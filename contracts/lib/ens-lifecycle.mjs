// Shared browser/Node lifecycle verification. Callers supply the reviewed registrar build.
import { decodeFunctionData, encodeFunctionData, keccak256, toHex, zeroAddress } from 'viem';
import { UPSTREAM, addresses, curatorRoles, dnsEncode, ENDPOINT_KEYS, endpointRecordKey, endpointState, factoryAbi, fail, isLocalAdministrativeClient as localConnection, labelId, normalizedRuntimeHash, obsoleteEndpointKey, parseOperatorEndpoints, permissionAbi, readAt, readText, registrarRoles, registryAbi, resolverAbi, resolverOwnerRoles, roles, sameAddress, serializeOperatorEndpoints, validateEndpoint } from './ens-common.mjs';
import { validateJoinConfig, verifyJoin } from './ens-join.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RECORDS = ['derpc.endpoint', 'derpc.signer', 'derpc.caps', 'derpc.beacon', 'derpc.gateways', 'derpc.price', 'derpc.payee', 'derpc.paymentChain', 'derpc.escrow', 'derpc.endpoints'];
const PAID = ['derpc.price', 'derpc.payee', 'derpc.paymentChain', 'derpc.escrow'];
const MAX_REVIEW_SECONDS = 900;
const stable = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const equal = (a, b) => stable(a) === stable(b);
const differencePaths = (a, b, path = '') => equal(a, b) ? [] : a && b && typeof a === 'object' && typeof b === 'object' ? [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => differencePaths(a[key], b[key], path ? `${path}.${key}` : key)) : [path];
export const lifecycleManifestHash = manifest => keccak256(toHex(stable(manifest)));
const publicAddress = value => typeof value === 'string' && ADDRESS.test(value) && !sameAddress(value, zeroAddress);
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Unknown lifecycle input field'); };
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function validateLifecycleManifest(manifest, build) {
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'derpc-ens-deployment' || manifest.chainId !== 1 || manifest.parentName !== 'derpc.eth' || typeof manifest.localOnly !== 'boolean') fail('Supply the original receipt-checked mainnet ENS deployment manifest');
  if (manifest.sourceHash !== build.sourceHash || !equal(manifest.compiler, build.compiler)) fail('Manifest registrar source/compiler differs from the reviewed local build');
  if (manifest.verification?.receipts !== true || manifest.verification.canonicalBlocks !== true || manifest.verification.stateMatchesConfig !== true || manifest.verification.hotKeyEventAudit !== true || !integer(manifest.verification.minimumConfirmations) || manifest.verification.minimumConfirmations < 12) fail('Manifest lacks the required deployment verification');
  if (![manifest.curator, manifest.deployer, manifest.subregistry, manifest.registrar?.address].every(publicAddress) || !HASH.test(manifest.registrar?.codeHash) || manifest.registrar.codeHash !== manifest.registrar.runtimeCodeHash || !sameAddress(manifest.registrar.registry, manifest.subregistry) || !sameAddress(manifest.registrar.subregistry, manifest.subregistry)) fail('Manifest deployment pins are incomplete or inconsistent');
  if (!Array.isArray(manifest.operators) || manifest.operators.length < 1 || manifest.operators.length > 3 || !Array.isArray(manifest.transactions)) fail('Manifest must contain the verified 1–3 operator deployment and receipts');
  const names = new Set(), resolvers = new Set(), hotKeys = new Set();
  for (const op of manifest.operators) {
    if (!/^(?!..--)[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?\.derpc\.eth$/.test(op.name) || names.has(op.name) || ![op.operator, op.resolver, op.coldOwner, op.hotKey, op.payee].every(publicAddress) || resolvers.has(op.resolver.toLowerCase()) || hotKeys.has(op.hotKey.toLowerCase())) fail('Manifest has conflicting operator identities or resolvers');
    names.add(op.name); resolvers.add(op.resolver.toLowerCase()); hotKeys.add(op.hotKey.toLowerCase());
    if (!op.records || PAID.some(key => op.records[key])) fail('Lifecycle tooling supports free operators only');
    if (endpointRecordKey(op) === 'derpc.endpoints') {
      if (op.records['derpc.endpoint'] || op.records['derpc.beacon'] || serializeOperatorEndpoints(parseOperatorEndpoints(op.records['derpc.endpoints'])) !== op.records['derpc.endpoints']) fail('Plural manifest needs a canonical list and cleared singular records');
    } else validateEndpoint(op.records['derpc.endpoint'], 'manifest endpoint');
    if (op.initialRecords && endpointRecordKey({ records: op.initialRecords }) !== endpointRecordKey(op) && !manifest.transactions.some(tx => tx.id === `migrate-endpoint-mode-${op.name.slice(0, -'.derpc.eth'.length)}` && HASH.test(tx.transactionHash))) fail('Changed endpoint mode is missing its reviewed migration evidence');
    if (sameAddress(op.hotKey, manifest.curator) || manifest.operators.some(other => sameAddress(op.hotKey, other.coldOwner) || sameAddress(op.hotKey, other.operator))) fail('Manifest hot key has an owner or curator identity');
  }
  for (const [name, artifact] of Object.entries(UPSTREAM.artifacts)) if (!sameAddress(manifest.upstream?.[name]?.address, artifact.address) || !HASH.test(manifest.upstream[name].runtimeCodeHash) || manifest.upstream[name].normalizedRuntimeCodeHash !== artifact.normalizedRuntimeCodeHash) fail('Manifest upstream ENS pins differ from the official artifacts');
  return manifest;
}

