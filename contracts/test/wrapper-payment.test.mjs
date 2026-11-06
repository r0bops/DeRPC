// Local integration only: real HTTP, proof verification, signatures, journal and escrow transactions.
// The anonymous transport and consensus header are explicit fixtures; this does not test Tor or consensus.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import ganache from 'ganache';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, custom, http, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';
import { PaymentClient } from '../../payments/src/client.ts';
import { voucherTypedData } from '../../payments/src/protocol.ts';
import { createPaymentChain } from '../../wrapper/src/payment-chain.ts';
import { createPaymentController } from '../../wrapper/src/payment.ts';
import { openFilePaymentStore } from '../../wrapper/src/payment-store.ts';
import { createProxy } from '../../wrapper/src/proxy.ts';
import { serve } from '../../wrapper/src/server.ts';
import { createDeRPCWith, simulatedLyingOperator } from '../../provider/src/api/derpc.ts';
import { TOR_JS_PIN } from '../../provider/src/config/mainnet.ts';
import { provenFixture, TARGET, RETURN_42, word } from '../../provider/test/execution/proven-fixture.ts';

const chainId = 31337;
const price = 10n;
const deposit = 1000n;
const selected = { id: 'local-paid', url: 'https://local-paid.example/rpc', priority: 0 };
let rpc, proxy, directory, store, controller, derpc, payments, publicClient, payer, escrow, abi, sessionId;
let config, transportCalls, upstreamCalls;

beforeAll(async () => {
  rpc = ganache.server({ chain: { chainId, hardfork: 'shanghai' }, logging: { quiet: true }, wallet: { totalAccounts: 3 } });
  await rpc.listen(0, '127.0.0.1');
  const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
  const keys = Object.values(rpc.provider.getInitialAccounts()).map(a => a.secretKey);
  const accounts = keys.map(privateKeyToAccount);
  publicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 10 });
  payer = createWalletClient({ account: accounts[0], transport: http(rpcUrl, { retryCount: 0 }) });
  const artifact = compile()['QueryEscrow.sol'].QueryEscrow;
  abi = artifact.abi;
  const deploy = await payer.deployContract({ abi, bytecode: `0x${artifact.evm.bytecode.object}`, chain: null });
  escrow = (await publicClient.waitForTransactionReceipt({ hash: deploy })).contractAddress;
  sessionId = await publicClient.readContract({ address: escrow, abi, functionName: 'nextSessionId' });
  const funding = await payer.writeContract({ address: escrow, abi, functionName: 'open', args: [accounts[1].address, accounts[2].address], value: deposit, chain: null });
  expect((await publicClient.waitForTransactionReceipt({ hash: funding })).status).toBe('success');
  const funded = await publicClient.readContract({ address: escrow, abi, functionName: 'sessions', args: [sessionId] });

  directory = await mkdtemp(join(tmpdir(), 'derpc-paid-integration-'));
  store = await openFilePaymentStore(directory);
  const adapter = await createPaymentChain({ rpcUrl, chainId, escrow, privateKey: keys[1], confirmations: 1, store });
  config = { chainId, escrow, operator: adapter.operator, price, store, chain: adapter.chain };
  controller = createPaymentController(config);
  payments = new PaymentClient();
  payments.addSession({ chainId, escrow, operatorId: selected.id, sessionId, payer: funded[0], payee: funded[1], signer: accounts[2], deposit: funded[3], refundAfter: Number(funded[4]), price });

  const fixture = await provenFixture([
    { address: TOR_JS_PIN.specifier, storage: { 1: BigInt(TOR_JS_PIN.workerHash) } },
    { address: TARGET, balance: 73n, nonce: 2n, code: RETURN_42 },
  ]);
  const send = fixture.endpoint();
  upstreamCalls = [];
  const handler = createProxy({
    executionUrl: 'http://execution.invalid', beaconUrl: 'http://beacon.invalid',
    identity: { ens: 'local-paid.derpc.eth', signer: accounts[1].address, chains: [1], version: '1', service: 'node' },
    payments: { admit: (...args) => controller.admit(...args), voucher: (...args) => controller.voucher(...args) },
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      upstreamCalls.push(request);
      const result = request.method === 'eth_getBlockByNumber'
        ? { number: `0x${fixture.block.blockNumber.toString(16)}` }
        : await send(request.method, request.params, { isolationKey: 'test-upstream' });
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  });
  proxy = serve(handler, 0);
  await once(proxy, 'listening');
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  transportCalls = [];
  let state = 'ready';
  derpc = createDeRPCWith({
    startTransport: () => ({
      pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => state,
      fetch: async (url, init) => {
        // The ONLY test transport route is this loopback server. No .example hostname is contacted.
        if (new URL(url).hostname !== 'local-paid.example') throw new Error('unexpected test destination');
        transportCalls.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body) });
        return fetch(new URL(new URL(url).pathname, origin), init);
      },
      close: () => { state = 'closed'; },
    }),
    startHeaders: async () => ({ finalized: () => fixture.block, assertFresh: () => {}, pollHealth: () => ({ consecutiveFailures: 0 }), close: () => {} }),
  }, { operators: [selected], payments, verifiedCalls: true });
  await derpc.ready;
}, 30_000);

