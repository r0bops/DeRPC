import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, toHex } from 'viem';
import { UPSTREAM, addresses, dnsEncode, resolverAbi } from '../scripts/ens-common.mjs';
import { registrarBuild } from '../scripts/ens-plan.mjs';
import { lifecycleManifestHash, lifecycleTransaction, prepareLifecycle, validateLifecycleAction, validateLifecycleManifest, verifyLifecycle } from '../scripts/ens-lifecycle.mjs';

const addr = n => toHex(n, { size: 20 }), hash = n => toHex(n, { size: 32 });
let build;
beforeAll(() => { build = registrarBuild(); }, 30000);
function fixture() {
  return { schemaVersion: 1, kind: 'derpc-ens-deployment', chainId: 1, localOnly: true, parentName: 'derpc.eth', curator: addr(1), deployer: addr(2), subregistry: addr(3), sourceHash: build.sourceHash, compiler: build.compiler, registrar: { address: addr(4), codeHash: hash(1), runtimeCodeHash: hash(1), registry: addr(3), subregistry: addr(3) },
    verification: { receipts: true, canonicalBlocks: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 },
    upstream: Object.fromEntries(Object.entries(UPSTREAM.artifacts).map(([name, artifact]) => [name, { address: addresses[name], runtimeCodeHash: hash(2), normalizedRuntimeCodeHash: artifact.normalizedRuntimeCodeHash }])),
    transactions: [], observedBlock: { number: '100', hash: hash(100) }, operators: [10, 20].map((n, index) => ({ name: `${index ? 'bob' : 'alice'}.derpc.eth`, operator: addr(n), coldOwner: addr(n), hotKey: addr(n + 1), payee: addr(n), resolver: addr(n + 2), records: { 'derpc.endpoint': `https://${index ? 'bob' : 'alice'}.example/rpc`, 'derpc.signer': addr(n), 'derpc.caps': '{"chainId":1,"methods":["eth_getProof","eth_getCode"]}' } })) };
}

describe('unsigned ENS lifecycle review', () => {
  it('reconstructs only endpoint text writes from the dedicated hot key', () => {
    const manifest = fixture();
    const action = validateLifecycleAction({ type: 'rotate-endpoint', label: 'alice', expectedEndpoint: 'https://alice.example/rpc', newEndpoint: 'https://replacement.example/rpc' }, manifest);
    const tx = lifecycleTransaction(manifest, action, { index: 0 }, build);
    expect(tx).toMatchObject({ from: manifest.operators[0].hotKey, to: manifest.operators[0].resolver, value: '0x0', chainId: '0x1' });
    expect(decodeFunctionData({ abi: resolverAbi, data: tx.data })).toEqual({ functionName: 'setText', args: [dnsEncode('alice.derpc.eth'), 'derpc.endpoint', action.newEndpoint] });
  });

  it('uses registrar removal and only the recorded operator or curator for renewal', () => {
    const manifest = fixture(), before = { index: 7 };
    const remove = lifecycleTransaction(manifest, { type: 'delist', label: 'alice' }, before, build);
    expect(remove.from).toBe(manifest.curator); expect(remove.to).toBe(manifest.registrar.address);
    expect(decodeFunctionData({ abi: build.artifact.abi, data: remove.data })).toEqual({ functionName: 'remove', args: [7n] });
    for (const authority of ['operator', 'curator']) {
      const action = validateLifecycleAction({ type: 'renew', label: 'alice', expectedExpiry: 100, expiry: 200, authority }, manifest);
      const tx = lifecycleTransaction(manifest, action, before, build);
      expect(tx.from).toBe(authority === 'operator' ? manifest.operators[0].operator : manifest.curator);
      expect(decodeFunctionData({ abi: build.artifact.abi, data: tx.data })).toEqual({ functionName: 'renew', args: [7n, 200n] });
    }
  });

  it('refuses arbitrary permissions, labels, senders, keys and invalid endpoints', () => {
    for (const action of [
      { type: 'grant', label: 'alice' }, { type: 'delist', label: 'alice', from: addr(99) }, { type: 'delist', label: 'alice.bob' }, { type: 'delist', label: 'absent' },
      { type: 'renew', label: 'alice', expectedExpiry: 100, expiry: 100 }, { type: 'renew', label: 'alice', expectedExpiry: 100, expiry: 200, authority: 'hotKey' },
      { type: 'rotate-endpoint', label: 'alice', expectedEndpoint: 'https://alice.example/rpc', newEndpoint: 'https://alice.example/rpc' },
      { type: 'rotate-endpoint', label: 'alice', expectedEndpoint: 'https://alice.example/rpc', newEndpoint: 'https://user:secret@example.com' },
      { type: 'rotate-endpoint', label: 'alice', expectedEndpoint: 'https://alice.example/rpc', newEndpoint: `http://${'a'.repeat(56)}.onion` },
      { type: 'rotate-endpoint', label: 'alice', expectedEndpoint: 'https://alice.example/rpc', newEndpoint: 'https://valid.example/rpc', key: 'derpc.payee' },
    ]) expect(() => validateLifecycleAction(action, fixture())).toThrow();
  });

  it('requires the original verified source, exact registrar pins, free records and separate resolver identities', () => {
    expect(validateLifecycleManifest(fixture(), build).chainId).toBe(1);
    for (const mutate of [m => { m.sourceHash = hash(99); }, m => { m.verification.hotKeyEventAudit = false; }, m => { m.registrar.registry = addr(99); }, m => { m.registrar.codeHash = hash(99); }, m => { m.operators[1].resolver = m.operators[0].resolver; }, m => { m.operators[0].hotKey = m.operators[1].coldOwner; }, m => { m.operators[0].records['derpc.price'] = '1'; }, m => { m.operators[0].records['derpc.endpoints'] = '[]'; }]) {
      const manifest = fixture(); mutate(manifest); expect(() => validateLifecycleManifest(manifest, build)).toThrow();
    }
  });

  it('binds all manifest content without depending on JSON object key order', () => {
    const manifest = fixture();
    expect(lifecycleManifestHash(Object.fromEntries(Object.entries(manifest).reverse()))).toBe(lifecycleManifestHash(manifest));
    const changed = structuredClone(manifest); changed.operators[0].hotKey = addr(98);
    expect(lifecycleManifestHash(changed)).not.toBe(lifecycleManifestHash(manifest));
  });

  it('fails before reading state on another chain or before twelve confirmations are requested', async () => {
    const manifest = fixture(), client = { getChainId: async () => 31337 };
    await expect(prepareLifecycle({ manifest, action: { type: 'delist', label: 'alice' }, client, build })).rejects.toThrow(/chain ID/);
    await expect(verifyLifecycle({ manifest, plan: {}, transactionHash: hash(1), confirmations: 1, client, build })).rejects.toThrow(/12 confirmations/);
  });
});
