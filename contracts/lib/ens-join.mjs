// Browser-safe enrollment planner/verifier. The reviewed compiled build is an explicit input.
import { encodeFunctionData, getAddress, isAddress, keccak256, toHex, zeroAddress } from 'viem';
import { addresses, curatorRoles, deploymentSalt, ENDPOINT_KEYS, endpointRecordKey, endpointState, factoryAbi, fail, isEmptyCode, json, labelId, normalizedRuntimeHash, operatorRecords, permissionAbi, preflight, readAt, readText, RECORD_KEYS, registrarRoles, registryAbi, resolverAbi, resolverOwnerRoles, roles, sameAddress, setter, validateConfig } from './ens-common.mjs';
import { directoryPins } from './ens-wallet.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const only = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Unknown operator enrollment field'); };

/** A separately reviewed deployment pin plus one public operator entry. Never a private key. */
export function validateJoinConfig(input) {
  only(input, ['schemaVersion', 'kind', 'chainId', 'parentName', 'deploymentId', 'curator', 'directory', 'operators']);
  if (input.kind !== 'derpc-ens-join-config' || input.operators?.length !== 1) fail('Operator enrollment requires exactly one operator');
  const op = input.operators[0];
  const checked = validateConfig({ schemaVersion: input.schemaVersion, chainId: input.chainId, parentName: input.parentName,
    deploymentId: input.deploymentId, curator: input.curator, deployer: op.operator, operators: input.operators });
  if (!sameAddress(op.operator, op.coldOwner)) fail('Self-service enrollment requires the operator to own its dedicated resolver');
  if (op.payment) fail('Open enrollment is free; payment records need a separate reviewed rollout');
  only(input.directory, ['chainId', 'ethRegistry', 'registrar']);
  only(input.directory.registrar, ['address', 'codeHash', 'registry']);
  const pin = input.directory.registrar;
  if (input.directory.chainId !== 1 || !sameAddress(input.directory.ethRegistry, addresses.ETHRegistry) ||
      ![pin.address, pin.registry].every(a => typeof a === 'string' && isAddress(a) && !sameAddress(a, zeroAddress)) ||
      !HASH.test(pin.codeHash ?? '') || /^0x0+$/i.test(pin.codeHash)) fail('Use reviewed mainnet registrar and subregistry pins');
  return { schemaVersion: 1, kind: input.kind, chainId: 1, parentName: 'derpc.eth', deploymentId: checked.deploymentId,
    curator: checked.curator, directory: { chainId: 1, ethRegistry: addresses.ETHRegistry,
      registrar: { address: getAddress(pin.address), codeHash: pin.codeHash.toLowerCase(), registry: getAddress(pin.registry) } }, operators: checked.operators };
}

export function joinConfigFromDeployment({ manifest, operator, deploymentId }) {
  const directory = directoryPins(manifest);
  return validateJoinConfig({ schemaVersion: 1, kind: 'derpc-ens-join-config', chainId: 1, parentName: 'derpc.eth',
    deploymentId: deploymentId ?? `join-${operator.label.slice(0, 20)}-${keccak256(toHex(operator.operator)).slice(2, 10)}`,
    curator: manifest.curator, directory, operators: [operator] });
}

export function checkJoinIdentity(a, b) {
  if (json(validateJoinConfig(a)) !== json(validateJoinConfig(b))) fail('Operator enrollment identity or deployment pin changed');
}

