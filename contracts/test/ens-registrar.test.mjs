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

describe('registrar curation rules', () => {
  let reg, ens;
  const curator = () => wallets[0], alice = () => wallets[1], bob = () => wallets[2];
  const now = async () => Number((await client.getBlock()).timestamp);
  const skip = async seconds => { await rpc.request({ method: 'evm_increaseTime', params: [seconds] }); await rpc.request({ method: 'evm_mine', params: [] }); };
  const call = (wallet, functionName, args) => write(wallet, reg, 'OperatorRegistrar', functionName, args);
  const list = (label, who, expiry, from = curator()) => call(from, 'register', [label, who.account.address, ens, who.account.address, expiry]);
  const entry = index => read(reg, 'OperatorRegistrar', 'operators', [BigInt(index)]);
  const fresh = async () => { ens = await deploy('ENSLeaseTest'); reg = await deploy('OperatorRegistrar', [ens, curator().account.address]); };

  it('lets only the curator revive a lapsed listing', async () => {
    await fresh();
    await list('alice', alice(), await now() + 3600);
    await skip(86400);
    await expect(call(alice(), 'renew', [0n, await now() + 3600])).rejects.toThrow();
    const expiry = await now() + 3600;
    await call(curator(), 'renew', [0n, expiry]);
    expect(Number((await entry(0))[2])).toBe(expiry);
    await call(alice(), 'renew', [0n, expiry + 3600]); // running again, so the operator may extend it
  });

  it('lets the curator reinstate a removed listing', async () => {
    await fresh();
    await list('alice', alice(), await now() + 3600);
    await expect(call(curator(), 'reinstate', [0n])).rejects.toThrow(); // already active
    await call(curator(), 'remove', [0n, alice().account.address]);
    await expect(call(alice(), 'reinstate', [0n])).rejects.toThrow();
    await call(curator(), 'reinstate', [0n]);
    expect((await entry(0))[3]).toBe(true);
    await call(alice(), 'renew', [0n, await now() + 7200]);
  });

  it('removes an entry only while it is active and held by the expected operator', async () => {
    await fresh();
    await list('alice', alice(), await now() + 3600);
    await expect(call(curator(), 'remove', [0n, bob().account.address])).rejects.toThrow();
    expect((await entry(0))[3]).toBe(true);
    await call(curator(), 'remove', [0n, alice().account.address]);
    expect((await entry(0))[3]).toBe(false);
    await expect(call(curator(), 'remove', [0n, alice().account.address])).rejects.toThrow();
  });

  it('refuses labels that ENS normalization rejects for hyphens in the third and fourth places', async () => {
    await fresh();
    const expiry = await now() + 3600;
    for (const label of ['ab--cd', 'xn--foo', 'ab--']) await expect(list(label, alice(), expiry)).rejects.toThrow();
    for (const label of ['a--b', 'abc--d', 'team-a']) await list(label, alice(), expiry);
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(3n);
  });

  it('gives an expired slot to a new label once the list is full', async () => {
    await fresh();
    const expiry = await now() + 3600;
    for (let i = 0; i < 128; i++) await list(`op${i}`, alice(), expiry);
    const inSlot = (slot, label, who, until, from = curator()) => call(from, 'registerInSlot', [BigInt(slot), label, who.account.address, ens, who.account.address, until]);
    await expect(list('newcomer', bob(), expiry)).rejects.toThrow(); // full
    await expect(inSlot(5, 'newcomer', bob(), expiry)).rejects.toThrow(); // slot 5 is still running
    await skip(7200);
    const later = await now() + 3600;
    await expect(inSlot(5, 'newcomer', bob(), later, bob())).rejects.toThrow(); // curator only
    await expect(inSlot(128, 'newcomer', bob(), later)).rejects.toThrow(); // no such slot
    await inSlot(5, 'newcomer', bob(), later);
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(128n);
    const taken = await entry(5);
    expect(taken[0]).toBe(toHex('newcomer', { size: 32 })); expect(taken[1].toLowerCase()).toBe(bob().account.address.toLowerCase()); expect(taken[3]).toBe(true);
    await expect(inSlot(6, 'newcomer', bob(), later)).rejects.toThrow(); // a label never occupies two slots
    await inSlot(6, 'op5', alice(), later); // the displaced label returns through another expired slot
    expect((await entry(6))[0]).toBe(toHex('op5', { size: 32 }));
    await list('op7', bob(), later); // an existing label still reuses its own slot through register
    expect((await entry(7))[1].toLowerCase()).toBe(bob().account.address.toLowerCase());
  }, 120000);
});
