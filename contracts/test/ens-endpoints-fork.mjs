// Invoked only inside ens-fork.test.mjs's guarded, snapshotted loopback Anvil scenario.
import { expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createWalletClient, decodeFunctionData, encodeFunctionData, http, zeroAddress } from 'viem';
import { addresses, dnsEncode, endpointState, json, labelId, readAt, registryAbi, resolverAbi, serializeOperatorEndpoints } from '../scripts/ens-common.mjs';
import { preparePlan } from '../scripts/ens-plan.mjs';
import { verifyDeployment } from '../scripts/ens-verify.mjs';
import { checkLifecyclePlan, prepareLifecycle, verifyLifecycle } from '../scripts/ens-lifecycle.mjs';

export async function validateForkEndpoints({ config: baselineConfig, stages: baselineStages, manifest: baselineManifest, client, rpc, forkRpc, build, fork }) {
  const whole = await rpc('evm_snapshot');
  const report = { checkedAt: new Date().toISOString(), localOnly: true, publicTransactionsSent: false, scope: 'Actual ENS mainnet bytecode on a disposable local fork; fixture operators are not independent public enrollments', fork, sourceHash: build.sourceHash, compiler: build.compiler, upstream: baselineManifest.upstream, checks: [], examples: [] };
  const nodes = label => [{ id: 'east', url: `https://${label}-east.example/rpc`, beaconUrl: `https://${label}-east.example/beacon` }, { id: 'west', url: `https://${label}-west.example/rpc`, beaconUrl: `https://${label}-west.example/beacon` }];
  const submit = tx => createWalletClient({ account: tx.from, transport: http(forkRpc, { retryCount: 0, timeout: 30000 }) }).sendTransaction({ chain: null, to: tx.to, data: tx.data, value: 0n, gas: 8_000_000n, ...(tx.nonce ? { nonce: Number(BigInt(tx.nonce)) } : {}) });
  const call = (from, to, abi, functionName, args) => ({ from, to, data: encodeFunctionData({ abi, functionName, args }), value: '0x0', chainId: '0x1' });
  const mine = async () => { for (let i = 0; i < 12; i++) await rpc('evm_mine'); };
  const isolated = async fn => { const snapshot = await rpc('evm_snapshot'); try { return await fn(); } finally { expect(await rpc('evm_revert', [snapshot])).toBe(true); } };
  // Poll the exact submitted hash: the local node can return it before the transaction is in a block.
  const receipt = async hash => {
    for (const deadline = Date.now() + 30000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 100))) {
      try { return await client.getTransactionReceipt({ hash }); } catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    }
    throw new Error(`no local receipt for ${hash}`);
  };
  const execute = async plan => {
    const transactionHashes = [];
    for (const item of plan.transactions) { const hash = await submit(item.walletRequest.params[0]); expect((await receipt(hash)).status).toBe('success'); transactionHashes.push(hash); }
    return { plan: structuredClone(plan), transactionHashes };
  };
  const op = baselineConfig.operators[0], other = baselineConfig.operators[1], original = baselineManifest.operators[0], resolver = original.resolver, name = original.name;
  const state = async () => endpointState(readAt(client, (await client.getBlock()).number), resolver, name, op.hotKey);
  try {
    const pluralConfig = structuredClone(baselineConfig);
    delete pluralConfig.operators[0].endpoint; delete pluralConfig.operators[0].beacon;
    pluralConfig.operators[0].endpoints = nodes(op.label);
    const migration = await preparePlan({ config: pluralConfig, client, build });
    expect(migration.stage).toBe('migrate-endpoint-permissions-and-records'); expect(migration.transactions).toHaveLength(1);
    expect(migration.transactions[0].walletRequest.params[0].from).toBe(op.coldOwner);
    const inner = decodeFunctionData({ abi: resolverAbi, data: migration.transactions[0].walletRequest.params[0].data }).args[0];
    expect(inner).toHaveLength(5);

    await isolated(async () => {
      const before = await state();
      const invalid = [...inner]; invalid[4] = '0xdeadbeef';
      const hash = await submit(call(op.coldOwner, resolver, resolverAbi, 'multicall', [invalid]));
      expect((await receipt(hash)).status).toBe('reverted');
      expect(await state()).toEqual(before);
    });
    await isolated(async () => {
      await submit(call(op.coldOwner, resolver, resolverAbi, 'setText', [dnsEncode(name), 'derpc.price', '1']));
      await expect(preparePlan({ config: pluralConfig, client, build })).rejects.toThrow(/paid records/);
    });
    await isolated(async () => {
      // Even safe-looking final roles cannot turn an unreviewed non-atomic sequence
      // into the planner's explicitly reviewed migration transaction.
      const hashes = [];
      for (const data of inner) hashes.push(await submit({ from: op.coldOwner, to: resolver, data }));
      await mine();
      await expect(verifyDeployment({ config: pluralConfig, stages: baselineStages, client, build })).rejects.toThrow(/hot-key event audit/);
      const forged = structuredClone(migration);
      forged.transactions = [{ id: `grant-endpoints-${op.label}`, walletRequest: { method: 'eth_sendTransaction', params: [{ from: op.coldOwner, to: resolver, data: inner[4], value: '0x0', chainId: '0x1' }] } }];
      await expect(verifyDeployment({ config: pluralConfig, stages: [...baselineStages, { plan: forged, transactionHashes: [hashes[4]] }], client, build })).rejects.toThrow(/atomic migration/);
    });
    report.checks.push('Cold-owner migration is atomic: later inner-call failure rolls back revocation and records; paid and non-atomic/unreviewed migration evidence are rejected');

    const migrationStage = await execute(migration); await mine();
    const stages = [...baselineStages, migrationStage];
    const pluralManifest = await verifyDeployment({ config: pluralConfig, stages, client, build });
    expect(pluralManifest.operators[0].initialRecords).toEqual(original.records);
    expect(pluralManifest.operators[0].records['derpc.endpoints']).toBe(serializeOperatorEndpoints(nodes(op.label)));
    const migrated = await state();
    expect(migrated.roles['derpc.endpoint']).toBe(0n); expect(migrated.roles['derpc.endpoints']).toBe(16n);
    expect(migrated.records['derpc.endpoint']).toBe(''); expect(migrated.records['derpc.beacon']).toBe('');
    report.examples.push({ type: 'legacy-to-plural', plan: migration, receiptBlock: (await client.getTransactionReceipt({ hash: migrationStage.transactionHashes[0] })).blockNumber.toString(), verified: pluralManifest.verification });
    for (const [target, recordName, key, value] of [[resolver, name, 'derpc.endpoint', 'https://old-permission.example'], [resolver, name, 'derpc.beacon', 'https://standalone-beacon.example'], [resolver, name, 'derpc.signer', other.signer], [resolver, name, 'derpc.payee', other.payee], [baselineManifest.operators[1].resolver, `${other.label}.derpc.eth`, 'derpc.endpoints', serializeOperatorEndpoints(nodes(other.label))]]) {
      const tx = call(op.hotKey, target, resolverAbi, 'setText', [dnsEncode(recordName), key, value]);
      await expect(client.call({ account: tx.from, to: tx.to, data: tx.data })).rejects.toThrow();
    }
    report.checks.push('Verified migration preserves original initialization history and limits the hot key to the entire plural record; singular/beacon/signer/payee and cross-operator writes deny');

    // A reorg after historical reads must not result in a supposedly canonical manifest.
    let audited = false;
    const head = await client.getBlock();
    const inconsistent = { ...client, getLogs: async options => { const result = await client.getLogs(options); if (options.event) audited = true; return result; }, getBlock: async options => {
      const block = await client.getBlock(options);
      return audited && options.blockNumber === head.number ? { ...block, hash: '0x' + '55'.repeat(32) } : block;
    } };
    await expect(verifyDeployment({ config: pluralConfig, stages, client: inconsistent, build })).rejects.toThrow(/noncanonical/);
    report.checks.push('Post-audit reorg of the final observation rejects deployment verification');

    const replacement = nodes(op.label); replacement[0].url = 'https://rotated-east.example/rpc'; replacement[0].beaconUrl = 'https://rotated-east.example/beacon';
    const rotate = await prepareLifecycle({ manifest: pluralManifest, action: { type: 'rotate-endpoints', label: op.label, expectedEndpoints: nodes(op.label), newEndpoints: replacement }, client, build });
    await isolated(async () => {
      const concurrent = nodes(op.label); concurrent[1].url = 'https://concurrent-west.example/rpc';
      await submit(call(op.hotKey, resolver, resolverAbi, 'setText', [dnsEncode(name), 'derpc.endpoints', serializeOperatorEndpoints(concurrent)]));
      await expect(checkLifecyclePlan({ manifest: pluralManifest, plan: rotate, client, build })).rejects.toThrow(/list changed/);
    });
    const forgedManifest = structuredClone(baselineManifest);
    forgedManifest.operators[0] = { ...pluralManifest.operators[0] };
    forgedManifest.transactions.push(pluralManifest.transactions.find(tx => tx.id === `migrate-endpoint-mode-${op.label}`));
    await expect(prepareLifecycle({ manifest: forgedManifest, action: rotate.action, client, build })).rejects.toThrow(/canonical observed block/);
    const rotationHash = await submit(rotate.walletRequest.params[0]); await mine();
    const rotated = await verifyLifecycle({ manifest: pluralManifest, plan: rotate, transactionHash: rotationHash, client, build });
    expect(rotated.after.entry).toEqual(rotated.before.entry);
    expect(rotated.after.records['derpc.endpoints']).toBe(serializeOperatorEndpoints(replacement));
    expect(rotated.after.records['derpc.endpoint']).toBe(''); expect(rotated.after.records['derpc.beacon']).toBe('');
    const lifecycleHead = await client.getBlock();
    const finalizedReceiptBlock = await client.getBlock({ blockNumber: BigInt(rotated.receipt.blockNumber) });
    let finalizedRead = false;
    const reorgDuringFinality = { ...client, getBlock: async options => {
      if (options.blockTag === 'finalized') { finalizedRead = true; return finalizedReceiptBlock; }
      const block = await client.getBlock(options);
      return finalizedRead && options.blockNumber === lifecycleHead.number ? { ...block, hash: '0x' + '66'.repeat(32) } : block;
    } };
    await expect(verifyLifecycle({ manifest: pluralManifest, plan: rotate, transactionHash: rotationHash, client: reorgDuringFinality, build })).rejects.toThrow(/no longer canonical/);
    report.examples.push({ type: 'rotate-endpoints', plan: rotate, verified: rotated.verification, finality: rotated.finality, receipt: rotated.receipt });
    report.checks.push('Plural lifecycle binds the full old/new list including beacon URLs; a concurrent edit to the other node, a forged old manifest observation and a head reorg during the finalized read are refused');

    await isolated(async () => {
      const delist = await prepareLifecycle({ manifest: pluralManifest, action: { type: 'delist', label: op.label }, client, build });
      const hash = await submit(delist.walletRequest.params[0]); await mine();
      const result = await verifyLifecycle({ manifest: pluralManifest, plan: delist, transactionHash: hash, client, build });
      expect(result.after.entry.active).toBe(false); expect(result.after.records['derpc.endpoints']).toBe(serializeOperatorEndpoints(replacement));
      expect(result.after.ens).toEqual(result.before.ens);
    });
    const reverse = await preparePlan({ config: baselineConfig, client, build });
    expect(reverse.transactions[0].id).toBe(`migrate-endpoint-mode-${op.label}`);
    const reverseStage = await execute(reverse); await mine();
    const restored = await verifyDeployment({ config: baselineConfig, stages: [...stages, reverseStage], client, build });
    expect((await state()).roles).toEqual({ 'derpc.endpoint': 16n, 'derpc.endpoints': 0n });
    expect((await state()).records['derpc.endpoints']).toBe('');
    expect(restored.operators[0].initialRecords).toEqual(original.records);
    report.examples.push({ type: 'plural-to-legacy', plan: reverse, verified: restored.verification });
    report.checks.push('Operator-wide delisting retains the plural record/token but clears admission; explicit reverse migration removes plural authority and restores only legacy authority');

    await isolated(async () => {
      // A second independent fixture proves initial plural deployments, not only migrations.
      await submit(call(baselineConfig.curator, addresses.ETHRegistry, registryAbi, 'setSubregistry', [labelId('derpc'), zeroAddress]));
      let fresh = structuredClone(baselineConfig); delete fresh.registrar; fresh.deploymentId = 'fork-plural-initial-fixture';
      fresh.operators = fresh.operators.slice(0, 1);
      for (const operator of fresh.operators) { delete operator.endpoint; delete operator.beacon; operator.endpoints = nodes(operator.label); }
      const freshStages = [];
      for (let round = 0; round < 8; round++) {
        const plan = await preparePlan({ config: fresh, client, build }); fresh = plan.resumeConfig;
        if (plan.status === 'state-matches-config') break;
        freshStages.push(await execute(plan));
      }
      await mine();
      const checked = await verifyDeployment({ config: fresh, stages: freshStages, client, build });
      expect(checked.operators).toHaveLength(1);
      for (const operator of checked.operators) {
        expect(operator.records['derpc.endpoints']).toBe(serializeOperatorEndpoints(nodes(operator.name.split('.')[0])));
        expect(operator.records['derpc.endpoint']).toBe(''); expect(operator.records['derpc.beacon']).toBe('');
        expect(operator.initialRecords).toEqual(operator.records);
      }
      report.freshDeployment = { operators: checked.operators.map(operator => ({ name: operator.name, records: operator.records })), stages: freshStages.map(({ plan }) => ({ stage: plan.stage, transactions: plan.transactions.map(item => item.id) })), verification: checked.verification };
      const delist = await prepareLifecycle({ manifest: checked, action: { type: 'delist', label: fresh.operators[0].label }, client, build });
      const hash = await submit(delist.walletRequest.params[0]); await mine();
      const removed = await verifyLifecycle({ manifest: checked, plan: delist, transactionHash: hash, client, build });
      expect(removed.after.entry.active).toBe(false); expect(removed.after.ens).toEqual(removed.before.ens);
      report.freshDeployment.delisting = { receipt: removed.receipt, verification: removed.verification };
    });
    report.checks.push('Fresh single-operator plural deployment completes every unsigned stage, canonical receipt/role verification and lifecycle delisting with one dedicated resolver for both endpoints');
    report.complete = true;
    return report;
  } finally {
    expect(await rpc('evm_revert', [whole])).toBe(true);
    if (process.env.DERPC_ENS_ENDPOINTS_REPORT) writeFileSync(process.env.DERPC_ENS_ENDPOINTS_REPORT, json(report), { flag: 'wx' });
  }
}
