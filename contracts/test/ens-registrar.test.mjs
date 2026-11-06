import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';

let rpc, client, wallets, artifacts, registry, registrar;
const extra = { 'ENSLeaseTest.sol': { content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract ENSLeaseTest {
    mapping(uint256 => uint64) public expiry;
    bool public reject;
    function setReject(bool value) external { reject = value; }
    function register(string calldata label,address,address,address,uint256,uint64 until) external returns(uint256 id) {
        require(!reject, "registry rejected"); id = uint256(keccak256(bytes(label)));
        require(expiry[id] <= block.timestamp, "still registered"); expiry[id] = until;
    }
    function renew(uint256 id,uint64 until) external { require(!reject, "registry rejected"); require(until > expiry[id]); expiry[id] = until; }
}` } };
const artifact = name => Object.values(artifacts).flatMap(file => Object.entries(file)).find(([key]) => key === name)[1];
const read = (address, name, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args });
async function write(wallet, address, name, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('local transaction reverted');
  return receipt;
}
async function deploy(name, args = []) {
  const a = artifact(name);
  return (await client.waitForTransactionReceipt({ hash: await wallets[0].deployContract({ abi: a.abi, bytecode: `0x${a.evm.bytecode.object}`, args, chain: null }) })).contractAddress;
}
beforeAll(async () => {
  artifacts = compile(extra);
  rpc = ganache.provider({ chain: { chainId: 31337, hardfork: 'shanghai' }, logging: { quiet: true }, wallet: { totalAccounts: 3 } });
  client = createPublicClient({ transport: custom(rpc, { retryCount: 0 }), pollingInterval: 10 });
  wallets = Object.values(rpc.getInitialAccounts()).map(account => createWalletClient({ account: privateKeyToAccount(account.secretKey), transport: custom(rpc, { retryCount: 0 }) }));
  registry = await deploy('ENSLeaseTest');
  registrar = await deploy('OperatorRegistrar', [registry, wallets[0].account.address]);
}, 30000);
afterAll(async () => { await rpc?.disconnect(); });

describe('registrar lease lifecycle', () => {
  it('rolls back the proofable list when the external ENS registration rejects', async () => {
    const expiry = Number((await client.getBlock()).timestamp) + 3600;
    await write(wallets[0], registry, 'ENSLeaseTest', 'setReject', [true]);
    await expect(write(wallets[0], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[1].account.address, registry, wallets[1].account.address, expiry])).rejects.toThrow();
    expect(await read(registrar, 'OperatorRegistrar', 'operatorCount')).toBe(0n);
    await write(wallets[0], registry, 'ENSLeaseTest', 'setReject', [false]);
    await write(wallets[0], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[1].account.address, registry, wallets[1].account.address, expiry]);
    expect(await read(registrar, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
  });

  it('cannot reuse a removed name until its actual ENS lease expires', async () => {
    const expiry = Number((await client.getBlock()).timestamp) + 7200;
    await write(wallets[0], registrar, 'OperatorRegistrar', 'remove', [0n]);
    await expect(write(wallets[0], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[2].account.address, registry, wallets[2].account.address, expiry])).rejects.toThrow();
    await expect(write(wallets[1], registrar, 'OperatorRegistrar', 'setPayee', [0n, wallets[2].account.address])).rejects.toThrow();
    await rpc.request({ method: 'evm_increaseTime', params: [3601] }); await rpc.request({ method: 'evm_mine', params: [] });
    const renewedExpiry = Number((await client.getBlock()).timestamp) + 3600;
    await write(wallets[0], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[2].account.address, registry, wallets[2].account.address, renewedExpiry]);
    expect(await read(registrar, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
    const entry = await read(registrar, 'OperatorRegistrar', 'operators', [0n]);
    expect(entry[0]).toBe(toHex('alice', { size: 32 })); expect(entry[3]).toBe(true);
    expect(entry[1].toLowerCase()).toBe(wallets[2].account.address.toLowerCase());
    await expect(write(wallets[1], registrar, 'OperatorRegistrar', 'renew', [0n, renewedExpiry + 100])).rejects.toThrow();
    await expect(write(wallets[1], registrar, 'OperatorRegistrar', 'setPayee', [0n, wallets[1].account.address])).rejects.toThrow();
  });

  it('rolls back the authenticated expiry when ENS renewal rejects', async () => {
    const before = await read(registrar, 'OperatorRegistrar', 'operators', [0n]);
    await write(wallets[0], registry, 'ENSLeaseTest', 'setReject', [true]);
    await expect(write(wallets[2], registrar, 'OperatorRegistrar', 'renew', [0n, Number(before[2]) + 100])).rejects.toThrow();
    expect((await read(registrar, 'OperatorRegistrar', 'operators', [0n]))[2]).toBe(before[2]);
  });
});
