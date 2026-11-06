import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { escrowBuild, validatePlan } from './payment-deploy.mjs';
import { validateWalletReview } from './payment-wallet-client.mjs';

export const MAX_PLAN_BYTES = 128 * 1024;
const clientScript = readFileSync(new URL('./payment-wallet-client.mjs', import.meta.url), 'utf8');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeRPC test escrow deployment</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><script type="module" src="/wallet.js"></script></head>
<body><main><h1>Deploy the test escrow</h1><p>This local page sends one reviewed contract-creation request to your browser wallet. The wallet keeps its keys and handles the transaction; the local server receives no keys, signatures or transaction hash.</p>
<p class="status" id="status">Not deployed</p><p id="message" role="status">Loading the checked plan…</p>
<dl><dt>Network</dt><dd id="network"></dd><dt>Sender</dt><dd id="sender"></dd><dt>Transferred value</dt><dd>0 ETH. The wallet charges test ETH for deployment gas.</dd><dt>Source hash</dt><dd id="source"></dd><dt>Runtime code hash</dt><dd id="runtime"></dd><dt>Creation code hash</dt><dd id="creation"></dd><dt>Compiler</dt><dd id="compiler"></dd><dt>Plan prepared</dt><dd id="created"></dd></dl>
<details><summary>Saved gas and balance preflight</summary><p>These are earlier administrative RPC observations, not a fresh quote or light-client verification.</p><pre id="preflight"></pre></details>
<details><summary>Exact contract-creation bytecode</summary><pre id="bytecode"></pre></details>
<p id="wallet-detection" role="status">Looking for wallet extensions…</p><p><label for="wallet-select">Wallet extension</label> <select id="wallet-select"><option value="">No wallet detected</option></select> <button id="detect" type="button">Detect wallets</button></p>
<p>Wallet: <span id="wallet">Not connected</span></p><button id="connect" type="button">Connect selected wallet</button> <button id="switch-network" type="button" disabled>Switch to required testnet</button>
<p id="network-details"></p><p id="connection-message" role="status">Connect the reviewed account on the required testnet to enable the review checkbox.</p>
<p><label><input id="review" type="checkbox" aria-describedby="connection-message" disabled> I reviewed the sender, testnet, bytecode hashes and zero transferred value.</label></p><button id="send" type="button" disabled>Review and deploy in wallet</button>
<p>Check the wallet's network, sender and fees before approving. This is a test-funds deployment, and paid queries are linkable to the paying account. Wallet traffic goes outside Anon-RPC.</p>
<h2>Transaction result</h2><pre id="transaction-hash">No transaction submitted.</pre><button id="export" type="button" disabled>Export transaction hash</button><p>A returned hash is not a deployment receipt. Verify the receipt and runtime before configuring payments.</p><pre id="verify-command">Run payment-deploy.mjs verify after a transaction has been submitted.</pre>
</main></body></html>`;
const css = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;padding:24px}main{max-width:850px;margin:auto}h1{font-size:1.8rem}p{line-height:1.5}dt{font-weight:600;margin-top:16px}dd{margin:4px 0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:light-dark(#f1f3f5,#20252a);border-radius:6px}button{font:inherit;padding:10px 16px;cursor:pointer}button:disabled{cursor:not-allowed}details{margin:18px 0}summary{cursor:pointer}.status{font-weight:700}`;

export function loadWalletPlan(path, build = escrowBuild()) {
  const metadata = statSync(path);
  if (!metadata.isFile()) throw new Error('deployment plan must be a regular file');
  if (metadata.size > MAX_PLAN_BYTES) throw new Error('deployment plan exceeds 128 KiB');
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_PLAN_BYTES) throw new Error('deployment plan exceeds 128 KiB');
  let plan;
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid deployment plan JSON'); }
  validatePlan(plan, build, false);
  validateWalletReview(plan);
  return plan;
}

export async function startWalletReview({ planPath, port = 8791, build = escrowBuild() }) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer between 0 and 65535');
  // Validate BEFORE opening a listener. Serve an immutable in-memory snapshot thereafter.
  const plan = loadWalletPlan(planPath, build);
  const planJson = JSON.stringify(plan);
  let origin;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (request, response) => {
    const headers = {
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    };
    const reject = status => { response.writeHead(status, { ...headers, 'content-type': 'text/plain', 'connection': 'close' }); response.end('Request refused.'); };
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) return reject(403);
    const site = request.headers['sec-fetch-site'];
    // A user may click the local link from another site. Only top-level, user-initiated
    // navigation to the inert review page is allowed; scripts/plan remain same-origin.
    const navigation = request.url === '/' && request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document' && request.headers['sec-fetch-user'] === '?1';
    if (site && site !== 'same-origin' && site !== 'none' && !navigation) return reject(403);
    if (request.method !== 'GET') return reject(405);
    const assets = {
      '/': ['text/html; charset=utf-8', html],
      '/wallet.js': ['text/javascript; charset=utf-8', clientScript],
      '/style.css': ['text/css; charset=utf-8', css],
      '/favicon.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#20252a"/><path d="M10 8h5c12 0 12 16 0 16h-5V8zm4 4v8h1c6 0 6-8 0-8h-1z" fill="white"/></svg>'],
      '/plan.json': ['application/json; charset=utf-8', planJson],
    };
    const asset = Object.hasOwn(assets, request.url) ? assets[request.url] : undefined;
    if (!asset) return reject(404);
    response.writeHead(200, { ...headers, 'content-type': asset[0], 'content-length': Buffer.byteLength(asset[1]) });
    response.end(asset[1]);
  });
  server.maxConnections = 16;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; server.off('error', reject); resolve(); });
  });
  return { server, origin, plan };
}

async function main() {
  const args = process.argv.slice(2);
  let planPath, port = 8791, portSpecified = false;
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i + 1]) throw new Error('usage: node contracts/scripts/payment-wallet.mjs --plan <reviewed-plan.json> [--port 8791]');
    if (args[i] === '--plan' && !planPath) planPath = args[i + 1];
    else if (args[i] === '--port' && !portSpecified) { port = Number(args[i + 1]); portSpecified = true; }
    else throw new Error('unknown or duplicate argument');
  }
  if (!planPath) throw new Error('--plan is required');
  const { server, origin, plan } = await startWalletReview({ planPath, port });
  console.log(`Review ${plan.name} escrow deployment at ${origin}`);
  console.log(`Sender ${plan.walletRequest.params[0].from}; source ${plan.sourceHash}; runtime ${plan.codeHash}`);
  console.log('Status: not deployed. Connect the wallet and manually review/sign in the browser. The server never sends a transaction.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
