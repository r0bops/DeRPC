import { describe, expect, it, vi } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CappedDelegationSigner, MemoryDelegationStore, delegatedReadTypedData, type DelegatedRead, type DelegationOptions, type DelegationSession, type DelegationStore } from "../src/delegation.ts";
import { voucherTypedData, type SignedVoucher } from "../src/protocol.ts";

const app = privateKeyToAccount(`0x${"11".repeat(32)}`);
const alice = privateKeyToAccount(`0x${"22".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"33".repeat(32)}`);
const session: DelegationSession = { chainId: 31337, escrow: `0x${"44".repeat(20)}`, sessionId: 7n, budget: 100n, refundAfter: 2000, safetyMarginSeconds: 100 };
const readHash = `0x${"ab".repeat(32)}` as Hex;
const request = (overrides: Partial<DelegatedRead> = {}): DelegatedRead => ({ sessionId: session.sessionId, userKey: alice.address, nonce: 0n, charge: 10n, readHash, expiresAt: 1800, ...overrides });
const signature = (read: DelegatedRead, signer = alice) => signer.signTypedData(delegatedReadTypedData(session, read));
const evidence = { readHash, charge: 10n };

function setup(overrides: Partial<DelegationOptions<SignedVoucher>> = {}) {
  const signed = vi.fn(async (amount: bigint): Promise<SignedVoucher> => ({ sessionId: session.sessionId, amount, signature: await app.signTypedData(voucherTypedData(session, session.sessionId, amount)) }));
  const verified = vi.fn(async (value: unknown) => value as { readHash: Hex; charge: bigint });
  const store = new MemoryDelegationStore();
  const options = { session, store, signCumulative: signed, verifyRead: verified, now: () => 1_000_000, ...overrides };
  return { coordinator: new CappedDelegationSigner(options), signed, verified, store, options };
}

