import { operatorUrl, parseOperatorEndpoints, type OperatorEndpointRecord } from "@derpc/provider";

/** Full public lifecycle evidence is larger than the individual 4096-byte endpoint record. */
export const MAX_LIFECYCLE_EVIDENCE_BYTES = 128 * 1024;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;
const HASH = /^0x[\da-fA-F]{64}$/;
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const ADMIN_NOTICE = "Imported administrative observations; receipt inclusion, canonical ancestry and transaction causality are not verified by this comparison.";

export type LifecycleAction =
  | { type: "rotate-endpoint"; label: string; expectedEndpoint: string; newEndpoint: string }
  | { type: "rotate-endpoints"; label: string; expectedEndpoints: readonly OperatorEndpointRecord[]; newEndpoints: readonly OperatorEndpointRecord[] }
  | { type: "delist"; label: string }
  | { type: "renew"; label: string; expectedExpiry: number; expiry: number; authority: "operator" | "curator" };

export interface LifecycleEvidence {
  readonly name: string;
  readonly action: LifecycleAction;
  readonly transactionHash: string;
  readonly localOnly: boolean;
  readonly receipt: { readonly blockNumber: number; readonly blockHash: string };
  readonly administrativeFinality: "finalized" | "pending-finality" | "unavailable";
}

/** Supply the result of the provider's completed discovery, never fields from the imported file. */
export interface LifecycleDirectory {
  operators: readonly { ens?: string; operatorId?: string; endpointId?: string; url: string; beaconUrl?: string; expiry?: number }[];
  rejected: readonly { name: string; reason?: string }[];
  listVerification: "proven" | "unverified";
  recordVerification: "proven" | "unverified";
  blockNumber: number;
  blockHash: string;
}

/** Supply a current provider status. A previous status object cannot establish clock freshness. */
export interface LifecycleSnapshot {
  blockNumber: number;
  blockHash: string;
  verifiedAt: number;
  expiresAt: number;
  state: "fresh" | "stale";
}

export interface LifecycleStatus {
  state: "receipt-recorded" | "awaiting-proven-refresh" | "expected-state-observed" | "conflict";
  title: string;
  detail: string;
  provenBlockNumber?: number;
}

function object(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || allowed && Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error("Unexpected lifecycle evidence fields.");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decimal(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,15})$/.test(value) || !integer(Number(value))) throw new Error("Invalid lifecycle evidence number.");
  return Number(value);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("Invalid lifecycle evidence hash.");
  return value.toLowerCase();
}

function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.includes("?") || value.includes("#")) throw new Error("Invalid public endpoint URL.");
  return operatorUrl(value).href;
}

function endpointList(value: unknown): readonly OperatorEndpointRecord[] {
  // Share the ENS schema's count, UTF-8 size, canonical URL, ID and unknown-field checks.
  const result = parseOperatorEndpoints(JSON.stringify({ version: 1, endpoints: value }));
  return Object.freeze(result.map(entry => Object.freeze(entry)));
}

function parseAction(input: unknown): LifecycleAction {
  const candidate = object(input);
  const type = candidate.type;
  const allowed = type === "rotate-endpoint" ? ["type", "label", "expectedEndpoint", "newEndpoint"]
    : type === "rotate-endpoints" ? ["type", "label", "expectedEndpoints", "newEndpoints"]
      : type === "delist" ? ["type", "label"]
        : type === "renew" ? ["type", "label", "expectedExpiry", "expiry", "authority"] : [];
  object(input, allowed);
  if (!allowed.length || typeof candidate.label !== "string" || !LABEL.test(candidate.label)) throw new Error("Invalid lifecycle action or operator label.");
  const label = candidate.label;
  if (type === "rotate-endpoint") {
    const expectedEndpoint = endpoint(candidate.expectedEndpoint), newEndpoint = endpoint(candidate.newEndpoint);
    if (expectedEndpoint === newEndpoint) throw new Error("Endpoint rotation has no change.");
    return Object.freeze({ type, label, expectedEndpoint, newEndpoint });
  }
  if (type === "rotate-endpoints") {
    const expectedEndpoints = endpointList(candidate.expectedEndpoints), newEndpoints = endpointList(candidate.newEndpoints);
    if (JSON.stringify(expectedEndpoints) === JSON.stringify(newEndpoints)) throw new Error("Endpoint rotation has no change.");
    return Object.freeze({ type, label, expectedEndpoints, newEndpoints });
  }
  if (type === "delist") return Object.freeze({ type, label });
  if (!integer(candidate.expectedExpiry) || !integer(candidate.expiry) || candidate.expiry <= candidate.expectedExpiry || !["operator", "curator"].includes(String(candidate.authority))) {
    throw new Error("Invalid lifecycle renewal.");
  }
  return Object.freeze({ type: "renew", label, expectedExpiry: candidate.expectedExpiry, expiry: candidate.expiry, authority: candidate.authority as "operator" | "curator" });
}

