import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { decodeFunctionData, encodeDeployData, encodeFunctionData, keccak256, toHex } from 'viem';
import { addresses, adminClient, curatorRoles, deploymentSalt, dnsEncode, ENDPOINT_KEYS, endpointMigrationCalls, endpointMigrationState, endpointRecordKey, factoryAbi, fail, isMain, json, labelId, obsoleteEndpointKey, operatorRecords, permissionAbi, readAt, RECORD_KEYS, registrarRoles, registryAbi, reportError, resolverAbi, resolverOwnerRoles, sameAddress, save, setter, validateConfig } from './ens-common.mjs';
import { loadConfig, preparePlan, registrarBuild } from './ens-plan.mjs';

// Reconstruct each permitted call from the final reviewed config. A forged plan cannot
// smuggle a value transfer, arbitrary setter, admin role, or unrelated transaction into evidence.
export function expectedTransaction(item, config, plan, build) {
  const call = (from, to, abi, functionName, args) => ({ from, to, data: encodeFunctionData({ abi, functionName, args }), value: '0x0', chainId: '0x1' });
  if (item.id === 'deploy-registry') return call(config.deployer, addresses.VerifiableFactory, factoryAbi, 'deployProxy', [addresses.UserRegistryImpl, deploymentSalt(config, 'registry'), encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: config.curator, roleBitmap: curatorRoles }]] })]);
  if (item.id === 'deploy-registrar') return { from: config.deployer, data: encodeDeployData({ abi: build.artifact.abi, bytecode: `0x${build.artifact.evm.bytecode.object}`, args: [plan.subregistry, config.curator] }), value: '0x0', chainId: '0x1', nonce: toHex(config.registrar.nonce) };
  if (item.id === 'grant-registrar') return call(config.curator, plan.subregistry, registryAbi, 'grantRootRoles', [registrarRoles, config.registrar.address]);
  if (item.id === 'set-registry-parent') return call(config.curator, plan.subregistry, registryAbi, 'setParent', [addresses.ETHRegistry, 'derpc']);
  if (item.id === 'attach-subregistry') return call(config.curator, addresses.ETHRegistry, registryAbi, 'setSubregistry', [labelId('derpc'), plan.subregistry]);
  for (const op of config.operators) {
    const resolver = plan.resolvers[op.label], name = `${op.label}.${config.parentName}`;
    if (item.id === `deploy-resolver-${op.label}`) return call(config.deployer, addresses.VerifiableFactory, factoryAbi, 'deployProxy', [addresses.PermissionedResolverImpl, deploymentSalt(config, `resolver:${op.label}`), encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: op.coldOwner, roleBitmap: resolverOwnerRoles }], Object.entries(operatorRecords(op)).map(([key, value]) => setter(name, key, value))] })]);
    const selected = endpointRecordKey(op);
    if (item.id === `grant-${selected === 'derpc.endpoints' ? 'endpoints' : 'endpoint'}-${op.label}`) return call(op.coldOwner, resolver, resolverAbi, 'grantSetterRoles', [setter(name, selected, ''), op.hotKey]);
    if (item.id === `migrate-endpoint-mode-${op.label}`) return call(op.coldOwner, resolver, resolverAbi, 'multicall', [endpointMigrationCalls(op, name)]);
    // Reconstruct the sender independently of the supplied plan: even the curator
    // cannot submit a registration on behalf of a different operator.
    if (item.id === `register-${op.label}`) return call(op.operator, config.registrar.address, build.artifact.abi, 'register', [op.label, op.operator, resolver, op.payee, BigInt(op.expiry)]);
    const records = operatorRecords(op);
    for (const key of RECORD_KEYS) {
      if (item.id === `record-${op.label}-${key}`) return call(op.coldOwner, resolver, resolverAbi, 'setText', [dnsEncode(name), key, records[key] ?? '']);
    }
    if (item.id === `renew-${op.label}`) {
      const decoded = decodeFunctionData({ abi: build.artifact.abi, data: item.walletRequest?.params?.[0]?.data });
      if (decoded.functionName !== 'renew' || decoded.args[0] < 0n || decoded.args[0] >= 128n || BigInt(decoded.args[1]) !== BigInt(op.expiry)) fail('Invalid renewal intent');
      return call(config.curator, config.registrar.address, build.artifact.abi, 'renew', decoded.args);
    }
  }
  fail('Unrecognized ENS transaction intent');
}

