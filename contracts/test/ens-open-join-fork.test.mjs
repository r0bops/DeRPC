// Opt-in validation of independent operator enrollment on actual ENS bytecode.
// Only a disposable loopback Anvil fork may impersonate these public fixture addresses.
import { expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http } from 'viem';
import { addresses, dnsEncode, json, labelId, registryAbi, resolverAbi } from '../scripts/ens-common.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { verifyDeployment } from '../scripts/ens-verify.mjs';
import { enrollmentPins, joinConfigFromDeployment, prepareJoinPlan, validateJoinConfig, verifyJoin } from '../scripts/ens-join.mjs';

const forkRpc = process.env.DERPC_ENS_OPEN_JOIN_FORK_RPC;
it.skipIf(!forkRpc)('enrolls a distinct operator through three operator-signed stages with the curator idle', async () => {
  const reportFile = process.env.DERPC_ENS_OPEN_JOIN_REPORT;
  if (reportFile && existsSync(reportFile)) throw new Error('Choose a new report path; historical evidence must not be overwritten');
  const url = new URL(forkRpc);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('requires a credential-free loopback HTTP fork');
  const transport = http(forkRpc, { retryCount: 0, timeout: 30000 });
  const client = createPublicClient({ transport, pollingInterval: 20 });
  const rpc = (method, params = []) => client.request({ method, params });
  if (await client.getChainId() !== 31337) throw new Error('refusing any chain other than local 31337');
  const info = await rpc('anvil_nodeInfo');
  if (!info.forkConfig?.forkUrl || !info.forkConfig?.forkBlockNumber || !/anvil/i.test(await rpc('web3_clientVersion'))) throw new Error('requires a disposable Anvil mainnet fork');
  const initialBlock = await client.getBlock();
  expect(initialBlock.number).toBe(BigInt(info.forkConfig.forkBlockNumber));
  expect(initialBlock.hash).toBe((await client.getBlock({ blockNumber: BigInt(info.forkConfig.forkBlockNumber) })).hash);
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const parent = await read(addresses.ETHRegistry, registryAbi, 'getState', [labelId('derpc')]);
  const curator = parent.latestOwner;
  const [deployer, bootstrapOwner, bootstrapHot, operator, hotKey] = [1, 2, 3, 4, 5].map(n => getAddress(`0x${(0xdec000n + BigInt(n)).toString(16).padStart(40, '0')}`));
  const fixtureActors = [deployer, bootstrapOwner, bootstrapHot, operator, hotKey];
  expect(fixtureActors.map(a => a.toLowerCase())).not.toContain(curator.toLowerCase());
  const actors = [curator, ...fixtureActors];
  const build = registrarBuild();
  const report = {
    schemaVersion: 1, kind: 'derpc-ens-open-join-fork', checkedAt: new Date().toISOString(), localOnly: true,
    publicTransactionsSent: false, complete: false, sourceHash: build.sourceHash, compiler: build.compiler,
    scope: 'Local mainnet fork with genuine ENS bytecode and explicitly fictitious operator addresses and .example records. No public enrollment, keys, endpoint traffic or consensus proof.',
    fork: { blockNumber: initialBlock.number, blockHash: initialBlock.hash, clientVersion: await rpc('web3_clientVersion') },
    actors: { curator, deployer, bootstrapOwner, bootstrapHot, operator, hotKey }, checks: [], stages: [],
  };
  const snapshot = await rpc('evm_snapshot');
  const receipt = async hash => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { return await client.getTransactionReceipt({ hash }); }
      catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`local fork did not mine submitted transaction ${hash}`);
  };
  const send = async tx => {
    expect(tx.chainId).toBe('0x1'); expect(tx.value).toBe('0x0'); expect(actors).toContain(tx.from);
    const wallet = createWalletClient({ account: tx.from, transport });
    const hash = await wallet.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: 0n, gas: 8_000_000n,
      ...(tx.nonce === undefined ? {} : { nonce: Number(BigInt(tx.nonce)) }) });
    expect((await receipt(hash)).status).toBe('success');
    return hash;
  };
  const confirm = async () => { for (let i = 0; i < 12; i++) await rpc('evm_mine'); };
  try {
    await rpc('anvil_setChainId', [1]);
    for (const account of actors) {
      await rpc('anvil_impersonateAccount', [account]);
      await rpc('anvil_setBalance', [account, '0x56bc75e2d63100000']);
    }
    // These artificial local accounts must behave as EOAs, irrespective of public state.
    for (const account of fixtureActors) await rpc('anvil_setCode', [account, '0x']);
    const expiry = Number(initialBlock.timestamp) + 7200;
    const entry = (label, owner, updater) => ({ label, operator: owner, coldOwner: owner, hotKey: updater, signer: owner, payee: owner,
      endpoint: `https://${label}.example/rpc`, expiry, caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'] } });
    let bootstrap = { schemaVersion: 1, chainId: 1, parentName: 'derpc.eth', curator, deployer,
      deploymentId: 'open-join-local-bootstrap', operators: [entry('bootstrap', bootstrapOwner, bootstrapHot)] };
    const bootstrapStages = [];
    let ready;
    for (let round = 0; round < 8; round++) {
      const plan = await preparePlan({ config: bootstrap, client, build }); bootstrap = plan.resumeConfig;
      if (plan.status === 'state-matches-config') { ready = plan; break; }
      const transactionHashes = [];
      for (const item of plan.transactions) transactionHashes.push(await send(item.walletRequest.params[0]));
      bootstrapStages.push({ plan, transactionHashes });
    }
    expect(ready?.status).toBe('state-matches-config');
    await confirm();
    const deployment = await verifyDeployment({ config: bootstrap, stages: bootstrapStages, client, build, confirmations: 12 });
    expect(deployment.localOnly).toBe(true);
    const joinedOperator = entry('independent', operator, hotKey);
    // Public pin export intentionally refuses local manifests. Construct only this explicit local fixture.
    expect(() => joinConfigFromDeployment({ manifest: deployment, operator: joinedOperator })).toThrow(/public/);
    const config = validateJoinConfig({ schemaVersion: 1, kind: 'derpc-ens-join-config', chainId: 1, parentName: 'derpc.eth',
      deploymentId: 'independent-local-join', curator, operators: [joinedOperator], directory: { chainId: 1, ethRegistry: addresses.ETHRegistry,
        registrar: { address: deployment.registrar.address, codeHash: deployment.registrar.codeHash, registry: deployment.subregistry } } });
    report.bootstrap = { registrar: deployment.registrar, subregistry: deployment.subregistry, verification: deployment.verification };
    const curatorNonce = await client.getTransactionCount({ address: curator });
    const bootstrapNonce = await client.getTransactionCount({ address: bootstrapOwner });
    await rpc('anvil_stopImpersonatingAccount', [curator]);
    await rpc('anvil_stopImpersonatingAccount', [bootstrapOwner]);
    await rpc('anvil_stopImpersonatingAccount', [deployer]);
    const stages = [];
    const expectedStages = ['deploy-operator-resolver', 'configure-operator-endpoint-key', 'register-operator'];
    for (const stage of expectedStages) {
      const plan = await prepareJoinPlan({ config, client, build });
      expect(plan.stage).toBe(stage); expect(plan.transactions).toHaveLength(1);
      const tx = plan.transactions[0].walletRequest.params[0];
      expect(tx.from).toBe(operator); expect(tx.from).not.toBe(curator);
      if (stage === 'register-operator') {
        await expect(client.call({ account: curator, to: tx.to, data: tx.data })).rejects.toThrow(/revert/i);
        await expect(client.call({ account: bootstrapOwner, to: tx.to, data: tx.data })).rejects.toThrow(/revert/i);
      }
      const hash = await send(tx);
      expect((await receipt(hash)).from.toLowerCase()).toBe(operator.toLowerCase());
      stages.push({ plan, transactionHashes: [hash] });
      report.stages.push({ stage, id: plan.transactions[0].id, sender: tx.from, transactionHash: hash });
    }
    await confirm();
    const manifest = await verifyJoin({ config, stages, client, build, confirmations: 12 });
    expect(manifest.localOnly).toBe(true);
    expect(manifest.verification).toEqual({ receipts: true, canonicalBlocks: true, operatorSigned: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 });
    expect(manifest.transactions.map(tx => tx.from.toLowerCase())).toEqual([operator, operator, operator].map(a => a.toLowerCase()));
    expect(() => enrollmentPins(manifest)).toThrow(/public/);
    expect(await client.getTransactionCount({ address: curator })).toBe(curatorNonce);
    expect(await client.getTransactionCount({ address: bootstrapOwner })).toBe(bootstrapNonce);
    expect(await read(deployment.registrar.address, build.artifact.abi, 'operatorCount')).toBe(2n);
    expect((await read(deployment.registrar.address, build.artifact.abi, 'operators', [1n])).slice(1)).toEqual([operator, BigInt(expiry), true, operator]);
    expect(await read(deployment.subregistry, registryAbi, 'getState', [labelId('independent')])).toMatchObject({ status: 2, latestOwner: operator, expiry: BigInt(expiry) });
    expect((await preparePlan({ config: bootstrap, client, build })).status).toBe('state-matches-config');
    const resumedBootstrap = await verifyDeployment({ config: bootstrap, stages: bootstrapStages, client, build });
    expect(resumedBootstrap.verification.stateMatchesConfig).toBe(true);
    expect(resumedBootstrap.operators.map(op => op.name)).toEqual(['bootstrap.derpc.eth']);
    expect((await read(deployment.registrar.address, build.artifact.abi, 'operators', [1n]))[3]).toBe(true);
    report.enrollment = manifest;
    report.checks.push('All three staged calls and canonical twelve-confirmation receipts belong to the independent operator; curator and bootstrap owner transaction counts stayed unchanged and their impersonation was disabled');
    report.checks.push('Curator and a different operator cannot mint the new operator name; genuine local manifests cannot become public directory pins');
    report.checks.push('Original bootstrap planning and receipt verification remain complete after another independently signed operator joins');
    for (const stage of stages) {
      const hash = stage.transactionHashes[0];
      await expect(verifyJoin({ config, stages, build, client: { ...client, getTransactionReceipt: async request => {
        const actual = await client.getTransactionReceipt(request);
        return request.hash === hash ? { ...actual, from: curator } : actual;
      } } })).rejects.toThrow(/receipt differs from the operator-signed intent/);
    }
    report.checks.push('Verifier rejects forged curator senders on resolver deployment, endpoint permission and registration receipts');
    const resolver = manifest.operators[0].resolver;
    for (const [target, name, key] of [[resolver, 'independent.derpc.eth', 'derpc.payee'], [ready.resolvers.bootstrap, 'bootstrap.derpc.eth', 'derpc.endpoint']]) {
      await expect(client.call({ account: hotKey, to: target, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(name), key, 'unauthorized'] }) })).rejects.toThrow(/revert/i);
    }
    for (const delegate of [hotKey, bootstrapHot]) {
      const roleSnapshot = await rpc('evm_snapshot');
      try {
        const setter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode('independent.derpc.eth'), 'unlisted.permission', ''] });
        await send({ from: operator, to: resolver, chainId: '0x1', value: '0x0', data: encodeFunctionData({ abi: resolverAbi, functionName: 'grantSetterRoles', args: [setter, delegate] }) });
        await expect(verifyJoin({ config, stages, client, build })).rejects.toThrow(/unexpected resolver authority/);
      } finally { expect(await rpc('evm_revert', [roleSnapshot])).toBe(true); }
    }
    report.checks.push('Endpoint key cannot change payee or another operator resolver; event audit rejects unknown text permissions granted to either the hot key or an unrelated delegate');
    for (const anchor of [manifest.observedBlock.number, stages[0].plan.preflight.blockNumber, manifest.transactions[0].blockNumber]) {
      let logsRead = false;
      await expect(verifyJoin({ config, stages, build, client: { ...client,
        getLogs: async request => { const events = await client.getLogs(request); logsRead = true; return events; },
        getBlock: async request => {
          const block = await client.getBlock(request);
          return logsRead && BigInt(request.blockNumber) === BigInt(anchor) ? { ...block, hash: `0x${'ff'.repeat(32)}` } : block;
        },
      } })).rejects.toThrow(/became noncanonical/);
    }
    report.checks.push('Injected administrative block-hash changes after log collection invalidate final, review and receipt anchors; this is a reorg-response fixture, not a real network reorg');
    report.complete = true;
  } finally {
    try {
      for (const account of actors) await rpc('anvil_stopImpersonatingAccount', [account]);
      expect(await rpc('evm_revert', [snapshot])).toBe(true);
    } finally {
      await rpc('anvil_setChainId', [31337]);
      report.restoredChainId = await client.getChainId();
      expect(report.restoredChainId).toBe(31337);
      expect((await client.getBlock()).hash).toBe(initialBlock.hash);
      report.restoredForkBlock = true;
      if (reportFile) writeFileSync(reportFile, json(report), { flag: 'wx' });
    }
  }
}, 240000);
