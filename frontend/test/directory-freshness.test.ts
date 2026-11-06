import { describe, expect, it } from "vitest";
import type { DeRPCStatus } from "@derpc/provider";
import { directoryFreshness } from "../src/directory-freshness.ts";

const snapshot = {
  blockNumber: 26_356_339,
  blockHash: `0x${"ab".repeat(32)}`,
  verifiedAt: 1_000_000,
  expiresAt: 1_600_000,
  state: "fresh" as const,
  requiredForReads: true,
};
function status(data: unknown = snapshot, source = "verified-ens"): DeRPCStatus {
  return { routing: { source, selection: "balanced", ...(data ? { directorySnapshot: data } : {}) } } as DeRPCStatus;
}

describe("proven directory freshness display", () => {
  it("shows the proven block and exact deadline while counting age from successful verification", () => {
    const view = directoryFreshness(status(), 1_120_000);
    expect(view.blocked).toBe(false);
    expect(view.text).toContain("Proven at block 26356339 · fresh");
    expect(view.text).toContain("Checked 2 min 0 s ago");
    expect(view.text).toContain(new Date(snapshot.expiresAt).toISOString());
    expect(view.details).toContain(snapshot.blockHash);
    expect(view.details).toContain("new finalized verified refresh");
  });

  it("blocks at the deadline even without a new provider event", () => {
    expect(directoryFreshness(status(), snapshot.expiresAt - 1).blocked).toBe(false);
    const stale = directoryFreshness(status(), snapshot.expiresAt);
    expect(stale.blocked).toBe(true);
    expect(stale.text).toContain("Refresh ENS before further reads");
  });

  it("honors provider staleness and clock rollback before the wall-time deadline", () => {
    expect(directoryFreshness(status({ ...snapshot, state: "stale" }), 1_120_000).blocked).toBe(true);
    const rollback = directoryFreshness(status(), snapshot.verifiedAt - 1);
    expect(rollback.blocked).toBe(true);
    expect(rollback.text).toContain("Clock is earlier");
  });

  it("blocks mixed pools when the provider requires the snapshot but keeps independent explicit routes usable", () => {
    expect(directoryFreshness(status({ ...snapshot, state: "stale" }, "explicit"), 1_120_000).blocked).toBe(true);
    const independent = directoryFreshness(status({ ...snapshot, state: "stale", requiredForReads: false }, "explicit"), 1_120_000);
    expect(independent.blocked).toBe(false);
    expect(independent.text).toContain("current explicit routes do not depend on it");
  });

  it("refuses missing or malformed required metadata without making a new proof claim", () => {
    expect(directoryFreshness(status(null), 1_120_000).blocked).toBe(true);
    expect(directoryFreshness(status({ ...snapshot, expiresAt: NaN }), 1_120_000).blocked).toBe(true);
    expect(directoryFreshness(status({ ...snapshot, expiresAt: NaN, requiredForReads: false }, "explicit"), 1_120_000).blocked).toBe(false);
    expect(directoryFreshness(status(null, "explicit"), 1_120_000).blocked).toBe(false);
  });
});
