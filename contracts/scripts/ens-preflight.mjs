import { adminClient, preflight, save, isMain, reportError } from './ens-common.mjs';

async function main() {
  const [output, rpc] = process.argv.slice(2);
  if (!output) throw new Error('usage: node contracts/scripts/ens-preflight.mjs output.json [public-rpc-url]');
  save(output, await preflight(adminClient(rpc)));
  console.log(`Read-only ENS preflight saved to ${output}. No transaction was sent.`);
}
if (isMain(import.meta.url)) main().catch(reportError);
