// Local end-to-end sponsorship: only the app coordinator holds the escrow session key.
// Loopback transports and a genuine generated state trie are fixtures, not a Tor/consensus claim.
import { afterAll, beforeAll, expect, it } from 'vitest';
import ganache from 'ganache';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';
import { readAuthorizationTypedData, voucherTypedData } from '../../payments/src/protocol.ts';
import { SponsoredPaymentCoordinator } from '../../payments/src/sponsored.ts';
import { SponsoredPaymentClient, createSponsoredHttpTransport } from '../../payments/src/sponsored-client.ts';
import { FileDelegationStore, serveSponsoredCoordinator } from '../../payments/src/node-store.ts';
import { createReadEvidenceVerifier, sponsoredRequestHash } from '../../payments/examples/read-evidence.ts';
import { createPaymentChain } from '../../wrapper/src/payment-chain.ts';
import { createPaymentController } from '../../wrapper/src/payment.ts';
import { openFilePaymentStore } from '../../wrapper/src/payment-store.ts';
import { createProxy } from '../../wrapper/src/proxy.ts';
import { serve } from '../../wrapper/src/server.ts';
import { createVerifiedReader } from '../../provider/src/verify/reader.ts';
import { provenFixture, TARGET, THIRD } from '../../provider/test/execution/proven-fixture.ts';

const chainId = 31337, price = 10n, deposit = 1000n;
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const now = () => Math.floor(Date.now() / 1000);
let rpc, proxy, coordinatorServer, root, wrapperStore, delegationStore, controller, coordinator;
let publicClient, payer, appSigner, delegatedKeys, escrow, abi, session, fixture, wrapperOrigin, coordinatorOrigin;
let browser, secondBrowser, appOptions, upstreamCalls = 0, sponsorVerifications = 0;

const requestHash = address => sponsoredRequestHash({ method: 'eth_getBalance', address }, fixture.block.blockHash);
async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
function browserClient(signer) {
  return new SponsoredPaymentClient({
    session: { ...session, price }, userSigner: signer, sessionKey: appSigner.address,
    transport: createSponsoredHttpTransport({ url: 'https://sponsor.example', fetch: (url, init) => {
      if (new URL(url).hostname !== 'sponsor.example') throw new Error('unexpected coordinator destination');
      return fetch(new URL(new URL(url).pathname, coordinatorOrigin), init);
    } }),
  });
}
const intent = (nonce, address = TARGET) => ({ nonce, kind: 'proof', requestHash: requestHash(address), expiresAt: now() + 300 });
async function wrapperRpc(method, params, headers = {}) {
  return fetch(`${wrapperOrigin}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: json({ jsonrpc: '2.0', id: 1, method, params }) });
}
async function readBalance(attempt, address = TARGET) {
  let evidence;
  const reader = createVerifiedReader({
    headers: { finalized: () => fixture.block, assertFresh: block => { expect(block).toBe(fixture.block); } },
    send: async (method, params) => {
      const response = await wrapperRpc(method, params, attempt.headers());
      if (!response.ok) throw new Error(`paid wrapper HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      evidence = { readId: attempt.readId, method: 'eth_getBalance', address, blockHash: fixture.block.blockHash, proof: body.result };
      return body.result;
    },
  });
  const result = await reader.getBalance(address);
  evidence.value = result.value.toString();
  return { result, evidence };
}
async function openCoordinator() {
  delegationStore = await FileDelegationStore.open(join(root, 'sponsor'));
  coordinator = new SponsoredPaymentCoordinator({ ...appOptions, store: delegationStore });
  coordinatorServer = await serveSponsoredCoordinator(coordinator);
  coordinatorOrigin = `http://127.0.0.1:${coordinatorServer.address().port}`;
}