// The configured deployment is authority supplied by the application build, never an imported replacement.
// Enrollment JSON is only a claim until resolveOperatorLifecycleManifest replays its canonical receipts.
function boundedEnrollment(input) {
  const pending = [[input, 0]], seen = new Set();
  let nodes = 0, characters = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > 12000 || depth > 24) fail('Operator enrollment evidence exceeds its structural bound');
    if (typeof value === 'string') characters += value.length;
    else if (value && typeof value === 'object') {
      if (seen.has(value)) fail('Operator enrollment evidence must be an acyclic JSON value');
      seen.add(value);
      const keys = Object.keys(value);
      if (keys.length > 256) fail('Operator enrollment evidence has too many fields or entries');
      for (const key of keys) { characters += key.length; pending.push([value[key], depth + 1]); }
    } else if (value !== null && !['undefined', 'boolean', 'number', 'bigint'].includes(typeof value)) fail('Operator enrollment evidence must contain public JSON data only');
    if (characters > 524288) fail('Operator enrollment evidence exceeds 512 KiB');
  }
  const encoded = JSON.stringify(input, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  if (new TextEncoder().encode(encoded).byteLength > 524288) fail('Operator enrollment evidence exceeds 512 KiB');
  return JSON.parse(encoded);
}

function sameDirectory(directory, deployment) {
  return directory?.chainId === 1 && sameAddress(directory.ethRegistry, addresses.ETHRegistry) &&
    sameAddress(directory.registrar?.address, deployment.registrar.address) &&
    sameAddress(directory.registrar?.registry, deployment.subregistry) &&
    typeof directory.registrar?.codeHash === 'string' && directory.registrar.codeHash.toLowerCase() === deployment.registrar.codeHash.toLowerCase();
}

function operatorLifecycleView({ deployment, enrollment, build }) {
  if (!build?.artifact?.abi || !build?.artifact?.evm?.deployedBytecode || !HASH.test(build.sourceHash)) fail('Supply the application\'s reviewed registrar build');
  validateLifecycleManifest(deployment, build);
  if (!deployment.observedBlock || !HASH.test(deployment.observedBlock.hash)) fail('Configured deployment has no canonical observed block');
  if (enrollment === undefined || enrollment === null) return { manifest: deployment };
  const imported = boundedEnrollment(enrollment);
  if (imported.schemaVersion !== 1 || imported.kind !== 'derpc-ens-operator-enrollment' || imported.chainId !== 1 ||
      imported.localOnly !== deployment.localOnly || imported.sourceHash !== build.sourceHash || !equal(imported.compiler, build.compiler) ||
      !sameDirectory(imported.directory, deployment)) fail('Operator enrollment differs from the configured directory, source, compiler or environment');
  if (!imported.verification?.operatorSigned || !HASH.test(imported.observedBlock?.hash) || !/^\d+$/.test(String(imported.observedBlock?.number))) fail('Enrollment lacks its operator signature evidence or canonical observation');
  const evidence = imported.enrollmentEvidence;
  if (!evidence || !Array.isArray(evidence.stages) || evidence.stages.length !== 3 ||
      evidence.stages.some(stage => stage.plan?.transactions?.length !== 1 || stage.transactionHashes?.length !== 1) ||
      !Array.isArray(imported.operators) || imported.operators.length !== 1 || !Array.isArray(imported.transactions) || imported.transactions.length !== 3) fail('Enrollment must retain its exact three reviewed stages and receipts');
  const config = validateJoinConfig(evidence.config);
  if (!sameDirectory(config.directory, deployment) || !sameAddress(config.curator, deployment.curator)) fail('Enrollment config differs from the configured directory or curator');
  const selected = config.operators[0], declared = imported.operators[0];
  if (declared.name !== `${selected.label}.derpc.eth` || ['operator', 'coldOwner', 'hotKey', 'payee'].some(key => !sameAddress(declared[key], selected[key])) || Number(declared.expiry) !== selected.expiry) fail('Enrollment operator differs from its original reviewed config');
  const manifest = { ...deployment, deployer: selected.operator, operators: imported.operators,
    transactions: imported.transactions, observedBlock: imported.observedBlock, verification: imported.verification,
    provenance: { enrollmentHash: lifecycleManifestHash(imported), configuredDeploymentHash: lifecycleManifestHash(deployment) } };
  validateLifecycleManifest(manifest, build);
  return { manifest, imported, config };
}

/** Review/display data only. Sending still requires the asynchronous current-state recheck below. */
export function operatorLifecycleOperators(options) {
  return structuredClone(operatorLifecycleView(options).manifest.operators);
}

/** Replay imported enrollment at its original canonical observation, then reuse the normal lifecycle engine. */
export async function resolveOperatorLifecycleManifest({ deployment, enrollment, client, build }) {
  const view = operatorLifecycleView({ deployment, enrollment, build });
  if (!view.imported) return view.manifest;
  const { imported, config } = view;
  const anchor = imported.observedBlock;
  await canonicalBlock(client, anchor.number, anchor.hash);
  const historical = { ...client, getBlock: request => request.blockTag === 'latest'
    ? canonicalBlock(client, anchor.number, anchor.hash) : client.getBlock(request) };
  const verified = await verifyJoin({ config, stages: imported.enrollmentEvidence.stages, client: historical, build, confirmations: 12 });
  for (const key of ['sourceHash', 'compiler', 'directory', 'operators', 'transactions', 'observedBlock', 'roleTable', 'verification', 'localOnly', 'enrollmentEvidence']) {
    if (!equal(verified[key], imported[key])) fail(`Imported operator enrollment ${key} differs from replayed canonical evidence`);
  }
  await canonicalBlock(client, anchor.number, anchor.hash);
  return { ...view.manifest, operators: verified.operators, transactions: verified.transactions };
}

