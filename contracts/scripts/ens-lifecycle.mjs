import { readFileSync } from 'node:fs';
import { adminClient, fail, isMain, reportError, save } from './ens-common.mjs';
import { registrarBuild } from './ens-plan.mjs';
import { prepareLifecycle as prepare, checkLifecyclePlan as check, verifyLifecycle as verify } from '../lib/ens-lifecycle.mjs';
export * from '../lib/ens-lifecycle.mjs';

// Preserve the Node API's local compiler default; browser callers supply a pinned build explicitly.
export const prepareLifecycle = options => prepare({ ...options, build: options.build ?? registrarBuild() });
export const checkLifecyclePlan = options => check({ ...options, build: options.build ?? registrarBuild() });
export const verifyLifecycle = options => verify({ ...options, build: options.build ?? registrarBuild() });

async function main() {
  const [command, manifestFile, inputFile, next, last, rpcArgument] = process.argv.slice(2);
  if (!['prepare', 'check', 'verify'].includes(command) || !manifestFile || !inputFile || !next || command === 'verify' && !last) fail('usage: ens-lifecycle.mjs prepare manifest.json action.json plan.json [rpc] | check manifest.json plan.json check.json [rpc] | verify manifest.json plan.json txHash evidence.json [rpc]');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')), input = JSON.parse(readFileSync(inputFile, 'utf8'));
  const client = adminClient(command === 'verify' ? rpcArgument : last);
  const result = command === 'prepare' ? await prepareLifecycle({ manifest, action: input, client }) : command === 'check' ? await checkLifecyclePlan({ manifest, plan: input, client }) : await verifyLifecycle({ manifest, plan: input, transactionHash: next, client });
  const output = command === 'verify' ? last : next;
  save(output, result);
  console.log(`${command} output saved to ${output}. No transaction was signed or sent.`);
}
if (isMain(import.meta.url)) main().catch(reportError);
