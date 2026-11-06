import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, namehash, parseAbi, stringToHex, zeroAddress, type Hex } from "viem";
import { operatorUrl, checkOperatorIdentity, assertSeparateGateway } from "../operators/endpoint.ts";
import { parseOperatorEndpoints } from "../operators/endpoints.ts";
import type { AnonTransport } from "../transport/anon-transport.ts";
import { createJsonRpcSend } from "../transport/json-rpc.ts";
import { ProofVerificationError, verifyAccountProof, verifyStorageProof, type AccountProof } from "../verify/index.ts";
import type { HeaderView, JsonRpcSend, VerifiedValue } from "../verify/reader.ts";
import type { DeRPCOperator } from "../api/derpc.ts";
import { readProvenOperators, type RegistrarPin, type ProvenOperator } from "./registrar.ts";

export { readProvenOperators, type RegistrarPin, type ProvenOperator } from "./registrar.ts";
export const registryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getState(uint256 anyId) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))",
]);
export const resolverAbi = parseAbi(["function resolve(bytes name,bytes data) view returns (bytes)", "function text(bytes32 node,string key) view returns (string)", "function multicall(bytes[] calls) view returns (bytes[])"]);
export const RECORD_KEYS = ["derpc.endpoints", "derpc.endpoint", "derpc.beacon", "derpc.signer", "derpc.caps", "derpc.gateways", "derpc.price", "derpc.payee", "derpc.paymentChain", "derpc.escrow"] as const;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const ISOLATION_KEY = "derpc:operator-discovery";
export class DiscoveryBlockChangedError extends Error {
  override name = "DiscoveryBlockChangedError";
}
export class DiscoveryReadError extends Error {
  override name = "DiscoveryReadError";
}

export interface PaymentTerms {
  readonly price: bigint;
  readonly payee: Hex;
  readonly chainId: number;
  readonly escrow: Hex;
  /** The payment destination is authenticated; this alone does not authenticate the escrow. */
  readonly payeeProven: boolean;
  /** All terms were read using local execution against proven state. */
  readonly recordsProven: boolean;
}
export interface DiscoveredOperator extends DeRPCOperator {
  ens: string;
  expiry: number;
  payment?: PaymentTerms;
  /** A fixed public worker-pin proof succeeded at this authenticated block. */
  proofVerifiedAt: number;
}
export interface Directory {
  operators: DiscoveredOperator[];
  rejected: { name: string; reason: string }[];
  listVerification: "proven" | "unverified";
  recordVerification: "proven" | "unverified";
  blockNumber: number;
  blockHash: Hex;
}
export interface DiscoveryOptions {
  transport: AnonTransport;
  /** A bootstrap operator the user selected. No direct-network client is created here. */
  executionUrl: string;
  /** Optional selected-pool sender, always anonymous. Also used for registrar proofs. */
  send?: JsonRpcSend;
  headers: HeaderView;
  ethRegistry: Hex;
  registrar?: RegistrarPin;
  /** Independently known gateway owners, keyed by KPS address; checked before any candidate probe. */
  gatewayOwners?: Record<string, string>;
  /** Run the complete registrar proof under one bounded pool/payment authorization. */
  readRegistrar?: (pin: RegistrarPin, options?: { signal?: AbortSignal }) => Promise<VerifiedValue<ProvenOperator[]>>;
  /** Optional local EVM execution against proven state, pinned to the requested block. */
  verifiedCall?: (to: Hex, data: Hex, options?: { signal?: AbortSignal }) => Promise<VerifiedValue<Hex>>;
  signal?: AbortSignal;
  /** Whole-directory limit, including metadata, identities and capability proofs. Default 120 s. */
  totalTimeoutMs?: number;
  now?: () => number;
}