/** Bound unused evidence too; only validated display/action fields survive parsing. */
function boundedTree(value: unknown, depth = 0, budget = { remaining: 8000 }): void {
  if (depth > 16 || --budget.remaining < 0) throw new Error("Lifecycle evidence is too complex.");
  if (value && typeof value === "object") {
    if (Array.isArray(value) && value.length > 256) throw new Error("Lifecycle evidence array is too large.");
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid lifecycle evidence key.");
      boundedTree(child, depth + 1, budget);
    }
  }
}

/** Parse public CLI evidence only. No URL is fetched and no imported verification claim is trusted. */
export function parseLifecycleEvidence(json: string): LifecycleEvidence {
  if (typeof json !== "string" || json.length > MAX_LIFECYCLE_EVIDENCE_BYTES || new TextEncoder().encode(json).length > MAX_LIFECYCLE_EVIDENCE_BYTES) {
    throw new Error("Lifecycle evidence exceeds 128 KiB.");
  }
  const raw: unknown = JSON.parse(json);
  boundedTree(raw);
  const data = object(raw, ["schemaVersion", "kind", "chainId", "localOnly", "verifiedAt", "manifestHash", "action", "transactionHash", "receipt", "before", "after", "current", "verification", "finality", "trust"]);
  if (data.schemaVersion !== 1 || data.kind !== "derpc-ens-lifecycle-evidence" || data.chainId !== 1 || typeof data.localOnly !== "boolean") throw new Error("Expected mainnet ENS lifecycle evidence version 1.");
  if (typeof data.verifiedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.verifiedAt) || !Number.isFinite(Date.parse(data.verifiedAt))) throw new Error("Invalid lifecycle evidence timestamp.");
  hash(data.manifestHash);
  for (const key of ["before", "after", "current"]) object(data[key]);
  if (data.trust !== undefined && typeof data.trust !== "string") throw new Error("Invalid administrative evidence notice.");
  const action = parseAction(data.action);
  const receipt = object(data.receipt, ["blockNumber", "blockHash", "transactionIndex", "from", "to", "gasUsed", "confirmations"]);
  const blockNumber = decimal(receipt.blockNumber), blockHash = hash(receipt.blockHash);
  if (!integer(receipt.transactionIndex) || ![receipt.from, receipt.to].every(value => typeof value === "string" && ADDRESS.test(value) && !/^0x0{40}$/i.test(value)) || decimal(receipt.confirmations) < 12 || decimal(receipt.gasUsed) === 0) throw new Error("Incomplete lifecycle receipt metadata.");
  const verificationKeys = ["canonicalReceipt", "exactRequest", "receiptParentPreconditions", "receiptBlockState", "currentState", "rolesAndRuntime"];
  const verification = object(data.verification, verificationKeys);
  if (!verificationKeys.every(key => verification[key] === true)) throw new Error("Expected the lifecycle verifier's administrative checks.");
  const finality = object(data.finality, ["status", "finalizedBlock", "clientRefreshVerified"]);
  if (!["finalized", "pending-finality", "unavailable"].includes(String(finality.status)) || finality.clientRefreshVerified !== false) throw new Error("Imported evidence cannot claim a browser-proven refresh.");
  if (finality.status === "unavailable") {
    if (finality.finalizedBlock !== null) throw new Error("Inconsistent administrative finality metadata.");
  } else {
    const finalized = object(finality.finalizedBlock, ["number", "hash"]);
    const number = decimal(finalized.number);
    hash(finalized.hash);
    if ((number >= blockNumber) !== (finality.status === "finalized")) throw new Error("Inconsistent administrative finality metadata.");
  }
  return Object.freeze({ name: `${action.label}.derpc.eth`, action, transactionHash: hash(data.transactionHash), localOnly: data.localOnly,
    receipt: Object.freeze({ blockNumber, blockHash }), administrativeFinality: finality.status as LifecycleEvidence["administrativeFinality"] });
}

