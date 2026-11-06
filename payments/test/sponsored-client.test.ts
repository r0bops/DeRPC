import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { hashTypedData, verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { VerifiedHeader } from "../../provider/src/light-client/header-source.ts";
import type { AccountProof } from "../../provider/src/verify/index.ts";
import type { JsonRpcSend } from "../../provider/src/verify/reader.ts";
import { createReadEvidenceVerifier, sponsoredRequestHash } from "../examples/read-evidence.ts";
import { createSponsoredReader, SponsoredReaderError } from "../examples/sponsored-reader.ts";
import { readAuthorizationTypedData, voucherTypedData, type SignedVoucher } from "../src/protocol.ts";
import { sponsoredIntentTypedData, type SponsoredAuthorization, type SponsoredReadIntent } from "../src/sponsored.ts";
import { createSponsoredHttpTransport, SponsoredPaymentClient, SponsoredRequestError, type SponsoredIntentInput, type SponsoredSession, type SponsoredTransport } from "../src/sponsored-client.ts";

const fixture = JSON.parse(await readFile(new URL("../../provider/test/fixtures/mainnet-proofs.json", import.meta.url), "utf8")) as {
  capturedAt: number;
  block: { number: number; hash: Hex; stateRoot: Hex };
  inputs: { HOLDER: Address; WETH: Address; holderSlot: Hex };
  responses: { holderAccount: AccountProof; wethWithSlots: AccountProof; wethCode: Hex };
  reference: { holderWethBalanceOf: Hex };
};
// The fixture root and clock are explicit test anchors, not claims of live consensus or anonymity.
const now = Math.floor(fixture.capturedAt / 1000);
const app = privateKeyToAccount(`0x${"71".repeat(32)}`);
const browser = privateKeyToAccount(`0x${"72".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"73".repeat(32)}`);
const session: SponsoredSession = { chainId: 31337, escrow: `0x${"74".repeat(20)}`, sessionId: 31n, price: 10n, refundAfter: now + 7200 };
const header: VerifiedHeader = { network: "mainnet", slot: 0, blockNumber: fixture.block.number, blockHash: fixture.block.hash, stateRoot: fixture.block.stateRoot, timestamp: now };
const input: SponsoredIntentInput = { nonce: 0n, kind: "proof", requestHash: sponsoredRequestHash({ method: "eth_getBalance", address: fixture.inputs.HOLDER }, fixture.block.hash), expiresAt: now + 3600 };
const controls = (nonce = 0n) => ({ nonce, expiresAt: input.expiresAt });

async function authorized(intent: SponsoredReadIntent, signer = app): Promise<SponsoredAuthorization> {
  const readId = hashTypedData(sponsoredIntentTypedData(session, intent));
  const deadline = now + 60;
  const signature = await signer.signTypedData(readAuthorizationTypedData(session, { sessionId: intent.sessionId, readId, kind: intent.kind, price: intent.charge, deadline }));
  return { readId, deadline, headers: {
    "x-derpc-session": intent.sessionId.toString(), "x-derpc-read-id": readId,
    "x-derpc-read-kind": intent.kind, "x-derpc-price": intent.charge.toString(),
    "x-derpc-read-deadline": deadline.toString(), "x-derpc-read-authorization": signature,
  } };
}
async function voucher(amount = 10n, signer = app): Promise<SignedVoucher> {
  return { sessionId: session.sessionId, amount, signature: await signer.signTypedData(voucherTypedData(session, session.sessionId, amount)) };
}
function setup(overrides: Partial<SponsoredTransport> = {}, clock = () => fixture.capturedAt) {
  const sign = vi.fn(browser.signTypedData);
  const authorize = vi.fn(async (intent: SponsoredReadIntent, signature: Hex) => {
    expect(await verifyTypedData({ ...sponsoredIntentTypedData(session, intent), address: browser.address, signature })).toBe(true);
    return authorized(intent);
  });
  const complete = vi.fn(async () => voucher());
  const transport: SponsoredTransport = { authorize, complete, ...overrides };
  const client = new SponsoredPaymentClient({ session, sessionKey: app.address, userSigner: { address: browser.address, signTypedData: sign as typeof browser.signTypedData }, transport, now: clock });
  return { client, sign, authorize, complete, transport };
}
function readerSetup(overrides: { send?: JsonRpcSend; transport?: Partial<SponsoredTransport>; assertFresh?: (block: VerifiedHeader) => void } = {}) {
  const headers = { finalized: () => header, assertFresh: overrides.assertFresh ?? vi.fn() };
  const verifier = createReadEvidenceVerifier({ headers, price: session.price });
  let total = 0n;
  const complete = vi.fn(async (intent: SponsoredReadIntent, _signature: Hex, evidence: unknown, options?: { signal?: AbortSignal }) => {
    const checked = await verifier(evidence, { ...options, intent });
    expect(checked.requestHash).toBe(intent.requestHash);
    total += checked.charge;
    return voucher(total);
  });
  const sdk = setup({ complete, ...overrides.transport });
  const send = vi.fn(overrides.send ?? (async (method: string, params: unknown[]) => {
    if (method === "eth_getCode") return fixture.responses.wethCode;
    expect(method).toBe("eth_getProof");
    return structuredClone(params[0] === fixture.inputs.WETH ? fixture.responses.wethWithSlots : fixture.responses.holderAccount);
  }));
  return { ...sdk, complete, send, reader: createSponsoredReader({ client: sdk.client, headers, send }), headers };
}

describe("sponsored browser payment client", () => {
  it("prepares an immutable delegated intent without contacting the coordinator", async () => {
    const sdk = setup();
    const prepared = await sdk.client.prepare(input);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.intent)).toBe(true);
    expect(sdk.authorize).not.toHaveBeenCalled();
    expect(sdk.complete).not.toHaveBeenCalled();
    expect(await verifyTypedData({ ...sponsoredIntentTypedData(session, prepared.intent), address: browser.address, signature: prepared.signature })).toBe(true);
    const attempt = await sdk.client.retryBegin(prepared);
    expect(attempt.readId).toBe(hashTypedData(sponsoredIntentTypedData(session, prepared.intent)));
    expect(Object.isFrozen(attempt.headers())).toBe(true);
    expect(sdk.sign).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["session", (reply: SponsoredAuthorization) => { reply.headers["x-derpc-session"] = "99"; }],
    ["kind", (reply: SponsoredAuthorization) => { reply.headers["x-derpc-read-kind"] = "call"; }],
    ["price", (reply: SponsoredAuthorization) => { reply.headers["x-derpc-price"] = "1"; }],
    ["deadline", (reply: SponsoredAuthorization) => { reply.deadline = input.expiresAt + 1; reply.headers["x-derpc-read-deadline"] = reply.deadline.toString(); }],
    ["extra header", (reply: SponsoredAuthorization) => { reply.headers.authorization = "unexpected coordinator credential"; }],
  ] as const)("rejects substituted %s authorization fields", async (_label, mutate) => {
    const sdk = setup({ authorize: async intent => { const reply = await authorized(intent); mutate(reply); return reply; } });
    await expect(sdk.client.begin(input)).rejects.toBeInstanceOf(SponsoredRequestError);
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("rejects a valid session signature authorizing a different request and the wrong session signer", async () => {
    const replay = setup({ authorize: intent => authorized({ ...intent, nonce: intent.nonce + 1n }) });
    await expect(replay.client.begin(input)).rejects.toMatchObject({ cause: { message: expect.stringContaining("does not match") } });
    const wrong = setup({ authorize: intent => authorized(intent, stranger) });
    await expect(wrong.client.begin(input)).rejects.toMatchObject({ cause: { message: expect.stringContaining("session-key") } });
  });

  it("checks prior vouchers and completion vouchers against the confirmed session key", async () => {
    const poisoned = setup({ authorize: async intent => {
      const auth = await authorized(intent);
      const bad = await voucher(10n, stranger);
      auth.headers["x-derpc-voucher"] = JSON.stringify({ amount: "10", signature: bad.signature });
      return auth;
    } });
    await expect(poisoned.client.begin(input)).rejects.toMatchObject({ cause: { message: expect.stringContaining("voucher") } });
    const badCompletion = setup({ complete: async () => voucher(10n, stranger) });
    const attempt = await badCompletion.client.begin(input);
    await expect(attempt.complete({})).rejects.toMatchObject({ cause: { message: expect.stringContaining("voucher") } });
  });

  it("retains the exact intent after lost replies and can recover a completed read after authorization expiry", async () => {
    let time = fixture.capturedAt;
    let lostAuthorization = true;
    let lostCompletion = true;
    const attempts: Array<{ intent: SponsoredReadIntent; signature: Hex }> = [];
    const sdk = setup({
      authorize: async (intent, signature) => {
        attempts.push({ intent, signature });
        if (lostAuthorization) { lostAuthorization = false; throw new Error("reply lost"); }
        return authorized(intent);
      },
      complete: async () => {
        if (lostCompletion) { lostCompletion = false; throw new Error("voucher acknowledgement lost"); }
        return voucher();
      },
    }, () => time);
    let failure: SponsoredRequestError | undefined;
    try { await sdk.client.begin(input); } catch (error) { failure = error as SponsoredRequestError; }
    expect(failure).toBeInstanceOf(SponsoredRequestError);
    const attempt = await sdk.client.retryBegin(failure!.recovery);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(sdk.sign).toHaveBeenCalledTimes(1);
    await expect(attempt.complete({})).rejects.toBeInstanceOf(SponsoredRequestError);
    time += 61_000;
    expect(() => attempt.headers()).toThrow("expired");
    expect((await sdk.client.retryComplete(attempt.recovery, {})).amount).toBe(10n);
    expect(sdk.sign).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before authorization and before completion", async () => {
    const sdk = setup();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(sdk.client.begin(input, { signal: abort.signal })).rejects.toThrow("cancelled");
    expect(sdk.sign).not.toHaveBeenCalled();
    expect(sdk.authorize).not.toHaveBeenCalled();
    const attempt = await sdk.client.begin(input);
    await expect(attempt.complete({}, { signal: abort.signal })).rejects.toThrow("cancelled");
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("recovers an old committed voucher after intent and session expiry without signing another intent", async () => {
    const original = setup();
    const prepared = await original.client.prepare(input);
    const restarted = setup({}, () => (session.refundAfter + 1) * 1000);
    expect((await restarted.client.retryComplete(prepared, undefined)).amount).toBe(10n);
    expect(restarted.sign).not.toHaveBeenCalled();
    expect(restarted.authorize).not.toHaveBeenCalled();
    await expect(restarted.client.begin(input)).rejects.toThrow("settlement safety margin");
    await expect(restarted.client.retryBegin(prepared)).rejects.toThrow("settlement safety margin");
    expect(restarted.sign).not.toHaveBeenCalled();
  });
});

describe("sponsored proof-verifying reader", () => {
  it("waits for coordinator authorization before sending proof requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const enteredAuthorization = new Promise<void>(resolve => { entered = resolve; });
    const sdk = readerSetup({ transport: { authorize: async intent => { entered(); await gate; return authorized(intent); } } });
    const reading = sdk.reader.getBalance(fixture.inputs.HOLDER, controls());
    await enteredAuthorization;
    expect(sdk.send).not.toHaveBeenCalled();
    expect(sdk.complete).not.toHaveBeenCalled();
    release();
    expect((await reading).value).toBe(BigInt(fixture.responses.holderAccount.balance));
    expect(sdk.complete).toHaveBeenCalledTimes(1);
  });

  it("verifies balance, nonce, storage and code; proof and code share one authorization", async () => {
    const sdk = readerSetup();
    expect((await sdk.reader.getBalance(fixture.inputs.HOLDER, controls(0n))).value).toBe(BigInt(fixture.responses.holderAccount.balance));
    expect((await sdk.reader.getTransactionCount(fixture.inputs.HOLDER, controls(1n))).value).toBe(BigInt(fixture.responses.holderAccount.nonce));
    expect((await sdk.reader.getStorageAt(fixture.inputs.WETH, fixture.inputs.holderSlot, controls(2n))).value).toBe(BigInt(fixture.reference.holderWethBalanceOf));
    const code = await sdk.reader.getCode(fixture.inputs.WETH, controls(3n));
    expect(code.value).toBe(fixture.responses.wethCode);
    expect(code.voucher.amount).toBe(40n);
    expect(sdk.complete).toHaveBeenCalledTimes(4);
    expect(sdk.send).toHaveBeenCalledTimes(5);
    const proofHeaders = sdk.send.mock.calls[3]![2].headers;
    const codeHeaders = sdk.send.mock.calls[4]![2].headers;
    expect(proofHeaders).toBe(codeHeaders);
    expect(codeHeaders?.["x-derpc-read-kind"]).toBe("code");
    expect(codeHeaders?.["x-derpc-read-id"]).toBe(code.readId);
  });

  it("never completes invalid proof, invalid code, stale result or cancelled network reads", async () => {
    const corrupt = structuredClone(fixture.responses.holderAccount);
    corrupt.balance = "0x1";
    const invalid = readerSetup({ send: async () => corrupt });
    await expect(invalid.reader.getBalance(fixture.inputs.HOLDER, controls())).rejects.toThrow("proven");
    expect(invalid.complete).not.toHaveBeenCalled();
    const wrongCode = readerSetup({ send: async method => method === "eth_getCode" ? "0x00" : structuredClone(fixture.responses.wethWithSlots) });
    await expect(wrongCode.reader.getCode(fixture.inputs.WETH, controls())).rejects.toThrow("code does not match");
    expect(wrongCode.complete).not.toHaveBeenCalled();
    const abort = new AbortController();
    const cancelled = readerSetup({ send: async () => { abort.abort(new Error("cancelled read")); return structuredClone(fixture.responses.holderAccount); } });
    await expect(cancelled.reader.getBalance(fixture.inputs.HOLDER, { ...controls(), signal: abort.signal })).rejects.toThrow("cancelled read");
    expect(cancelled.complete).not.toHaveBeenCalled();
    let stale = false;
    const aged = readerSetup({ assertFresh: () => { if (stale) throw new Error("stale finalized header"); }, send: async () => { stale = true; return structuredClone(fixture.responses.holderAccount); } });
    await expect(aged.reader.getBalance(fixture.inputs.HOLDER, controls())).rejects.toThrow("stale finalized");
    expect(aged.complete).not.toHaveBeenCalled();
  });

  it("retains verified evidence and its signed intent if the completion reply is lost", async () => {
    const sdk = readerSetup({ transport: { complete: async () => { throw new Error("lost response"); } } });
    let failure: SponsoredReaderError | undefined;
    try { await sdk.reader.getBalance(fixture.inputs.HOLDER, controls()); } catch (error) { failure = error as SponsoredReaderError; }
    expect(failure).toBeInstanceOf(SponsoredReaderError);
    expect(failure!.evidence?.proof).toEqual(fixture.responses.holderAccount);
    expect(failure!.recovery.intent.requestHash).toBe(input.requestHash);
    expect(failure!.evidence?.value).toBe(BigInt(fixture.responses.holderAccount.balance).toString());
  });
});

describe("explicit sponsored coordinator HTTP transport", () => {
  it("uses only the injected fetch, serializes bigint fields and parses vouchers", async () => {
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      const body = JSON.parse(init!.body as string) as { intent: Record<string, unknown> };
      expect(body.intent.sessionId).toBe(session.sessionId.toString());
      const result = await voucher();
      return Response.json({ voucher: { ...result, amount: result.amount.toString(), sessionId: result.sessionId.toString() } });
    });
    const transport = createSponsoredHttpTransport({ url: "http://sponsor.test", fetch: fetcher as typeof fetch });
    const sdk = setup();
    const prepared = await sdk.client.prepare(input);
    expect((await transport.complete(prepared.intent, prepared.signature, { test: true })).amount).toBe(10n);
    expect(sent[0]!.url).toBe("http://sponsor.test/complete");
    expect(sent[0]!.init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(() => createSponsoredHttpTransport({ url: "http://sponsor.test", fetch: undefined as unknown as typeof fetch })).toThrow("transport");
  });

  it("bounds response bytes and cancels a stalled response body at the deadline", async () => {
    const prepared = await setup().client.prepare(input);
    const cancelled = vi.fn();
    const large = createSponsoredHttpTransport({ url: "http://sponsor.test", maxResponseBytes: 16, fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17)); }, cancel: cancelled }))) as typeof fetch });
    await expect(large.authorize(prepared.intent, prepared.signature)).rejects.toThrow("size limit");
    expect(cancelled).toHaveBeenCalledTimes(1);
    const timedOut = vi.fn();
    const stalled = createSponsoredHttpTransport({ url: "http://sponsor.test", timeoutMs: 20, fetch: (async () => new Response(new ReadableStream({ cancel: timedOut }))) as typeof fetch });
    await expect(stalled.authorize(prepared.intent, prepared.signature)).rejects.toThrow("deadline");
    expect(timedOut).toHaveBeenCalledTimes(1);
  });
});
