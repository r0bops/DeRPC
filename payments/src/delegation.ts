import { hashTypedData, isAddress, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import { assertTestPaymentChain, type ReadKind, type SignedVoucher } from "./protocol.ts";

export interface DelegationSession {
  chainId: number;
  escrow: Address;
  sessionId: bigint;
  /** A hard aggregate spending ceiling, at most the confirmed escrow deposit. */
  budget: bigint;
  refundAfter: number;
  safetyMarginSeconds?: number;
}

export interface DelegatedRead {
  sessionId: bigint;
  userKey: Address;
  nonce: bigint;
  charge: bigint;
  /** Digest of the exact request/result/block tuple the sponsor's verifier checks. */
  readHash: Hex;
  expiresAt: number;
}

export type DelegationVoucher = SignedVoucher;
export interface DelegationGrant { cap: bigint; spent: bigint; nextNonce: bigint; expiresAt: number; revoked: boolean }
export interface DelegationReservation { digest: Hex; userKey: Address; nonce: bigint; charge: bigint; cumulative: bigint; readHash?: Hex }
export interface DelegationReadAuthorization {
  digest: Hex; userKey: Address; nonce: bigint; charge: bigint; requestHash: Hex;
  kind: ReadKind; readId: Hex; deadline: number; expiresAt: number;
}

/** Store only counters, authorizations and signatures here, never the escrow signing key. */
export interface DelegationState {
  /** Missing only in ledgers from the initial post-proof implementation. */
  mode?: "post-proof-v1" | "sponsored-v1";
  session: string;
  budget: bigint;
  refundAfter: number;
  total: bigint;
  grants: Record<string, DelegationGrant>;
  reservations: Record<string, DelegationReservation>;
  latestVoucher?: DelegationVoucher;
  /** Sponsored mode: every issued authorization permanently consumes grant exposure. */
  readAuthorizations?: Record<string, DelegationReadAuthorization>;
  price?: bigint;
  sessionKey?: Address;
  safetyMarginSeconds?: number;
  closing?: boolean;
}

export interface DelegationStore {
  /**
   * Serializes all mutations for this session, including across processes, and durably commits
   * before resolving. If update throws, nothing commits. A storage/acknowledgement failure can
   * have an unknown commit outcome: stop that store and reopen its durable state before retrying.
   * Never restore an older counter snapshot. Process-local memory is for tests only.
   */
  transact<T>(session: string, update: (state: DelegationState | undefined) => { state: DelegationState; value: T }): Promise<T>;
}

export interface DelegationOptions<Voucher extends DelegationVoucher = DelegationVoucher> {
  session: DelegationSession;
  store: DelegationStore;
  /** This key stays in the sponsor's trusted host. Delegated browser keys cannot sign vouchers. */
  signCumulative: (amount: bigint) => Promise<Voucher>;
  /**
   * REQUIRED host-side proof verification. Check the exact read/result/block tuple and freshness,
   * and return its bound digest and authorized charge. Never accept a browser's "verified" flag.
   * This callback must not read RPC directly: use a separately tested anonymous host runtime.
   */
  verifyRead: (evidence: unknown, options?: { signal?: AbortSignal }) => Promise<{ readHash: Hex; charge: bigint }>;
  now?: () => number;
  maxRequests?: number;
}

const UINT256_MAX = (1n << 256n) - 1n;
const grantKey = (address: Address) => address.toLowerCase();
const reservationKey = (request: DelegatedRead) => `${grantKey(request.userKey)}:${request.nonce}`;

export function delegatedReadTypedData(session: Pick<DelegationSession, "chainId" | "escrow">, request: DelegatedRead) {
  return {
    domain: { name: "DeRPC Delegation", version: "1", chainId: session.chainId, verifyingContract: session.escrow },
    types: { DelegatedRead: [
      { name: "sessionId", type: "uint256" },
      { name: "userKey", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "charge", type: "uint256" },
      { name: "readHash", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ] },
    primaryType: "DelegatedRead",
    message: { ...request, expiresAt: BigInt(request.expiresAt) },
  } as const;
}

/**
 * The app funds one escrow session per operator and runs this capped signing service.
 * It sees sponsored read evidence. A browser holds only a revocable request key. This component
 * does not establish anonymous server transport: the injected proof verifier must supply that.
 */
export class CappedDelegationSigner<Voucher extends DelegationVoucher = DelegationVoucher> {
  private readonly options: DelegationOptions<Voucher>;
  private readonly session: DelegationSession;
  private readonly key: string;
  private readonly deadline: number;
  private readonly maxRequests: number;

  constructor(options: DelegationOptions<Voucher>) {
    const session = { ...options.session };
    assertTestPaymentChain(session.chainId);
    if (!Number.isSafeInteger(session.chainId) || session.chainId <= 0 || !isAddress(session.escrow) || session.escrow === zeroAddress || session.sessionId <= 0n || session.sessionId > UINT256_MAX || session.budget <= 0n || session.budget > UINT256_MAX || !Number.isSafeInteger(session.refundAfter)) throw new Error("invalid delegated session");
    const margin = session.safetyMarginSeconds ?? 600;
    if (!Number.isSafeInteger(margin) || margin < 60) throw new Error("invalid settlement safety margin");
    this.deadline = session.refundAfter - margin;
    this.maxRequests = options.maxRequests ?? 10_000;
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1) throw new Error("invalid delegation request limit");
    this.options = options;
    this.session = session;
    this.key = `${session.chainId}:${session.escrow.toLowerCase()}:${session.sessionId}`;
  }

  /** Trusted application administration only; do not expose this unauthenticated over HTTP. */
  async grant(userKey: Address, cap: bigint, expiresAt: number): Promise<void> {
    if (!isAddress(userKey) || userKey === zeroAddress || cap < 0n || cap > this.session.budget || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.deadline) throw new Error("invalid delegation grant");
    await this.transact(state => {
      this.assertOpen();
      const previous = state.grants[grantKey(userKey)];
      if (previous && cap < previous.spent) throw new Error("grant cap is below already reserved spending");
      // Regranting never resets a nonce or used budget: old authorizations cannot become new spend.
      state.grants[grantKey(userKey)] = { cap, spent: previous?.spent ?? 0n, nextNonce: previous?.nextNonce ?? 0n, expiresAt, revoked: false };
    });
  }

  /** Stops new reservations. Already authorized spend cannot be clawed back from an operator. */
  async revoke(userKey: Address): Promise<void> {
    await this.transact(state => {
      const grant = state.grants[grantKey(userKey)];
      if (grant) grant.revoked = true;
    });
  }

  async snapshot(): Promise<DelegationState> { return this.transact(state => structuredClone(state)); }

  async approve(request: DelegatedRead, signature: Hex, evidence: unknown, options: { signal?: AbortSignal } = {}): Promise<DelegationVoucher> {
    options.signal?.throwIfAborted();
    request = { ...request };
    this.validateRequest(request);
    const typed = delegatedReadTypedData(this.session, request);
    if (!await verifyTypedData({ ...typed, address: request.userKey, signature })) throw new Error("invalid delegated read signature");
    const digest = hashTypedData(typed);
    const resumed = await this.transact(state => {
      const existing = this.existingReservation(state, request, digest);
      if (!existing) this.assertAllowance(state, request);
      return existing;
    });
    if (!resumed) {
      const verified = options.signal
        ? await this.options.verifyRead(evidence, { signal: options.signal })
        : await this.options.verifyRead(evidence);
      options.signal?.throwIfAborted();
      if (verified.readHash.toLowerCase() !== request.readHash.toLowerCase() || verified.charge !== request.charge) throw new Error("verified read does not match its spending authorization");
    }
    const reservation = await this.transact(state => {
      options.signal?.throwIfAborted();
      const existing = this.existingReservation(state, request, digest);
      if (existing) return existing;
      this.assertAllowance(state, request); // repeat after verification: time, caps and revocation can change
      if (Object.keys(state.reservations).length >= this.maxRequests) throw new Error("delegation session request limit reached");
      const grant = state.grants[grantKey(request.userKey)]!;
      grant.spent += request.charge;
      grant.nextNonce++;
      state.total += request.charge;
      const reserved = { digest, userKey: request.userKey, nonce: request.nonce, charge: request.charge, cumulative: state.total };
      state.reservations[reservationKey(request)] = reserved;
      return reserved;
    });
    // Persisted before signing: a crash, thrown signer, or failed acknowledgement cannot make a
    // generated voucher's spending available again. An exact retry resumes the same reservation.
    const latest = await this.transact(state => state.latestVoucher ? { ...state.latestVoucher } : undefined);
    if (latest && latest.amount >= reservation.cumulative) return latest;
    this.assertOpen();
    options.signal?.throwIfAborted();
    const signed = await this.options.signCumulative(reservation.cumulative);
    if (signed.sessionId !== this.session.sessionId || signed.amount !== reservation.cumulative || !/^0x[0-9a-fA-F]{130}$/.test(signed.signature)) throw new Error("signer returned an invalid cumulative voucher");
    return this.transact(state => {
      if (!state.latestVoucher || state.latestVoucher.amount < signed.amount) state.latestVoucher = { sessionId: signed.sessionId, amount: signed.amount, signature: signed.signature };
      return { ...state.latestVoucher! };
    });
  }

  private async transact<T>(update: (state: DelegationState) => T): Promise<T> {
    return this.options.store.transact(this.key, existing => {
      const state = existing ?? { mode: "post-proof-v1", session: this.key, budget: this.session.budget, refundAfter: this.session.refundAfter, total: 0n, grants: {}, reservations: {} };
      if ((state.mode ?? "post-proof-v1") !== "post-proof-v1") throw new Error("delegation ledger belongs to the sponsored authorization protocol");
      if (state.session !== this.key || state.budget !== this.session.budget || state.refundAfter !== this.session.refundAfter) throw new Error("persisted delegation session configuration changed");
      return { state, value: update(state) };
    });
  }

  private existingReservation(state: DelegationState, request: DelegatedRead, digest: Hex): DelegationReservation | undefined {
    const previous = state.reservations[reservationKey(request)];
    if (previous && previous.digest !== digest) throw new Error("delegation nonce was used for another read");
    return previous ? { ...previous } : undefined;
  }

  private validateRequest(request: DelegatedRead): void {
    if (request.sessionId !== this.session.sessionId || !isAddress(request.userKey) || request.userKey === zeroAddress || request.nonce < 0n || request.nonce > UINT256_MAX || request.charge <= 0n || request.charge > UINT256_MAX || !/^0x[0-9a-fA-F]{64}$/.test(request.readHash) || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0) throw new Error("invalid delegated read");
  }

  private assertAllowance(state: DelegationState, request: DelegatedRead): void {
    this.assertOpen();
    const grant = state.grants[grantKey(request.userKey)];
    const now = this.now();
    if (!grant || grant.revoked || grant.expiresAt <= now) throw new Error("delegation missing, revoked or expired");
    if (request.expiresAt <= now || request.expiresAt > grant.expiresAt || request.expiresAt > this.deadline) throw new Error("delegated read expired or exceeds grant lifetime");
    if (request.nonce !== grant.nextNonce) throw new Error("unexpected delegation nonce");
    if (grant.spent + request.charge > grant.cap || state.total + request.charge > state.budget) throw new Error("delegated spending limit exceeded");
  }

  private now(): number { return Math.floor((this.options.now ?? Date.now)() / 1000); }
  private assertOpen(): void { if (this.now() >= this.deadline) throw new Error("delegated session is inside its settlement safety margin"); }
}

/** A serialized, process-local store for tests. Production signers require durable transactions. */
export class MemoryDelegationStore implements DelegationStore {
  private readonly states = new Map<string, DelegationState>();
  private readonly queues = new Map<string, Promise<void>>();
  async transact<T>(session: string, update: (state: DelegationState | undefined) => { state: DelegationState; value: T }): Promise<T> {
    const previous = this.queues.get(session) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => pending);
    this.queues.set(session, tail);
    await previous;
    try {
      const { state, value } = update(this.states.has(session) ? structuredClone(this.states.get(session)!) : undefined);
      this.states.set(session, structuredClone(state));
      return value;
    } finally {
      release();
      if (this.queues.get(session) === tail) this.queues.delete(session);
    }
  }
}
