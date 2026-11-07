import { hashTypedData, isAddress, keccak256, stringToHex, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { DelegationReadAuthorization, DelegationSession, DelegationState, DelegationStore } from "./delegation.ts";
import { assertTestPaymentChain, closeAuthorizationTypedData, readAuthorizationTypedData, voucherTypedData, type PaymentDomain, type ReadKind, type SignedVoucher } from "./protocol.ts";

export interface SponsoredReadIntent {
  sessionId: bigint; userKey: Address; nonce: bigint; kind: ReadKind;
  requestHash: Hex; charge: bigint; expiresAt: number;
}
export interface SponsoredAuthorization { readId: Hex; deadline: number; headers: Record<string, string> }
export interface SponsoredCoordinatorOptions {
  session: DelegationSession;
  store: DelegationStore;
  /** Frozen per-read price, including each full code/call logical read. */
  price: bigint;
  /** Only the trusted app holds this escrow key. Never pass it to a delegated browser or agent. */
  signer: Pick<PrivateKeyAccount, "address" | "signTypedData">;
  verifyRead: (evidence: unknown, control: { signal?: AbortSignal; intent: Readonly<SponsoredReadIntent>; authorization: Readonly<DelegationReadAuthorization> }) => Promise<{ requestHash: Hex; readHash: Hex; charge: bigint }>;
  now?: () => number;
  maxPending?: number;
  maxRequests?: number;
}

export function sponsoredIntentTypedData(domain: PaymentDomain, intent: SponsoredReadIntent) {
  return {
    domain: { name: "DeRPC Sponsored Reads", version: "1", chainId: domain.chainId, verifyingContract: domain.escrow },
    types: { DelegatedReadIntent: [
      { name: "sessionId", type: "uint256" }, { name: "userKey", type: "address" },
      { name: "nonce", type: "uint256" }, { name: "kindHash", type: "bytes32" },
      { name: "requestHash", type: "bytes32" }, { name: "charge", type: "uint256" }, { name: "expiresAt", type: "uint64" },
    ] },
    primaryType: "DelegatedReadIntent",
    message: { ...intent, kindHash: keccak256(stringToHex(intent.kind)), expiresAt: BigInt(intent.expiresAt) },
  } as const;
}

const MAX_UINT = (1n << 256n) - 1n;
const uint = (n: unknown): n is bigint => typeof n === "bigint" && n >= 0n && n <= MAX_UINT;
const userKey = (address: Address) => address.toLowerCase();
const intentKey = (intent: SponsoredReadIntent) => `${userKey(intent.userKey)}:${intent.nonce}`;

/** A session-key signing service with durable pre-read exposure and post-proof payment. */
export class SponsoredPaymentCoordinator {
  private readonly options: SponsoredCoordinatorOptions;
  private readonly session: DelegationSession;
  private readonly key: string;
  private readonly cutoff: number;
  private readonly margin: number;
  private readonly maxPending: number;
  private readonly maxRequests: number;

  constructor(options: SponsoredCoordinatorOptions) {
    const session = { ...options.session };
    assertTestPaymentChain(session.chainId);
    if (!isAddress(session.escrow) || session.escrow.toLowerCase() === zeroAddress || !isAddress(options.signer.address) || options.signer.address.toLowerCase() === zeroAddress || !uint(session.sessionId) || !session.sessionId || !uint(session.budget) || !session.budget || !uint(options.price) || !options.price || options.price > session.budget || !Number.isSafeInteger(session.refundAfter)) throw new Error("invalid sponsored session");
    this.margin = session.safetyMarginSeconds ?? 600;
    this.maxPending = options.maxPending ?? 4;
    this.maxRequests = options.maxRequests ?? 4096;
    if (!Number.isSafeInteger(this.margin) || this.margin < 60 || !Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 4 || !Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1 || this.maxRequests > 4096) throw new Error("invalid sponsored session bounds");
    this.session = Object.freeze(session);
    this.options = Object.freeze({ ...options, signer: Object.freeze({ address: options.signer.address, signTypedData: options.signer.signTypedData }) });
    this.cutoff = session.refundAfter - this.margin;
    this.key = `${session.chainId}:${session.escrow.toLowerCase()}:${session.sessionId}`;
  }

  /** Trusted administration only. A cap covers every issued authorization, including abandoned ones. */
  async grant(address: Address, cap: bigint, expiresAt: number): Promise<void> {
    if (!isAddress(address) || address.toLowerCase() === zeroAddress || !uint(cap) || cap > this.session.budget || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.cutoff) throw new Error("invalid sponsored grant");
    this.assertRequestKey(address);
    await this.transact(state => {
      this.assertOpen(state);
      const previous = state.grants[userKey(address)];
      if (previous && cap < previous.spent) throw new Error("grant cap is below allocated exposure");
      state.grants[userKey(address)] = { cap, spent: previous?.spent ?? 0n, nextNonce: previous?.nextNonce ?? 0n, expiresAt, revoked: false };
    });
  }

  async revoke(address: Address): Promise<void> {
    await this.transact(state => { const grant = state.grants[userKey(address)]; if (grant) grant.revoked = true; });
  }

  async snapshot(): Promise<DelegationState> { return this.transact(state => structuredClone(state)); }

  async authorize(intent: SponsoredReadIntent, signature: Hex, control: { signal?: AbortSignal } = {}): Promise<SponsoredAuthorization> {
    intent = { ...intent };
    control.signal?.throwIfAborted();
    const digest = await this.authenticate(intent, signature);
    const authorization = await this.transact(state => {
      control.signal?.throwIfAborted();
      this.assertOpen(state);
      const key = intentKey(intent);
      const previous = state.readAuthorizations![key];
      if (previous) {
        if (previous.digest !== digest) throw new Error("sponsored nonce was used for another intent");
        if (this.now() >= previous.deadline) throw new Error("sponsored read authorization expired");
        return { ...previous };
      }
      const now = this.now();
      const grant = state.grants[userKey(intent.userKey)];
      if (!grant || grant.revoked || grant.expiresAt <= now || intent.expiresAt <= now || intent.expiresAt > grant.expiresAt || intent.expiresAt > this.cutoff) throw new Error("sponsored grant missing, revoked or expired");
      if (intent.nonce !== grant.nextNonce) throw new Error("unexpected sponsored nonce");
      const exposure = Object.values(state.grants).reduce((sum, item) => sum + item.spent, 0n);
      if (grant.spent + intent.charge > grant.cap || exposure + intent.charge > state.budget) throw new Error("sponsored exposure limit exceeded");
      const entries = Object.entries(state.readAuthorizations!);
      if (entries.length >= this.maxRequests) throw new Error("sponsored request limit reached");
      // Completed reads still count as unpaid until their voucher reaches the wrapper. The wrapper
      // enforces that credit itself; this additional bound covers outstanding sponsor approvals.
      if (entries.filter(([id, auth]) => !state.reservations[id] && auth.deadline > now).length >= this.maxPending) throw new Error("sponsored pending authorization limit reached");
      const authorization: DelegationReadAuthorization = {
        digest, userKey: intent.userKey, nonce: intent.nonce, charge: intent.charge,
        requestHash: intent.requestHash, kind: intent.kind, readId: digest,
        deadline: Math.min(now + 60, intent.expiresAt, this.cutoff), expiresAt: intent.expiresAt,
      };
      state.readAuthorizations![key] = authorization;
      grant.spent += intent.charge;
      grant.nextNonce++;
      return { ...authorization };
    });
    // Never refund this allocation on signer failure, cancellation or lost acknowledgement.
    control.signal?.throwIfAborted();
    if (this.now() >= authorization.deadline) throw new Error("sponsored read authorization expired");
    const readSignature = await this.options.signer.signTypedData(readAuthorizationTypedData(this.session, {
      sessionId: this.session.sessionId, readId: authorization.readId, kind: authorization.kind,
      price: authorization.charge, deadline: authorization.deadline,
    }));
    const state = await this.snapshot();
    control.signal?.throwIfAborted();
    this.assertOpen(state);
    if (this.now() >= authorization.deadline) throw new Error("sponsored read authorization expired");
    return {
      readId: authorization.readId, deadline: authorization.deadline,
      headers: {
        "x-derpc-session": this.session.sessionId.toString(), "x-derpc-read-id": authorization.readId,
        "x-derpc-read-kind": authorization.kind, "x-derpc-price": authorization.charge.toString(),
        "x-derpc-read-deadline": authorization.deadline.toString(), "x-derpc-read-authorization": readSignature,
        ...(state.latestVoucher ? { "x-derpc-voucher": JSON.stringify({ amount: state.latestVoucher.amount.toString(), signature: state.latestVoucher.signature }) } : {}),
      },
    };
  }

  async complete(intent: SponsoredReadIntent, signature: Hex, evidence: unknown, control: { signal?: AbortSignal } = {}): Promise<SignedVoucher> {
    intent = { ...intent };
    control.signal?.throwIfAborted();
    const digest = await this.authenticate(intent, signature);
    const key = intentKey(intent);
    const previous = await this.transact(state => {
      const authorization = state.readAuthorizations![key];
      if (!authorization || authorization.digest !== digest) throw new Error("unknown sponsored authorization");
      return { authorization: { ...authorization }, completed: state.reservations[key] ? { ...state.reservations[key]! } : undefined };
    });
    let readHash = previous.completed?.readHash;
    if (!previous.completed) {
      this.assertCompletionLive(previous.authorization);
      const verified = await this.options.verifyRead(evidence, { signal: control.signal, intent: Object.freeze({ ...intent }), authorization: Object.freeze({ ...previous.authorization }) });
      control.signal?.throwIfAborted();
      if (verified.requestHash.toLowerCase() !== intent.requestHash.toLowerCase() || verified.charge !== intent.charge || !/^0x[0-9a-fA-F]{64}$/.test(verified.readHash)) throw new Error("verified evidence does not match the sponsored intent");
      readHash = verified.readHash.toLowerCase() as Hex;
    }
    const reservation = await this.transact(state => {
      control.signal?.throwIfAborted();
      const existing = state.reservations[key];
      if (existing) return { ...existing };
      this.assertOpen(state);
      this.assertCompletionLive(state.readAuthorizations![key]!);
      state.total += intent.charge;
      const reservation = { digest, userKey: previous.authorization.userKey, nonce: intent.nonce, charge: intent.charge, cumulative: state.total, readHash };
      state.reservations[key] = reservation;
      return { ...reservation };
    });
    // This committed cumulative includes only independently verified completions, never pending work.
    const state = await this.snapshot();
    if (state.latestVoucher && state.latestVoucher.amount >= reservation.cumulative) return { ...state.latestVoucher };
    if (this.now() >= this.cutoff) throw new Error("sponsored session reached settlement margin");
    control.signal?.throwIfAborted();
    return this.signTotal(reservation.cumulative);
  }

  /** Trusted sponsor administration only; deliberately absent from the HTTP/browser API. */
  async prepareClose(): Promise<{ voucher: SignedVoucher; closeAuthorization: Hex; closeDeadline: number }> {
    const total = await this.transact(state => { state.closing = true; return state.total; });
    const closeDeadline = Math.min(this.now() + 60, this.session.refundAfter - 1);
    if (closeDeadline <= this.now()) throw new Error("session reached refund deadline");
    const voucher = await this.signTotal(total);
    const closeAuthorization = await this.options.signer.signTypedData(closeAuthorizationTypedData(this.session, { sessionId: this.session.sessionId, amount: voucher.amount, deadline: closeDeadline }));
    return { voucher, closeAuthorization, closeDeadline };
  }

  private async signTotal(amount: bigint): Promise<SignedVoucher> {
    const signature = await this.options.signer.signTypedData(voucherTypedData(this.session, this.session.sessionId, amount));
    return this.transact(state => {
      if (!state.latestVoucher || state.latestVoucher.amount < amount) state.latestVoucher = { sessionId: this.session.sessionId, amount, signature };
      return { ...state.latestVoucher! };
    });
  }

  private async authenticate(intent: SponsoredReadIntent, signature: Hex): Promise<Hex> {
    if (intent.sessionId !== this.session.sessionId || !isAddress(intent.userKey) || intent.userKey.toLowerCase() === zeroAddress || !uint(intent.nonce) || intent.charge !== this.options.price || !["proof", "code", "call"].includes(intent.kind) || !/^0x[0-9a-fA-F]{64}$/.test(intent.requestHash) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= 0) throw new Error("invalid sponsored intent");
    this.assertRequestKey(intent.userKey); // Also refuse unsafe grants written by an older coordinator.
    const typed = sponsoredIntentTypedData(this.session, intent);
    if (!await verifyTypedData({ ...typed, address: intent.userKey, signature })) throw new Error("invalid sponsored intent signature");
    return hashTypedData(typed);
  }

  private assertRequestKey(address: Address): void {
    if (userKey(address) === userKey(this.options.signer.address)) throw new Error("escrow session key cannot be used as a delegated request key");
  }

  private async transact<T>(update: (state: DelegationState) => T): Promise<T> {
    return this.options.store.transact(this.key, existing => {
      const state: DelegationState = existing ?? {
        mode: "sponsored-v1", session: this.key, budget: this.session.budget, refundAfter: this.session.refundAfter,
        total: 0n, grants: {}, reservations: {}, readAuthorizations: {}, price: this.options.price,
        sessionKey: this.options.signer.address, safetyMarginSeconds: this.margin,
      };
      if (state.mode !== "sponsored-v1" || state.session !== this.key || state.budget !== this.session.budget || state.refundAfter !== this.session.refundAfter || state.price !== this.options.price || state.sessionKey?.toLowerCase() !== this.options.signer.address.toLowerCase() || state.safetyMarginSeconds !== this.margin || !state.readAuthorizations) throw new Error("persisted sponsored session mode or configuration changed");
      return { state, value: update(state) };
    });
  }
  private now(): number { return Math.floor((this.options.now ?? Date.now)() / 1000); }
  private assertOpen(state: DelegationState): void { if (state.closing || this.now() >= this.cutoff) throw new Error("sponsored session is closing or inside settlement margin"); }
  // Previously issued authorizations may complete after grant revocation, within this fixed short
  // deadline and their already allocated exposure. They cannot extend it or obtain a new nonce.
  private assertCompletionLive(authorization: DelegationReadAuthorization): void { if (this.now() >= authorization.deadline) throw new Error("sponsored completion deadline expired"); }
}