it('recovers an expired missing nonce after journal restart without replacing signed transactions', async () => {
  // Only this in-process Ganache provider is contacted. Start one day behind so an
  // originally valid close can expire while later sessions use the current clock.
  const node = ganache.provider({
    chain: { chainId, hardfork: 'shanghai', time: new Date(Date.now() - 86_460_000) },
    miner: { instamine: 'strict' }, logging: { quiet: true }, wallet: { totalAccounts: 3 },
  });
  const intercepted = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (new URL(String(url)).hostname !== 'payment-nonce-recovery.invalid') throw new Error('unexpected nonce recovery test destination');
    const request = JSON.parse(init.body);
    try { return Response.json({ jsonrpc: '2.0', id: request.id, result: await node.request(request) }); }
    catch (error) { return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: error.code ?? -32000, message: error.message } }); }
  });
  const journalDirectory = await mkdtemp(join(tmpdir(), 'derpc-nonce-recovery-'));
  let journal, accounting;
  try {
    const localAccounts = Object.values(node.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey));
    const localKeys = Object.values(node.getInitialAccounts()).map(a => a.secretKey);
    const reader = createPublicClient({ transport: custom(node), pollingInterval: 10 });
    const funder = createWalletClient({ account: localAccounts[0], transport: custom(node) });
    const artifact = compile()['QueryEscrow.sol'].QueryEscrow;
    const deployed = await funder.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, chain: null });
    const address = (await reader.waitForTransactionReceipt({ hash: deployed })).contractAddress;
    async function fund() {
      const id = await reader.readContract({ address, abi: artifact.abi, functionName: 'nextSessionId' });
      const hash = await funder.writeContract({ address, abi: artifact.abi, functionName: 'open', args: [localAccounts[1].address, localAccounts[2].address], value: deposit, chain: null });
      await reader.waitForTransactionReceipt({ hash });
      const session = await reader.readContract({ address, abi: artifact.abi, functionName: 'sessions', args: [id] });
      return { id, refundAfter: Number(session[4]) };
    }
    const first = await fund();
    journal = await openFilePaymentStore(journalDirectory);
    const adapterOptions = { rpcUrl: 'http://payment-nonce-recovery.invalid', chainId, escrow: address, privateKey: localKeys[1], confirmations: 1 };
    let adapter = await createPaymentChain({ ...adapterOptions, store: journal });
    async function record(session) {
      const signature = await localAccounts[2].signTypedData(voucherTypedData({ chainId, escrow: address }, session.id, price));
      const prepared = await adapter.chain.prepareClose(session.id, price, signature);
      await journal.save({
        version: 1, chainId, escrow: address, sessionId: String(session.id),
        payer: localAccounts[0].address, operator: adapter.operator, sessionKey: localAccounts[2].address,
        price: String(price), deposit: String(deposit), refundAfter: session.refundAfter, served: 1,
        reads: { [`0x${'11'.repeat(32)}`]: { kind: 'proof', requests: { [`0x${'22'.repeat(32)}`]: 1 } } },
        highest: { amount: String(price), signature }, settlement: { state: 'pending', amount: String(price), ...prepared },
      });
      return prepared;
    }
    const original = await record(first);
    expect(parseTransaction(original.serializedTransaction).nonce).toBe(0);
    // The original broadcast was lost before acceptance; advancing time expires its claim.
    await node.request({ method: 'evm_setTime', params: [Date.now()] });
    await node.request({ method: 'evm_mine', params: [] });
    const failedBroadcast = vi.fn(async () => { throw new Error('node unavailable before acceptance'); });
    accounting = createPaymentController({ chainId, escrow: address, operator: adapter.operator, price, store: journal, chain: { ...adapter.chain, broadcast: failedBroadcast } });
    await accounting.tick();
    expect(failedBroadcast).toHaveBeenCalledWith(original.serializedTransaction);
    expect((await journal.load(String(first.id))).settlement.state).toBe('expired');
    await accounting.drain(); await journal.close();

    journal = await openFilePaymentStore(journalDirectory);
    adapter = await createPaymentChain({ ...adapterOptions, store: journal });
    const second = await fund();
    const later = await record(second);
    expect(await reader.getTransactionCount({ address: adapter.operator, blockTag: 'pending' })).toBe(0);
    expect(parseTransaction(later.serializedTransaction).nonce).toBe(1); // expired journal still reserves 0
    await adapter.chain.broadcast(later.serializedTransaction);
    const broadcast = vi.fn(adapter.chain.broadcast);
    accounting = createPaymentController({ chainId, escrow: address, operator: adapter.operator, price, store: journal, chain: { ...adapter.chain, broadcast } });
    await accounting.tick();
    expect(broadcast).toHaveBeenCalledWith(original.serializedTransaction);
    expect((await reader.waitForTransactionReceipt({ hash: original.transactionHash })).status).toBe('reverted');
    expect((await reader.waitForTransactionReceipt({ hash: later.transactionHash })).status).toBe('success');
    await accounting.tick();
    expect((await journal.load(String(first.id))).settlement).toMatchObject({ state: 'expired', amount: String(price), ...original });
    expect((await journal.load(String(second.id))).settlement).toMatchObject({ state: 'confirmed', amount: String(price), ...later });
    expect(await reader.getTransactionCount({ address: adapter.operator })).toBe(2);
    expect(await reader.getBalance({ address })).toBe(deposit); // only the expired session remains
    const broadcasts = broadcast.mock.calls.length;
    await accounting.drain(); await journal.close();

    journal = await openFilePaymentStore(journalDirectory);
    adapter = await createPaymentChain({ ...adapterOptions, store: journal });
    const restartedBroadcast = vi.fn(adapter.chain.broadcast);
    accounting = createPaymentController({ chainId, escrow: address, operator: adapter.operator, price, store: journal, chain: { ...adapter.chain, broadcast: restartedBroadcast } });
    await accounting.tick();
    expect(restartedBroadcast).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(broadcasts);
    expect((await journal.load(String(first.id))).settlement).toMatchObject({ state: 'expired', ...original });
    const refund = await funder.writeContract({ address, abi: artifact.abi, functionName: 'refund', args: [first.id], chain: null });
    expect((await reader.waitForTransactionReceipt({ hash: refund })).status).toBe('success');
    expect(await reader.getBalance({ address })).toBe(0n);
  } finally {
    await accounting?.drain(); await journal?.close();
    intercepted.mockRestore(); await node.disconnect();
    await rm(journalDirectory, { recursive: true, force: true });
  }
}, 30_000);

