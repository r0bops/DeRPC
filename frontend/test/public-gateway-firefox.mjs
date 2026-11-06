// Live, opt-in production-browser check. Run after building/pinning the release:
// DERPC_TEST_BASE_URL='https://gateway.example/ipfs/CID' node frontend/test/public-gateway-firefox.mjs
// DERPC_TEST_OUTPUT_PREFIX controls /tmp report/screenshot paths; DERPC_TEST_REPORT_PATH can save
// the JSON separately. Uses real public WETH fixtures, never a wallet or transaction.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../wrapper/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer-core'));
const supplied = process.env.DERPC_TEST_BASE_URL;
if (!supplied) throw new Error('Set DERPC_TEST_BASE_URL to the assembled production site root (HTTPS or localhost).');
const parsedBase = new URL(supplied);
if (!/^https?:$/.test(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
  throw new Error('DERPC_TEST_BASE_URL must be an HTTP(S) site root without credentials, query or fragment.');
}
const base = parsedBase.href.replace(/\/+$/, '');
const output = process.env.DERPC_TEST_OUTPUT_PREFIX ?? '/tmp/derpc-vps-browser';
const reportPath = process.env.DERPC_TEST_REPORT_PATH ?? `${output}.json`;
const checkerSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const allowedBundles = new Set([
  'https://cdn.jsdelivr.net/npm/tor-js@0.4.4/dist/anon-rpc-worker.js',
  'https://unpkg.com/tor-js@0.4.4/dist/anon-rpc-worker.js',
  'https://raw.githubusercontent.com/ethereum/tor-js/keccak/5b/62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b',
]);
const executionAndBeaconHosts = new Set([
  'ethereum-rpc.publicnode.com', 'eth.drpc.org', 'rpc.mevblocker.io', 'eth.blockrazor.xyz',
  'eth-mainnet.public.blastapi.io', 'ethereum-beacon-api.publicnode.com',
  'lodestar-mainnet.chainsafe.io', 'www.lightclientdata.org',
]);
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), base,
  checker: { path: 'frontend/test/public-gateway-firefox.mjs', sha256: checkerSha256 },
  scope: 'Fresh Firefox visiting the assembled production site; public WETH/Uniswap fixtures only; no wallet or transaction.',
  siteDelivery: parsedBase.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(parsedBase.hostname)
    ? (parsedBase.pathname.startsWith('/ipfs/')
      ? 'Local HTTP Kubo gateway serving the release CID. This checks IPFS path packaging and public VPS RPC transport; external HTTPS gateway/derpc.eth.limo validation remains pending.'
      : 'Local HTTP preview of the production static release. This checks public VPS RPC transport; external HTTPS gateway/derpc.eth.limo validation remains pending.')
    : 'Remote site delivery; record the exact base URL and do not infer ENS publication from a generic IPFS gateway.',
  productionTimeoutOverrides: false, observationLimitMs: 180000,
  pages: [], observations: [], rtcObservations: [], httpRequests: [], httpErrors: [], requestFailures: [],
  pageErrors: [], console: [], gates: {},
  qualifications: [
    'Production timeout settings and worker configuration are unchanged; 180 seconds bounds this observation, not the application.',
    'External HTTP requests are observed through Firefox/Puppeteer events. This is not a packet capture or proof of all browser background traffic.',
    'The intended release configures only the VPS gateway. This checker requires its succeeded WebRTC candidate and refuses to pass if another working gateway is observed.',
    'Test-only RTCPeerConnection observation retains native peer references and inspects selected/nominated candidate-pair statistics in every accessible frame. It does not change ICE options, certificates, gateway configuration, or application deadlines.',
    'A successful candidate with received traffic proves the gateway connection. Sampled stats are not a complete packet capture; competing observed gateways prevent exclusive gateway attribution.',
    'Shutdown is checked through real UI refusal and an HTTP observation window; encrypted KPS packet counts are not exposed by this UI.',
  ],
};
let browser, page, timedOut = false;
let phase = 'initial';
let closePromise;
const started = Date.now();
const deadline = started + report.observationLimitMs;
const remaining = (maximum = 15000) => {
  const left = deadline - Date.now();
  if (left <= 0 || timedOut) throw new Error('The 180-second observation deadline elapsed.');
  return Math.max(1, Math.min(maximum, left));
};
const closeOwnedBrowser = () => {
  if (browser && !closePromise) closePromise = browser.close().then(() => { report.ownedBrowserClosed = true; });
  return closePromise;
};
const watchdog = setTimeout(() => {
  timedOut = true;
  void closeOwnedBrowser()?.catch(error => { report.cleanupError = String(error); });
}, report.observationLimitMs);
const readState = () => page.evaluate(() => {
  const text = id => document.getElementById(id)?.textContent ?? null;
  return {
    worker: text('worker-status'), lightClient: text('lc-status'), header: text('lc-header'),
    pin: text('pin-status'), choice: text('choice-status'), poolEvents: text('pool-events'),
    reads: [...document.querySelectorAll('#reads tr')].map(row => [...row.children].map(cell => ({ text: cell.textContent, class: cell.className }))),
    paymentsEnabled: document.getElementById('enable-payments')?.checked ?? null,
    paymentControlsDisabled: document.getElementById('payment-controls')?.disabled ?? null,
    readDisabled: document.getElementById('read-again')?.disabled ?? null,
    cutDisabled: document.getElementById('cut-network')?.disabled ?? null,
    liarDisabled: document.getElementById('inject-liar')?.disabled ?? null,
    developmentHandlePresent: '__derpc' in window, secureContext: isSecureContext,
    selectedOperators: [...document.querySelectorAll('#operators input:checked')].map(input => input.value),
  };
});
const hasProvenRows = state => state.reads.length === 4 && state.reads.slice(0, 3).every(row =>
  row[1]?.class === 'ok' && /verified at block \d+/.test(row[1].text));
