import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { VerifiedHeader } from "../../provider/src/light-client/header-source.ts";
import type { AccountProof } from "../../provider/src/verify/index.ts";
import { balanceReadHash, createBalanceEvidenceVerifier } from "../examples/balance-verifier.ts";
import { CappedDelegationSigner, delegatedReadTypedData, type DelegatedRead, type DelegationOptions, type DelegationSession } from "../src/delegation.ts";
import { FileDelegationStore, serveDelegationCoordinator, type CoordinatorServerOptions } from "../src/node-store.ts";
import { voucherTypedData, type SignedVoucher } from "../src/protocol.ts";

const fixture = JSON.parse(await readFile(new URL("../../provider/test/fixtures/mainnet-proofs.json", import.meta.url), "utf8")) as {
  capturedAt: number;
  block: { number: number; hash: Hex; stateRoot: Hex };
  inputs: { HOLDER: Address };
  responses: { holderAccount: AccountProof };
};
// This recorded state root is an explicit test trust anchor. These tests exercise real Merkle
// proof verification, but do not claim live consensus, freshness or anonymous network traffic.
const clock = fixture.capturedAt;
const nowSeconds = Math.floor(clock / 1000);
const header: VerifiedHeader = {
  network: "mainnet", slot: 0, blockNumber: fixture.block.number, blockHash: fixture.block.hash,
  stateRoot: fixture.block.stateRoot, timestamp: nowSeconds,
};
const app = privateKeyToAccount(`0x${"61".repeat(32)}`);
const browser = privateKeyToAccount(`0x${"62".repeat(32)}`);
const session: DelegationSession = {
  chainId: 31337, escrow: `0x${"63".repeat(20)}`, sessionId: 15n, budget: 100n,
  refundAfter: nowSeconds + 7200,
};
const price = 10n;
const paths: string[] = [];
const stores: FileDelegationStore[] = [];
const servers: Server[] = [];

function evidence() {
  return {
    method: "eth_getBalance" as const, address: fixture.inputs.HOLDER, blockHash: fixture.block.hash,
    value: BigInt(fixture.responses.holderAccount.balance).toString(),
    proof: structuredClone(fixture.responses.holderAccount),
  };
}

function authorization(overrides: Partial<DelegatedRead> = {}): DelegatedRead {
  return {
    sessionId: session.sessionId, userKey: browser.address, nonce: 0n, charge: price,
    readHash: balanceReadHash(fixture.inputs.HOLDER, fixture.block.hash, BigInt(fixture.responses.holderAccount.balance)),
    expiresAt: nowSeconds + 3600, ...overrides,
  };
}

function proofVerifier() {
  const fresh = vi.fn((candidate: VerifiedHeader) => {
    if (candidate.blockHash !== fixture.block.hash || clock - candidate.timestamp * 1000 >= 30 * 60 * 1000) throw new Error("stale test anchor");
  });
  return { fresh, verify: createBalanceEvidenceVerifier({ headers: { finalized: () => header, assertFresh: fresh }, price }) };
}

async function start(options: CoordinatorServerOptions = {}, overrideVerifier?: DelegationOptions["verifyRead"]) {
  const path = await mkdtemp(join(tmpdir(), "derpc-delegation-http-"));
  paths.push(path);
  const store = await FileDelegationStore.open(path);
  stores.push(store);
  const actual = proofVerifier();
  const verify = vi.fn(overrideVerifier ?? actual.verify);
  const signed = vi.fn(async (amount: bigint): Promise<SignedVoucher> => ({
    sessionId: session.sessionId, amount,
    signature: await app.signTypedData(voucherTypedData(session, session.sessionId, amount)),
  }));
  const signer = new CappedDelegationSigner({ session, store, now: () => clock, verifyRead: verify, signCumulative: signed });
  await signer.grant(browser.address, 25n, nowSeconds + 3600);
  const server = await serveDelegationCoordinator(signer, { port: 0, timeoutMs: 5000, ...options });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("coordinator did not bind a TCP port");
  expect(address.address).toBe("127.0.0.1");
  return { signer, signed, verify, fresh: actual.fresh, url: `http://127.0.0.1:${address.port}` };
}

