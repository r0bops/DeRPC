import { isAddress, isHex, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { assertTestPaymentChain, closeAuthorizationTypedData, readAuthorizationTypedData, voucherTypedData, type PaymentDomain, type ReadKind, type SignedVoucher } from "./protocol.ts";

export interface PaymentSessionOptions extends PaymentDomain {
  operatorId: string;
  sessionId: bigint;
  payer: Address;
  payee: Address;
  /** Ephemeral key named by the confirmed on-chain session. Never exposed by snapshot(). */
  signer: Pick<PrivateKeyAccount, "address" | "signTypedData">;
  deposit: bigint;
  price: bigint;
  refundAfter: number;
  creditWindow?: number;
  /** Cooperative host policy only; a raw session-key holder can bypass it. Delegate agent keys instead. */
  spendLimit?: bigint;
  safetyMarginSeconds?: number;
}

export interface PaymentSessionSnapshot {
  operatorId: string;
  chainId: number;
  escrow: Address;
  sessionId: bigint;
  payer: Address;
  payee: Address;
  sessionKey: Address;
  deposit: bigint;
  price: bigint;
  spendLimit: bigint;
  total: bigint;
  verifiedReads: number;
  inFlight: number;
  refundAfter: number;
  remaining: bigint;
  status: "ready" | "closing" | "expired" | "exhausted" | "disposed";
}

export interface PaymentAttempt {
  readonly readId: Hex;
  headers(): Record<string, string>;
  /** Invoke only after the complete logical read and its final freshness check succeed. */
  verified(signal?: AbortSignal): Promise<SignedVoucher>;
  /** Invalid proofs, cancellation, transport failure: release the local reservation, sign no voucher. */
  failed(): void;
}

interface Session {
  options: Readonly<PaymentSessionOptions>;
  deposit: bigint;
  spendLimit: bigint;
  total: bigint;
  verifiedReads: number;
  inFlight: number;
  voucher?: SignedVoucher;
  closing: boolean;
  disposed: boolean;
  queue: Promise<unknown>;
}

const UINT256_MAX = (1n << 256n) - 1n;
const uint256 = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= UINT256_MAX;

export class PaymentClient {
  private readonly sessions = new Map<string, Session>();
  private readonly usedSessions = new Set<string>();
  private readonly now: () => number;
  private readonly onChange?: (snapshots: PaymentSessionSnapshot[]) => void;

  constructor(options: { now?: () => number; onChange?: (snapshots: PaymentSessionSnapshot[]) => void } = {}) {
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  /** Call only after the wallet's deposit receipt and on-chain session fields have been checked. */
  addSession(options: PaymentSessionOptions): void {
    assertTestPaymentChain(options.chainId);
    for (const address of [options.escrow, options.payer, options.payee, options.signer.address]) {
      if (!isAddress(address) || address.toLowerCase() === zeroAddress) throw new Error("invalid payment address");
    }
    if (!options.operatorId || !uint256(options.sessionId) || options.sessionId === 0n || !uint256(options.deposit) || options.deposit === 0n || !uint256(options.price) || options.price === 0n || options.price > options.deposit) throw new Error("invalid payment session");
    if (!Number.isSafeInteger(options.refundAfter) || options.refundAfter <= 0) throw new Error("invalid refund deadline");
    const creditWindow = options.creditWindow ?? 4;
    const safetyMarginSeconds = options.safetyMarginSeconds ?? 600;
    if (!Number.isSafeInteger(creditWindow) || creditWindow < 1 || creditWindow > 32 || !Number.isSafeInteger(safetyMarginSeconds) || safetyMarginSeconds < 60) throw new Error("invalid payment window");
    const spendLimit = options.spendLimit ?? options.deposit;
    if (!uint256(spendLimit) || spendLimit === 0n || spendLimit > options.deposit) throw new Error("spending limit exceeds the funded deposit");
    if (this.sessions.has(options.operatorId)) throw new Error("remove or finish the existing operator session before replacing it");
    const identity = `${options.chainId}:${options.escrow.toLowerCase()}:${options.sessionId}`;
    if (this.usedSessions.has(identity)) throw new Error("cannot reset a previously attached session's signed total");
    const session: Session = {
      options: Object.freeze({ ...options, signer: Object.freeze({ address: options.signer.address, signTypedData: options.signer.signTypedData }), creditWindow, safetyMarginSeconds }), deposit: options.deposit,
      spendLimit, total: 0n, verifiedReads: 0, inFlight: 0, closing: false, disposed: false, queue: Promise.resolve(),
    };
    this.assertReady(session);
    this.sessions.set(options.operatorId, session);
    this.usedSessions.add(identity);
    this.notify();
  }

  has(operatorId: string): boolean { return this.sessions.has(operatorId); }
  latestVoucher(operatorId: string): SignedVoucher | undefined {
    const voucher = this.get(operatorId).voucher;
    return voucher ? { ...voucher } : undefined;
  }

  async begin(operatorId: string, kind: ReadKind, options: { signal?: AbortSignal } = {}): Promise<PaymentAttempt> {
    if (!["proof", "code", "call"].includes(kind)) throw new Error("invalid paid-read kind");
    options.signal?.throwIfAborted();
    const session = this.get(operatorId);
    this.assertReady(session);
    if (session.inFlight >= session.options.creditWindow!) throw new Error("payment credit window is full");
    if (session.total + BigInt(session.inFlight + 1) * session.options.price > session.spendLimit) throw new Error("payment spending limit reached");
    session.inFlight++;
    this.notify();
    let phase: "reserved" | "signing" | "complete" | "failed" = "reserved";
    const fail = () => {
      if (phase !== "reserved") return;
      phase = "failed"; session.inFlight--; this.notify();
    };
    const readId = randomId();
    const deadline = Math.min(Math.floor(this.now() / 1000) + 60, session.options.refundAfter - session.options.safetyMarginSeconds!);
    const authorization = { sessionId: session.options.sessionId, readId, kind, price: session.options.price, deadline };
    let signature: Hex;
    try {
      signature = await session.options.signer.signTypedData(readAuthorizationTypedData(session.options, authorization));
      options.signal?.throwIfAborted();
      this.assertReady(session);
    } catch (error) { fail(); throw error; }

    return {
      readId,
      headers: () => {
        if (phase !== "reserved") throw new Error("paid read is no longer active");
        options.signal?.throwIfAborted();
        this.assertReady(session);
        if (Math.floor(this.now() / 1000) >= deadline) throw new Error("paid read authorization expired");
        const voucher = session.voucher;
        return {
          "x-derpc-session": session.options.sessionId.toString(),
          "x-derpc-read-id": readId,
          "x-derpc-read-kind": kind,
          "x-derpc-price": session.options.price.toString(),
          "x-derpc-read-deadline": deadline.toString(),
          "x-derpc-read-authorization": signature,
          ...(voucher ? { "x-derpc-voucher": JSON.stringify({ amount: voucher.amount.toString(), signature: voucher.signature }) } : {}),
        };
      },
      verified: async (signal?: AbortSignal) => {
        if (phase !== "reserved") throw new Error("paid read already completed");
        try { options.signal?.throwIfAborted(); signal?.throwIfAborted(); }
        catch (error) { fail(); throw error; }
        phase = "signing";
        const signing = session.queue.then(async () => {
          options.signal?.throwIfAborted(); signal?.throwIfAborted();
          this.assertReady(session);
          const amount = session.total + session.options.price;
          if (amount > session.spendLimit) throw new Error("payment spending limit reached");
          const signed = await session.options.signer.signTypedData(voucherTypedData(session.options, session.options.sessionId, amount));
          // A signature has been created. Retain its total even if cancellation arrives during signing;
          // forgetting it would allow a later voucher to regress or exceed a delegated cap.
          const voucher = { sessionId: session.options.sessionId, amount, signature: signed };
          session.total = amount; session.voucher = voucher; session.verifiedReads++;
          return { ...voucher };
        });
        session.queue = signing.catch(() => {});
        try { const result = await signing; phase = "complete"; return result; }
        catch (error) { phase = "failed"; throw error; }
        finally { session.inFlight--; this.notify(); }
      },
      failed: fail,
    };
  }

  /** Supply a newly confirmed deposit value; a top-up never silently raises this local spending policy. */
  updateDeposit(operatorId: string, confirmedDeposit: bigint): void {
    const session = this.get(operatorId);
    if (!uint256(confirmedDeposit) || confirmedDeposit < session.deposit || confirmedDeposit < session.total) throw new Error("deposit cannot decrease or exceed uint256");
    session.deposit = confirmedDeposit;
    this.notify();
  }

  /**
   * Explicit app/user action, separate from funding. Existing reservations count against the cap.
   * This is host policy; a holder of the raw session key can sign up to the on-chain deposit.
   */
  setSpendLimit(operatorId: string, limit: bigint): void {
    const session = this.get(operatorId);
    if (!uint256(limit) || limit < session.total + BigInt(session.inFlight) * session.options.price || limit > session.deposit) throw new Error("invalid spending limit");
    session.spendLimit = limit; this.notify();
  }

  /** Stop starting reads before delivering the final voucher for one closing transaction. */
  async finish(operatorId: string): Promise<SignedVoucher | undefined> {
    const session = this.get(operatorId);
    if (session.inFlight) throw new Error("wait for pending reads before closing the payment session");
    session.closing = true;
    await session.queue;
    this.notify();
    // The operator may have been detached or assigned a new session while awaiting the queue.
    return session.voucher ? { ...session.voucher } : undefined;
  }

  /** Explicit close intent, separate from a replayable cumulative voucher. */
  async prepareClose(operatorId: string): Promise<{ voucher: SignedVoucher; closeAuthorization: Hex; closeDeadline: number }> {
    const session = this.get(operatorId);
    await this.finish(operatorId);
    const closeDeadline = Math.min(Math.floor(this.now() / 1000) + 60, session.options.refundAfter - 1);
    if (closeDeadline <= this.now() / 1000) throw new Error("session reached its refund deadline; use refund instead");
    if (!session.voucher) {
      session.voucher = {
        sessionId: session.options.sessionId, amount: 0n,
        signature: await session.options.signer.signTypedData(voucherTypedData(session.options, session.options.sessionId, 0n)),
      };
    }
    const closeAuthorization = await session.options.signer.signTypedData(closeAuthorizationTypedData(session.options, {
      sessionId: session.options.sessionId, amount: session.voucher.amount, deadline: closeDeadline,
    }));
    return { voucher: { ...session.voucher }, closeAuthorization, closeDeadline };
  }

  /** Call after settlement/refund or intentionally abandoning the bounded deposit; it forgets the key. */
  removeSession(operatorId: string): void {
    const session = this.get(operatorId);
    if (session.inFlight) throw new Error("cannot dispose a session with pending reads");
    session.disposed = true;
    this.sessions.delete(operatorId);
    this.notify();
  }

  snapshot(): PaymentSessionSnapshot[] {
    return [...this.sessions].map(([operatorId, s]) => ({
      operatorId, chainId: s.options.chainId, escrow: s.options.escrow, sessionId: s.options.sessionId,
      payer: s.options.payer, payee: s.options.payee, sessionKey: s.options.signer.address,
      deposit: s.deposit, price: s.options.price, spendLimit: s.spendLimit, total: s.total,
      verifiedReads: s.verifiedReads, inFlight: s.inFlight, refundAfter: s.options.refundAfter,
      remaining: s.spendLimit - s.total - BigInt(s.inFlight) * s.options.price,
      status: s.disposed ? "disposed" : s.closing ? "closing" : this.now() / 1000 >= s.options.refundAfter - s.options.safetyMarginSeconds! ? "expired" : s.total + s.options.price > s.spendLimit ? "exhausted" : "ready",
    }));
  }

  private get(operatorId: string): Session {
    const session = this.sessions.get(operatorId);
    if (!session) throw new Error("operator has no funded payment session");
    return session;
  }
  private assertReady(session: Session): void {
    if (session.closing || session.disposed) throw new Error("payment session is closed for reads");
    if (this.now() / 1000 >= session.options.refundAfter - session.options.safetyMarginSeconds!) throw new Error("payment session is too close to refund timeout");
  }
  private notify() {
    try { this.onChange?.(this.snapshot()); } catch { /* Observers cannot change payment accounting. */ }
  }
}

function randomId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Validate voucher acknowledgements without creating another network path. */
export async function verifyVoucher(domain: PaymentDomain, sessionKey: Address, voucher: SignedVoucher): Promise<boolean> {
  try {
    return uint256(voucher.sessionId) && voucher.sessionId > 0n && uint256(voucher.amount) && isHex(voucher.signature) && await verifyTypedData({ ...voucherTypedData(domain, voucher.sessionId, voucher.amount), address: sessionKey, signature: voucher.signature });
  } catch { return false; }
}
