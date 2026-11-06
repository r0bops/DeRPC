import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, parseAbi, zeroAddress } from "viem";
import { namehash, normalize } from "viem/ens";
import type { VerifiedHeader } from "../light-client/header-source.ts";
import { bytesToHex, type Hex } from "../verify/hex.ts";
import { InputError, type HeaderView } from "../verify/reader.ts";
import { CallRevertedError, ExecutionLimitError, UnsupportedExecutionError, type VerifiedExecutor } from "./verified-call.ts";

/** Same upstream revision as contracts/deployments/ens-upstream-mainnet.json.
 * This is the deployed v2 implementation: the older public proxy can still point at v1.
 * Its bytecode, hierarchy, and selected resolver are all authenticated by the injected executor.
 * https://github.com/ensdomains/contracts-v2/blob/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/deployments/mainnet/UniversalResolverV2.json
 */
export const MAINNET_ENS_UNIVERSAL_RESOLVER_V2: Hex = "0x06fdd07f007adac667177b46ab2eb9a75132cfd5";
export const ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT = "4f47cbcc11462fb413196e6b5c0f8090247a6c08";

// Public interfaces checked against the pinned UniversalResolverV2 artifact and ENS profiles.
const universalAbi = parseAbi(["function resolveWithGateways(bytes name,bytes data,string[] gateways) view returns (bytes,address)"]);
const addressAbi = parseAbi(["function addr(bytes32 node) view returns (address)"]);
const coinAddressAbi = parseAbi(["function addr(bytes32 node,uint256 coinType) view returns (bytes)"]);
const textAbi = parseAbi(["function text(bytes32 node,string key) view returns (string)"]);
const contenthashAbi = parseAbi(["function contenthash(bytes32 node) view returns (bytes)"]);

export type VerifiedEnsRecord =
  | { type: "address" }
  | { type: "coinAddress"; coinType: bigint }
  | { type: "text"; key: string }
  | { type: "contenthash" };

export interface VerifiedEnsLimits {
  inputCharacters: number;
  labels: number;
  nameBytes: number;
  textKeyBytes: number;
  calldataBytes: number;
  resultBytes: number;
  timeoutMs: number;
}

export const DEFAULT_VERIFIED_ENS_LIMITS: Readonly<VerifiedEnsLimits> = Object.freeze({
  inputCharacters: 4096, labels: 32, nameBytes: 1024, textKeyBytes: 256,
  calldataBytes: 16 * 1024, resultBytes: 16 * 1024, timeoutMs: 60_000,
});

export class EnsBlockChangedError extends Error { override name = "EnsBlockChangedError"; }
export class EnsResolutionError extends Error { override name = "EnsResolutionError"; }

export interface VerifiedEnsOptions {
  name: string;
  /** Default: Ethereum address. Empty text/bytes or the zero address retain their proven values. */
  record?: VerifiedEnsRecord;
  headers: HeaderView;
  /** Must execute locally against proven state, e.g. executor.call or derpc.verifiedCall.
   * It must use the same finalized block as headers. The helper never creates a network client.
   */
  verifiedCall: VerifiedExecutor["call"];
  signal?: AbortSignal;
  /** Limits may be lowered. EVM gas/state/round-trip limits remain the executor's responsibility. */
  limits?: Partial<VerifiedEnsLimits>;
}

export interface VerifiedEnsResult {
  normalizedName: string;
  resolver: Hex;
  record: VerifiedEnsRecord;
  /** Text is UTF-8; address, coinAddress and contenthash are hex. No content URL is fetched. */
  value: string;
  block: VerifiedHeader;
}

/**
 * Resolve any ENSIP-15 name supported by the pinned mainnet hierarchy, within the stated bounds.
 * Exactly ONE local EVM invocation resolves the entire hierarchy and record at one state root.
 * Wildcards, legacy resolvers and v2 proxies use the Universal Resolver's own on-chain rules.
 * CCIP-Read, unavailable execution context and over-limit names fail closed without fallback.
 */
