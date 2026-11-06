import { describe, expect, it, vi } from "vitest";
import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PaymentClient, type PaymentSessionOptions } from "../src/client.ts";
import { CappedDelegationSigner, MemoryDelegationStore, delegatedReadTypedData, type DelegatedRead, type DelegationOptions, type DelegationStore } from "../src/delegation.ts";
import { voucherTypedData, type SignedVoucher } from "../src/protocol.ts";

const signer = privateKeyToAccount(`0x${"71".repeat(32)}`);
const alice = privateKeyToAccount(`0x${"72".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"73".repeat(32)}`);
const escrow = `0x${"74".repeat(20)}` as Address;
const now = 1_000_000;
const session = { chainId: 31337, escrow, sessionId: 11n, budget: 20n, refundAfter: 5000, safetyMarginSeconds: 300 };
const evidence = { readHash: `0x${"aa".repeat(32)}` as Hex, charge: 10n };
const options = (extra: Partial<PaymentSessionOptions> = {}): PaymentSessionOptions => ({
  operatorId: "alice.derpc.eth", chainId: 31337, escrow, sessionId: 11n,
  payer: alice.address, payee: bob.address, signer, deposit: 100n, price: 10n,
  refundAfter: 5000, creditWindow: 2, ...extra,
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const request = (userKey = alice.address, nonce = 0n): DelegatedRead => ({ sessionId: session.sessionId, userKey, nonce, charge: 10n, readHash: evidence.readHash, expiresAt: 4000 });
const signedVoucher = async (amount: bigint): Promise<SignedVoucher> => ({ sessionId: session.sessionId, amount, signature: await signer.signTypedData(voucherTypedData(session, session.sessionId, amount)) });

describe("payment signing races", () => {
  it("reserves credit before slow read authorization and releases it after cancellation", async () => {
    const entered = deferred(), release = deferred();
    const sign = vi.fn(signer.signTypedData);
    sign.mockImplementation(async typed => { entered.resolve(); await release.promise; return signer.signTypedData(typed); });
    const payments = new PaymentClient({ now: () => now });
    payments.addSession(options({ creditWindow: 1, signer: { address: signer.address, signTypedData: sign as typeof signer.signTypedData } }));
    const controller = new AbortController();
    const attempt = payments.begin("alice.derpc.eth", "proof", { signal: controller.signal });
    await entered.promise;
    expect(payments.snapshot()[0]?.inFlight).toBe(1);
    await expect(payments.begin("alice.derpc.eth", "proof")).rejects.toThrow("credit window");
    controller.abort();
    release.resolve();
    await expect(attempt).rejects.toThrow();
    expect(payments.snapshot()[0]).toMatchObject({ total: 0n, inFlight: 0, remaining: 100n });
    expect(sign.mock.calls.map(([typed]) => typed.primaryType)).toEqual(["ReadAuthorization"]);
    const next = await payments.begin("alice.derpc.eth", "proof");
    next.failed();
  });

  it("retains a created voucher despite late cancellation but cancels the next queued signature", async () => {
    const signing = deferred(), release = deferred();
    const sign = vi.fn(signer.signTypedData);
    sign.mockImplementation(async typed => {
      if (typed.primaryType === "Voucher") { signing.resolve(); await release.promise; }
      return signer.signTypedData(typed);
    });
    const payments = new PaymentClient({ now: () => now });
    payments.addSession(options({ signer: { address: signer.address, signTypedData: sign as typeof signer.signTypedData } }));
    const firstAbort = new AbortController(), secondAbort = new AbortController();
    const first = await payments.begin("alice.derpc.eth", "proof", { signal: firstAbort.signal });
    const second = await payments.begin("alice.derpc.eth", "proof", { signal: secondAbort.signal });
    const firstVerified = first.verified();
    await signing.promise;
    const secondVerified = second.verified();
    const secondRejected = expect(secondVerified).rejects.toThrow();
    firstAbort.abort(); secondAbort.abort();
    expect(() => payments.setSpendLimit("alice.derpc.eth", 10n)).toThrow("invalid spending limit");
    expect(() => payments.removeSession("alice.derpc.eth")).toThrow("pending reads");
    release.resolve();
    const voucher = await firstVerified;
    await secondRejected;
    expect(voucher.amount).toBe(10n);
    expect(await verifyTypedData({ ...voucherTypedData(session, session.sessionId, 10n), address: signer.address, signature: voucher.signature })).toBe(true);
    expect(sign.mock.calls.filter(([typed]) => typed.primaryType === "Voucher")).toHaveLength(1);
    expect(payments.snapshot()[0]).toMatchObject({ total: 10n, inFlight: 0, verifiedReads: 1, remaining: 90n });
  });

  it("does not lose signed accounting if a notification callback throws", async () => {
    const observer = vi.fn(() => { throw new Error("UI was disposed"); });
    const payments = new PaymentClient({ now: () => now, onChange: observer });
    payments.addSession(options());
    const voucher = await (await payments.begin("alice.derpc.eth", "proof")).verified();
    expect(observer.mock.calls.length).toBeGreaterThan(2);
    expect(payments.latestVoucher("alice.derpc.eth")).toEqual(voucher);
    expect(payments.snapshot()[0]).toMatchObject({ total: 10n, inFlight: 0, verifiedReads: 1 });
  });

  it("cannot reset a previously signed session by relabeling it or detaching it", async () => {
    const payments = new PaymentClient({ now: () => now });
    payments.addSession(options());
    await (await payments.begin("alice.derpc.eth", "proof")).verified();
    expect(() => payments.addSession(options({ operatorId: "alias.derpc.eth" }))).toThrow("signed total");
    payments.removeSession("alice.derpc.eth");
    expect(() => payments.addSession(options())).toThrow("signed total");
    payments.addSession(options({ sessionId: 12n }));
    expect(payments.snapshot()[0]).toMatchObject({ sessionId: 12n, total: 0n });
  });
});

describe("delegated signing races", () => {
  it("never regresses the acknowledged voucher when an older signer response arrives last", async () => {
    const firstSigning = deferred(), releaseFirst = deferred();
    const sign = vi.fn(async (amount: bigint) => {
      if (amount === 10n) { firstSigning.resolve(); await releaseFirst.promise; }
      return signedVoucher(amount);
    });
    const shared: DelegationOptions = { session, store: new MemoryDelegationStore(), verifyRead: async () => evidence, signCumulative: sign, now: () => now };
    const first = new CappedDelegationSigner(shared), second = new CappedDelegationSigner(shared);
    await first.grant(alice.address, 10n, 4000);
    await second.grant(bob.address, 10n, 4000);
    const a = request(), b = request(bob.address);
    const firstApproval = first.approve(a, await alice.signTypedData(delegatedReadTypedData(session, a)), evidence);
    await firstSigning.promise;
    const later = await second.approve(b, await bob.signTypedData(delegatedReadTypedData(session, b)), evidence);
    expect(later.amount).toBe(20n);
    releaseFirst.resolve();
    expect(await firstApproval).toEqual(later);
    expect((await first.snapshot()).latestVoucher?.amount).toBe(20n);
    expect((await first.snapshot()).total).toBe(20n);
    expect(sign.mock.calls.map(([amount]) => amount)).toEqual([10n, 20n]);
    const c = request(alice.address, 1n);
    await expect(first.approve(c, await alice.signTypedData(delegatedReadTypedData(session, c)), evidence)).rejects.toThrow("limit exceeded");
  });

  it("keeps the reserved cap after a post-signature persistence failure and resumes without new spending", async () => {
    const memory = new MemoryDelegationStore();
    let failVoucherSave = true;
    const store: DelegationStore = {
      transact: (key, update) => memory.transact(key, state => {
        const result = update(state);
        if (result.state.latestVoucher && failVoucherSave) {
          failVoucherSave = false;
          throw new Error("voucher persistence interrupted");
        }
        return result;
      }),
    };
    const sign = vi.fn(signedVoucher), verify = vi.fn(async () => evidence);
    const config = { session, store, signCumulative: sign, verifyRead: verify, now: () => now };
    const coordinator = new CappedDelegationSigner(config);
    await coordinator.grant(alice.address, 10n, 4000);
    const a = request(), signature = await alice.signTypedData(delegatedReadTypedData(session, a));
    await expect(coordinator.approve(a, signature, evidence)).rejects.toThrow("persistence interrupted");
    expect((await coordinator.snapshot()).total).toBe(10n);
    expect((await coordinator.snapshot()).latestVoucher).toBeUndefined();
    const restarted = new CappedDelegationSigner(config);
    const recovered = await restarted.approve(a, signature, undefined);
    expect(recovered.amount).toBe(10n);
    expect(sign.mock.calls.map(([amount]) => amount)).toEqual([10n, 10n]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await restarted.snapshot()).grants[alice.address.toLowerCase()]).toMatchObject({ spent: 10n, nextNonce: 1n });
    const next = request(alice.address, 1n);
    await expect(restarted.approve(next, await alice.signTypedData(delegatedReadTypedData(session, next)), evidence)).rejects.toThrow("limit exceeded");
  });
});