export function expectedJoinTransaction(item, input, plan, build) {
  const config = validateJoinConfig(input), op = config.operators[0], name = `${op.label}.derpc.eth`;
  const call = (to, abi, functionName, args) => ({ from: op.operator, to, data: encodeFunctionData({ abi, functionName, args }), value: '0x0', chainId: '0x1' });
  const resolver = plan.resolvers[op.label], selected = endpointRecordKey(op);
  if (item.id === `deploy-resolver-${op.label}`) return call(addresses.VerifiableFactory, factoryAbi, 'deployProxy', [addresses.PermissionedResolverImpl,
    deploymentSalt(config, `resolver:${op.label}`), encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [
      [{ account: op.operator, roleBitmap: resolverOwnerRoles }], Object.entries(operatorRecords(op)).map(([key, value]) => setter(name, key, value)),
    ] })]);
  if (item.id === `grant-endpoint-${op.label}`) return call(resolver, resolverAbi, 'grantSetterRoles', [setter(name, selected, ''), op.hotKey]);
  if (item.id === `register-${op.label}`) {
    if (plan.registrationSlot === null) return call(config.directory.registrar.address, build.artifact.abi, 'register', [op.label, op.operator, resolver, op.payee, BigInt(op.expiry)]);
    if (!Number.isSafeInteger(plan.registrationSlot) || plan.registrationSlot < 0 || plan.registrationSlot >= 128) fail('Invalid registration slot');
    return call(config.directory.registrar.address, build.artifact.abi, 'registerInSlot', [BigInt(plan.registrationSlot), op.label, op.operator, resolver, op.payee, BigInt(op.expiry)]);
  }
  fail('Unrecognized operator enrollment transaction');
}

