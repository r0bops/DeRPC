import { keccak256, toHex } from "viem";
import { parseEnsDirectory, type EnsDirectoryConfig } from "../../frontend/build/ens-directory.ts";
// The same validation is used by the CLI and browser; no deployment is inferred from predictions.
// @ts-expect-error Shared JavaScript administrative core has no generated declaration.
import { directoryPins } from "../../contracts/lib/ens-wallet.mjs";
// @ts-expect-error Shared JavaScript administrative core has no generated declaration.
import { validateLifecycleManifest } from "../../contracts/lib/ens-lifecycle.mjs";
// @ts-expect-error Shared JavaScript public interfaces have no generated declaration.
import { RECORD_KEYS, UPSTREAM } from "../../contracts/lib/ens-common.mjs";

export const OPERATOR_ADMIN_RPC_URLS = [
  "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org",
] as const;

export interface OperatorBuild {
  sourceHash: string;
  compiler: { version: string; optimizerRuns: number; evmVersion: string };
  artifact: { abi: unknown; evm: { deployedBytecode: {
    object: string;
    immutableReferences: Record<string, { start: number; length: number }[]>;
  } } };
}

/** Only runtime verification data belongs in the browser, never compiler output or creation code. */
export function browserOperatorBuild(compiled: OperatorBuild): OperatorBuild {
  const runtime = compiled.artifact.evm.deployedBytecode;
  return {
    sourceHash: compiled.sourceHash,
    compiler: { version: compiled.compiler.version, optimizerRuns: compiled.compiler.optimizerRuns, evmVersion: compiled.compiler.evmVersion },
    artifact: { abi: structuredClone(compiled.artifact.abi), evm: { deployedBytecode: {
      object: runtime.object,
      immutableReferences: Object.fromEntries(Object.entries(runtime.immutableReferences).map(([key, ranges]) => [key, ranges.map(({ start, length }) => ({ start, length }))])),
    } } },
  };
}

export interface OperatorReleaseMetadata {
  schemaVersion: 1;
  enabled: boolean;
  directory: EnsDirectoryConfig | null;
  sourceHash: string;
  compiler: OperatorBuild["compiler"];
  manifestHash: string | null;
  adminRpcOrigins: string[];
}

/** Build-time configuration is authority; URL parameters, uploads and local storage are not. */
export function parseOperatorDeployment(input: string | undefined, directoryInput: string | undefined, build: OperatorBuild): Record<string, unknown> | null {
  const directory = parseEnsDirectory(directoryInput);
  if (input === undefined || input.trim() === "") return null;
  const fail = (reason: string): never => { throw new Error(`VITE_ENS_OPERATOR_DEPLOYMENT: ${reason}`); };
  if (new TextEncoder().encode(input).length > 128 * 1024) fail("public deployment manifest exceeds 128 KiB");
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(input); } catch { return fail("expected the complete verified deployment JSON"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("expected a deployment object");
  const fields = ["schemaVersion", "kind", "chainId", "localOnly", "rpcOrigin", "verifiedAt", "parentName", "curator", "deployer", "subregistry", "registrar", "operators", "roleTable", "sourceHash", "compiler", "observedBlock", "upstream", "transactions", "verification", "rpcTrust"];
  // Reject extra data rather than projecting/reordering records: resolver creation
  // verification depends on their original initializer order.
  const publicFields = (value: unknown, allowed: readonly string[], context: string, nested: readonly string[] = []): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`expected public ${context} fields`);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !allowed.includes(key))) return fail(`unexpected ${context} field; supply only the public verifier export`);
    if (Object.entries(row).some(([key, entry]) => !nested.includes(key) && entry !== null && typeof entry === "object")) return fail(`non-scalar ${context} field; supply only the public verifier export`);
    return row;
  };
  const publicRows = (value: unknown, context: string): unknown[] => Array.isArray(value) ? value : fail(`expected public ${context} list`);
  publicFields(manifest, fields, "deployment", ["registrar", "operators", "roleTable", "compiler", "observedBlock", "upstream", "transactions", "verification"]);
  publicFields(manifest.registrar, ["address", "codeHash", "runtimeCodeHash", "registry", "subregistry", "arraySlot", "entrySlots", "maxOperators"], "registrar");
  publicFields(manifest.compiler, ["version", "optimizerRuns", "evmVersion"], "compiler");
  publicFields(manifest.observedBlock, ["number", "hash"], "observed block");
  publicFields(manifest.verification, ["receipts", "canonicalBlocks", "minimumConfirmations", "stateMatchesConfig", "hotKeyEventAudit"], "verification");
  for (const value of publicRows(manifest.operators, "operators")) {
    const op = publicFields(value, ["name", "resolver", "operator", "coldOwner", "hotKey", "expiry", "payee", "records", "initialRecords"], "operator", ["records", "initialRecords"]);
    for (const key of ["records", "initialRecords"]) if (Object.hasOwn(op, key)) {
      const records = publicFields(op[key], RECORD_KEYS, "operator records");
      if (Object.values(records).some(value => typeof value !== "string")) fail("operator record values must be public text");
    }
  }
  for (const value of publicRows(manifest.transactions, "transactions")) publicFields(value, ["id", "transactionHash", "blockNumber", "blockHash", "from", "to", "gasUsed", "effectiveGasPrice", "confirmations"], "transaction");
  if (Object.hasOwn(manifest, "roleTable")) for (const value of publicRows(manifest.roleTable, "role table")) publicFields(value, ["resource", "account", "roles", "bitmap"], "role table");
  const upstreamNames = Object.keys(UPSTREAM.artifacts);
  const upstream = publicFields(manifest.upstream, upstreamNames, "upstream", upstreamNames);
  for (const artifact of Object.values(upstream)) publicFields(artifact, ["address", "runtimeCodeHash", "normalizedRuntimeCodeHash"], "upstream artifact");
  let pins: EnsDirectoryConfig | null;
  try {
    validateLifecycleManifest(manifest, build);
    pins = parseEnsDirectory(JSON.stringify(directoryPins(manifest)));
  } catch { return fail("requires a public, source-matched mainnet deployment verified at twelve confirmations"); }
  if (!directory || JSON.stringify(pins) !== JSON.stringify(directory)) fail("VITE_ENS_DIRECTORY must contain the identical reviewed directory pins");
  // This export is still administrative evidence. Every action rechecks chain state through both sources.
  return manifest;
}

export function operatorReleaseMetadata(deployment: Record<string, unknown> | null, build: OperatorBuild): OperatorReleaseMetadata {
  return {
    schemaVersion: 1, enabled: deployment !== null,
    directory: deployment ? parseEnsDirectory(JSON.stringify(directoryPins(deployment))) : null,
    sourceHash: build.sourceHash, compiler: build.compiler,
    manifestHash: deployment ? keccak256(toHex(JSON.stringify(deployment))) : null,
    adminRpcOrigins: OPERATOR_ADMIN_RPC_URLS.map(url => new URL(url).origin),
  };
}
