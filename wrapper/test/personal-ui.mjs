// Optional real-browser personal-token handling check. Start the frontend and personal wrapper first.
// DERPC_TEST_PERSONAL_URL and DERPC_PERSONAL_TOKEN_FILE are required; no token is written to the report.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';

function required(name) { if (!process.env[name]) throw new Error(`${name} is required`); return process.env[name]; }
const endpoint = required('DERPC_TEST_PERSONAL_URL');
const hostname = new URL(endpoint).hostname;
const token = readFileSync(required('DERPC_PERSONAL_TOKEN_FILE'), 'utf8').trim();
const origin = new URL(process.env.DERPC_DEV_ORIGIN ?? 'http://localhost:5173').origin;
const output = process.env.DERPC_TEST_REPORT ?? '/tmp/derpc-personal-ui-report.json';
const report = { started: new Date().toISOString(), kind: 'live-personal-ui-token-review' };
const browser = await puppeteer.launch({ browser: process.env.DERPC_BROWSER ?? 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox', headless: true });
const consoleMessages = [];
const requests = [];
let page;
function containsSecret(value) { return value.includes(token) || value.includes(hostname); }
try {
  page = await browser.newPage();
  page.on('console', message => consoleMessages.push(message.text()));
  page.on('pageerror', error => consoleMessages.push(String(error)));
  page.on('request', request => requests.push({ url: request.url() }));
  await page.evaluateOnNewDocument(() => {
    const fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.__personalReviewFetches = [];
    globalThis.__personalReviewSensitive = false;
    globalThis.fetch = (input, init) => {
      globalThis.__personalReviewFetches.push({ url: typeof input === 'string' ? input : input instanceof Request ? input.url : String(input), body: typeof init?.body === 'string' ? init.body : '', sensitive: globalThis.__personalReviewSensitive });
      return fetchOriginal(input, init);
    };
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#personal-token');
  await page.evaluate(({ endpoint, token }) => {
    globalThis.__personalReviewSensitive = true;
    document.getElementById('personal-endpoint').value = endpoint;
    document.getElementById('personal-token').value = token;
    document.getElementById('personal-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }, { endpoint, token });
  const entered = await page.evaluate(() => ({
    tokenCleared: document.getElementById('personal-token').value === '',
    endpointCleared: document.getElementById('personal-endpoint').value === '',
    selected: [...document.querySelectorAll('#operators input:checked')].map(input => input.value),
  }));
  if (!entered.tokenCleared || !entered.endpointCleared || entered.selected.length !== 1 || entered.selected[0] !== 'my-personal-node') throw new Error('personal configuration was not accepted and cleared');
  await page.click('#use-operators');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#reads tr')];
    return rows.length === 4 && rows.every(row => row.children[1]?.className !== 'muted');
  }, { timeout: 150_000 });
  const checked = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage),
    rows: [...document.querySelectorAll('#reads tr')].map(row => ({ resultClass: row.children[1]?.className, via: row.children[2]?.textContent })),
    pinVerified: document.getElementById('pin-status').textContent.startsWith('verified'),
    workerLog: document.getElementById('worker-log').textContent,
    hostFetches: globalThis.__personalReviewFetches,
  }));
  if (checked.rows.slice(0, 3).some(row => row.resultClass !== 'ok') || checked.rows[3].resultClass !== 'warn' || !checked.pinVerified) throw new Error('personal verified reads did not complete');
  if (checked.rows.slice(0, 3).some(row => !row.via.includes('My own node'))) throw new Error('verified reads did not report the personal operator');
  report.fieldsCleared = entered.tokenCleared && entered.endpointCleared;
  report.verifiedPersonalReads = 3;
  report.workerPinVerified = checked.pinVerified;
  report.rawCallRefused = true;
  report.noSecretInDom = !containsSecret(checked.dom);
  report.noSecretInStorage = !containsSecret(checked.local + checked.session);
  report.noSecretInConsole = !consoleMessages.some(containsSecret);
  report.noSecretInWorkerLog = !containsSecret(checked.workerLog);
  report.noSecretInBrowserHttp = !requests.some(request => containsSecret(request.url)) && !checked.hostFetches.some(request => containsSecret(request.url + request.body));
  report.noDevLogAfterPersonalSelection = !checked.hostFetches.some(request => new URL(request.url, origin).pathname === '/__derpc-log' && request.sensitive);
  if (![report.noSecretInDom, report.noSecretInStorage, report.noSecretInConsole, report.noSecretInWorkerLog, report.noSecretInBrowserHttp, report.noDevLogAfterPersonalSelection].every(Boolean)) throw new Error('personal details appeared in a surface that should not retain them, or development logging continued');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#personal-token');
  report.personalForgottenAfterReload = await page.evaluate(() => !document.querySelector('#operators input[value="my-personal-node"]') && !document.querySelector('#operators input:checked') && document.getElementById('personal-token').value === '' && document.getElementById('personal-endpoint').value === '');
  if (!report.personalForgottenAfterReload) throw new Error('reload retained personal configuration');
  const outside = requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== origin).map(request => request.url);
  report.externalBrowserRequests = [...new Set(outside)];
  report.noDirectRpcOrBeacon = outside.every(url => /^https:\/\/(cdn\.jsdelivr\.net\/npm\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|unpkg\.com\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|raw\.githubusercontent\.com\/ethereum\/tor-js\/keccak\/)/.test(url));
  if (!report.noDirectRpcOrBeacon) throw new Error('unexpected direct browser network request');
  report.ok = true;
} catch (error) {
  report.error = String(error).replaceAll(token, '[redacted-token]').replaceAll(hostname, '[private-onion]');
  if (page) {
    try {
      const state = await page.evaluate(() => ({ status: Object.fromEntries(['worker-status', 'lc-status', 'pin-status', 'personal-status'].map(id => [id, document.getElementById(id)?.textContent])), reads: document.getElementById('reads')?.textContent }));
      report.failureState = JSON.parse(JSON.stringify(state).replaceAll(token, '[redacted-token]').replaceAll(hostname, '[private-onion]'));
    } catch { /* Preserve the original failure if the page also stopped. */ }
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  report.limits = ['This observes one Firefox UI session and its browser HTTP/log/storage surfaces; it is not a general memory, browser-extension or infrastructure logging audit.', 'The personal token is intentionally delivered inside encrypted worker traffic to its endpoint; the untrusted worker receives request headers.', 'The wrapper and gateway belong to the same tester, so this does not establish independent operator/gateway privacy.'];
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
