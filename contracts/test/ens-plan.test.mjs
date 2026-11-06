import { describe, it, expect, beforeAll } from 'vitest';
import { decodeFunctionData, getContractAddress, toHex, zeroAddress } from 'viem';
import { addresses, curatorRoles, deploymentSalt, factoryAbi, operatorRecords, registryAbi, resolverAbi, resolverOwnerRoles, validateConfig } from '../scripts/ens-common.mjs';
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

describe('ENS deployment review', () => {
  it('requires real public configuration and rejects secret fields or broad hot-key identities', () => {
    for (const mutate of [
      c => { c.curator = null; }, c => { c.privateKey = 'not-accepted'; },
      c => { c.operators[1].label = c.operators[0].label; },
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
});
