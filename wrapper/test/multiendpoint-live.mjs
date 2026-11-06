// Optional real-network M1-B check. Requires Docker, Firefox, a running frontend Vite server,
// DERPC_TEST_GATEWAY and a Tor image built from wrapper/Dockerfile.tor.
// Example: docker build -t derpc-multiendpoint-tor -f wrapper/Dockerfile.tor wrapper
// This owns two temporary wrapper processes, two public test onions, and RPC-only 503 gates.
// Onion keys live in a disposable container tmpfs. No original service or container is modified.
import puppeteer from 'puppeteer-core';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const gateway = process.env.DERPC_TEST_GATEWAY;
if (!gateway)
    throw new Error('DERPC_TEST_GATEWAY is required');
const origin = new URL(process.env.DERPC_DEV_ORIGIN ?? 'http://localhost:5173').origin;
const image = process.env.DERPC_TEST_TOR_IMAGE ?? 'derpc-multiendpoint-tor';
const output = resolve(process.env.DERPC_TEST_REPORT ?? '/tmp/derpc-multiendpoint-live.json');
const readyFile = process.env.DERPC_TEST_SETUP_READY_FILE;
const startFile = process.env.DERPC_TEST_START_FILE;
const checkEns = process.env.DERPC_TEST_ENS_CHECK === 'true';
if (startFile && existsSync(startFile))
    throw new Error('DERPC_TEST_START_FILE must not already exist');
