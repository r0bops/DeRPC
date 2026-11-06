import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { toHex, type Hex } from "viem";
import { closeAuthorizationTypedData, readAuthorizationTypedData, voucherTypedData } from "@derpc/payments";
import { createPaymentController, isUnpaidBootstrap, type ChainSession, type PaymentChain } from "../src/payment.ts";
import { MemoryPaymentStore, openFilePaymentStore } from "../src/payment-store.ts";
import { createProxy } from "../src/proxy.ts";

const key = privateKeyToAccount(`0x${"23".repeat(32)}`);
const payer = `0x${"11".repeat(20)}` as Hex;
const operator = `0x${"22".repeat(20)}` as Hex;
const escrow = `0x${"33".repeat(20)}` as Hex;
const domain = { chainId: 31337, escrow };
const proof = { method: "eth_getProof", params: [payer, [], "0x12"] };
const code = { method: "eth_getCode", params: [payer, "0x12"] };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function setup(options: { window?: number; store?: MemoryPaymentStore } = {}) {
  let now = 1_800_000_000;
  const state: ChainSession = { payer, operator, sessionKey: key.address, deposit: 1000n, refundAfter: now + 3600, closed: false };
  const store = options.store ?? new MemoryPaymentStore();
  const chain: PaymentChain = {
    session: vi.fn(async () => ({ ...state })),
    prepareClose: vi.fn(async () => ({ transactionHash: `0x${"55".repeat(32)}` as Hex, serializedTransaction: "0x1234" as Hex })),
    broadcast: vi.fn(async () => {}),
    receipt: vi.fn(async () => "pending" as const),
  };
  const config = { ...domain, operator, price: 10n, creditWindow: options.window ?? 2, now: () => now, store, chain };
  const controller = createPaymentController(config);
  async function headers(read = 1, kind: "proof" | "code" | "call" = "proof", changes: Partial<{ price: bigint; deadline: number; chainId: number }> = {}) {
    const authorization = { sessionId: 1n, readId: toHex(read, { size: 32 }), kind, price: changes.price ?? 10n, deadline: changes.deadline ?? now + 60 };
    const signature = await key.signTypedData(readAuthorizationTypedData({ ...domain, chainId: changes.chainId ?? domain.chainId }, authorization));
    return new Headers({
      "x-derpc-session": "1", "x-derpc-read-id": authorization.readId, "x-derpc-read-kind": kind,
      "x-derpc-price": authorization.price.toString(), "x-derpc-read-deadline": String(authorization.deadline), "x-derpc-read-authorization": signature,
    });
  }
  async function voucher(amount: bigint, close = false) {
    const payload = { sessionId: "1", amount: amount.toString(), signature: await key.signTypedData(voucherTypedData(domain, 1n, amount)) };
    return close ? { ...payload, close, closeDeadline: now + 60, closeAuthorization: await key.signTypedData(closeAuthorizationTypedData(domain, { sessionId: 1n, amount, deadline: now + 60 })) } : payload;
  }
  return { controller, chain, config, store, headers, voucher, state, now: () => now, setNow: (value: number) => { now = value; } };
}