/** DNS wire encoding for already-normalized, fully on-chain ENS names. */
export function dnsName(name: string): Hex {
  const labels = name.split(".");
  const bytes: number[] = [];
  for (const label of labels) {
    const encoded = new TextEncoder().encode(label);
    if (!encoded.length || encoded.length > 63 || /[\u0000-\u0020\u007f]/.test(label)) throw new Error("invalid DNS label");
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  if (bytes.length > 255) throw new Error("DNS name too long");
  return `0x${bytes.map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Read the ENTIRE directory before the user's selection. Generic provider eth_call stays refused. */
export async function discoverOperators(options: DiscoveryOptions): Promise<Directory> {
  const timeoutMs = options.totalTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("discovery timeout must be 1..300000 ms");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("operator discovery deadline exceeded")), timeoutMs);
  try {
    signal.throwIfAborted();
    return await abortable(scan({ ...options, signal }), signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function scan(options: DiscoveryOptions & { signal: AbortSignal }): Promise<Directory> {
  const { transport, headers, signal } = options;
  const activeGateways = transport.pin.config.gateways ?? [];
  if (!Array.isArray(activeGateways) || activeGateways.some(gateway => typeof gateway !== "string")) throw new Error("invalid anonymous gateway configuration");
  const block = headers.finalized();
  const timestamp = Math.floor((options.now ?? Date.now)() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("invalid discovery clock");
  const now = Math.max(block.timestamp, timestamp);
  const blockTag = `0x${block.blockNumber.toString(16)}`;
  const check = () => { signal.throwIfAborted(); headers.assertFresh?.(block); };
  check();
  const send = options.send ?? createJsonRpcSend(transport, operatorUrl(options.executionUrl).href, { timeoutMs: 15_000, maxBodyBytes: 256 * 1024 });
  async function call(to: Hex, data: Hex): Promise<Hex> {
    check();
    if (!validAddress(to)) throw new Error("missing ENS contract");
    let result: unknown;
    try {
      if (options.verifiedCall) {
        const verified = await options.verifiedCall(to, data, { signal });
        if (verified.block.blockHash !== block.blockHash || verified.block.stateRoot !== block.stateRoot || verified.block.blockNumber !== block.blockNumber) throw new DiscoveryBlockChangedError("discovery changed its verified block");
        result = verified.value;
      } else {
        // No CCIP-Read handler: an OffchainLookup revert is a failure, never a gateway fetch.
        result = await send("eth_call", [{ to, data }, blockTag], { isolationKey: ISOLATION_KEY, signal });
      }
    } catch (error) {
      // Only a completed local execution can establish a resolver revert. Local execution
      // limits, unavailable context and sender failures leave the snapshot incomplete.
      // Preserve them as fatal read errors instead of silently dropping this operator.
      if (error instanceof ProofVerificationError || isFatal(error) || options.verifiedCall && error instanceof Error && error.name === "CallRevertedError") throw error;
      throw new DiscoveryReadError(error instanceof Error ? error.message : "ENS metadata read failed", { cause: error });
    }
    check();
    if (typeof result !== "string" || !/^0x(?:[\da-fA-F]{2})*$/.test(result) || result.length > 32768) throw new Error("invalid ENS call result");
    return result as Hex;
  }
  async function registryAddress(address: Hex, fn: "getResolver" | "getSubregistry", label: string): Promise<Hex> {
    return decodeFunctionResult({ abi: registryAbi, functionName: fn, data: await call(address, encodeFunctionData({ abi: registryAbi, functionName: fn, args: [label] })) });
  }
  async function state(address: Hex, label: string) {
    const value = decodeFunctionResult({ abi: registryAbi, functionName: "getState", data: await call(address, encodeFunctionData({ abi: registryAbi, functionName: "getState", args: [BigInt(keccak256(stringToHex(label)))] })) });
    if (value.expiry > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid name expiry");
    return value;
  }
  async function texts(resolver: Hex, name: string, keys: readonly string[]): Promise<string[]> {
    const profiles = keys.map(key => encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [namehash(name), key] }));
    // ENSv2 AbstractRecordResolver explicitly supports resolve(name, multicall(profiles)).
    // Keep all records in one local EVM execution and one logical read.
    const profile = profiles.length === 1 ? profiles[0]! : encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [profiles] });
    const data = await call(resolver, encodeFunctionData({ abi: resolverAbi, functionName: "resolve", args: [dnsName(name), profile] }));
    const inner = decodeFunctionResult({ abi: resolverAbi, functionName: "resolve", data });
    const results = profiles.length === 1 ? [inner] : decodeFunctionResult({ abi: resolverAbi, functionName: "multicall", data: inner });
    if (results.length !== keys.length) throw new Error("incomplete ENS record batch");
    return results.map(data => {
      // A failed profile can contain revert bytes, including OffchainLookup. Never follow it.
      const result = decodeFunctionResult({ abi: resolverAbi, functionName: "text", data });
      if (new TextEncoder().encode(result).length > 4096) throw new Error("ENS text record is too large");
      return result;
    });
  }
  const parent = await state(options.ethRegistry, "derpc");
  if (parent.status !== 2 || parent.expiry <= BigInt(now) || !validAddress(parent.latestOwner)) throw new Error("derpc.eth is not active");
  const subregistry = await registryAddress(options.ethRegistry, "getSubregistry", "derpc");
  if (!validAddress(subregistry)) throw new Error("derpc.eth has no operator subregistry");
  if (options.registrar?.registry && subregistry.toLowerCase() !== options.registrar.registry.toLowerCase()) throw new Error("ENS subregistry differs from the pinned registrar deployment");
  const proven = options.registrar ? await (options.readRegistrar
    ? options.readRegistrar(options.registrar, { signal })
    : readProvenOperators({ headers: { finalized: () => block, assertFresh: h => headers.assertFresh?.(h) }, send, registrar: options.registrar, now: options.now, signal })) : undefined;
  if (proven && (proven.block.blockHash !== block.blockHash || proven.block.stateRoot !== block.stateRoot || proven.block.blockNumber !== block.blockNumber)) throw new DiscoveryBlockChangedError("registrar discovery changed its verified block");
  let labels: string[];
  if (proven) labels = proven.value.map(o => o.label);
  else {
    const resolver = await registryAddress(options.ethRegistry, "getResolver", "derpc");
    const index: unknown = JSON.parse((await texts(resolver, "derpc.eth", ["derpc.operators"]))[0]!);
    if (!Array.isArray(index) || index.length > 128 || index.some(label => typeof label !== "string" || !LABEL.test(label)) || new Set(index).size !== index.length) throw new Error("invalid operator index");
    labels = index;
  }
  const result: Directory = {
    operators: [], rejected: [], listVerification: proven || options.verifiedCall ? "proven" : "unverified",
    recordVerification: options.verifiedCall ? "proven" : "unverified", blockNumber: block.blockNumber, blockHash: block.blockHash,
  };
  for (const label of labels) {
    const name = `${label}.derpc.eth`;
    let phase: "records" | "endpoint" = "records";
    try {
      check();
      const entry = await state(subregistry, label);
      if (entry.status !== 2 || entry.expiry <= BigInt(now) || !validAddress(entry.latestOwner)) throw new Error("name expired or removed");
      const member = proven?.value.find(o => o.label === label);
      if (member && member.operator.toLowerCase() !== entry.latestOwner.toLowerCase()) throw new Error("ENS owner differs from the proven operator");
      const resolver = await registryAddress(subregistry, "getResolver", label);
      const recordValues = await texts(resolver, name, RECORD_KEYS);
      const records = Object.fromEntries(RECORD_KEYS.map((key, i) => [key, recordValues[i]!])) as Record<string, string>;
      const plural = records["derpc.endpoints"] !== "";
      // An invalid present plural record is an operator-level policy rejection. Never
      // fall back to an older singular endpoint or probe a partly validated node list.
      const nodes = plural ? parseOperatorEndpoints(records["derpc.endpoints"]!) : [{
        id: undefined,
        url: operatorUrl(records["derpc.endpoint"]!).href,
        ...(records["derpc.beacon"] ? { beaconUrl: operatorUrl(records["derpc.beacon"]).href } : {}),
      }];
      const signer = records["derpc.signer"]!;
      if (!validAddress(signer)) throw new Error("invalid signer");
      const caps: unknown = JSON.parse(records["derpc.caps"]!);
      if (!caps || typeof caps !== "object" || Array.isArray(caps)) throw new Error("invalid operator capabilities");
      const capability = caps as { chainId?: unknown; methods?: unknown; beacon?: unknown };
      if (capability.chainId !== 1 || !Array.isArray(capability.methods) || capability.methods.length > 16 || capability.methods.some(m => typeof m !== "string") || !["eth_getProof", "eth_getCode"].every(m => (capability.methods as unknown[]).includes(m)) || capability.beacon !== undefined && typeof capability.beacon !== "boolean") throw new Error("unsupported operator capabilities");
      const gateways: unknown = records["derpc.gateways"] ? JSON.parse(records["derpc.gateways"]) : [];
      if (!Array.isArray(gateways) || gateways.length > 16 || gateways.some(g => typeof g !== "string" || !validGateway(g))) throw new Error("invalid gateway declarations");
      const expiry = Math.min(Number(parent.expiry), Number(entry.expiry), member?.expiry ?? Number.MAX_SAFE_INTEGER);
      if (capability.beacon === true && nodes.some(node => !node.beaconUrl)) throw new Error("beacon capability has no endpoint");
      const candidates: DiscoveredOperator[] = nodes.map(node => ({
        id: node.id === undefined ? name : `${name}#${node.id}`, operatorId: name,
        ...(node.id === undefined ? {} : { endpointId: node.id }),
        ...(options.verifiedCall ? { ensOwner: entry.latestOwner } : {}),
        ens: name, operator: name, url: node.url, ...(node.beaconUrl ? { beaconUrl: node.beaconUrl } : {}),
        priority: 0, expiry, gateways, wrapperIdentity: { signer }, proofVerifiedAt: block.blockNumber,
      }));
      const paymentKeys = ["derpc.price", "derpc.payee", "derpc.paymentChain", "derpc.escrow"];
      if (paymentKeys.some(k => records[k])) {
        if (plural) throw new Error("plural operator endpoints are free-only");
        const price = records["derpc.price"]!, chain = records["derpc.paymentChain"]!, escrow = records["derpc.escrow"]!, recordPayee = records["derpc.payee"]!;
        if (!/^[1-9]\d{0,77}$/.test(price) || BigInt(price) > MAX_UINT256 || !/^[1-9]\d{0,15}$/.test(chain) || !Number.isSafeInteger(Number(chain)) || !validAddress(recordPayee) || !validAddress(escrow)) throw new Error("invalid payment terms");
        if (member && member.payee.toLowerCase() !== recordPayee.toLowerCase()) throw new Error("ENS payee differs from the proven payee");
        candidates[0]!.payment = Object.freeze({ price: BigInt(price), payee: member?.payee ?? recordPayee, chainId: Number(chain), escrow, payeeProven: !!proven || !!options.verifiedCall, recordsProven: !!options.verifiedCall });
      }
      // Apply the same gateway/operator ownership separation as normal routing before the
      // public identity or proof probe contacts this candidate through the active worker.
      assertSeparateGateway({ ens: name, gateways }, activeGateways, options.gatewayOwners);
      phase = "endpoint";
      for (const operator of candidates) {
        try {
          check();
          await checkOperatorIdentity(transport, operator.url, { ens: name, signer, endpointId: operator.endpointId }, signal);
          // Every candidate receives the same public bootstrap proof, never a user's account query.
          // Paid legacy wrappers allow this fixed pin check before a session is funded.
          const probe = createJsonRpcSend(transport, operator.url, { timeoutMs: 15_000, maxBodyBytes: 256 * 1024 });
          const proof = await probe("eth_getProof", [transport.pin.specifier, ["0x1"], blockTag], { isolationKey: ISOLATION_KEY, signal }) as AccountProof;
          const account = verifyAccountProof({ stateRoot: block.stateRoot, address: transport.pin.specifier, proof });
          if (!Array.isArray(proof.storageProof) || proof.storageProof.length !== 1) throw new Error("endpoint did not serve the bootstrap slot proof");
          verifyStorageProof({ storageRoot: account.storageRoot, slot: "0x1", proof: proof.storageProof[0]! });
          check();
          result.operators.push(operator);
        } catch (error) {
          check();
          if (isFatal(error)) throw error;
          result.rejected.push({ name: operator.id!, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      // Endpoint-local failures are availability observations after the metadata was read.
      // An incomplete/corrupt metadata read invalidates the whole refresh. The scan signal
      // and freshness check still make cancellation or a stale header fatal in either phase.
      check();
      if ((phase === "records" && error instanceof ProofVerificationError) || isFatal(error)) throw error;
      result.rejected.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  check();
  const finishedAt = Math.max(block.timestamp, Math.floor((options.now ?? Date.now)() / 1000));
  if (!Number.isSafeInteger(finishedAt) || finishedAt < now) throw new Error("discovery clock moved backwards");
  if (parent.expiry <= BigInt(finishedAt)) throw new Error("derpc.eth expired during discovery");
  result.operators = result.operators.filter(operator => {
    if (operator.expiry > finishedAt) return true;
    result.rejected.push({ name: operator.ens, reason: "name expired during discovery" });
    return false;
  });
  return result;
}

/** A refreshed list can remove selected entries, never silently add new choices. */
export function retainChosenOperators(directory: Directory, chosenNames: readonly string[]): DiscoveredOperator[] {
  const chosen = new Set(chosenNames);
  return directory.operators.filter(o => chosen.has(o.ens));
}

function validAddress(value: unknown): value is Hex {
  return typeof value === "string" && isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress;
}
function validGateway(value: string): boolean {
  const match = /^([^\s/?#]+):(\d{1,5}):([A-Za-z0-9_-]{16,128})$/.exec(value);
  return value.length <= 256 && !!match && Number(match[2]) > 0 && Number(match[2]) <= 65535;
}
function isFatal(error: unknown): boolean {
  return error instanceof Error && ["TransportUnavailableError", "StaleHeaderError", "StaleCheckpointError", "HeaderSourceNotReadyError", "WorkerPinMismatchError", "WorkerPinChainError", "DiscoveryBlockChangedError", "DiscoveryReadError", "PoolExhaustedError", "NoOperatorsChosenError", "PaymentAuthorizationError", "PaymentSessionError"].includes(error.name);
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason ?? new DOMException("aborted", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}
