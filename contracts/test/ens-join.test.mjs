import { beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroAddress } from 'viem';
import { addresses, curatorRoles, factoryAbi, json, labelId, operatorRecords, registrarRoles, registryAbi, resolverAbi, resolverOwnerRoles, textAbi } from '../scripts/ens-common.mjs';
import { registrarBuild } from '../scripts/ens-plan.mjs';
import { checkJoinIdentity, enrollmentPins, expectedJoinTransaction, prepareJoinPlan, validateJoinConfig } from '../scripts/ens-join.mjs';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
const now = 1794000000n;
let build;
beforeAll(() => { build = registrarBuild(); }, 30000);
function fixture() {
  const runtime = `0x${build.artifact.evm.deployedBytecode.object}`;
  const config = validateJoinConfig({ schemaVersion: 1, kind: 'derpc-ens-join-config', chainId: 1, parentName: 'derpc.eth', deploymentId: 'self-alice',
    curator: addr(1), directory: { chainId: 1, ethRegistry: addresses.ETHRegistry, registrar: { address: addr(2), registry: addr(3), codeHash: keccak256(runtime) } },
    operators: [{ label: 'alice', operator: addr(4), coldOwner: addr(4), hotKey: addr(5), signer: addr(4), payee: addr(4),
      endpoint: 'https://rpc.example/rpc', beacon: 'https://rpc.example', caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'], beacon: true }, expiry: Number(now + 86400n) }] });
  const op = config.operators[0], resolver = addr(6), calls = [];
  const state = { deployed: false, granted: false, entries: [], operatorBlocked: false, labelBlocked: false,
    name: { status: 0, latestOwner: zeroAddress, expiry: 0n }, code: runtime, additionalRoot: 0n, alteredRecord: false, extraScoped: false };
  const snapshot = { chainId: 1, blockNumber: 100n, blockHash: toHex(100, { size: 32 }), timestamp: now, localOnly: true,
    parent: { expiry: now + 365n * 86400n, subregistry: addr(3) } };
  const client = {
    getBytecode: async ({ address }) => address === addr(2) ? state.code : state.deployed && address === resolver ? '0x6000' : '0x',
    estimateGas: async tx => { calls.push(tx); return 123456n; },
    readContract: async ({ address, functionName: fn, args }) => {
      if (fn === 'registry') return addr(3);
      if (fn === 'curator') return addr(1);
      if (fn === 'verifyContract') return args[0] === addr(3) ? addresses.UserRegistryImpl : addresses.PermissionedResolverImpl;
      if (fn === 'predictProxyAddress') { expect(args[0]).toBe(op.operator); return resolver; }
      if (fn === 'operatorCount') return BigInt(state.entries.length);
      if (fn === 'operators') return state.entries[Number(args[0])];
      if (fn === 'operatorBlocked') return state.operatorBlocked;
      if (fn === 'labelBlocked') return state.labelBlocked;
      if (fn === 'getState') return state.name;
      if (fn === 'getParent') return [addresses.ETHRegistry, 'derpc'];
      if (fn === 'getResolver') return resolver;
      if (fn === 'roles') {
        if (address === addr(3)) return args[1] === addr(1) ? curatorRoles : registrarRoles;
        if (args[0] === 0n) return args[1] === op.operator ? resolverOwnerRoles : 0n;
        return args[0] === labelId('derpc.endpoint') && state.granted ? 16n : 0n;
      }
      if (fn === 'roleCount') {
        if (address === addr(3)) return args[0] === 0n ? curatorRoles + registrarRoles + state.additionalRoot : 0n;
        if (args[0] === labelId('derpc.signer') && state.extraScoped) return 16n;
        return args[0] === 0n ? resolverOwnerRoles : args[0] === labelId('derpc.endpoint') && state.granted ? 16n : 0n;
      }
      if (fn === 'resolve') {
        const decoded = decodeFunctionData({ abi: textAbi, data: args[1] }), key = decoded.args[1];
        return encodeFunctionResult({ abi: textAbi, functionName: 'text', result: state.alteredRecord && key === 'derpc.signer' ? addr(99) : operatorRecords(op)[key] ?? '' });
      }
      throw new Error(`Unexpected read ${fn}`);
    },
  };
  return { config, op, resolver, snapshot, client, state, calls, plan: () => prepareJoinPlan({ config, client, snapshot, build }) };
}

describe('operator-signed open ENS enrollment', () => {
  it('prepares resolver, scoped updater and mint from the operator without owner calls', async () => {
    const f = fixture(), plans = [];
    plans.push(await f.plan());
    expect(plans[0].stage).toBe('deploy-operator-resolver');
    const deploy = decodeFunctionData({ abi: factoryAbi, data: plans[0].transactions[0].walletRequest.params[0].data });
    const initialized = decodeFunctionData({ abi: resolverAbi, data: deploy.args[2] });
    expect(initialized.args[0]).toEqual([{ account: f.op.operator, roleBitmap: resolverOwnerRoles }]);
    f.state.deployed = true; plans.push(await f.plan());
    expect(plans[1].stage).toBe('configure-operator-endpoint-key');
    f.state.granted = true; plans.push(await f.plan());
    expect(plans[2].stage).toBe('register-operator');
    const mint = decodeFunctionData({ abi: build.artifact.abi, data: plans[2].transactions[0].walletRequest.params[0].data });
    expect(mint.functionName).toBe('register'); expect(mint.args[1]).toBe(f.op.operator);
    for (const plan of plans) {
      expect(plan.transactions).toHaveLength(1);
      expect(plan.flow).toBe('operator-join');
      const item = plan.transactions[0];
      expect(item.walletRequest.params[0]).toEqual(expectedJoinTransaction(item, f.config, plan, build));
      expect(item.walletRequest.params[0]).toMatchObject({ from: f.op.operator, value: '0x0', chainId: '0x1' });
      expect(item.walletRequest.params[0].from).not.toBe(f.config.curator);
    }
    expect(f.calls.every(tx => tx.account === f.op.operator && tx.value === 0n)).toBe(true);
    f.state.entries = [[toHex('alice', { size: 32 }), f.op.operator, BigInt(f.op.expiry), true, f.op.payee]];
    f.state.name = { status: 2, latestOwner: f.op.operator, expiry: BigInt(f.op.expiry) };
    expect(await f.plan()).toMatchObject({ stage: 'complete', status: 'state-matches-config', transactions: [] });
  });

  it('accepts unrelated active members instead of requiring an owner-controlled bootstrap roster', async () => {
    const f = fixture();
    f.state.entries = [[toHex('bob', { size: 32 }), addr(90), now + 86400n, true, addr(90)]];
    expect((await f.plan()).stage).toBe('deploy-operator-resolver');
  });

  it('refuses bans and a full active list before preparing any gas-spending step', async () => {
    for (const key of ['operatorBlocked', 'labelBlocked']) {
      const f = fixture(); f.state[key] = true;
      await expect(f.plan()).rejects.toThrow(/blocked/); expect(f.calls).toHaveLength(0);
    }
    const f = fixture(); f.state.entries = Array.from({ length: 128 }, (_, i) => [toHex(`member${i}`, { size: 32 }), addr(90), now + 86400n, true, addr(90)]);
    await expect(f.plan()).rejects.toThrow(/128 operator slots/); expect(f.calls).toHaveLength(0);
    f.state.entries[10][3] = false; f.state.deployed = f.state.granted = true;
    const recovered = await f.plan();
    expect(recovered.registrationSlot).toBe(10);
    const mint = decodeFunctionData({ abi: build.artifact.abi, data: recovered.transactions[0].walletRequest.params[0].data });
    expect(mint.functionName).toBe('registerInSlot'); expect(mint.args[0]).toBe(10n);
  });

  it('fails closed on changed parent attachment, runtime, roles and protected records', async () => {
    for (const mutate of [f => { f.snapshot.parent.subregistry = addr(99); }, f => { f.state.code = '0x6000'; },
      f => { f.state.additionalRoot = 1n; }, f => { f.state.deployed = true; f.state.alteredRecord = true; },
      f => { f.state.deployed = true; f.state.extraScoped = true; },
      f => { f.config.operators[0].expiry = Number(now + 31n * 86400n); }]) {
      const f = fixture(); mutate(f); await expect(f.plan()).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    }
  });

  it('allows a previously removed, expired name only after both persistent bans are explicitly cleared', async () => {
    const f = fixture();
    f.state.entries = [[toHex('alice', { size: 32 }), f.op.operator, now - 1n, false, f.op.payee]];
    f.state.labelBlocked = true;
    await expect(f.plan()).rejects.toThrow(/blocked/);
    f.state.labelBlocked = false; f.state.deployed = f.state.granted = true;
    expect((await f.plan()).stage).toBe('register-operator');
  });

  it('requires a single operator-controlled resolver and exact immutable review inputs', () => {
    for (const mutate of [c => { c.privateKey = 'not-accepted'; }, c => { c.operators.push(c.operators[0]); },
      c => { c.operators[0].coldOwner = addr(99); }, c => { c.directory.registrar.codeHash = toHex(0, { size: 32 }); },
      c => { c.directory.registrar.extra = 'not-accepted'; }, c => { c.kind = 'another'; }]) {
      const c = fixture().config; mutate(c); expect(() => validateJoinConfig(c)).toThrow();
    }
    const c = fixture().config, changed = JSON.parse(json(c)); changed.operators[0].endpoint = 'https://different.example';
    expect(() => checkJoinIdentity(c, changed)).toThrow(/changed/);
    expect(() => expectedJoinTransaction({ id: 'attach-subregistry' }, c, { resolvers: {} }, build)).toThrow(/Unrecognized/);
  });

  it('does not publish directory pins for local, incomplete or unsigned enrollment evidence', () => {
    const c = fixture().config;
    const manifest = { kind: 'derpc-ens-operator-enrollment', chainId: 1, localOnly: false, directory: c.directory,
      verification: { receipts: true, canonicalBlocks: true, operatorSigned: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 } };
    expect(enrollmentPins(manifest)).toEqual(c.directory);
    for (const mutate of [m => { m.localOnly = true; }, m => { m.verification.operatorSigned = false; }, m => { m.verification.minimumConfirmations = 11; }]) {
      const copy = structuredClone(manifest); mutate(copy); expect(() => enrollmentPins(copy)).toThrow();
    }
  });
});
