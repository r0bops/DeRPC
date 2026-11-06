import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CappedDelegationSigner, MemoryDelegationStore, type DelegationStore } from "../src/delegation.ts";
import { FileDelegationStore } from "../src/node-store.ts";
import { readAuthorizationTypedData, voucherTypedData } from "../src/protocol.ts";
import { SponsoredPaymentCoordinator, sponsoredIntentTypedData, type SponsoredCoordinatorOptions, type SponsoredReadIntent } from "../src/sponsored.ts";

const sponsor = privateKeyToAccount(`0x${"71".repeat(32)}`);
const alice = privateKeyToAccount(`0x${"72".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"73".repeat(32)}`);
const session = { chainId: 31337, escrow: `0x${"74".repeat(20)}` as Hex, sessionId: 12n, budget: 100n, refundAfter: 5000 };
const hash = `0x${"75".repeat(32)}` as Hex;
const evidence = { requestHash: hash, readHash: hash, charge: 10n };
const paths: string[] = [];
const stores: FileDelegationStore[] = [];
function setup(store: DelegationStore = new MemoryDelegationStore(), overrides: Partial<SponsoredCoordinatorOptions> = {}) {
  const signed = vi.fn(sponsor.signTypedData);
  const verified = vi.fn<SponsoredCoordinatorOptions["verifyRead"]>(async () => evidence);
  const options: SponsoredCoordinatorOptions = { session, store, price: 10n, signer: { address: sponsor.address, signTypedData: signed as typeof sponsor.signTypedData }, now: () => 1_000_000, verifyRead: verified, ...overrides };
  return { service: new SponsoredPaymentCoordinator(options), signed, verified, options };
}
function intent(overrides: Partial<SponsoredReadIntent> = {}): SponsoredReadIntent {
  return { sessionId: session.sessionId, userKey: alice.address, nonce: 0n, kind: "proof", requestHash: hash, charge: 10n, expiresAt: 2000, ...overrides };
}
const sign = (request: SponsoredReadIntent, account = alice) => account.signTypedData(sponsoredIntentTypedData(session, request));
async function disk(path?: string) {
  const directory = path ?? await mkdtemp(join(tmpdir(), "derpc-sponsored-"));
  if (!path) paths.push(directory);
  const store = await FileDelegationStore.open(directory);
  stores.push(store);
  return { directory, store };
}
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("pre-read sponsored exposure", () => {
  it("durably reserves allowance before authorizing the exact signed intent, then pays only verified work", async () => {
    const { service, signed, verified } = setup();
    await service.grant(alice.address, 20n, 2000);
    const request = intent(), signature = await sign(request);
    const auth = await service.authorize(request, signature);
    expect(auth.readId).toBe(hashTypedData(sponsoredIntentTypedData(session, request)));
    expect(auth.deadline).toBe(1060);
    expect(await verifyTypedData({ ...readAuthorizationTypedData(session, { sessionId: session.sessionId, readId: auth.readId, kind: "proof", price: 10n, deadline: auth.deadline }), address: sponsor.address, signature: auth.headers["x-derpc-read-authorization"] as Hex })).toBe(true);
    let state = await service.snapshot();
    expect(state.grants[alice.address.toLowerCase()]).toMatchObject({ spent: 10n, nextNonce: 1n });
    expect(state.total).toBe(0n);
    expect(state.latestVoucher).toBeUndefined();
    expect(verified).not.toHaveBeenCalled();
    expect(signed.mock.calls[0]?.[0].primaryType).toBe("ReadAuthorization");
    const voucher = await service.complete(request, signature, evidence);
    expect(voucher.amount).toBe(10n);
    expect(await verifyTypedData({ ...voucherTypedData(session, session.sessionId, 10n), address: sponsor.address, signature: voucher.signature })).toBe(true);
    state = await service.snapshot();
    expect(state.total).toBe(10n);
    expect(state.grants[alice.address.toLowerCase()]?.spent).toBe(10n);
    expect(verified.mock.calls[0]?.[1]).toMatchObject({ intent: request, authorization: { readId: auth.readId, requestHash: hash } });
  });

  it("does not include abandoned or invalid reads in a later valid cumulative voucher", async () => {
    const { service, options } = setup();
    await service.grant(alice.address, 30n, 2000);
    const abandoned = intent(), completed = intent({ nonce: 1n });
    await service.authorize(abandoned, await sign(abandoned));
    await service.authorize(completed, await sign(completed));
    const invalid = new SponsoredPaymentCoordinator({ ...options, verifyRead: async () => { throw new Error("bad proof"); } });
    await expect(invalid.complete(abandoned, await sign(abandoned), {})).rejects.toThrow("bad proof");
    const voucher = await service.complete(completed, await sign(completed), evidence);
    expect(voucher.amount).toBe(10n);
    const state = await service.snapshot();
    expect(state.total).toBe(10n);
    expect(state.grants[alice.address.toLowerCase()]?.spent).toBe(20n);
    expect(Object.keys(state.readAuthorizations!)).toHaveLength(2);
    expect(Object.keys(state.reservations)).toHaveLength(1);
  });

  it("serializes parallel cap checks and never signs after a failed durable allocation", async () => {
    const { service, signed } = setup(undefined, { session: { ...session, budget: 10n } });
    await service.grant(alice.address, 10n, 2000);
    await service.grant(bob.address, 10n, 2000);
    const a = intent(), b = intent({ userKey: bob.address });
    const results = await Promise.allSettled([service.authorize(a, await sign(a)), service.authorize(b, await sign(b, bob))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(signed).toHaveBeenCalledTimes(1);
    const failing = setup({ transact: async () => { throw new Error("disk failed"); } });
    await expect(failing.service.authorize(a, await sign(a))).rejects.toThrow("disk failed");
    expect(failing.signed).not.toHaveBeenCalled();
  });

  it("keeps issued exposure after revocation, expiry and cancellation; only existing work may finish", async () => {
    let clock = 1_000_000;
    const { service, signed } = setup(undefined, { now: () => clock });
    await service.grant(alice.address, 20n, 2000);
    const request = intent(), signature = await sign(request);
    await service.authorize(request, signature);
    await service.revoke(alice.address);
    const next = intent({ nonce: 1n });
    await expect(service.authorize(next, await sign(next))).rejects.toThrow("revoked");
    expect((await service.complete(request, signature, evidence)).amount).toBe(10n);
    const signatures = signed.mock.calls.length;
    clock = 2_100_000;
    expect((await service.complete(request, signature, undefined)).amount).toBe(10n);
    expect(signed.mock.calls.length).toBe(signatures);
    expect((await service.snapshot()).grants[alice.address.toLowerCase()]?.spent).toBe(10n);
  });

  it("bounds unfinished exposure and never extends an exact retry's deadline", async () => {
    let clock = 1_000_000;
    const { service } = setup(undefined, { maxPending: 1, now: () => clock });
    await service.grant(alice.address, 100n, 2000);
    const request = intent(), signature = await sign(request);
    const auth = await service.authorize(request, signature);
    clock += 10_000;
    expect((await service.authorize(request, signature)).deadline).toBe(auth.deadline);
    const next = intent({ nonce: 1n });
    await expect(service.authorize(next, await sign(next))).rejects.toThrow("pending");
    clock += 60_000;
    await expect(service.complete(request, signature, evidence)).rejects.toThrow("deadline");
    await expect(service.authorize(request, signature)).rejects.toThrow("expired");
    // Expiration frees only the concurrency slot. Its allocated allowance remains consumed.
    await service.authorize(next, await sign(next));
    expect((await service.snapshot()).grants[alice.address.toLowerCase()]?.spent).toBe(20n);
  });

  it("atomically completes one intent once under concurrent retries and rejects a changed intent", async () => {
    const { service } = setup();
    await service.grant(alice.address, 30n, 2000);
    const request = intent(), signature = await sign(request);
    await service.authorize(request, signature);
    const changed = { ...request, requestHash: `0x${"ff".repeat(32)}` as Hex };
    await expect(service.authorize(changed, await sign(changed))).rejects.toThrow("another intent");
    const vouchers = await Promise.all([service.complete(request, signature, evidence), service.complete(request, signature, evidence)]);
    expect(vouchers.map(v => v.amount)).toEqual([10n, 10n]);
    expect((await service.snapshot()).total).toBe(10n);
  });

  it("terminal close blocks new work and excludes unverified exposure, including zero-read sessions", async () => {
    const { service } = setup();
    await service.grant(alice.address, 20n, 2000);
    const request = intent(), signature = await sign(request);
    await service.authorize(request, signature);
    const closed = await service.prepareClose();
    expect(closed.voucher.amount).toBe(0n);
    const next = intent({ nonce: 1n });
    await expect(service.authorize(next, await sign(next))).rejects.toThrow("closing");
    await expect(service.complete(request, signature, evidence)).rejects.toThrow("closing");
    expect((await service.snapshot()).total).toBe(0n);
  });

  it.skipIf(process.platform !== "linux")("restores exact authorizations and paid totals after restart, refusing legacy mode on the same funded session", async () => {
    const { directory, store } = await disk();
    const first = setup(store);
    await first.service.grant(alice.address, 20n, 2000);
    const request = intent(), signature = await sign(request);
    const auth = await first.service.authorize(request, signature);
    await store.close();
    const second = setup((await disk(directory)).store);
    expect(await second.service.authorize(request, signature)).toEqual(auth);
    expect((await second.service.snapshot()).grants[alice.address.toLowerCase()]?.spent).toBe(10n);
    // EIP-712 addresses are case-insensitive; retries must preserve the stored authorization owner.
    const voucher = await second.service.complete({ ...request, userKey: request.userKey.toLowerCase() as Hex }, signature, evidence);
    await second.options.store.transact((await second.service.snapshot()).session, state => ({ state: state!, value: undefined }));
    const legacy = new CappedDelegationSigner({ session, store: second.options.store, signCumulative: async () => voucher, verifyRead: async () => evidence, now: () => 1_000_000 });
    await expect(legacy.snapshot()).rejects.toThrow("sponsored");
    expect((await second.service.snapshot()).latestVoucher).toEqual(voucher);
  });

  it("refuses a sponsored coordinator over an existing post-proof ledger", async () => {
    const store = new MemoryDelegationStore();
    const legacy = new CappedDelegationSigner({ session, store, signCumulative: async amount => ({ sessionId: session.sessionId, amount, signature: `0x${"11".repeat(65)}` }), verifyRead: async () => evidence, now: () => 1_000_000 });
    await legacy.grant(alice.address, 20n, 2000);
    await expect(setup(store).service.grant(alice.address, 20n, 2000)).rejects.toThrow("mode");
  });

  it.skipIf(process.platform !== "linux")("retains allocated exposure when the read signer dies before its reply is acknowledged", async () => {
    const { directory, store } = await disk();
    const failing = setup(store, { signer: { address: sponsor.address, signTypedData: (async args => {
      const signature = await sponsor.signTypedData(args);
      process.kill(store.workerPid, "SIGKILL");
      return signature;
    }) as typeof sponsor.signTypedData } });
    await failing.service.grant(alice.address, 10n, 2000);
    const request = intent(), signature = await sign(request);
    await expect(failing.service.authorize(request, signature)).rejects.toThrow();
    await store.close();
    const recovered = setup((await disk(directory)).store);
    expect((await recovered.service.authorize(request, signature)).readId).toBe(hashTypedData(sponsoredIntentTypedData(session, request)));
    const state = await recovered.service.snapshot();
    expect(state.grants[alice.address.toLowerCase()]?.spent).toBe(10n);
    expect(state.total).toBe(0n);
  });

  it.skipIf(process.platform !== "linux")("recovers a signed voucher after a crash without verifying or charging the same intent twice", async () => {
    const { directory, store } = await disk();
    const failing = setup(store, { signer: { address: sponsor.address, signTypedData: (async args => {
      const signature = await sponsor.signTypedData(args);
      if (args.primaryType === "Voucher") process.kill(store.workerPid, "SIGKILL");
      return signature;
    }) as typeof sponsor.signTypedData } });
    await failing.service.grant(alice.address, 10n, 2000);
    const request = intent(), signature = await sign(request);
    await failing.service.authorize(request, signature);
    await expect(failing.service.complete(request, signature, evidence)).rejects.toThrow();
    await store.close();
    const recovered = setup((await disk(directory)).store);
    const voucher = await recovered.service.complete(request, signature, undefined);
    expect(voucher.amount).toBe(10n);
    expect(recovered.verified).not.toHaveBeenCalled();
    expect((await recovered.service.snapshot()).total).toBe(10n);
    expect((await recovered.service.snapshot()).grants[alice.address.toLowerCase()]?.spent).toBe(10n);
  });
});
