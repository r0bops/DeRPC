import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { addresses } from '../scripts/ens-common.mjs';
import { checkSubmittedTransaction, createEnsSession, directoryPins, startEnsWallet } from '../scripts/ens-wallet.mjs';

const plan = JSON.parse(readFileSync(new URL('../deployments/ens-two-demo-operators-plan-1-2026-11-07.json', import.meta.url)));
const config = plan.resumeConfig;
const build = { sourceHash: plan.sourceHash, compiler: plan.compiler };
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const temporary = [], servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(sourcePlan = plan) {
  const directory = mkdtempSync(join(tmpdir(), 'derpc-ens-wallet-')); temporary.push(directory);
  const transactions = new Map(), receipts = new Map(), confirmed = new Set();
  const missing = name => { const error = new Error('not indexed'); error.name = name; throw error; };
  const client = {
    getChainId: async () => 1,
    getTransaction: async ({ hash }) => transactions.get(hash) ?? missing('TransactionNotFoundError'),
    getTransactionReceipt: async ({ hash }) => receipts.get(hash) ?? missing('TransactionReceiptNotFoundError'),
    getBlock: async ({ blockNumber }) => ({ hash: BigInt(blockNumber) === BigInt(sourcePlan.preflight.blockNumber) ? sourcePlan.preflight.blockHash : hash(Number(blockNumber)) }),
  };
  const crosscheckClient = { ...client };
  const planner = async () => {
    const result = structuredClone(sourcePlan); result.transactions = result.transactions.filter(tx => !confirmed.has(tx.id));
    if (!result.transactions.length) { result.status = 'state-matches-config'; result.stage = 'complete'; }
    return result;
  };
  const submit = (index, { mined = true, mutation } = {}) => {
    const item = sourcePlan.transactions[index], expected = item.walletRequest.params[0], h = hash(index + 1);
    const blockNumber = BigInt(sourcePlan.preflight.blockNumber) + BigInt(index + 1), blockHash = hash(Number(blockNumber));
    const tx = { hash: h, from: expected.from, to: expected.to ?? null, input: expected.data, value: 0n, chainId: 1, nonce: index, blockNumber, blockHash };
    mutation?.(tx); transactions.set(h, tx);
    if (mined) { receipts.set(h, { transactionHash: h, from: expected.from, status: 'success', blockNumber, blockHash }); confirmed.add(item.id); }
    return h;
  };
  return { directory, client, crosscheckClient, planner, submit, transactions, receipts,
    options: () => ({ config: sourcePlan.resumeConfig, build, directory, client, crosscheckClient, planner }) };
}

function joinFixture() {
  const custom = structuredClone(plan);
  custom.flow = 'operator-join';
  custom.stage = 'register-operator';
  custom.resumeConfig = { ...structuredClone(config), flow: 'operator-join', operators: [structuredClone(config.operators[0])] };
  custom.transactions = [{ ...structuredClone(plan.transactions[0]), id: 'register-demo-1', purpose: 'Operator registers its own name',
    walletRequest: { method: 'eth_sendTransaction', params: [{ from: config.operators[0].operator, to: config.curator, data: '0x1234', value: '0x0', chainId: '0x1' }] } }];
  const f = fixture(custom);
  const manifest = { kind: 'derpc-ens-operator-registration', chainId: 1, operators: custom.resumeConfig.operators,
    roleTable: custom.roleTable, verification: { receipts: true, minimumConfirmations: 12 } };
  const pins = { chainId: 1, ethRegistry: addresses.ETHRegistry, registrar: { address: config.curator, codeHash: hash(3), registry: plan.subregistry } };
  const validateInput = vi.fn(input => {
    if (input.flow !== 'operator-join' || input.operators?.length !== 1) throw new Error('Unexpected join configuration');
    return structuredClone(input);
  });
  const checkStageIdentity = vi.fn((reviewed, current) => {
    if (JSON.stringify(reviewed) !== JSON.stringify(current)) throw new Error('Join identity changed');
  });
  const reconstructTransaction = vi.fn((item, input, stage, source) => {
    if (item.id !== custom.transactions[0].id || input.flow !== 'operator-join' || stage.flow !== 'operator-join' || source.sourceHash !== build.sourceHash) throw new Error('Unknown join transaction');
    return structuredClone(custom.transactions[0].walletRequest.params[0]);
  });
  const exportPins = vi.fn(input => {
    if (input.kind !== manifest.kind || input.verification?.receipts !== true || input.verification.minimumConfirmations < 12) throw new Error('Join manifest is not verified');
    return structuredClone(pins);
  });
  return { ...f, custom, manifest, pins, validateInput, checkStageIdentity, reconstructTransaction, exportPins,
    joinOptions: () => ({ ...f.options(), validateInput, checkStageIdentity, reconstructTransaction, exportPins, verifier: async () => structuredClone(manifest) }) };
}

