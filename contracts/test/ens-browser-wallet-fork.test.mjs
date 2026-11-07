// Opt-in actual website wallet panel + genuine ENS bytecode integration.
// Test-only configuration and wallet proxy can write only to guarded local Anvil.
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { addresses, json, labelId, preflight, registryAbi } from '../scripts/ens-common.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { verifyDeployment } from '../scripts/ens-verify.mjs';

const forkRpc = process.env.DERPC_ENS_BROWSER_WALLET_FORK_RPC;
const root = fileURLToPath(new URL('../../', import.meta.url));

it.skipIf(!forkRpc)('runs the website wallet panel through registration recovery and independent management', async () => {
  const output = process.env.DERPC_ENS_BROWSER_WALLET_REPORT;
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
    'contracts/test/ens-browser-wallet-fork.test.mjs', 'web/src/ens/panel.ts', 'web/src/ens/runtime.ts', 'web/src/ens/configured.ts', 'web/src/ens/session.ts', 'web/src/ens/wallet.css', 'provider/src/operators/endpoints.ts', 'provider/src/operators/endpoint.ts', 'pnpm-lock.yaml',
  ].sort();
  const hashes = () => Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const sourcesBefore = hashes();
  const report = {
    schemaVersion: 1, kind: 'derpc-ens-browser-wallet-fork', checkedAt: new Date().toISOString(), complete: false,
    localOnly: true, publicTransactionsSent: false, sourceHash: build.sourceHash, compiler: build.compiler,
    scope: 'Actual website wallet panel/runtime/session in Firefox, genuine ENS contracts on a disposable local fork, injected local wallet only. Test-only virtual config relabels the local manifest public and proxies two administrative origins to one guarded fork. This tests UI/journal/contract integration, not public deployment, source independence, extension integration, anonymity or consensus.',
    fork: { blockNumber: initial.number, blockHash: initial.hash }, stages: [], lifecycle: [], checks: [],
    pageErrors: [], blockedBrowserRequests: [], sourcesBefore,
  };
  const snapshot = await rpc('evm_snapshot');
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const parent = await read(addresses.ETHRegistry, registryAbi, 'getState', [labelId('derpc')]);
  const curator = parent.latestOwner;
  const [deployer, bootstrapOwner, bootstrapHot, operator, hotKey] = [1, 2, 3, 4, 5].map(n => getAddress(`0x${(0xdec200n + BigInt(n)).toString(16).padStart(40, '0')}`));
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
      deploymentId: 'browser-wallet-local-bootstrap', operators: [entry('wallet-bootstrap', bootstrapOwner, bootstrapHot)] };
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

    const operatorEntry = entry('wallet-independent', operator, hotKey);
    const curatorNonce = await client.getTransactionCount({ address: curator });
    for (const account of [curator, deployer, bootstrapOwner]) await rpc('anvil_stopImpersonatingAccount', [account]);
    const { createServer } = await import('../../frontend/node_modules/vite/dist/node/index.js');
    const puppeteer = (await import('../../wrapper/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).default;
    temporary = mkdtempSync('/tmp/derpc-ens-browser-wallet-');
    const adminUrls = ['https://admin-a.example', 'https://admin-b.example'];
    // This is deliberately test-only classification. Neither manifest nor URLs are production configuration.
    const configured = { deployment: JSON.parse(json({ ...deployment, localOnly: false })), build, adminRpcUrls: adminUrls };
    writeFileSync(join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Local ENS wallet integration fixture</title><main id="fixture"></main><script type="module" src="/main.js"></script>');
    writeFileSync(join(temporary, 'main.js'), `
      import { operatorWalletHtml, mountOperatorWallet } from ${JSON.stringify(resolve(root, 'web/src/ens/panel.ts'))};
      import { savedBrowserSession } from ${JSON.stringify(resolve(root, 'web/src/ens/session.ts'))};
      const element = document.querySelector('#fixture'); element.innerHTML = operatorWalletHtml();
      window.readEnsSession = () => savedBrowserSession(localStorage);
      mountOperatorWallet(element, { operator: () => (${JSON.stringify(operatorEntry)}) });
    `);
    const virtual = 'virtual:derpc-ens-operator';
    server = await createServer({ configFile: false, root: temporary, cacheDir: join(temporary, 'cache'), logLevel: 'warn', optimizeDeps: { include: [] },
      plugins: [{ name: 'explicit-local-ens-fixture', resolveId: id => id === virtual ? `\0${virtual}` : undefined,
        load: id => id === `\0${virtual}` ? `export default ${json(configured)};` : undefined }],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, temporary] } } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox', headless: true, protocolTimeout: 120000 });
    report.browser = await browser.version();
    report.adminFixture = { origins: adminUrls, upstreams: 1, sourceIndependenceTested: false };
    report.walletSends = [];
    report.timings = [];
    const page = await browser.newPage();
    const administrativeOrigins = new Set();
    await page.exposeFunction('localFixtureAdmin', async ({ url: requestedUrl, body: encoded }) => {
      const requestedOrigin = new URL(requestedUrl).origin;
      if (!adminUrls.includes(requestedOrigin)) throw new Error('Unexpected administrative fixture origin');
      administrativeOrigins.add(requestedOrigin);
      const body = JSON.parse(encoded);
      if (Array.isArray(body) || !/^eth_(?:call|estimateGas|chainId|get[A-Za-z]+|maxPriorityFeePerGas|feeHistory)$/.test(body.method)) throw new Error('The administrative fixture refuses mutation');
      const response = await fetch(forkRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.text() };
    });
    let walletAccount = operator, loseFirstResponse = true;
    await page.exposeFunction('localFixtureWallet', async request => {
      if (['eth_requestAccounts', 'eth_accounts'].includes(request.method)) return { value: [walletAccount] };
      if (request.method === 'eth_chainId') return { value: await rpc('eth_chainId') };
      if (request.method === 'wallet_switchEthereumChain') { expect(request.params).toEqual([{ chainId: '0x1' }]); return { value: null }; }
      if (request.method !== 'eth_sendTransaction') throw new Error('Unsupported fixture wallet request');
      const tx = request.params[0]; expect(tx.from.toLowerCase()).toBe(walletAccount.toLowerCase());
      const hash = await send(tx);
      report.walletSends.push({ from: tx.from, to: tx.to, hash });
      if (loseFirstResponse) { loseFirstResponse = false; return { error: 'Injected loss of wallet response after the local transaction mined' }; }
      return { value: hash };
    });
    await page.evaluateOnNewDocument(adminUrls => {
      // Only this disposable fixture redirects the two explicit administrative sources.
      // No production module, transport configuration or CORS policy is changed.
      const ordinaryFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (!adminUrls.includes(new URL(request.url).origin)) return ordinaryFetch(input, init);
        if (request.method !== 'POST') throw new Error('Unexpected fixture HTTP method');
        const result = await window.localFixtureAdmin({ url: request.url, body: await request.text() });
        return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
      };
      const listeners = new Map();
      window.ethereum = { isMetaMask: true,
        request: async request => { const result = await window.localFixtureWallet(request); if (result.error) throw new Error(result.error); return result.value; },
        on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        removeListener: (event, fn) => listeners.get(event)?.delete(fn),
      };
      window.changeFixtureWallet = account => { for (const fn of listeners.get('accountsChanged') ?? []) fn([account]); };
    }, adminUrls);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        const requestUrl = request.url(), requestedOrigin = /^https?:/.test(requestUrl) ? new URL(requestUrl).origin : null;
        if (requestedOrigin && requestedOrigin !== origin) { report.blockedBrowserRequests.push(requestUrl); await request.abort(); return; }
        await request.continue();
      })().catch(error => { report.pageErrors.push(error.message); void request.abort(); });
    });
    const ready = () => page.waitForFunction(() => window.readEnsSession && !document.querySelector('#ens-prepare-join').disabled, { timeout: 30000 });
    const waitStage = async stage => {
      try { await page.waitForFunction(stage => document.querySelector('#ens-stage-title').textContent.includes(stage), { timeout: 120000 }, stage); }
      catch { throw new Error(`Waiting for ${stage}: ${await page.$eval('#ens-web-message', element => element.textContent)}`); }
    };
    const journal = () => page.evaluate(() => window.readEnsSession());
    const field = (id, value) => page.evaluate(({ id, value }) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, { id, value });
    const reviewAndSend = async () => {
      const started = Date.now();
      const before = report.walletSends.length;
      await page.click('#ens-transaction-list button');
      const review = await page.$eval('#ens-transaction-summary', element => element.textContent);
      expect(review).toContain('Estimated gas'); expect(review).toContain('0 ETH');
      const plan = await page.$eval('#ens-exact-plan', element => JSON.parse(element.textContent));
      expect(BigInt(plan.transactions[0].estimatedGas)).toBeGreaterThan(0n);
      expect(await page.$eval('#ens-web-send', element => element.disabled)).toBe(true);
      await page.click('#ens-web-connect');
      await page.waitForFunction(() => !document.querySelector('#ens-web-reviewed').disabled, { timeout: 30000 });
      expect(await page.$eval('#ens-web-send', element => element.disabled)).toBe(true);
      await page.click('#ens-web-reviewed'); await page.click('#ens-web-send');
      try { await page.waitForFunction(() => !document.querySelector('#ens-web-refresh').disabled, { timeout: 120000 }); }
      catch { throw new Error(`Wallet action did not finish: ${await page.$eval('#ens-web-message', element => element.textContent)}`); }
      expect(report.walletSends).toHaveLength(before + 1);
      report.timings.push({ phase: 'review-recheck-send', transaction: before + 1, elapsedMs: Date.now() - started });
    };
    const refresh = async () => { await page.click('#ens-web-refresh'); await page.waitForFunction(() => !document.querySelector('#ens-web-refresh').disabled, { timeout: 120000 }); };
    const verify = async () => { await page.click('#ens-web-verify'); await page.waitForFunction(() => !document.querySelector('#ens-download-evidence').disabled, { timeout: 120000 }); return (await journal()).manifest; };
    await page.goto(origin); await ready();
    expect(report.walletSends).toHaveLength(0);
    await page.click('#ens-prepare-join'); await waitStage('deploy-operator-resolver');
    await reviewAndSend();
    expect((await journal()).stages[0].entries[0].status).toBe('pending');
    const firstHash = report.walletSends[0].hash;
    await page.reload(); await ready(); await page.click('#ens-resume'); await waitStage('deploy-operator-resolver');
    await page.click('#ens-transaction-list button');
    expect(await page.$eval('#ens-web-send', element => element.disabled)).toBe(true);
    expect(report.walletSends).toHaveLength(1);
    await field('ens-web-reconcile-hash', firstHash); await page.click('#ens-web-reconcile');
    await page.waitForFunction(() => window.readEnsSession().stages[0].entries[0].status === 'confirmed', { timeout: 30000 });
    await refresh(); await waitStage('configure-operator-endpoint-key'); await reviewAndSend();
    await refresh(); await waitStage('register-operator'); await reviewAndSend();
    expect(report.walletSends).toHaveLength(3);
    await refresh(); await waitStage('Ready for final verification');
    await page.click('#ens-web-verify');
    await page.waitForFunction(() => document.querySelector('#ens-web-message').textContent.includes('confirmations'), { timeout: 30000 });
    expect((await journal()).manifest).toBeNull();
    await confirm(); await refresh();
    const enrollment = await verify();
    expect(enrollment.verification.operatorSigned).toBe(true);
    expect(enrollment.transactions.every(tx => tx.from.toLowerCase() === operator.toLowerCase())).toBe(true);
    report.stages = enrollment.transactions.map(tx => ({ id: tx.id, from: tx.from, hash: tx.transactionHash, confirmations: tx.confirmations }));
    report.checks.push('Real wallet panel requires account connection and explicit gas/request review for all three operator-signed stages');
    report.checks.push('A lost wallet response remains pending after reload; resume prevents a duplicate send and accepts only reconciliation of the mined original hash');
    report.checks.push('Enrollment verification refuses fewer than twelve confirmations and succeeds after twelve local blocks on both proxied administrative clients');
    writeFileSync(join(temporary, 'enrollment.json'), json(enrollment));
    await page.click('#ens-archive'); await page.waitForFunction(() => window.readEnsSession() === null);
    await page.$eval('#ens-management', element => { element.open = true; });
    await (await page.$('#ens-enrollment-file')).uploadFile(join(temporary, 'enrollment.json'));
    await page.waitForFunction(() => document.querySelector('#ens-managed-operator').value === 'wallet-independent.derpc.eth', { timeout: 30000 });
    await field('ens-renew-expiry', new Date((expiry + 3600) * 1000).toISOString().slice(0, 19));
    await page.click('#ens-prepare-management'); await waitStage('renew'); await reviewAndSend(); await confirm(); await refresh();
    const renewed = await verify();
    expect(renewed.after.entry.expiry).toBe(expiry + 3600); expect(renewed.receipt.from.toLowerCase()).toBe(operator.toLowerCase());
    report.lifecycle.push({ action: renewed.action, receipt: renewed.receipt, verification: renewed.verification });
    await page.click('#ens-archive'); await page.waitForFunction(() => window.readEnsSession() === null);
    walletAccount = hotKey; await page.evaluate(account => window.changeFixtureWallet(account), hotKey);
    await page.select('#ens-management-kind', 'endpoint');
    await field('ens-new-endpoint', 'https://wallet-independent.example/rpc-updated');
    await page.click('#ens-prepare-management'); await waitStage('rotate-endpoint'); await reviewAndSend(); await confirm(); await refresh();
    const rotated = await verify();
    expect(rotated.after.records['derpc.endpoint']).toBe('https://wallet-independent.example/rpc-updated');
    expect(rotated.after.entry.expiry).toBe(expiry + 3600); expect(rotated.receipt.from.toLowerCase()).toBe(hotKey.toLowerCase());
    report.lifecycle.push({ action: rotated.action, receipt: rotated.receipt, verification: rotated.verification });
    expect(report.walletSends).toHaveLength(5);
    expect([...administrativeOrigins].sort()).toEqual([...adminUrls].sort());
    expect(await client.getTransactionCount({ address: curator })).toBe(curatorNonce);
    expect(report.pageErrors).toEqual([]); expect(report.blockedBrowserRequests).toEqual([]);
    report.checks.push('Imported enrollment is reverified by the real runtime before operator renewal and scoped-key endpoint change; the curator remains idle and the renewal survives rotation');
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
}, 600000);