/** Operator-only transactions against an already attached, reviewed registry. No pool-owner calls. */
export async function prepareJoinPlan({ config: input, client, build, snapshot, historical = false }) {
  if (!build) fail('Supply the reviewed registrar build explicitly');
  const config = validateJoinConfig(input), op = config.operators[0], pin = config.directory.registrar;
  const observed = snapshot ?? await preflight(client);
  if (observed.chainId !== 1 || !sameAddress(observed.parent.subregistry, pin.registry)) fail('The reviewed operator subregistry is not attached to derpc.eth');
  const blockNumber = BigInt(observed.blockNumber), now = BigInt(observed.timestamp), read = readAt(client, blockNumber);
  if (BigInt(op.expiry) <= now || BigInt(op.expiry) > now + 30n * 86400n || BigInt(op.expiry) > BigInt(observed.parent.expiry)) fail('Choose an unexpired lease within 30 days and the parent expiry');
  const code = await client.getBytecode({ address: pin.address, blockNumber });
  if (isEmptyCode(code) || keccak256(code).toLowerCase() !== pin.codeHash) fail('Registrar runtime does not match the reviewed pin');
  const compiled = build.artifact.evm.deployedBytecode;
  if (normalizedRuntimeHash(code, { runtimeBytes: compiled.object.length / 2, immutableRanges: Object.values(compiled.immutableReferences).flat() }) !== keccak256(`0x${compiled.object}`)) fail('Registrar is not the locally reviewed open-registration implementation');
  const [registry, curator, implementation, curatorRoot, registrarRoot, rootCount, parent] = await Promise.all([
    read(pin.address, build.artifact.abi, 'registry'), read(pin.address, build.artifact.abi, 'curator'),
    read(addresses.VerifiableFactory, factoryAbi, 'verifyContract', [pin.registry]),
    read(pin.registry, registryAbi, 'roles', [0n, config.curator]), read(pin.registry, registryAbi, 'roles', [0n, pin.address]), read(pin.registry, registryAbi, 'roleCount', [0n]), read(pin.registry, registryAbi, 'getParent'),
  ]);
  if (!sameAddress(registry, pin.registry) || !sameAddress(curator, config.curator) || !sameAddress(implementation, addresses.UserRegistryImpl) ||
      curatorRoot !== curatorRoles || registrarRoot !== registrarRoles || rootCount !== curatorRoles + registrarRoles ||
      !sameAddress(parent[0], addresses.ETHRegistry) || parent[1] !== 'derpc') fail('Registry implementation, parent or reviewed administrative roles changed');
  const resolver = await read(addresses.VerifiableFactory, factoryAbi, 'predictProxyAddress', [op.operator, deploymentSalt(config, `resolver:${op.label}`)]);
  const count = Number(await read(pin.address, build.artifact.abi, 'operatorCount'));
  if (!Number.isSafeInteger(count) || count < 0 || count > 128) fail('Registrar exceeds the proven list bound');
  const entries = await Promise.all(Array.from({ length: count }, (_, i) => read(pin.address, build.artifact.abi, 'operators', [BigInt(i)])));
  const index = entries.findIndex(e => e[0] === toHex(op.label, { size: 32 })), entry = entries[index];
  const registered = !!entry && entry[3] && BigInt(entry[2]) > now;
  const state = await read(pin.registry, registryAbi, 'getState', [labelId(op.label)]);
  let registrationSlot = null;
  if (!registered) {
    const [operatorBlocked, labelBlocked] = await Promise.all([
      read(pin.address, build.artifact.abi, 'operatorBlocked', [op.operator]), read(pin.address, build.artifact.abi, 'labelBlocked', [keccak256(toHex(op.label))]),
    ]);
    if (operatorBlocked || labelBlocked) fail('This address or name was blocked; only the curator can restore admission');
    if (state.status !== 0) fail('The requested ENS name is not available');
    if (index < 0 && count === 128) {
      registrationSlot = entries.findIndex(e => !e[3] || BigInt(e[2]) <= now);
      if (registrationSlot < 0) fail('All 128 operator slots are active; no registration transaction is prepared');
    }
  } else if (!sameAddress(entry[1], op.operator) || !sameAddress(entry[4], op.payee) || BigInt(entry[2]) !== BigInt(op.expiry) ||
      state.status !== 2 || !sameAddress(state.latestOwner, op.operator) || BigInt(state.expiry) !== BigInt(op.expiry) ||
      !sameAddress(await read(pin.registry, registryAbi, 'getResolver', [op.label]), resolver) || await read(pin.registry, registryAbi, 'roleCount', [labelId(op.label)]) !== 0n) fail('Existing registration differs from this operator enrollment');
  const plan = { schemaVersion: 1, kind: 'derpc-ens-unsigned-plan', flow: 'operator-join', chainId: 1, createdAt: new Date().toISOString(),
    sourceHash: build.sourceHash, compiler: build.compiler, preflight: observed, subregistry: pin.registry, resolvers: { [op.label]: resolver },
    registrationSlot, resumeConfig: config, roleTable: [
      { resource: 'Registrar administration and delisting', account: config.curator, roles: 'unchanged; no owner transaction for this enrollment' },
      { resource: `${op.label} resolver root`, account: op.operator, roles: 'SET_TEXT; SET_TEXT_ADMIN', bitmap: resolverOwnerRoles.toString() },
      { resource: `${op.label} resolver key ${endpointRecordKey(op)} only`, account: op.hotKey, roles: 'SET_TEXT', bitmap: roles.text.toString() },
      { resource: `${op.label} ENS name`, account: op.operator, roles: 'none (non-transferable)', bitmap: '0' },
    ], transactions: [], status: 'needs-wallet-transactions',
    instructions: 'The operator signs each transaction in their own wallet and pays mainnet gas. The service never receives a key or signs. Free open admission does not establish honest service or independent ownership.' };
  const add = (id, purpose) => { const item = { id, purpose }; item.walletRequest = { method: 'eth_sendTransaction', params: [expectedJoinTransaction(item, config, plan, build)] }; plan.transactions.push(item); };
  const finish = async stage => {
    plan.stage = stage;
    if (!historical) for (const item of plan.transactions) {
      const tx = item.walletRequest.params[0];
      item.estimatedGas = String(await client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: 0n, blockNumber }));
    }
    return plan;
  };
  if (isEmptyCode(await client.getBytecode({ address: resolver, blockNumber }))) {
    add(`deploy-resolver-${op.label}`, `Create your dedicated resolver and initialize ${op.label}.derpc.eth records`);
    return finish('deploy-operator-resolver');
  }
  if (!sameAddress(await read(addresses.VerifiableFactory, factoryAbi, 'verifyContract', [resolver]), addresses.PermissionedResolverImpl)) fail('Dedicated resolver implementation changed; choose a fresh reviewed deployment ID');
  const name = `${op.label}.derpc.eth`, selected = endpointRecordKey(op);
  const [ownerRoot, hotRoot, resolverRootCount, endpoints] = await Promise.all([
    read(resolver, resolverAbi, 'roles', [0n, op.operator]), read(resolver, resolverAbi, 'roles', [0n, op.hotKey]), read(resolver, resolverAbi, 'roleCount', [0n]), endpointState(read, resolver, name, op.hotKey),
  ]);
  if (ownerRoot !== resolverOwnerRoles || hotRoot !== 0n || resolverRootCount !== resolverOwnerRoles ||
      ENDPOINT_KEYS.some(key => endpoints.counts[key] !== endpoints.roles[key] || (key === selected ? ![0n, roles.text].includes(endpoints.roles[key]) : endpoints.roles[key] !== 0n))) fail('Dedicated resolver grants unexpected permissions');
  const records = operatorRecords(op);
  for (const key of RECORD_KEYS) {
    if (await readText(read, resolver, name, key) !== (records[key] ?? '')) fail(`Resolver record ${key} differs from the reviewed operator input`);
    if (key !== selected && await read(resolver, resolverAbi, 'roleCount', [labelId(key)]) !== 0n) fail('Resolver grants unexpected scoped authority outside the selected endpoint record');
  }
  if (endpoints.roles[selected] === 0n) {
    add(`grant-endpoint-${op.label}`, `Authorize only your endpoint updater for ${selected}`);
    return finish('configure-operator-endpoint-key');
  }
  if (!registered) {
    add(`register-${op.label}`, `Register ${name} from its operator wallet; no parent-owner signature`);
    return finish('register-operator');
  }
  plan.status = 'state-matches-config';
  plan.operators = [{ name, resolver, operator: op.operator, coldOwner: op.coldOwner, hotKey: op.hotKey, expiry: op.expiry, payee: op.payee, records }];
  return finish('complete');
}