export async function resolveVerifiedEns(options: VerifiedEnsOptions): Promise<VerifiedEnsResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new InputError("verified ENS options must be an object");
  const fields = ["name", "record", "headers", "verifiedCall", "signal", "limits"];
  if (Reflect.ownKeys(options).some(key => typeof key !== "string" || !fields.includes(key))) throw new InputError("unsupported verified ENS option");
  if (!options.headers || typeof options.headers.finalized !== "function" || typeof options.verifiedCall !== "function") throw new InputError("verified ENS requires a header source and verified executor");
  const limits = { ...DEFAULT_VERIFIED_ENS_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    const maximum = DEFAULT_VERIFIED_ENS_LIMITS[key as keyof VerifiedEnsLimits];
    if (maximum === undefined || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new InputError(`invalid verified ENS limit: ${key}`);
  }
  if (typeof options.name !== "string" || !options.name) throw new InputError("ENS resolution requires a nonempty name");
  if (options.name.length > limits.inputCharacters) throw new ExecutionLimitError("ENS input name exceeds the character limit");
  let normalizedName: string;
  try { normalizedName = normalize(options.name); }
  catch (cause) { throw new InputError("ENS name is invalid under ENSIP-15", { cause }); }
  const labels = normalizedName.split(".");
  if (labels.length > limits.labels) throw new ExecutionLimitError("ENS name exceeds the label limit");
  const encoder = new TextEncoder();
  const wire: number[] = [];
  for (const label of labels) {
    const bytes = encoder.encode(label);
    if (!bytes.length) throw new InputError("ENS root and empty labels are unsupported");
    // ENS's DNS encoding uses a full byte for label length; ordinary DNS's 63-byte limit does
    // not apply. Do not silently replace longer labels with unverified labelhash placeholders.
    if (bytes.length > 255) throw new UnsupportedExecutionError("ENS labels longer than 255 UTF-8 bytes are unsupported");
    if (wire.length + bytes.length + 2 > limits.nameBytes) throw new ExecutionLimitError("ENS DNS name exceeds the byte limit");
    wire.push(bytes.length, ...bytes);
  }
  wire.push(0);
  const dns = bytesToHex(Uint8Array.from(wire));
  const node = namehash(normalizedName);
  const record = validateRecord(options.record === undefined ? { type: "address" } : options.record, limits, encoder);
  const profile = record.type === "address"
    ? { abi: addressAbi, functionName: "addr" as const, args: [node] as const }
    : record.type === "coinAddress"
      ? { abi: coinAddressAbi, functionName: "addr" as const, args: [node, record.coinType] as const }
      : record.type === "text"
        ? { abi: textAbi, functionName: "text" as const, args: [node, record.key] as const }
        : { abi: contenthashAbi, functionName: "contenthash" as const, args: [node] as const };
  const data = record.type === "address" ? encodeFunctionData({ abi: addressAbi, functionName: "addr", args: [node] })
    : record.type === "coinAddress" ? encodeFunctionData({ abi: coinAddressAbi, functionName: "addr", args: [node, record.coinType] })
      : record.type === "text" ? encodeFunctionData({ abi: textAbi, functionName: "text", args: [node, record.key] })
        : encodeFunctionData({ abi: contenthashAbi, functionName: "contenthash", args: [node] });
  // Explicit empty gateways avoid loading the advisory gateway provider. The on-chain batching
  // implementation still resolves fully on-chain legacy profiles, and propagates OffchainLookup.
  const calldata = encodeFunctionData({ abi: universalAbi, functionName: "resolveWithGateways", args: [dns, data, []] });
  if ((calldata.length - 2) / 2 > limits.calldataBytes) throw new ExecutionLimitError("ENS calldata exceeds the byte limit");

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new ExecutionLimitError("verified ENS resolution deadline exceeded")), limits.timeoutMs);
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const current = options.headers.finalized();
    if (current.network !== "mainnet" || !current.execution) throw new UnsupportedExecutionError("verified ENS resolution requires authenticated mainnet execution context");
    // Snapshot primitive fields: a mutable HeaderView must not change the comparison anchor.
    const block: VerifiedHeader = { ...current, execution: { ...current.execution } };
    options.headers.assertFresh?.(block);
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const response = await Promise.race([
      options.verifiedCall({ to: MAINNET_ENS_UNIVERSAL_RESOLVER_V2, data: calldata, signal }), aborted,
    ]);
    signal.throwIfAborted();
    if (!sameBlock(block, response.block)) throw new EnsBlockChangedError("ENS resolution changed its authenticated block context");
    options.headers.assertFresh?.(block);
    const raw = boundedHex(response.value, limits.resultBytes);
    let result: Hex;
    let resolver: Hex;
    let value: string;
    try {
      [result, resolver] = decodeFunctionResult({ abi: universalAbi, functionName: "resolveWithGateways", data: raw });
      if (encodeFunctionResult({ abi: universalAbi, functionName: "resolveWithGateways", result: [result, resolver] }).toLowerCase() !== raw.toLowerCase()) throw new Error("noncanonical Universal Resolver response");
      if (resolver.toLowerCase() === zeroAddress) throw new Error("Universal Resolver returned no resolver");
      value = decodeFunctionResult({ abi: profile.abi, functionName: profile.functionName, data: result });
      if (encodeFunctionResult({ abi: profile.abi, functionName: profile.functionName, result: value as Hex }).toLowerCase() !== result.toLowerCase()) throw new Error("noncanonical ENS profile response");
    } catch (cause) { throw new EnsResolutionError("invalid verified ENS result", { cause }); }
    return { normalizedName, resolver, record, value, block };
  } catch (error) {
    if (error instanceof CallRevertedError && error.data.toLowerCase().startsWith("0x556f1830")) throw new UnsupportedExecutionError("CCIP-Read OffchainLookup is refused");
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

function validateRecord(input: VerifiedEnsRecord, limits: VerifiedEnsLimits, encoder: TextEncoder): VerifiedEnsRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("invalid ENS record request");
  const fields = input.type === "text" ? ["type", "key"] : input.type === "coinAddress" ? ["type", "coinType"] : ["type"];
  if (Reflect.ownKeys(input).some(key => typeof key !== "string" || !fields.includes(key))) throw new InputError("unsupported ENS record request field");
  if (input.type === "address" || input.type === "contenthash") return { type: input.type };
  if (input.type === "coinAddress") {
    if (typeof input.coinType !== "bigint" || input.coinType < 0n || input.coinType >= 1n << 256n) throw new InputError("ENS coin type must be a uint256 bigint");
    return { type: input.type, coinType: input.coinType };
  }
  if (input.type === "text") {
    if (typeof input.key !== "string") throw new InputError("ENS text key must be a string");
    if (input.key.length > limits.textKeyBytes || encoder.encode(input.key).length > limits.textKeyBytes) throw new ExecutionLimitError("ENS text key exceeds the byte limit");
    if (new TextDecoder().decode(encoder.encode(input.key)) !== input.key) throw new InputError("ENS text key contains an invalid Unicode sequence");
    return { type: input.type, key: input.key };
  }
  throw new InputError("unsupported ENS record profile");
}

function boundedHex(value: unknown, bytes: number): Hex {
  if (typeof value !== "string" || value.length > bytes * 2 + 2) throw new ExecutionLimitError("ENS result exceeds the byte limit");
  if (!/^0x(?:[\da-fA-F]{2})*$/.test(value)) throw new EnsResolutionError("invalid verified ENS result bytes");
  return value as Hex;
}

function sameBlock(expected: VerifiedHeader, actual: VerifiedHeader): boolean {
  const a = expected.execution, b = actual?.execution;
  return actual?.network === expected.network && actual.slot === expected.slot && actual.blockNumber === expected.blockNumber && actual.blockHash === expected.blockHash && actual.stateRoot === expected.stateRoot && actual.timestamp === expected.timestamp && !!a && !!b && a.feeRecipient === b.feeRecipient && a.prevRandao === b.prevRandao && a.gasLimit === b.gasLimit && a.baseFeePerGas === b.baseFeePerGas && a.excessBlobGas === b.excessBlobGas;
}