beforeAll(async () => {
  rpc = ganache.server({ chain: { chainId, hardfork: 'shanghai' }, logging: { quiet: true }, wallet: { totalAccounts: 5 } });
  await rpc.listen(0, '127.0.0.1');
  const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
  const keys = Object.values(rpc.provider.getInitialAccounts()).map(value => value.secretKey);
  const accounts = keys.map(privateKeyToAccount);
  [appSigner, ...delegatedKeys] = accounts.slice(2);
  publicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 10 });
  payer = createWalletClient({ account: accounts[0], transport: http(rpcUrl, { retryCount: 0 }) });
  const artifact = compile()['QueryEscrow.sol'].QueryEscrow;
  abi = artifact.abi;
  const deployed = await payer.deployContract({ abi, bytecode: `0x${artifact.evm.bytecode.object}`, chain: null });
  escrow = (await publicClient.waitForTransactionReceipt({ hash: deployed })).contractAddress;
  const sessionId = await publicClient.readContract({ address: escrow, abi, functionName: 'nextSessionId' });
  const funded = await payer.writeContract({ address: escrow, abi, functionName: 'open', args: [accounts[1].address, appSigner.address], value: deposit, chain: null });
  expect((await publicClient.waitForTransactionReceipt({ hash: funded })).status).toBe('success');
  const chainSession = await publicClient.readContract({ address: escrow, abi, functionName: 'sessions', args: [sessionId] });
  session = { chainId, escrow, sessionId, budget: 30n, refundAfter: Number(chainSession[4]) };
  root = await mkdtemp(join(tmpdir(), 'derpc-sponsored-integration-'));
  wrapperStore = await openFilePaymentStore(join(root, 'wrapper'));
  const adapter = await createPaymentChain({ rpcUrl, chainId, escrow, privateKey: keys[1], confirmations: 1, store: wrapperStore });
  controller = createPaymentController({ chainId, escrow, price, store: wrapperStore, ...adapter });
  fixture = await provenFixture([{ address: TARGET, balance: 73n }, { address: THIRD, balance: 91n }]);
  const send = fixture.endpoint();
  proxy = serve(createProxy({
    executionUrl: 'http://execution.invalid', beaconUrl: 'http://beacon.invalid', payments: controller,
    identity: { ens: 'sponsored.derpc.eth', signer: adapter.operator, chains: [1], version: '1', service: 'node' },
    fetch: async (_url, init) => {
      upstreamCalls++;
      const { id, method, params } = JSON.parse(init.body);
      const result = method === 'eth_getBlockByNumber' ? { number: `0x${fixture.block.blockNumber.toString(16)}` } : await send(method, params, { isolationKey: 'fixture-upstream' });
      return Response.json({ jsonrpc: '2.0', id, result });
    },
  }), 0);
  await once(proxy, 'listening');
  wrapperOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const verifyEvidence = createReadEvidenceVerifier({
    price,
    headers: { finalized: () => fixture.block, assertFresh: block => { expect(block).toBe(fixture.block); } },
  });
  appOptions = {
    session, price, signer: appSigner,
    verifyRead: async (evidence, control) => {
      sponsorVerifications++;
      control.signal?.throwIfAborted();
      if (!evidence || evidence.readId !== control.authorization.readId) throw new Error('evidence is not bound to the authorized read');
      // The app's example verifier obtains its root from its OWN trusted header view.
      return verifyEvidence(evidence, control);
    },
  };
  await openCoordinator();
  await coordinator.grant(delegatedKeys[0].address, 20n, now() + 600);
  await coordinator.grant(delegatedKeys[1].address, 20n, now() + 600);
  browser = browserClient(delegatedKeys[0]);
  secondBrowser = browserClient(delegatedKeys[1]);
}, 30_000);

