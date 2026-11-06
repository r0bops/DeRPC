import { keccak256, stringToHex, verifyTypedData, type Address, type Hex } from "viem";
import { voucherTypedData, readAuthorizationTypedData, closeAuthorizationTypedData } from "@derpc/payments";
import type { PaymentStore, StoredPaymentSession, StoredRead, StoredVoucher } from "./payment-store.ts";

export interface ChainSession { payer: Address; operator: Address; sessionKey: Address; deposit: bigint; refundAfter: number; closed: boolean }
export interface PaymentChain {
  session(id: bigint): Promise<ChainSession>;
  prepareClose(id: bigint, amount: bigint, signature: Hex): Promise<{ transactionHash: Hex; serializedTransaction: Hex }>;
  broadcast(serializedTransaction: Hex): Promise<void>;
  receipt(hash: Hex): Promise<"pending" | "success" | "reverted">;
}
export interface PaymentConfig {
  chainId: number;
  escrow: Address;
  operator: Address;
  price: bigint;
  creditWindow?: number;
  safetyMarginSeconds?: number;
  now?: () => number;
  store: PaymentStore;
  chain: PaymentChain;
}
export interface PaymentRpc { method: string; params: unknown[] }
export interface PaymentStatus {
  highestAmount: string;
  settlement: { state: StoredPaymentSession["settlement"]["state"]; transactionHash?: Hex; paid?: string; refunded?: string; error?: string };
}
export class PaymentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const uint = /^(0|[1-9]\d{0,77})$/;
const bytes32 = /^0x[\da-fA-F]{64}$/;
const signaturePattern = /^0x[\da-fA-F]{130}$/;

/** This exempts only public supply-chain bootstrap reads. It does not provide a free arbitrary RPC. */
export function isUnpaidBootstrap(call: PaymentRpc): boolean {
  if (call.method === "eth_chainId") return true;
  const [account, keys] = call.params;
  const specifiers = ["0x700da3193d35fa54cd3fbf29b66f2a2a0385659e", "0x3acd9742c68f6d993066ae25533e09b9e1f60ed0"];
  return call.method === "eth_getProof" && typeof account === "string" && specifiers.includes(account.toLowerCase()) &&
    Array.isArray(keys) && keys.length === 1 && typeof keys[0] === "string" && /^0x[\da-fA-F]{1,64}$/.test(keys[0]) && BigInt(keys[0]) === 1n;
}

