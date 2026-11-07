// Optional real-network diagnosis: all consensus and execution requests use one onion.
// Set the same public endpoint/name/signer/gateway variables as test:live.
// No private endpoint, token or payment configuration is accepted by this runner.
// Optional DERPC_ENDPOINT_ID checks a plural node's identity; DERPC_TEST_OPERATOR_GATEWAYS
// is a JSON array of public KPS addresses run by that operator. --check-config validates offline.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertSeparateGateway, operatorUrl } from '../../provider/src/operators/endpoint.ts';
import { assertPublicGateways, gatewayHost } from '../../frontend/build/gateways.ts';
import { validateEndpointId, validateOperatorName } from '../src/proxy.ts';
function required(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`${name} is required`);
    return value;
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const origin = new URL(process.env.DERPC_DEV_ORIGIN ?? 'http://localhost:5173').origin;
const output = resolve(process.env.DERPC_TEST_REPORT ?? '/tmp/derpc-onion-availability.json');
const gateway = required('DERPC_TEST_GATEWAY').trim();
gatewayHost(gateway);
const endpoint = operatorUrl(required('DERPC_TEST_ONION_URL'));
if (!/^[a-z2-7]{56}\.onion$/.test(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw new Error('expected a public v3 onion endpoint without credentials, query or fragment');
const hostname = endpoint.hostname;
const ens = required('DERPC_ENS_NAME'), signer = required('DERPC_SIGNER');
validateOperatorName(ens);
if (!/^0x[\da-fA-F]{40}$/.test(signer))
    throw new Error('DERPC_SIGNER must be a public Ethereum address');
const endpointId = process.env.DERPC_ENDPOINT_ID;
if (endpointId !== undefined)
    validateEndpointId(endpointId);
let operatorGateways;
if (process.env.DERPC_TEST_OPERATOR_GATEWAYS !== undefined) {
    try { operatorGateways = JSON.parse(process.env.DERPC_TEST_OPERATOR_GATEWAYS); }
    catch { throw new Error('DERPC_TEST_OPERATOR_GATEWAYS must be a JSON array of public KPS addresses'); }
    if (!Array.isArray(operatorGateways) || operatorGateways.length > 16 || operatorGateways.some(value => typeof value !== 'string'))
        throw new Error('DERPC_TEST_OPERATOR_GATEWAYS must contain at most 16 public KPS addresses');
    assertPublicGateways(operatorGateways);
}
const operator = {
    id: endpointId === undefined ? ens : `${ens}#${endpointId}`, operatorId: ens,
    ...(endpointId === undefined ? {} : { endpointId }),
    priority: 0, url: endpoint.href, beaconUrl: endpoint.origin, ens,
    wrapperIdentity: { signer }, ...(operatorGateways === undefined ? {} : { gateways: operatorGateways }),
};
// Use the production guard before launching Firefox and again through createDeRPCWith below.
assertSeparateGateway(operator, [gateway]);
const workerLogLevel = process.env.DERPC_TEST_WORKER_LOG_LEVEL ?? 'warn';
if (!['warn', 'debug'].includes(workerLogLevel))
    throw new Error('diagnostic log level must be warn or debug');
if (process.argv.includes('--check-config')) {
    console.log(JSON.stringify({ gateway, operator, operatorGatewayDeclaration: operatorGateways ?? null }));
    process.exit(0);
}
const hash = value => createHash('sha256').update(value).digest('hex');
const paths = ['provider/src/api/derpc.ts', 'provider/src/api/eip1193.ts', 'provider/src/operators/endpoint.ts', 'provider/src/pool/pool.ts', 'provider/src/light-client/header-source.ts', 'provider/src/transport/anon-transport.ts', 'provider/src/transport/response-body.ts', 'provider/src/transport/json-rpc.ts', 'provider/src/config/mainnet.ts', 'frontend/build/gateways.ts', 'patches/@lodestar__light-client@1.43.0.patch', 'wrapper/src/server.ts', 'wrapper/src/proxy.ts', 'wrapper/test/onion-availability.mjs'];
const hashes = () => Object.fromEntries(paths.map(path => [path, hash(readFileSync(`${root}/${path}`))]));
const report = { started: new Date().toISOString(), kind: 'all-onion-consensus-and-execution-availability', runtime: 'fresh Firefox profile / explicitly configured gateway / pinned tor-js 0.4.4', gateway, operator, operatorGatewayDeclaration: operatorGateways ?? null, onion: hostname, endpoint: endpoint.href, sourcesBefore: hashes(), checks: [], limits: { workerHarnessBoundMs: 45000, headerHarnessBoundMs: 75000, pinAndBalanceHarnessBoundMs: 65000, storageHarnessBoundMs: 40000, productionTimeoutOverrides: false, workerLogLevel }, routes: { consensus: 'public wrapper onion', execution: 'same public wrapper onion' }, qualifications: ['This browser check alone does not establish gateway/operator independence or a public-site deployment.', 'Declared operator gateways are checked for overlap with the selected gateway; omitted declarations mean ownership is unknown, not independent.', 'Wrapper upstreams and ownership must be recorded separately; all observed client consensus and execution requests must use the selected onion.', 'This starts a fresh browser profile; it does not reset the wrapper cache or Tor service.', 'Default provider identity, RPC, pool and consensus security budgets remain unchanged.', 'Worker logs are diagnostics only; outcomes are determined by structured errors and host proof verification.'] };
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const save = () => writeFileSync(output, json(report) + '\n', { mode: 0o600 });
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox', headless: true, protocolTimeout: 220000 });
const requests = [], pending = [];
try {
    report.browserVersion = await browser.version();
    const page = await browser.newPage();
    page.on('request', request => { if (/^https?:/.test(request.url()))
        requests.push(request.url()); });
    page.on('response', response => { if (new URL(response.url()).pathname.endsWith('/@lodestar_light-client.js'))
        pending.push(response.text().then(text => { report.loadedLodestar = { sha256: hash(text), lifecycleController: text.includes('lifecycle = new AbortController()'), abortGuard: text.includes('while (!this.lifecycle.signal.aborted)'), stopAbort: text.includes('this.lifecycle.abort(new DOMException("light client stopped", "AbortError"))') }; })); });
    await page.exposeFunction('onionProgress', entry => { report.checks.push(entry); save(); console.log(JSON.stringify(entry)); });
    await page.setRequestInterception(true);
    page.on('request', request => { if (request.isNavigationRequest() && request.url() === origin + '/')
        void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>All-onion availability check</title>' });
    else
        void request.continue(); });
    await page.goto(origin);
    report.result = await page.evaluate(async ({ root, gateway, operator, workerLogLevel }) => {
        const p = await import(`/@fs${root}/provider/src/index.ts`);
        const { createDeRPCWith } = await import(`/@fs${root}/provider/src/api/derpc.ts`);
        const fixture = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', onion = new URL(operator.url).origin;
        const traffic = [], events = [], workerLogs = [], headerLogs = [];
        let transport, phase = 'worker-startup';
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        const errorShape = (error, depth = 0) => error && typeof error === 'object' ? { name: error.name, message: error.message, code: error.code, kind: error.kind, torKind: error.torKind, ...(Array.isArray(error.attempts) ? { attempts: error.attempts } : {}), ...(error.cause && depth < 2 ? { cause: errorShape(error.cause, depth + 1) } : {}) } : { message: String(error) };
        const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
        const d = createDeRPCWith({ startTransport: options => {
                transport = p.startAnonTransport(options);
                const original = transport.fetch.bind(transport);
                transport.fetch = async (url, options) => {
                    const start = performance.now(), entry = { phase, url, atMs: elapsed(), isolationKey: options?.isolationKey, timeoutMs: options?.timeoutMs };
                    if (typeof options?.body === 'string') {
                        try {
                            const body = JSON.parse(options.body);
                            entry.rpcMethod = body.method;
                            entry.account = body.params?.[0];
                        }
                        catch { }
                    }
                    traffic.push(entry);
                    try {
                        const response = await original(url, options);
                        entry.status = response.status;
                        entry.headersMs = Math.round(performance.now() - start);
                        if (response.body) {
                            const body = response.body, getReader = body.getReader.bind(body);
                            let bytes = 0, prefix = '';
                            body.getReader = (...args) => {
                                const reader = getReader(...args), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
                                reader.read = async (...readArgs) => { try {
                                    const chunk = await read(...readArgs);
                                    if (chunk.value) {
                                        bytes += chunk.value.byteLength;
                                        if (prefix.length < 1024)
                                            prefix += new TextDecoder().decode(chunk.value).slice(0, 1024 - prefix.length);
                                    }
                                    if (chunk.done) {
                                        entry.bodyBytes = bytes;
                                        entry.completeMs = Math.round(performance.now() - start);
                                        try {
                                            const parsed = JSON.parse(prefix);
                                            if (parsed.error)
                                                entry.upstreamRpcError = parsed.error;
                                        }
                                        catch { }
                                    }
                                    return chunk;
                                }
                                catch (error) {
                                    entry.bodyError = errorShape(error);
                                    entry.completeMs = Math.round(performance.now() - start);
                                    throw error;
                                } };
                                reader.cancel = async (reason) => { entry.bodyCancelled = true; entry.bodyCancelReason = errorShape(reason); return cancel(reason); };
                                return reader;
                            };
                        }
                        return response;
                    }
                    catch (error) {
                        entry.error = errorShape(error);
                        entry.completeMs = Math.round(performance.now() - start);
                        throw error;
                    }
                };
                return transport;
            }, startHeaders: options => p.startVerifiedHeaderSource({ ...options, onLog: (level, message) => headerLogs.push({ level, message, atMs: elapsed() }) }) }, { worker: { ...p.TOR_JS_PIN, config: { ...p.TOR_JS_PIN.config, logLevel: workerLogLevel } }, gateways: [gateway], beaconUrl: onion, operators: [operator], onPoolEvent: event => events.push(event), onWorkerLog: line => { workerLogs.push(line); if (workerLogs.length > 500)
                workerLogs.shift(); } });
        async function bounded(promise, ms, label) { let timer; try {
            return await Promise.race([promise, new Promise((_, reject) => timer = setTimeout(() => { const error = new Error(`${label} exceeded harness bound ${ms}ms`); error.name = 'LiveCheckDeadline'; reject(error); }, ms))]);
        }
        finally {
            clearTimeout(timer);
        } }
        let outcome = { ok: false };
        try {
            await bounded(transport.ready, 45000, 'worker startup');
            await window.onionProgress({ phase: 'worker-ready', atMs: elapsed() });
            phase = 'consensus-startup';
            await bounded(d.ready, 75000, 'header startup');
            const startupMs = elapsed();
            await window.onionProgress({ phase: 'header-verified', atMs: startupMs, blockNumber: d.status().lightClient.header?.blockNumber });
            phase = 'worker-pin-and-balance';
            let began = performance.now();
            // Worker pin and the account read have separate production pool budgets (30s each).
            const balance = await bounded(d.reader.getBalance(fixture), 65000, 'worker pin and balance');
            const balanceMs = Math.round(performance.now() - began);
            await window.onionProgress({ phase: 'balance-verified', durationMs: balanceMs, blockNumber: balance.block.blockNumber, pin: d.status().pin.state });
            phase = 'storage-proof';
            began = performance.now();
            const storage = await bounded(d.reader.getStorageAt(fixture, '0x0'), 40000, 'storage proof');
            const storageMs = Math.round(performance.now() - began);
            await window.onionProgress({ phase: 'storage-verified', durationMs: storageMs, blockNumber: storage.block.blockNumber });
            outcome = { ok: true, startupMs, balanceMs, storageMs, balance: balance.value.toString(), storage: storage.value.toString(), blockNumber: balance.block.blockNumber, blockHash: balance.block.blockHash, stateRoot: balance.block.stateRoot, pinVerified: d.status().pin.state === 'verified' };
        }
        catch (error) {
            outcome = { ok: false, phase, error: errorShape(error), status: clean(d.status()) };
        }
        finally {
            phase = 'closed';
            d.close();
            const before = traffic.length;
            let refusal;
            try {
                await d.reader.getBalance(fixture);
            }
            catch (error) {
                refusal = errorShape(error);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            outcome.close = { error: refusal, callsAfterClose: traffic.length - before, observationMs: 1000, state: d.status().transport.state };
        }
        outcome.allRequestsUseOnion = traffic.length > 0 && traffic.every(entry => new URL(entry.url).origin === onion);
        outcome.identityObserved = traffic.some(entry => entry.url.endsWith('/.well-known/derpc.json') && entry.status === 200 && entry.completeMs !== undefined);
        outcome.traffic = traffic;
        outcome.events = events;
        outcome.workerLogs = workerLogs;
        outcome.headerLogs = headerLogs;
        return clean(outcome);
    }, { root, gateway, operator, workerLogLevel });
    await Promise.all(pending);
    report.externalBrowserRequests = [...new Set(requests.filter(url => new URL(url).origin !== origin))];
    report.noDirectRpcOrBeacon = report.externalBrowserRequests.every(url => /^https:\/\/(cdn\.jsdelivr\.net\/npm\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|unpkg\.com\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|raw\.githubusercontent\.com\/ethereum\/tor-js\/keccak\/)/.test(url));
    report.ok = report.result.ok && report.result.pinVerified && report.result.allRequestsUseOnion && report.result.identityObserved && report.result.close.callsAfterClose === 0 && report.result.close.error?.name === 'TransportUnavailableError' && report.noDirectRpcOrBeacon && report.loadedLodestar?.abortGuard;
    if (!report.ok)
        process.exitCode = 1;
}
catch (error) {
    report.error = String(error);
    process.exitCode = 1;
}
finally {
    await browser.close();
    report.finished = new Date().toISOString();
    report.sourcesAfter = hashes();
    report.changedSources = paths.filter(path => report.sourcesBefore[path] !== report.sourcesAfter[path]);
    if (report.changedSources.length) {
        report.ok = false;
        process.exitCode = 1;
    }
    save();
    console.log(json({ ok: report.ok, result: report.result && { ...report.result, traffic: undefined, events: undefined, workerLogs: undefined, headerLogs: undefined }, error: report.error, changedSources: report.changedSources, noDirectRpcOrBeacon: report.noDirectRpcOrBeacon, output }));
}