describe("app-funded capped delegation", () => {
  it("signs spending only after the sponsor verifies the exact read and cost", async () => {
    const { coordinator, signed, verified } = setup();
    await coordinator.grant(alice.address, 25n, 1800);
    const read = request();
    const voucher = await coordinator.approve(read, await signature(read), evidence);
    expect(verified).toHaveBeenCalledWith(evidence);
    expect(signed).toHaveBeenCalledWith(10n);
    expect(verified.mock.invocationCallOrder[0]).toBeLessThan(signed.mock.invocationCallOrder[0]!);
    expect(await verifyTypedData({ ...voucherTypedData(session, session.sessionId, 10n), address: app.address, signature: voucher.signature })).toBe(true);
    expect((await coordinator.snapshot()).grants[alice.address.toLowerCase()]).toMatchObject({ spent: 10n, nextNonce: 1n });
  });

  it("does not consume allowance or sign when evidence fails or is for another read", async () => {
    const { coordinator, signed } = setup({ verifyRead: async () => { throw new Error("invalid storage proof"); } });
    await coordinator.grant(alice.address, 25n, 1800);
    const read = request();
    await expect(coordinator.approve(read, await signature(read), evidence)).rejects.toThrow("invalid storage proof");
    expect((await coordinator.snapshot()).total).toBe(0n);
    expect(signed).not.toHaveBeenCalled();
    const wrong = setup({ verifyRead: async () => ({ readHash: `0x${"cd".repeat(32)}`, charge: 10n }) });
    await wrong.coordinator.grant(alice.address, 25n, 1800);
    await expect(wrong.coordinator.approve(read, await signature(read), evidence)).rejects.toThrow("does not match");
    expect((await wrong.coordinator.snapshot()).total).toBe(0n);
  });

  it("authenticates delegated keys and binds domain, session, nonce, read and cost", async () => {
    const { coordinator, verified } = setup();
    await coordinator.grant(alice.address, 25n, 1800);
    const read = request();
    await expect(coordinator.approve(read, await signature(read, bob), evidence)).rejects.toThrow("signature");
    const wrongChain = await alice.signTypedData(delegatedReadTypedData({ ...session, chainId: 560048 }, read));
    await expect(coordinator.approve(read, wrongChain, evidence)).rejects.toThrow("signature");
    const wrongContract = await alice.signTypedData(delegatedReadTypedData({ ...session, escrow: bob.address }, read));
    await expect(coordinator.approve(read, wrongContract, evidence)).rejects.toThrow("signature");
    await expect(coordinator.approve({ ...read, charge: 11n }, await signature(read), evidence)).rejects.toThrow("signature");
    await expect(coordinator.approve({ ...read, sessionId: 8n }, await signature(read), evidence)).rejects.toThrow("invalid delegated read");
    expect(verified).not.toHaveBeenCalled();
  });

  it("returns exact retries without double billing and rejects a reused nonce for different data", async () => {
    const { coordinator, signed, verified } = setup();
    await coordinator.grant(alice.address, 25n, 1800);
    const first = request(), sig = await signature(first);
    const voucher = await coordinator.approve(first, sig, evidence);
    expect(await coordinator.approve(first, sig, undefined)).toEqual(voucher);
    const changed = request({ readHash: `0x${"cd".repeat(32)}` });
    await expect(coordinator.approve(changed, await signature(changed), evidence)).rejects.toThrow("nonce was used");
    expect(signed).toHaveBeenCalledTimes(1);
    expect(verified).toHaveBeenCalledTimes(1);
    expect((await coordinator.snapshot()).total).toBe(10n);
  });

  it("enforces per-user and aggregate caps across concurrent signer instances", async () => {
    const shared = setup();
    const second = new CappedDelegationSigner(shared.options);
    await shared.coordinator.grant(alice.address, 100n, 1800);
    await shared.coordinator.grant(bob.address, 100n, 1800);
    const a = request({ charge: 60n }), b = request({ userKey: bob.address, charge: 60n });
    const results = await Promise.allSettled([
      shared.coordinator.approve(a, await signature(a), { readHash, charge: 60n }),
      second.approve(b, await signature(b, bob), { readHash, charge: 60n }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await shared.coordinator.snapshot()).total).toBe(60n);
    expect(shared.signed).toHaveBeenCalledTimes(1);
    const capped = setup();
    await capped.coordinator.grant(alice.address, 9n, 1800);
    const read = request();
    await expect(capped.coordinator.approve(read, await signature(read), evidence)).rejects.toThrow("limit exceeded");
    expect(capped.verified).not.toHaveBeenCalled();
  });

  it("rechecks revocation and expiry after slow proof verification", async () => {
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    const { coordinator, signed } = setup({ verifyRead: async () => { entered(); await wait; return evidence; } });
    await coordinator.grant(alice.address, 25n, 1800);
    const read = request();
    const approval = coordinator.approve(read, await signature(read), evidence);
    await started;
    await coordinator.revoke(alice.address);
    release();
    await expect(approval).rejects.toThrow("revoked");
    expect(signed).not.toHaveBeenCalled();
    expect((await coordinator.snapshot()).total).toBe(0n);
  });

  it("recovers a signed voucher after a failed persistence acknowledgement without charging twice", async () => {
    const memory = new MemoryDelegationStore();
    let failVoucherCommit = true;
    const store: DelegationStore = {
      transact: (key, update) => memory.transact(key, state => {
        const updated = update(state);
        if (updated.state.latestVoucher && failVoucherCommit) {
          failVoucherCommit = false;
          throw new Error("voucher commit failed");
        }
        return updated;
      }),
    };
    const { coordinator, options, signed, verified } = setup({ store });
    await coordinator.grant(alice.address, 20n, 1800);
    const read = request(), sig = await signature(read);
    await expect(coordinator.approve(read, sig, evidence)).rejects.toThrow("voucher commit failed");
    expect((await coordinator.snapshot()).total).toBe(10n);
    const restarted = new CappedDelegationSigner(options);
    expect((await restarted.approve(read, sig, undefined)).amount).toBe(10n);
    expect(signed.mock.calls.map(([amount]) => amount)).toEqual([10n, 10n]);
    expect(verified).toHaveBeenCalledTimes(1);
    expect((await restarted.snapshot()).total).toBe(10n);
  });

  it("keeps durable reservations after signing or acknowledgement failures and resumes safely", async () => {
    const first = setup();
    let fail = true;
    const signed = vi.fn(async (amount: bigint) => {
      if (fail) { fail = false; throw new Error("signing service lost acknowledgement"); }
      return first.options.signCumulative(amount);
    });
    const coordinator = new CappedDelegationSigner({ ...first.options, signCumulative: signed });
    await coordinator.grant(alice.address, 10n, 1800);
    const read = request(), sig = await signature(read);
    await expect(coordinator.approve(read, sig, evidence)).rejects.toThrow("lost acknowledgement");
    expect((await coordinator.snapshot()).total).toBe(10n);
    const restarted = new CappedDelegationSigner({ ...first.options, signCumulative: signed });
    expect((await restarted.approve(read, sig, undefined)).amount).toBe(10n);
    expect(first.verified).toHaveBeenCalledTimes(1);
    expect((await restarted.snapshot()).total).toBe(10n);
    const next = request({ nonce: 1n });
    await expect(restarted.approve(next, await signature(next), evidence)).rejects.toThrow("limit exceeded");
  });

  it("fails closed when reservation persistence fails before signing", async () => {
    const memory = new MemoryDelegationStore();
    let failReservation = false;
    const store: DelegationStore = {
      transact: (key, update) => memory.transact(key, state => {
        const updated = update(state);
        if (failReservation && updated.state.total > 0n) throw new Error("durability failure");
        return updated;
      }),
    };
    const { coordinator, signed } = setup({ store });
    await coordinator.grant(alice.address, 25n, 1800);
    failReservation = true;
    const read = request();
    await expect(coordinator.approve(read, await signature(read), evidence)).rejects.toThrow("durability failure");
    expect(signed).not.toHaveBeenCalled();
    expect((await coordinator.snapshot()).total).toBe(0n);
  });

  it("retains nonce and used cap on regrant; honors expiry, settlement margin and ledger bounds", async () => {
    let now = 1000;
    const { coordinator } = setup({ now: () => now * 1000, maxRequests: 1 });
    await coordinator.grant(alice.address, 25n, 1800);
    const read = request();
    await coordinator.approve(read, await signature(read), evidence);
    await coordinator.revoke(alice.address);
    await coordinator.grant(alice.address, 30n, 1800);
    expect((await coordinator.snapshot()).grants[alice.address.toLowerCase()]).toMatchObject({ spent: 10n, nextNonce: 1n });
    const next = request({ nonce: 1n });
    await expect(coordinator.approve(next, await signature(next), evidence)).rejects.toThrow("request limit reached");
    now = 1900;
    await expect(coordinator.grant(bob.address, 10n, 1950)).rejects.toThrow();
    await expect(coordinator.approve(next, await signature(next), evidence)).rejects.toThrow("safety margin");
  });
});
