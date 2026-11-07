// Opt-in real Firefox + genuine ENS bytecode parity check. Only a guarded local
// Anvil fork is writable; browser core prepares/verifies and Node impersonates.
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { addresses, json, labelId, preflight, registryAbi } from '../scripts/ens-common.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { verifyDeployment } from '../scripts/ens-verify.mjs';
import * as joinAdapter from '../scripts/ens-join.mjs';
import * as lifecycleAdapter from '../scripts/ens-lifecycle.mjs';

const forkRpc = process.env.DERPC_ENS_BROWSER_CORE_FORK_RPC;
const root = fileURLToPath(new URL('../../', import.meta.url));
const canonical = value => JSON.parse(JSON.stringify(value, (key, item) =>
  ['createdAt', 'checkedAt', 'verifiedAt'].includes(key) ? undefined : typeof item === 'bigint' ? item.toString() : item));

it.skipIf(!forkRpc)('keeps browser and CLI enrollment/lifecycle intent equal on actual ENS contracts', async () => {
  const output = process.env.DERPC_ENS_BROWSER_CORE_REPORT;
  if (output && existsSync(output)) throw new Error('Choose a new report path; historical evidence must not be overwritten');
  const url = new URL(forkRpc);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('requires a credential-free loopback HTTP fork');
  const transport = http(forkRpc, { retryCount: 0, timeout: 30000 });
  const client = createPublicClient({ transport, pollingInterval: 20 });
  const rpc = (method, params = []) => client.request({ method, params });
  if (await client.getChainId() !== 31337) throw new Error('refusing any chain other than local 31337');
  const info = await rpc('anvil_nodeInfo');
  if (!info.forkConfig?.forkUrl || !info.forkConfig?.forkBlockNumber || !/anvil/i.test(await rpc('web3_clientVersion'))) throw new Error('requires a disposable Anvil mainnet fork');
  const initial = await client.getBlock();
  expect(initial.number).toBe(BigInt(info.forkConfig.forkBlockNumber));
  const build = registrarBuild();
  const sourceFiles = [
    ...readdirSync(join(root, 'contracts/lib')).filter(name => name.endsWith('.mjs')).map(name => `contracts/lib/${name}`),
    ...readdirSync(join(root, 'contracts/scripts')).filter(name => /^ens-.*\.mjs$/.test(name)).map(name => `contracts/scripts/${name}`),
    'contracts/src/OperatorRegistrar.sol', 'contracts/deployments/ens-upstream-mainnet.json',
    'contracts/test/ens-browser-core-fork.test.mjs', 'provider/src/operators/endpoints.ts', 'provider/src/operators/endpoint.ts', 'pnpm-lock.yaml',
  ].sort();
  const hashes = () => Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const sourcesBefore = hashes();
  const report = {
    schemaVersion: 1, kind: 'derpc-ens-browser-core-fork', checkedAt: new Date().toISOString(), complete: false,
    localOnly: true, publicTransactionsSent: false, sourceHash: build.sourceHash, compiler: build.compiler,
    scope: 'Actual Firefox executes the extracted browser core against genuine ENS contracts on a disposable local fork. Node submits only reviewed requests by local impersonation. Fictitious operators and .example endpoints; no public registration, wallet UI, anonymous transport or consensus-proof claim.',
    fork: { blockNumber: initial.number, blockHash: initial.hash }, stages: [], lifecycle: [], checks: [],
    pageErrors: [], blockedBrowserRequests: [], sourcesBefore,
  };
  const snapshot = await rpc('evm_snapshot');
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const parent = await read(addresses.ETHRegistry, registryAbi, 'getState', [labelId('derpc')]);
  const curator = parent.latestOwner;
  const [deployer, bootstrapOwner, bootstrapHot, operator, hotKey] = [1, 2, 3, 4, 5].map(n => getAddress(`0x${(0xdec100n + BigInt(n)).toString(16).padStart(40, '0')}`));
  const fixtures = [deployer, bootstrapOwner, bootstrapHot, operator, hotKey], actors = [curator, ...fixtures];
  expect(fixtures.map(a => a.toLowerCase())).not.toContain(curator.toLowerCase());
  const receipt = async hash => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { return await client.getTransactionReceipt({ hash }); }
      catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local transaction was not mined');
  };
  const send = async tx => {
    expect(tx.value).toBe('0x0'); expect(tx.chainId).toBe('0x1'); expect(actors).toContain(tx.from);
    const wallet = createWalletClient({ account: tx.from, transport });
    const hash = await wallet.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: 0n, gas: 8_000_000n,
      ...(tx.nonce === undefined ? {} : { nonce: Number(BigInt(tx.nonce)) }) });
    expect((await receipt(hash)).status).toBe('success');
    return hash;
  };
  const confirm = async () => { for (let i = 0; i < 12; i++) await rpc('evm_mine'); };
  let temporary, server, browser;
  try {
    await rpc('anvil_setChainId', [1]);
    for (const account of actors) {
      await rpc('anvil_impersonateAccount', [account]); await rpc('anvil_setBalance', [account, '0x56bc75e2d63100000']);
    }
    for (const account of fixtures) await rpc('anvil_setCode', [account, '0x']);
    const expiry = Number(initial.timestamp) + 7200;
    const entry = (label, owner, updater) => ({ label, operator: owner, coldOwner: owner, hotKey: updater, signer: owner, payee: owner,
      endpoint: `https://${label}.example/rpc`, expiry, caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'] } });
    let config = { schemaVersion: 1, chainId: 1, parentName: 'derpc.eth', curator, deployer,
      deploymentId: 'browser-core-local-bootstrap', operators: [entry('browser-bootstrap', bootstrapOwner, bootstrapHot)] };
    const bootstrapStages = [];
    let bootstrapComplete = false;
    for (let round = 0; round < 8; round++) {
      const plan = await preparePlan({ config, client, build }); config = plan.resumeConfig;
      if (plan.status === 'state-matches-config') { bootstrapComplete = true; break; }
      const transactionHashes = [];
      for (const item of plan.transactions) transactionHashes.push(await send(item.walletRequest.params[0]));
      bootstrapStages.push({ plan, transactionHashes });
    }
    expect(bootstrapComplete).toBe(true); await confirm();
    const deployment = await verifyDeployment({ config, stages: bootstrapStages, client, build });
    expect(deployment.localOnly).toBe(true);
    const joinConfig = joinAdapter.validateJoinConfig({ schemaVersion: 1, kind: 'derpc-ens-join-config', chainId: 1, parentName: 'derpc.eth',
      deploymentId: 'browser-core-local-operator', curator, operators: [entry('browser-independent', operator, hotKey)],
      directory: { chainId: 1, ethRegistry: addresses.ETHRegistry,
        registrar: { address: deployment.registrar.address, codeHash: deployment.registrar.codeHash, registry: deployment.subregistry } } });
    const curatorNonce = await client.getTransactionCount({ address: curator });
    for (const account of [curator, deployer, bootstrapOwner]) await rpc('anvil_stopImpersonatingAccount', [account]);

    const { createServer } = await import('../../frontend/node_modules/vite/dist/node/index.js');
    const puppeteer = (await import('../../wrapper/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).default;
    const lifecycle = await import('../lib/ens-lifecycle.mjs');
    temporary = mkdtempSync('/tmp/derpc-ens-browser-core-');
    writeFileSync(join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>ENS browser core test</title><script type="module" src="/main.js"></script>');
    writeFileSync(join(temporary, 'main.js'), `
      import * as join from ${JSON.stringify(resolve(root, 'contracts/lib/ens-join.mjs'))};
      import * as lifecycle from ${JSON.stringify(resolve(root, 'contracts/lib/ens-lifecycle.mjs'))};
      import { createPublicClient, http } from ${JSON.stringify(resolve(root, 'contracts/node_modules/viem/_esm/index.js'))};
      const modules = { join, lifecycle };
      const client = createPublicClient({ transport: http(${JSON.stringify(forkRpc)}, { retryCount: 0, timeout: 30000 }) });
      window.ensCall = async ({ module, method, args, build }) => JSON.stringify(await modules[module][method]({ ...args, client, build }), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    `);
    server = await createServer({ configFile: false, root: temporary, cacheDir: join(temporary, 'cache'), logLevel: 'warn', optimizeDeps: { include: [] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, temporary] } } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox', headless: true, protocolTimeout: 120000 });
    report.browser = await browser.version();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const requestUrl = request.url();
      if (/^https?:/.test(requestUrl) && ![origin, url.origin].includes(new URL(requestUrl).origin)) {
        report.blockedBrowserRequests.push(requestUrl); void request.abort(); return;
      }
      void request.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.ensCall === 'function', { timeout: 30000 });
    expect(await page.evaluate(() => ({ process: typeof process, Buffer: typeof Buffer, require: typeof require }))).toEqual({ process: 'undefined', Buffer: 'undefined', require: 'undefined' });
    const browserCall = async (module, method, args) => JSON.parse(await page.evaluate(input => window.ensCall(input), JSON.parse(json({ module, method, args, build }))));
    const stages = [];
    for (const stage of ['deploy-operator-resolver', 'configure-operator-endpoint-key', 'register-operator']) {
      const args = { config: joinConfig, snapshot: await preflight(client) };
      const plan = await browserCall('join', 'prepareJoinPlan', args);
      const adapted = await joinAdapter.prepareJoinPlan({ ...args, client, build });
      expect(canonical(plan)).toEqual(canonical(adapted)); expect(plan.stage).toBe(stage);
      expect(plan.transactions).toHaveLength(1);
      const tx = plan.transactions[0].walletRequest.params[0]; expect(tx.from).toBe(operator);
      const hash = await send(tx);
      stages.push({ plan, transactionHashes: [hash] });
      report.stages.push({ stage, id: plan.transactions[0].id, from: tx.from, transactionHash: hash });
    }
    await confirm();
    const enrollment = await browserCall('join', 'verifyJoin', { config: joinConfig, stages });
    expect(canonical(enrollment)).toEqual(canonical(await joinAdapter.verifyJoin({ config: joinConfig, stages, client, build })));
    expect(enrollment.localOnly).toBe(true); expect(enrollment.verification.operatorSigned).toBe(true);
    expect(enrollment.enrollmentEvidence.stages).toHaveLength(3);
    report.checks.push('Firefox imported browser cores without Node globals; all three operator-signed join plans and verified receipts exactly matched the Node adapters');

    const actions = [
      { type: 'renew', label: 'browser-independent', expectedExpiry: expiry, expiry: expiry + 3600, authority: 'operator' },
      { type: 'rotate-endpoint', label: 'browser-independent', expectedEndpoint: 'https://browser-independent.example/rpc', newEndpoint: 'https://browser-independent.example/rpc-updated' },
    ];
    for (const action of actions) {
      const args = { deployment, enrollment, action };
      const plan = await browserCall('lifecycle', 'prepareOperatorLifecycle', args);
      expect(canonical(plan)).toEqual(canonical(await lifecycle.prepareOperatorLifecycle({ ...args, client, build })));
      const manifest = await lifecycle.resolveOperatorLifecycleManifest({ deployment, enrollment, client, build });
      expect(canonical(plan)).toEqual(canonical(await lifecycleAdapter.prepareLifecycle({ manifest, action, client, build })));
      const recheck = await browserCall('lifecycle', 'checkOperatorLifecyclePlan', { deployment, enrollment, plan });
      expect(recheck.stateStillMatches).toBe(true);
      expect(canonical(recheck)).toEqual(canonical(await lifecycleAdapter.checkLifecyclePlan({ manifest, plan, client, build })));
      const tx = plan.walletRequest.params[0]; expect(tx.from).toBe(action.type === 'renew' ? operator : hotKey);
      const hash = await send(tx); await confirm();
      const verifyArgs = { deployment, enrollment, plan, transactionHash: hash };
      const evidence = await browserCall('lifecycle', 'verifyOperatorLifecycle', verifyArgs);
      expect(canonical(evidence)).toEqual(canonical(await lifecycle.verifyOperatorLifecycle({ ...verifyArgs, client, build })));
      expect(canonical(evidence)).toEqual(canonical(await lifecycleAdapter.verifyLifecycle({ manifest, plan, transactionHash: hash, client, build })));
      expect(evidence.localOnly).toBe(true); expect(evidence.verification.exactRequest).toBe(true);
      if (action.type === 'renew') expect(evidence.after.entry.expiry).toBe(expiry + 3600);
      else {
        expect(evidence.after.records['derpc.endpoint']).toBe(action.newEndpoint);
        expect(evidence.after.entry.expiry).toBe(expiry + 3600);
      }
      report.lifecycle.push({ action, from: tx.from, transactionHash: hash, receipt: evidence.receipt, verification: evidence.verification });
    }
    expect(await client.getTransactionCount({ address: curator })).toBe(curatorNonce);
    expect(report.pageErrors).toEqual([]); expect(report.blockedBrowserRequests).toEqual([]);
    report.checks.push('Independent operator renewed its live lease; its scoped updater changed only the endpoint after renewal; browser and Node lifecycle requests, rechecks and canonical evidence matched');
    report.checks.push('Curator stayed idle after bootstrap; browser requested only its temporary local assets and the guarded loopback administrative fork');
    report.complete = true;
  } finally {
    await browser?.close(); await server?.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    try {
      for (const account of actors) await rpc('anvil_stopImpersonatingAccount', [account]);
      expect(await rpc('evm_revert', [snapshot])).toBe(true);
    } finally {
      await rpc('anvil_setChainId', [31337]);
      report.restoredChainId = await client.getChainId();
      expect(report.restoredChainId).toBe(31337); expect((await client.getBlock()).hash).toBe(initial.hash);
      report.restoredForkBlock = true;
      report.sourcesAfter = hashes();
      report.changedSources = sourceFiles.filter(path => sourcesBefore[path] !== report.sourcesAfter[path]);
      expect(report.changedSources).toEqual([]);
      if (output) writeFileSync(output, json(report), { flag: 'wx' });
    }
  }
}, 240000);