const ens = 'multi.derpc.eth', signer = '0x1111111111111111111111111111111111111111';
const execution = 'https://rpc.mevblocker.io', beacon = 'https://ethereum-beacon-api.publicnode.com';
const other = { id: 'mevblocker.derpc.eth', operatorId: 'mevblocker.derpc.eth', ens: 'mevblocker.derpc.eth', operator: 'MEV Blocker', url: execution, priority: 2 };
const dir = mkdtempSync(join(tmpdir(), 'derpc-m1b-live-'));
const container = `derpc-m1b-live-${process.pid}-${Date.now()}`;
const nodes = [], externalRequests = [], servedModules = [], responseWork = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const report = { started: new Date().toISOString(), kind: 'local-multiendpoint-onion-failover', mockEns: true, paymentsEnabled: false, publicFixture: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', stages: [], faults: [], productionTimeoutOverrides: false };
const save = () => writeFileSync(output, stringify(report) + '\n', { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => {
    if (!condition)
        throw new Error(message);
};
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
function sourceHashes() {
    const files = ['wrapper/test/multiendpoint-live.mjs', 'patches/@lodestar__light-client@1.43.0.patch', 'pnpm-lock.yaml'];
    for (const base of ['provider/src', 'wrapper/src']) {
        for (const entry of readdirSync(join(root, base), { recursive: true, withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.ts'))
                files.push(relative(root, join(entry.parentPath, entry.name)));
        }
    }
    return Object.fromEntries(files.sort().map(file => [file, hash(readFileSync(join(root, file)))]));
}
async function unusedPort() {
    const server = createSocketServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
    }
}
let browser, torCreated = false, inflightExecution = 0, maxExecutionConcurrency = 0, stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
        stopping = true;
        report.cancelled = true;
        void browser?.close().catch(() => { });
    });
const assertRunning = () => {
    if (stopping)
        throw new Error('owned live check cancelled');
};
async function startNode(endpointId, priority) {
    const port = await unusedPort();
    const node = { endpointId, priority, port, failed: false, gateRequests: [], childLog: '' };
    nodes.push(node);
    node.child = spawn(process.execPath, ['wrapper/src/main.ts'], { cwd: root, env: {
            PATH: process.env.PATH, NODE_ENV: 'test', DERPC_PORT: String(port), DERPC_ENDPOINT_ID: endpointId,
            DERPC_ENS_NAME: ens, DERPC_SIGNER: signer, DERPC_DEMO_PROXY: 'true',
            DERPC_EXECUTION_URL: execution, DERPC_BEACON_URL: beacon,
        }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [node.child.stdout, node.child.stderr])
        stream.on('data', data => { node.childLog = (node.childLog + data.toString()).slice(-4096); });
    const deadline = Date.now() + 10000;
    for (;;) {
        assertRunning();
        if (node.child.exitCode !== null)
            throw new Error(`owned ${endpointId} wrapper exited before readiness: ${node.childLog}`);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/.well-known/derpc.json`, { signal: AbortSignal.timeout(1000) });
            const identity = await response.json();
            assert(response.ok && identity.ens === ens && identity.signer === signer && identity.endpointId === endpointId && identity.service === 'demo-proxy', 'unexpected owned wrapper identity');
            node.identity = identity;
            break;
        }
        catch (error) {
            if (Date.now() >= deadline)
                throw error;
            await delay(100);
        }
    }
    node.gate = createServer({ requestTimeout: 20000, headersTimeout: 10000 }, (request, response) => {
        const path = request.url ?? '/';
        if (!path.startsWith('/') || path.startsWith('//')) {
            response.writeHead(400);
            response.end();
            return;
        }
        const rpc = path === '/rpc';
        const entry = { endpointId, path, at: new Date().toISOString(), injectedUnavailable: rpc && node.failed };
        node.gateRequests.push(entry);
        if (rpc) {
            inflightExecution++;
            maxExecutionConcurrency = Math.max(maxExecutionConcurrency, inflightExecution);
        }
        let completed = false;
        const finish = () => {
            if (completed)
                return;
            completed = true;
            if (rpc)
                inflightExecution--;
        };
        response.once('finish', finish);
        response.once('close', finish);
        if (rpc && node.failed) {
            response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: 'controlled test endpoint unavailability' }));
            return;
        }
        const upstream = httpRequest({ hostname: '127.0.0.1', port, path, method: request.method, headers: request.headers }, incoming => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
        });
        upstream.on('error', () => {
            if (!response.headersSent)
                response.writeHead(502);
            response.end();
        });
        response.on('close', () => upstream.destroy());
        request.pipe(upstream);
    });
    await new Promise((resolve, reject) => { node.gate.once('error', reject); node.gate.listen(0, '127.0.0.1', resolve); });
    node.gatePort = node.gate.address().port;
}
try {
    report.wrapperSourcesAtStart = Object.fromEntries(Object.entries(sourceHashes()).filter(([path]) => path.startsWith('wrapper/src/')));
    await startNode('node-a', 0);
    await startNode('node-b', 0);
    const uid = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'id', image, '-u']);
    const gid = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'id', image, '-g']);
    assert(/^\d+$/.test(uid) && /^\d+$/.test(gid), 'invalid Tor image user IDs');
    const torrc = ['SocksPort 0', 'ControlPort 0', 'Log notice stdout', 'DataDirectory /var/lib/tor', ...nodes.flatMap(node => [
            `HiddenServiceDir /var/lib/tor/${node.endpointId}`, 'HiddenServiceVersion 3', `HiddenServicePort 80 127.0.0.1:${node.gatePort}`, 'HiddenServicePoWDefensesEnabled 0',
        ])].join('\n') + '\n';
    writeFileSync(join(dir, 'torrc'), torrc, { mode: 0o644 });
    report.torImageId = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    docker(['run', '-d', '--name', container, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        '--mount', `type=bind,source=${join(dir, 'torrc')},target=/etc/tor/m1b-torrc,readonly`, '--tmpfs', `/var/lib/tor:rw,nosuid,nodev,noexec,mode=0700,uid=${uid},gid=${gid}`,
        image, 'tor', '-f', '/etc/tor/m1b-torrc']);
    torCreated = true;
    const torDeadline = Date.now() + 90000;
    for (;;) {
        assertRunning();
        try {
            for (const node of nodes) {
                const hostname = docker(['exec', container, 'cat', `/var/lib/tor/${node.endpointId}/hostname`]);
                assert(/^[a-z2-7]{56}\.onion$/.test(hostname), 'invalid generated onion hostname');
                node.url = `http://${hostname}/rpc`;
            }
            if (docker(['logs', container]).includes('Bootstrapped 100%'))
                break;
        }
        catch { /* Tor may still be initializing its owned tmpfs. */ }
        if (Date.now() >= torDeadline)
            throw new Error('owned Tor service did not bootstrap within90s');
        await delay(1000);
    }
    const candidates = nodes.map(node => ({ id: `${ens}#${node.endpointId}`, operatorId: ens, endpointId: node.endpointId, ens, operator: 'Local multi-node demo proxy', url: node.url, beaconUrl: new URL(node.url).origin, priority: node.priority, wrapperIdentity: { signer } }));
    report.setup = { identities: nodes.map(node => node.identity), candidates, otherOperatorForLaterExplicitSelection: other, upstreams: { execution, beacon }, keysInDisposableTmpfs: true };
    if (readyFile)
        writeFileSync(readyFile, stringify({ ready: true, candidates }) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ stage: 'isolated-services-ready', endpoints: candidates.map(({ endpointId, url }) => ({ endpointId, url })), waitingForSourceSignal: !!startFile }));
    save();
    if (startFile) {
        const deadline = Date.now() + 15 * 60000;
        while (!existsSync(startFile)) {
            assertRunning();
            if (Date.now() >= deadline)
                throw new Error('current-source readiness signal did not arrive within15min');
            await delay(500);
        }
    }
    assertRunning();
    report.optionalEnsRequested = checkEns;
    report.sourcesBefore = sourceHashes();
    assert(Object.entries(report.wrapperSourcesAtStart).every(([path, value]) => report.sourcesBefore[path] === value), 'wrapper source changed after owned processes started; restart the test');
    report.sourceTreeHashBefore = hash(JSON.stringify(report.sourcesBefore));
    browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox', headless: true, protocolTimeout: 300000 });
    report.browserVersion = await browser.version();
    const page = await browser.newPage();
    page.on('request', request => {
        if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin)
            externalRequests.push(request.url());
    });
    page.on('response', response => {
        const url = new URL(response.url()), prefix = `/@fs${root}/provider/src/`;
        if (url.pathname.startsWith(prefix))
            responseWork.push(response.text().then(text => servedModules.push({ path: `provider/src/${url.pathname.slice(prefix.length)}`, sha256: hash(text) })));
        if (url.pathname.endsWith('/@lodestar_light-client.js'))
            responseWork.push(response.text().then(text => { report.loadedLodestar = { sha256: hash(text), lifecycleGuard: text.includes('while (!this.lifecycle.signal.aborted)') }; }));
    });
    await page.exposeFunction('multiProgress', stage => { report.stages.push(stage); save(); console.log(JSON.stringify({ stage: stage.name, ok: stage.ok, endpoint: stage.endpoint, durationMs: stage.durationMs, error: stage.error })); });
    await page.exposeFunction('makeNodeUnavailable', endpointId => {
        const node = nodes.find(node => node.endpointId === endpointId);
        assert(node, 'test requested an unowned endpoint');
        node.failed = true;
        report.faults.push({ endpointId, at: new Date().toISOString(), behavior: 'test-only ingress gate returns503 for /rpc; identity/beacon continue to the actual wrapper' });
        save();
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.isNavigationRequest() && request.url() === `${origin}/`)
            void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Multi-endpoint live check</title>' });
        else
            void request.continue();
    });
    await page.goto(origin);
    report.result = await page.evaluate(async ({ root, gateway, candidates, other, ens, checkEns }) => {
        const p = await import(`/@fs${root}/provider/src/index.ts`);
        const { createDeRPCWith } = await import(`/@fs${root}/provider/src/api/derpc.ts`);
        const fixture = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        const events = [], traffic = [], workerLogs = [];
        let transport, phase = 'startup';
        const started = performance.now();
        const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
        const d = createDeRPCWith({ startTransport: options => {
                transport = p.startAnonTransport(options);
                const original = transport.fetch.bind(transport);
                transport.fetch = async (url, options) => {
                    const entry = { phase, url, atMs: Math.round(performance.now() - started) }, began = performance.now();
                    if (typeof options?.body === 'string') {
                        try {
                            const body = JSON.parse(options.body);
                            entry.method = body.method;
                            entry.account = body.params?.[0];
                        }
                        catch { }
                    }
                    traffic.push(entry);
                    try {
                        const response = await original(url, options);
                        entry.status = response.status;
                        entry.headersMs = Math.round(performance.now() - began);
                        return response;
                    }
                    catch (error) {
                        entry.error = { name: error.name, message: error.message, code: error.code, torKind: error.torKind };
                        entry.headersMs = Math.round(performance.now() - began);
                        throw error;
                    }
                };
                return transport;
            }, startHeaders: p.startVerifiedHeaderSource }, { verifiedCalls: checkEns, gateways: [gateway], beaconUrl: new URL(candidates[1].url).origin, operators: [], onPoolEvent: event => events.push(event), onWorkerLog: line => {
                workerLogs.push(line);
                if (workerLogs.length > 50)
                    workerLogs.shift();
            } });
        async function bounded(promise, ms, name) {
            let timer;
            try {
                return await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => reject(new Error(`${name} exceeded test harness bound`)), ms))]);
            }
            finally {
                clearTimeout(timer);
            }
        }
        async function read(name, action, expected, bound = 35000) {
            phase = name;
            const began = performance.now(), eventStart = events.length, trafficStart = traffic.length;
            const stage = { name, ok: false };
            try {
                const value = await bounded(action(), bound, name);
                const success = events.slice(eventStart).filter(event => event.type === 'success').at(-1);
                stage.endpoint = success?.endpoint;
                stage.value = value.value.toString();
                stage.blockNumber = value.block.blockNumber;
                stage.blockHash = value.block.blockHash;
                stage.ok = expected ? stage.endpoint === expected : candidates.some(candidate => candidate.id === stage.endpoint);
                stage.observations = d.status().operators;
            }
            catch (error) {
                stage.error = { name: error.name, message: error.message, attempts: error.attempts };
            }
            stage.durationMs = Math.round(performance.now() - began);
            stage.events = events.slice(eventStart);
            stage.requests = traffic.slice(trafficStart).filter(entry => entry.method);
            await window.multiProgress(clean(stage));
            if (!stage.ok)
                throw new Error(`${name} failed its verified endpoint assertion`);
            return stage;
        }
        let result;
        try {
            await bounded(transport.ready, 45000, 'worker startup');
            await bounded(d.ready, 75000, 'header startup');
            const startupMs = Math.round(performance.now() - started);
            await window.multiProgress({ name: 'header-verified', ok: true, durationMs: startupMs, blockNumber: d.status().lightClient.header?.blockNumber });
            // Public-fixture readiness is sequential and must succeed at both nodes before an outage.
            d.setOperators([candidates[0]]);
            await read('warmup-node-a', () => d.reader.getBalance(fixture), candidates[0].id, 65000);
            d.setOperators([candidates[1]]);
            await read('warmup-node-b', () => d.reader.getBalance(fixture), candidates[1].id);
            d.setOperators(candidates);
            const first = await read('first-operator-node', () => d.reader.getBalance(fixture));
            const firstNode = candidates.find(candidate => candidate.id === first.endpoint), sibling = candidates.find(candidate => candidate.id !== first.endpoint);
            await window.makeNodeUnavailable(firstNode.endpointId);
            const failover = await read('failed-node-to-sibling', () => d.reader.getTransactionCount(fixture), sibling.id);
            if (!failover.events.some(event => event.type === 'transient-failure' && event.endpoint === firstNode.id))
                throw new Error('sibling stage did not observe the controlled first-node failure');
            await read('same-account-retains-sibling', () => d.reader.getStorageAt(fixture, '0x0'), sibling.id);
            await window.makeNodeUnavailable(sibling.endpointId);
            if (traffic.some(entry => entry.method && entry.url === other.url))
                throw new Error('other operator was queried before explicit selection');
            d.setOperators([...candidates, other]);
            await window.multiProgress({ name: 'explicit-fallback-added', ok: true, selectedOperatorIds: [ens, other.operatorId] });
            await read('operator-unavailable-to-explicit-fallback', () => d.reader.getStorageAt(fixture, '0x1'), other.id);
            const execution = traffic.filter(entry => entry.method);
            const allowed = new Set([...candidates, other].map(candidate => candidate.url));
            const consensus = traffic.filter(entry => new URL(entry.url).pathname.startsWith('/eth/v1/beacon/'));
            if (!execution.every(entry => allowed.has(entry.url)) || !consensus.every(entry => candidates.some(candidate => new URL(candidate.url).origin === new URL(entry.url).origin)))
                throw new Error('request escaped the explicit execution/onion consensus choices');
            result = { ok: true, startupMs, firstEndpoint: firstNode.id, siblingEndpoint: sibling.id, fallbackEndpoint: other.id, pinVerified: d.status().pin.state === 'verified', operatorIds: [...new Set(d.status().operators.map(operator => operator.operatorId ?? operator.ens ?? operator.id))], selection: d.status().routing, executionStayedWithinChoices: true, consensusStayedOnOwnedOnions: true };
            if (checkEns) {
                phase = 'optional-generic-verified-ens';
                const began = performance.now(), trafficStart = traffic.length;
                let resolved;
                try {
                    const value = await bounded(d.resolveEns({ name: 'derpc.eth', record: { type: 'text', key: 'url' } }), 65000, 'generic verified ENS resolution');
                    resolved = { ok: true, value: clean(value) };
                }
                catch (error) {
                    resolved = { ok: false, error: { name: error.name, message: error.message } };
                }
                const requests = traffic.slice(trafficStart).filter(entry => entry.method);
                const methods = requests.map(entry => entry.method);
                resolved.durationMs = Math.round(performance.now() - began);
                resolved.rpcMethods = Object.fromEntries([...new Set(methods)].map(method => [method, methods.filter(value => value === method).length]));
                resolved.allRpcViaSelectedFallback = requests.length > 0 && requests.every(entry => entry.url === other.url);
                resolved.noRemoteEthCall = !methods.includes('eth_call');
                if (!resolved.noRemoteEthCall)
                    resolved.ok = false;
                result.ensResolution = resolved;
                await window.multiProgress({ name: phase, ...resolved });
            }
        }
        catch (error) {
            result = { ok: false, phase, error: { name: error.name, message: error.message }, status: clean(d.status()) };
        }
        finally {
            phase = 'closed';
            d.close();
            const before = traffic.length;
            let refusal;
            try {
                await d.reader.getStorageAt(fixture, '0x2');
            }
            catch (error) {
                refusal = error.name;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            result.close = { refused: refusal === 'TransportUnavailableError', errorName: refusal, callsAfterClose: traffic.length - before, observationMs: 1000 };
        }
        result.events = events;
        result.traffic = traffic;
        result.workerLogs = workerLogs;
        return clean(result);
    }, { root, gateway, candidates, other, ens, checkEns });
    await Promise.all(responseWork);
    report.externalBrowserRequests = [...new Set(externalRequests)];
    report.noDirectRpcOrBeacon = report.externalBrowserRequests.every(url => /^https:\/\/(cdn\.jsdelivr\.net\/npm\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|unpkg\.com\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|raw\.githubusercontent\.com\/ethereum\/tor-js\/keccak\/)/.test(url));
    report.servedModules = servedModules.sort((a, b) => a.path.localeCompare(b.path));
    report.ok = report.result.ok && report.result.pinVerified && report.result.close.refused && report.result.close.callsAfterClose === 0 && report.noDirectRpcOrBeacon && report.loadedLodestar?.lifecycleGuard;
    if (!report.ok)
        process.exitCode = 1;
}
catch (error) {
    report.error = String(error);
    report.ok = false;
    process.exitCode = 1;
}
finally {
    if (browser)
        await browser.close();
    report.maxObservedExecutionConcurrencyAtOwnedGates = maxExecutionConcurrency;
    report.controlled503Counts = Object.fromEntries(nodes.map(node => [node.endpointId, node.gateRequests.filter(entry => entry.injectedUnavailable).length]));
    if (report.result?.ok && (maxExecutionConcurrency > 1 || Object.values(report.controlled503Counts).some(count => count < 1))) {
        report.ok = false;
        report.failureAssertions = 'expected sequential owned RPC requests and an observed controlled503 at each node';
        process.exitCode = 1;
    }
    for (const node of nodes) {
        if (node.gate) {
            node.gate.closeAllConnections();
            await new Promise(resolve => node.gate.close(resolve));
        }
        await stopChild(node.child);
    }
    if (torCreated) {
        try {
            docker(['rm', '-f', container]);
        }
        catch {
            report.cleanupFailure = 'owned Tor container removal failed';
            report.ok = false;
            process.exitCode = 1;
        }
    }
    rmSync(dir, { recursive: true, force: true });
    report.cleanedUp = !report.cleanupFailure;
    if (report.sourcesBefore) {
        const after = sourceHashes();
        report.sourceTreeHashAfter = hash(JSON.stringify(after));
        report.changedSources = [...new Set([...Object.keys(report.sourcesBefore), ...Object.keys(after)])].filter(path => report.sourcesBefore[path] !== after[path]);
        if (report.changedSources.length) {
            report.ok = false;
            process.exitCode = 1;
        }
    }
    report.finished = new Date().toISOString();
    report.limits = ['Same-party test wrappers and gateway, public-node upstreams and mock ENS identities: no public ENS registration or independent-operator claim.', 'Both onions are disposable and removed after this check; the private keys never leave container tmpfs.', 'Controlled unavailability is an actual HTTP503 returned by a test-only /rpc ingress gate; the actual wrapper identity and beacon routes remain available.', 'Initial selection is explicitly limited to one operator; this functional check is not evidence of global ranking or random-selection fairness.', 'Sequential public-fixture warmups verify node-a and node-b individually before the group/outage stages; these are reported separately. The additional operator is explicitly selected only for the later cross-operator stage.', 'No production timeouts, proof verification, isolation policy or existing service are changed.', 'This check does not exercise finalized operator-directory discovery, rotation, delisting or permission changes. Optional generic ENS resolution is a separate result and cannot convert a failed operator test into a pass.'];
    save();
    console.log(stringify({ ok: report.ok, result: report.result && { ...report.result, events: undefined, traffic: undefined, workerLogs: undefined }, error: report.error, changedSources: report.changedSources, cleanedUp: report.cleanedUp, output }));
}