function operatorAction(input, manifest) {
  const action = validateLifecycleAction(input, manifest);
  if (action.type === 'delist' || action.type === 'renew' && action.authority !== 'operator') fail('Website management supports operator renewal and endpoint updates only');
  return action;
}

/** Pure journal reconstruction, not send authorization. checkOperatorLifecyclePlan must run before wallet submission. */
export function expectedOperatorLifecycleTransaction({ deployment, enrollment, plan, build }) {
  const { manifest } = operatorLifecycleView({ deployment, enrollment, build });
  if (plan?.kind !== 'derpc-ens-lifecycle-plan' || plan.schemaVersion !== 1 || plan.chainId !== 1 ||
      plan.sourceHash !== build.sourceHash || plan.manifestHash !== lifecycleManifestHash(manifest) ||
      !integer(plan.before?.index) || plan.before.index >= 128) fail('Saved operator lifecycle plan differs from the configured identity or reviewed build');
  const action = operatorAction(plan.action, manifest), transaction = lifecycleTransaction(manifest, action, plan.before, build);
  if (plan.walletRequest?.method !== 'eth_sendTransaction' || plan.walletRequest.params?.length !== 1 || !equal(plan.walletRequest.params[0], transaction)) fail('Saved operator lifecycle transaction differs from its permitted action');
  return transaction;
}

export async function prepareOperatorLifecycle({ deployment, enrollment, action, client, build }) {
  const manifest = await resolveOperatorLifecycleManifest({ deployment, enrollment, client, build });
  return prepareLifecycle({ manifest, action: operatorAction(action, manifest), client, build });
}

export async function checkOperatorLifecyclePlan({ deployment, enrollment, plan, client, build }) {
  expectedOperatorLifecycleTransaction({ deployment, enrollment, plan, build });
  const manifest = await resolveOperatorLifecycleManifest({ deployment, enrollment, client, build });
  return checkLifecyclePlan({ manifest, plan, client, build });
}

export async function verifyOperatorLifecycle({ deployment, enrollment, plan, transactionHash, client, confirmations = 12, build }) {
  expectedOperatorLifecycleTransaction({ deployment, enrollment, plan, build });
  const manifest = await resolveOperatorLifecycleManifest({ deployment, enrollment, client, build });
  return verifyLifecycle({ manifest, plan, transactionHash, client, confirmations, build });
}

