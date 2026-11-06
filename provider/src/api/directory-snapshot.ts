import type { VerifiedHeader } from "../light-client/header-source.ts";

export const DIRECTORY_SNAPSHOT_TTL_MS = 10 * 60_000;
export const DIRECTORY_SNAPSHOT_MAX_BLOCK_AGE_MS = 30 * 60_000;

export interface DirectorySnapshotStatus {
  blockNumber: number;
  blockHash: `0x${string}`;
  /** Unix milliseconds when this authenticated block was first accepted as a directory snapshot. */
  verifiedAt: number;
  /** Unix milliseconds; also limited by the authenticated block's age. */
  expiresAt: number;
  state: "fresh" | "stale";
  /** False when the current pool contains only independently configured endpoints. */
  requiredForReads: boolean;
}

export class DirectorySnapshotExpiredError extends Error {
  override name = "DirectorySnapshotExpiredError";
  constructor(detail = "expired", options?: ErrorOptions) {
    super(`ENS directory snapshot ${detail}; refresh proven records before reading`, options);
  }
}

/** Host-local authorization lifetime. No status call or repeated block can renew this object. */
export class DirectorySnapshotLease {
  readonly verifiedAt = Date.now();
  readonly expiresAt: number;
  readonly controller = new AbortController();
  private readonly monotonicAt = performance.now();
  private lastWall = this.verifiedAt;
  private lastMonotonic = this.monotonicAt;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly block: VerifiedHeader, private readonly onExpired: () => void) {
    if (!Number.isSafeInteger(this.verifiedAt) || this.verifiedAt < 0 || !Number.isFinite(this.monotonicAt) ||
      !Number.isSafeInteger(block.timestamp) || block.timestamp < 0) throw new DirectorySnapshotExpiredError("has an invalid clock");
    this.expiresAt = Math.min(this.verifiedAt + DIRECTORY_SNAPSHOT_TTL_MS, block.timestamp * 1000 + DIRECTORY_SNAPSHOT_MAX_BLOCK_AGE_MS);
    this.assertFresh();
    this.timer = setTimeout(() => this.expire(new DirectorySnapshotExpiredError()), this.expiresAt - this.verifiedAt);
  }

  assertFresh(): void {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    const wall = Date.now(), monotonic = performance.now();
    if (!Number.isSafeInteger(wall) || !Number.isFinite(monotonic) || wall < this.lastWall || monotonic < this.lastMonotonic) {
      this.expire(new DirectorySnapshotExpiredError("clock moved backwards"));
    } else {
      this.lastWall = wall;
      this.lastMonotonic = monotonic;
      if (wall >= this.expiresAt || monotonic - this.monotonicAt >= this.expiresAt - this.verifiedAt) this.expire(new DirectorySnapshotExpiredError());
    }
    this.controller.signal.throwIfAborted();
  }

  expire(error: DirectorySnapshotExpiredError): void {
    if (this.controller.signal.aborted) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller.abort(error);
    this.onExpired();
  }

  status(requiredForReads: boolean): DirectorySnapshotStatus {
    try { this.assertFresh(); } catch { /* stale state remains observable */ }
    return { blockNumber: this.block.blockNumber, blockHash: this.block.blockHash, verifiedAt: this.verifiedAt,
      expiresAt: this.expiresAt, state: this.controller.signal.aborted ? "stale" : "fresh", requiredForReads };
  }

  dispose(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
}
