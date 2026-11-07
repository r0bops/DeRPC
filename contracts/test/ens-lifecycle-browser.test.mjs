import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, toHex } from 'viem';
import { UPSTREAM, addresses, dnsEncode, operatorRecords, resolverAbi, serializeOperatorEndpoints } from '../lib/ens-common.mjs';
import { registrarBuild } from '../scripts/ens-plan.mjs';
import { validateJoinConfig } from '../lib/ens-join.mjs';
import { expectedOperatorLifecycleTransaction, lifecycleManifestHash, lifecycleTransaction, operatorLifecycleOperators, prepareOperatorLifecycle, resolveOperatorLifecycleManifest } from '../lib/ens-lifecycle.mjs';

// These tests isolate the authority bridge. Exact receipt/runtime replay is tested by
// ens-join-verification and the opt-in browser-core fork integration using real ENS code.
const replay = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../lib/ens-join.mjs', async importOriginal => ({ ...await importOriginal(), verifyJoin: replay.verify }));
const addr = n => toHex(n, { size: 20 }), hash = n => toHex(n, { size: 32 });
let build;
beforeAll(() => { build = registrarBuild(); }, 30000);
beforeEach(() => replay.verify.mockReset());

function fixture(plural = false) {
  const directory = { chainId: 1, ethRegistry: addresses.ETHRegistry,
    registrar: { address: addr(4), codeHash: hash(1), registry: addr(3) } };
  const raw = { label: 'carol', operator: addr(30), coldOwner: addr(30), hotKey: addr(31), signer: addr(30), payee: addr(30),
    caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'] }, expiry: 1794086400,
    ...(plural ? { endpoints: [{ id: 'east', url: 'https://east.example/rpc' }, { id: 'west', url: 'https://west.example/rpc' }] }
      : { endpoint: 'https://carol.example/rpc' }) };
  const op = { name: 'carol.derpc.eth', operator: raw.operator, coldOwner: raw.coldOwner, hotKey: raw.hotKey,
    payee: raw.payee, expiry: raw.expiry, resolver: addr(32), records: operatorRecords(raw) };
  const verification = { receipts: true, canonicalBlocks: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 };
  const deployment = { schemaVersion: 1, kind: 'derpc-ens-deployment', chainId: 1, localOnly: true, parentName: 'derpc.eth',
    curator: addr(1), deployer: addr(2), subregistry: addr(3), sourceHash: build.sourceHash, compiler: structuredClone(build.compiler),
    registrar: { ...directory.registrar, runtimeCodeHash: hash(1), subregistry: addr(3) }, verification,
    upstream: Object.fromEntries(Object.entries(UPSTREAM.artifacts).map(([name, artifact]) => [name, {
      address: addresses[name], runtimeCodeHash: hash(2), normalizedRuntimeCodeHash: artifact.normalizedRuntimeCodeHash,
    }])), observedBlock: { number: '100', hash: hash(100) }, transactions: [],
    operators: [{ name: 'alice.derpc.eth', operator: addr(10), coldOwner: addr(10), hotKey: addr(11), payee: addr(10), resolver: addr(12),
      records: { 'derpc.endpoint': 'https://alice.example/rpc', 'derpc.signer': addr(10), 'derpc.caps': '{"chainId":1,"methods":["eth_getProof","eth_getCode"]}' } }],
  };
  const config = { schemaVersion: 1, kind: 'derpc-ens-join-config', chainId: 1, parentName: 'derpc.eth', deploymentId: 'join-carol',
    curator: deployment.curator, directory: structuredClone(directory), operators: [raw] };
  const ids = ['deploy-resolver-carol', 'grant-endpoint-carol', 'register-carol'];
  const stages = ids.map((id, i) => ({ plan: { compiler: structuredClone(build.compiler), transactions: [{ id }], registrationSlot: null }, transactionHashes: [hash(200 + i)] }));
  const enrollment = { schemaVersion: 1, kind: 'derpc-ens-operator-enrollment', chainId: 1, localOnly: true,
    checkedAt: '2026-11-07T00:00:00.000Z', sourceHash: build.sourceHash, compiler: structuredClone(build.compiler), directory,
    operators: [op], roleTable: [], observedBlock: { number: '120', hash: hash(120) },
    verification: { ...verification, operatorSigned: true },
    transactions: ids.map((id, i) => ({ id, transactionHash: hash(200 + i), blockNumber: String(101 + i), blockHash: hash(101 + i), from: raw.operator })),
    enrollmentEvidence: { config, stages },
  };
  // A real replay returns canonical fields, independently of the supplied imported JSON.
  const verified = structuredClone(enrollment);
  replay.verify.mockImplementation(async () => ({ ...structuredClone(verified), checkedAt: new Date().toISOString() }));
  const blocks = new Map([[100n, { number: 100n, hash: hash(100) }], [120n, { number: 120n, hash: hash(120) }], [200n, { number: 200n, hash: hash(200) }]]);
  const client = { getChainId: async () => 1, getBlock: vi.fn(async request => request.blockTag === 'latest' ? blocks.get(200n) : blocks.get(BigInt(request.blockNumber))) };
  return { deployment, enrollment, client, build, blocks, raw, op };
}