export function validateLifecycleAction(input, manifest) {
  const keys = input?.type === 'rotate-endpoint' ? ['type', 'label', 'expectedEndpoint', 'newEndpoint'] : input?.type === 'rotate-endpoints' ? ['type', 'label', 'expectedEndpoints', 'newEndpoints'] : input?.type === 'delist' ? ['type', 'label'] : input?.type === 'renew' ? ['type', 'label', 'expectedExpiry', 'expiry', 'authority'] : [];
  only(input, keys);
  if (!keys.length || !/^(?!..--)[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(input.label)) fail('Choose rotate-endpoint, rotate-endpoints, delist or renew and a canonical operator label');
  const op = manifest.operators.find(op => op.name === `${input.label}.derpc.eth`);
  if (!op) fail('Operator is absent from the trusted deployment manifest');
  const action = { ...input };
  if (action.type === 'rotate-endpoint') {
    if (endpointRecordKey(op) !== 'derpc.endpoint') fail('Use rotate-endpoints for a plural operator');
    validateEndpoint(action.expectedEndpoint, 'expectedEndpoint'); validateEndpoint(action.newEndpoint, 'newEndpoint');
    if (action.expectedEndpoint === action.newEndpoint) fail('Endpoint rotation must change the current endpoint');
  }
  if (action.type === 'rotate-endpoints') {
    if (endpointRecordKey(op) !== 'derpc.endpoints') fail('A cold-owner mode migration is required before plural rotation');
    action.expectedEndpoints = parseOperatorEndpoints(serializeOperatorEndpoints(action.expectedEndpoints));
    action.newEndpoints = parseOperatorEndpoints(serializeOperatorEndpoints(action.newEndpoints));
    if (serializeOperatorEndpoints(action.expectedEndpoints) === serializeOperatorEndpoints(action.newEndpoints)) fail('Plural rotation must change the canonical endpoint list');
    if (JSON.parse(op.records['derpc.caps']).beacon === true && !action.newEndpoints.every(endpoint => endpoint.beaconUrl)) fail('Beacon capability requires a beacon URL for every new endpoint');
  }
  if (action.type === 'renew') {
    if (!integer(action.expectedExpiry) || !integer(action.expiry) || action.expiry <= action.expectedExpiry) fail('Renewal needs explicit increasing Unix-second expiries');
    action.authority ??= 'operator';
    if (!['operator', 'curator'].includes(action.authority)) fail('Renewal authority must be operator or curator');
  }
  return action;
}

async function canonicalBlock(client, number, hash) {
  const block = await client.getBlock({ blockNumber: BigInt(number) });
  if (hash && block.hash !== hash) fail('Recorded block is no longer canonical');
  return block;
}

// Provenance is rechecked, not inferred from an arbitrary event-history start block.
async function resolverCreation(client, manifest, op, blockNumber) {
  const label = op.name.slice(0, -'.derpc.eth'.length);
  const entries = manifest.transactions.filter(tx => tx.id === `deploy-resolver-${label}`);
  if (entries.length !== 1 || !HASH.test(entries[0].transactionHash)) fail('Missing unique resolver creation receipt');
  const recorded = entries[0];
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: recorded.transactionHash }), client.getTransaction({ hash: recorded.transactionHash })]);
  if (receipt.status !== 'success' || receipt.transactionHash !== recorded.transactionHash || tx.hash !== recorded.transactionHash || receipt.blockNumber.toString() !== recorded.blockNumber.toString() || receipt.blockHash !== recorded.blockHash || receipt.blockNumber > blockNumber || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || !sameAddress(tx.from, manifest.deployer) || !sameAddress(tx.to, addresses.VerifiableFactory) || tx.value !== 0n) fail('Resolver creation provenance differs from its manifest');
  await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  const decoded = decodeFunctionData({ abi: factoryAbi, data: tx.input });
  if (decoded.functionName !== 'deployProxy' || !sameAddress(decoded.args[0], addresses.PermissionedResolverImpl)) fail('Resolver receipt is not the reviewed factory deployment');
  const predicted = await readAt(client, receipt.blockNumber)(addresses.VerifiableFactory, factoryAbi, 'predictProxyAddress', [manifest.deployer, decoded.args[1]]);
  if (!sameAddress(predicted, op.resolver)) fail('Resolver creation receipt predicts another proxy');
  const init = decodeFunctionData({ abi: resolverAbi, data: decoded.args[2] });
  const expectedCalls = Object.entries(op.initialRecords ?? op.records).map(([key, value]) => encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(op.name), key, value] }));
  if (init.functionName !== 'initialize' || init.args[0].length !== 1 || !sameAddress(init.args[0][0].account, op.coldOwner) || init.args[0][0].roleBitmap !== resolverOwnerRoles || !equal(init.args[1], expectedCalls)) fail('Resolver initialization differs from its original manifest');
  return receipt.blockNumber;
}

