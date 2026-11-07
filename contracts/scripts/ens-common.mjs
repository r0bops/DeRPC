// Node-only adapters; validation and public interfaces are shared with the browser.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { fail, json } from '../lib/ens-common.mjs';
export * from '../lib/ens-common.mjs';

export const save = (file, value) => writeFileSync(file, json(value), { flag: 'wx' });
export const isMain = url => process.argv[1] && pathToFileURL(process.argv[1]).href === url;
export const reportError = error => { console.error(error.name === 'Error' ? error.message : 'Administrative RPC check failed; inspect the RPC connection without exposing credentials.'); process.exitCode = 1; };

export function adminClient(url = process.env.ENS_RPC_URL ?? 'https://ethereum-rpc.publicnode.com') {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) fail('Invalid administrative RPC URL');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) fail('Remote administrative RPC requires HTTPS');
  // Deliberately no wallet client, signer, private key, or transaction submission path.
  return createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000 }), ccipRead: false });
}
