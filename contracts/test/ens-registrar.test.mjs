import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, getAddress, keccak256, parseEventLogs, stringToHex, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compile } from '../scripts/compile.mjs';

let rpc, client, wallets, artifacts, registry, registrar;
const extra = { 'ENSLeaseTest.sol': { content: `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {OperatorRegistrar} from "./OperatorRegistrar.sol";
interface IERC1155ReceiverTest {
    function onERC1155Received(address,address,uint256,uint256,bytes calldata) external returns(bytes4);
}
contract ENSLeaseTest {
    mapping(uint256 => uint64) public expiry;
    bool public reject;
    bool public callback;
    function setReject(bool value) external { reject = value; }
    function setCallback(bool value) external { callback = value; }
    function register(string calldata label,address owner,address,address,uint256,uint64 until) external returns(uint256 id) {
        require(!reject, "registry rejected"); id = uint256(keccak256(bytes(label)));
        require(expiry[id] <= block.timestamp, "still registered"); expiry[id] = until;
        // Match ENS's ordering: initialize the lease before the ERC1155 receiver callback.
        if (callback && owner.code.length != 0) require(IERC1155ReceiverTest(owner).onERC1155Received(msg.sender,address(0),id,1,"") == IERC1155ReceiverTest.onERC1155Received.selector, "receiver rejected");
    }
    function renew(uint256 id,uint64 until) external { require(!reject, "registry rejected"); require(until > expiry[id]); expiry[id] = until; }
}
contract RegistrationReceiverTest is IERC1155ReceiverTest {
    OperatorRegistrar public immutable registrar;
    address public immutable resolver;
    address public immutable payee;
    bool public immutable reject;
    uint64 public expiry;
    uint256 public mutations;
    uint256 public guarded;
    bool private entered;
    constructor(OperatorRegistrar registrar_,address resolver_,address payee_,bool reject_) {
        registrar = registrar_; resolver = resolver_; payee = payee_; reject = reject_;
    }
    function begin(string calldata label,uint64 until) external { expiry = until; registrar.register(label,address(this),resolver,payee,until); }
    function attempt(bytes memory data) private {
        (bool ok,bytes memory result) = address(registrar).call(data);
        if (ok) mutations++;
        else if (result.length >= 4 && bytes4(result) == OperatorRegistrar.RegistrationInProgress.selector) guarded++;
    }
    function onERC1155Received(address,address,uint256,uint256,bytes calldata) external returns(bytes4) {
        require(msg.sender == resolver);
        if (entered) return IERC1155ReceiverTest.onERC1155Received.selector;
        entered = true;
        attempt(abi.encodeCall(registrar.register,("nested",address(this),resolver,payee,expiry)));
        attempt(abi.encodeCall(registrar.registerInSlot,(0,"nested-slot",address(this),resolver,payee,expiry)));
        attempt(abi.encodeCall(registrar.renew,(0,expiry + 1)));
        attempt(abi.encodeCall(registrar.setPayee,(0,address(this))));
        return reject ? bytes4(0) : IERC1155ReceiverTest.onERC1155Received.selector;
    }
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
    await expect(write(wallets[1], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[1].account.address, registry, wallets[1].account.address, expiry])).rejects.toThrow();
    expect(await read(registrar, 'OperatorRegistrar', 'operatorCount')).toBe(0n);
    await write(wallets[0], registry, 'ENSLeaseTest', 'setReject', [false]);
    await write(wallets[1], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[1].account.address, registry, wallets[1].account.address, expiry]);
    expect(await read(registrar, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
  });

  it('cannot reuse a removed name until its actual ENS lease expires', async () => {
    const expiry = Number((await client.getBlock()).timestamp) + 7200;
    await write(wallets[0], registrar, 'OperatorRegistrar', 'remove', [0n, wallets[1].account.address, toHex('alice', { size: 32 })]);
    await expect(write(wallets[2], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[2].account.address, registry, wallets[2].account.address, expiry])).rejects.toThrow();
    await expect(write(wallets[1], registrar, 'OperatorRegistrar', 'setPayee', [0n, wallets[2].account.address])).rejects.toThrow();
    await rpc.request({ method: 'evm_increaseTime', params: [3601] }); await rpc.request({ method: 'evm_mine', params: [] });
    const renewedExpiry = Number((await client.getBlock()).timestamp) + 3600;
    await expect(write(wallets[2], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[2].account.address, registry, wallets[2].account.address, renewedExpiry])).rejects.toThrow(); // label ban survives expiry
    await write(wallets[0], registrar, 'OperatorRegistrar', 'setLabelBlocked', [keccak256(stringToHex('alice')), false]);
    await write(wallets[2], registrar, 'OperatorRegistrar', 'register', ['alice', wallets[2].account.address, registry, wallets[2].account.address, renewedExpiry]);
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

describe('open registrar moderation and lease rules', () => {
  let reg, ens;
  const curator = () => wallets[0], alice = () => wallets[1], bob = () => wallets[2];
  const now = async () => Number((await client.getBlock()).timestamp);
  const skip = async seconds => { await rpc.request({ method: 'evm_increaseTime', params: [seconds] }); await rpc.request({ method: 'evm_mine', params: [] }); };
  const call = (wallet, functionName, args) => write(wallet, reg, 'OperatorRegistrar', functionName, args);
  const list = (label, who, expiry, from = who) => call(from, 'register', [label, who.account.address, ens, who.account.address, expiry]);
  const entry = index => read(reg, 'OperatorRegistrar', 'operators', [BigInt(index)]);
  const fresh = async () => { ens = await deploy('ENSLeaseTest'); reg = await deploy('OperatorRegistrar', [ens, curator().account.address]); };

  it('requires the operator signature for both registration paths, including when the caller is curator', async () => {
    await fresh();
    const expiry = await now() + 3600;
    for (const from of [curator(), bob()]) await expect(list('alice', alice(), expiry, from)).rejects.toThrow();
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(0n);
    await list('alice', alice(), expiry);
    await list('curator-own', curator(), expiry); // the curator may register only as itself
    await skip(7200);
    const args = [0n, 'replacement', bob().account.address, ens, bob().account.address, await now() + 3600];
    for (const from of [curator(), alice()]) await expect(call(from, 'registerInSlot', args)).rejects.toThrow();
    await call(bob(), 'registerInSlot', args);
    expect((await entry(0))[1]).toBe(bob().account.address);
  });

  it('restricts all moderation to the curator and rejects meaningless zero block targets', async () => {
    await fresh();
    await list('alice', alice(), await now() + 3600);
    const labelHash = keccak256(stringToHex('alice'));
    for (const from of [alice(), bob()]) {
      for (const [method, args] of [
        ['remove', [0n, alice().account.address, toHex('alice', { size: 32 })]], ['reinstate', [0n, alice().account.address, toHex('alice', { size: 32 })]],
        ['setOperatorBlocked', [alice().account.address, true]], ['setLabelBlocked', [labelHash, true]],
      ]) await expect(call(from, method, args)).rejects.toThrow();
    }
    await expect(call(curator(), 'setOperatorBlocked', [zeroAddress, true])).rejects.toThrow();
    await expect(call(curator(), 'setLabelBlocked', [toHex(0n, { size: 32 }), true])).rejects.toThrow();
    const before = await entry(0);
    await call(curator(), 'setOperatorBlocked', [alice().account.address, true]);
    await call(curator(), 'setLabelBlocked', [labelHash, true]);
    expect(await entry(0)).toEqual(before); // bans govern future admission, not existing visibility
    await expect(list('new-alice', alice(), await now() + 3600)).rejects.toThrow();
    await call(curator(), 'setOperatorBlocked', [alice().account.address, false]);
    await list('new-alice', alice(), await now() + 3600);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [labelHash])).toBe(true);
  });

  it('keeps address and label tombstones after expiry and slot reuse without hiding active siblings', async () => {
    await fresh();
    const expiry = await now() + 3600;
    await list('removed', alice(), expiry);
    await list('sibling', alice(), expiry);
    const sibling = await entry(1), labelHash = keccak256(stringToHex('removed'));
    await call(curator(), 'remove', [0n, alice().account.address, toHex('removed', { size: 32 })]);
    expect(await entry(1)).toEqual(sibling);
    expect(await read(reg, 'OperatorRegistrar', 'operatorBlocked', [alice().account.address])).toBe(true);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [labelHash])).toBe(true);
    await call(alice(), 'renew', [1n, expiry + 1800]);
    await call(alice(), 'setPayee', [1n, bob().account.address]);
    await expect(list('alias', alice(), expiry)).rejects.toThrow();
    await skip(7200);
    const later = await now() + 3600;
    const replace = (label, who) => call(who, 'registerInSlot', [0n, label, who.account.address, ens, who.account.address, later]);
    await expect(replace('alias', alice())).rejects.toThrow();
    await expect(replace('removed', bob())).rejects.toThrow();
    await replace('replacement', bob());
    await expect(list('removed', bob(), later)).rejects.toThrow(); // old label mapping was deleted, ban was not
    await expect(list('alias', alice(), later)).rejects.toThrow();
    await call(curator(), 'setLabelBlocked', [labelHash, false]);
    await expect(list('removed', alice(), later)).rejects.toThrow(); // clearing a label never clears its owner's ban
    await list('removed', bob(), later);
    await call(curator(), 'setOperatorBlocked', [alice().account.address, false]);
    await call(alice(), 'registerInSlot', [1n, 'alias', alice().account.address, ens, alice().account.address, later]);
    expect((await entry(0))[0]).toBe(toHex('replacement', { size: 32 }));
    expect((await entry(1))[0]).toBe(toHex('alias', { size: 32 }));
    expect((await entry(2))[0]).toBe(toHex('removed', { size: 32 }));
  });

  it('immediately recovers an inactive slot without releasing its old ENS name or ban', async () => {
    await fresh();
    const expiry = await now() + 29 * 86400, labelHash = keccak256(stringToHex('removed'));
    await list('removed', alice(), expiry);
    await call(curator(), 'remove', [0n, alice().account.address, toHex('removed', { size: 32 })]);
    await call(curator(), 'setLabelBlocked', [labelHash, false]);
    await expect(list('removed', bob(), expiry)).rejects.toThrow(); // even an explicitly unblocked name keeps its ENS lease
    await call(curator(), 'setLabelBlocked', [labelHash, true]);
    await call(bob(), 'registerInSlot', [0n, 'replacement', bob().account.address, ens, bob().account.address, expiry]);
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
    expect((await entry(0))[1]).toBe(bob().account.address);
    expect(await read(ens, 'ENSLeaseTest', 'expiry', [BigInt(labelHash)])).toBe(BigInt(expiry));
    expect(await read(reg, 'OperatorRegistrar', 'operatorBlocked', [alice().account.address])).toBe(true);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [labelHash])).toBe(true);
    await expect(call(alice(), 'renew', [0n, expiry + 1])).rejects.toThrow();
    await expect(call(alice(), 'setPayee', [0n, alice().account.address])).rejects.toThrow();
    await expect(call(curator(), 'remove', [0n, alice().account.address, toHex('removed', { size: 32 })])).rejects.toThrow();
    await expect(list('removed', bob(), expiry)).rejects.toThrow();
    await call(curator(), 'setLabelBlocked', [labelHash, false]);
    await expect(list('removed', bob(), expiry)).rejects.toThrow(); // displaced mapping cannot bypass ENS's still-live lease
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(1n); // failed ENS call rolls back the new slot
    expect((await entry(0))[0]).toBe(toHex('replacement', { size: 32 }));
  });

  it('accepts smart-wallet operators while refusing callback mutations before the Listed event', async () => {
    await fresh();
    const receiver = await deploy('RegistrationReceiverTest', [reg, ens, bob().account.address, false]);
    const expiry = await now() + 3600;
    await write(curator(), ens, 'ENSLeaseTest', 'setCallback', [true]);
    const receipt = await write(curator(), receiver, 'RegistrationReceiverTest', 'begin', ['smart-wallet', expiry]);
    expect(await read(receiver, 'RegistrationReceiverTest', 'mutations')).toBe(0n);
    expect(await read(receiver, 'RegistrationReceiverTest', 'guarded')).toBe(4n);
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
    expect((await entry(0)).slice(1)).toEqual([getAddress(receiver), BigInt(expiry), true, bob().account.address]);
    const listed = parseEventLogs({ abi: artifact('OperatorRegistrar').abi, logs: receipt.logs, eventName: 'Listed' });
    expect(listed).toHaveLength(1);
    expect(listed[0].args).toMatchObject({ operator: getAddress(receiver), payee: bob().account.address, expiry: BigInt(expiry) });
    await list('after-callback', alice(), expiry); // registration guard was released
  });

  it('rolls back registration and its guard if the smart-wallet receiver rejects its token', async () => {
    await fresh();
    const receiver = await deploy('RegistrationReceiverTest', [reg, ens, bob().account.address, true]);
    const expiry = await now() + 3600;
    await write(curator(), ens, 'ENSLeaseTest', 'setCallback', [true]);
    await expect(write(curator(), receiver, 'RegistrationReceiverTest', 'begin', ['receiver-reject', expiry])).rejects.toThrow();
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(0n);
    expect(await read(ens, 'ENSLeaseTest', 'expiry', [BigInt(keccak256(stringToHex('receiver-reject')))])).toBe(0n);
    await list('receiver-reject', alice(), expiry);
    expect((await entry(0))[1]).toBe(alice().account.address);
  });

  it('reinstates only the selected entry and clears its address and label bans explicitly', async () => {
    await fresh();
    const expiry = await now() + 3600;
    for (const label of ['first', 'second', 'sibling']) await list(label, alice(), expiry);
    await call(curator(), 'remove', [0n, alice().account.address, toHex('first', { size: 32 })]);
    await call(curator(), 'remove', [1n, alice().account.address, toHex('second', { size: 32 })]);
    const sibling = await entry(2);
    await call(curator(), 'reinstate', [0n, alice().account.address, toHex('first', { size: 32 })]);
    expect((await entry(0))[3]).toBe(true);
    expect((await entry(1))[3]).toBe(false);
    expect(await entry(2)).toEqual(sibling);
    expect(await read(reg, 'OperatorRegistrar', 'operatorBlocked', [alice().account.address])).toBe(false);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [keccak256(stringToHex('first'))])).toBe(false);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [keccak256(stringToHex('second'))])).toBe(true);
    await list('new-name', alice(), expiry); // reinstatement intentionally also lifts this address's admission ban
  });

  it('refuses queued moderation for a previous label even when the replacement has the same owner', async () => {
    await fresh();
    const expiry = await now() + 3600;
    const old = [0n, alice().account.address, toHex('old-label', { size: 32 })];
    const replacement = [0n, alice().account.address, toHex('replacement', { size: 32 })];
    await list('old-label', alice(), expiry);
    await call(curator(), 'remove', old);
    await call(curator(), 'setOperatorBlocked', [alice().account.address, false]);
    await call(alice(), 'registerInSlot', [0n, 'replacement', alice().account.address, ens, alice().account.address, expiry]);
    await expect(call(curator(), 'remove', old)).rejects.toThrow();
    expect((await entry(0))[3]).toBe(true);
    await call(curator(), 'remove', replacement);
    await expect(call(curator(), 'reinstate', old)).rejects.toThrow();
    await expect(call(curator(), 'reinstate', [0n, bob().account.address, replacement[2]])).rejects.toThrow();
    expect((await entry(0))[3]).toBe(false);
    expect(await read(reg, 'OperatorRegistrar', 'operatorBlocked', [alice().account.address])).toBe(true);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [keccak256(stringToHex('replacement'))])).toBe(true);
    await call(curator(), 'reinstate', replacement);
    expect((await entry(0))[3]).toBe(true);
    expect(await read(reg, 'OperatorRegistrar', 'labelBlocked', [keccak256(stringToHex('old-label'))])).toBe(true);
  });

  it('allows self-registration of an expired active name without curator approval', async () => {
    await fresh();
    await list('alice', alice(), await now() + 3600);
    await skip(7200);
    await list('alice', alice(), await now() + 3600);
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(1n);
    expect((await entry(0))[3]).toBe(true);
  });

  it('preserves the exact three-word proof layout and slot-one label index', async () => {
    await fresh();
    const layout = artifact('OperatorRegistrar').storageLayout;
    expect(layout.storage.map(({ label, slot, offset }) => ({ label, slot, offset }))).toEqual([
      { label: 'operators', slot: '0', offset: 0 }, { label: 'indexPlusOne', slot: '1', offset: 0 },
      { label: 'operatorBlocked', slot: '2', offset: 0 }, { label: 'labelBlocked', slot: '3', offset: 0 },
      { label: 'registering', slot: '4', offset: 0 },
    ]);
    const type = layout.types[layout.types[layout.storage[0].type].base];
    expect(type.numberOfBytes).toBe('96');
    expect(type.members.map(({ label, slot, offset }) => ({ label, slot, offset }))).toEqual([
      { label: 'label', slot: '0', offset: 0 }, { label: 'operator', slot: '1', offset: 0 },
      { label: 'expiry', slot: '1', offset: 20 }, { label: 'active', slot: '1', offset: 28 },
      { label: 'payee', slot: '2', offset: 0 },
    ]);
    const expiry = await now() + 3600, packed = toHex('proofable', { size: 32 });
    await call(alice(), 'register', ['proofable', alice().account.address, ens, bob().account.address, expiry]);
    const storage = async slot => BigInt(await client.getStorageAt({ address: reg, slot: toHex(slot, { size: 32 }) }) || '0x0');
    const base = BigInt(keccak256(toHex(0n, { size: 32 })));
    expect(await storage(0n)).toBe(1n);
    expect(await storage(base)).toBe(BigInt(packed));
    expect(await storage(base + 1n)).toBe(BigInt(alice().account.address) | BigInt(expiry) << 160n | 1n << 224n);
    expect(await storage(base + 2n)).toBe(BigInt(bob().account.address));
    const indexSlot = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [packed, 1n])));
    expect(await storage(indexSlot)).toBe(1n);
    await call(curator(), 'remove', [0n, alice().account.address, packed]);
    expect(await storage(base + 1n)).toBe(BigInt(alice().account.address) | BigInt(expiry) << 160n);
    expect(await storage(indexSlot)).toBe(1n);
  });

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
    const expected = [0n, alice().account.address, toHex('alice', { size: 32 })];
    await expect(call(curator(), 'reinstate', expected)).rejects.toThrow(); // already active
    await call(curator(), 'remove', expected);
    await expect(call(alice(), 'reinstate', expected)).rejects.toThrow();
    await call(curator(), 'reinstate', expected);
    expect((await entry(0))[3]).toBe(true);
    await call(alice(), 'renew', [0n, await now() + 7200]);
  });

  it('removes an entry only while it is active and held by the expected operator', async () => {
    await fresh();
    await list('alice', alice(), await now() + 3600);
    await expect(call(curator(), 'remove', [0n, bob().account.address, toHex('alice', { size: 32 })])).rejects.toThrow();
    expect((await entry(0))[3]).toBe(true);
    await call(curator(), 'remove', [0n, alice().account.address, toHex('alice', { size: 32 })]);
    expect((await entry(0))[3]).toBe(false);
    await expect(call(curator(), 'remove', [0n, alice().account.address, toHex('alice', { size: 32 })])).rejects.toThrow();
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
    const inSlot = (slot, label, who, until, from = who) => call(from, 'registerInSlot', [BigInt(slot), label, who.account.address, ens, who.account.address, until]);
    await expect(list('newcomer', bob(), expiry)).rejects.toThrow(); // full
    await expect(inSlot(5, 'newcomer', bob(), expiry)).rejects.toThrow(); // slot 5 is still running
    await call(curator(), 'remove', [5n, alice().account.address, toHex('op5', { size: 32 })]);
    await inSlot(5, 'newcomer', bob(), expiry); // removal immediately recovers capacity for a different name
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(128n);
    await skip(7200);
    const later = await now() + 3600;
    await expect(inSlot(5, 'newcomer', bob(), later, curator())).rejects.toThrow(); // operator must sign
    await expect(inSlot(128, 'newcomer', bob(), later)).rejects.toThrow(); // no such slot
    await inSlot(5, 'newcomer', bob(), later);
    expect(await read(reg, 'OperatorRegistrar', 'operatorCount')).toBe(128n);
    const taken = await entry(5);
    expect(taken[0]).toBe(toHex('newcomer', { size: 32 })); expect(taken[1].toLowerCase()).toBe(bob().account.address.toLowerCase()); expect(taken[3]).toBe(true);
    await expect(inSlot(6, 'newcomer', bob(), later)).rejects.toThrow(); // a label never occupies two slots
    await expect(inSlot(6, 'op5', alice(), later)).rejects.toThrow(); // both bans survived capacity recovery and expiry
    await call(curator(), 'setOperatorBlocked', [alice().account.address, false]);
    await call(curator(), 'setLabelBlocked', [keccak256(stringToHex('op5')), false]);
    await inSlot(6, 'op5', alice(), later); // the displaced label returns through another expired slot
    expect((await entry(6))[0]).toBe(toHex('op5', { size: 32 }));
    await list('op7', bob(), later); // an existing label still reuses its own slot through register
    expect((await entry(7))[1].toLowerCase()).toBe(bob().account.address.toLowerCase());
  }, 120000);
});