async function snapshotState({ manifest, client, build, block, action }) {
  const read = readAt(client, block.number);
  const op = manifest.operators.find(op => op.name === `${action.label}.derpc.eth`);
  const registrarCode = await client.getBytecode({ address: manifest.registrar.address, blockNumber: block.number });
  if (!registrarCode || keccak256(registrarCode) !== manifest.registrar.codeHash) fail('Registrar runtime differs from the trusted pin');
  const compiled = build.artifact.evm.deployedBytecode;
  if (normalizedRuntimeHash(registrarCode, { runtimeBytes: compiled.object.length / 2, immutableRanges: Object.values(compiled.immutableReferences).flat() }) !== keccak256(`0x${compiled.object}`)) fail('Pinned registrar differs from the local reviewed source');
  const upstream = await Promise.all(Object.entries(UPSTREAM.artifacts).map(async ([name, artifact]) => {
    const code = await client.getBytecode({ address: artifact.address, blockNumber: block.number });
    if (!code || keccak256(code) !== manifest.upstream[name].runtimeCodeHash || normalizedRuntimeHash(code, artifact) !== artifact.normalizedRuntimeCodeHash) fail('ENS implementation bytecode changed');
    return [name, keccak256(code)];
  }));
  const [curator, registry, parentState, parentSubregistry, parentResolver, parentPermission, registryParent, registryImpl, curatorRoot, registrarRoot, rootCount, count] = await Promise.all([
    read(manifest.registrar.address, build.artifact.abi, 'curator'), read(manifest.registrar.address, build.artifact.abi, 'registry'),
    read(addresses.ETHRegistry, registryAbi, 'getState', [labelId('derpc')]), read(addresses.ETHRegistry, registryAbi, 'getSubregistry', ['derpc']), read(addresses.ETHRegistry, registryAbi, 'getResolver', ['derpc']),
    read(addresses.ETHRegistry, registryAbi, 'hasRoles', [labelId('derpc'), roles.setSubregistry, manifest.curator]),
    read(manifest.subregistry, registryAbi, 'getParent'), read(addresses.VerifiableFactory, factoryAbi, 'verifyContract', [manifest.subregistry]),
    read(manifest.subregistry, registryAbi, 'roles', [0n, manifest.curator]), read(manifest.subregistry, registryAbi, 'roles', [0n, manifest.registrar.address]), read(manifest.subregistry, registryAbi, 'roleCount', [0n]),
    read(manifest.registrar.address, build.artifact.abi, 'operatorCount'),
  ]);
  if (!sameAddress(curator, manifest.curator) || !sameAddress(registry, manifest.subregistry) || !sameAddress(parentSubregistry, manifest.subregistry) || parentState.status !== 2 || parentState.expiry <= block.timestamp || !parentPermission || !sameAddress(registryParent[0], addresses.ETHRegistry) || registryParent[1] !== 'derpc' || !sameAddress(registryImpl, addresses.UserRegistryImpl)) fail('ENS parent, subregistry, curator or implementation changed');
  if (curatorRoot !== curatorRoles || registrarRoot !== registrarRoles || rootCount !== curatorRoles + registrarRoles) fail('Unexpected registry root permissions');
  if (count > 128n) fail('Registrar exceeds its fixed proof layout bound');
  const entries = await Promise.all(Array.from({ length: Number(count) }, (_, index) => read(manifest.registrar.address, build.artifact.abi, 'operators', [BigInt(index)])));
  const indices = entries.map((entry, index) => entry[0] === toHex(action.label, { size: 32 }) ? index : -1).filter(index => index >= 0);
  if (indices.length !== 1) fail('Missing or ambiguous registrar entry');
  const index = indices[0], entry = entries[index];
  if (!sameAddress(entry[1], op.operator) || !sameAddress(entry[4], op.payee)) fail('Registrar ownership or payee changed');
  const [ens, resolved, nameRoles, operatorBlocked, labelBlocked] = await Promise.all([
    read(manifest.subregistry, registryAbi, 'getState', [labelId(action.label)]), read(manifest.subregistry, registryAbi, 'getResolver', [action.label]), read(manifest.subregistry, registryAbi, 'roleCount', [labelId(action.label)]),
    read(manifest.registrar.address, build.artifact.abi, 'operatorBlocked', [op.operator]), read(manifest.registrar.address, build.artifact.abi, 'labelBlocked', [toHex(labelId(action.label), { size: 32 })]),
  ]);
  const originalRead = readAt(client, BigInt(manifest.observedBlock.number));
  const [originalEns, originalParent, originalParentResolver] = await Promise.all([originalRead(manifest.subregistry, registryAbi, 'getState', [labelId(action.label)]), originalRead(addresses.ETHRegistry, registryAbi, 'getState', [labelId('derpc')]), originalRead(addresses.ETHRegistry, registryAbi, 'getResolver', ['derpc'])]);
  const originalRecords = Object.fromEntries(await Promise.all(RECORDS.map(async key => [key, await readText(originalRead, op.resolver, op.name, key)])));
  if (RECORDS.some(key => originalRecords[key] !== (op.records[key] ?? ''))) fail('Manifest records do not match its canonical observed block');
  if (!sameAddress(originalParent.latestOwner, parentState.latestOwner) || originalParent.tokenId !== parentState.tokenId || !sameAddress(originalParentResolver, parentResolver)) fail('Original parent ownership or resolver changed');
  if (originalEns.status !== 2 || originalEns.tokenId !== ens.tokenId || !sameAddress(originalEns.latestOwner, ens.latestOwner)) fail('Operator token differs from the original verified deployment');
  if (await read(manifest.subregistry, registryAbi, 'roleCount', [ens.resource]) !== 0n) fail('Current ENS resource has unexpected name permissions');
  const expired = BigInt(entry[2]) <= block.timestamp;
  // Official PermissionedRegistry.getState exposes the NEXT EAC version while
  // expired. Reviving a lease restores the original resource; it does not mint.
  if (ens.resource !== originalEns.resource + (expired ? 1n : 0n)) fail('ENS resource differs from the original lease permission scope');
  if (!sameAddress(ens.latestOwner, op.operator) || BigInt(ens.expiry) !== BigInt(entry[2]) || ens.status !== (expired ? 0 : 2) || !sameAddress(resolved, expired ? zeroAddress : op.resolver) || nameRoles !== 0n) fail('ENS ownership, expiry, resolver or name permissions differ from the listing');
  const permissionSnapshots = [];
  for (const resolverOp of manifest.operators) {
    const [impl, ownerRoot, countRoot, hotRoot, endpoints] = await Promise.all([
      read(addresses.VerifiableFactory, factoryAbi, 'verifyContract', [resolverOp.resolver]), read(resolverOp.resolver, resolverAbi, 'roles', [0n, resolverOp.coldOwner]), read(resolverOp.resolver, resolverAbi, 'roleCount', [0n]), read(resolverOp.resolver, resolverAbi, 'roles', [0n, resolverOp.hotKey]), endpointState(read, resolverOp.resolver, resolverOp.name, resolverOp.hotKey),
    ]);
    const selected = endpointRecordKey(resolverOp), obsolete = obsoleteEndpointKey(resolverOp), selectedResource = labelId(selected);
    if (!sameAddress(impl, addresses.PermissionedResolverImpl) || ownerRoot !== resolverOwnerRoles || countRoot !== resolverOwnerRoles || hotRoot !== 0n || endpoints.roles[selected] !== roles.text || endpoints.counts[selected] !== roles.text || endpoints.roles[obsolete] !== 0n || endpoints.counts[obsolete] !== 0n || endpoints.records[obsolete] !== '' || selected === 'derpc.endpoints' && endpoints.records['derpc.beacon'] !== '') fail('Resolver has unexpected permissions, obsolete records or implementation');
    for (const key of RECORDS.filter(key => key !== selected)) if (await read(resolverOp.resolver, resolverAbi, 'roleCount', [labelId(key)]) !== 0n) fail('Resolver has unexpected scoped authority on a protected record');
    const fromBlock = await resolverCreation(client, manifest, resolverOp, block.number);
    const events = await client.getLogs({ address: resolverOp.resolver, event: permissionAbi.find(item => item.type === 'event'), fromBlock, toBlock: block.number, strict: true });
    if (events.length > 4096) fail('Resolver role history exceeds the bounded lifecycle audit');
    for (const event of events) {
      if (event.removed === true) fail('Resolver role history contains a removed event');
      if (manifest.operators.some(candidate => sameAddress(event.args.account, candidate.hotKey))) continue;
      const creation = manifest.transactions.find(tx => tx.id === `deploy-resolver-${resolverOp.name.slice(0, -'.derpc.eth'.length)}`);
      if (!sameAddress(event.args.account, resolverOp.coldOwner) || event.args.resource !== 0n || event.args.newRoleBitmap !== resolverOwnerRoles ||
          event.transactionHash !== creation?.transactionHash || event.blockHash !== creation.blockHash || event.blockNumber !== BigInt(creation.blockNumber)) fail('Resolver role history contains authority beyond the reviewed owner and endpoint updater');
    }
    for (const candidate of manifest.operators) {
      const resourceRoles = new Map();
      for (const event of events) if (sameAddress(event.args.account, candidate.hotKey)) {
        const label = resolverOp.name.slice(0, -'.derpc.eth'.length);
        const evidence = manifest.transactions.find(tx => tx.transactionHash === event.transactionHash);
        if (!evidence || ![`grant-endpoint-${label}`, `grant-endpoints-${label}`, `migrate-endpoint-mode-${label}`].includes(evidence.id) || BigInt(evidence.blockNumber) !== event.blockNumber || evidence.blockHash !== event.blockHash || event.blockNumber > BigInt(manifest.observedBlock.number)) fail('Hot-key role history contains a permission change absent from the observed manifest');
        resourceRoles.set(event.args.resource.toString(), event.args.newRoleBitmap);
      }
      const own = sameAddress(candidate.hotKey, resolverOp.hotKey);
      if (own && resourceRoles.get(selectedResource.toString()) !== roles.text || [...resourceRoles].some(([resource, bitmap]) => bitmap !== 0n && (!own || resource !== selectedResource.toString() || bitmap !== roles.text))) fail('Hot-key role history grants authority outside its own selected endpoint record');
    }
    permissionSnapshots.push({ resolver: resolverOp.resolver, implementation: impl, ownerRoot, countRoot, hotRoot, selectedEndpointKey: selected, endpointRoles: endpoints.roles, endpointCounts: endpoints.counts });
  }
  const records = Object.fromEntries(await Promise.all(RECORDS.map(async key => [key, await readText(read, op.resolver, op.name, key)])));
  if (PAID.some(key => records[key])) fail('Lifecycle operation requires a free operator');
  if (endpointRecordKey(op) === 'derpc.endpoints' && serializeOperatorEndpoints(parseOperatorEndpoints(records['derpc.endpoints'])) !== records['derpc.endpoints']) fail('Current plural record is not canonical');
  for (const key of RECORDS.filter(key => key !== endpointRecordKey(op))) if (records[key] !== (op.records[key] ?? '')) fail('A protected operator record differs from the original manifest');
  return { block: { number: block.number.toString(), hash: block.hash, timestamp: Number(block.timestamp) }, index, entry: { label: action.label, operator: entry[1], expiry: Number(entry[2]), active: entry[3], payee: entry[4] }, moderation: { operatorBlocked, labelBlocked }, ens, activeResource: originalEns.resource, dedicatedResolver: op.resolver, resolved, records, registryCount: count, parentState, parentResolver, permissions: permissionSnapshots, upstream: Object.fromEntries(upstream) };
}

