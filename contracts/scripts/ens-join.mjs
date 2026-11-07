import { readFileSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminClient, fail, isMain } from './ens-common.mjs';
import { registrarBuild } from './ens-plan.mjs';
import { createEnsSession, startEnsWallet } from './ens-wallet.mjs';
import { checkJoinIdentity, enrollmentPins, expectedJoinTransaction, joinConfigFromDeployment, validateJoinConfig,
  prepareJoinPlan as prepareCoreJoinPlan, verifyJoin as verifyCoreJoin } from '../lib/ens-join.mjs';
export { checkJoinIdentity, enrollmentPins, expectedJoinTransaction, joinConfigFromDeployment, validateJoinConfig } from '../lib/ens-join.mjs';

export async function prepareJoinPlan({ build = registrarBuild(), ...options }) {
  return prepareCoreJoinPlan({ ...options, build });
}
export async function verifyJoin({ build = registrarBuild(), ...options }) {
  return verifyCoreJoin({ ...options, build });
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--deployment', '--operator', '--deployment-id', '--out', '--rpc', '--crosscheck-rpc', '--port'].includes(key) || !args[i + 1] || options[key]) fail('Usage: ens-join.mjs --deployment verified-deployment.json --operator operator-entry.json --out evidence-directory [--deployment-id ID --rpc URL --crosscheck-rpc URL --port 8793]');
    options[key] = args[i + 1];
  }
  if (!options['--deployment'] || !options['--operator'] || !options['--out']) fail('--deployment, --operator and --out are required');
  const manifest = JSON.parse(readFileSync(options['--deployment'], 'utf8')), entry = JSON.parse(readFileSync(options['--operator'], 'utf8'));
  const config = joinConfigFromDeployment({ manifest, operator: entry.operatorConfig ?? entry, deploymentId: options['--deployment-id'] });
  const primary = options['--rpc'] ?? 'https://ethereum-rpc.publicnode.com', secondary = options['--crosscheck-rpc'] ?? 'https://eth.drpc.org';
  if (new URL(primary).origin === new URL(secondary).origin) fail('Use distinct administrative RPC sources');
  const directory = resolve(options['--out']); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, 'wallet.lock'), fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  const release = () => { try { unlinkSync(lock); } catch {} };
  try {
    const session = await createEnsSession({ config, directory, client: adminClient(primary), crosscheckClient: adminClient(secondary),
      planner: prepareJoinPlan, verifier: verifyJoin, validateInput: validateJoinConfig, checkStageIdentity: checkJoinIdentity,
      reconstructTransaction: expectedJoinTransaction, exportPins: enrollmentPins });
    const { server, origin } = await startEnsWallet({ session, port: Number(options['--port'] ?? 8793) });
    console.log(`Review your operator registration: ${origin}`);
    console.log(`Signer: ${config.operators[0].operator}. Three operator transactions; mainnet gas is paid in the wallet. No transaction has been sent.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
    process.once('exit', release);
  } catch (error) { release(); throw error; }
}
if (isMain(import.meta.url)) main().catch(error => { console.error(String(error.shortMessage ?? error.message).slice(0, 600)); process.exitCode = 1; });
