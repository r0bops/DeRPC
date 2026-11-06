import type { DeRPCStatus } from "@derpc/provider";

export interface DirectoryFreshnessView {
  blocked: boolean;
  text: string;
  details: string;
  tone: "muted" | "ok" | "warn";
}

const duration = (ms: number): string => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.floor(ms / 1000) % 60} s`;
const validDate = (value: number) => Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000;

/** Display the provider's authenticated snapshot; clicking Refresh never renews these times. */
export function directoryFreshness(status: DeRPCStatus, now = Date.now()): DirectoryFreshnessView {
  const routing = status.routing;
  const snapshot = routing?.directorySnapshot;
  const required = snapshot?.requiredForReads ?? (routing?.source === "verified-ens");
  if (!snapshot) {
    return {
      blocked: required,
      text: required ? "ENS snapshot unavailable — refresh ENS before reads." : "No proven ENS snapshot loaded.",
      details: "Membership and records are known only at the last proven finalized block. A new verified refresh is needed to observe later changes.",
      tone: required ? "warn" : "muted",
    };
  }
  if (!Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0 || !/^0x[\da-fA-F]{64}$/.test(snapshot.blockHash) ||
    !validDate(snapshot.verifiedAt) || !validDate(snapshot.expiresAt) || !["fresh", "stale"].includes(snapshot.state)) {
    return {
      blocked: required,
      text: required ? "ENS snapshot metadata unavailable — refresh ENS before reads." : "Cached ENS snapshot metadata unavailable; current explicit routes do not depend on it.",
      details: "No freshness interval can be established from this metadata.", tone: "warn",
    };
  }
  const stale = snapshot.state === "stale" || now >= snapshot.expiresAt || now < snapshot.verifiedAt;
  const timing = now < snapshot.verifiedAt ? "Clock is earlier than verification time." : `Checked ${duration(now - snapshot.verifiedAt)} ago.`;
  const deadline = new Date(snapshot.expiresAt).toISOString();
  return {
    blocked: required && stale,
    text: `Proven at block ${snapshot.blockNumber} · ${stale ? "stale" : "fresh"}. ${timing} ${stale ? "Validity deadline" : "Expires"} ${deadline}${stale ? "." : ` (${duration(snapshot.expiresAt - now)} left).`} ${required ? stale ? "Refresh ENS before further reads." : "Required for current reads." : "Cached; current explicit routes do not depend on it."}`,
    details: `Block hash ${snapshot.blockHash}. Verified ${new Date(snapshot.verifiedAt).toISOString()}. Later membership and record changes become visible only after a new finalized verified refresh.`,
    tone: stale ? "warn" : required ? "ok" : "muted",
  };
}