export function requireLifecyclePreconditions(action, before) {
  if (!before.entry.active) fail('Operator is already delisted; lifecycle tooling never relists it');
  if (action.type === 'rotate-endpoint' || action.type === 'rotate-endpoints') {
    if (before.entry.expiry <= before.block.timestamp) fail('Renew an expired listing before rotating its endpoint');
    if (action.type === 'rotate-endpoint' && before.records['derpc.endpoint'] !== action.expectedEndpoint) fail('Endpoint changed since the requested expectedEndpoint');
    if (action.type === 'rotate-endpoints' && before.records['derpc.endpoints'] !== serializeOperatorEndpoints(action.expectedEndpoints)) fail('Endpoint list changed since the reviewed expectedEndpoints');
  }
  if (action.type === 'renew' && (before.entry.expiry !== action.expectedExpiry || action.expiry <= before.block.timestamp || action.expiry > before.block.timestamp + 30 * 86400 || BigInt(action.expiry) > BigInt(before.parentState.expiry))) fail('Renewal requires the expected current lease and a future expiry within 30 days and the parent lease');
  // The registrar lets an operator extend a running lease only; a lapsed one comes back through the curator.
  if (action.type === 'renew' && action.authority !== 'curator' && before.entry.expiry <= before.block.timestamp) fail('A lapsed lease can be renewed only by the curator');
}

export function lifecycleTransaction(manifest, action, before, build) {
  const op = manifest.operators.find(op => op.name === `${action.label}.derpc.eth`);
  if (action.type === 'rotate-endpoint') return { from: op.hotKey, to: op.resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(op.name), 'derpc.endpoint', action.newEndpoint] }), value: '0x0', chainId: '0x1' };
  if (action.type === 'rotate-endpoints') return { from: op.hotKey, to: op.resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(op.name), 'derpc.endpoints', serializeOperatorEndpoints(action.newEndpoints)] }), value: '0x0', chainId: '0x1' };
  const from = action.type === 'delist' || action.authority === 'curator' ? manifest.curator : op.operator;
  return { from, to: manifest.registrar.address, data: encodeFunctionData({ abi: build.artifact.abi, functionName: action.type === 'delist' ? 'remove' : 'renew', args: action.type === 'delist' ? [BigInt(before.index), op.operator, toHex(action.label, { size: 32 })] : [BigInt(before.index), BigInt(action.expiry)] }), value: '0x0', chainId: '0x1' };
}

