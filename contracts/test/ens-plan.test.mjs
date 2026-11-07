import { describe, it, expect, beforeAll } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, getContractAddress, toHex, zeroAddress } from 'viem';
import { addresses, curatorRoles, deploymentSalt, factoryAbi, labelId, operatorRecords, registrarRoles, registryAbi, resolverAbi, resolverOwnerRoles, roles, textAbi, validateConfig } from '../scripts/ens-common.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { expectedTransaction } from '../scripts/ens-verify.mjs';

const addr = n => toHex(n, { size: 20 });
const time = 1800000000;
const config = () => ({ schemaVersion: 1, chainId: 1, parentName: 'derpc.eth', deploymentId: 'local-test', curator: addr(1), deployer: addr(2), operators: [3, 10].map((n, i) => ({ label: ['alice', 'bob'][i], operator: addr(n), coldOwner: addr(n + 1), hotKey: addr(n + 2), signer: addr(n + 3), payee: addr(n), endpoint: `https://${['alice', 'bob'][i]}.example/rpc`, caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'] }, expiry: time + 86400 })) });
let build;
beforeAll(() => { build = registrarBuild(); }, 30000);

function firstStageClient(c, deployed = false) {
  const subregistry = addr(50), resolvers = { alice: addr(51), bob: addr(52) };
  const bySalt = new Map([[deploymentSalt(c, 'registry'), subregistry], ...c.operators.map(op => [deploymentSalt(c, `resolver:${op.label}`), resolvers[op.label]])]);
  const client = {
    readContract: async ({ functionName, args }) => {
      if (functionName === 'hasRoles') return true;
      if (functionName === 'predictProxyAddress') return bySalt.get(args[1]);
      if (functionName === 'verifyContract') return args[0] === subregistry ? addresses.UserRegistryImpl : addresses.PermissionedResolverImpl;
      throw new Error(`Unexpected read ${functionName}`);
    },
    getBytecode: async ({ address }) => deployed && [subregistry, ...Object.values(resolvers)].includes(address) ? '0x01' : '0x',
    getTransactionCount: async () => 9,
    estimateGas: async () => 200000n,
  };
  const snapshot = { chainId: 1, blockNumber: '100', blockHash: toHex(100, { size: 32 }), timestamp: time, parent: { expiry: time + 365 * 86400, subregistry: zeroAddress } };
  return { client, snapshot, subregistry, resolvers };
}

function registrationStageClient(c, { blockedOperator, blockedLabel, entries = [] } = {}) {
  c.registrar = { address: getContractAddress({ from: c.deployer, nonce: 9n }), nonce: 9 };
  const mock = firstStageClient(c, true), baseRead = mock.client.readContract;
  mock.snapshot.parent.subregistry = mock.subregistry;
  mock.gasRequests = [];
  mock.client.estimateGas = async request => { mock.gasRequests.push(request); return 200000n; };
  mock.client.getBytecode = async ({ address }) => address === c.registrar.address
    ? `0x${build.artifact.evm.deployedBytecode.object}`
    : [mock.subregistry, ...Object.values(mock.resolvers)].includes(address) ? '0x01' : '0x';
  mock.client.readContract = async request => {
    const { address, functionName, args = [] } = request;
    if (['hasRoles', 'predictProxyAddress', 'verifyContract'].includes(functionName)) return baseRead(request);
    if (address === c.registrar.address) {
      if (functionName === 'registry') return mock.subregistry;
      if (functionName === 'curator') return c.curator;
      if (functionName === 'operatorCount') return BigInt(entries.length);
      if (functionName === 'operators') return entries[Number(args[0])];
      if (functionName === 'operatorBlocked') return args[0] === blockedOperator;
      if (functionName === 'labelBlocked') return args[0] === blockedLabel;
    }
    if (address === mock.subregistry) {
      if (functionName === 'roles') return args[1] === c.curator ? curatorRoles : registrarRoles;
      if (functionName === 'roleCount') return args[0] === 0n ? curatorRoles + registrarRoles : 0n;
      if (functionName === 'getParent') return [addresses.ETHRegistry, 'derpc'];
      if (functionName === 'getState') {
        const op = c.operators.find(op => labelId(op.label) === args[0]);
        const entry = entries.find(entry => entry[0] === toHex(op.label, { size: 32 }));
        return entry ? { status: 2, latestOwner: op.operator, expiry: entry[2] } : { status: 0 };
      }
      if (functionName === 'getResolver') return mock.resolvers[args[0]];
    }
    const op = c.operators.find(op => mock.resolvers[op.label] === address);
    if (op) {
      if (functionName === 'roles') return args[0] === 0n
        ? args[1] === op.coldOwner ? resolverOwnerRoles : 0n
        : args[1] === op.hotKey && args[0] === labelId('derpc.endpoint') ? roles.text : 0n;
      if (functionName === 'roleCount') return args[0] === 0n ? resolverOwnerRoles : args[0] === labelId('derpc.endpoint') ? roles.text : 0n;
      if (functionName === 'resolve') {
        const key = decodeFunctionData({ abi: textAbi, data: args[1] }).args[1];
        return encodeFunctionResult({ abi: textAbi, functionName: 'text', result: operatorRecords(op)[key] ?? '' });
      }
    }
    throw new Error(`Unexpected registration read ${functionName}`);
  };
  return mock;
}

describe('ENS deployment review', () => {
  it('requires real public configuration and rejects secret fields or broad hot-key identities', () => {
    for (const mutate of [
      c => { c.curator = null; }, c => { c.privateKey = 'not-accepted'; },
      c => { c.operators[1].label = c.operators[0].label; },
      c => { c.operators[0].label = 'ab--cd'; }, // ENS normalization refuses hyphens in the third and fourth places
      c => { c.operators[0].hotKey = c.operators[1].coldOwner; },
      c => { c.operators[0].hotKey = c.operators[0].operator; },
      c => { c.operators[0].endpoint = 'https://user:secret@rpc.example'; },
      c => { c.operators[0].endpoint = 'http://rpc.example'; },
      c => { c.operators[0].endpoint = `http://${'a'.repeat(56)}.onion`; },
      c => { c.operators[0].caps.beacon = true; },
      c => { c.operators[0].caps.methods.push('eth_call'); },
    ]) { const c = config(); mutate(c); expect(() => validateConfig(c)).toThrow(); }
  });

  it('will not publish an arbitrary or local payment contract as a paid mainnet operator', () => {
    const c = config(); c.operators[0].payment = { priceWei: '1', deployment: { chainId: 1, escrow: addr(90) } };
    expect(() => validateConfig(c)).toThrow(/receipt-checked/);
    c.operators[0].payment.deployment = { kind: 'derpc-query-escrow', testPayments: true, localOnly: false, chainId: 560048, escrow: addr(90), transactionHash: toHex(1, { size: 32 }), codeHash: toHex(2, { size: 32 }), verification: { receipt: true, creationInput: true, runtimeCode: true, confirmations: '12' } };
    expect(operatorRecords(validateConfig(c).operators[0])).toMatchObject({ 'derpc.price': '1', 'derpc.payee': addr(3), 'derpc.paymentChain': '560048', 'derpc.escrow': addr(90) });
    c.operators[0].payment.deployment.localOnly = true;
    expect(() => validateConfig(c)).toThrow(/receipt-checked/);
  });

  it('prepares independent proxy transactions with no transfer, unregister, upgrade or hot-key root roles', async () => {
    const c = config(), mock = firstStageClient(c);
    const plan = await preparePlan({ config: c, ...mock, build });
    expect(plan.stage).toBe('deploy-ens-proxies'); expect(plan.transactions).toHaveLength(3);
    const deployments = plan.transactions.map(item => decodeFunctionData({ abi: factoryAbi, data: item.walletRequest.params[0].data }));
    expect(deployments[0].args[0].toLowerCase()).toBe(addresses.UserRegistryImpl.toLowerCase());
    const registryInit = decodeFunctionData({ abi: registryAbi, data: deployments[0].args[2] });
    expect(registryInit.args[0]).toEqual([{ account: c.curator, roleBitmap: curatorRoles }]);
    for (let i = 0; i < 2; i++) {
      const initialization = decodeFunctionData({ abi: resolverAbi, data: deployments[i + 1].args[2] });
      expect(initialization.args[0]).toEqual([{ account: c.operators[i].coldOwner, roleBitmap: resolverOwnerRoles }]);
      expect(initialization.args[1].map(data => decodeFunctionData({ abi: resolverAbi, data }).functionName)).toEqual(['setText', 'setText', 'setText']);
    }
    expect(deployments[1].args[1]).not.toBe(deployments[2].args[1]);
    for (const item of plan.transactions) expect(item.walletRequest.params[0]).toMatchObject({ value: '0x0', chainId: '0x1', from: c.deployer });
  });

  it('reruns past existing proxies and fixes an explicit registrar nonce without replaying deployments', async () => {
    const c = config(), mock = firstStageClient(c, true);
    const plan = await preparePlan({ config: c, ...mock, build });
    expect(plan.stage).toBe('deploy-registrar'); expect(plan.transactions).toHaveLength(1);
    expect(plan.resumeConfig.registrar).toEqual({ address: getContractAddress({ from: c.deployer, nonce: 9n }), nonce: 9 });
    expect(plan.transactions[0].walletRequest.params[0].nonce).toBe('0x9');
    const replay = await preparePlan({ config: plan.resumeConfig, ...mock, build });
    expect(replay.transactions).toEqual(plan.transactions);
    mock.client.getTransactionCount = async () => 10;
    await expect(preparePlan({ config: plan.resumeConfig, ...mock, build })).rejects.toThrow(/nonce changed/);
  });

  it('stops before preparing mutations if the parent is attached elsewhere, permissions are missing, or the lease is invalid', async () => {
    const c = config(), mock = firstStageClient(c);
    mock.snapshot.parent.subregistry = addr(99);
    await expect(preparePlan({ config: c, ...mock, build })).rejects.toThrow(/another subregistry/);
    mock.snapshot.parent.subregistry = zeroAddress;
    c.operators[0].expiry = time + 31 * 86400;
    await expect(preparePlan({ config: c, ...mock, build })).rejects.toThrow(/30 days/);
    c.operators[0].expiry = time + 86400;
    const original = mock.client.readContract;
    mock.client.readContract = options => options.functionName === 'hasRoles' ? false : original(options);
    await expect(preparePlan({ config: c, ...mock, build })).rejects.toThrow(/authority/);
  });

  it('receipt reconstruction permits only reviewed calldata and rejects unknown privileged actions', async () => {
    const c = config(), mock = firstStageClient(c);
    const plan = await preparePlan({ config: c, ...mock, build });
    for (const item of plan.transactions) expect(expectedTransaction(item, plan.resumeConfig, plan, build)).toEqual(item.walletRequest.params[0]);
    expect(() => expectedTransaction({ id: 'grant-all-roles' }, c, plan, build)).toThrow(/Unrecognized/);
  });

  it('prepares each registration from its distinct operator and reconstructs that sender independently of the plan', async () => {
    const c = validateConfig(config()), mock = registrationStageClient(c);
    const plan = await preparePlan({ config: c, ...mock, build });
    expect(plan.stage).toBe('register-or-renew-operators');
    expect(plan.transactions.map(item => item.id)).toEqual(['register-alice', 'register-bob']);
    for (const [index, item] of plan.transactions.entries()) {
      const op = c.operators[index], tx = item.walletRequest.params[0];
      expect(tx.from).toBe(op.operator); expect(tx.from).not.toBe(c.curator);
      expect(mock.gasRequests[index].account).toBe(op.operator);
      expect(decodeFunctionData({ abi: build.artifact.abi, data: tx.data }).args).toEqual([op.label, op.operator, mock.resolvers[op.label], op.payee, BigInt(op.expiry)]);
      expect(expectedTransaction(item, c, plan, build)).toEqual(tx);
      const forged = structuredClone(item); forged.walletRequest.params[0].from = c.curator;
      expect(expectedTransaction(forged, c, plan, build).from).toBe(op.operator);
      expect(expectedTransaction(forged, c, plan, build)).not.toEqual(forged.walletRequest.params[0]);
    }
  });

  it.each(['operator', 'label'])('refuses an unregistered %s blocked by curator moderation without preparing an unban', async kind => {
    const c = validateConfig(config()), op = c.operators[0];
    const mock = registrationStageClient(c, kind === 'operator'
      ? { blockedOperator: op.operator } : { blockedLabel: toHex(labelId(op.label), { size: 32 }) });
    await expect(preparePlan({ config: c, ...mock, build })).rejects.toThrow(new RegExp(`blocked by curator moderation \\(${kind}\\)`));
    expect(mock.gasRequests).toHaveLength(0);
  });

  it('does not treat a future-registration ban as revocation of an existing active listing', async () => {
    const c = validateConfig(config());
    const entries = c.operators.map(op => [toHex(op.label, { size: 32 }), op.operator, BigInt(op.expiry), true, op.payee]);
    const mock = registrationStageClient(c, { entries, blockedOperator: c.operators[0].operator, blockedLabel: toHex(labelId(c.operators[0].label), { size: 32 }) });
    const plan = await preparePlan({ config: c, ...mock, build });
    expect(plan.status).toBe('state-matches-config'); expect(plan.transactions).toEqual([]);
  });

  it('allows unrelated open registrations before and after configured operators register', async () => {
    const c = validateConfig(config());
    const newcomer = [toHex('newcomer', { size: 32 }), addr(80), BigInt(time + 3600), true, addr(80)];
    const before = registrationStageClient(c, { entries: [newcomer] });
    const pending = await preparePlan({ config: c, ...before, build });
    expect(pending.transactions.map(item => item.id)).toEqual(['register-alice', 'register-bob']);
    const entries = [newcomer, ...c.operators.map(op => [toHex(op.label, { size: 32 }), op.operator, BigInt(op.expiry), true, op.payee])];
    const after = registrationStageClient(c, { entries });
    const complete = await preparePlan({ config: c, ...after, build });
    expect(complete.status).toBe('state-matches-config'); expect(complete.transactions).toEqual([]);
    expect(complete.operators.map(op => op.name)).toEqual(['alice.derpc.eth', 'bob.derpc.eth']);
    expect(after.gasRequests).toEqual([]);
    expect(entries[0]).toEqual(newcomer);
  });

  it.each(['operator', 'payee', 'inactive'])('still rejects a configured entry with changed %s alongside unrelated registrations', async field => {
    const c = validateConfig(config());
    const entries = [[toHex('newcomer', { size: 32 }), addr(80), BigInt(time + 3600), true, addr(80)], ...c.operators.map(op => [toHex(op.label, { size: 32 }), op.operator, BigInt(op.expiry), true, op.payee])];
    entries[1][{ operator: 1, payee: 4, inactive: 3 }[field]] = field === 'inactive' ? false : addr(81);
    const mock = registrationStageClient(c, { entries });
    await expect(preparePlan({ config: c, ...mock, build })).rejects.toThrow(/removed or has a conflicting operator\/payee/);
    expect(mock.gasRequests).toEqual([]);
  });
});