afterAll(async () => {
  await closeServer(coordinatorServer);
  await delegationStore?.close();
  await closeServer(proxy);
  await controller?.drain();
  await wrapperStore?.close();
  await rpc?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it('serves app-funded verified reads with delegated-only browser keys, durable caps and revocation, then settles exactly once', async () => {
  const tag = `0x${fixture.block.blockNumber.toString(16)}`;
  const forged = { sessionId: session.sessionId, readId: `0x${'11'.repeat(32)}`, kind: 'proof', price, deadline: now() + 60 };
  const rejected = await wrapperRpc('eth_getProof', [TARGET, [], tag], {
    'x-derpc-session': String(session.sessionId), 'x-derpc-read-id': forged.readId, 'x-derpc-read-kind': 'proof',
    'x-derpc-price': String(price), 'x-derpc-read-deadline': String(forged.deadline),
    'x-derpc-read-authorization': await delegatedKeys[0].signTypedData(readAuthorizationTypedData(session, forged)),
  });
  expect(rejected.status).toBe(401);
  expect(upstreamCalls).toBe(0);

  const [first, abandoned] = await Promise.all([browser.begin(intent(0n)), secondBrowser.begin(intent(0n))]);
  const duplicate = await browser.retryBegin(first.recovery);
  expect([duplicate.readId, duplicate.deadline]).toEqual([first.readId, first.deadline]);
  const second = await browser.begin(intent(1n, THIRD));
  expect((await coordinator.snapshot()).total).toBe(0n); // authorization cannot itself be redeemed
  const beforeLimits = upstreamCalls;
  await expect(browser.begin(intent(2n))).rejects.toThrow(); // per-user exposure cap
  await expect(secondBrowser.begin(intent(1n))).rejects.toThrow(); // aggregate exposure cap
  expect(upstreamCalls).toBe(beforeLimits);

  const secondRead = await readBalance(second, THIRD);
  expect(secondRead.result.value).toBe(91n);
  expect((await second.complete(secondRead.evidence)).amount).toBe(10n); // out-of-order completion
  const invalid = await readBalance(abandoned);
  expect(invalid.result.value).toBe(73n);
  const tampered = structuredClone(invalid.evidence);
  tampered.proof.balance = '0xffff';
  await expect(abandoned.complete(tampered)).rejects.toThrow();
  expect((await coordinator.snapshot()).total).toBe(10n);
  const firstRead = await readBalance(first);
  expect((await first.complete(firstRead.evidence)).amount).toBe(20n);
  expect((await coordinator.snapshot()).total).toBe(20n);
  await coordinator.revoke(delegatedKeys[1].address);
  await expect(secondBrowser.begin(intent(1n))).rejects.toThrow();
  const retained = await secondBrowser.retryBegin(abandoned.recovery);
  expect([retained.readId, retained.deadline]).toEqual([abandoned.readId, abandoned.deadline]);

  // Closing and administrative operations are deliberately unavailable to delegated HTTP callers.
  for (const path of ['/approve', '/grant', '/revoke', '/close']) {
    const response = await fetch(`${coordinatorOrigin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  }
  const voucherForgery = { sessionId: String(session.sessionId), amount: '20', signature: await delegatedKeys[0].signTypedData(voucherTypedData(session, session.sessionId, 20n)) };
  expect((await fetch(`${wrapperOrigin}/payments/voucher`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(voucherForgery) })).status).toBe(401);

  await closeServer(coordinatorServer);
  coordinatorServer = undefined;
  await delegationStore.close();
  await openCoordinator();
  browser = browserClient(delegatedKeys[0]); // a reloaded browser receives no app key
  secondBrowser = browserClient(delegatedKeys[1]);
  const recovered = await coordinator.snapshot();
  expect(recovered.total).toBe(20n);
  expect(recovered.grants[delegatedKeys[0].address.toLowerCase()].spent).toBe(20n);
  expect(recovered.grants[delegatedKeys[1].address.toLowerCase()]).toMatchObject({ spent: 10n, revoked: true });
  await expect(browser.begin(intent(2n))).rejects.toThrow();
  await expect(secondBrowser.begin(intent(1n))).rejects.toThrow();
  const verificationCount = sponsorVerifications;
  const resumed = await browser.retryBegin(first.recovery);
  expect((await resumed.complete(firstRead.evidence)).amount).toBe(20n);
  expect(sponsorVerifications).toBe(verificationCount); // committed completion replay cannot double-charge

  const closing = await coordinator.prepareClose(); // trusted app administration, outside browser API
  expect(closing.voucher.amount).toBe(20n);
  await expect(coordinator.complete(abandoned.recovery.intent, abandoned.recovery.signature, invalid.evidence)).rejects.toThrow();
  const before = await publicClient.getBalance({ address: payer.account.address });
  const closeBody = { ...closing.voucher, close: true, closeAuthorization: closing.closeAuthorization, closeDeadline: closing.closeDeadline };
  const response = await fetch(`${wrapperOrigin}/payments/voucher`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(closeBody) });
  expect(response.status).toBe(200);
  const submitted = await response.json();
  const transactionHash = submitted.settlement.transactionHash;
  expect(submitted).toMatchObject({ highestAmount: '20', settlement: { state: 'pending' } });
  expect((await publicClient.waitForTransactionReceipt({ hash: transactionHash })).status).toBe('success');
  await controller.tick();
  const status = await controller.voucher({ sessionId: String(session.sessionId), amount: '20', signature: closing.voucher.signature });
  expect(status.settlement).toMatchObject({ state: 'confirmed', transactionHash, paid: '20', refunded: '980' });
  expect(await publicClient.getBalance({ address: payer.account.address })).toBe(before + 980n);
  expect(await publicClient.getBalance({ address: escrow })).toBe(0n);
}, 30_000);
