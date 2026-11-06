import { describe, expect, it, vi } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PaymentClient, type PaymentSessionOptions } from "../src/client.ts";
import { closeAuthorizationTypedData, readAuthorizationTypedData, voucherTypedData } from "../src/protocol.ts";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const escrow = `0x${"22".repeat(20)}` as Address;
const payer = `0x${"33".repeat(20)}` as Address;
const payee = `0x${"44".repeat(20)}` as Address;
const domain = { chainId: 31337, escrow };
const NOW = 1000000;
function options(extra: Partial<PaymentSessionOptions> = {}): PaymentSessionOptions {
  return { ...domain, operatorId: "alice", sessionId: 1n, payer, payee, signer, price: 10n, deposit: 100n, refundAfter: NOW / 1000 + 3600, ...extra };
}
function client(extra: Partial<PaymentSessionOptions> = {}) {
  const sign = vi.fn(signer.signTypedData);
  const payments = new PaymentClient({ now: () => NOW });
  payments.addSession(options({ ...extra, signer: { address: signer.address, signTypedData: sign as typeof signer.signTypedData } }));
  return { payments, sign };
}

describe("verified-read payments", () => {
  it("signs only non-spending authorization before a read and no voucher for an invalid proof", async () => {
    const { payments, sign } = client();
    const read = await payments.begin("alice", "proof");
    expect(sign.mock.calls.map(([data]) => data.primaryType)).toEqual(["ReadAuthorization"]);
    expect(read.headers()["x-derpc-voucher"]).toBeUndefined();
    read.failed();
    expect(payments.latestVoucher("alice")).toBeUndefined();
    expect(payments.snapshot()[0]).toMatchObject({ total: 0n, verifiedReads: 0, inFlight: 0 });
    await expect(read.verified()).rejects.toThrow("already completed");
  });

  it("binds authorization to session, chain, escrow, read kind, ID, price and deadline", async () => {
    const { payments } = client();
    const read = await payments.begin("alice", "code");
    const headers = read.headers();
    const authorization = {
      sessionId: 1n, readId: read.readId, kind: "code" as const,
      price: 10n, deadline: Number(headers["x-derpc-read-deadline"]),
    };
    const signedBy = await recoverTypedDataAddress({ ...readAuthorizationTypedData(domain, authorization), signature: headers["x-derpc-read-authorization"] as Hex });
    expect(signedBy).toBe(signer.address);
    expect(hashTypedData(readAuthorizationTypedData(domain, authorization))).not.toBe(hashTypedData(voucherTypedData(domain, 1n, 10n)));
    const changed = await recoverTypedDataAddress({ ...readAuthorizationTypedData({ ...domain, chainId: 1 }, authorization), signature: headers["x-derpc-read-authorization"] as Hex });
    expect(changed).not.toBe(signer.address);
    read.failed();
  });

  it("issues one cumulative voucher for a completed code read and carries it on the next request", async () => {
    const { payments, sign } = client();
    const read = await payments.begin("alice", "code");
    expect(read.headers()["x-derpc-read-id"]).toBe(read.headers()["x-derpc-read-id"]);
    const voucher = await read.verified();
    expect(voucher.amount).toBe(10n);
    expect(await recoverTypedDataAddress({ ...voucherTypedData(domain, 1n, 10n), signature: voucher.signature })).toBe(signer.address);
    expect(sign.mock.calls.map(([data]) => data.primaryType)).toEqual(["ReadAuthorization", "Voucher"]);
    const next = await payments.begin("alice", "proof");
    expect(JSON.parse(next.headers()["x-derpc-voucher"]!)).toEqual({ amount: "10", signature: voucher.signature });
    next.failed();
  });

  it("bounds parallel credit and serializes concurrent verified totals without overpaying", async () => {
    const { payments } = client({ creditWindow: 2, deposit: 25n });
    const a = await payments.begin("alice", "proof");
    const b = await payments.begin("alice", "proof");
    await expect(payments.begin("alice", "proof")).rejects.toThrow("credit window");
    const vouchers = await Promise.all([a.verified(), b.verified()]);
    expect(vouchers.map(v => v.amount)).toEqual([10n, 20n]);
    expect(payments.snapshot()[0]).toMatchObject({ total: 20n, inFlight: 0, verifiedReads: 2, remaining: 5n });
    await expect(payments.begin("alice", "proof")).rejects.toThrow("spending limit");
  });

  it("keeps separate sessions through failure and failover", async () => {
    const { payments, sign } = client();
    payments.addSession(options({ operatorId: "bob", sessionId: 2n }));
    const bad = await payments.begin("alice", "proof"); bad.failed();
    const good = await payments.begin("bob", "proof"); await good.verified();
    expect(payments.latestVoucher("alice")).toBeUndefined();
    expect(payments.latestVoucher("bob")?.amount).toBe(10n);
    expect(sign.mock.calls.every(([data]) => data.primaryType !== "Voucher")).toBe(true);
  });

  it("does not sign spend after cancellation or near refund timeout", async () => {
    let now = NOW;
    const payments = new PaymentClient({ now: () => now });
    payments.addSession(options());
    const abort = new AbortController();
    const read = await payments.begin("alice", "proof", { signal: abort.signal });
    abort.abort();
    await expect(read.verified()).rejects.toThrow();
    expect(payments.snapshot()[0]?.inFlight).toBe(0);
    expect(payments.latestVoucher("alice")).toBeUndefined();
    now += (3600 - 600) * 1000;
    await expect(payments.begin("alice", "proof")).rejects.toThrow("refund timeout");
  });

  it("freezes price, and top-ups cannot silently raise an agent's spending limit", async () => {
    const { payments } = client({ spendLimit: 10n });
    await (await payments.begin("alice", "proof")).verified();
    payments.updateDeposit("alice", 200n);
    await expect(payments.begin("alice", "proof")).rejects.toThrow("spending limit");
    payments.setSpendLimit("alice", 20n);
    await (await payments.begin("alice", "proof")).verified();
    expect(payments.snapshot()[0]).toMatchObject({ total: 20n, price: 10n, deposit: 200n });
    expect(() => payments.setSpendLimit("alice", 201n)).toThrow();
    expect(() => payments.setSpendLimit("alice", 10n)).toThrow();
  });

  it("requires explicit close intent, closes unused sessions with zero, and stops further reads", async () => {
    const { payments } = client();
    const close = await payments.prepareClose("alice");
    expect(close.voucher.amount).toBe(0n);
    expect(payments.snapshot()[0]).toMatchObject({ total: 0n, verifiedReads: 0, status: "closing" });
    expect(await recoverTypedDataAddress({ ...closeAuthorizationTypedData(domain, { sessionId: 1n, amount: 0n, deadline: close.closeDeadline }), signature: close.closeAuthorization })).toBe(signer.address);
    await expect(payments.begin("alice", "proof")).rejects.toThrow("closed for reads");
    payments.removeSession("alice");
    expect(payments.has("alice")).toBe(false);
    expect(() => payments.addSession(options())).toThrow("cannot reset");
  });

  it("hard-gates real payment chains and does not leak signing keys in snapshots", () => {
    expect(() => client({ chainId: 1 })).toThrow("real-fund payments are disabled");
    const { payments } = client();
    expect(payments.snapshot()[0]).not.toHaveProperty("signer");
    expect(payments.snapshot()[0]).not.toHaveProperty("privateKey");
  });
});
