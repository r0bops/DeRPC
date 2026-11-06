// Optional real-network check. Nothing here supplies mock proofs or a direct browser RPC fallback.
// Start the wrapper and the frontend Vite server first; install Firefox or set DERPC_BROWSER_PATH.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionResult, encodeFunctionData, namehash, parseAbi } from 'viem';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const origin = new URL(process.env.DERPC_DEV_ORIGIN ?? 'http://localhost:5173').origin;
const repo = fileURLToPath(new URL('../..', import.meta.url));
const moduleRoot = `/@fs${repo}/provider/src`;
const resolverAbi = parseAbi(['function resolve(bytes name,bytes data) view returns (bytes)', 'function text(bytes32 node,string key) view returns (string)', 'function multicall(bytes[] data) view returns (bytes[] results)']);
const callName = process.env.DERPC_TEST_ENS_NAME ?? 'derpc.eth';
const callKeys = (process.env.DERPC_TEST_ENS_KEYS ?? 'url').split(',');
const callResolver = process.env.DERPC_TEST_ENS_RESOLVER;
const dnsName = `0x${callName.split('.').map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)]).toString('hex')).join('')}00`;
const profiles = callKeys.map(key => encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [namehash(callName), key] }));
const profile = profiles.length === 1 ? profiles[0] : encodeFunctionData({ abi: resolverAbi, functionName: 'multicall', args: [profiles] });
const config = {
  gateway: required('DERPC_TEST_GATEWAY'),
  endpoint: required('DERPC_TEST_ONION_URL'),
  ens: required('DERPC_ENS_NAME'),
  signer: required('DERPC_SIGNER'),
  exit: process.env.DERPC_TEST_EXIT_URL ?? 'https://rpc.mevblocker.io',
  personal: process.env.DERPC_TEST_PERSONAL_URL,
  token: process.env.DERPC_PERSONAL_TOKEN_FILE ? readFileSync(process.env.DERPC_PERSONAL_TOKEN_FILE, 'utf8').trim() : undefined,
  moduleRoot,
  verifiedCall: callResolver ? { to: callResolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'resolve', args: [dnsName, profile] }) } : undefined,
};
if (!!config.personal !== !!config.token) throw new Error('personal URL and token file must be supplied together');
const report = { started: new Date().toISOString(), requests: [], result: null };
const output = resolve(process.env.DERPC_TEST_REPORT ?? '/tmp/derpc-wrapper-live.json');
function safeJson(value) {
  let text = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
  if (config.token) text = text.replaceAll(config.token, '[redacted-token]');
  if (config.personal) text = text.replaceAll(new URL(config.personal).hostname, '[private-onion]');
  return text;
}
const browser = await puppeteer.launch({
  browser: process.env.DERPC_BROWSER ?? 'firefox',
  executablePath: process.env.DERPC_BROWSER_PATH ?? '/usr/bin/firefox',
  headless: true,
  protocolTimeout: 240_000,
});
try {
  const page = await browser.newPage();
  page.on('request', request => {
    if (/^https?:/.test(request.url())) report.requests.push(request.url());
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    // Only the main document is replaced. Replacing the harness iframe would prevent worker boot.
    if (request.isNavigationRequest() && request.url() === `${origin}/`) {
      void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>DeRPC live wrapper test</title>' });
    } else void request.continue();
  });
  await page.goto(origin);
  report.result = await page.evaluate(async config => {
    const p = await import(`${config.moduleRoot}/index.ts`);
    const { createDeRPCWith } = await import(`${config.moduleRoot}/api/derpc.ts`);
    const events = [];
    const seen = [];
    const rpcMethods = [];
    let transport;
    // Capture the production transport for the raw latency/authentication checks; no fake dependency.
    const deps = {
      startTransport: options => {
        transport = p.startAnonTransport(options);
        const original = transport.fetch.bind(transport);
        transport.fetch = (url, options) => {
          seen.push(config.personal && new URL(url).hostname === new URL(config.personal).hostname ? 'personal' : url);
          if (typeof options?.body === 'string') {
            try {
              const parsed = JSON.parse(options.body);
              for (const entry of Array.isArray(parsed) ? parsed : [parsed]) if (typeof entry?.method === 'string') rpcMethods.push(entry.method);
            } catch { /* Other transport bodies are not JSON-RPC. */ }
          }
          return original(url, options);
        };
        return transport;
      },
      startHeaders: p.startVerifiedHeaderSource,
    };
    const onion = new URL(config.endpoint);
    const operator = { id: 'onion-demo-proxy', url: onion.href, beaconUrl: onion.origin, priority: 0, ens: config.ens, wrapperIdentity: { signer: config.signer } };
    const start = performance.now();
    const d = createDeRPCWith(deps, {
      gateways: [config.gateway], operators: [operator], attemptTimeoutMs: 20_000,
      verifiedCalls: !!config.verifiedCall,
      onPoolEvent: event => events.push(event), onWorkerLog: () => {},
    });
    const deadline = (promise, ms, description) => {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), ms); })]).finally(() => clearTimeout(timer));
    };
    let phase = 'startup';
    try {
      await deadline(d.ready, 90_000, 'startup exceeded 90 s');
      const syncedMs = Math.round(performance.now() - start);
      const address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
      phase = 'verified onion balance';
      const readStart = performance.now();
      const value = await deadline(d.reader.getBalance(address), 60_000, 'verified onion read exceeded 60 s');
      const result = { ok: true, syncedMs, readMs: Math.round(performance.now() - readStart), balance: value.value.toString(), block: value.block, benchmark: [], personal: null, failedClosed: false, callsAfterClose: null, events, workerHash: d.status().worker.workerHash };
      const tag = `0x${value.block.blockNumber.toString(16)}`;
      phase = 'route benchmark';
      for (const [route, endpoint] of [['onion', onion.href], ['exit', config.exit]]) {
        const send = p.createJsonRpcSend(transport, endpoint, { timeoutMs: 30_000 });
        const began = performance.now();
        try {
          const proof = await send('eth_getProof', [address, [], tag], { isolationKey: `derpc:account:${address.toLowerCase()}:benchmark` });
          p.verifyAccountProof({ stateRoot: value.block.stateRoot, address, proof });
          result.benchmark.push({ route, ok: true, durationMs: Math.round(performance.now() - began) });
        } catch (error) { result.benchmark.push({ route, ok: false, durationMs: Math.round(performance.now() - began), error: error.message }); }
      }
      // Test reciprocal identity refusal as well as the successful check above.
      phase = 'wrapper identity';
      let mismatchedIdentityRejected = false;
      try { await p.checkOperatorIdentity(transport, onion.href, { ens: 'wrong.derpc.eth', signer: config.signer }); }
      catch { mismatchedIdentityRejected = true; }
      result.mismatchedIdentityRejected = mismatchedIdentityRejected;
      if (!mismatchedIdentityRejected) throw new Error('mismatched wrapper identity was accepted');
      if (config.personal) {
        phase = 'personal node';
        const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), isolationKey: 'derpc:personal-test', timeoutMs: 20_000, redirect: 'error' };
        const refused = await transport.fetch(config.personal, request);
        await refused.arrayBuffer();
        if (refused.status !== 401) throw new Error('personal endpoint accepted an unauthenticated request');
        const own = { id: 'personal-node', operator: 'My node', url: config.personal, personalToken: config.token, priority: -1 };
        d.setOperators([own, operator]);
        const ownValue = await d.reader.getBalance(address);
        const ownSuccess = events.filter(e => e.type === 'success').at(-1)?.endpoint;
        if (ownSuccess !== 'personal-node') throw new Error('personal request did not use the own node');
        // The same authenticated onion advertises port 80 only: port 81 is unavailable.
        const unavailable = new URL(config.personal); unavailable.port = '81';
        d.setOperators([{ ...own, url: unavailable.href }, operator]);
        const fallback = await deadline(d.reader.getBalance(address), 90_000, 'personal fallback exceeded 90 s');
        const fallbackSuccess = events.filter(e => e.type === 'success').at(-1)?.endpoint;
        if (fallbackSuccess !== operator.id || fallback.value !== ownValue.value) throw new Error('personal failure did not return the verified pool fallback');
        result.personal = { unauthenticatedStatus: refused.status, ownReadVerified: true, unavailableFallbackVerified: true };
      }
      if (config.verifiedCall) {
        phase = 'local ENS execution';
        d.setOperators([operator]);
        const began = performance.now();
        const methodStart = rpcMethods.length;
        const call = await deadline(d.verifiedCall(config.verifiedCall), 90_000, 'local ENS execution exceeded 90 s');
        const methods = rpcMethods.slice(methodStart);
        if (methods.includes('eth_call')) throw new Error('local execution sent eth_call upstream');
        result.verifiedCall = { ...call, durationMs: Math.round(performance.now() - began), rpcMethods: Object.fromEntries([...new Set(methods)].map(method => [method, methods.filter(m => m === method).length])) };
      }
      d.close();
      phase = 'closed transport';
      const before = seen.length;
      try { await d.reader.getBalance(address); }
      catch (error) { result.failedClosed = error.name === 'TransportUnavailableError'; }
      result.callsAfterClose = seen.length - before;
      if (!result.failedClosed || result.callsAfterClose !== 0) throw new Error('closed transport did not fail closed');
      return result;
    } catch (error) {
      return { ok: false, phase, error: error instanceof Error ? error.message : String(error), events, rpcMethods: Object.fromEntries([...new Set(rpcMethods)].map(method => [method, rpcMethods.filter(m => m === method).length])) };
    } finally { d.close(); }
  }, config);
  if (report.result.verifiedCall) {
    const inner = decodeFunctionResult({ abi: resolverAbi, functionName: 'resolve', data: report.result.verifiedCall.value });
    const values = callKeys.length === 1 ? [inner] : decodeFunctionResult({ abi: resolverAbi, functionName: 'multicall', data: inner });
    report.result.verifiedCall.records = callKeys.map((key, i) => ({ name: callName, key, value: decodeFunctionResult({ abi: resolverAbi, functionName: 'text', data: values[i] }) }));
    report.result.verifiedCall.resolver = callResolver;
  }
  const outside = report.requests.filter(url => new URL(url).origin !== origin);
  const permittedBundle = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|unpkg\.com\/tor-js@0\.4\.4\/dist\/anon-rpc-worker\.js|raw\.githubusercontent\.com\/ethereum\/tor-js\/keccak\/)/;
  report.externalBrowserRequests = outside;
  report.noDirectRpc = outside.every(url => permittedBundle.test(url));
  if (!report.noDirectRpc) throw new Error('unexpected direct browser traffic; inspect the report');
  if (!report.result.ok) throw new Error(`${report.result.phase}: ${report.result.error}`);
  console.log(safeJson({ ...report.result, noDirectRpc: report.noDirectRpc }));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(safeJson(report.error));
  process.exitCode = 1;
} finally {
  // Never serialize configuration: it contains the personal token and unpublished hostname.
  writeFileSync(output, safeJson(report), { mode: 0o600 });
  await browser.close();
}