export async function verifyJoin({ config: input, stages, client, confirmations = 12, build }) {
  if (!build) fail('Supply the reviewed registrar build explicitly');
  const config = validateJoinConfig(input), op = config.operators[0];
  if (!Number.isSafeInteger(confirmations) || confirmations < 12 || await client.getChainId() !== 1) fail('Enrollment verification requires mainnet and at least twelve confirmations');
  const final = await prepareJoinPlan({ config, client, build });
  if (final.status !== 'state-matches-config') fail('Operator enrollment is incomplete');
  if (!Array.isArray(stages) || stages.length !== 3) fail('Retain all three reviewed operator stages and receipts');
  const lastBlock = BigInt(final.preflight.blockNumber), evidence = [], hashes = new Set();
  const required = [`deploy-resolver-${op.label}`, `grant-endpoint-${op.label}`, `register-${op.label}`];
  for (const [index, stage] of stages.entries()) {
    const { plan, transactionHashes } = stage;
    if (plan?.kind !== 'derpc-ens-unsigned-plan' || plan.flow !== 'operator-join' || plan.sourceHash !== build.sourceHash || json(plan.compiler) !== json(build.compiler)) fail('Operator stage source or compiler changed');
    checkJoinIdentity(plan.resumeConfig, config);
    if (plan.transactions?.length !== 1 || plan.transactions[0].id !== required[index] || transactionHashes?.length !== 1) fail('Enrollment requires its three exact ordered transactions');
    const reviewBlock = BigInt(plan.preflight.blockNumber);
    if ((await client.getBlock({ blockNumber: reviewBlock })).hash !== plan.preflight.blockHash) fail('Operator review block is no longer canonical');
    const reconstructed = await prepareJoinPlan({ config, client, build, snapshot: plan.preflight, historical: true });
    const intent = p => ({ stage: p.stage, subregistry: p.subregistry, resolvers: p.resolvers, registrationSlot: p.registrationSlot,
      transactions: p.transactions.map(t => ({ id: t.id, walletRequest: t.walletRequest })) });
    if (json(intent(reconstructed)) !== json(intent(plan))) fail('Operator stage differs from the canonical reviewed prestate');
    const hash = transactionHashes[0], item = plan.transactions[0], expected = expectedJoinTransaction(item, config, plan, build);
    if (!HASH.test(hash ?? '') || hashes.has(hash.toLowerCase()) || json(item.walletRequest) !== json({ method: 'eth_sendTransaction', params: [expected] })) fail('Invalid or duplicate enrollment intent or transaction hash');
    hashes.add(hash.toLowerCase());
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    if (receipt.status !== 'success' || !sameAddress(tx.from, op.operator) || !sameAddress(receipt.from, op.operator) ||
        !sameAddress(tx.to, expected.to) || tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.value !== 0n || tx.chainId !== 1 ||
        tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || receipt.blockNumber <= reviewBlock ||
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash || lastBlock - receipt.blockNumber + 1n < BigInt(confirmations)) fail('Enrollment receipt differs from the operator-signed intent or lacks canonical confirmations');
    if (index && receipt.blockNumber <= evidence[index - 1].blockNumber) fail('Enrollment receipts are out of order');
    evidence.push({ id: item.id, transactionHash: hash, from: tx.from, to: tx.to, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed, confirmations: lastBlock - receipt.blockNumber + 1n });
  }
  const events = await client.getLogs({ address: final.resolvers[op.label], event: permissionAbi.find(item => item.type === 'event'),
    fromBlock: evidence[0].blockNumber, toBlock: lastBlock, strict: true });
  for (const event of events) {
    const rootOwner = sameAddress(event.args.account, op.operator) && event.args.resource === 0n && event.args.newRoleBitmap === resolverOwnerRoles;
    const endpointUpdater = sameAddress(event.args.account, op.hotKey) && event.args.resource === labelId(endpointRecordKey(op)) && event.args.newRoleBitmap === roles.text;
    if (event.removed === true || !rootOwner && !endpointUpdater) fail('Enrollment received unexpected resolver authority');
  }
  // Role-log collection can be slow. Recheck every trust anchor after that audit,
  // then recheck the final snapshot once more before exporting success.
  const canonical = new Map([[lastBlock.toString(), final.preflight.blockHash]]);
  const bind = (number, hash) => {
    const key = String(number), previous = canonical.get(key);
    if (previous && previous !== hash) fail('Enrollment evidence disagrees on a canonical block');
    canonical.set(key, hash);
  };
  for (const receipt of evidence) bind(receipt.blockNumber, receipt.blockHash);
  for (const { plan } of stages) bind(plan.preflight.blockNumber, plan.preflight.blockHash);
  for (const [number, hash] of canonical) if ((await client.getBlock({ blockNumber: BigInt(number) })).hash !== hash) fail('Enrollment snapshot, review or receipt became noncanonical during verification');
  if ((await client.getBlock({ blockNumber: lastBlock })).hash !== final.preflight.blockHash) fail('Final enrollment snapshot became noncanonical during verification');
  return { schemaVersion: 1, kind: 'derpc-ens-operator-enrollment', chainId: 1, localOnly: final.preflight.localOnly !== false,
    checkedAt: new Date().toISOString(), sourceHash: build.sourceHash, compiler: build.compiler, directory: config.directory,
    enrollmentEvidence: JSON.parse(json({ config, stages: stages.map(({ plan, transactionHashes }) => ({ plan, transactionHashes })) })),
    operators: final.operators, roleTable: final.roleTable, transactions: evidence, observedBlock: { number: lastBlock, hash: final.preflight.blockHash },
    verification: { receipts: true, canonicalBlocks: true, operatorSigned: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: confirmations },
    trust: 'Administrative RPC evidence only. Anonymous endpoint reachability, reciprocal identity and finalized proven directory discovery remain separate checks.' };
}

export function enrollmentPins(manifest) {
  if (manifest?.kind !== 'derpc-ens-operator-enrollment' || manifest.chainId !== 1 || manifest.localOnly !== false ||
      !['receipts', 'canonicalBlocks', 'operatorSigned', 'stateMatchesConfig', 'hotKeyEventAudit'].every(k => manifest.verification?.[k] === true) ||
      !Number.isSafeInteger(manifest.verification.minimumConfirmations) || manifest.verification.minimumConfirmations < 12) fail('A public verified operator enrollment is required');
  const directory = manifest.directory;
  return directoryPins({ kind: 'derpc-ens-deployment', chainId: 1, localOnly: false,
    upstream: { ETHRegistry: { address: directory?.ethRegistry } }, registrar: directory?.registrar,
    subregistry: directory?.registrar?.registry, verification: manifest.verification });
}