afterAll(async () => {
  derpc?.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await controller?.drain();
  await store?.close();
  await rpc?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('charges one verified logical read, rejects corruption, flushes the final voucher and recovers settlement after restart', async () => {
  expect((await derpc.reader.getBalance(TARGET)).value).toBe(73n);
  expect(payments.snapshot()[0]).toMatchObject({ total: 10n, verifiedReads: 1 });
  expect((await store.load(sessionId.toString())).highest).toBeUndefined(); // first read signs after its response
  const sent = transportCalls.length;
  expect((await derpc.reader.getBalance(TARGET)).value).toBe(73n);
  expect(transportCalls).toHaveLength(sent); // cache hits create no authorization or payment

  expect((await derpc.reader.getCode(TARGET)).value).toBe(RETURN_42);
  const codeRequests = transportCalls.filter(c => c.headers.get('x-derpc-read-kind') === 'code');
  expect(codeRequests.map(c => c.body.method).sort()).toEqual(['eth_getCode', 'eth_getProof']);
  expect(new Set(codeRequests.map(c => c.headers.get('x-derpc-read-id'))).size).toBe(1);
  expect(payments.snapshot()[0]).toMatchObject({ total: 20n, verifiedReads: 2 });
  expect((await derpc.verifiedCall({ to: TARGET })).value).toBe(word(42n));
  expect(payments.snapshot()[0]).toMatchObject({ total: 30n, verifiedReads: 3 });
  expect(upstreamCalls.every(c => c.method !== 'eth_call')).toBe(true); // execution stayed in the verified host

  derpc.setOperators([simulatedLyingOperator(selected)]);
  await expect(derpc.reader.getTransactionCount(TARGET)).rejects.toThrow();
  expect(derpc.status().operators[0].state).toBe('excluded');
  expect(payments.snapshot()[0]).toMatchObject({ total: 30n, verifiedReads: 3, inFlight: 0 });

  const before = await publicClient.getBalance({ address: payer.account.address });
  const submitted = await derpc.settlePayment(selected.id, { close: true });
  expect(submitted).toMatchObject({ highestAmount: '30', settlement: { state: 'pending' } });
  const transactionHash = submitted.settlement.transactionHash;
  expect(transactionHash).toMatch(/^0x[\da-f]{64}$/);
  const durable = await store.load(sessionId.toString());
  expect(durable.highest.amount).toBe('30');
  expect(durable.settlement.serializedTransaction).toMatch(/^0x[\da-f]+$/);
  expect((await publicClient.waitForTransactionReceipt({ hash: transactionHash })).status).toBe('success');

  // The persisted signed transaction and claim survive replacing the entire accounting controller.
  await controller.drain();
  await store.close();
  store = await openFilePaymentStore(directory);
  controller = createPaymentController({ ...config, store });
  await controller.tick();
  const confirmed = await derpc.settlePayment(selected.id);
  expect(confirmed).toMatchObject({ highestAmount: '30', settlement: { state: 'confirmed', transactionHash, paid: '30', refunded: '970' } });
  expect((await publicClient.readContract({ address: escrow, abi, functionName: 'sessions', args: [sessionId] }))[5]).toBe(true);
  expect(await publicClient.getBalance({ address: payer.account.address })).toBe(before + 970n);
  expect(await publicClient.getBalance({ address: escrow })).toBe(0n);
}, 30_000);
