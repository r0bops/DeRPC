#!/usr/bin/env node
// Exercise the distributed images, with synthetic upstreams inside an isolated
// container. This is a packaging/filtering test, not proof or Tor verification.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const usage = 'node wrapper/test/release-smoke.mjs --image <wrapper-image> --tor-image <tor-image> [--out <report.json>]';

function argumentsFor(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--image', '--tor-image', '--out'].includes(key) || values[key] !== undefined || !value || value.startsWith('--') || /[\x00-\x1f]/.test(value)) throw new Error(usage);
    values[key] = value;
  }
  if (!values['--image'] || !values['--tor-image']) throw new Error(usage);
  for (const key of ['--image', '--tor-image']) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/.test(values[key])) throw new Error('Supply a local Docker image name, digest or ID.');
  return values;
}

// Serialized into a temporary read-only mount; all imports are Node built-ins.
async function containerFixture() {
  const { strict: assert } = await import('node:assert');
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { existsSync, readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { setTimeout: delay } = await import('node:timers/promises');
  const checks = [], servers = new Set(), children = new Set();
  const token = readFileSync('/smoke/personal-token', 'utf8').trim();
  const account = `0x${'11'.repeat(20)}`;
  const specifier = '0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e';
  const proof = { address: account, accountProof: ['0xdeadbeef'], balance: '0x7', nonce: '0x1', codeHash: `0x${'22'.repeat(32)}`, storageHash: `0x${'33'.repeat(32)}`, storageProof: [{ key: '0x1', value: '0x9', proof: ['0xcafe'] }] };
  const rpcCalls = [], beaconCalls = [];
  let wrapper, stopped = false;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DERPC_')));
  const timeout = (promise, ms, message) => new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); accept(value); }, error => { clearTimeout(timer); reject(error); });
  });
  function start(entry, env) {
    const child = spawn(process.execPath, [entry], { env: { ...cleanEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', errorOutput = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 256 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { errorOutput += chunk; if (errorOutput.length > 256 * 1024) child.kill('SIGKILL'); });
    const done = new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); accept({ code, signal, output, errorOutput }); });
    });
    // A spawn error must remain handled while readiness probes are in progress.
    done.catch(() => {});
    return { child, done, output: () => output, errorOutput: () => errorOutput };
  }
  async function closeServer(server) {
    if (!servers.has(server)) return;
    server.closeAllConnections();
    await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    servers.delete(server);
  }
  async function cleanup() {
    await Promise.allSettled([...servers].map(closeServer));
    for (const child of children) child.kill('SIGTERM');
    await delay(30);
    for (const child of children) child.kill('SIGKILL');
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopped = true;
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
  async function check(name, body) {
    const started = performance.now();
    await body();
    checks.push({ name, passed: true, durationMs: Math.round(performance.now() - started) });
  }
  async function listen(handler) {
    const server = createServer(handler);
    servers.add(server);
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  }
  async function get(path, options = {}, port = 8787) {
    return fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(3000), redirect: 'error' });
  }
  async function rpc(method, params, options = {}) {
    const { port, ...rest } = options;
    const response = await get('/rpc', { method: 'POST', headers: { 'content-type': 'application/json', ...rest.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) }, port);
    return { status: response.status, body: await response.json() };
  }
  function onion() {
    const publicKey = Buffer.alloc(32, 7), version = Buffer.from([3]);
    const checksum = createHash('sha3-256').update('.onion checksum').update(publicKey).update(version).digest().subarray(0, 2);
    const bytes = Buffer.concat([publicKey, checksum, version]);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, value = 0, encoded = '';
    for (const byte of bytes) {
      value = (value << 8) | byte; bits += 8;
      while (bits >= 5) { bits -= 5; encoded += alphabet[(value >>> bits) & 31]; }
    }
    assert.equal(bits, 0);
    return `${encoded}.onion`;
  }
  let checkEntrypoint = { available: false, exercised: false };
  try {
    const execution = await listen(async (request, response) => {
      try {
        let text = '';
        for await (const chunk of request) { text += chunk; assert.ok(text.length < 128 * 1024); }
        const call = JSON.parse(text);
        rpcCalls.push({ ...call, authorization: request.headers.authorization });
        assert.equal(request.method, 'POST');
        let result;
        if (call.method === 'eth_chainId') result = '0x1';
        else if (call.method === 'eth_getBlockByNumber') { assert.deepEqual(call.params, ['finalized', false]); result = { number: '0x64', hash: `0x${'44'.repeat(32)}` }; }
        else if (call.method === 'eth_getProof') result = { ...proof, address: call.params[0], storageProof: call.params[1].map(key => ({ key, value: '0x9', proof: ['0xcafe'] })) };
        else if (call.method === 'eth_getCode') result = '0x60006000';
        else throw new Error(`Unexpected forwarded method ${call.method}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      } catch { response.writeHead(500); response.end('{}'); }
    });
    const beacon = await listen((request, response) => {
      beaconCalls.push({ path: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 'electra', data: { fixturePath: request.url, finalized_header: { beacon: { slot: '64' } } } }));
    });
    const env = {
      DERPC_ENS_NAME: 'release-smoke.derpc.eth', DERPC_SIGNER: account, DERPC_ENDPOINT_ID: 'node-a',
      DERPC_EXECUTION_URL: execution.url, DERPC_BEACON_URL: beacon.url,
      DERPC_PERSONAL_TOKEN_FILE: '/smoke/personal-token', DERPC_ONION_HOSTNAME: onion(),
    };
    await check('invalid configuration exits before serving', async () => {
      const cases = [
        [{ DERPC_ENS_NAME: '' }, /DERPC_ENS_NAME is required/],
        [{ DERPC_ENDPOINT_ID: 'invalid/node' }, /DERPC_ENDPOINT_ID/],
        [{ DERPC_PAYMENT_ESCROW: account }, /free-only/],
        [{ DERPC_EXECUTION_URL: 'file:///tmp/not-an-rpc' }, /invalid upstream URL/],
        [{ DERPC_PERSONAL_PORT: '8787' }, /ports must differ/],
      ];
      for (const [change, expected] of cases) {
        const invalid = start('/app/wrapper/src/main.ts', { ...env, ...change });
        const result = await timeout(invalid.done, 5000, 'Invalid configuration did not exit');
        assert.notEqual(result.code, 0);
        assert.equal(result.signal, null);
        assert.match(result.errorOutput, expected);
      }
      assert.equal(rpcCalls.length, 0);
      assert.equal(beaconCalls.length, 0);
    });
    wrapper = start('/app/wrapper/src/main.ts', env);
    await check('packaged main starts and serves exact operator and endpoint identity', async () => {
      const deadline = Date.now() + 15_000;
      let identity;
      while (Date.now() < deadline) {
        if (wrapper.child.exitCode !== null || wrapper.child.signalCode !== null) throw new Error(`Wrapper exited during startup: ${wrapper.errorOutput()}`);
        try { const response = await get('/.well-known/derpc.json'); if (response.ok) { identity = await response.json(); break; } } catch { /* Wait for the packaged listener. */ }
        await delay(100);
      }
      assert.deepEqual(identity, { ens: env.DERPC_ENS_NAME, signer: account, endpointId: 'node-a', chains: [1], version: '1', service: 'node' });
    });
    await check('allowlisted RPCs forward through the real HTTP listener with finalized tags', async () => {
      assert.deepEqual(await rpc('eth_chainId', []), { status: 200, body: { jsonrpc: '2.0', id: 7, result: '0x1' } });
      const actual = await rpc('eth_getProof', [account, ['0x1'], 'finalized']);
      assert.equal(actual.status, 200);
      assert.deepEqual(actual.body.result, proof);
      const forwarded = rpcCalls.find(call => call.method === 'eth_getProof');
      assert.deepEqual(forwarded.params, [account, ['0x1'], '0x64']);
      assert.equal((await rpc('eth_getCode', [account, '0x64'])).body.result, '0x60006000');
      const before = rpcCalls.filter(call => call.method === 'eth_getProof').length;
      assert.equal((await rpc('eth_getProof', [account, ['0x1'], '0x64'])).status, 200);
      assert.equal(rpcCalls.filter(call => call.method === 'eth_getProof').length, before);
    });
    await check('unsupported methods, notifications and mixed batches never reach upstream', async () => {
      const before = rpcCalls.length;
      for (const method of ['eth_call', 'eth_sendRawTransaction', 'admin_nodeInfo']) assert.equal((await rpc(method, [])).status, 403);
      const valid = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
      const batch = await get('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([valid, { ...valid, id: 2, method: 'eth_call' }]) });
      assert.equal(batch.status, 403); await batch.text();
      const notification = await get('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [] }) });
      assert.equal(notification.status, 400); await notification.text();
      assert.equal((await rpc('eth_getProof', [account, ['0x1'], 'latest'])).status, 400);
      assert.equal(rpcCalls.length, before);
    });
    await check('future state requests are refused before proof forwarding', async () => {
      const before = rpcCalls.filter(call => call.method === 'eth_getProof').length;
      assert.equal((await rpc('eth_getProof', [account, ['0x2'], '0x65'])).status, 400);
      assert.equal(rpcCalls.filter(call => call.method === 'eth_getProof').length, before);
    });
    await check('all four beacon routes pass and other paths are refused', async () => {
      const base = '/eth/v1/beacon/light_client/';
      for (const path of [`${base}bootstrap/0x${'55'.repeat(32)}`, `${base}updates?start_period=1&count=2`, `${base}finality_update`, `${base}optimistic_update`]) {
        const response = await get(path);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.fixturePath, path);
      }
      assert.equal(beaconCalls.length, 4);
      for (const [path, status] of [['/eth/v1/node/identity', 404], [`${base}updates?start_period=1&count=5`, 400], ['/payments/voucher', 404]]) {
        const response = await get(path); assert.equal(response.status, status); await response.text();
      }
      assert.equal(beaconCalls.length, 4);
    });
    await check('personal listener authenticates without forwarding credentials or sharing the public cache', async () => {
      const before = rpcCalls.length;
      assert.equal((await rpc('eth_chainId', [], { port: 8788 })).status, 401);
      assert.equal((await rpc('eth_chainId', [], { port: 8788, headers: { authorization: 'Bearer wrong' } })).status, 401);
      assert.equal(rpcCalls.length, before);
      const options = { port: 8788, headers: { authorization: `Bearer ${token}` } };
      const proofs = rpcCalls.filter(call => call.method === 'eth_getProof').length;
      assert.equal((await rpc('eth_getProof', [account, ['0x1'], '0x64'], options)).status, 200);
      assert.equal(rpcCalls.filter(call => call.method === 'eth_getProof').length, proofs + 1);
      const identity = await get('/.well-known/derpc.json', { headers: options.headers }, 8788);
      assert.equal(identity.status, 404); await identity.text();
      assert.ok(rpcCalls.every(call => call.authorization === undefined));
      assert.ok(beaconCalls.every(call => call.authorization === undefined));
    });
    await check('packaged check command validates the running fixture and prints its ENS proposal', async () => {
        assert.ok(existsSync('/app/wrapper/src/check.ts'), 'Release image is missing /app/wrapper/src/check.ts');
        checkEntrypoint.available = true;
        const command = start('/app/wrapper/src/check.ts', env);
        const result = await timeout(command.done, 10_000, 'Packaged check command did not finish');
        assert.equal(result.code, 0, result.errorOutput);
        assert.equal(result.signal, null);
        assert.ok(result.output.includes(env.DERPC_ENS_NAME));
        assert.ok(result.output.includes(env.DERPC_ONION_HOSTNAME));
        assert.ok(result.output.includes('node-a'));
        checkEntrypoint.exercised = true;
    });
    await check('upstream shutdown fails requests instead of serving cached state or another destination', async () => {
      await closeServer(execution.server);
      await closeServer(beacon.server);
      assert.equal((await rpc('eth_getProof', [account, ['0x1'], '0x64'])).status, 502);
      assert.equal((await rpc('eth_chainId', [])).status, 502);
      const response = await get('/eth/v1/beacon/light_client/finality_update');
      assert.equal(response.status, 502); await response.text();
    });
    await check('SIGTERM exits cleanly and closes both listeners', async () => {
      assert.equal(wrapper.child.kill('SIGTERM'), true);
      const result = await timeout(wrapper.done, 5000, 'Wrapper failed to stop after SIGTERM');
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.ok(!result.output.includes(token) && !result.errorOutput.includes(token));
      await assert.rejects(get('/.well-known/derpc.json'));
      await assert.rejects(get('/rpc', {}, 8788));
    });
    assert.equal(stopped, false);
    assert.equal(children.size, 0);
    process.stdout.write(`${JSON.stringify({ passed: true, nodeVersion: process.version, architecture: process.arch, checks, checkEntrypoint })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ passed: false, checks, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  } finally { await cleanup(); }
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const runId = `derpc-release-smoke-${process.pid}-${randomBytes(5).toString('hex')}`;
  const owned = new Set();
  const controller = new AbortController();
  let temporary, interrupted;
  const onSignal = signal => { interrupted ??= signal; controller.abort(new Error(`Interrupted by ${signal}`)); };
  const interrupt = () => onSignal('SIGINT'), terminate = () => onSignal('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const report = { schemaVersion: 1, kind: 'derpc-wrapper-release-smoke', startedAt: new Date().toISOString(), ok: false, complete: false,
    scope: 'Real packaged images; Docker network none; synthetic loopback-only upstream fixtures; no host ports or persistent volumes.',
    limitations: ['Fixture proofs are intentionally synthetic and do not establish cryptographic correctness.', 'Tor configuration is checked offline; onion reachability and client anonymity are not tested.'], images: {}, checks: [], cleanup: { containersRemoved: false, temporaryFilesRemoved: false } };
  async function docker(parameters, timeout = 60_000, useSignal = true) {
    return execute('docker', parameters, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, ...(useSignal ? { signal: controller.signal } : {}) });
  }
  async function container(suffix, image, command, mounts = []) {
    const name = `${runId}-${suffix}`;
    owned.add(name);
    return docker(['run', '--rm', '--pull', 'never', '--name', name, '--label', `org.derpc.release-smoke=${runId}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', ...mounts, image, ...command]);
  }
  try {
    for (const [name, image] of [['wrapper', args['--image']], ['tor', args['--tor-image']]]) {
      const inspected = JSON.parse((await docker(['image', 'inspect', image])).stdout);
      if (inspected.length !== 1 || inspected[0].Os !== 'linux') throw new Error(`Expected one local Linux ${name} image.`);
      report.images[name] = { reference: image, id: inspected[0].Id, architecture: inspected[0].Architecture, os: inspected[0].Os };
    }
    temporary = await mkdtemp(join(tmpdir(), 'derpc-release-smoke-'));
    // The non-root image user needs read/traverse access only to these synthetic fixtures.
    await chmod(temporary, 0o755);
    await writeFile(join(temporary, 'fixture.mjs'), `await (${containerFixture.toString()})();\n`, { mode: 0o444 });
    await writeFile(join(temporary, 'personal-token'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o444 });
    const wrapper = await container('wrapper', args['--image'], ['node', '/smoke/fixture.mjs'], ['--mount', `type=bind,src=${temporary},dst=/smoke,readonly`]);
    const fixture = JSON.parse(wrapper.stdout.trim());
    if (fixture.passed !== true || !Array.isArray(fixture.checks) || fixture.checks.length < 10 || fixture.checks.some(check => check.passed !== true) || fixture.checkEntrypoint?.available !== true || fixture.checkEntrypoint?.exercised !== true) throw new Error('Packaged wrapper did not report all required smoke checks.');
    report.checks.push(...fixture.checks);
    report.wrapperRuntime = { nodeVersion: fixture.nodeVersion, architecture: fixture.architecture, checkEntrypoint: fixture.checkEntrypoint };
    const version = (await container('tor-version', args['--tor-image'], ['tor', '--version'])).stdout.trim();
    if (!/^Tor version \d+\.\d+\.\d+/m.test(version)) throw new Error('Tor image did not report its version.');
    report.torVersion = version.split('\n')[0];
    const config = await container('tor-config', args['--tor-image'], ['tor', '--verify-config', '-f', '/etc/tor/torrc', '--DisableNetwork', '1']);
    if (!config.stdout.includes('Configuration was valid')) throw new Error('Tor default configuration validation did not succeed.');
    const dump = (await container('tor-settings', args['--tor-image'], ['tor', '--dump-config', 'short', '-f', '/etc/tor/torrc', '--DisableNetwork', '1'])).stdout.split('\n');
    for (const required of ['SocksPort 0', 'ControlPort 0', 'DisableNetwork 1', 'DataDirectory /var/lib/tor', 'HiddenServiceDir /var/lib/tor/pool', 'HiddenServicePort 80 127.0.0.1:8787']) {
      if (!dump.includes(required)) throw new Error(`Packaged Tor config is missing ${required}.`);
    }
    if (dump.filter(line => line.startsWith('HiddenServiceDir ')).length !== 1 || dump.filter(line => line.startsWith('HiddenServicePort ')).length !== 1 || dump.filter(line => line === 'HiddenServiceVersion 3').length !== 1 || dump.filter(line => line === 'HiddenServicePoWDefensesEnabled 0').length !== 1 || dump.some(line => line.includes('8788') || line.includes('/personal'))) throw new Error('Release Tor must expose only the pool v3 service, with no personal listener and compatible proof-of-work settings.');
    report.checks.push({ name: 'packaged Tor version and pool-only v3 loopback forwarding validate with networking disabled', passed: true });
    report.complete = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (error && typeof error === 'object' && typeof error.stderr === 'string') {
      try { const failure = JSON.parse(error.stderr.trim()); if (Array.isArray(failure.checks)) report.checks.push(...failure.checks); if (typeof failure.error === 'string') report.error = failure.error; } catch { /* Docker's diagnostic remains in error.message. */ }
    }
  } finally {
    for (const name of owned) {
      try { await docker(['rm', '--force', name], 10_000, false); }
      catch (error) { if (!String(error.stderr ?? error.message).includes('No such container')) { report.complete = false; report.cleanup.error = `Unable to remove owned smoke container ${name}.`; } }
    }
    try {
      const remaining = (await docker(['ps', '--all', '--quiet', '--filter', `label=org.derpc.release-smoke=${runId}`], 10_000, false)).stdout.trim();
      report.cleanup.containersRemoved = remaining === '';
      if (remaining) report.complete = false;
    } catch { report.complete = false; report.cleanup.error = 'Unable to verify disposable container cleanup.'; }
    if (temporary) {
      try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryFilesRemoved = true; }
      catch { report.complete = false; report.cleanup.error = 'Unable to remove temporary smoke fixtures.'; }
    } else report.cleanup.temporaryFilesRemoved = true;
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
  if (interrupted) { report.complete = false; report.error = `Interrupted by ${interrupted}`; }
  report.ok = report.complete;
  report.finishedAt = new Date().toISOString();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args['--out']) await writeFile(resolve(args['--out']), json, { mode: 0o644 });
  process.stdout.write(json);
  if (!report.complete) process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
