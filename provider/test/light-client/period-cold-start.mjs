// Manual live-network check; this is deliberately outside the offline Vitest suite.
// DERPC_TEST_GATEWAY=<KPS address> node provider/test/light-client/period-cold-start.mjs --preflight --report /tmp/preflight.json
// Run a NEW process with --live only after 2026-11-06T19:53:59Z. Preflight can never close the boundary gate.
import { createServer } from '../../../frontend/node_modules/vite/dist/node/index.js';
import puppeteer from '../../../wrapper/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const mode = args.includes('--live') ? 'live' : args.includes('--preflight') ? 'preflight' : null;
if (!mode || args.includes('--live') && args.includes('--preflight')) throw Error('Choose exactly one of --preflight or --live');
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--report') { if (!args[++index]) throw Error('--report needs a file path'); }
  else if (!['--live', '--preflight'].includes(args[index])) throw Error(`Unknown argument: ${args[index]}`);
}
const root = fileURLToPath(new URL('../../..', import.meta.url));
const output = resolve(args.includes('--report') ? args[args.indexOf('--report') + 1] : `/tmp/derpc-period-cold-start-${mode}.json`);
const gateway = process.env.DERPC_TEST_GATEWAY;
if (!gateway) throw Error('DERPC_TEST_GATEWAY is required; no environment files are read or changed');
const urls = (name, defaults) => {
  const values = process.env[name] ? JSON.parse(process.env[name]) : defaults;
  if (!Array.isArray(values) || !values.length) throw Error(`${name} must be a nonempty JSON URL array`);
  return values.map(value => {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error(`${name} must contain public endpoints without credentials, query or fragment`);
    return url.href.replace(/\/$/, '');
  });
};
const beacons = urls('DERPC_TEST_BEACON_URLS', ['https://ethereum-beacon-api.publicnode.com', 'https://lodestar-mainnet.chainsafe.io']);
const rpcs = urls('DERPC_TEST_RPC_URLS', ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth.blockrazor.xyz']);
const boundaryMs = (1606824023 + 1904 * 8192 * 12) * 1000;
if (mode === 'live' && Date.now() < boundaryMs) throw Error(`Too early: the real period-1904 boundary is ${new Date(boundaryMs).toISOString()}`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = readdirSync(join(root, 'provider/src'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => join(entry.parentPath, entry.name).slice(root.length));
const paths = [...sourceFiles, 'provider/test/light-client/period-cold-start.mjs', 'provider/test/light-client/period-cold-start.browser.mjs',
  'provider/test/light-client/forced-update.test.ts', 'patches/@lodestar__light-client@1.43.0.patch', 'pnpm-lock.yaml',
  'provider/node_modules/@lodestar/light-client/lib/index.js', 'provider/node_modules/@lodestar/light-client/lib/spec/processLightClientUpdate.js',
  'provider/node_modules/@lodestar/light-client/lib/spec/validateLightClientUpdate.js', 'provider/node_modules/@lodestar/light-client/lib/spec/utils.js'];
const hashes = () => Object.fromEntries(paths.sort().map(path => [path, hash(readFileSync(join(root, path)))]));
const report = { kind: 'period-1904-cold-start', mode, startedAt: new Date().toISOString(), boundaryAt: new Date(boundaryMs).toISOString(),
  runtime: 'Fresh Firefox profile, isolated temporary Vite cache and page, real pinned tor-js worker',
  gatewaySha256: hash(gateway), beacons, rpcs, sourcesBefore: hashes(), progress: [],
  qualifications: ['No synthetic clock, refreshed checkpoint, preloaded committee or verifier bypass.',
    'Observer wrappers invoke the original verifier methods unchanged; fetched response summaries alone never establish acceptance.',
    'A finalized header can legitimately remain in period 1903 near the boundary; its actual slot and period are disclosed.',
    'This tests the existing gateway and selected endpoints, not public hosting or independence.',
    'Production startup, freshness, response and pool timeout settings remain unchanged. Harness bounds only stop the observation.',
    'All execution and beacon requests must use the anonymous worker. Public bundle-only resolver fallbacks remain allowed.'] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const temporary = mkdtempSync('/tmp/derpc-period-cold-start-');
const browserSource = join(root, 'provider/test/light-client/period-cold-start.browser.mjs');
writeFileSync(join(temporary, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Period cold-start verification</title><script type="module" src="/main.js"></script>');
writeFileSync(join(temporary, 'main.js'), `import { runPeriodColdStart } from ${JSON.stringify(browserSource)}; window.runPeriodColdStart = runPeriodColdStart;`);
const bundleUrls = new Set(['https://cdn.jsdelivr.net/npm/tor-js@0.4.4/dist/anon-rpc-worker.js', 'https://unpkg.com/tor-js@0.4.4/dist/anon-rpc-worker.js',
  'https://raw.githubusercontent.com/ethereum/tor-js/keccak/5b/62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b']);
let server, browser;
try {
  server = await createServer({ configFile: false, root: temporary, cacheDir: join(temporary, 'cache'), logLevel: 'warn',
    resolve: { alias: [{ find: /^@chainsafe\/bls$/, replacement: '@chainsafe/bls/herumi' }] },
    optimizeDeps: { include: [] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, temporary] } },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox', headless: true, protocolTimeout: 330000 });
  report.browserVersion = await browser.version();
  report.browserLaunchedAt = new Date().toISOString();
  const page = await browser.newPage();
  report.externalBrowserRequests = [];
  report.blockedDirectRequests = [];
  report.pageErrors = [];
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.exposeFunction('periodProgress', entry => { report.progress.push(entry); save(); console.log(JSON.stringify(entry)); });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) {
      report.externalBrowserRequests.push(url);
      if (!bundleUrls.has(url)) { report.blockedDirectRequests.push(url); void request.abort(); return; }
    }
    void request.continue();
  });
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.runPeriodColdStart === 'function', { timeout: 45000 });
  report.result = await page.evaluate(options => window.runPeriodColdStart(options), { mode, gateway, beacons, rpcs });
  const outcome = report.result.outcome;
  report.noDirectRpcOrBeacon = report.blockedDirectRequests.length === 0 && report.externalBrowserRequests.every(url => bundleUrls.has(url));
  report.ok = outcome.functionalPass && outcome.pin?.state === 'verified' && report.noDirectRpcOrBeacon &&
    outcome.close.callsAfterClose === 0 && outcome.close.iframeCount === 0 && outcome.close.refusal?.name === 'TransportUnavailableError' &&
    (mode === 'preflight' || outcome.boundaryValidated);
  report.boundaryValidated = mode === 'live' && report.ok && outcome.boundaryValidated;
} catch (error) { report.error = { name: error.name, message: error.message }; report.ok = false; report.boundaryValidated = false; }
finally {
  await browser?.close();
  await server?.close();
  rmSync(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.sourcesAfter = hashes();
  report.changedSources = paths.filter(path => report.sourcesBefore[path] !== report.sourcesAfter[path]);
  if (report.changedSources.length) { report.ok = false; report.boundaryValidated = false; }
  save();
  console.log(JSON.stringify({ ok: report.ok, boundaryValidated: report.boundaryValidated, mode, error: report.error, outcome: report.result?.outcome,
    noDirectRpcOrBeacon: report.noDirectRpcOrBeacon, changedSources: report.changedSources, report: output }, null, 2));
  if (!report.ok) process.exitCode = 1;
}
