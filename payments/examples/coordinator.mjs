// Run: node payments/examples/coordinator.mjs /absolute/path/app-coordinator.mjs
// The application module must export its actual verified-evidence callback; no fallback exists.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { SponsoredPaymentCoordinator } from '../src/index.ts';
import { FileDelegationStore, serveSponsoredCoordinator } from '../src/node-store.ts';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('Pass an application configuration module with session, verifyFunding and verifyRead exports.');
const config = await import(pathToFileURL(resolve(modulePath)).href);
if (typeof config.verifyRead !== 'function' || typeof config.verifyFunding !== 'function' || !config.session || typeof config.price !== 'bigint' || typeof config.stateDirectory !== 'string' || typeof config.sessionKeyFile !== 'string') {
  throw new Error('Configuration must supply session, price, stateDirectory, sessionKeyFile, verifyFunding and the real verifyRead callback.');
}
const keyInfo = await stat(config.sessionKeyFile);
if (!keyInfo.isFile() || keyInfo.uid !== process.getuid() || (keyInfo.mode & 0o077) !== 0) throw new Error('Session key file must be owner-only (chmod 600).');
const secret = (await readFile(config.sessionKeyFile, 'utf8')).trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw new Error('Session key file must contain a private key as 32-byte hex.');
const signer = privateKeyToAccount(secret);
// The callback must authenticate the payment chain/contract/session from the app's trusted view.
const funded = await config.verifyFunding();
if (!funded || funded.closed || funded.chainId !== config.session.chainId || funded.escrow.toLowerCase() !== config.session.escrow.toLowerCase() || BigInt(funded.sessionId) !== config.session.sessionId || funded.sessionKey.toLowerCase() !== signer.address.toLowerCase() || BigInt(funded.deposit) < config.session.budget || Number(funded.refundAfter) !== config.session.refundAfter) {
  throw new Error('Confirmed funding does not match the configured delegated session.');
}
const store = await FileDelegationStore.open(config.stateDirectory);
let server;
try {
  const coordinator = new SponsoredPaymentCoordinator({ session: config.session, store,
    price: config.price, signer, verifyRead: config.verifyRead });
  // Application administration supplies initial grants/revocations. Never expose this unauthenticated.
  if (config.administer) await config.administer(coordinator);
  server = await serveSponsoredCoordinator(coordinator, { port: config.port ?? 8790 });
  // Optional trusted local administration can retain the service for later prepareClose/settlement.
  if (config.onReady) await config.onReady(coordinator);
  console.log(`DeRPC app coordinator listening on 127.0.0.1:${server.address().port}; test payments only`);
  let stopping;
  const stop = () => stopping ??= (async () => {
    const drained = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections();
    await drained;
    await store.close();
  })();
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch (error) {
  if (server) await new Promise(resolve => server.close(resolve));
  await store.close();
  throw error;
}
