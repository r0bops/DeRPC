// Run one app-funded read using the application's configured anonymous runtime.
// No transport, trust anchor, key or funding identity is substituted.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SponsoredPaymentClient, createSponsoredHttpTransport } from '../src/index.ts';
import { createSponsoredReader } from './sponsored-reader.ts';

if (!process.argv[2]) throw new Error('Pass an application module exporting session, sessionKey, userSigner, coordinatorUrl, coordinatorFetch, headers, send, request and control.');
const config = await import(pathToFileURL(resolve(process.argv[2])).href);
if (typeof config.send !== 'function' || typeof config.coordinatorFetch !== 'function' || typeof config.headers?.finalized !== 'function' || typeof config.headers?.assertFresh !== 'function' || !config.userSigner || !config.request || !config.control) throw new Error('The application must supply its actual anonymous transport, authenticated header view, delegated key and read request.');
const client = new SponsoredPaymentClient({ session: config.session, sessionKey: config.sessionKey,
  userSigner: config.userSigner, transport: createSponsoredHttpTransport({ url: config.coordinatorUrl, fetch: config.coordinatorFetch }) });
const reader = createSponsoredReader({ client, headers: config.headers, send: config.send });
try {
  const result = await reader.read(config.request, config.control);
  console.log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
} finally { await config.close?.(); }