describe("wrapper payment accounting", () => {
  it("reserves concurrent credit atomically and accepts only signed cumulative progress", async () => {
    const s = setup();
    const headers = await Promise.all([s.headers(1), s.headers(2), s.headers(3)]);
    const results = await Promise.allSettled(headers.map(h => s.controller.admit(h, [proof])));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect((await s.store.load("1"))?.served).toBe(2);
    expect((await s.store.load("1"))?.highest).toBeUndefined();
    const prior = await s.voucher(10n);
    const next = await s.headers(4);
    next.set("x-derpc-voucher", JSON.stringify({ amount: prior.amount, signature: prior.signature }));
    await s.controller.admit(next, [proof]);
    expect((await s.store.load("1"))?.highest?.amount).toBe("10");
    await expect(s.controller.admit(await s.headers(5), [proof])).rejects.toThrow("credit window");
  });

  it("rejects unauthenticated, cross-domain, wrong-price and unfunded reads", async () => {
    const s = setup();
    await expect(s.controller.admit(new Headers(), [proof])).rejects.toThrow();
    await expect(s.controller.admit(await s.headers(1, "proof", { chainId: 1 }), [proof])).rejects.toThrow("signature");
    await expect(s.controller.admit(await s.headers(1, "proof", { price: 11n }), [proof])).rejects.toThrow("price");
    s.state.deposit = 0n;
    await expect(s.controller.admit(await s.headers(), [proof])).rejects.toThrow("unfunded");
    expect(await s.store.load("1")).toBeUndefined();
  });

  it("persists the original price across operator price changes and restart", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    const restarted = createPaymentController({ ...s.config, price: 500n });
    await restarted.admit(await s.headers(2), [proof]);
    expect((await s.store.load("1"))?.price).toBe("10");
    await expect(restarted.admit(await s.headers(3, "proof", { price: 500n }), [proof])).rejects.toThrow("price");
  });

  it("bounds request replay and treats a proof plus code as one logical read", async () => {
    const s = setup();
    const headers = await s.headers(1, "code");
    await s.controller.admit(headers, [proof]);
    await s.controller.admit(headers, [code]);
    expect((await s.store.load("1"))?.served).toBe(1);
    await s.controller.admit(headers, [code]);
    await expect(s.controller.admit(headers, [code])).rejects.toThrow("retry limit");
    await expect(s.controller.admit(headers, [{ ...proof, params: [payer, ["0x1"], "0x12"] }])).rejects.toThrow();
    await expect(s.controller.admit(await s.headers(1, "proof"), [proof])).rejects.toThrow("another kind");
  });

  it("does not let a single code read retrieve unrelated accounts or blocks", async () => {
    const s = setup();
    const headers = await s.headers(1, "code");
    await s.controller.admit(headers, [proof]);
    await expect(s.controller.admit(headers, [{ method: "eth_getCode", params: [operator, "0x12"] }])).rejects.toThrow("account and block");
  });

  it("never accepts an invalid, excessive or decreasing claim as increased payment", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    const ten = await s.voucher(10n);
    await expect(s.controller.voucher({ ...ten, amount: "11" })).rejects.toThrow("exceeds");
    await expect(s.controller.voucher({ ...ten, signature: await key.signTypedData(voucherTypedData({ ...domain, chainId: 1 }, 1n, 10n)) })).rejects.toThrow("signature");
    await s.controller.voucher(ten);
    await s.controller.voucher(await s.voucher(0n));
    expect((await s.store.load("1"))?.highest?.amount).toBe("10");
  });

  it("requires separate close authorization and journals exact signed transaction before broadcast", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    const signed = await s.voucher(10n);
    await expect(s.controller.voucher({ ...signed, close: true })).rejects.toThrow("close authorization");
    expect(s.chain.prepareClose).not.toHaveBeenCalled();
    vi.mocked(s.chain.broadcast).mockImplementation(async raw => {
      const durable = await s.store.load("1");
      expect(durable?.highest?.amount).toBe("10");
      expect(durable?.settlement.serializedTransaction).toBe(raw);
      expect(durable?.settlement.state).toBe("submitting");
    });
    const pending = await s.controller.voucher(await s.voucher(10n, true));
    expect(pending.settlement.state).toBe("pending");
    vi.mocked(s.chain.receipt).mockResolvedValue("success");
    const result = await s.controller.voucher(signed);
    expect(result.settlement).toMatchObject({ state: "confirmed", paid: "10", refunded: "990" });
    expect(s.chain.prepareClose).toHaveBeenCalledTimes(1);
  });

  it("can close a zero-read session with a signed zero voucher", async () => {
    const s = setup();
    const response = await s.controller.voucher(await s.voucher(0n, true));
    expect(response.highestAmount).toBe("0");
    expect(response.settlement.state).toBe("pending");
    expect(s.chain.prepareClose).toHaveBeenCalledWith(1n, 0n, expect.any(String));
  });

  it("stops serving before the timeout and settles automatically with a safety margin", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    await s.controller.voucher(await s.voucher(10n));
    s.setNow(s.state.refundAfter - 599);
    await expect(s.controller.admit(await s.headers(2), [proof])).rejects.toThrow("settlement");
    await s.controller.tick();
    expect(s.chain.prepareClose).toHaveBeenCalledTimes(1);
    expect((await s.store.load("1"))?.settlement.state).toBe("pending");
  });

  it("recovers a lost broadcast acknowledgment by replaying the identical journaled transaction", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    vi.mocked(s.chain.broadcast).mockRejectedValueOnce(new Error("network lost after send"));
    await s.controller.voucher(await s.voucher(10n, true));
    const restarted = createPaymentController(s.config);
    await restarted.tick();
    expect(s.chain.prepareClose).toHaveBeenCalledTimes(1);
    expect(s.chain.broadcast).toHaveBeenCalledTimes(2);
    expect(vi.mocked(s.chain.broadcast).mock.calls[0]).toEqual(vi.mocked(s.chain.broadcast).mock.calls[1]);
    vi.mocked(s.chain.receipt).mockResolvedValue("success");
    await restarted.tick();
    expect((await s.store.load("1"))?.settlement.state).toBe("confirmed");
  });

  it("never acknowledges a voucher or sends a settlement when durable storage fails", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    vi.spyOn(s.store, "save").mockRejectedValue(new Error("disk full"));
    await expect(s.controller.voucher(await s.voucher(10n, true))).rejects.toThrow("disk full");
    expect(s.chain.broadcast).not.toHaveBeenCalled();
  });

  it("retries an expired transaction across restart until its nonce is consumed, retaining the evidence", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    vi.mocked(s.chain.broadcast).mockRejectedValueOnce(new Error("node rejected before accepting the transaction"));
    await s.controller.voucher(await s.voucher(10n, true));
    const original = (await s.store.load("1"))!.settlement;
    await s.controller.drain();
    s.setNow(s.state.refundAfter);
    const restarted = createPaymentController(s.config);
    await restarted.tick();
    expect((await s.store.load("1"))!.settlement).toMatchObject({
      state: "expired", transactionHash: original.transactionHash,
      serializedTransaction: original.serializedTransaction, amount: "10",
    });
    expect(s.chain.broadcast).toHaveBeenCalledTimes(2);
    expect(s.chain.broadcast).toHaveBeenLastCalledWith(original.serializedTransaction);
    expect(s.chain.prepareClose).toHaveBeenCalledTimes(1);

    vi.mocked(s.chain.receipt).mockResolvedValue("reverted");
    s.setNow(s.state.refundAfter - 1); // a local clock correction must not discard expired evidence
    await restarted.tick();
    const consumed = (await s.store.load("1"))!.settlement;
    expect(consumed).toMatchObject({
      state: "expired", transactionHash: original.transactionHash,
      serializedTransaction: original.serializedTransaction, amount: "10",
    });
    expect(consumed.error).toContain("nonce consumed");
    await restarted.drain();
    await createPaymentController(s.config).tick();
    expect(s.chain.broadcast).toHaveBeenCalledTimes(2);
    expect(s.chain.prepareClose).toHaveBeenCalledTimes(1);
  });

  it("still reconciles a confirmed transaction when its receipt arrives after the refund deadline", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    await s.controller.voucher(await s.voucher(10n, true));
    s.setNow(s.state.refundAfter);
    await s.controller.tick();
    expect((await s.store.load("1"))?.settlement.state).toBe("expired");
    const broadcasts = vi.mocked(s.chain.broadcast).mock.calls.length;
    vi.mocked(s.chain.receipt).mockResolvedValue("success");
    s.state.closed = true;
    expect((await s.controller.voucher(await s.voucher(10n))).settlement.state).toBe("confirmed");
    expect(s.chain.broadcast).toHaveBeenCalledTimes(broadcasts);
  });

  it("continues other session settlements when one node lookup fails", async () => {
    const s = setup();
    await s.controller.admit(await s.headers(), [proof]);
    await s.controller.voucher(await s.voucher(10n, true));
    const second = (await s.store.load("1"))!;
    second.sessionId = "2";
    await s.store.save(second);
    vi.mocked(s.chain.receipt).mockRejectedValueOnce(new Error("node lookup failed")).mockResolvedValue("success");
    await s.controller.tick();
    expect((await s.store.load("1"))?.settlement.error).toContain("retry");
    expect((await s.store.load("2"))?.settlement.state).toBe("confirmed");
  });

  it("cancels queued work before querying the chain and drains writes before shutdown", async () => {
    const s = setup();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(s.chain.session).mockImplementationOnce(async () => { await wait; return { ...s.state }; });
    const [firstHeaders, secondHeaders] = await Promise.all([s.headers(1), s.headers(2)]);
    const first = s.controller.admit(firstHeaders, [proof]);
    const abort = new AbortController();
    const second = s.controller.admit(secondHeaders, [proof], abort.signal);
    const canceled = expect(second).rejects.toThrow("cancel queued");
    abort.abort(new Error("cancel queued"));
    let drained = false;
    const drain = s.controller.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(s.controller.admit(await s.headers(3), [proof])).rejects.toThrow("shutting down");
    release();
    await first;
    await canceled;
    await drain;
    expect(s.chain.session).toHaveBeenCalledTimes(1);
    expect((await s.store.load("1"))?.served).toBe(1);
  });

  it("bounds queued session work under a stalled settlement-chain node", async () => {
    const s = setup({ window: 32 });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(s.chain.session).mockImplementation(async () => { await wait; return { ...s.state }; });
    const headers = await Promise.all(Array.from({ length: 20 }, (_, i) => s.headers(i + 1)));
    const requests = headers.map(header => s.controller.admit(header, [proof]).then(() => "ok", error => error.message as string));
    await new Promise(resolve => setTimeout(resolve, 1));
    release();
    const results = await Promise.all(requests);
    expect(results.filter(result => result.includes("queue limit"))).toHaveLength(4);
    expect(s.chain.session).toHaveBeenCalledTimes(16);
  });

  it("allows only narrowly public bootstrap requests without a session", async () => {
    const s = setup();
    const bootstrap = { method: "eth_getProof", params: ["0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e", ["0x1"], "0x12"] };
    expect(isUnpaidBootstrap(bootstrap)).toBe(true);
    expect(isUnpaidBootstrap({ ...bootstrap, params: [bootstrap.params[0], ["0x2"], "0x12"] })).toBe(false);
    await s.controller.admit(new Headers(), [bootstrap]);
    expect(s.chain.session).not.toHaveBeenCalled();
    await expect(s.controller.admit(new Headers(), [proof])).rejects.toThrow();
  });

  it("rejects unpaid execution before any upstream work while leaving beacon serving free", async () => {
    const s = setup();
    const upstream = vi.fn(async () => Response.json({ data: {} }));
    const proxy = createProxy({ executionUrl: "http://127.0.0.1:8545", beaconUrl: "http://127.0.0.1:5052", identity: { ens: "a.derpc.eth", signer: operator, version: "1", chains: [1], service: "demo-proxy" }, payments: s.controller, fetch: upstream });
    const rejected = await proxy(new Request("http://wrapper/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...proof, jsonrpc: "2.0", id: 1 }) }));
    expect(rejected.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    expect((await proxy(new Request("http://wrapper/eth/v1/beacon/light_client/finality_update"))).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe("durable payment journal", () => {
  it("keeps reservations/vouchers across restart, applies private file modes and prevents competing writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "derpc-payment-test-")); directories.push(directory);
    const disk = await openFilePaymentStore(directory);
    const s = setup();
    const controller = createPaymentController({ ...s.config, store: disk });
    await controller.admit(await s.headers(), [proof]);
    await controller.voucher(await s.voucher(10n));
    await expect(openFilePaymentStore(directory)).rejects.toThrow("writer");
    expect((await stat(join(directory, "1.json"))).mode & 0o777).toBe(0o600);
    await disk.close();
    const restarted = await openFilePaymentStore(directory);
    expect((await restarted.load("1"))?.highest?.amount).toBe("10");
    expect((await restarted.list())[0]?.served).toBe(1);
    await restarted.close();
  });

  it("recovers a stale container PID lock once and refuses an incomplete recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "derpc-payment-test-")); directories.push(directory);
    await writeFile(join(directory, "writer.lock"), JSON.stringify({ pid: process.pid, started: "stale-previous-container", token: "old" }));
    const attempts = await Promise.allSettled([openFilePaymentStore(directory), openFilePaymentStore(directory)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    for (const result of attempts) if (result.status === "fulfilled") await result.value.close();
    await writeFile(join(directory, "writer.lock"), JSON.stringify({ pid: process.pid, started: "stale", token: "old" }));
    await writeFile(join(directory, "recovery.lock"), "incomplete");
    await expect(openFilePaymentStore(directory)).rejects.toThrow("incomplete");
    expect(await readFile(join(directory, "writer.lock"), "utf8")).toContain("old");
  });
});