function planFor(manifest, action, build) {
  const before = { index: 7 };
  return { schemaVersion: 1, kind: 'derpc-ens-lifecycle-plan', chainId: 1, sourceHash: build.sourceHash,
    manifestHash: lifecycleManifestHash(manifest), action, before,
    walletRequest: { method: 'eth_sendTransaction', params: [lifecycleTransaction(manifest, action, before, build)] } };
}

describe('browser lifecycle authority bridge', () => {
  it('uses only the configured manifest for bootstrap operators without importing another deployment', async () => {
    const f = fixture();
    expect(operatorLifecycleOperators({ ...f, enrollment: undefined })).toEqual(f.deployment.operators);
    expect(await resolveOperatorLifecycleManifest({ ...f, enrollment: undefined })).toBe(f.deployment);
    await expect(resolveOperatorLifecycleManifest({ ...f, enrollment: f.deployment })).rejects.toThrow(/enrollment differs/);
    expect(replay.verify).not.toHaveBeenCalled();
  });

  it('replays original enrollment receipts at their canonical snapshot without changing subsequent lifecycle identity', async () => {
    const f = fixture(), first = await resolveOperatorLifecycleManifest(f), second = await resolveOperatorLifecycleManifest(f);
    expect(replay.verify).toHaveBeenCalledTimes(2);
    const request = replay.verify.mock.calls[0][0];
    expect(request.config).toEqual(validateJoinConfig(f.enrollment.enrollmentEvidence.config));
    expect(request.stages).toEqual(f.enrollment.enrollmentEvidence.stages);
    expect(Object.keys(request.stages[0].plan.compiler)).toEqual(Object.keys(build.compiler));
    expect(await request.client.getBlock({ blockTag: 'latest' })).toEqual(f.blocks.get(120n));
    expect(await f.client.getBlock({ blockTag: 'latest' })).toEqual(f.blocks.get(200n));
    expect(first.deployer).toBe(f.raw.operator);
    expect(first.curator).toBe(f.deployment.curator);
    expect(first.operators).toEqual(f.enrollment.operators);
    expect(lifecycleManifestHash(first)).toBe(lifecycleManifestHash(second));
  });

  it.each(['directory', 'source', 'compiler', 'curator', 'hot key', 'local environment', 'missing stages'])('rejects changed %s before receipt replay', async field => {
    const f = fixture(), enrollment = f.enrollment;
    if (field === 'directory') enrollment.directory.registrar.registry = addr(99);
    if (field === 'source') enrollment.sourceHash = hash(99);
    if (field === 'compiler') enrollment.compiler.optimizerRuns++;
    if (field === 'curator') enrollment.enrollmentEvidence.config.curator = addr(99);
    if (field === 'hot key') enrollment.operators[0].hotKey = addr(99);
    if (field === 'local environment') enrollment.localOnly = false;
    if (field === 'missing stages') enrollment.enrollmentEvidence.stages.pop();
    await expect(resolveOperatorLifecycleManifest(f)).rejects.toThrow();
    expect(replay.verify).not.toHaveBeenCalled();
  });

  it('refuses self-declared records or receipts that differ from actual enrollment replay', async () => {
    for (const mutate of [e => { e.operators[0].records['derpc.signer'] = addr(99); }, e => { e.transactions[2].transactionHash = hash(99); }]) {
      const f = fixture(); mutate(f.enrollment);
      await expect(resolveOperatorLifecycleManifest(f)).rejects.toThrow(/differs from replayed canonical evidence/);
    }
  });

  it('propagates failed receipt replay and rejects an orphaned enrollment snapshot', async () => {
    const f = fixture(); replay.verify.mockRejectedValueOnce(new Error('Wrong operator-signed receipt'));
    await expect(resolveOperatorLifecycleManifest(f)).rejects.toThrow(/Wrong operator-signed receipt/);
    f.blocks.get(120n).hash = hash(99);
    await expect(resolveOperatorLifecycleManifest(f)).rejects.toThrow(/no longer canonical/);
    expect(replay.verify).toHaveBeenCalledOnce();
  });

  it('bounds imported evidence size and nesting before replay', async () => {
    const oversized = fixture(); oversized.enrollment.padding = 'a'.repeat(524289);
    await expect(resolveOperatorLifecycleManifest(oversized)).rejects.toThrow(/512 KiB/);
    const nested = fixture(); let cursor = nested.enrollment;
    for (let i = 0; i < 30; i++) cursor = cursor.child = {};
    await expect(resolveOperatorLifecycleManifest(nested)).rejects.toThrow(/structural bound/);
    expect(replay.verify).not.toHaveBeenCalled();
  });

  it('reconstructs renewal from the operator, refusing a changed signer or curator authority', async () => {
    const f = fixture(), manifest = await resolveOperatorLifecycleManifest(f);
    const action = { type: 'renew', label: 'carol', expectedExpiry: f.raw.expiry, expiry: f.raw.expiry + 3600, authority: 'operator' };
    const plan = planFor(manifest, action, build), tx = expectedOperatorLifecycleTransaction({ ...f, plan });
    expect(tx.from).toBe(f.raw.operator); expect(tx.to).toBe(f.deployment.registrar.address);
    expect(decodeFunctionData({ abi: build.artifact.abi, data: tx.data })).toEqual({ functionName: 'renew', args: [7n, BigInt(action.expiry)] });
    const changed = structuredClone(plan); changed.walletRequest.params[0].from = f.raw.hotKey;
    expect(() => expectedOperatorLifecycleTransaction({ ...f, plan: changed })).toThrow(/permitted action/);
    const curator = planFor(manifest, { ...action, authority: 'curator' }, build);
    expect(() => expectedOperatorLifecycleTransaction({ ...f, plan: curator })).toThrow(/operator renewal and endpoint updates only/);
  });

  it.each([false, true])('reconstructs the exact hot-key endpoint update (plural=%s)', async plural => {
    const f = fixture(plural), manifest = await resolveOperatorLifecycleManifest(f);
    const action = plural ? { type: 'rotate-endpoints', label: 'carol', expectedEndpoints: f.raw.endpoints,
      newEndpoints: [{ id: 'east', url: 'https://new.example/rpc' }] }
      : { type: 'rotate-endpoint', label: 'carol', expectedEndpoint: f.raw.endpoint, newEndpoint: 'https://new.example/rpc' };
    const plan = planFor(manifest, action, build), tx = expectedOperatorLifecycleTransaction({ ...f, plan });
    expect(tx.from).toBe(f.raw.hotKey); expect(tx.to).toBe(f.op.resolver);
    expect(decodeFunctionData({ abi: resolverAbi, data: tx.data }).args).toEqual([dnsEncode('carol.derpc.eth'),
      plural ? 'derpc.endpoints' : 'derpc.endpoint', plural ? serializeOperatorEndpoints(action.newEndpoints) : action.newEndpoint]);
    const changed = structuredClone(plan); changed.walletRequest.params[0].from = f.raw.operator;
    expect(() => expectedOperatorLifecycleTransaction({ ...f, plan: changed })).toThrow(/permitted action/);
  });

  it('retains the mainnet check and excludes moderation from website actions', async () => {
    const f = fixture(), withoutEnrollment = { ...f, enrollment: undefined };
    const action = { type: 'renew', label: 'alice', expectedExpiry: 1000, expiry: 2000 };
    await expect(prepareOperatorLifecycle({ ...withoutEnrollment, action, client: { ...f.client, getChainId: async () => 31337 } })).rejects.toThrow(/mainnet chain ID/);
    await expect(prepareOperatorLifecycle({ ...withoutEnrollment, action: { type: 'delist', label: 'alice' } })).rejects.toThrow(/operator renewal and endpoint updates only/);
  });
});
