import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, hashTypedData, keccak256, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';

let rpc, client, payer, operator, outsider, escrow, registry, registrar, artifacts;
const signer = privateKeyToAccount('0x' + '19'.repeat(32)); // test-only, never funded outside this in-memory chain
const chainId = 31337;
const extra = { 'TestRegistry.sol': { content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract TestRegistry {
  uint256 public lastRoles;
  uint64 public lastExpiry;
  address public lastOwner;
  mapping(uint256 => uint64) public expiries;
  function register(string calldata label,address owner,address,address,uint256 roles,uint64 expiry) external returns(uint256 id) {
    id=uint256(keccak256(bytes(label))); require(expiries[id] <= block.timestamp,"registered");
    lastRoles=roles; lastOwner=owner; lastExpiry=expiry; expiries[id]=expiry;
  }
  function renew(uint256 id,uint64 expiry) external { require(expiry>expiries[id]); expiries[id]=expiry; lastExpiry=expiry; }
}
contract RejectingPayer {
  function open(address escrow,address operator,address key) external payable returns(bytes memory) {
    (bool ok,bytes memory result)=escrow.call{value:msg.value}(abi.encodeWithSignature("open(address,address)",operator,key)); require(ok); return result;
  }
  receive() external payable { revert(); }
}` } };

const artifact = name => Object.values(artifacts).flatMap(f => Object.entries(f)).find(([n]) => n === name)[1];
async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await payer.deployContract({ abi: a.abi, bytecode: '0x' + a.evm.bytecode.object, args, chain: null });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress;
}
async function write(wallet, address, name, functionName, args = [], value) {
  const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, value, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('transaction reverted');
  return receipt;
}
const read = (address, name, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args });
const typed = (id, amount, contract = escrow, network = chainId) => ({
  domain: { name: 'DeRPC Query Escrow', version: '1', chainId: network, verifyingContract: contract },
  types: { Voucher: [{ name: 'sessionId', type: 'uint256' }, { name: 'amount', type: 'uint256' }] },
  primaryType: 'Voucher', message: { sessionId: id, amount },
});
async function open(amount = 1000000n, wallet = payer) {
  const id = await read(escrow, 'QueryEscrow', 'nextSessionId');
  await write(wallet, escrow, 'QueryEscrow', 'open', [operator.account.address, signer.address], amount);
  return id;
}

beforeAll(async () => {
  artifacts = compile(extra);
  rpc = ganache.provider({ chain: { chainId, hardfork: 'shanghai' }, logging: { quiet: true }, wallet: { totalAccounts: 4 } });
  const accounts = Object.values(rpc.getInitialAccounts()).map(a => privateKeyToAccount(a.secretKey));
  client = createPublicClient({ transport: custom(rpc, { retryCount: 0 }), pollingInterval: 10 });
  [payer, operator, outsider] = accounts.map(account => createWalletClient({ account, transport: custom(rpc, { retryCount: 0 }) }));
  escrow = await deploy('QueryEscrow');
  registry = await deploy('TestRegistry');
  registrar = await deploy('OperatorRegistrar', [registry, payer.account.address]);
}, 30000);
afterAll(async () => { await rpc?.disconnect(); });

describe('QueryEscrow', () => {
  it('settles a signed running total once, refunds the remainder, and matches EIP-712', async () => {
    const id = await open();
    const signature = await signer.signTypedData(typed(id, 300n));
    expect(await read(escrow, 'QueryEscrow', 'voucherDigest', [id, 300n])).toBe(hashTypedData(typed(id, 300n)));
    const before = await client.getBalance({ address: payer.account.address });
    await write(operator, escrow, 'QueryEscrow', 'close', [id, 300n, signature]);
    expect(await client.getBalance({ address: payer.account.address })).toBe(before + 999700n);
    expect((await read(escrow, 'QueryEscrow', 'sessions', [id]))[5]).toBe(true);
    await expect(write(operator, escrow, 'QueryEscrow', 'close', [id, 300n, signature])).rejects.toThrow();
  });

  it('rejects overclaims, unfunded sessions, another caller and signatures for another amount', async () => {
    const id = await open();
    const signature = await signer.signTypedData(typed(id, 100n));
    await expect(write(operator, escrow, 'QueryEscrow', 'close', [id, 101n, signature])).rejects.toThrow();
    await expect(write(outsider, escrow, 'QueryEscrow', 'close', [id, 100n, signature])).rejects.toThrow();
    await expect(write(operator, escrow, 'QueryEscrow', 'close', [999999n, 100n, signature])).rejects.toThrow();
    const excessive = await signer.signTypedData(typed(id, 1000001n));
    await expect(write(operator, escrow, 'QueryEscrow', 'close', [id, 1000001n, excessive])).rejects.toThrow();
  });

  it('binds the chain, escrow and unique session even when a signing key is reused', async () => {
    const first = await open();
    const second = await open();
    for (const payload of [typed(first, 20n), typed(second, 20n, escrow, 1), typed(second, 20n, operator.account.address)]) {
      await expect(write(operator, escrow, 'QueryEscrow', 'close', [second, 20n, await signer.signTypedData(payload)])).rejects.toThrow();
    }
    await write(operator, escrow, 'QueryEscrow', 'close', [second, 20n, await signer.signTypedData(typed(second, 20n))]);
  });

  it('allows only the payer to top up without extending the deadline', async () => {
    const id = await open(100n);
    const original = await read(escrow, 'QueryEscrow', 'sessions', [id]);
    await expect(write(outsider, escrow, 'QueryEscrow', 'topUp', [id], 50n)).rejects.toThrow();
    await write(payer, escrow, 'QueryEscrow', 'topUp', [id], 50n);
    const updated = await read(escrow, 'QueryEscrow', 'sessions', [id]);
    expect(updated[3]).toBe(150n);
    expect(updated[4]).toBe(original[4]);
  });

  it('cannot let a rejecting payer block the operator payment', async () => {
    const rejecting = await deploy('RejectingPayer');
    const id = await read(escrow, 'QueryEscrow', 'nextSessionId');
    await write(payer, rejecting, 'RejectingPayer', 'open', [escrow, operator.account.address, signer.address], 1000n);
    await write(operator, escrow, 'QueryEscrow', 'close', [id, 200n, await signer.signTypedData(typed(id, 200n))]);
    expect(await read(escrow, 'QueryEscrow', 'pendingWithdrawals', [rejecting])).toBe(800n);
  });

  it('refuses early refunds and late settlement, and returns the deposit only to its payer', async () => {
    const id = await open(700n);
    await expect(write(payer, escrow, 'QueryEscrow', 'refund', [id])).rejects.toThrow();
    await rpc.request({ method: 'evm_increaseTime', params: [86401] });
    await rpc.request({ method: 'evm_mine', params: [] });
    await expect(write(operator, escrow, 'QueryEscrow', 'close', [id, 5n, await signer.signTypedData(typed(id, 5n))])).rejects.toThrow();
    await expect(write(outsider, escrow, 'QueryEscrow', 'refund', [id])).rejects.toThrow();
    await write(payer, escrow, 'QueryEscrow', 'refund', [id]);
    await expect(write(payer, escrow, 'QueryEscrow', 'refund', [id])).rejects.toThrow();
  });
});

describe('OperatorRegistrar', () => {
  it('uses a fixed three-slot layout and registers without transfer or resolver roles', async () => {
    const now = Number((await client.getBlock()).timestamp);
    await write(payer, registrar, 'OperatorRegistrar', 'register', ['alice', operator.account.address, registry, operator.account.address, now + 3600]);
    expect(await read(registry, 'TestRegistry', 'lastRoles')).toBe(0n);
    expect(await read(registrar, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
    expect(BigInt(await client.getStorageAt({ address: registrar, slot: toHex(0n, { size: 32 }) }))).toBe(1n);
    const base = BigInt(keccak256(toHex(0n, { size: 32 })));
    expect(await client.getStorageAt({ address: registrar, slot: toHex(base, { size: 32 }) })).toBe(toHex('alice', { size: 32 }));
    const metadata = BigInt(await client.getStorageAt({ address: registrar, slot: toHex(base + 1n, { size: 32 }) }));
    expect(metadata & ((1n << 160n) - 1n)).toBe(BigInt(operator.account.address));
    expect((metadata >> 160n) & ((1n << 64n) - 1n)).toBe(BigInt(now + 3600));
    expect(metadata >> 224n).toBe(1n);
    expect(BigInt(await client.getStorageAt({ address: registrar, slot: toHex(base + 2n, { size: 32 }) }))).toBe(BigInt(operator.account.address));
  });

  it('rejects unauthorized joins, malformed labels and excessive leases', async () => {
    const now = Number((await client.getBlock()).timestamp);
    await expect(write(outsider, registrar, 'OperatorRegistrar', 'register', ['bob', outsider.account.address, registry, outsider.account.address, now + 3600])).rejects.toThrow();
    for (const label of ['Alice', '-bob', 'bob-', 'a.b', '', 'a'.repeat(32)]) {
      await expect(write(payer, registrar, 'OperatorRegistrar', 'register', [label, operator.account.address, registry, operator.account.address, now + 3600])).rejects.toThrow();
    }
    await expect(write(payer, registrar, 'OperatorRegistrar', 'register', ['bob', operator.account.address, registry, zeroAddress, now + 3600])).rejects.toThrow();
    await expect(write(payer, registrar, 'OperatorRegistrar', 'register', ['bob', operator.account.address, registry, operator.account.address, now + 31 * 86400])).rejects.toThrow();
  });

  it('limits renewal and payee updates, and a removed operator cannot renew itself', async () => {
    const now = Number((await client.getBlock()).timestamp);
    await expect(write(outsider, registrar, 'OperatorRegistrar', 'renew', [0n, now + 7200])).rejects.toThrow();
    await write(operator, registrar, 'OperatorRegistrar', 'renew', [0n, now + 7200]);
    await expect(write(outsider, registrar, 'OperatorRegistrar', 'setPayee', [0n, outsider.account.address])).rejects.toThrow();
    await write(operator, registrar, 'OperatorRegistrar', 'setPayee', [0n, outsider.account.address]);
    expect((await read(registrar, 'OperatorRegistrar', 'operators', [0n]))[4].toLowerCase()).toBe(outsider.account.address.toLowerCase());
    await write(payer, registrar, 'OperatorRegistrar', 'remove', [0n]);
    expect((await read(registrar, 'OperatorRegistrar', 'operators', [0n]))[3]).toBe(false);
    await expect(write(operator, registrar, 'OperatorRegistrar', 'renew', [0n, now + 10800])).rejects.toThrow();
  });
});
