import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTypedData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { VerifiedHeader } from "../../provider/src/light-client/header-source.ts";
import type { AccountProof } from "../../provider/src/verify/index.ts";
import type { JsonRpcSend } from "../../provider/src/verify/reader.ts";
import { createReadEvidenceVerifier, sponsoredRequestHash } from "../examples/read-evidence.ts";
import { createSponsoredReader } from "../examples/sponsored-reader.ts";
import { PaymentClient } from "../src/client.ts";
import { MemoryDelegationStore } from "../src/delegation.ts";
import { FileDelegationStore, serveSponsoredCoordinator } from "../src/node-store.ts";
import { voucherTypedData } from "../src/protocol.ts";
import { createSponsoredHttpTransport, SponsoredPaymentClient, type SignedSponsoredIntent, type SponsoredTransport } from "../src/sponsored-client.ts";
import { SponsoredPaymentCoordinator, sponsoredIntentTypedData } from "../src/sponsored.ts";

const fixture = JSON.parse(await readFile(new URL("../../provider/test/fixtures/mainnet-proofs.json", import.meta.url), "utf8")) as {
  capturedAt: number; block: { number: number; hash: Hex; stateRoot: Hex };
  inputs: { HOLDER: Address }; responses: { holderAccount: AccountProof };
};
// Fixed test keys and a recorded proof root, with no funded deployment or anonymous runtime claim.
const owner = privateKeyToAccount(`0x${"81".repeat(32)}`);
const agent = privateKeyToAccount(`0x${"82".repeat(32)}`);
const now = Math.floor(fixture.capturedAt / 1000);
const expiresAt = now + 3600;
const session = { chainId: 31337, escrow: `0x${"83".repeat(20)}` as Hex, sessionId: 61n, budget: 30n, refundAfter: now + 7200 };
const price = 10n;
const header: VerifiedHeader = { network: "mainnet", slot: 0, blockNumber: fixture.block.number, blockHash: fixture.block.hash, stateRoot: fixture.block.stateRoot, timestamp: now };
const headers = { finalized: () => ({ ...header }), assertFresh: (candidate: VerifiedHeader) => { if (candidate.blockHash !== header.blockHash || candidate.timestamp !== now) throw new Error("unexpected test proof anchor"); } };
const requestHash = sponsoredRequestHash({ method: "eth_getBalance", address: fixture.inputs.HOLDER }, header.blockHash);
const input = (nonce: bigint) => ({ nonce, kind: "proof" as const, requestHash, expiresAt });
const evidence = () => ({ method: "eth_getBalance" as const, address: fixture.inputs.HOLDER, blockHash: header.blockHash, value: BigInt(fixture.responses.holderAccount.balance).toString(), proof: structuredClone(fixture.responses.holderAccount) });
const paths: string[] = [];
const closeHosts: Array<() => Promise<void>> = [];

async function start(directory: string) {
  const store = await FileDelegationStore.open(directory);
  const verifyRead = vi.fn(createReadEvidenceVerifier({ headers, price }));
  const options = { session, price, signer: owner, store, verifyRead, now: () => fixture.capturedAt };
  const coordinator = new SponsoredPaymentCoordinator(options);
  const server = await serveSponsoredCoordinator(coordinator, { port: 0 }).catch(async error => { await store.close(); throw error; });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("coordinator did not bind");
  expect(bound.address).toBe("127.0.0.1");
  const url = `http://127.0.0.1:${bound.port}`;
  const close = async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await store.close();
  };
  closeHosts.push(close);
  const userSign = vi.fn(agent.signTypedData);
  const client = new SponsoredPaymentClient({
    session: { ...session, price }, sessionKey: owner.address,
    userSigner: { address: agent.address, signTypedData: userSign as typeof agent.signTypedData },
    transport: createSponsoredHttpTransport({ url, fetch }), now: () => fixture.capturedAt,
  });
  return { coordinator, client, close, verifyRead, userSign, options, url };
}

async function post(url: string, prepared: SignedSponsoredIntent, extra = {}) {
  return fetch(`${url}/authorize`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...prepared, ...extra }, (_key, value) => typeof value === "bigint" ? value.toString() : value) });
}

