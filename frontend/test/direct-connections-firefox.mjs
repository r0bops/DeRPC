// Manual browser regression: node frontend/test/direct-connections-firefox.mjs [report.json]
// Requires installed workspace dependencies and Firefox with Marionette. Uses fresh profiles,
// ephemeral localhost servers, and an in-memory failed transport stub. No live anonymity claim.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), "../..");
const frontend = path.join(root, "frontend");
const sha256 = async filename => createHash("sha256").update(await readFile(filename)).digest("hex");
const sources = ["frontend/src/direct-connections.ts", "frontend/src/render.ts", "frontend/src/network-check.ts", "frontend/src/main.ts", "frontend/index.html", "frontend/network-check.html"];
const sourceHashes = () => Promise.all(sources.map(async source => [source, await sha256(path.join(root, source))]));
const sourceSha256 = Object.fromEntries(await sourceHashes());
const harnessSha256 = await sha256(here);
const require = createRequire(path.join(frontend, "package.json"));
const { createServer: viteServer } = await import(pathToFileURL(require.resolve("vite")).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporary = await mkdtemp(path.join(tmpdir(), "derpc-firefox-diagnostics-"));
const reportPath = path.resolve(process.argv[2] ?? path.join(tmpdir(), "derpc-direct-connections-firefox.json"));
const results = [];
const fixtureHits = new Map();
let vite;
let transportOverrides = 0;

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

// Marionette provides both ordinary page automation and Firefox's privileged verification APIs.
// A separate BiDi/Puppeteer session cannot share its WebDriver session on recent Firefox.
async function connect(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let input = Buffer.alloc(0);
  let sequence = 0;
  const pending = new Map();
  const fail = error => {
    for (const task of pending.values()) { clearTimeout(task.timeout); task.reject(error); }
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Firefox automation connection closed")));
  socket.on("data", chunk => {
    input = Buffer.concat([input, chunk]);
    while (true) {
      const colon = input.indexOf(58);
      if (colon < 0) return;
      const length = Number(input.subarray(0, colon).toString());
      if (input.length < colon + 1 + length) return;
      const message = JSON.parse(input.subarray(colon + 1, colon + 1 + length));
      input = input.subarray(colon + 1 + length);
      if (!Array.isArray(message) || message[0] !== 1) continue; // Initial protocol greeting.
      const task = pending.get(message[1]);
      if (!task) continue;
      pending.delete(message[1]);
      clearTimeout(task.timeout);
      if (message[2]) task.reject(new Error(JSON.stringify(message[2])));
      else task.resolve(message[3]);
    }
  });
  return {
    socket,
    send(method, parameters = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Firefox command timed out: ${method}`)); }, 60_000);
        pending.set(id, { resolve, reject, timeout });
        const payload = JSON.stringify([0, id, method, parameters]);
        socket.write(`${Buffer.byteLength(payload)}:${payload}`);
      });
    },
  };
}

async function launch(privateWindow) {
  const profile = await mkdtemp(path.join(temporary, "profile-"));
  const reserve = net.createServer();
  const port = await listen(reserve);
  await new Promise(resolve => reserve.close(resolve));
  const preferences = {
    "marionette.port": port,
    "browser.privatebrowsing.autostart": false,
    "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.enabled": false,
  };
  await writeFile(path.join(profile, "user.js"), Object.entries(preferences)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
  const child = spawn(process.env.FIREFOX_BIN ?? "/usr/bin/firefox", [
    "--headless", "--no-remote", "--profile", profile, "--marionette", "--remote-allow-system-access",
    ...(privateWindow ? ["--private-window", "about:blank"] : ["about:blank"]),
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let launchError;
  child.on("error", error => { launchError = error; });
  child.stderr.resume(); // Firefox startup logs can include profile paths; don't persist them.
  let client;
  const stop = async () => {
    client?.socket.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  };
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error("Firefox exited before automation started");
      try { client = await connect(port); break; } catch { await delay(100); }
    }
    assert(client, "Firefox Marionette did not start");
    const session = await client.send("WebDriver:NewSession", { capabilities: { alwaysMatch: {} } });
    await client.send("WebDriver:SetTimeouts", { script: 20_000, pageLoad: 60_000, implicit: 0 });
    const evaluate = async (script, args = [], context = "content", async = false) => {
      await client.send("Marionette:SetContext", { value: context });
      const result = await client.send(async ? "WebDriver:ExecuteAsyncScript" : "WebDriver:ExecuteScript", {
        script, args, newSandbox: true, sandbox: context === "chrome" ? "default" : null, line: 1, filename: "derpc-local-ui-qa",
      });
      return result.value;
    };
    return { client, stop, evaluate, version: session.capabilities.browserVersion };
  } catch (error) { await stop(); throw error; }
}

const privateState = `
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
  const win = Services.wm.getMostRecentWindow('navigator:browser');
  return {
    autostart: Services.prefs.getBoolPref('browser.privatebrowsing.autostart', false),
    windowIsPrivate: PrivateBrowsingUtils.isWindowPrivate(win),
    selectedBrowserIsPrivate: PrivateBrowsingUtils.isBrowserPrivate(win.gBrowser.selectedBrowser),
  };
`;

// These nsIHttpChannel events are independent of window.performance and keep working when timing
// APIs are disabled. Some subresource channels have no browsing context ID, so do not drop those.
// Observe this owned Firefox process and mark tab attribution when exposed. URLs are sanitized
// before storage: loopback origin labels, no query/fragment, no absolute filesystem paths.
const installHttpObserver = `
  const win = Services.wm.getMostRecentWindow('navigator:browser');
  const topId = win.gBrowser.selectedBrowser.browsingContext.id;
  const origins = arguments[0];
  const topics = ['http-on-modify-request', 'http-on-examine-response', 'http-on-examine-cached-response'];
  const state = { events: [], topics, errors: 0, dropped: 0 };
  state.observer = { observe(subject, topic) {
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const context = BrowsingContext.get(channel.loadInfo.browsingContextID);
      if (state.events.length >= 10_000) { state.dropped++; return; }
      const origin = channel.URI.prePath;
      const label = origins[origin] ?? 'external-http-origin';
      let pathname = channel.URI.QueryInterface(Ci.nsIURL).filePath;
      if (pathname.startsWith('/@fs/')) pathname = '/@fs/[workspace-module]';
      if (label === 'external-http-origin') pathname = '[redacted]';
      let status = null;
      try { status = channel.responseStatus; } catch {}
      state.events.push({ topic, url: label + pathname, method: channel.requestMethod, status, tabAttributed: context?.top.id === topId });
    } catch { state.errors++; }
  }};
  for (const topic of topics) Services.obs.addObserver(state.observer, topic);
  win.__derpcDiagnosticQa = state;
  return true;
`;
const takeHttpEvents = `
  const state = Services.wm.getMostRecentWindow('navigator:browser').__derpcDiagnosticQa;
  const result = { events: state.events.splice(0), errors: state.errors, dropped: state.dropped };
  state.errors = state.dropped = 0;
  return result;
`;
const removeHttpObserver = `
  const win = Services.wm.getMostRecentWindow('navigator:browser');
  const state = win.__derpcDiagnosticQa;
  if (state) for (const topic of state.topics) Services.obs.removeObserver(state.observer, topic);
  delete win.__derpcDiagnosticQa;
`;

const transportStub = `
  export class NetworkUnavailableError extends Error {}
  export class TransportUnavailableError extends Error {
    constructor(state) { super('Transport disabled for UI QA'); this.state = state; this.name = 'TransportUnavailableError'; }
  }
  export function startAnonTransport({ pin, onState }) {
    const error = new TransportUnavailableError('failed');
    return { pin, ready: Promise.resolve().then(() => { onState?.('failed', error.message); throw error; }),
      state: () => 'failed', fetch: async () => { throw error; }, close: () => {} };
  }
`;
const instrumentation = `
  window.__derpcQaErrors = [];
  addEventListener('error', event => { if (event.message) window.__derpcQaErrors.push(event.message); });
  addEventListener('unhandledrejection', event => window.__derpcQaErrors.push(String(event.reason)));
  if (new URL(location.href).searchParams.get('qa') === 'timings-unavailable') {
    Object.defineProperty(globalThis, 'PerformanceObserver', { configurable: true, value: undefined });
    Object.defineProperty(performance, 'getEntriesByType', { configurable: true, value: undefined });
  }
`;

const fixture = httpServer((request, response) => {
  if (!/^\/cache\/(normal|private)-(index|network-check)\.js$/.test(request.url ?? "")) {
    response.writeHead(404).end(); return;
  }
  fixtureHits.set(request.url, (fixtureHits.get(request.url) ?? 0) + 1);
  response.writeHead(200, {
    "content-type": "application/javascript", "cache-control": "public, max-age=3600",
    "timing-allow-origin": "*", "access-control-allow-origin": "*",
  });
  response.end("globalThis.__qaCachedLoads = (globalThis.__qaCachedLoads || 0) + 1;");
});

function assertHttpLog(log) {
  assert.equal(log.errors, 0, "Independent HTTP observer failed");
  assert.equal(log.dropped, 0, "Independent HTTP log exceeded its bound");
  assert(log.events.some(event => event.topic === "http-on-modify-request"), "Independent HTTP log did not capture page requests");
}

async function readUi(browser, fixtureHost) {
  return browser.evaluate(`
    const host = arguments[0];
    const row = [...document.querySelectorAll('#direct tr')].find(row => row.cells[0]?.textContent === host);
    return {
      status: document.querySelector('#direct-status')?.textContent,
      statusClass: document.querySelector('#direct-status')?.className,
      worker: document.querySelector('#worker-status')?.textContent,
      fixtureRow: row ? [...row.cells].map((cell, index) => index === 0 ? 'loopback-fixture' : cell.textContent) : null,
      emptyState: document.querySelector('#direct td[colspan]')?.textContent ?? null,
      errors: window.__derpcQaErrors,
    };
  `, [fixtureHost]);
}

async function ready(browser) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await browser.evaluate(`return {
      worker: document.querySelector('#worker-status')?.textContent,
      status: document.querySelector('#direct-status')?.textContent,
      errors: window.__derpcQaErrors,
    };`);
    assert.deepEqual(state.errors, [], `Page startup errors: ${JSON.stringify(state.errors)}`);
    if (state.worker?.includes("Transport disabled for UI QA") && state.status && !state.status.startsWith("Waiting")) return;
    await delay(200);
  }
  throw new Error("Diagnostic page failed to initialize with the explicit transport stub");
}

async function addFixture(browser, url) {
  return browser.evaluate(`
    const done = arguments[arguments.length - 1];
    const script = document.createElement('script');
    script.src = arguments[0];
    script.onload = () => done({ loaded: true, executions: window.__qaCachedLoads });
    script.onerror = () => done({ loaded: false });
    document.head.append(script);
  `, [url], "content", true);
}

try {
  const fixtureOrigin = `http://127.0.0.1:${await listen(fixture)}`;
  vite = await viteServer({
    configFile: false, envDir: false, root: frontend, cacheDir: path.join(temporary, "vite-cache"),
    logLevel: "error", define: { "import.meta.env.VITE_TOR_GATEWAYS": JSON.stringify("") },
    server: { host: "127.0.0.1", port: 0, strictPort: true, fs: { allow: [root] } },
    resolve: { alias: [{ find: /^@chainsafe\/bls$/, replacement: "@chainsafe/bls/herumi" }] },
    plugins: [{
      name: "derpc-local-diagnostics-qa", enforce: "pre",
      transform(_source, id) {
        if (id.split("?")[0] === path.join(root, "provider/src/transport/anon-transport.ts")) {
          transportOverrides++; return { code: transportStub, map: null };
        }
      },
      transformIndexHtml: { order: "pre", handler: () => [{ tag: "script", children: instrumentation, injectTo: "head-prepend" }] },
      configureServer(server) {
        // Suppress the development call-log writer; this dedicated server never reads vite.config.ts.
        server.middlewares.use("/__derpc-log", (request, response) => { request.resume(); response.writeHead(204).end(); });
      },
    }],
  });
  await vite.listen();
  const appOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  let browserVersion;
  for (const privateWindow of [false, true]) {
    const mode = privateWindow ? "private" : "normal";
    const browser = await launch(privateWindow);
    browserVersion = browser.version;
    try {
      const privacy = await browser.evaluate(privateState, [], "chrome");
      assert.equal(privacy.autostart, false, "Private-window run must not substitute permanent private mode");
      assert.equal(privacy.windowIsPrivate, privateWindow);
      assert.equal(privacy.selectedBrowserIsPrivate, privateWindow);
      await browser.evaluate(installHttpObserver, [{ [appOrigin]: "loopback-app", [fixtureOrigin]: "loopback-fixture" }], "chrome");
      for (const route of ["index.html", "network-check.html"]) {
        const fixturePath = `/cache/${mode}-${route.replace(".html", "")}.js`;
        const fixtureUrl = fixtureOrigin + fixturePath;
        await browser.client.send("Marionette:SetContext", { value: "content" });
        await browser.client.send("WebDriver:Navigate", { url: `${appOrigin}/${route}` });
        await ready(browser);
        assert.deepEqual(await browser.evaluate(privateState, [], "chrome"), privacy);
        const firstLoad = await addFixture(browser, fixtureUrl);
        assert.equal(firstLoad.loaded, true);
        assert.equal(fixtureHits.get(fixturePath), 1);
        const coldHttp = await browser.evaluate(takeHttpEvents, [], "chrome");
        assertHttpLog(coldHttp);
        assert(coldHttp.events.some(event => event.url === "loopback-fixture" + fixturePath && event.topic === "http-on-examine-response"), `Cold fixture HTTP response missing: ${JSON.stringify(coldHttp.events.slice(-10))}`);
        await browser.client.send("Marionette:SetContext", { value: "content" });
        await browser.client.send("WebDriver:Refresh");
        await ready(browser);
        const warmInitial = await readUi(browser, new URL(fixtureOrigin).host);
        const cachedLoad = await addFixture(browser, fixtureUrl);
        assert.equal(cachedLoad.loaded, true);
        assert.equal(cachedLoad.executions, 1, "Cached script must execute after the reload");
        await delay(500);
        const beforeClear = await readUi(browser, new URL(fixtureOrigin).host);
        const cachedTimings = await browser.evaluate(`return performance.getEntriesByName(arguments[0]).map(entry => ({ transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize }));`, [fixtureUrl]);
        assert(beforeClear.fixtureRow, "Cached resource observation missing from diagnostics");
        assert(cachedTimings.length > 0 && cachedTimings.every(entry => entry.transferSize === 0));
        assert.equal(fixtureHits.get(fixturePath), 1, "Warm load unexpectedly reached the independent fixture server");
        const warmHttp = await browser.evaluate(takeHttpEvents, [], "chrome");
        assertHttpLog(warmHttp);
        assert(warmHttp.events.some(event => event.url === "loopback-fixture" + fixturePath && event.topic === "http-on-examine-cached-response"), "Firefox HTTP observer did not confirm cached fixture response");
        const resourceBufferImmediatelyAfterClear = await browser.evaluate("performance.clearResourceTimings(); return performance.getEntriesByType('resource').length;");
        assert.equal(resourceBufferImmediatelyAfterClear, 0);
        await delay(3100); // Cross the collector's periodic snapshot interval.
        const afterClear = await readUi(browser, new URL(fixtureOrigin).host);
        assert.deepEqual(afterClear.fixtureRow, beforeClear.fixtureRow);
        assert.deepEqual(afterClear.errors, []);
        assert.equal(afterClear.statusClass, "muted");
        results.push({ mode, route, privacy, case: "warm cache and cleared resource buffer", fixtureServerHits: fixtureHits.get(fixturePath), firstLoad, cachedLoad, cachedTimings, resourceBufferImmediatelyAfterClear, warmInitial, beforeClear, afterClear, coldHttp, warmHttp });
        console.log(`PASS Firefox ${mode} ${route}: warm cache, independent HTTP cache event, retained row after buffer clear`);
      }
      if (privateWindow) for (const route of ["index.html", "network-check.html"]) {
        await browser.evaluate(takeHttpEvents, [], "chrome");
        await browser.client.send("Marionette:SetContext", { value: "content" });
        await browser.client.send("WebDriver:Navigate", { url: `${appOrigin}/${route}?qa=timings-unavailable` });
        await ready(browser);
        await delay(3100); // Also exercise the periodic refresh with unavailable APIs.
        const empty = await readUi(browser, "no-fixture");
        assert.deepEqual(await browser.evaluate(privateState, [], "chrome"), privacy);
        assert.equal(empty.statusClass, "warn");
        assert(empty.status.includes("does not establish that no network connections occurred"));
        assert(empty.status.includes("snapshot is unavailable"));
        assert(empty.emptyState.includes("No resource observations available"));
        assert.deepEqual(empty.errors, []);
        const independentHttp = await browser.evaluate(takeHttpEvents, [], "chrome");
        assertHttpLog(independentHttp);
        results.push({ mode, route, privacy, case: "private window with timing APIs explicitly disabled", empty, independentHttp });
        console.log(`PASS Firefox private ${route}: unavailable APIs warn despite independently logged HTTP loads`);
      }
    } finally {
      try { await browser.evaluate(removeHttpObserver, [], "chrome"); } finally { await browser.stop(); }
    }
  }
  assert(transportOverrides > 0);
  assert.deepEqual(Object.fromEntries(await sourceHashes()), sourceSha256, "Diagnostic source changed during the run; rerun against stable files");
  assert.equal(await sha256(here), harnessSha256, "Harness changed during the run; rerun the final harness");
  const report = {
    schemaVersion: 1, recordedAt: new Date().toISOString(), browser: `Firefox/${browserVersion}`,
    scope: "UI-only Firefox diagnostics regression; no live anonymity, proof-verification or wallet-transaction claim.",
    setup: {
      server: "Dedicated temporary Vite development server and cache fixture on ephemeral loopback ports; no existing server or environment files used.",
      privateWindow: "Fresh profile launched with --private-window; autostart false, PrivateBrowsingUtils window and selected-browser flags asserted true. Normal profile flags asserted false. Headless Firefox.",
      transport: "Dedicated Vite transform replaces only anon-transport.ts in memory with a rejected stub; every page asserts Transport disabled for UI QA. The actual worker/KPS/WebRTC transport does not start in these cases.",
      transportOverrides,
      independentNetworkLog: "Firefox chrome-context nsIHttpChannel observer for this owned Firefox process: http-on-modify-request, http-on-examine-response, http-on-examine-cached-response. Independent of ResourceTiming. Tab attribution recorded when Firefox exposes a matching browsing context; missing subresource attribution is not filtered away. Local fixture server hits separately counted.",
      sanitization: "HTTP URLs contain origin labels and paths only: no query, fragment or workspace absolute path. External origins/paths redacted. No headers, bodies, tokens, profile paths or user data collected.",
      timingsUnavailable: "Additional private-window cases shadow PerformanceObserver and performance.getEntriesByType before app startup. This is a deliberate compatibility simulation, not Firefox's default private behavior.",
    },
    results,
    reproduction: { command: "node frontend/test/direct-connections-firefox.mjs /tmp/derpc-direct-connections-firefox.json", firefoxBinary: "FIREFOX_BIN override; defaults to /usr/bin/firefox", harnessSha256, sourceSha256 },
    limitations: [
      "Development pages with explicit transport stub; does not replace live/public gateway, release-build, Tor exit or verified-read checks.",
      "HTTP-channel log is bounded and scoped to the owned Firefox process. Background HTTP may be included; tab attribution is incomplete for subresources. WebRTC, non-HTTP transports and full OS network activity are not measured.",
      "ResourceTiming entries measure exposed observations, not all connections. Clearing the browser buffer must not erase previously retained rows; collection remains bounded to 512 observations per page.",
      "Cache fixture is a local HTTP resource; private caching is tested within one private-window lifetime, not persistence after closing private browsing.",
    ],
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${results.length} passing Firefox cases to ${reportPath}`);
} finally {
  await vite?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