export function createPaymentController(config: PaymentConfig) {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const margin = config.safetyMarginSeconds ?? 600;
  const window = config.creditWindow ?? 4;
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 || config.price <= 0n || !Number.isSafeInteger(window) || window < 1 || window > 32 || !Number.isSafeInteger(margin) || margin < 60) throw new Error("invalid payment configuration");
  const domain = { chainId: config.chainId, escrow: config.escrow };
  const queues = new Map<string, Promise<unknown>>();
  const queuedPerSession = new Map<string, number>();
  let queued = 0;
  let submissions: Promise<unknown> = Promise.resolve();
  let accepting = true;
  const active = new Set<Promise<void>>();
  function enter(): () => void {
    if (!accepting) throw new PaymentError(503, "payment controller is shutting down");
    if (active.size >= 64) throw new PaymentError(429, "payment operation limit reached");
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    active.add(completion);
    return () => { active.delete(completion); finish(); };
  }
  async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (queued >= 64 || (queuedPerSession.get(id) ?? 0) >= 16) throw new PaymentError(429, "payment session queue limit reached");
    queued++;
    queuedPerSession.set(id, (queuedPerSession.get(id) ?? 0) + 1);
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(id, next);
    try { return await next; } finally {
      queued--;
      const remaining = (queuedPerSession.get(id) ?? 1) - 1;
      if (remaining) queuedPerSession.set(id, remaining); else queuedPerSession.delete(id);
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function sessionId(value: unknown): string {
    if (typeof value !== "string" || !uint.test(value) || BigInt(value) === 0n || BigInt(value) >= 1n << 256n) throw new PaymentError(400, "invalid payment session id");
    return value;
  }
  async function readSession(id: string): Promise<StoredPaymentSession> {
    const chain = await config.chain.session(BigInt(id));
    if (chain.closed || chain.deposit <= 0n || chain.operator.toLowerCase() !== config.operator.toLowerCase() || /^0x0{40}$/i.test(chain.payer) || /^0x0{40}$/i.test(chain.sessionKey)) throw new PaymentError(402, "session is unfunded, closed or belongs to another operator");
    let stored = await config.store.load(id);
    if (!stored) stored = { version: 1, chainId: config.chainId, escrow: config.escrow, sessionId: id, payer: chain.payer, operator: chain.operator, sessionKey: chain.sessionKey, price: config.price.toString(), deposit: chain.deposit.toString(), refundAfter: chain.refundAfter, served: 0, reads: {}, settlement: { state: "open" } };
    if (stored.chainId !== config.chainId || stored.escrow.toLowerCase() !== config.escrow.toLowerCase() || stored.payer.toLowerCase() !== chain.payer.toLowerCase() || stored.sessionKey.toLowerCase() !== chain.sessionKey.toLowerCase() || stored.operator.toLowerCase() !== chain.operator.toLowerCase() || stored.refundAfter !== chain.refundAfter) throw new PaymentError(409, "session chain data conflicts with durable state");
    stored.deposit = chain.deposit.toString();
    return stored;
  }
  function parseVoucher(value: unknown): StoredVoucher {
    const voucher = value as StoredVoucher;
    if (!voucher || typeof voucher.amount !== "string" || !uint.test(voucher.amount) || typeof voucher.signature !== "string" || !signaturePattern.test(voucher.signature)) throw new PaymentError(400, "invalid voucher encoding");
    return voucher;
  }
  async function acceptVoucher(session: StoredPaymentSession, value: unknown): Promise<void> {
    const voucher = parseVoucher(value);
    const amount = BigInt(voucher.amount);
    if (amount > BigInt(session.deposit) || amount > BigInt(session.served) * BigInt(session.price)) throw new PaymentError(402, "voucher exceeds deposit or served reads");
    const valid = await verifyTypedData({ address: session.sessionKey, ...voucherTypedData(domain, BigInt(session.sessionId), amount), signature: voucher.signature });
    if (!valid) throw new PaymentError(401, "invalid voucher signature");
    // Delayed parallel requests may carry an older valid voucher. They never decrease our claim.
    if (!session.highest || amount > BigInt(session.highest.amount)) session.highest = voucher;
  }
  function status(session: StoredPaymentSession): PaymentStatus {
    const settlement = session.settlement;
    return { highestAmount: session.highest?.amount ?? "0", settlement: {
      state: settlement.state, transactionHash: settlement.transactionHash, error: settlement.error,
      ...(settlement.state === "confirmed" ? { paid: settlement.amount ?? "0", refunded: (BigInt(session.deposit) - BigInt(settlement.amount ?? "0")).toString() } : {}),
    } };
  }
  async function settle(session: StoredPaymentSession): Promise<void> {
    if (session.settlement.state === "confirmed" || (session.settlement.state === "expired" && !session.settlement.transactionHash)) return;
    if (session.settlement.transactionHash) {
      const receipt = await config.chain.receipt(session.settlement.transactionHash);
      if (receipt === "success") {
        // A top-up may have landed after submission. Refresh its actual refund basis before reporting.
        const current = await config.chain.session(BigInt(session.sessionId));
        session.deposit = current.deposit.toString();
        session.settlement.state = "confirmed"; delete session.settlement.error; await config.store.save(session); return;
      }
      if (receipt === "pending") {
        const expired = session.settlement.state === "expired" || now() >= session.refundAfter;
        let broadcastFailed = false;
        // Preserve and replay the original transaction even after its claim expires. If a
        // failed broadcast left its nonce absent from the node, abandoning it would strand
        // every later settlement from this operator behind that nonce. No replacement is signed.
        if (session.settlement.serializedTransaction) {
          try { await config.chain.broadcast(session.settlement.serializedTransaction); }
          catch { broadcastFailed = true; }
        }
        if (expired) {
          session.settlement.state = "expired"; session.settlement.error = "settlement still pending at refund deadline";
          if (session.settlement.serializedTransaction) session.settlement.error += "; retrying original transaction to consume its nonce";
        } else {
          session.settlement.state = "pending";
          if (broadcastFailed) session.settlement.error = "settlement broadcast failed; retrying identical signed transaction";
          else delete session.settlement.error;
        }
        await config.store.save(session);
        return;
      }
      if (session.settlement.state === "expired" || now() >= session.refundAfter) {
        // The reverted transaction consumed its nonce. Retain its exact durable evidence;
        // the payer can refund, and later operator transactions are no longer held up.
        session.settlement.state = "expired";
        session.settlement.error = "settlement transaction reverted after expiry; nonce consumed";
        await config.store.save(session);
        return;
      }
      session.settlement = { state: "failed", error: "settlement transaction reverted" };
      await config.store.save(session);
    }
    if (now() >= session.refundAfter) { session.settlement.state = "expired"; session.settlement.error = "refund deadline passed before settlement"; await config.store.save(session); return; }
    if (!session.highest) return;
    // One key settles all sessions. Serialize nonce reservation and journal it before network send.
    const submit = submissions.catch(() => {}).then(async () => {
      try {
        const current = await config.chain.session(BigInt(session.sessionId));
        if (current.closed) {
          session.settlement = { state: "failed", error: "session closed on-chain; reconcile its transaction before retrying" };
          await config.store.save(session);
          return;
        }
        const prepared = await config.chain.prepareClose(BigInt(session.sessionId), BigInt(session.highest!.amount), session.highest!.signature);
        session.settlement = { state: "submitting", ...prepared, amount: session.highest!.amount };
        await config.store.save(session);
      } catch {
        session.settlement = { state: "failed", error: "settlement preparation failed; will retry before deadline" };
        await config.store.save(session);
        return;
      }
      try { await config.chain.broadcast(session.settlement.serializedTransaction!); }
      catch { session.settlement.error = "settlement broadcast failed; retrying identical signed transaction"; }
      session.settlement.state = "pending";
      await config.store.save(session);
    });
    submissions = submit;
    await submit;
  }

  return {
    /** Reserve unpaid credit and durably record replay budgets BEFORE sending any node work. */
    async admit(headers: Headers, calls: readonly PaymentRpc[], signal?: AbortSignal): Promise<void> {
      const leave = enter();
      try {
      const billed = calls.filter(call => !isUnpaidBootstrap(call));
      if (!billed.length) return;
      const id = sessionId(headers.get("x-derpc-session"));
      const readId = (headers.get("x-derpc-read-id") ?? "").toLowerCase();
      const kind = headers.get("x-derpc-read-kind");
      const deadlineString = headers.get("x-derpc-read-deadline") ?? "";
      const priceString = headers.get("x-derpc-price") ?? "";
      const authorization = headers.get("x-derpc-read-authorization") ?? "";
      if (!bytes32.test(readId) || !["proof", "code", "call"].includes(kind ?? "") || !uint.test(deadlineString) || !uint.test(priceString) || !signaturePattern.test(authorization)) throw new PaymentError(401, "signed read authorization required");
      await locked(id, async () => {
        signal?.throwIfAborted();
        const session = await readSession(id);
        signal?.throwIfAborted();
        const deadline = Number(deadlineString);
        if (!Number.isSafeInteger(deadline) || deadline < now() || deadline > now() + 300 || deadline > session.refundAfter - margin || now() >= session.refundAfter - margin) throw new PaymentError(402, "read authorization expired or session needs settlement");
        if (!["open", "failed"].includes(session.settlement.state)) throw new PaymentError(402, "session is settling");
        if (priceString !== session.price) throw new PaymentError(402, "read price differs from the frozen session price");
        const valid = await verifyTypedData({ address: session.sessionKey, ...readAuthorizationTypedData(domain, {
          sessionId: BigInt(id), readId: readId as Hex, kind: kind as StoredRead["kind"], price: BigInt(priceString), deadline,
        }), signature: authorization as Hex });
        if (!valid) throw new PaymentError(401, "invalid read authorization signature");
        const previousVoucher = headers.get("x-derpc-voucher");
        if (previousVoucher) {
          let parsed: unknown;
          try { parsed = JSON.parse(previousVoucher); } catch { throw new PaymentError(400, "invalid voucher JSON"); }
          await acceptVoucher(session, parsed);
        }
        let read = session.reads[readId];
        if (!read) {
          if (session.served >= 4096) throw new PaymentError(402, "session read limit reached; settle and open another session");
          const next = BigInt(session.served + 1) * BigInt(session.price);
          if (next > BigInt(session.deposit) || next - BigInt(session.highest?.amount ?? "0") > BigInt(window) * BigInt(session.price)) throw new PaymentError(402, "unpaid credit window exhausted");
          read = { kind: kind as StoredRead["kind"], requests: {}, methods: {} };
          session.reads[readId] = read;
          session.served++;
        }
        if (read.kind !== kind) throw new PaymentError(409, "read id reused for another kind");
        for (const call of billed) {
          if (!["eth_getProof", "eth_getCode"].includes(call.method)) throw new PaymentError(400, "invalid paid method");
          if (kind === "proof" && call.method !== "eth_getProof") throw new PaymentError(400, "proof read cannot fetch code");
          const fingerprint = keccak256(stringToHex(JSON.stringify([call.method, call.params]).toLowerCase()));
          const count = read.requests[fingerprint] ?? 0;
          if (count >= 2) throw new PaymentError(409, "read request retry limit reached");
          const limit = kind === "proof" ? 1 : kind === "code" ? 2 : 64;
          if (!count && Object.keys(read.requests).length >= limit) throw new PaymentError(402, "logical read request budget exceeded");
          if (kind === "code") {
            if (!count && Object.values(read.methods ?? {}).includes(call.method)) throw new PaymentError(402, "code read permits only one proof and one code request");
            const account = String(call.params[0]).toLowerCase();
            const block = String(call.params[call.method === "eth_getProof" ? 2 : 1]).toLowerCase();
            if (read.account && (read.account !== account || read.block !== block)) throw new PaymentError(409, "code and account proof must share an account and block");
            read.account = account; read.block = block;
          }
          read.requests[fingerprint] = count + 1;
          (read.methods ??= {})[fingerprint] = call.method;
        }
        signal?.throwIfAborted();
        await config.store.save(session);
      });
      } finally { leave(); }
    },
    async voucher(body: unknown, signal?: AbortSignal): Promise<PaymentStatus> {
      const leave = enter();
      try {
      const input = body as { sessionId?: unknown; amount?: unknown; signature?: unknown; close?: unknown; closeAuthorization?: unknown; closeDeadline?: unknown };
      const id = sessionId(input?.sessionId);
      return await locked(id, async () => {
        signal?.throwIfAborted();
        const stored = await config.store.load(id);
        signal?.throwIfAborted();
        if (stored && (["pending", "confirmed", "submitting"].includes(stored.settlement.state) || stored.settlement.transactionHash)) {
          await acceptVoucher(stored, input);
          signal?.throwIfAborted();
          if (stored.highest?.amount !== stored.settlement.amount) throw new PaymentError(409, "settlement already started with an earlier voucher");
          await settle(stored);
          return status(stored);
        }
        const session = await readSession(id);
        signal?.throwIfAborted();
        await acceptVoucher(session, input);
        if (input.close === true) {
          const deadline = typeof input.closeDeadline === "number" ? input.closeDeadline : Number(input.closeDeadline);
          if (!Number.isSafeInteger(deadline) || deadline < now() || deadline > now() + 300 || typeof input.closeAuthorization !== "string" || !signaturePattern.test(input.closeAuthorization)) throw new PaymentError(401, "signed close authorization required");
          const valid = await verifyTypedData({ address: session.sessionKey, ...closeAuthorizationTypedData(domain, { sessionId: BigInt(id), amount: BigInt(session.highest?.amount ?? "0"), deadline }), signature: input.closeAuthorization as Hex });
          if (!valid) throw new PaymentError(401, "invalid close authorization");
        } else if (input.close !== undefined && input.close !== false) throw new PaymentError(400, "invalid close flag");
        signal?.throwIfAborted();
        await config.store.save(session); // durable highest voucher before acknowledging or submitting
        if (input.close === true || now() >= session.refundAfter - margin) await settle(session);
        return status(session);
      });
      } finally { leave(); }
    },
    /** Run at startup and periodically. Failures stay visible and are retried while time remains. */
    async tick(): Promise<PaymentStatus[]> {
      const leave = enter();
      try {
      const sessions = await config.store.list();
      const results: PaymentStatus[] = [];
      for (const session of sessions) {
        if (session.settlement.state !== "open" || now() >= session.refundAfter - margin) {
          results.push(await locked(session.sessionId, async () => {
            const current = await config.store.load(session.sessionId);
            if (!current) return status(session);
            try { await settle(current); }
            catch {
              // A failed node lookup for one session must not starve other approaching deadlines.
              current.settlement.error = "settlement check failed; will retry";
              await config.store.save(current);
            }
            return status(current);
          }));
        }
      }
      return results;
      } finally { leave(); }
    },
    async drain(): Promise<void> {
      accepting = false;
      await Promise.allSettled([...active]);
      await submissions.catch(() => {});
    },
  };
}