async function body(request = authorization(), readEvidence: unknown = evidence()) {
  const signature = await browser.signTypedData(delegatedReadTypedData(session, request));
  return JSON.stringify({ request, signature, evidence: readEvidence }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}

function post(url: string, serialized: string, route = "/approve") {
  return fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: serialized });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const store of stores.splice(0)) await store.close();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("delegated payment HTTP coordinator", () => {
  it("verifies a real recorded account proof before returning a durable app-signed voucher", async () => {
    const host = await start();
    const response = await post(host.url, await body());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { voucher } = await response.json() as { voucher: { sessionId: string; amount: string; signature: Hex } };
    expect(voucher.sessionId).toBe(session.sessionId.toString());
    expect(voucher.amount).toBe(price.toString());
    const typed = voucherTypedData(session, BigInt(voucher.sessionId), BigInt(voucher.amount));
    expect(await verifyTypedData({ ...typed, address: app.address, signature: voucher.signature })).toBe(true);
    expect(await verifyTypedData({ ...typed, address: browser.address, signature: voucher.signature })).toBe(false);
    expect(host.signed).toHaveBeenCalledExactlyOnceWith(price);
    expect(host.fresh).toHaveBeenCalledTimes(2);
    expect((await host.signer.snapshot()).latestVoucher).toEqual({ ...voucher, sessionId: session.sessionId, amount: price });
  });

  it("rejects a mutated account proof without reserving credit or creating a voucher", async () => {
    const host = await start();
    const corrupt = evidence();
    corrupt.proof.balance = "0x1";
    const response = await post(host.url, await body(authorization(), corrupt));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("proven") });
    const state = await host.signer.snapshot();
    expect(state.total).toBe(0n);
    expect(state.reservations).toEqual({});
    expect(state.latestVoucher).toBeUndefined();
    expect(host.signed).not.toHaveBeenCalled();
  });

  it("binds the browser authorization to the exact proven address, block and balance", async () => {
    const host = await start();
    const wrongTuples = [
      balanceReadHash(browser.address, fixture.block.hash, 0n),
      balanceReadHash(fixture.inputs.HOLDER, `0x${"ff".repeat(32)}`, 0n),
      balanceReadHash(fixture.inputs.HOLDER, fixture.block.hash, 1n),
    ];
    for (const readHash of wrongTuples) {
      const response = await post(host.url, await body(authorization({ readHash })));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("does not match") });
    }
    expect((await host.signer.snapshot()).total).toBe(0n);
    expect(host.signed).not.toHaveBeenCalled();
  });

  it("keeps grant and revoke administration off HTTP and bounds approval bodies", async () => {
    const host = await start({ maxBodyBytes: 256 });
    for (const route of ["/grant", "/revoke", "/admin/grant", "/admin/revoke"]) {
      const response = await post(host.url, "{}", route);
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
    const response = await post(host.url, await body());
    expect(response.status).toBe(413);
    await response.arrayBuffer();
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.signed).not.toHaveBeenCalled();
    expect((await host.signer.snapshot()).total).toBe(0n);
  });

  it("bounds stalled verifiers and prevents spending when a timed-out verifier later resolves", async () => {
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let abortSignal: AbortSignal | undefined;
    const actual = proofVerifier();
    const host = await start({ maxConcurrent: 1, timeoutMs: 500 }, async (readEvidence, options) => {
      abortSignal = options?.signal;
      started();
      // Deliberately ignore abort in this dependency: the coordinator must still gate spending.
      await stalled;
      return actual.verify(readEvidence);
    });
    const serialized = await body();
    const first = post(host.url, serialized);
    try {
      await entered;
      const busy = await post(host.url, serialized);
      expect(busy.status).toBe(429);
      await busy.arrayBuffer();
      const timeout = await first;
      expect(timeout.status).toBe(504);
      await timeout.arrayBuffer();
      expect(abortSignal?.aborted).toBe(true);
      // Keep the slot occupied until the uncooperative verifier exits, even after its HTTP timeout.
      const stillBusy = await post(host.url, serialized);
      expect(stillBusy.status).toBe(429);
      await stillBusy.arrayBuffer();
    } finally { release(); }
    await vi.waitFor(async () => {
      const invalid = await post(host.url, "{}");
      const status = invalid.status;
      await invalid.arrayBuffer();
      expect(status).toBe(400);
    });
    const state = await host.signer.snapshot();
    expect(state.total).toBe(0n);
    expect(state.reservations).toEqual({});
    expect(state.latestVoucher).toBeUndefined();
    expect(host.signed).not.toHaveBeenCalled();
    expect(host.verify).toHaveBeenCalledTimes(1);
  });
});
