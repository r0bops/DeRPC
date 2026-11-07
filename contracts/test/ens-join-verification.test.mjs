import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroAddress } from 'viem';
import { addresses, curatorRoles, labelId, operatorRecords, registrarRoles, resolverOwnerRoles, roles, textAbi } from '../scripts/ens-common.mjs';
import { registrarBuild } from '../scripts/ens-plan.mjs';
import { prepareJoinPlan, validateJoinConfig, verifyJoin } from '../scripts/ens-join.mjs';

// Historical RPC fixture only: real planner/calldata/runtime checks, injected administrative
// observations. Actual ENS bytecode, upstream preflight and wallet integration run in the fork suite.
vi.mock('../lib/ens-common.mjs', async importOriginal => ({
  ...await importOriginal(), preflight: async client => structuredClone(client.reviewSnapshot),
}));

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => toHex(n, { size: 32 });
const now = 1794000000n;
let build;
beforeAll(() => { build = registrarBuild(); }, 30000);

async function fixture() {
  const runtime = `0x${build.artifact.evm.deployedBytecode.object}`;
  const config = validateJoinConfig({ schemaVersion: 1, kind: 'derpc-ens-join-config', chainId: 1, parentName: 'derpc.eth',
    deploymentId: 'verify-alice', curator: address(1),
    directory: { chainId: 1, ethRegistry: addresses.ETHRegistry, registrar: { address: address(2), registry: address(3), codeHash: keccak256(runtime) } },
    operators: [{ label: 'alice', operator: address(4), coldOwner: address(4), hotKey: address(5), signer: address(4), payee: address(4),
      endpoint: 'https://rpc.example/rpc', beacon: 'https://rpc.example',
      caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'], beacon: true }, expiry: Number(now + 86400n) }],
  });
  const op = config.operators[0], resolver = address(6), records = operatorRecords(op);
  const snapshots = new Map(), transactions = new Map(), receipts = new Map(), stages = [], logs = [], orphaned = new Set();
  let auditComplete = false;
  const observation = number => ({ chainId: 1, blockNumber: BigInt(number), blockHash: hash(number), timestamp: now,
    localOnly: true, parent: { expiry: now + 365n * 86400n, subregistry: address(3) } });
  const stateAt = number => {
    const state = snapshots.get(Number(number));
    if (!state) throw new Error(`Unexpected historical read at block ${number}`);
    return state;
  };
  const client = {
    reviewSnapshot: observation(120),
    getChainId: async () => 1,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: hash(Number(blockNumber) + (orphaned.has(Number(blockNumber)) ? 500 : 0)), timestamp: now }),
    getBytecode: async ({ address: target, blockNumber }) => target === address(2) ? runtime : stateAt(blockNumber).deployed && target === resolver ? '0x6000' : '0x',
    estimateGas: async () => 123456n,
    getTransaction: async ({ hash }) => transactions.get(hash),
    getTransactionReceipt: async ({ hash }) => receipts.get(hash),
    getLogs: async () => { auditComplete = true; return structuredClone(logs); },
    readContract: async ({ address: target, functionName, args, blockNumber }) => {
      const state = stateAt(blockNumber);
      if (functionName === 'registry') return address(3);
      if (functionName === 'curator') return address(1);
      if (functionName === 'getParent') return [addresses.ETHRegistry, 'derpc'];
      if (functionName === 'verifyContract') return args[0] === address(3) ? addresses.UserRegistryImpl : addresses.PermissionedResolverImpl;
      if (functionName === 'predictProxyAddress') { expect(args[0]).toBe(op.operator); return resolver; }
      if (functionName === 'operatorCount') return state.registered ? 1n : 0n;
      if (functionName === 'operators') return [toHex(op.label, { size: 32 }), op.operator, BigInt(op.expiry), true, op.payee];
      if (functionName === 'operatorBlocked' || functionName === 'labelBlocked') return false;
      if (functionName === 'getState') return state.registered
        ? { status: 2, latestOwner: op.operator, expiry: BigInt(op.expiry) }
        : { status: 0, latestOwner: zeroAddress, expiry: 0n };
      if (functionName === 'getResolver') return resolver;
      if (functionName === 'roles') {
        if (target === address(3)) return args[1] === config.curator ? curatorRoles : registrarRoles;
        if (args[0] === 0n) return args[1] === op.operator ? resolverOwnerRoles : 0n;
        return args[0] === labelId('derpc.endpoint') && state.granted && args[1] === op.hotKey ? roles.text : 0n;
      }
      if (functionName === 'roleCount') {
        if (target === address(3)) return args[0] === 0n ? curatorRoles + registrarRoles : 0n;
        return args[0] === 0n ? resolverOwnerRoles : args[0] === labelId('derpc.endpoint') && state.granted ? roles.text : 0n;
      }
      if (functionName === 'resolve') {
        const key = decodeFunctionData({ abi: textAbi, data: args[1] }).args[1];
        return encodeFunctionResult({ abi: textAbi, functionName: 'text', result: records[key] ?? '' });
      }
      throw new Error(`Unexpected read ${functionName}`);
    },
  };
  for (let i = 0; i < 3; i++) {
    const review = 100 + 2 * i;
    snapshots.set(review, { deployed: i > 0, granted: i > 1, registered: false });
    const plan = await prepareJoinPlan({ config, client, snapshot: observation(review), build });
    const tx = plan.transactions[0].walletRequest.params[0], transactionHash = hash(900 + i), blockNumber = BigInt(review + 1);
    transactions.set(transactionHash, { hash: transactionHash, from: tx.from, to: tx.to, input: tx.data, value: 0n, chainId: 1, blockNumber, blockHash: hash(review + 1) });
    receipts.set(transactionHash, { transactionHash, from: tx.from, status: 'success', blockNumber, blockHash: hash(review + 1), gasUsed: 100n });
    stages.push({ plan, transactionHashes: [transactionHash] });
  }
  snapshots.set(120, { deployed: true, granted: true, registered: true });
  const event = (args, number, transactionHash) => ({ args, blockNumber: BigInt(number), blockHash: hash(number), transactionHash, removed: false });
  logs.push(event({ account: op.operator, resource: 0n, newRoleBitmap: resolverOwnerRoles }, 101, hash(900)),
    event({ account: op.hotKey, resource: labelId('derpc.endpoint'), newRoleBitmap: roles.text }, 103, hash(901)));
  return { config, op, client, stages, logs, transactions, receipts, event,
    orphan: block => orphaned.add(block), audited: () => auditComplete,
    verify: () => verifyJoin({ config, stages, client, build }),
  };
}

