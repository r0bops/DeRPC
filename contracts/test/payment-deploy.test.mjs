import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { administrativeClient, escrowBuild, prepareDeployment, validatePlan, verifyDeployment } from '../scripts/payment-deploy.mjs';

let rpc, client, wallet, build, plan, transactionHash;
beforeAll(async () => {
  build = escrowBuild();
  rpc = ganache.provider({ chain: { chainId: 31337, hardfork: 'shanghai' }, logging: { quiet: true }, wallet: { totalAccounts: 1 } });
  const account = privateKeyToAccount(Object.values(rpc.getInitialAccounts())[0].secretKey);
  const transport = custom(rpc, { retryCount: 0 });
  client = createPublicClient({ transport, pollingInterval: 10 });
  wallet = createWalletClient({ transport, account });
  plan = await prepareDeployment({ chainId: 31337, from: account.address, client, local: true, build });
  transactionHash = await wallet.deployContract({ abi: build.artifact.abi, bytecode: build.creationBytecode, chain: null });
  await client.waitForTransactionReceipt({ hash: transactionHash });
}, 30000);
afterAll(async () => { await rpc?.disconnect(); });

const verify = (overrides = {}, args = {}) => verifyDeployment({ plan, transactionHash, client: { ...client, ...overrides }, confirmations: 1, local: true, build, ...args });

describe('reviewed test-payment deployment workflow', () => {
  it('prepares an unsigned creation request and labels sampled costs as administrative observations', () => {
    expect(plan.walletRequest).toMatchObject({ method: 'eth_sendTransaction', params: [{ value: '0x0', chainId: '0x7a69', data: build.creationBytecode }] });
    expect(plan.walletRequest.params[0].to).toBeUndefined();
    expect(plan.preflight.trust).toContain('not light-client verified');
    expect(BigInt(plan.preflight.estimatedGas)).toBeGreaterThan(0n);
  });

  it('exports an exact-code manifest only after a successful creation receipt', async () => {
    const manifest = await verify();
    expect(manifest).toMatchObject({ schemaVersion: 1, kind: 'derpc-query-escrow', testPayments: true, localOnly: true, chainId: 31337, codeHash: build.codeHash, sourceHash: build.sourceHash });
    expect(manifest.verification).toMatchObject({ receipt: true, creationInput: true, runtimeCode: true, confirmations: '1' });
    expect(manifest.escrow).toMatch(/^0x[\da-fA-F]{40}$/);
    expect(BigInt(manifest.transactionFeeWei)).toBe(BigInt(manifest.gasUsed) * BigInt(manifest.effectiveGasPriceWei));
  });

  it('refuses real-fund chains, remote local mode, wrong RPC chain and insufficient confirmations', async () => {
    await expect(prepareDeployment({ chainId: 1, from: wallet.account.address, build })).rejects.toThrow('test funds only');
    await expect(prepareDeployment({ chainId: 560048, from: wallet.account.address, local: true, build })).rejects.toThrow('test funds only');
    expect(() => administrativeClient('https://rpc.example', true)).toThrow('loopback');
    expect(() => administrativeClient('http://rpc.example')).toThrow('HTTPS');
    await expect(verify({ getChainId: async () => 1 })).rejects.toThrow('chain');
    await expect(verify({}, { confirmations: 12 })).rejects.toThrow('12 confirmations');
    await expect(verify({}, { local: false })).rejects.toThrow('test funds only');
  });

  it('rejects altered source, creation bytecode or network in the reviewed plan', () => {
    expect(() => validatePlan({ ...plan, sourceHash: '0x' + '00'.repeat(32) }, build, true)).toThrow('source differs');
    const changed = structuredClone(plan);
    changed.walletRequest.params[0].data = '0x00';
    expect(() => validatePlan(changed, build, true)).toThrow('transaction differs');
    changed.walletRequest.params[0] = { ...plan.walletRequest.params[0], chainId: '0x1' };
    expect(() => validatePlan(changed, build, true)).toThrow('transaction differs');
  });

  it('refuses a failed receipt or a receipt pointing at a different creation address', async () => {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    await expect(verify({ getTransactionReceipt: async () => ({ ...receipt, status: 'reverted' }) })).rejects.toThrow('successful');
    await expect(verify({ getTransactionReceipt: async () => ({ ...receipt, contractAddress: wallet.account.address }) })).rejects.toThrow('not derived');
  });

  it('rejects wrong deployer, init code, canonical block or deployed runtime', async () => {
    const transaction = await client.getTransaction({ hash: transactionHash });
    await expect(verify({ getTransaction: async () => ({ ...transaction, input: '0x00' }) })).rejects.toThrow('creation transaction differs');
    await expect(verify({ getTransaction: async () => ({ ...transaction, from: '0x' + '11'.repeat(20) }) })).rejects.toThrow('creation transaction differs');
    await expect(verify({ getBlock: async args => ({ ...await client.getBlock(args), hash: '0x' + 'ab'.repeat(32) }) })).rejects.toThrow('canonical');
    await expect(verify({ getBytecode: async () => '0x00' })).rejects.toThrow('runtime differs');
  });
});