const callRefused = state => state.reads.length === 4 && state.reads[3][1]?.class === 'warn' &&
  /refused as expected/.test(state.reads[3][1].text) && /4200/.test(state.reads[3][1].text);
const ready = state => /^ready\b/.test(state.worker ?? '') && /^verified\b/.test(state.lightClient ?? '') &&
  /^verified\b/.test(state.pin ?? '') && hasProvenRows(state) && callRefused(state) && state.readDisabled === false;
const snapshot = async () => {
  const state = await readState();
  report.lastState = state;
  const workerLog = await page.$eval('#worker-log', node => node.textContent ?? '').catch(() => '');
  report.workerLog = workerLog.slice(-64000);
  return state;
};
const collectRtc = async label => {
  const frames = await Promise.all(page.frames().map(async frame => {
    const url = frame.url();
    const frameUrl = url.startsWith('data:') ? '[data iframe]' : url.slice(0, 200);
    try {
      const result = await frame.evaluate(async () => {
        const state = globalThis[Symbol.for('derpc.qa.rtcPeers')];
        if (!state) return { instrumented: false, peers: [] };
        const peers = await Promise.all(state.peers.map(async (peer, index) => {
          const result = { index, connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState, selectedRemotePairs: [] };
          try {
            const stats = await peer.getStats();
            const selected = new Set([...stats.values()].filter(item => item.type === 'transport').map(item => item.selectedCandidatePairId).filter(Boolean));
            for (const pair of stats.values()) {
              if (pair.type !== 'candidate-pair' || pair.state !== 'succeeded' || !(pair.nominated || pair.selected || selected.has(pair.id))) continue;
              const remote = stats.get(pair.remoteCandidateId);
              result.selectedRemotePairs.push({
                pairId: pair.id, address: remote?.address ?? remote?.ip ?? null, port: remote?.port ?? null,
                protocol: remote?.protocol ?? null, candidateType: remote?.candidateType ?? null,
                state: pair.state, nominated: pair.nominated ?? null, selectedByTransport: selected.has(pair.id),
                bytesReceived: pair.bytesReceived ?? 0, bytesSent: pair.bytesSent ?? 0,
              });
            }
          } catch (error) { result.statsError = String(error).slice(0, 300); }
          return result;
        }));
        return { instrumented: true, peers };
      });
      return { frameUrl, ...result };
    } catch (error) { return { frameUrl, evaluationError: String(error).slice(0, 300) }; }
  }));
  const observation = { label, at: new Date().toISOString(), frames };
  report.rtcObservations.push(observation);
  return observation;
};
try {
  browser = await puppeteer.launch({
    browser: 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox',
    headless: true, protocolTimeout: 15000, timeout: remaining(20000),
  });
  report.browser = await browser.version();
  page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.evaluateOnNewDocument(() => {
    const NativePeer = globalThis.RTCPeerConnection;
    if (typeof NativePeer !== 'function') return;
    const key = Symbol.for('derpc.qa.rtcPeers');
    const state = { peers: [] };
    Object.defineProperty(globalThis, key, { value: state });
    const ObservedPeer = new Proxy(NativePeer, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        state.peers.push(peer);
        return peer;
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection');
    Object.defineProperty(globalThis, 'RTCPeerConnection', { ...descriptor, value: ObservedPeer });
  });
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', error => report.pageErrors.push({ phase, message: String(error).slice(0, 3000) }));
  page.on('console', message => {
    if (report.console.length < 2000) report.console.push({ phase, type: message.type(), text: message.text().slice(0, 3000) });
  });
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url)) report.httpRequests.push({ phase, at: new Date().toISOString(), method: request.method(), url });
  });
  page.on('response', response => {
    if (response.status() >= 400) report.httpErrors.push({ phase, url: response.url(), status: response.status() });
  });
  page.on('requestfailed', request => report.requestFailures.push({ phase, url: request.url(), error: request.failure()?.errorText ?? null }));
  let documentHttpStatus = null;
  for (const route of ['/', '/#/directory', '/#/operate']) {
    phase = `site:${route}`;
    const response = await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: remaining(30000) });
    if (response) documentHttpStatus = response.status();
    await page.waitForFunction(() => document.querySelectorAll('h1,h2').length > 0, { timeout: remaining() });
    await delay(150);
    report.pages.push({ route, status: documentHttpStatus, sameDocumentNavigation: response === null, ...await page.evaluate(() => ({
      title: document.title, headings: [...document.querySelectorAll('h1,h2')].map(node => node.textContent),
      overflow: document.documentElement.scrollWidth > innerWidth,
    })) });
  }
  phase = 'boot-and-read';
  const response = await page.goto(base + '/demo/', { waitUntil: 'domcontentloaded', timeout: remaining(30000) });
  report.demoHttpStatus = response?.status() ?? null;
  await page.waitForSelector('#operators input[value="mevblocker.derpc.eth"]', { timeout: remaining(20000) });
  const fixtureOperators = ['mevblocker.derpc.eth', 'blockrazor.derpc.eth'];
  report.initialState = await readState();
  await collectRtc('before-selection');
  if (report.initialState.selectedOperators.length) throw new Error('Expected a fresh browser with no saved operator selection.');
  for (const name of fixtureOperators) await page.click(`#operators input[value="${name}"]`);
  await page.click('#use-operators');
  let nextLog = 0;
  while (Date.now() < deadline - 10000) {
    const state = await snapshot();
    if (Date.now() >= nextLog) {
      report.observations.push({ phase, at: new Date().toISOString(), ...state });
      await collectRtc('boot-and-read');
      console.log(JSON.stringify({ phase, worker: state.worker, lightClient: state.lightClient, pin: state.pin }));
      nextLog = Date.now() + 15000;
    }
    if (ready(state)) { report.readState = state; break; }
    if (/^failed\b|^closed\b/.test(state.worker ?? '') || /^failed\b/.test(state.lightClient ?? '')) break;
    if (state.reads.length === 4 && !state.readDisabled && state.reads.some(row => row[1]?.class === 'bad')) break;
    await delay(500);
  }
  const verified = report.readState ?? await snapshot();
  await collectRtc(report.readState ? 'after-proven-reads' : 'after-failed-read-observation');
  report.gates.workerReady = /^ready\b/.test(verified.worker ?? '');
  report.gates.lightClientVerified = /^verified\b/.test(verified.lightClient ?? '');
  report.gates.workerPinVerified = /^verified\b/.test(verified.pin ?? '');
  report.gates.provenRows = hasProvenRows(verified);
  report.gates.rawEthCallRefused = callRefused(verified);
  report.gates.paymentsOff = verified.paymentsEnabled === false && verified.paymentControlsDisabled === true;
  report.gates.productionBuild = verified.developmentHandlePresent === false;
  report.gates.secureBrowserContext = verified.secureContext === true;
  await page.screenshot({ path: `${output}.png`, fullPage: true, timeout: remaining(10000) });
  report.screenshot = `${output}.png`;
  if (verified.cutDisabled === false && Date.now() < deadline - 4000) {
    phase = 'shutdown';
    const requestsBeforeClose = report.httpRequests.length;
    await page.click('#cut-network');
    const closeDeadline = Math.min(deadline - 1000, Date.now() + 7000);
    while (Date.now() < closeDeadline) {
      const state = await snapshot();
      report.afterClose = state;
      if (/^closed\b/.test(state.worker ?? '') && state.reads.length === 4 && state.reads.slice(0, 3).every(row =>
        row[1]?.class === 'bad' && /TransportUnavailable|anonymous transport is closed|no direct fallback/i.test(row[1].text))) break;
      await delay(100);
    }
    await delay(Math.min(1000, remaining(1000)));
    report.httpRequestsAfterClose = report.httpRequests.slice(requestsBeforeClose);
    report.shutdownObservationMs = 1000;
    report.gates.shutdownRefusal = /^closed\b/.test(report.afterClose?.worker ?? '') && report.afterClose?.reads.length === 4 &&
      report.afterClose.reads.slice(0, 3).every(row => row[1]?.class === 'bad' && /TransportUnavailable|anonymous transport is closed|no direct fallback/i.test(row[1].text));
    report.gates.noHttpAfterClose = report.httpRequestsAfterClose.length === 0;
    await collectRtc('after-shutdown');
  } else {
    report.gates.shutdownRefusal = false;
    report.gates.noHttpAfterClose = false;
    report.shutdownNotObserved = verified.cutDisabled !== false ? 'Anonymous transport never became cuttable.' : 'Observation deadline left insufficient time.';
  }
} catch (error) {
  report.error = String(error);
  if (page && !timedOut) {
    await snapshot().catch(() => {});
    await collectRtc('error-diagnostics').catch(() => {});
    await page.screenshot({ path: `${output}.png`, fullPage: true, timeout: 3000 }).then(() => {
      report.screenshot = `${output}.png`;
    }).catch(() => {});
  }
} finally {
  clearTimeout(watchdog);
  await closeOwnedBrowser()?.catch(error => { report.cleanupError = String(error); });
  report.timedOut = timedOut;
  report.externalHttpRequests = report.httpRequests.filter(({ url }) => new URL(url).origin !== parsedBase.origin);
  report.observedDirectRpcOrBeaconRequests = report.externalHttpRequests.filter(({ url }) => {
    const parsed = new URL(url);
    return executionAndBeaconHosts.has(parsed.hostname) || /\/eth\/v[12]\/beacon\/light_client\//.test(parsed.pathname);
  });
  report.unexpectedExternalHttpRequests = report.externalHttpRequests.filter(({ url }) => !allowedBundles.has(url));
  report.gates.noDirectRpcOrBeaconHttp = report.observedDirectRpcOrBeaconRequests.length === 0;
  report.gates.onlyAllowedExternalHttp = report.unexpectedExternalHttpRequests.length === 0;
  report.gates.noPageErrors = report.pageErrors.length === 0;
  report.gates.pagesLoaded = report.pages.length === 3 && report.pages.every(item => item.status === 200 && item.headings.length > 0) && report.demoHttpStatus === 200;
  report.gates.noFailedSiteAssets = !report.httpErrors.some(({ url }) => new URL(url).origin === parsedBase.origin) &&
    !report.requestFailures.some(({ url }) => /^https?:/.test(url) && new URL(url).origin === parsedBase.origin);
  const diagnosticLines = [...(report.workerLog ?? '').split('\n'), ...report.console.map(item => item.text)];
  report.gatewayDiagnosticLines = diagnosticLines.filter(line => /gateway|KPS|ICE|WebRTC|bootstrap|45\.76\.81\.48|152\.236\.3\.22/i.test(line)).slice(-300);
  const successfulPairs = report.rtcObservations.flatMap(observation => observation.frames.flatMap(frame =>
    (frame.peers ?? []).flatMap(peer => peer.selectedRemotePairs ?? []))).filter(pair => pair.bytesReceived > 0);
  const connectedGatewayAddresses = [...new Set(successfulPairs.map(pair => pair.address).filter(Boolean))];
  const vpsPairObserved = successfulPairs.some(pair => pair.address === '45.76.81.48' && pair.port === 12298);
  report.gates.vpsGatewayConnected = vpsPairObserved;
  report.gates.noCompetingGatewayObserved = vpsPairObserved && successfulPairs.every(pair => pair.address === '45.76.81.48');
  report.gatewayAttribution = {
    vpsAddressMentioned: diagnosticLines.some(line => line.includes('45.76.81.48')),
    demoAddressMentioned: diagnosticLines.some(line => line.includes('152.236.3.22')),
    connectedGatewayAddresses,
    vpsConnectionProvenByRtcStats: vpsPairObserved,
    noCompetingGatewayObserved: report.gates.noCompetingGatewayObserved,
    qualification: 'Only succeeded selected/nominated pairs with received bytes count. Native getStats observations establish live gateway connections; warning/configuration log mentions alone do not. Sampling is not exhaustive packet accounting.',
  };
  report.ok = !report.error && !timedOut && !report.cleanupError && Object.values(report.gates).every(Boolean) && report.ownedBrowserClosed === true;
  report.outcome = report.ok ? 'Production browser completed proven finalized reads, refused raw eth_call, and refused reads after shutdown.' : 'Production browser release check did not pass every gate; inspect failed gates and diagnostics.';
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - started;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, report: reportPath, error: report.error, gates: report.gates, elapsedMs: report.elapsedMs }));
  process.exitCode = report.ok ? 0 : 1;
}