afterEach(async () => {
  for (const close of closeHosts.splice(0)) await close();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("agent payment authority", () => {
  it("refuses the escrow key as a delegated key on the client, grant API and old-grant request path", async () => {
    const transport: SponsoredTransport = { authorize: vi.fn(), complete: vi.fn() };
    expect(() => new SponsoredPaymentClient({ session: { ...session, price }, userSigner: owner,
      sessionKey: owner.address.toLowerCase() as Address, transport })).toThrow("escrow session key");
    const store = new MemoryDelegationStore();
    const coordinator = new SponsoredPaymentCoordinator({ session, price, store, signer: owner, now: () => fixture.capturedAt,
      verifyRead: createReadEvidenceVerifier({ headers, price }) });
    await expect(coordinator.grant(owner.address.toLowerCase() as Address, price, expiresAt)).rejects.toThrow("escrow session key");
    // An older service may already have persisted this unsafe configuration. Bypassing
    // the SDK and grant endpoint must not turn that into supported delegated authority.
    const state = await coordinator.snapshot();
    await store.transact(state.session, current => {
      current!.grants[owner.address.toLowerCase()] = { cap: price, spent: 0n, nextNonce: 0n, expiresAt, revoked: false };
      return { state: current!, value: undefined };
    });
    const intent = { ...input(0n), sessionId: session.sessionId, userKey: owner.address.toLowerCase() as Address, charge: price };
    const signature = await owner.signTypedData(sponsoredIntentTypedData(session, intent));
    await expect(coordinator.authorize(intent, signature)).rejects.toThrow("escrow session key");
    expect((await coordinator.snapshot()).readAuthorizations).toEqual({});
    expect(transport.authorize).not.toHaveBeenCalled();
  });

  it("distinguishes a local SDK limit from the authority of an escrow session key", async () => {
    const local = new PaymentClient({ now: () => fixture.capturedAt });
    local.addSession({ ...session, operatorId: "test-operator", payer: owner.address, payee: agent.address,
      signer: owner, deposit: session.budget, price, spendLimit: price });
    expect(local.snapshot()[0]!.spendLimit).toBe(price);
    const typed = voucherTypedData(session, session.sessionId, session.budget);
    // The contract authenticates the session key and deposit, not an SDK instance's policy.
    expect(await verifyTypedData({ ...typed, address: owner.address, signature: await owner.signTypedData(typed) })).toBe(true);
    expect(await verifyTypedData({ ...typed, address: owner.address, signature: await agent.signTypedData(typed) })).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("enforces a delegated agent's cap, explicit allowance top-up and revocation across HTTP and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "derpc-agent-flow-")); paths.push(directory);
    let host = await start(directory);
    await host.coordinator.grant(agent.address, price, expiresAt);
    const recovered: SignedSponsoredIntent[] = [];
    const send: JsonRpcSend = vi.fn(async (method, _params, options) => {
      expect(method).toBe("eth_getProof");
      expect(new Headers(options.headers).get("x-derpc-session")).toBe(session.sessionId.toString());
      return structuredClone(fixture.responses.holderAccount);
    });
    const reader = createSponsoredReader({ client: host.client, headers, send });
    const first = await reader.getBalance(fixture.inputs.HOLDER, { nonce: 0n, expiresAt, persistIntent: prepared => { recovered.push(prepared); } });
    expect(first.value).toBe(BigInt(fixture.responses.holderAccount.balance));
    expect(first.voucher.amount).toBe(price);
    expect(host.userSign.mock.calls.every(([data]) => data.primaryType === "DelegatedReadIntent")).toBe(true);

    const next = await host.client.prepare(input(1n));
    const bypass = await post(host.url, next, { cap: 1000n, budget: 1000n });
    expect(bypass.status).toBe(400);
    expect(await bypass.json()).toMatchObject({ error: expect.stringContaining("exposure limit") });
    for (const route of ["grant", "revoke", "close"]) {
      expect((await fetch(`${host.url}/${route}`, { method: "POST" })).status).toBe(404);
    }
    expect((await host.coordinator.snapshot()).grants[agent.address.toLowerCase()]).toMatchObject({ cap: price, spent: price, nextNonce: 1n });

    // Only trusted administration raises the absolute allowance, within the fixed funded budget.
    await host.coordinator.grant(agent.address, session.budget, expiresAt);
    await host.close(); host = await start(directory);
    expect((await host.coordinator.snapshot()).grants[agent.address.toLowerCase()]).toMatchObject({ cap: 30n, spent: 10n, nextNonce: 1n });
    const issued = await host.client.retryBegin(next);
    await host.coordinator.revoke(agent.address);
    const paid = await issued.complete(evidence()); // Already allocated work retains its short deadline.
    expect(paid.amount).toBe(20n);
    const revoked = await post(host.url, await host.client.prepare(input(2n)));
    expect(revoked.status).toBe(400);
    expect(await revoked.json()).toMatchObject({ error: expect.stringContaining("revoked") });
    expect((await host.coordinator.snapshot()).grants[agent.address.toLowerCase()]).toMatchObject({ cap: 30n, spent: 20n, nextNonce: 2n, revoked: true });

    await host.close(); host = await start(directory);
    expect(await host.client.retryComplete(recovered[0]!, undefined)).toEqual(paid);
    expect(host.verifyRead).not.toHaveBeenCalled();
    expect((await host.coordinator.snapshot()).total).toBe(20n);
    expect((await host.coordinator.snapshot()).grants[agent.address.toLowerCase()]).toMatchObject({ spent: 20n, nextNonce: 2n, revoked: true });
    await expect(new SponsoredPaymentCoordinator({ ...host.options, session: { ...session, budget: 40n } }).snapshot()).rejects.toThrow("configuration changed");
    expect(await verifyTypedData({ ...voucherTypedData(session, session.sessionId, paid.amount), address: owner.address, signature: paid.signature })).toBe(true);
  });
});
