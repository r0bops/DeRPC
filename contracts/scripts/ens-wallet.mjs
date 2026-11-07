import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addresses, adminClient, isMain, json, sameAddress, validateConfig } from './ens-common.mjs';
import { loadConfig, preparePlan, registrarBuild } from './ens-plan.mjs';
import { expectedTransaction, verifyDeployment, verifyStageIdentity } from './ens-verify.mjs';

const clone = value => JSON.parse(json(value));
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const errorMessage = error => String(error.shortMessage ?? error.message ?? 'Administrative check failed').slice(0, 600);

function atomicSave(path, value) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function directoryPins(manifest) {
  if (manifest?.kind !== 'derpc-ens-deployment' || manifest.chainId !== 1 || manifest.localOnly !== false ||
      !['receipts', 'canonicalBlocks', 'stateMatchesConfig', 'hotKeyEventAudit'].every(key => manifest.verification?.[key] === true) ||
      !Number.isSafeInteger(manifest.verification.minimumConfirmations) || manifest.verification.minimumConfirmations < 12) throw new Error('A public receipt-checked ENS manifest with twelve confirmations is required');
  const pins = { chainId: 1, ethRegistry: manifest.upstream?.ETHRegistry?.address,
    registrar: { address: manifest.registrar?.address, codeHash: manifest.registrar?.codeHash, registry: manifest.subregistry } };
  if (![pins.ethRegistry, pins.registrar.address, pins.registrar.registry].every(value => /^0x[0-9a-fA-F]{40}$/.test(value ?? '') && !/^0x0+$/i.test(value)) ||
      !hashPattern.test(pins.registrar.codeHash ?? '') || /^0x0+$/i.test(pins.registrar.codeHash) || !sameAddress(pins.ethRegistry, addresses.ETHRegistry)) throw new Error('Manifest has invalid mainnet directory pins');
  return pins;
}

