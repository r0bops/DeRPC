import { hashTypedData, isAddress, verifyTypedData, zeroAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { assertTestPaymentChain, readAuthorizationTypedData, voucherTypedData, type PaymentDomain, type SignedVoucher } from "./protocol.ts";
import { sponsoredIntentTypedData, type SponsoredAuthorization, type SponsoredReadIntent } from "./sponsored.ts";

export interface SponsoredSession extends PaymentDomain {
  sessionId: bigint;
  price: bigint;
  refundAfter: number;
  safetyMarginSeconds?: number;
}
export interface SignedSponsoredIntent { readonly intent: Readonly<SponsoredReadIntent>; readonly signature: Hex }
export type SponsoredIntentInput = Pick<SponsoredReadIntent, "nonce" | "kind" | "requestHash" | "expiresAt">;
export interface SponsoredTransport {
  authorize(intent: SponsoredReadIntent, signature: Hex, options?: { signal?: AbortSignal }): Promise<SponsoredAuthorization>;
  complete(intent: SponsoredReadIntent, signature: Hex, evidence: unknown, options?: { signal?: AbortSignal }): Promise<SignedVoucher>;
}
export interface SponsoredAttempt {
  readonly readId: Hex;
  readonly deadline: number;
  readonly recovery: SignedSponsoredIntent;
  /** The same authenticated read ID is used for every proof/code subrequest. */
  headers(): Readonly<Record<string, string>>;
  /** Call only after the browser host has verified the full response and its freshness. */
  complete(evidence: unknown, options?: { signal?: AbortSignal }): Promise<SignedVoucher>;
}

/** An unknown response never requires a new nonce or signature: retry this exact authorization. */
export class SponsoredRequestError extends Error {
  override name = "SponsoredRequestError";
  readonly recovery: SignedSponsoredIntent;
  constructor(message: string, recovery: SignedSponsoredIntent, cause: unknown) {
    super(message, { cause });
    this.recovery = recovery;
  }
}

const MAX_UINT256 = (1n << 256n) - 1n;
const uint256 = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= MAX_UINT256;
const bytes32 = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const signature65 = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
const validAddress = (value: Address) => isAddress(value) && value.toLowerCase() !== zeroAddress;

/** Delegated browser/agent request key only. Keep the escrow session key in the trusted coordinator. */
export class SponsoredPaymentClient {
  private readonly session: Readonly<SponsoredSession>;
  private readonly signer: Pick<PrivateKeyAccount, "address" | "signTypedData">;
  private readonly sessionKey: Address;
  private readonly transport: SponsoredTransport;
  private readonly now: () => number;
  private readonly stopAt: number;

  constructor(options: {
    session: SponsoredSession;
    userSigner: Pick<PrivateKeyAccount, "address" | "signTypedData">;
    /** Address from the checked funding receipt/on-chain session, not from the coordinator reply. */
    sessionKey: Address;
    transport: SponsoredTransport;
    now?: () => number;
  }) {
    const session = { ...options.session, safetyMarginSeconds: options.session.safetyMarginSeconds ?? 600 };
    assertTestPaymentChain(session.chainId);
    if (!validAddress(session.escrow) || !validAddress(options.sessionKey) || !validAddress(options.userSigner.address) || !uint256(session.sessionId) || session.sessionId === 0n || !uint256(session.price) || session.price === 0n || !Number.isSafeInteger(session.refundAfter) || !Number.isSafeInteger(session.safetyMarginSeconds) || session.safetyMarginSeconds < 60) throw new Error("invalid sponsored session");
    if (options.userSigner.address.toLowerCase() === options.sessionKey.toLowerCase()) throw new Error("escrow session key cannot be used as a delegated request key");
    this.session = Object.freeze(session);
    this.signer = Object.freeze({ address: options.userSigner.address, signTypedData: options.userSigner.signTypedData });
    this.sessionKey = options.sessionKey;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.stopAt = session.refundAfter - session.safetyMarginSeconds;
  }

  /** Persist this non-secret signed intent before sending if recovery across page reloads is needed. */
  async prepare(input: SponsoredIntentInput, options: { signal?: AbortSignal } = {}): Promise<SignedSponsoredIntent> {
    options.signal?.throwIfAborted();
    const intent = Object.freeze({ ...input, sessionId: this.session.sessionId, userKey: this.signer.address, charge: this.session.price });
    this.validateIntent(intent);
    const signature = await this.signer.signTypedData(sponsoredIntentTypedData(this.session, intent));
    options.signal?.throwIfAborted();
    this.validateIntent(intent);
    if (!signature65(signature)) throw new Error("invalid delegated intent signature");
    return Object.freeze({ intent, signature });
  }

  async begin(input: SponsoredIntentInput, options: { signal?: AbortSignal } = {}): Promise<SponsoredAttempt> {
    return this.retryBegin(await this.prepare(input, options), options);
  }

  async retryBegin(prepared: SignedSponsoredIntent, options: { signal?: AbortSignal } = {}): Promise<SponsoredAttempt> {
    options.signal?.throwIfAborted();
    const recovery = await this.checkRecovery(prepared);
    const { intent, signature } = recovery;
    options.signal?.throwIfAborted();
    try {
      const returned = await this.transport.authorize(intent, signature, options);
      if (!returned) throw new Error("missing sponsored authorization");
      const authorization = Object.freeze({ readId: returned.readId, deadline: returned.deadline, headers: Object.freeze({ ...returned.headers }) });
      options.signal?.throwIfAborted();
      const headers = await this.checkAuthorization(intent, authorization);
      options.signal?.throwIfAborted();
      let voucher: Readonly<SignedVoucher> | undefined;
      let pending: Promise<SignedVoucher> | undefined;
      const assertActive = () => {
        options.signal?.throwIfAborted();
        this.validateIntent(intent);
        if (this.seconds() >= authorization.deadline) throw new Error("sponsored read authorization expired");
      };
      return Object.freeze({
        readId: authorization.readId,
        deadline: authorization.deadline,
        recovery,
        headers: () => { assertActive(); return headers; },
        complete: async (evidence: unknown, control: { signal?: AbortSignal } = {}) => {
          // Complete may be retried after a lost response. The sponsor deduplicates the retained
          // intent; a newly allocated nonce would risk billing the same logical read twice.
          control.signal?.throwIfAborted();
          options.signal?.throwIfAborted();
          if (voucher) return { ...voucher };
          if (pending) return pending;
          this.validateIntent(intent);
          const signal = combineSignals(options.signal, control.signal);
          const work = (async () => {
            const result = await this.retryComplete(recovery, evidence, { signal });
            voucher = Object.freeze({ ...result });
            return { ...result };
          })();
          pending = work;
          try { return await work; } finally { if (pending === work) pending = undefined; }
        },
      });
    } catch (error) {
      throw new SponsoredRequestError("sponsored authorization failed; retry the same signed intent", recovery, error);
    }
  }

  /** Recover a lost completion reply even after the short read-authorization window has elapsed. */
  async retryComplete(prepared: SignedSponsoredIntent, evidence: unknown, options: { signal?: AbortSignal } = {}): Promise<SignedVoucher> {
    options.signal?.throwIfAborted();
    // The coordinator may safely return an already committed voucher after expiry. It alone
    // distinguishes that recovery from a request for new spend; this path never signs a new intent.
    const recovery = await this.checkRecovery(prepared, false);
    options.signal?.throwIfAborted();
    try {
      const returned = await this.transport.complete(recovery.intent, recovery.signature, evidence, options);
      const result = returned && { sessionId: returned.sessionId, amount: returned.amount, signature: returned.signature };
      await this.checkVoucher(result, recovery.intent.charge);
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      throw new SponsoredRequestError("sponsored completion failed; retry the same signed intent", recovery, error);
    }
  }

  private async checkRecovery(prepared: SignedSponsoredIntent, requireLive = true): Promise<SignedSponsoredIntent> {
    const recovery = Object.freeze({ intent: Object.freeze({ ...prepared.intent }), signature: prepared.signature });
    this.validateIntent(recovery.intent, requireLive);
    if (!signature65(recovery.signature) || !await verifyTypedData({ ...sponsoredIntentTypedData(this.session, recovery.intent), address: this.signer.address, signature: recovery.signature })) throw new Error("invalid retained sponsored intent signature");
    return recovery;
  }

  private async checkAuthorization(intent: SponsoredReadIntent, response: SponsoredAuthorization): Promise<Readonly<Record<string, string>>> {
    this.validateIntent(intent);
    const readId = hashTypedData(sponsoredIntentTypedData(this.session, intent));
    if (!response || response.readId !== readId || !Number.isSafeInteger(response.deadline) || response.deadline <= this.seconds() || response.deadline > intent.expiresAt || response.deadline > this.stopAt || !response.headers || typeof response.headers !== "object" || Array.isArray(response.headers)) throw new Error("coordinator authorization does not match the sponsored intent");
    const required = {
      "x-derpc-session": intent.sessionId.toString(), "x-derpc-read-id": readId,
      "x-derpc-read-kind": intent.kind, "x-derpc-price": intent.charge.toString(),
      "x-derpc-read-deadline": response.deadline.toString(),
    };
    const allowed = new Set([...Object.keys(required), "x-derpc-read-authorization", "x-derpc-voucher"]);
    for (const [name, value] of Object.entries(response.headers)) {
      if (!allowed.has(name) || typeof value !== "string") throw new Error("unexpected coordinator authorization header");
    }
    for (const [name, value] of Object.entries(required)) {
      if (response.headers[name] !== value) throw new Error("coordinator authorization headers do not match the sponsored intent");
    }
    const signature = response.headers["x-derpc-read-authorization"];
    if (!signature65(signature) || !await verifyTypedData({
      ...readAuthorizationTypedData(this.session, { sessionId: intent.sessionId, readId, kind: intent.kind, price: intent.charge, deadline: response.deadline }),
      address: this.sessionKey, signature,
    })) throw new Error("invalid coordinator session-key authorization signature");
    const headers = { ...response.headers };
    if (headers["x-derpc-voucher"] !== undefined) {
      const previous = JSON.parse(headers["x-derpc-voucher"]) as { amount?: unknown; signature?: unknown };
      const voucher = parseVoucher({ sessionId: intent.sessionId.toString(), amount: previous.amount, signature: previous.signature });
      await this.checkVoucher(voucher, 0n);
      headers["x-derpc-voucher"] = JSON.stringify({ amount: voucher.amount.toString(), signature: voucher.signature });
    }
    return Object.freeze(headers);
  }

  private async checkVoucher(voucher: SignedVoucher, minimum: bigint): Promise<void> {
    if (!voucher || voucher.sessionId !== this.session.sessionId || !uint256(voucher.amount) || voucher.amount < minimum || !signature65(voucher.signature) || !await verifyTypedData({ ...voucherTypedData(this.session, voucher.sessionId, voucher.amount), address: this.sessionKey, signature: voucher.signature })) throw new Error("invalid coordinator cumulative voucher");
  }
  private validateIntent(intent: SponsoredReadIntent, requireLive = true): void {
    if (requireLive) this.assertOpen();
    if (intent.sessionId !== this.session.sessionId || typeof intent.userKey !== "string" || intent.userKey.toLowerCase() !== this.signer.address.toLowerCase() || intent.charge !== this.session.price || !uint256(intent.nonce) || !["proof", "code", "call"].includes(intent.kind) || !bytes32(intent.requestHash) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= 0 || (requireLive && intent.expiresAt <= this.seconds()) || intent.expiresAt > this.stopAt) throw new Error("invalid sponsored intent");
  }
  private seconds(): number { return Math.floor(this.now() / 1000); }
  private assertOpen(): void { if (this.seconds() >= this.stopAt) throw new Error("sponsored session is inside its settlement safety margin"); }
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  return first && second ? AbortSignal.any([first, second]) : first ?? second;
}

/** No global fetch fallback. Supply the app's tested anonymous coordinator transport explicitly. */
export function createSponsoredHttpTransport(options: {
  url: string;
  fetch: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): SponsoredTransport {
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || typeof options.fetch !== "function") throw new Error("invalid sponsored coordinator transport");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (![timeoutMs, maxResponseBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("invalid sponsored transport limits");
  const base = url.toString().replace(/\/$/, "");
  const request = async (route: string, value: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    signal?.throwIfAborted();
    const deadline = new AbortController();
    const combined = combineSignals(signal, deadline.signal)!;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancel!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => { void reader?.cancel().catch(() => {}); reject(combined.reason ?? new Error("sponsored request aborted")); };
      combined.addEventListener("abort", cancel, { once: true });
    });
    const timer = setTimeout(() => deadline.abort(new Error("sponsored coordinator deadline exceeded")), timeoutMs);
    const operation = (async () => {
      const response = await options.fetch(`${base}${route}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item),
        signal: combined, redirect: "error", credentials: "omit", cache: "no-store",
      });
      if (combined.aborted) void response.body?.cancel().catch(() => {});
      combined.throwIfAborted();
      if (!response.body) throw new Error("empty sponsored coordinator response");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const { done, value } = await reader.read();
          combined.throwIfAborted();
          if (done) break;
          length += value.length;
          if (length > maxResponseBytes) throw new Error("sponsored coordinator response exceeds size limit");
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      if (!response.ok) throw new Error(`sponsored coordinator returned HTTP ${response.status}`);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid sponsored coordinator response");
      return parsed as Record<string, unknown>;
    })();
    try { return await Promise.race([operation, aborted]); }
    finally { clearTimeout(timer); combined.removeEventListener("abort", cancel); }
  };
  return {
    authorize: async (intent, signature, control) => {
      const body = await request("/authorize", { intent, signature }, control?.signal);
      return body.authorization as SponsoredAuthorization;
    },
    complete: async (intent, signature, evidence, control) => {
      const body = await request("/complete", { intent, signature, evidence }, control?.signal);
      return parseVoucher(body.voucher);
    },
  };
}

function parseVoucher(value: unknown): SignedVoucher {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid coordinator voucher response");
  const input = value as Record<string, unknown>;
  const integer = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) > MAX_UINT256) throw new Error("invalid coordinator voucher amount");
    return BigInt(value);
  };
  if (!signature65(input.signature)) throw new Error("invalid coordinator voucher signature");
  return { sessionId: integer(input.sessionId), amount: integer(input.amount), signature: input.signature };
}