describe('ENS wallet session', () => {
  it('reuses durable locks, exact reconstruction and verified exports with explicit join hooks', async () => {
    const f = joinFixture(), session = await createEnsSession(f.joinOptions()), id = f.custom.transactions[0].id;
    await session.action({ action: 'begin', id });
    const restored = await createEnsSession(f.joinOptions());
    expect(f.validateInput).toHaveBeenCalledTimes(4);
    expect(f.checkStageIdentity).toHaveBeenCalledTimes(3);
    expect(f.reconstructTransaction).toHaveBeenCalledOnce();
    await expect(restored.action({ action: 'begin', id })).rejects.toThrow(/earlier wallet submission/);
    await restored.action({ action: 'record', id, hash: f.submit(0) });
    await restored.action({ action: 'refresh' });
    const verified = await restored.action({ action: 'verify' });
    expect(verified.complete).toBe(true);
    expect(verified.manifest.kind).toBe('derpc-ens-operator-registration');
    expect(verified.directoryPins).toEqual(f.pins);
    expect(f.exportPins).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(f.directory, 'ens-directory.json')))).toEqual(f.pins);
  });

  it('retains strict bootstrap validation, reconstruction and manifest rules unless each hook is explicitly supplied', async () => {
    const f = joinFixture();
    await expect(createEnsSession(f.options())).rejects.toThrow(/Unknown configuration field/);
    await createEnsSession(f.joinOptions());
    const { reconstructTransaction: _reconstruct, ...defaultReconstruction } = f.joinOptions();
    await expect(createEnsSession(defaultReconstruction)).rejects.toThrow();
    expect(() => directoryPins(f.manifest)).toThrow(/public receipt-checked ENS manifest/);
  });

  it('rejects changed join identity and calldata when restoring a custom session', async () => {
    const f = joinFixture(); await createEnsSession(f.joinOptions());
    const path = join(f.directory, 'session.json'), saved = JSON.parse(readFileSync(path));
    saved.stages[0].plan.resumeConfig.operators[0].operator = addresses.ETHRegistry;
    writeFileSync(path, JSON.stringify(saved));
    await expect(createEnsSession(f.joinOptions())).rejects.toThrow(/Join identity changed/);
    saved.stages[0].plan.resumeConfig = structuredClone(f.custom.resumeConfig);
    saved.stages[0].plan.transactions[0].walletRequest.params[0].data = '0xabcd';
    writeFileSync(path, JSON.stringify(saved));
    await expect(createEnsSession(f.joinOptions())).rejects.toThrow(/Saved stage transaction changed/);
  });

  it('does not export custom pins when the two verified join manifests disagree', async () => {
    const f = joinFixture(), session = await createEnsSession({ ...f.joinOptions(), verifier: async ({ client }) => {
      const manifest = structuredClone(f.manifest);
      if (client === f.crosscheckClient) manifest.operators[0].endpoint = 'https://different.example/rpc';
      return manifest;
    } });
    const id = f.custom.transactions[0].id;
    await session.action({ action: 'begin', id }); await session.action({ action: 'record', id, hash: f.submit(0) });
    await session.action({ action: 'refresh' });
    await expect(session.action({ action: 'verify' })).rejects.toThrow(/verification differs/);
    expect(session.state().complete).toBe(false);
    expect(existsSync(join(f.directory, 'ens-directory.json'))).toBe(false);
  });

  it('durably locks before any wallet request and preserves an unknown submission after restart', async () => {
    const f = fixture(), session = await createEnsSession(f.options()), id = plan.transactions[0].id;
    const begun = await session.action({ action: 'begin', id });
    expect(begun.permit.walletRequest).toEqual(plan.transactions[0].walletRequest);
    expect(begun.entries[0].status).toBe('pending');
    expect(JSON.parse(readFileSync(join(f.directory, 'session.json'))).stages[0].entries[0].status).toBe('pending');
    const restarted = await createEnsSession(f.options());
    await expect(restarted.action({ action: 'begin', id })).rejects.toThrow(/earlier wallet submission/);
    await expect(restarted.action({ action: 'begin', id: plan.transactions[1].id })).rejects.toThrow(/earlier wallet submission/);
    await restarted.action({ action: 'rejected', id });
    expect((await restarted.action({ action: 'begin', id })).permit.id).toBe(id);
  });

  it('preserves unindexed hashes and rejects changed calldata or a conflicting replacement hash', async () => {
    const f = fixture(), session = await createEnsSession(f.options()), id = plan.transactions[0].id;
    await session.action({ action: 'begin', id });
    const result = await session.action({ action: 'record', id, hash: hash(1) });
    expect(result.entries[0]).toMatchObject({ status: 'submitted', hash: hash(1) });
    await expect(session.action({ action: 'rejected', id })).rejects.toThrow(/explicitly rejected/);
    await expect(session.action({ action: 'record', id, hash: hash(2) })).rejects.toThrow(/already recorded/);
    f.submit(0, { mutation: tx => { tx.input = '0x1234'; } });
    await expect(session.action({ action: 'refresh' })).rejects.toThrow(/does not match/);
    expect(session.state().entries[0].status).toBe('submitted');
  });

  it('advances only after all exact receipts, retains stage evidence and gates manifest export', async () => {
    const f = fixture(), session = await createEnsSession(f.options());
    await expect(session.action({ action: 'verify' })).rejects.toThrow(/All stages/);
    for (let index = 0; index < plan.transactions.length; index++) {
      const id = plan.transactions[index].id;
      await session.action({ action: 'begin', id });
      const result = await session.action({ action: 'record', id, hash: f.submit(index) });
      expect(result.entries[index].status).toBe('confirmed');
    }
    expect(session.state().readyToVerify).toBe(false);
    const refreshed = await session.action({ action: 'refresh' });
    expect(refreshed.readyToVerify).toBe(true); expect(refreshed.complete).toBe(false);
    const evidence = JSON.parse(readFileSync(join(f.directory, 'receipts.json')));
    expect(evidence.stages[0]).toEqual({ planFile: 'stage-1.json', transactionHashes: [hash(1), hash(2), hash(3)] });
    expect(JSON.parse(readFileSync(join(f.directory, 'stage-1.json')))).toEqual(plan);
  });

  it('refuses conflicting sources, changing review blocks and changed on-chain intent', async () => {
    const f = fixture(), session = await createEnsSession(f.options()), id = plan.transactions[0].id;
    f.crosscheckClient.getBlock = async () => ({ hash: hash(99) });
    await expect(session.action({ action: 'begin', id })).rejects.toThrow(/no longer canonical/);
    expect(session.state().entries[0].status).toBe('ready');
    f.crosscheckClient.getBlock = f.client.getBlock;
    const options = f.options();
    options.planner = async args => {
      const copy = await f.planner();
      if (args.client === f.crosscheckClient) copy.transactions[0].walletRequest.params[0].data = '0x1234';
      return copy;
    };
    const restarted = await createEnsSession(options);
    await expect(restarted.action({ action: 'begin', id })).rejects.toThrow(/sources disagree/);
    expect(restarted.state().entries[0].status).toBe('ready');
  });

  it('invalidates exported pins and the completion display if a verified receipt disappears', async () => {
    const f = fixture();
    const manifest = { kind: 'derpc-ens-deployment', chainId: 1, localOnly: false,
      upstream: { ETHRegistry: { address: addresses.ETHRegistry } }, registrar: { address: config.curator, codeHash: hash(3) },
      subregistry: plan.subregistry, operators: [], roleTable: [],
      verification: { receipts: true, canonicalBlocks: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 } };
    const session = await createEnsSession({ ...f.options(), verifier: async () => manifest });
    for (let index = 0; index < plan.transactions.length; index++) {
      const id = plan.transactions[index].id; await session.action({ action: 'begin', id });
      await session.action({ action: 'record', id, hash: f.submit(index) });
    }
    await session.action({ action: 'refresh' });
    expect((await session.action({ action: 'verify' })).complete).toBe(true);
    expect(existsSync(join(f.directory, 'ens-directory.json'))).toBe(true);
    f.receipts.delete(hash(1));
    const refreshed = await session.action({ action: 'refresh' });
    expect(refreshed.complete).toBe(false); expect(refreshed.directoryPins).toBe(null);
    expect(refreshed.entries[0].status).toBe('submitted');
    expect(existsSync(join(f.directory, 'ens-directory.json'))).toBe(false);
    expect(existsSync(join(f.directory, 'previous-verification.json'))).toBe(true);
  });

  it('rechecks same-stage receipts before authorizing the next wallet request', async () => {
    const f = fixture(), session = await createEnsSession(f.options());
    const first = plan.transactions[0].id, second = plan.transactions[1].id;
    await session.action({ action: 'begin', id: first });
    await session.action({ action: 'record', id: first, hash: f.submit(0) });
    f.receipts.delete(hash(1));
    await expect(session.action({ action: 'begin', id: second })).rejects.toThrow(/no longer confirmed/);
    expect(session.state().entries[1].status).toBe('ready');
  });

  it('rejects altered journal destinations and endpoint configuration on restart', async () => {
    const f = fixture(); await createEnsSession(f.options());
    const path = join(f.directory, 'session.json'), journal = JSON.parse(readFileSync(path));
    journal.stages[0].plan.transactions[0].walletRequest.params[0].to = config.curator;
    writeFileSync(path, JSON.stringify(journal));
    await expect(createEnsSession(f.options())).rejects.toThrow(/transaction changed/);
    journal.stages[0].plan = structuredClone(plan);
    journal.config.operators[0].endpoint = 'https://evil.example/rpc';
    writeFileSync(path, JSON.stringify(journal));
    await expect(createEnsSession(f.options())).rejects.toThrow(/configuration differs/);
  });

  it('does not accept wrong-chain, reverted or noncanonical receipts', async () => {
    const f = fixture(), item = plan.transactions[0], h = f.submit(0);
    f.transactions.get(h).chainId = 31337;
    await expect(checkSubmittedTransaction(f.client, item, h, plan.preflight.blockNumber)).rejects.toThrow(/does not match/);
    f.transactions.get(h).chainId = 1; f.receipts.get(h).status = 'reverted';
    await expect(checkSubmittedTransaction(f.client, item, h, plan.preflight.blockNumber)).rejects.toThrow(/reverted/);
    f.receipts.get(h).status = 'success'; f.client.getBlock = async () => ({ hash: hash(99) });
    await expect(checkSubmittedTransaction(f.client, item, h, plan.preflight.blockNumber)).rejects.toThrow(/not canonical/);
  });
});