/** Public administrative reads only. There is deliberately no wallet or send RPC here. */
export async function checkSubmittedTransaction(client, item, hash, reviewBlock) {
  if (!hashPattern.test(hash)) throw new Error('Expected a transaction hash');
  if (await client.getChainId() !== 1) throw new Error('Administrative RPC is not Ethereum mainnet');
  let tx;
  try { tx = await client.getTransaction({ hash }); }
  catch (error) { if (error.name === 'TransactionNotFoundError') return null; throw error; }
  const expected = item.walletRequest.params[0];
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || !sameAddress(tx.from, expected.from) ||
      (expected.to ? !sameAddress(tx.to, expected.to) : tx.to !== null) || tx.input.toLowerCase() !== expected.data.toLowerCase() ||
      tx.value !== 0n || tx.chainId !== 1 || expected.nonce !== undefined && BigInt(tx.nonce) !== BigInt(expected.nonce)) {
    throw new Error('Transaction does not match the reviewed sender, destination, calldata, value, network or nonce');
  }
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error.name === 'TransactionReceiptNotFoundError') return null; throw error; }
  if (receipt.status !== 'success') throw new Error('Transaction reverted. Resolve its receipt before attempting a replacement');
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || !sameAddress(receipt.from, expected.from) ||
      receipt.blockNumber <= BigInt(reviewBlock) || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber ||
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Transaction receipt is not canonical or does not follow the review block');
  return clone({ hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
}

export async function createEnsSession({ config, directory, client, crosscheckClient, build = registrarBuild(),
  planner = preparePlan, verifier = verifyDeployment, validateInput = validateConfig,
  checkStageIdentity = verifyStageIdentity, reconstructTransaction = expectedTransaction, exportPins = directoryPins }) {
  if (!crosscheckClient) throw new Error('A second administrative RPC is required');
  const input = clone(validateInput(config));
  const path = resolve(directory, 'session.json');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let session = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
    schemaVersion: 1, kind: 'derpc-ens-wallet-session', inputHash: digest(input), config: input, stages: [], sourceHash: build.sourceHash,
  };
  if (session.kind !== 'derpc-ens-wallet-session' || session.schemaVersion !== 1 || session.inputHash !== digest(input) ||
      session.sourceHash !== build.sourceHash) throw new Error('Saved session belongs to another config or registrar source; keep its evidence and use its original inputs');
  validateInput(session.config);
  checkStageIdentity(input, session.config);
  const fixedConfig = clone(session.config); delete fixedConfig.registrar;
  const fixedInput = clone(input); delete fixedInput.registrar;
  if (json(fixedConfig) !== json(fixedInput)) throw new Error('Saved deployment configuration differs from the chosen operator configuration');
  for (const stage of session.stages) {
    if (stage.plan.sourceHash !== build.sourceHash || json(stage.plan.compiler) !== json(build.compiler)) throw new Error('Saved stage source or compiler changed');
    checkStageIdentity(stage.plan.resumeConfig, session.config);
    if (stage.entries.length !== stage.plan.transactions.length) throw new Error('Saved stage entries are incomplete');
    stage.plan.transactions.forEach((item, index) => {
      if (stage.entries[index].id !== item.id || !['ready', 'pending', 'submitted', 'confirmed'].includes(stage.entries[index].status) ||
          json(item.walletRequest.params[0]) !== json(reconstructTransaction(item, stage.plan.resumeConfig, stage.plan, build))) throw new Error('Saved stage transaction changed');
    });
  }
  let busy = false;
  const persist = () => {
    atomicSave(path, session);
    atomicSave(resolve(directory, 'resume-config.json'), session.config);
    session.stages.forEach((stage, i) => atomicSave(resolve(directory, `stage-${i + 1}.json`), stage.plan));
    atomicSave(resolve(directory, 'receipts.json'), { stages: session.stages.map((stage, i) => ({
      planFile: `stage-${i + 1}.json`, transactionHashes: stage.entries.map(entry => entry.hash ?? null),
    })) });
  };
  const invalidateVerification = () => {
    if (session.manifest || session.pins) {
      atomicSave(resolve(directory, 'previous-verification.json'), { invalidatedAt: new Date().toISOString(),
        manifest: session.manifest, crosscheck: session.crosscheck, directoryPins: session.pins });
      for (const file of ['deployment-manifest.json', 'deployment-crosscheck.json', 'ens-directory.json']) {
        const target = resolve(directory, file); if (existsSync(target)) unlinkSync(target);
      }
    }
    session.manifest = null; session.pins = null; session.crosscheck = null; session.finalPlan = null;
    persist();
  };
  async function freshPlan() {
    const a = clone(await planner({ config: session.config, client, build }));
    const b = clone(await planner({ config: a.resumeConfig, client: crosscheckClient, build }));
    const intent = plan => ({ stage: plan.stage, sourceHash: plan.sourceHash, compiler: plan.compiler, subregistry: plan.subregistry,
      resolvers: plan.resolvers, config: plan.resumeConfig, roleTable: plan.roleTable,
      transactions: plan.transactions.map(item => ({ id: item.id, walletRequest: item.walletRequest })) });
    if (json(intent(a)) !== json(intent(b))) throw new Error('The two administrative RPC sources disagree; no wallet request is enabled');
    if (a.preflight.localOnly !== false || b.preflight.localOnly !== false) throw new Error('This wallet helper requires public mainnet RPC sources');
    if ((await client.getBlock({ blockNumber: BigInt(a.preflight.blockNumber) })).hash !== a.preflight.blockHash ||
        (await crosscheckClient.getBlock({ blockNumber: BigInt(a.preflight.blockNumber) })).hash !== a.preflight.blockHash) throw new Error('Administrative sources disagree on the canonical review block');
    return a;
  }
  async function updateReceipts() {
    for (const stage of session.stages) for (let i = 0; i < stage.entries.length; i++) {
      const entry = stage.entries[i];
      if (!entry.hash) continue;
      const item = stage.plan.transactions[i];
      const checks = await Promise.all([client, crosscheckClient].map(source => checkSubmittedTransaction(source, item, entry.hash, stage.plan.preflight.blockNumber)));
      if (checks.every(Boolean) && json(checks[0]) === json(checks[1])) { entry.status = 'confirmed'; entry.receipt = checks[0]; }
      else { entry.status = 'submitted'; delete entry.receipt; }
    }
    persist();
  }
  async function refresh() {
    invalidateVerification();
    await updateReceipts();
    const last = session.stages.at(-1);
    if (last && session.stages.some(stage => stage.entries.some(entry => entry.status !== 'confirmed'))) return;
    const plan = await freshPlan();
    session.config = plan.resumeConfig;
    session.finalPlan = plan.status === 'state-matches-config' ? plan : null;
    if (!session.finalPlan) session.stages.push({ plan, entries: plan.transactions.map(item => ({ id: item.id, status: 'ready' })) });
    persist();
  }
  const state = () => clone({ plan: session.finalPlan ?? session.stages.at(-1)?.plan, entries: session.finalPlan ? [] : session.stages.at(-1)?.entries ?? [],
    complete: !!session.manifest, readyToVerify: !!session.finalPlan, manifest: session.manifest ?? null, directoryPins: session.pins ?? null,
    stageNumber: session.stages.length, evidenceDirectory: resolve(directory) });
  if (!session.stages.length) await refresh();
  else if (session.manifest) invalidateVerification();
  else persist();
  return { state, async action(request) {
    if (busy) throw new Error('Another deployment operation is running');
    busy = true;
    try {
      const stage = session.stages.at(-1);
      const index = stage?.entries.findIndex(entry => entry.id === request.id) ?? -1;
      const entry = index >= 0 ? stage.entries[index] : null;
      const item = index >= 0 ? stage.plan.transactions[index] : null;
      if (request.action === 'refresh') { await refresh(); return state(); }
      if (request.action === 'verify') {
        const wasReady = !!session.finalPlan;
        invalidateVerification();
        await updateReceipts();
        if (!wasReady || session.stages.some(s => s.entries.some(e => e.status !== 'confirmed'))) throw new Error('All stages must have matching receipts before final verification');
        const finalPlan = await freshPlan();
        if (finalPlan.status !== 'state-matches-config') throw new Error('Deployment changed; refresh and inspect its next required stage');
        session.finalPlan = finalPlan; persist();
        const stages = session.stages.map(s => ({ plan: s.plan, transactionHashes: s.entries.map(e => e.hash) }));
        const manifest = clone(await verifier({ config: session.config, stages, client, build, confirmations: 12 }));
        const second = clone(await verifier({ config: session.config, stages, client: crosscheckClient, build, confirmations: 12 }));
        const pins = exportPins(manifest);
        if (json(pins) !== json(exportPins(second)) || json(manifest.operators) !== json(second.operators) || json(manifest.roleTable) !== json(second.roleTable)) throw new Error('Deployment verification differs between RPC sources');
        session.manifest = manifest; session.crosscheck = second; session.pins = pins; persist();
        atomicSave(resolve(directory, 'deployment-manifest.json'), manifest);
        atomicSave(resolve(directory, 'deployment-crosscheck.json'), second);
        atomicSave(resolve(directory, 'ens-directory.json'), pins);
        return state();
      }
      if (!entry || session.finalPlan) throw new Error('Unknown current-stage transaction');
      if (request.action === 'begin') {
        if (entry.status !== 'ready' || stage.entries.some(e => ['pending', 'submitted'].includes(e.status))) throw new Error('Resolve the earlier wallet submission before sending another transaction');
        await updateReceipts();
        if (stage.entries.some(e => ['pending', 'submitted'].includes(e.status))) throw new Error('An earlier receipt in this stage is no longer confirmed');
        if (session.stages.some(s => s !== stage && s.entries.some(e => e.status !== 'confirmed'))) throw new Error('An earlier receipt is no longer confirmed');
        for (const source of [client, crosscheckClient]) if ((await source.getBlock({ blockNumber: BigInt(stage.plan.preflight.blockNumber) })).hash !== stage.plan.preflight.blockHash) throw new Error('The original review block is no longer canonical');
        const plan = await freshPlan();
        const current = plan.transactions.find(tx => tx.id === item.id);
        if (!current || json(current.walletRequest) !== json(item.walletRequest)) throw new Error('On-chain state or transaction changed; inspect the earlier submission before continuing');
        entry.status = 'pending'; entry.startedAt = new Date().toISOString(); persist();
        return { ...state(), permit: { id: item.id, walletRequest: clone(item.walletRequest), expiresAt: Date.now() + 60000 } };
      }
      if (request.action === 'record') {
        if (!['pending', 'submitted'].includes(entry.status) || !hashPattern.test(request.hash ?? '')) throw new Error('Only a pending submission can receive a valid transaction hash');
        if (entry.hash && entry.hash.toLowerCase() !== request.hash.toLowerCase()) throw new Error('A hash is already recorded; reconcile the original transaction before replacing it');
        if (session.stages.some(s => s.entries.some(e => e !== entry && e.hash?.toLowerCase() === request.hash.toLowerCase()))) throw new Error('Transaction hash is already assigned');
        // Preserve returned evidence even while the RPC has not yet indexed it.
        entry.hash = request.hash; entry.status = 'submitted'; persist();
        await updateReceipts(); return state();
      }
      if (request.action === 'rejected') {
        if (entry.status !== 'pending' || entry.hash) throw new Error('Only an explicitly rejected wallet request without a hash can be cleared');
        entry.status = 'ready'; delete entry.startedAt; persist(); return state();
      }
      throw new Error('Unsupported action');
    } finally { busy = false; }
  } };
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DeRPC ENS deployment</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><script type="module" src="/start.js"></script><main id="ens-wallet-root"></main></html>`;
const css = `:root{color-scheme:light dark;font:16px system-ui}body{margin:0;padding:24px}main{max-width:960px;margin:auto;overflow-wrap:anywhere}p{line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#8882}button,input,select{font:inherit;margin:6px 0;padding:8px;max-width:100%;box-sizing:border-box}button{cursor:pointer}button:disabled{cursor:not-allowed}label{display:block}dd{margin:6px 0;overflow-wrap:anywhere}section{border-top:1px solid #8885;padding:16px 0}[role=status]{white-space:pre-wrap;overflow-wrap:anywhere}input[type=text]{width:42rem}`;

export async function startEnsWallet({ session, port = 8792 }) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const token = randomBytes(32).toString('hex');
  const script = readFileSync(new URL('./ens-wallet-client.mjs', import.meta.url), 'utf8');
  let origin;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000 }, async (request, response) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
    const send = (status, type, body) => { response.writeHead(status, { ...headers, 'content-type': type }); response.end(body); };
    const jsonResponse = (status, data) => send(status, 'application/json', json(data));
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) return send(403, 'text/plain', 'Origin refused');
    const site = request.headers['sec-fetch-site'];
    const navigation = request.url === '/' && request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' && request.headers['sec-fetch-user'] === '?1';
    if (site && !['same-origin', 'none'].includes(site) && !navigation) return send(403, 'text/plain', 'Cross-origin request refused');
    if (request.method === 'GET') {
      const assets = { '/': ['text/html', html], '/style.css': ['text/css', css], '/wallet.js': ['text/javascript', script],
        '/favicon.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#20252a"/><path d="M10 8h5c12 0 12 16 0 16h-5V8zm4 4v8h1c6 0 6-8 0-8h-1z" fill="white"/></svg>'],
        '/start.js': ['text/javascript', "import { boot } from '/wallet.js'; boot(document.getElementById('ens-wallet-root')).catch(e => { document.getElementById('ens-wallet-root').textContent = e.message; });"] };
      if (request.url === '/state') return jsonResponse(200, { ...session.state(), token });
      const asset = Object.hasOwn(assets, request.url) && assets[request.url];
      return asset ? send(200, `${asset[0]}; charset=utf-8`, asset[1]) : send(404, 'text/plain', 'Not found');
    }
    if (request.method !== 'POST' || request.url !== '/action') return send(405, 'text/plain', 'Method refused');
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') return send(403, 'text/plain', 'Same-origin JSON required');
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new Error('Request too large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.token !== token) return send(403, 'text/plain', 'Session token refused');
      jsonResponse(200, { ...await session.action(input), token });
    } catch (error) { jsonResponse(409, { ...session.state(), token, error: errorMessage(error) }); }
  });
  server.maxConnections = 16;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`; server.off('error', reject); accept();
  }); });
  return { server, origin };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--config', '--out', '--rpc', '--crosscheck-rpc', '--port'].includes(key) || !args[i + 1] || options[key]) throw new Error('Usage: ens-wallet.mjs --config config.json --out evidence-directory [--rpc URL --crosscheck-rpc URL --port 8792]');
    options[key] = args[i + 1];
  }
  if (!options['--config'] || !options['--out']) throw new Error('--config and --out are required');
  const primary = options['--rpc'] ?? 'https://ethereum-rpc.publicnode.com';
  const secondary = options['--crosscheck-rpc'] ?? 'https://eth.drpc.org';
  if (new URL(primary).origin === new URL(secondary).origin) throw new Error('Use distinct administrative RPC sources');
  const directory = resolve(options['--out']); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, 'wallet.lock'); const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  const release = () => { try { unlinkSync(lock); } catch {} };
  try {
    const session = await createEnsSession({ config: loadConfig(options['--config']), directory,
      client: adminClient(primary), crosscheckClient: adminClient(secondary) });
    const { server, origin } = await startEnsWallet({ session, port: Number(options['--port'] ?? 8792) });
    console.log(`Review ENS deployment: ${origin}`);
    console.log(`Operators: ${session.state().plan.resumeConfig.operators.map(op => op.label + '.derpc.eth').join(', ')}`);
    console.log(`Evidence: ${directory}. Mainnet gas is paid by your wallet. No transaction has been sent.`);
    // In-flight administrative work may still persist state after sockets close.
    // Keep the exclusive lock until the process has actually finished that work.
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
    process.once('exit', release);
  } catch (error) { release(); throw error; }
}
if (isMain(import.meta.url)) main().catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