async function context(manifest, client, build) {
  validateLifecycleManifest(manifest, build);
  if (await client.getChainId() !== 1) fail('Lifecycle tooling requires mainnet chain ID 1');
  if (manifest.localOnly && !localConnection(client)) fail('Local fork manifests cannot be used with a public RPC');
  if (!manifest.observedBlock || !HASH.test(manifest.observedBlock.hash)) fail('Manifest has no canonical deployment snapshot');
  await canonicalBlock(client, manifest.observedBlock.number, manifest.observedBlock.hash);
}

export async function prepareLifecycle({ manifest, action: input, client, build }) {
  await context(manifest, client, build);
  const action = validateLifecycleAction(input, manifest), block = await client.getBlock({ blockTag: 'latest' });
  const before = await snapshotState({ manifest, client, build, block, action });
  requireLifecyclePreconditions(action, before);
  const transaction = lifecycleTransaction(manifest, action, before, build);
  const gas = await client.estimateGas({ account: transaction.from, to: transaction.to, data: transaction.data, value: 0n, blockNumber: block.number });
  await canonicalBlock(client, block.number, block.hash);
  return { schemaVersion: 1, kind: 'derpc-ens-lifecycle-plan', chainId: 1, localOnly: manifest.localOnly || localConnection(client), createdAt: new Date().toISOString(), manifestHash: lifecycleManifestHash(manifest), sourceHash: build.sourceHash, action, before, reviewExpiresAt: Number(block.timestamp) + MAX_REVIEW_SECONDS, estimatedGas: gas.toString(), walletRequest: { method: 'eth_sendTransaction', params: [transaction] }, review: ['Exactly one zero-value call; no grants, transfer, resolver replacement or payment activation.', 'Recheck this plan immediately before wallet submission. Delisting binds the expected operator and label; endpoint writes and renewals lack an on-chain expected-state guard. No action has an on-chain review deadline.', 'Delisting clears registrar admission, bans the operator and label from future registration, and preserves the ENS token. Expired-but-active listings may renew; removed listings cannot.', 'Receipt confirmation is separate from finality. Effective client routing changes require a successful authenticated finalized directory refresh.'] };
}

async function reviewedPlan({ manifest, plan, client, build }) {
  await context(manifest, client, build);
  if (plan?.kind !== 'derpc-ens-lifecycle-plan' || plan.schemaVersion !== 1 || plan.chainId !== 1 || plan.manifestHash !== lifecycleManifestHash(manifest) || plan.sourceHash !== build.sourceHash || plan.localOnly !== (manifest.localOnly || localConnection(client))) fail('Lifecycle plan does not match its original manifest, build or environment');
  const action = validateLifecycleAction(plan.action, manifest);
  const block = await canonicalBlock(client, plan.before.block.number, plan.before.block.hash);
  const before = await snapshotState({ manifest, client, build, block, action });
  if (!equal(before, plan.before) || plan.reviewExpiresAt !== Number(block.timestamp) + MAX_REVIEW_SECONDS) fail('Reviewed preconditions differ from their canonical block');
  requireLifecyclePreconditions(action, before);
  const transaction = lifecycleTransaction(manifest, action, before, build);
  if (plan.walletRequest?.method !== 'eth_sendTransaction' || plan.walletRequest.params?.length !== 1 || !equal(plan.walletRequest.params[0], transaction)) fail('Wallet request differs from the narrowly scoped lifecycle action');
  return { action, before, transaction };
}

function comparable(state) { const { block: _block, ...rest } = state; return rest; }

export async function checkLifecyclePlan({ manifest, plan, client, build }) {
  const reviewed = await reviewedPlan({ manifest, plan, client, build });
  const block = await client.getBlock({ blockTag: 'latest' });
  if (Number(block.timestamp) > plan.reviewExpiresAt) fail('Plan review window expired; prepare a fresh plan');
  const current = await snapshotState({ manifest, client, build, block, action: reviewed.action });
  requireLifecyclePreconditions(reviewed.action, current);
  if (!equal(comparable(current), comparable(reviewed.before))) fail('Lifecycle preconditions changed; prepare a fresh plan');
  await canonicalBlock(client, block.number, block.hash);
  return { schemaVersion: 1, kind: 'derpc-ens-lifecycle-recheck', localOnly: plan.localOnly, manifestHash: plan.manifestHash, checkedBlock: current.block, stateStillMatches: true, noTransactionSent: true };
}

