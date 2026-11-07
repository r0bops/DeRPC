// Opt-in exact deployment validation against actual ENS code on a disposable fork.
// No private keys or public signer: only the guarded loopback node can impersonate.
// Start Anvil with --chain-id 31337 --accounts 0; all mutations are reverted.
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { addresses, dnsEncode, json, readAt, readText, registryAbi, resolverAbi, validateConfig, labelId } from '../scripts/ens-common.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { verifyDeployment } from '../scripts/ens-verify.mjs';
import { checkLifecyclePlan, prepareLifecycle, verifyLifecycle } from '../scripts/ens-lifecycle.mjs';

const forkRpc = process.env.DERPC_ENS_TWO_OPERATORS_FORK_RPC;
it.skipIf(!forkRpc)('validates the exact two-operator unsigned plan and scoped lifecycle on a local ENS fork', async () => {
  const reportFile = process.env.DERPC_ENS_TWO_OPERATORS_REPORT;
  if (reportFile && existsSync(reportFile)) throw new Error('Choose a new report path; historical fork evidence must not be overwritten');
  const url = new URL(forkRpc);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('requires a credential-free loopback HTTP fork');
  const client = createPublicClient({ transport: http(forkRpc, { retryCount: 0, timeout: 30000 }), pollingInterval: 20 });
  if (await client.getChainId() !== 31337) throw new Error('refusing any chain other than local 31337');
  const rpc = (method, params = []) => client.request({ method, params });
  const info = await rpc('anvil_nodeInfo');
  if (!info.forkConfig?.forkUrl || !info.forkConfig?.forkBlockNumber || !/anvil/i.test(await rpc('web3_clientVersion'))) throw new Error('requires a disposable Anvil mainnet fork');
  const fork = { blockNumber: info.forkConfig.forkBlockNumber, blockHash: (await client.getBlock({ blockNumber: BigInt(info.forkConfig.forkBlockNumber) })).hash, clientVersion: await rpc('web3_clientVersion') };
  expect((await client.getBlock()).hash).toBe(fork.blockHash);
  const build = registrarBuild();
  const receipt = async hash => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { return await client.getTransactionReceipt({ hash }); }
      catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`local fork did not mine submitted transaction ${hash}`);
  };
  const inputPaths = [
    fileURLToPath(new URL('../deployments/ens-two-demo-operators-config-2026-11-07.json', import.meta.url)),
    process.env.DERPC_ENS_TWO_OPERATORS_PLAN ? resolve(process.env.DERPC_ENS_TWO_OPERATORS_PLAN) : fileURLToPath(new URL('../deployments/ens-open-registration-plan-1-2026-11-07.json', import.meta.url)),
    fileURLToPath(new URL('../deployments/ens-demo-hotkeys-public-2026-11-06.json', import.meta.url)),
  ];
  const filenames = inputPaths.map(path => basename(path));
  const inputs = inputPaths.map(path => readFileSync(path));
  let config = validateConfig(JSON.parse(inputs[0]));
  const reviewed = JSON.parse(inputs[1]), publicKeys = JSON.parse(inputs[2]);
  expect(config.operators).toHaveLength(2);
  expect(reviewed.resumeConfig).toEqual(config);
  expect(reviewed.sourceHash).toBe(build.sourceHash);
  expect(reviewed.compiler).toEqual(build.compiler);
  expect(publicKeys.entries.slice(0, 2)).toEqual(config.operators.map(op => ({ name: `${op.label}.derpc.eth`, address: op.hotKey })));
  const report = {
    checkedAt: new Date().toISOString(), localOnly: true, publicTransactionsSent: false, complete: false,
    scope: 'Exact public two-operator config and factory requests simulated with local impersonation, actual ENS bytecode, locally mined receipts and direct local state reads. No keys, onion traffic, consensus verification or public enrollment.',
    fork, sourceHash: build.sourceHash, compiler: build.compiler,
    inputs: Object.fromEntries(filenames.map((name, i) => [name, createHash('sha256').update(inputs[i]).digest('hex')])),
    checks: [], stages: [], lifecycle: [],
  };
  const fixture = await rpc('evm_snapshot');
  const actors = [...new Set([config.curator, config.deployer, ...config.operators.flatMap(op => [op.operator, op.coldOwner, op.hotKey])])];
  const send = async tx => {
    expect(tx.value).toBe('0x0'); expect(tx.chainId).toBe('0x1'); expect(actors).toContain(tx.from);
    const wallet = createWalletClient({ account: tx.from, transport: http(forkRpc, { retryCount: 0, timeout: 30000 }) });
    const hash = await wallet.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: 0n, gas: 8_000_000n, ...(tx.nonce === undefined ? {} : { nonce: Number(BigInt(tx.nonce)) }) });
    expect((await receipt(hash)).status).toBe('success');
    return hash;
  };
  const mine = async () => { for (let i = 0; i < 12; i++) await rpc('evm_mine'); };
  try {
    await rpc('anvil_setChainId', [1]);
    for (const account of actors) {
      await rpc('anvil_impersonateAccount', [account]);
      await rpc('anvil_setBalance', [account, '0x56bc75e2d63100000']);
    }
    const stages = [];
    let finalPlan;
    for (let round = 0; round < 8; round++) {
      const plan = await preparePlan({ config, client, build }); config = plan.resumeConfig;
      if (round === 0) {
        expect(plan.transactions.map(tx => tx.walletRequest)).toEqual(reviewed.transactions.map(tx => tx.walletRequest));
        expect(plan.subregistry).toBe(reviewed.subregistry); expect(plan.resolvers).toEqual(reviewed.resolvers);
        expect(plan.roleTable).toEqual(reviewed.roleTable);
      }
      if (plan.status === 'state-matches-config') { finalPlan = plan; break; }
      const transactionHashes = [];
      for (const item of plan.transactions) {
        if (item.id.startsWith('register-')) expect(item.walletRequest.params[0].from).toBe(config.operators.find(op => item.id === `register-${op.label}`).operator);
        transactionHashes.push(await send(item.walletRequest.params[0]));
      }
      stages.push({ plan: structuredClone(plan), transactionHashes });
      report.stages.push({ stage: plan.stage, ids: plan.transactions.map(tx => tx.id), transactionHashes });
    }
    expect(finalPlan?.status).toBe('state-matches-config');
    await mine();
    const manifest = await verifyDeployment({ config, stages, client, confirmations: 12, build });
    expect(manifest.localOnly).toBe(true);
    report.deployment = { subregistry: manifest.subregistry, registrar: manifest.registrar, operators: manifest.operators, verification: manifest.verification };
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
    expect(await read(manifest.registrar.address, build.artifact.abi, 'operatorCount')).toBe(2n);
    for (const [i, op] of config.operators.entries()) {
      const entry = await read(manifest.registrar.address, build.artifact.abi, 'operators', [BigInt(i)]);
      expect(entry.slice(1)).toEqual([op.operator, BigInt(op.expiry), true, op.payee]);
      const state = await read(manifest.subregistry, registryAbi, 'getState', [labelId(op.label)]);
      expect(state).toMatchObject({ status: 2, latestOwner: op.operator, expiry: BigInt(op.expiry) });
    }
    report.checks.push('Exact reviewed factory calls, current source/compiler, fixed public leases, all registration stages and canonical receipts with twelve local confirmations passed');
    for (const op of manifest.operators) {
      for (const key of ['derpc.signer', 'derpc.payee', 'derpc.beacon', 'derpc.gateways', 'derpc.endpoints']) {
        await expect(client.call({ account: op.hotKey, to: op.resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(op.name), key, 'not-authorized'] }) })).rejects.toThrow(/revert/i);
      }
      for (const other of manifest.operators.filter(other => other.name !== op.name)) {
        await expect(client.call({ account: op.hotKey, to: other.resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(other.name), 'derpc.endpoint', op.records['derpc.endpoint']] }) })).rejects.toThrow(/revert/i);
      }
      const label = op.name.slice(0, -'.derpc.eth'.length);
      const action = { type: 'rotate-endpoint', label, expectedEndpoint: op.records['derpc.endpoint'], newEndpoint: new URL('/rpc-fork-rotation', op.records['derpc.endpoint']).href };
      const plan = await prepareLifecycle({ manifest, action, client, build });
      expect((await checkLifecyclePlan({ manifest, plan, client, build })).stateStillMatches).toBe(true);
      const hash = await send(plan.walletRequest.params[0]); await mine();
      const result = await verifyLifecycle({ manifest, plan, transactionHash: hash, client, build });
      expect(result.after.records['derpc.endpoint']).toBe(action.newEndpoint);
      expect(result.after.records['derpc.gateways']).toBe(op.records['derpc.gateways']);
      expect(result.after.entry).toEqual(result.before.entry);
      report.lifecycle.push({ action, receipt: result.receipt, verification: result.verification });
    }
    report.checks.push('Each public hot key can rotate only its own endpoint; both cross-resolver attempts and ten protected-record attempts reverted; gateway declarations remained unchanged');
    const op = config.operators[0];
    const removal = await prepareLifecycle({ manifest, action: { type: 'delist', label: op.label }, client, build });
    await expect(client.call({ account: op.hotKey, to: removal.walletRequest.params[0].to, data: removal.walletRequest.params[0].data })).rejects.toThrow(/revert/i);
    const removeHash = await send(removal.walletRequest.params[0]); await mine();
    const removed = await verifyLifecycle({ manifest, plan: removal, transactionHash: removeHash, client, build });
    expect(removed.after.entry.active).toBe(false); expect(removed.after.ens).toEqual(removed.before.ens);
    expect(removed.after.moderation).toEqual({ operatorBlocked: true, labelBlocked: true });
    const active = await Promise.all(config.operators.map((_, i) => read(manifest.registrar.address, build.artifact.abi, 'operators', [BigInt(i)])));
    expect(active.map(entry => entry[3])).toEqual([false, true]);
    report.lifecycle.push({ action: removal.action, receipt: removed.receipt, verification: removed.verification, moderation: removed.after.moderation });
    const next = config.operators[1];
    await rpc('evm_setNextBlockTimestamp', [next.expiry + 1]); await rpc('evm_mine');
    const renewal = await prepareLifecycle({ manifest, action: { type: 'renew', label: next.label, expectedExpiry: next.expiry, expiry: next.expiry + 3600, authority: 'curator' }, client, build });
    await expect(client.call({ account: next.hotKey, to: renewal.walletRequest.params[0].to, data: renewal.walletRequest.params[0].data })).rejects.toThrow(/revert/i);
    const renewHash = await send(renewal.walletRequest.params[0]); await mine();
    const renewed = await verifyLifecycle({ manifest, plan: renewal, transactionHash: renewHash, client, build });
    expect(renewed.after.entry.expiry).toBe(next.expiry + 3600); expect(renewed.after.ens.latestOwner).toBe(next.operator);
    report.lifecycle.push({ action: renewal.action, receipt: renewed.receipt, verification: renewed.verification });
    for (const entry of manifest.operators) expect(await readText(readAt(client, (await client.getBlock()).number), entry.resolver, entry.name, 'derpc.gateways')).toBe(entry.records['derpc.gateways']);
    report.checks.push('Curator delisting removed only the targeted admission, banned its operator and label from future registration, and preserved its ENS token; curator renewal revived a lapsed lease while endpoint hot keys could do neither');
    expect(await read(addresses.ETHRegistry, registryAbi, 'getResolver', ['derpc'])).toBe(reviewed.preflight.parent.resolver);
    report.checks.push('Existing derpc.eth parent resolver stayed unchanged');
    report.complete = true;
  } finally {
    try {
      for (const account of actors) await rpc('anvil_stopImpersonatingAccount', [account]);
      expect(await rpc('evm_revert', [fixture])).toBe(true);
    } finally {
      await rpc('anvil_setChainId', [31337]);
      report.restoredChainId = await client.getChainId();
      expect(report.restoredChainId).toBe(31337);
      expect((await client.getBlock()).hash).toBe(fork.blockHash);
      report.restoredForkBlock = true;
      if (reportFile) writeFileSync(reportFile, json(report), { flag: 'wx' });
    }
  }
}, 240000);

