import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';
import { closeAuthorizationTypedData, readAuthorizationTypedData, voucherTypedData } from '../../payments/src/protocol.ts';

// Ephemeral accounts on a fresh in-memory chain. No public deployment or funded key is used.
const chainId = 31337;
const sessionKey = privateKeyToAccount(`0x${'71'.repeat(32)}`);
const wrongKey = privateKeyToAccount(`0x${'72'.repeat(32)}`);
const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
let rpc, client, wallet, operator, receiver, escrow, artifacts, snapshot;

const attacker = { 'AdversarialRecipient.sol': { content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract AdversarialRecipient {
    bool public rejectPayment;
    bool public attack;
    bool public attempted;
    bool public attackSucceeded;
    address public target;
    bytes public payload;
    function configure(bool reject_, address target_, bytes calldata payload_) external {
        rejectPayment = reject_; target = target_; payload = payload_; attack = payload_.length != 0;
    }
    function invoke(address to, bytes calldata data) external payable returns (bytes memory result) {
        (bool ok, bytes memory returned) = to.call{value:msg.value}(data);
        require(ok, "inner call rejected"); return returned;
    }
    receive() external payable {
        if (rejectPayment) revert("recipient rejects payment");
        if (attack) {
            attempted = true;
            (attackSucceeded,) = target.call{value:1}(payload);
        }
    }
}` } };

const artifact = name => Object.values(artifacts).flatMap(file => Object.entries(file)).find(([key]) => key === name)[1];
const data = (name, functionName, args = []) => encodeFunctionData({ abi: artifact(name).abi, functionName, args });
const read = (address, name, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args });
async function write(signer, address, name, functionName, args = [], value) {
  const hash = await signer.writeContract({ address, abi: artifact(name).abi, functionName, args, value, chain: null, gas: 1_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('transaction reverted');
  return receipt;
}
async function deploy(name) {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: `0x${a.evm.bytecode.object}`, chain: null });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress;
}
async function open(amount = 1000n, payee = operator.account.address) {
  const id = await read(escrow, 'QueryEscrow', 'nextSessionId');
  await write(wallet, escrow, 'QueryEscrow', 'open', [payee, sessionKey.address], amount);
  return id;
}
const domain = () => ({ chainId, escrow });
const voucher = (id, amount) => sessionKey.signTypedData(voucherTypedData(domain(), id, amount));

beforeAll(async () => {
  artifacts = compile(attacker);
  rpc = ganache.provider({ chain: { chainId, hardfork: 'shanghai' }, miner: { timestampIncrement: 0 }, logging: { quiet: true }, wallet: { totalAccounts: 3 } });
  const accounts = Object.values(rpc.getInitialAccounts()).map(account => privateKeyToAccount(account.secretKey));
  const transport = custom(rpc, { retryCount: 0 });
  client = createPublicClient({ transport, pollingInterval: 10, cacheTime: 0 });
  [wallet, operator, receiver] = accounts.map(account => createWalletClient({ account, transport }));
  escrow = await deploy('QueryEscrow');
  snapshot = await rpc.request({ method: 'evm_snapshot', params: [] });
}, 30000);
beforeEach(async () => {
  await rpc.request({ method: 'evm_revert', params: [snapshot] });
  snapshot = await rpc.request({ method: 'evm_snapshot', params: [] });
});
afterAll(async () => { await rpc?.disconnect(); });

describe('escrow adversarial settlement', () => {
  it('cannot redeem a signed read or close intent as a payment voucher', async () => {
    const id = await open();
    const deadline = Number((await read(escrow, 'QueryEscrow', 'sessions', [id]))[4]) - 600;
    const readSignature = await sessionKey.signTypedData(readAuthorizationTypedData(domain(), {
      sessionId: id, readId: `0x${'ab'.repeat(32)}`, kind: 'proof', price: 100n, deadline,
    }));
    const closeSignature = await sessionKey.signTypedData(closeAuthorizationTypedData(domain(), { sessionId: id, amount: 100n, deadline }));
    for (const signature of [readSignature, closeSignature]) {
      await expect(write(operator, escrow, 'QueryEscrow', 'close', [id, 100n, signature])).rejects.toThrow();
    }
    expect(await client.getBalance({ address: escrow })).toBe(1000n);
    await write(operator, escrow, 'QueryEscrow', 'close', [id, 100n, await voucher(id, 100n)]);
    expect(await client.getBalance({ address: escrow })).toBe(0n);
  });

  it('rejects malformed, high-s and foreign-key signatures without consuming a live session', async () => {
    const id = await open();
    const signature = await voucher(id, 100n);
    const r = signature.slice(2, 66), s = BigInt(`0x${signature.slice(66, 130)}`), v = parseInt(signature.slice(130), 16);
    const highS = `0x${r}${(curveOrder - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
    const malformed = [
      '0x', signature.slice(0, -2), signature + '00', `0x${r}${'0'.repeat(64)}1b`,
      signature.slice(0, -2) + '00', signature.slice(0, -2) + '1d', highS,
      await wrongKey.signTypedData(voucherTypedData(domain(), id, 100n)),
    ];
    for (const invalid of malformed) await expect(write(operator, escrow, 'QueryEscrow', 'close', [id, 100n, invalid])).rejects.toThrow();
    expect((await read(escrow, 'QueryEscrow', 'sessions', [id]))[5]).toBe(false);
    expect(await client.getBalance({ address: escrow })).toBe(1000n);
    await write(operator, escrow, 'QueryEscrow', 'close', [id, 100n, signature]);
  });

  it('conserves funds when both recipients reject payment and lets each withdraw only its credit', async () => {
    const payerContract = await deploy('AdversarialRecipient');
    const operatorContract = await deploy('AdversarialRecipient');
    for (const recipient of [payerContract, operatorContract]) await write(wallet, recipient, 'AdversarialRecipient', 'configure', [true, escrow, '0x']);
    const id = await read(escrow, 'QueryEscrow', 'nextSessionId');
    await write(wallet, payerContract, 'AdversarialRecipient', 'invoke', [escrow, data('QueryEscrow', 'open', [operatorContract, sessionKey.address])], 1000n);
    await write(wallet, operatorContract, 'AdversarialRecipient', 'invoke', [escrow, data('QueryEscrow', 'close', [id, 300n, await voucher(id, 300n)])]);
    expect(await read(escrow, 'QueryEscrow', 'pendingWithdrawals', [payerContract])).toBe(700n);
    expect(await read(escrow, 'QueryEscrow', 'pendingWithdrawals', [operatorContract])).toBe(300n);
    expect(await client.getBalance({ address: escrow })).toBe(1000n);
    await expect(write(receiver, escrow, 'QueryEscrow', 'withdraw', [receiver.account.address])).rejects.toThrow();
    // A failed destination must restore the whole credit rather than silently burn it.
    await expect(write(wallet, payerContract, 'AdversarialRecipient', 'invoke', [escrow, data('QueryEscrow', 'withdraw', [payerContract])])).rejects.toThrow();
    expect(await read(escrow, 'QueryEscrow', 'pendingWithdrawals', [payerContract])).toBe(700n);
    const before = await client.getBalance({ address: receiver.account.address });
    for (const recipient of [payerContract, operatorContract]) {
      await write(wallet, recipient, 'AdversarialRecipient', 'invoke', [escrow, data('QueryEscrow', 'withdraw', [receiver.account.address])]);
      await expect(write(wallet, recipient, 'AdversarialRecipient', 'invoke', [escrow, data('QueryEscrow', 'withdraw', [receiver.account.address])])).rejects.toThrow();
    }
    expect(await client.getBalance({ address: receiver.account.address })).toBe(before + 1000n);
    expect(await client.getBalance({ address: escrow })).toBe(0n);
  });

  it('does not allow recipient callbacks to mutate another escrow session during settlement', async () => {
    const operatorContract = await deploy('AdversarialRecipient');
    await write(wallet, operatorContract, 'AdversarialRecipient', 'configure', [false, escrow, data('QueryEscrow', 'open', [operator.account.address, sessionKey.address])]);
    const id = await open(1000n, operatorContract);
    const nextBefore = await read(escrow, 'QueryEscrow', 'nextSessionId');
    await write(wallet, operatorContract, 'AdversarialRecipient', 'invoke', [escrow, data('QueryEscrow', 'close', [id, 300n, await voucher(id, 300n)])]);
    expect(await read(operatorContract, 'AdversarialRecipient', 'attempted')).toBe(true);
    expect(await read(operatorContract, 'AdversarialRecipient', 'attackSucceeded')).toBe(false);
    expect(await read(escrow, 'QueryEscrow', 'nextSessionId')).toBe(nextBefore);
    expect(await client.getBalance({ address: operatorContract })).toBe(300n);
    expect(await client.getBalance({ address: escrow })).toBe(0n);
  });

  it('enforces a disjoint close/refund boundary at the exact timeout', async () => {
    const first = await open(), second = await open();
    const deadline = (await read(escrow, 'QueryEscrow', 'sessions', [first]))[4];
    await rpc.request({ method: 'evm_mine', params: [Number(deadline) - 1] });
    expect((await client.getBlock()).timestamp).toBe(deadline - 1n);
    await expect(write(wallet, escrow, 'QueryEscrow', 'refund', [second])).rejects.toThrow();
    await write(operator, escrow, 'QueryEscrow', 'close', [first, 100n, await voucher(first, 100n)]);
    await rpc.request({ method: 'evm_mine', params: [Number(deadline)] });
    expect((await client.getBlock()).timestamp).toBe(deadline);
    await expect(write(operator, escrow, 'QueryEscrow', 'close', [second, 100n, await voucher(second, 100n)])).rejects.toThrow();
    await expect(write(wallet, escrow, 'QueryEscrow', 'topUp', [second], 1n)).rejects.toThrow();
    await write(wallet, escrow, 'QueryEscrow', 'refund', [second]);
    expect(await client.getBalance({ address: escrow })).toBe(0n);
  });
});