function expectedAfter(before, action, after) {
  const expected = structuredClone(before);
  expected.block = after.block;
  if (action.type === 'rotate-endpoint') expected.records['derpc.endpoint'] = action.newEndpoint;
  if (action.type === 'rotate-endpoints') expected.records['derpc.endpoints'] = serializeOperatorEndpoints(action.newEndpoints);
  if (action.type === 'delist') {
    expected.entry.active = false;
    expected.moderation = { operatorBlocked: true, labelBlocked: true };
  }
  if (action.type === 'renew') {
    expected.entry.expiry = action.expiry;
    expected.ens.expiry = BigInt(action.expiry);
  }
  // ENS availability naturally changes at expiry. Renewal restores the existing resolver.
  const expired = expected.entry.expiry <= after.block.timestamp;
  expected.ens.status = expired ? 0 : 2;
  expected.ens.resource = BigInt(before.activeResource) + (expired ? 1n : 0n);
  expected.resolved = expired ? zeroAddress : before.dedicatedResolver;
  return expected;
}

export async function verifyLifecycle({ manifest, plan, transactionHash, client, confirmations = 12, build }) {
  if (!integer(confirmations) || confirmations < 12 || !HASH.test(transactionHash)) fail('Supply a transaction hash and at least 12 confirmations');
  const { action, before, transaction: expected } = await reviewedPlan({ manifest, plan, client, build });
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: transactionHash }), client.getTransaction({ hash: transactionHash })]);
  if (receipt.status !== 'success' || receipt.transactionHash !== transactionHash || tx.hash !== transactionHash || !sameAddress(receipt.from, expected.from) || !sameAddress(receipt.to, expected.to) || !sameAddress(tx.from, expected.from) || !sameAddress(tx.to, expected.to) || tx.input !== expected.data || tx.value !== 0n || tx.chainId !== 1 || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || tx.transactionIndex !== receipt.transactionIndex) fail('Mined transaction differs from the reviewed lifecycle request');
  if (receipt.blockNumber <= BigInt(before.block.number)) fail('Transaction must follow the reviewed precondition block');
  const block = await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  if (Number(block.timestamp) > plan.reviewExpiresAt) fail('Transaction mined after the reviewed plan deadline');
  // These pinned implementations emit logs for managed state changes. Parent-block
  // state alone cannot reveal a race earlier in the transaction's own block.
  const managed = [addresses.ETHRegistry, addresses.VerifiableFactory, manifest.subregistry, manifest.registrar.address, ...manifest.operators.map(op => op.resolver)];
  const blockEvents = await client.getLogs({ address: managed, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
  if (blockEvents.some(event => event.blockNumber !== receipt.blockNumber || event.blockHash !== receipt.blockHash || event.removed === true || !HASH.test(event.transactionHash) || !integer(event.transactionIndex) || !managed.some(address => sameAddress(address, event.address)) || event.transactionIndex === receipt.transactionIndex && event.transactionHash !== transactionHash)) fail('Managed event evidence is inconsistent with the canonical receipt block');
  if (blockEvents.some(event => event.transactionIndex !== receipt.transactionIndex)) fail('Another managed-contract mutation occurred in the receipt block; cannot establish isolated lifecycle preconditions');
  const parent = await canonicalBlock(client, receipt.blockNumber - 1n, block.parentHash);
  const preceding = await snapshotState({ manifest, client, build, block: parent, action });
  requireLifecyclePreconditions(action, preceding);
  if (!equal(comparable(before), comparable(preceding))) fail('Lifecycle state changed between review and the receipt parent block');
  const after = await snapshotState({ manifest, client, build, block, action });
  if (!equal(after, expectedAfter(before, action, after))) fail(`Receipt-block state does not match the exact intended lifecycle change: ${differencePaths(after, expectedAfter(before, action, after)).join(', ')}`);
  const latest = await client.getBlock({ blockTag: 'latest' });
  const observedConfirmations = latest.number - receipt.blockNumber + 1n;
  if (observedConfirmations < BigInt(confirmations)) fail('Lifecycle receipt has insufficient confirmations');
  const current = await snapshotState({ manifest, client, build, block: latest, action });
  if (!equal(current, expectedAfter(before, action, current))) fail('Current state differs from the verified lifecycle result');
  // Recheck block identities after multi-read snapshots to detect a reorg during verification.
  await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  await canonicalBlock(client, latest.number, latest.hash);
  let finalized;
  try { finalized = await client.getBlock({ blockTag: 'finalized' }); } catch { /* Explicitly report unavailable finality. */ }
  if (finalized) await canonicalBlock(client, finalized.number, finalized.hash);
  await canonicalBlock(client, receipt.blockNumber, receipt.blockHash);
  await canonicalBlock(client, latest.number, latest.hash);
  const finalityStatus = !finalized ? 'unavailable' : finalized.number >= receipt.blockNumber ? 'finalized' : 'pending-finality';
  return { schemaVersion: 1, kind: 'derpc-ens-lifecycle-evidence', chainId: 1, localOnly: plan.localOnly, verifiedAt: new Date().toISOString(), manifestHash: plan.manifestHash, action, transactionHash, receipt: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, transactionIndex: receipt.transactionIndex, from: tx.from, to: tx.to, gasUsed: receipt.gasUsed.toString(), confirmations: observedConfirmations.toString() }, before, after, current, verification: { canonicalReceipt: true, exactRequest: true, receiptParentPreconditions: true, receiptBlockState: true, currentState: true, rolesAndRuntime: true }, finality: { status: finalityStatus, finalizedBlock: finalized ? { number: finalized.number.toString(), hash: finalized.hash } : null, clientRefreshVerified: false }, trust: 'Administrative RPC observations only. Even finalized on-chain changes need a separate successful proven directory refresh before becoming effective in DeRPC.' };
}