describe('operator enrollment receipt and authority verification', () => {
  it('verifies all three operator-signed stages and retains the exact final observation', async () => {
    const f = await fixture(), manifest = await f.verify();
    expect(manifest.observedBlock).toEqual({ number: 120n, hash: hash(120) });
    expect(manifest.localOnly).toBe(true);
    expect(manifest.verification).toMatchObject({ canonicalBlocks: true, operatorSigned: true, hotKeyEventAudit: true, minimumConfirmations: 12 });
    expect(manifest.transactions.map(tx => tx.from)).toEqual([f.op.operator, f.op.operator, f.op.operator]);
  });

  it.each([
    ['first review', 100], ['first receipt', 101], ['second review', 102], ['second receipt', 103],
    ['third review', 104], ['third receipt', 105], ['final snapshot', 120],
  ])('rejects a reorg of the %s during the role-log audit', async (_name, block) => {
    const f = await fixture(), getLogs = f.client.getLogs;
    f.client.getLogs = async () => { const logs = await getLogs(); f.orphan(block); return logs; };
    await expect(f.verify()).rejects.toThrow(/became noncanonical/);
    expect(f.audited()).toBe(true);
  });

  it('rechecks the final snapshot after checking the other historical anchors', async () => {
    const f = await fixture(), getBlock = f.client.getBlock;
    f.client.getBlock = async request => {
      const block = await getBlock(request);
      if (f.audited() && request.blockNumber === 104n) f.orphan(120);
      return block;
    };
    await expect(f.verify()).rejects.toThrow(/Final enrollment snapshot became noncanonical/);
  });

  it.each([
    ['unknown protected-record delegate', address(99), 'derpc.signer'],
    ['unknown endpoint delegate', address(99), 'derpc.endpoint'],
    ['unknown delegate and unknown key', address(99), 'unlisted.key'],
    ['endpoint updater on an unknown key', address(5), 'unlisted.key'],
    ['cold owner with an extra scoped grant', address(4), 'unlisted.key'],
  ])('rejects %s in the complete resolver role history', async (_name, account, key) => {
    const f = await fixture();
    f.logs.push(f.event({ account, resource: labelId(key), newRoleBitmap: roles.text }, 110, hash(999)));
    await expect(f.verify()).rejects.toThrow(/unexpected resolver authority/);
  });

  it('rejects a role log marked as removed even when its grantee and key are otherwise valid', async () => {
    const f = await fixture(); f.logs[1].removed = true;
    await expect(f.verify()).rejects.toThrow(/unexpected resolver authority/);
  });

  it.each(['transaction', 'receipt'])('rejects the curator substituted as the registration %s signer', async kind => {
    const f = await fixture(), registrationHash = f.stages[2].transactionHashes[0];
    (kind === 'transaction' ? f.transactions : f.receipts).get(registrationHash).from = f.config.curator;
    await expect(f.verify()).rejects.toThrow(/operator-signed intent/);
  });

  it('rejects reuse of a successful earlier transaction as another enrollment receipt', async () => {
    const f = await fixture(); f.stages[2].transactionHashes[0] = f.stages[1].transactionHashes[0];
    await expect(f.verify()).rejects.toThrow(/duplicate enrollment/);
  });
});