export function verifyStageIdentity(stage, final) {
  const identity = config => ({ chainId: config.chainId, parentName: config.parentName, deploymentId: config.deploymentId, curator: config.curator, deployer: config.deployer, operators: config.operators.map(op => ({ label: op.label, operator: op.operator, coldOwner: op.coldOwner, hotKey: op.hotKey, signer: op.signer, payee: op.payee })).sort((a, b) => a.label.localeCompare(b.label)) });
  if (json(identity(stage)) !== json(identity(final)) || stage.registrar && json(stage.registrar) !== json(final.registrar)) fail('Historical stage changes the fixed deployment or operator identities');
}

async function verifyMigration({ item, plan, config, final, receipt, client }) {
  const label = item.id.slice('migrate-endpoint-mode-'.length), op = config.operators.find(op => op.label === label);
  const selected = endpointRecordKey(op), obsolete = obsoleteEndpointKey(op), resolver = final.resolvers[label], name = `${label}.${config.parentName}`;
  if (item.migration?.selected !== selected || item.migration?.obsolete !== obsolete) fail('Migration review does not identify both old and new permission scopes');
  const reviewBlock = BigInt(plan.preflight.blockNumber);
  if ((await client.getBlock({ blockNumber: reviewBlock })).hash !== plan.preflight.blockHash || receipt.blockNumber <= reviewBlock) fail('Migration review block is not canonical or does not precede its receipt');
  const atReview = await endpointMigrationState(readAt(client, reviewBlock), resolver, name, op);
  if (json(atReview) !== json(item.migration.before)) fail('Migration reviewed endpoint state was altered');
  if (atReview.ownerRoot !== resolverOwnerRoles || atReview.hotRoot !== 0n || atReview.rootCount !== resolverOwnerRoles || ['derpc.price', 'derpc.payee', 'derpc.paymentChain', 'derpc.escrow'].some(key => atReview.protectedRecords[key] !== '')) fail('Migration requires free records and unchanged limited resolver roles');
  const preceding = await endpointMigrationState(readAt(client, receipt.blockNumber - 1n), resolver, name, op);
  if (json(preceding) !== json(atReview)) fail('Migration endpoint state changed before mining');
  const events = await client.getLogs({ address: resolver, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
  if (events.some(event => event.blockHash !== receipt.blockHash || event.transactionIndex !== receipt.transactionIndex || event.transactionHash !== receipt.transactionHash || event.removed === true)) fail('Another resolver mutation or inconsistent event occurred in the migration receipt block');
  const after = await endpointMigrationState(readAt(client, receipt.blockNumber), resolver, name, op);
  const records = operatorRecords(op);
  if (after.roles[selected] !== 16n || after.counts[selected] !== 16n || after.roles[obsolete] !== 0n || after.counts[obsolete] !== 0n || after.records[selected] !== records[selected] || after.records[obsolete] !== '' || after.records['derpc.beacon'] !== (records['derpc.beacon'] ?? '') || after.ownerRoot !== atReview.ownerRoot || after.hotRoot !== atReview.hotRoot || after.rootCount !== atReview.rootCount || json(after.protectedRecords) !== json(atReview.protectedRecords)) fail('Migration receipt does not establish the selected scope, cleared obsolete records and unchanged protected records');
}

export async function verifyDeployment({ config: input, stages, client, confirmations = 12, build = registrarBuild() }) {
  const config = validateConfig(input);
  if (!config.registrar) fail('Use the final resumeConfig containing the registrar address and deployment nonce');
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) fail('Confirmations must be positive');
  if (await client.getChainId() !== 1) fail('Wrong receipt chain');
  if (!Array.isArray(stages) || !stages.length) fail('Supply reviewed stage plans and mined transaction hashes');
  const final = await preparePlan({ config, client, build });
  if (final.status !== 'state-matches-config') fail(`Deployment is incomplete; next stage is ${final.stage}`);
  const evidence = [], ids = new Set(), hashes = new Set(), initialRecords = new Map();
  const lastBlock = BigInt(final.preflight.blockNumber);
  for (const stage of stages) {
    const { plan, transactionHashes } = stage;
    if (plan?.kind !== 'derpc-ens-unsigned-plan' || plan.schemaVersion !== 1 || plan.chainId !== 1 || plan.sourceHash !== build.sourceHash || json(plan.compiler) !== json(build.compiler)) fail('Stage plan was not built from the reviewed registrar source/compiler');
    if (!sameAddress(plan.subregistry, final.subregistry) || json(plan.resolvers) !== json(final.resolvers)) fail('Stage plan belongs to another deployment');
    const stageConfig = validateConfig(plan.resumeConfig);
    verifyStageIdentity(stageConfig, config);
    stageConfig.registrar ??= config.registrar;
    const reconstructed = await preparePlan({ config: stageConfig, client, build, snapshot: plan.preflight, historical: true });
    const intents = value => value.transactions.map(item => ({ id: item.id, walletRequest: item.walletRequest, migration: item.migration ?? null }));
    if (json(intents(reconstructed)) !== json(intents(plan))) fail('Reviewed stage does not match the planner at its canonical prestate; mode changes require the atomic migration');
    if (!Array.isArray(transactionHashes) || !plan.transactions?.length || transactionHashes.length !== plan.transactions.length) fail('Supply one transaction hash for each transaction in each reviewed plan, in order');
    for (let index = 0; index < transactionHashes.length; index++) {
      const hash = transactionHashes[index], item = plan.transactions[index];
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || hashes.has(hash.toLowerCase())) fail('Invalid or duplicate transaction hash');
      hashes.add(hash.toLowerCase()); ids.add(item.id);
      const expected = expectedTransaction(item, stageConfig, final, build);
      if (item.walletRequest?.method !== 'eth_sendTransaction' || item.walletRequest.params?.length !== 1 || json(item.walletRequest.params[0]) !== json(expected)) fail('Reviewed wallet request differs from the permitted config intent');
      const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
      if (receipt.status !== 'success' || tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) fail('Missing or unsuccessful transaction receipt');
      if (receipt.blockNumber <= BigInt(plan.preflight.blockNumber)) fail('Deployment receipt must follow its reviewed precondition block');
      if (!sameAddress(tx.from, expected.from) || !sameAddress(receipt.from, expected.from) || (expected.to ? !sameAddress(tx.to, expected.to) : tx.to !== null) || tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.value !== 0n || (tx.chainId !== undefined && tx.chainId !== 1)) fail('Mined transaction differs from the reviewed wallet request');
      if (expected.nonce !== undefined && BigInt(tx.nonce) !== BigInt(expected.nonce)) fail('Registrar creation used another nonce');
      if (tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) fail('Receipt block is not canonical');
      if (lastBlock - receipt.blockNumber + 1n < BigInt(confirmations)) fail('A deployment receipt has insufficient confirmations');
      if (item.id === 'deploy-registrar' && !sameAddress(receipt.contractAddress, config.registrar.address)) fail('Registrar creation receipt has the wrong address');
      if (item.id.startsWith('deploy-resolver-')) {
        const label = item.id.slice('deploy-resolver-'.length);
        if (initialRecords.has(label)) fail('Duplicate resolver creation evidence');
        initialRecords.set(label, operatorRecords(stageConfig.operators.find(op => op.label === label)));
      }
      if (item.id.startsWith('migrate-endpoint-mode-')) await verifyMigration({ item, plan, config: stageConfig, final, receipt, client });
      if (item.id.startsWith('renew-')) {
        const decoded = decodeFunctionData({ abi: build.artifact.abi, data: tx.input });
        const entry = await readAt(client, lastBlock)(config.registrar.address, build.artifact.abi, 'operators', [decoded.args[0]]);
        if (entry[0] !== toHex(item.id.slice('renew-'.length), { size: 32 })) fail('Renewal references another operator');
      }
      evidence.push({ id: item.id, transactionHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, from: tx.from, to: tx.to, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, confirmations: lastBlock - receipt.blockNumber + 1n });
    }
  }
  const required = ['deploy-registry', 'deploy-registrar', 'grant-registrar', 'set-registry-parent', 'attach-subregistry', ...config.operators.flatMap(op => [`deploy-resolver-${op.label}`, `register-${op.label}`])];
  if (required.some(id => !ids.has(id))) fail('Deployment evidence is missing a required creation, role grant, attachment or registration transaction');
  for (const op of config.operators) if (!ids.has(`grant-endpoint-${op.label}`) && !ids.has(`grant-endpoints-${op.label}`) && !ids.has(`migrate-endpoint-mode-${op.label}`)) fail('Missing endpoint permission grant evidence');
  // Scoped resources are not enumerable from roleCount. Audit every hot-key role event
  // since each resolver's creation so grants for unknown text keys cannot escape verification.
  const roleEvent = permissionAbi.find(item => item.type === 'event');
  for (const op of config.operators) {
    const fromBlock = evidence.find(item => item.id === `deploy-resolver-${op.label}`).blockNumber;
    const events = await client.getLogs({ address: final.resolvers[op.label], event: roleEvent, fromBlock, toBlock: lastBlock, strict: true });
    for (const candidate of config.operators) {
      const currentRoles = new Map(), own = sameAddress(candidate.hotKey, op.hotKey), selected = labelId(endpointRecordKey(op));
      for (const event of events) if (sameAddress(event.args.account, candidate.hotKey)) {
        const reviewed = evidence.find(entry => entry.transactionHash === event.transactionHash);
        if (!reviewed || ![`grant-endpoint-${op.label}`, `grant-endpoints-${op.label}`, `migrate-endpoint-mode-${op.label}`].includes(reviewed.id) || !ENDPOINT_KEYS.some(key => labelId(key) === event.args.resource) || ![0n, 16n].includes(event.args.newRoleBitmap)) fail(`${op.label} hot-key event audit found an unreviewed permission change`);
        currentRoles.set(event.args.resource, event.args.newRoleBitmap);
      }
      if (own && currentRoles.get(selected) !== 16n || [...currentRoles].some(([resource, bitmap]) => bitmap !== 0n && (!own || resource !== selected || bitmap !== 16n))) fail(`${op.label} hot-key event audit found authority beyond its selected endpoint record`);
    }
  }
  final.operators = final.operators.map(op => ({ ...op, initialRecords: initialRecords.get(op.name.slice(0, -'.derpc.eth'.length)) }));
  // A slow historical role audit must not bless a final snapshot or receipt that
  // became orphaned while the other administrative reads were in flight.
  const canonicalChecks = new Map([[lastBlock.toString(), final.preflight.blockHash]]);
  for (const entry of evidence) {
    const key = entry.blockNumber.toString(), previous = canonicalChecks.get(key);
    if (previous && previous !== entry.blockHash) fail('Deployment evidence disagrees on the same canonical block');
    canonicalChecks.set(key, entry.blockHash);
  }
  for (const { plan } of stages) {
    const key = String(plan.preflight.blockNumber), previous = canonicalChecks.get(key);
    if (previous && previous !== plan.preflight.blockHash) fail('Reviewed stages disagree on the same canonical block');
    canonicalChecks.set(key, plan.preflight.blockHash);
  }
  for (const [number, hash] of canonicalChecks) if ((await client.getBlock({ blockNumber: BigInt(number) })).hash !== hash) fail('Deployment snapshot, review or receipt became noncanonical during verification');
  if ((await client.getBlock({ blockNumber: lastBlock })).hash !== final.preflight.blockHash) fail('Final deployment snapshot became noncanonical during verification');
  return { schemaVersion: 1, kind: 'derpc-ens-deployment', chainId: 1, localOnly: final.preflight.localOnly !== false, rpcOrigin: final.preflight.rpcOrigin, verifiedAt: new Date().toISOString(), parentName: config.parentName, curator: config.curator, deployer: config.deployer, subregistry: final.subregistry, registrar: final.registrar, operators: final.operators, roleTable: final.roleTable, sourceHash: build.sourceHash, compiler: build.compiler, observedBlock: { number: lastBlock, hash: final.preflight.blockHash }, upstream: final.preflight.upstream, transactions: evidence, verification: { receipts: true, canonicalBlocks: true, minimumConfirmations: confirmations, stateMatchesConfig: true, hotKeyEventAudit: true }, rpcTrust: 'Administrative RPC evidence, not light-client verification. Discovery must prove the pinned registrar and label ENS reads according to their verification mode.' };
}

async function main() {
  const [configFile, receiptFile, output, rpc] = process.argv.slice(2);
  if (!configFile || !receiptFile || !output) fail('usage: node contracts/scripts/ens-verify.mjs config.json receipts.json output.json [public-rpc-url]');
  const receipts = JSON.parse(readFileSync(receiptFile, 'utf8'));
  const stages = receipts.stages.map(stage => ({ plan: JSON.parse(readFileSync(resolve(dirname(receiptFile), stage.planFile), 'utf8')), transactionHashes: stage.transactionHashes }));
  save(output, await verifyDeployment({ config: loadConfig(configFile), stages, client: adminClient(rpc) }));
  console.log(`Receipt-checked ENS deployment manifest saved to ${output}. No transaction was sent.`);
}
if (isMain(import.meta.url)) main().catch(reportError);