it('exports directory pins only from public complete receipt verification', () => {
  const manifest = { kind: 'derpc-ens-deployment', chainId: 1, localOnly: false, upstream: { ETHRegistry: { address: addresses.ETHRegistry } },
    registrar: { address: config.curator, codeHash: hash(3) }, subregistry: plan.subregistry,
    verification: { receipts: true, canonicalBlocks: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 } };
  expect(directoryPins(manifest).registrar.registry).toBe(plan.subregistry);
  for (const change of [m => { m.localOnly = true; }, m => { m.verification.minimumConfirmations = 1; },
    m => { delete m.verification.minimumConfirmations; },
    m => { m.verification.hotKeyEventAudit = false; }, m => { m.registrar.codeHash = hash(0); }]) {
    const copy = structuredClone(manifest); change(copy); expect(() => directoryPins(copy)).toThrow();
  }
});

it('serves only loopback same-origin review assets and token-bound JSON actions', async () => {
  const f = fixture(), session = await createEnsSession(f.options());
  const { server, origin } = await startEnsWallet({ session, port: 0 }); servers.push(server);
  expect(server.address().address).toBe('127.0.0.1');
  const response = await fetch(`${origin}/state`), state = await response.json();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(state.token).toMatch(/^[0-9a-f]{64}$/);
  expect((await fetch(`${origin}/state`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  const wrongHost = await new Promise((accept, reject) => {
    const request = httpRequest(`${origin}/state`, { headers: { host: 'evil.example' } }, response => { response.resume(); accept(response.statusCode); });
    request.on('error', reject); request.end();
  });
  expect(wrongHost).toBe(403);
  expect((await fetch(`${origin}/action`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bad', action: 'begin' }) })).status).toBe(403);
  const started = await fetch(`${origin}/action`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: state.token, action: 'begin', id: plan.transactions[0].id }) });
  expect(started.status).toBe(200); expect((await started.json()).permit.id).toBe(plan.transactions[0].id);
  expect((await fetch(`${origin}/../session.json`)).status).toBe(404);
});
