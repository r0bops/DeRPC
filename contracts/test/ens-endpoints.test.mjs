import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, toHex, zeroAddress } from 'viem';
import { deploymentSalt, dnsEncode, endpointMigrationCalls, endpointRecordKey, factoryAbi, labelId, operatorRecords, resolverAbi, roles, serializeOperatorEndpoints, validateConfig } from '../scripts/ens-common.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { verifyStageIdentity } from '../scripts/ens-verify.mjs';
import { lifecycleTransaction, validateLifecycleAction } from '../scripts/ens-lifecycle.mjs';

const addr = value => toHex(value, { size: 20 });
let build;
beforeAll(() => { build = registrarBuild(); }, 30000);
const nodes = () => [{ id: 'east', url: 'https://EAST.example:443/rpc', beaconUrl: 'https://east.example/beacon' }, { id: 'west', url: 'https://west.example/rpc', beaconUrl: 'https://west.example/beacon' }];
const config = () => ({ schemaVersion: 1, chainId: 1, parentName: 'derpc.eth', curator: addr(1), deployer: addr(2), deploymentId: 'plural-fixture', operators: [3, 10].map((n, index) => ({ label: index ? 'bob' : 'alice', operator: addr(n), coldOwner: addr(n + 1), hotKey: addr(n + 2), signer: addr(n + 3), payee: addr(n), expiry: 1800003600, caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'], beacon: true }, endpoints: nodes() })) });

describe('plural ENS deployment and lifecycle', () => {
  it('publishes the exact shared canonical schema, clears singular records and selects one role', () => {
    const c = validateConfig(config()), op = c.operators[0];
    expect(op.endpoints[0].url).toBe('https://east.example/rpc');
    expect(operatorRecords(op)).toMatchObject({ 'derpc.endpoints': serializeOperatorEndpoints(nodes()), 'derpc.endpoint': '', 'derpc.beacon': '' });
    expect(endpointRecordKey(op)).toBe('derpc.endpoints');
  });

  it('refuses mixed/paid modes, partial required beacon coverage and malformed bounded lists', () => {
    for (const mutate of [
      op => { op.endpoint = 'https://legacy.example'; }, op => { op.beacon = null; }, op => { op.payment = {}; },
      op => { delete op.endpoints[1].beaconUrl; }, op => { op.endpoints = []; }, op => { op.endpoints = Array.from({ length: 9 }, (_, i) => ({ id: `node-${i}`, url: `https://node-${i}.example` })); },
      op => { op.endpoints[1].id = op.endpoints[0].id; }, op => { op.endpoints[1].url = 'https://east.example/rpc'; },
      op => { op.endpoints[0].id = '-bad'; }, op => { op.endpoints[0].id = 'x'.repeat(32); }, op => { op.endpoints[0].price = '1'; },
      op => { op.endpoints[0].url = 'https://east.example/?'; }, op => { op.endpoints[0].url = 'https://east.example/#'; }, op => { op.endpoints[0].url = 'https://secret:credential@east.example'; },
      op => { op.endpoints[0].url = `http://${'a'.repeat(56)}.onion`; }, op => { op.endpoints[0].url = `https://east.example/${'a'.repeat(4096)}`; },
    ]) { const c = config(); mutate(c.operators[0]); expect(() => validateConfig(c)).toThrow(); }
  });

  it('creates fresh plural resolver initializer calldata with canonical lists and empty legacy records', async () => {
    const c = validateConfig(config());
    const predictions = new Map([[deploymentSalt(c, 'registry'), addr(50)], ...c.operators.map((op, index) => [deploymentSalt(c, `resolver:${op.label}`), addr(51 + index)])]);
    const client = { readContract: async ({ functionName, args }) => functionName === 'hasRoles' ? true : predictions.get(args[1]), getBytecode: async () => '0x', estimateGas: async () => 100000n };
    const snapshot = { chainId: 1, blockNumber: '100', blockHash: toHex(100, { size: 32 }), timestamp: 1800000000, parent: { expiry: 1810000000, subregistry: zeroAddress } };
    const plan = await preparePlan({ config: c, client, snapshot, build });
    const proxy = decodeFunctionData({ abi: factoryAbi, data: plan.transactions[1].walletRequest.params[0].data });
    const init = decodeFunctionData({ abi: resolverAbi, data: proxy.args[2] });
    const texts = init.args[1].map(data => decodeFunctionData({ abi: resolverAbi, data }));
    expect(texts.every(call => call.functionName === 'setText')).toBe(true);
    expect(Object.fromEntries(texts.map(call => [call.args[1], call.args[2]]))).toEqual(operatorRecords(c.operators[0]));
    expect(plan.roleTable.find(row => row.account === c.operators[0].hotKey).resource).toContain('derpc.endpoints only');
  });

  it('atomically revokes the obsolete role before granting the chosen key in either migration direction', () => {
    const plural = validateConfig(config()).operators[0];
    const legacy = { ...plural, endpoint: 'https://legacy.example/rpc', beacon: 'https://legacy.example/beacon' }; delete legacy.endpoints;
    for (const [op, selected, obsolete] of [[plural, 'derpc.endpoints', 'derpc.endpoint'], [legacy, 'derpc.endpoint', 'derpc.endpoints']]) {
      const calls = endpointMigrationCalls(op, 'alice.derpc.eth').map(data => decodeFunctionData({ abi: resolverAbi, data }));
      expect(calls.map(call => call.functionName)).toEqual(['revokeRoles', 'setText', 'setText', 'setText', 'grantSetterRoles']);
      expect(calls[0].args).toEqual([labelId(obsolete), roles.text, op.hotKey]);
      expect(calls[1].args).toEqual([dnsEncode('alice.derpc.eth'), obsolete, '']);
      expect(calls[3].args).toEqual([dnsEncode('alice.derpc.eth'), selected, operatorRecords(op)[selected]]);
      expect(decodeFunctionData({ abi: resolverAbi, data: calls[4].args[0] }).args).toEqual([dnsEncode('alice.derpc.eth'), selected, '']);
      expect(calls[4].args[1]).toBe(op.hotKey);
    }
  });

  it('allows reviewed mode changes across stages but never substitutes deployment or operator identities', () => {
    const final = validateConfig(config()), earlier = structuredClone(final);
    for (const op of earlier.operators) { delete op.endpoints; op.endpoint = `https://${op.label}.example/rpc`; }
    expect(() => verifyStageIdentity(earlier, final)).not.toThrow();
    for (const mutate of [c => { c.deploymentId = 'another-deployment'; }, c => { c.deployer = addr(99); }, c => { c.curator = addr(99); }, c => { c.operators[0].hotKey = addr(99); }, c => { c.operators[0].operator = addr(99); }, c => { c.operators[0].coldOwner = addr(99); }, c => { c.operators[0].payee = addr(99); }]) {
      const changed = structuredClone(earlier); mutate(changed); expect(() => verifyStageIdentity(changed, final)).toThrow(/identities/);
    }
  });

  it('binds plural lifecycle rotation to the whole canonical old/new list and the same hot key', () => {
    const op = validateConfig(config()).operators[0];
    const manifest = { curator: addr(1), registrar: { address: addr(40) }, operators: [{ name: 'alice.derpc.eth', operator: op.operator, resolver: addr(41), hotKey: op.hotKey, records: operatorRecords(op) }] };
    const replacement = nodes(); replacement[0].url = 'https://replacement.example/rpc';
    const action = validateLifecycleAction({ type: 'rotate-endpoints', label: 'alice', expectedEndpoints: nodes(), newEndpoints: replacement }, manifest);
    const tx = lifecycleTransaction(manifest, action, { index: 0 }, build);
    expect(tx.from).toBe(op.hotKey); expect(tx.to).toBe(addr(41));
    expect(decodeFunctionData({ abi: resolverAbi, data: tx.data }).args).toEqual([dnsEncode('alice.derpc.eth'), 'derpc.endpoints', serializeOperatorEndpoints(replacement)]);
    expect(action.expectedEndpoints).toHaveLength(2); expect(action.newEndpoints[1]).toEqual(action.expectedEndpoints[1]);
    expect(() => validateLifecycleAction({ type: 'rotate-endpoints', label: 'alice', expectedEndpoints: nodes(), newEndpoints: op.endpoints }, manifest)).toThrow(/must change/);
    expect(() => validateLifecycleAction({ type: 'rotate-endpoint', label: 'alice', expectedEndpoint: 'https://old.example', newEndpoint: 'https://new.example' }, manifest)).toThrow(/rotate-endpoints/);
    delete replacement[1].beaconUrl;
    expect(() => validateLifecycleAction({ type: 'rotate-endpoints', label: 'alice', expectedEndpoints: nodes(), newEndpoints: replacement }, manifest)).toThrow(/every new endpoint/);
  });
});