/** A display-only comparison. Never use this result to select endpoints or authorize reads. */
export function lifecycleStatus(evidence: LifecycleEvidence, context: { directory?: LifecycleDirectory; snapshot?: LifecycleSnapshot; now?: number } = {}): LifecycleStatus {
  const { directory, snapshot } = context;
  const result = (state: LifecycleStatus["state"], title: string, detail: string, provenBlockNumber?: number): LifecycleStatus => ({ state, title, detail: `${detail} ${ADMIN_NOTICE}`, ...(provenBlockNumber === undefined ? {} : { provenBlockNumber }) });
  const pending = (detail: string) => result("awaiting-proven-refresh", "Awaiting proven directory refresh", detail);
  if (evidence.localOnly) return result("receipt-recorded", "Local-fork receipt recorded", "This evidence is from a local fork and cannot demonstrate a public mainnet change.");
  if (!directory && !snapshot) return result("receipt-recorded", "Administrative receipt recorded", "Refresh the ENS directory through DeRPC to compare the expected state.");
  if (!directory || !snapshot || directory.listVerification !== "proven" || directory.recordVerification !== "proven") return pending("Both operator membership and records need a completed proven refresh.");
  const now = context.now ?? Date.now();
  if (!integer(now) || !integer(snapshot.verifiedAt) || !integer(snapshot.expiresAt) || snapshot.state !== "fresh" || now < snapshot.verifiedAt || now >= snapshot.expiresAt || snapshot.expiresAt <= snapshot.verifiedAt) return pending("The authenticated directory snapshot is stale or its clock is invalid.");
  if (!integer(directory.blockNumber) || !HASH.test(directory.blockHash) || directory.blockNumber !== snapshot.blockNumber || directory.blockHash.toLowerCase() !== snapshot.blockHash.toLowerCase()) return pending("Directory records and the current authenticated snapshot do not refer to the same block.");
  const block = directory.blockNumber;
  if (block < evidence.receipt.blockNumber) return pending("The proven directory still predates the imported receipt block.");
  if (block === evidence.receipt.blockNumber && directory.blockHash.toLowerCase() !== evidence.receipt.blockHash) return result("conflict", "Imported receipt conflicts with proven block", "The imported receipt hash differs from the authenticated block at that height.", block);
  const matchingName = (name: string) => name === evidence.name || name.startsWith(`${evidence.name}#`);
  // Probe failures omit endpoints from Directory.operators; omission is not evidence of delisting.
  if (directory.rejected.some(entry => matchingName(entry.name))) return pending("This operator has rejected or unavailable candidates; the refresh cannot establish its complete expected state.");
  const entries = directory.operators.filter(entry => entry.ens === evidence.name || entry.operatorId === evidence.name);
  const action = evidence.action;
  let matches = false;
  try {
    if (action.type === "delist") matches = entries.length === 0;
    else if (action.type === "renew") matches = entries.length > 0 && entries.every(entry => entry.expiry === action.expiry && entry.expiry * 1000 > now);
    else if (action.type === "rotate-endpoint") matches = entries.length === 1 && entries[0]!.endpointId === undefined && endpoint(entries[0]!.url) === action.newEndpoint;
    else {
      matches = entries.length === action.newEndpoints.length && action.newEndpoints.every(expected => {
        const nodes = entries.filter(entry => entry.endpointId === expected.id);
        return nodes.length === 1 && endpoint(nodes[0]!.url) === expected.url &&
          (nodes[0]!.beaconUrl === undefined ? undefined : endpoint(nodes[0]!.beaconUrl)) === expected.beaconUrl;
      });
    }
  } catch { return pending("The directory does not contain a complete valid endpoint observation for this comparison."); }
  return matches
    ? result("expected-state-observed", "Expected state observed in proven directory", action.type === "delist" ? "The operator is absent from this fresh proven directory; this alone does not identify why it is absent." : "The expected fields match this fresh proven directory; this does not establish which transaction produced them.", block)
    : result("conflict", "Expected state differs from proven directory", "The fresh proven directory does not match the imported action. It may reflect another change or incorrect imported metadata.", block);
}
