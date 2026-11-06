import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import solc from 'solc';
import { encodeDeployData, encodeFunctionData, getContractAddress, keccak256, toHex, zeroAddress } from 'viem';
import { compile } from './compile.mjs';
import { addresses, adminClient, curatorRoles, deploymentSalt, dnsEncode, endpointResource, factoryAbi, fail, isEmptyCode, isMain, json, labelId, normalizedRuntimeHash, operatorRecords, preflight, readAt, readText, registrarRoles, registryAbi, reportError, resolverAbi, resolverOwnerRoles, roleTable, roles, sameAddress, save, setter, validateConfig } from './ens-common.mjs';

export function registrarBuild() {
  const compiled = compile();
  const artifact = compiled['OperatorRegistrar.sol'].OperatorRegistrar;
  return { artifact, sourceHash: keccak256(toHex(readFileSync(new URL('../src/OperatorRegistrar.sol', import.meta.url), 'utf8'))), paymentCodeHash: keccak256(`0x${compiled['QueryEscrow.sol'].QueryEscrow.evm.deployedBytecode.object}`), paymentSourceHash: keccak256(toHex(readFileSync(new URL('../src/QueryEscrow.sol', import.meta.url), 'utf8'))), compiler: { version: solc.version(), optimizerRuns: 200, evmVersion: 'shanghai' } };
}
export function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  for (const op of config.operators ?? []) if (op.payment?.deploymentFile) {
    op.payment.deployment = JSON.parse(readFileSync(resolve(dirname(path), op.payment.deploymentFile), 'utf8'));
    delete op.payment.deploymentFile;
  }
  return validateConfig(config);
}

/** Returns the next independent stage only. Rerun with resumeConfig after mined receipts. */
export async function preparePlan({ config: input, client, build = registrarBuild(), snapshot }) {
  const config = validateConfig(input);
  const observed = snapshot ?? await preflight(client);
  if (observed.chainId !== 1) fail('Wrong preflight chain');
  const blockNumber = BigInt(observed.blockNumber), now = BigInt(observed.timestamp);
  const read = readAt(client, blockNumber);
  const codeAt = address => client.getBytecode({ address, blockNumber });
  for (const op of config.operators) if (op.payment && (op.payment.deployment.codeHash !== build.paymentCodeHash || op.payment.deployment.sourceHash !== build.paymentSourceHash)) fail(`${op.label} payment manifest does not match the locally reviewed escrow source and runtime`);
  for (const op of config.operators) if (BigInt(op.expiry) <= now || BigInt(op.expiry) > now + 30n * 86400n || BigInt(op.expiry) > BigInt(observed.parent.expiry)) fail(`${op.label} needs an unexpired fixed lease of at most 30 days, within derpc.eth's expiry`);
  if (!await read(addresses.ETHRegistry, registryAbi, 'hasRoles', [labelId('derpc'), roles.setSubregistry, config.curator])) fail('Configured curator does not have SET_SUBREGISTRY authority over derpc.eth');
  const predict = kind => read(addresses.VerifiableFactory, factoryAbi, 'predictProxyAddress', [config.deployer, deploymentSalt(config, kind)]);
  const subregistry = await predict('registry');
  const resolvers = Object.fromEntries(await Promise.all(config.operators.map(async op => [op.label, await predict(`resolver:${op.label}`)])));
  if (new Set(Object.values(resolvers).map(a => a.toLowerCase())).size !== config.operators.length) fail('Each operator must have a separate resolver');
  const plan = { schemaVersion: 1, kind: 'derpc-ens-unsigned-plan', chainId: 1, createdAt: new Date().toISOString(), sourceHash: build.sourceHash, compiler: build.compiler, preflight: observed, subregistry, resolvers, resumeConfig: config, roleTable: roleTable(config), transactions: [], status: 'needs-wallet-transactions', instructions: 'Review and submit only this stage using the stated public wallet addresses. Wait for receipts, save resumeConfig, then rerun. This script never signs or sends transactions.' };
  function add(id, purpose, from, to, abi, functionName, args) {
    const tx = { from, to, data: encodeFunctionData({ abi, functionName, args }), value: '0x0', chainId: '0x1' };
    plan.transactions.push({ id, purpose, walletRequest: { method: 'eth_sendTransaction', params: [tx] } });
  }
  async function finish(stage) {
    plan.stage = stage;
    for (const item of plan.transactions) {
      const tx = item.walletRequest.params[0];
      // Every returned transaction is independently executable against the observed state.
      const gas = await client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: 0n, blockNumber });
      item.estimatedGas = gas.toString();
    }
    return plan;
  }
  async function assertProxy(address, implementation) {
    if (!sameAddress(await read(addresses.VerifiableFactory, factoryAbi, 'verifyContract', [address]), implementation)) fail('A deterministic proxy has a different implementation; use a new reviewed deploymentId');
  }
  if (!sameAddress(observed.parent.subregistry, zeroAddress) && !sameAddress(observed.parent.subregistry, subregistry)) fail('derpc.eth already points to another subregistry; do not replace an existing deployment implicitly');

  if (isEmptyCode(await codeAt(subregistry))) {
    add('deploy-registry', 'Deploy an ENS UserRegistry with only parent-setting and registrar/renew administration', config.deployer, addresses.VerifiableFactory, factoryAbi, 'deployProxy', [addresses.UserRegistryImpl, deploymentSalt(config, 'registry'), encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: config.curator, roleBitmap: curatorRoles }]] })]);
  } else await assertProxy(subregistry, addresses.UserRegistryImpl);
  for (const op of config.operators) {
    const resolver = resolvers[op.label];
    if (isEmptyCode(await codeAt(resolver))) {
      const calls = Object.entries(operatorRecords(op)).map(([key, value]) => setter(`${op.label}.${config.parentName}`, key, value));
      // grantSetterRoles must be a later cold-owner transaction: its admin check is not bypassed by initialize.
      add(`deploy-resolver-${op.label}`, `Deploy ${op.label}'s own on-chain resolver and initialize its records`, config.deployer, addresses.VerifiableFactory, factoryAbi, 'deployProxy', [addresses.PermissionedResolverImpl, deploymentSalt(config, `resolver:${op.label}`), encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: op.coldOwner, roleBitmap: resolverOwnerRoles }], calls] })]);
    } else await assertProxy(resolver, addresses.PermissionedResolverImpl);
  }
  if (plan.transactions.length) return finish('deploy-ens-proxies');

  if (!isEmptyCode(await codeAt(config.deployer))) fail('The registrar creation requires an EOA deployer; set deployer to its public wallet address (curator may remain a contract wallet)');
  if (!config.registrar) {
    const [pending, latest] = await Promise.all([client.getTransactionCount({ address: config.deployer, blockTag: 'pending' }), client.getTransactionCount({ address: config.deployer, blockTag: 'latest' })]);
    if (pending !== latest) fail('Deployer has pending transactions; wait for receipts before fixing the registrar creation nonce');
    config.registrar = { address: getContractAddress({ from: config.deployer, nonce: BigInt(pending) }), nonce: pending };
    plan.roleTable = roleTable(config);
  }
  if (!sameAddress(config.registrar.address, getContractAddress({ from: config.deployer, nonce: BigInt(config.registrar.nonce) }))) fail('Registrar address does not match its reviewed deployer and nonce');
  const registrarCode = await codeAt(config.registrar.address);
  if (isEmptyCode(registrarCode)) {
    if (await client.getTransactionCount({ address: config.deployer, blockTag: 'pending' }) !== config.registrar.nonce) fail('Registrar deployment nonce changed; check whether its reviewed transaction was mined before preparing a new address');
    const data = encodeDeployData({ abi: build.artifact.abi, bytecode: `0x${build.artifact.evm.bytecode.object}`, args: [subregistry, config.curator] });
    plan.transactions.push({ id: 'deploy-registrar', purpose: 'Deploy the fixed-layout, free curated registrar with no upgrade path', walletRequest: { method: 'eth_sendTransaction', params: [{ from: config.deployer, data, value: '0x0', chainId: '0x1', nonce: toHex(config.registrar.nonce) }] } });
    return finish('deploy-registrar');
  }
  const compiled = build.artifact.evm.deployedBytecode;
  const runtimeTemplate = { runtimeBytes: compiled.object.length / 2, immutableRanges: Object.values(compiled.immutableReferences).flat() };
  if (normalizedRuntimeHash(registrarCode, runtimeTemplate) !== keccak256(`0x${compiled.object}`)) fail('Registrar runtime differs from the local reviewed compilation');
  if (!sameAddress(await read(config.registrar.address, build.artifact.abi, 'registry'), subregistry) || !sameAddress(await read(config.registrar.address, build.artifact.abi, 'curator'), config.curator)) fail('Registrar immutable registry or curator differs');
  plan.registrar = { address: config.registrar.address, codeHash: keccak256(registrarCode), runtimeCodeHash: keccak256(registrarCode), registry: subregistry, subregistry, arraySlot: '0', entrySlots: 3, maxOperators: 128 };

  const [curatorRoot, registrarRoot, rootCount, parent] = await Promise.all([
    read(subregistry, registryAbi, 'roles', [0n, config.curator]), read(subregistry, registryAbi, 'roles', [0n, config.registrar.address]),
    read(subregistry, registryAbi, 'roleCount', [0n]), read(subregistry, registryAbi, 'getParent'),
  ]);
  if (curatorRoot !== curatorRoles || (registrarRoot !== 0n && registrarRoot !== registrarRoles) || rootCount !== curatorRoles + registrarRoot) fail('Unexpected registry root roles or assignees; no unregister, transfer or upgrade roles are allowed');
  if (registrarRoot === 0n) add('grant-registrar', 'Grant only registration and renewal to the registrar contract', config.curator, subregistry, registryAbi, 'grantRootRoles', [registrarRoles, config.registrar.address]);
  if (sameAddress(parent[0], zeroAddress) && parent[1] === '') add('set-registry-parent', 'Set the subregistry canonical parent to derpc.eth', config.curator, subregistry, registryAbi, 'setParent', [addresses.ETHRegistry, 'derpc']);
  else if (!sameAddress(parent[0], addresses.ETHRegistry) || parent[1] !== 'derpc') fail('Subregistry has a conflicting canonical parent');
  if (sameAddress(observed.parent.subregistry, zeroAddress)) add('attach-subregistry', 'Attach the new subregistry to derpc.eth; preserve its existing resolver', config.curator, addresses.ETHRegistry, registryAbi, 'setSubregistry', [labelId('derpc'), subregistry]);

  for (const op of config.operators) {
    const resolver = resolvers[op.label], name = `${op.label}.${config.parentName}`;
    const [ownerRoot, hotRoot, rootCount, endpointRoles, endpointCount] = await Promise.all([
      read(resolver, resolverAbi, 'roles', [0n, op.coldOwner]), read(resolver, resolverAbi, 'roles', [0n, op.hotKey]), read(resolver, resolverAbi, 'roleCount', [0n]),
      read(resolver, resolverAbi, 'roles', [endpointResource, op.hotKey]), read(resolver, resolverAbi, 'roleCount', [endpointResource]),
    ]);
    if (ownerRoot !== resolverOwnerRoles || hotRoot !== 0n || rootCount !== resolverOwnerRoles || ![0n, roles.text].includes(endpointRoles) || endpointCount !== endpointRoles) fail(`${op.label} resolver has unexpected roles or additional assignees`);
    if (endpointRoles === 0n) add(`grant-endpoint-${op.label}`, `Give ${op.label}'s hot key permission for derpc.endpoint only`, op.coldOwner, resolver, resolverAbi, 'grantSetterRoles', [setter(name, 'derpc.endpoint', ''), op.hotKey]);
    const records = operatorRecords(op);
    // Read even omitted payment fields so an old paid configuration cannot silently survive.
    for (const key of new Set([...Object.keys(records), 'derpc.beacon', 'derpc.gateways', 'derpc.price', 'derpc.payee', 'derpc.paymentChain', 'derpc.escrow'])) {
      if (key !== 'derpc.endpoint' && await read(resolver, resolverAbi, 'roles', [labelId(key), op.hotKey]) !== 0n) fail(`${op.label} hot key has authority outside the endpoint record`);
      const expected = records[key] ?? '';
      if (await readText(read, resolver, name, key) !== expected) add(`record-${op.label}-${key}`, `Set ${name} text ${key}`, op.coldOwner, resolver, resolverAbi, 'setText', [dnsEncode(name), key, expected]);
    }
  }
  if (plan.transactions.length) return finish('configure-permissions-and-records');

  const count = Number(await read(config.registrar.address, build.artifact.abi, 'operatorCount'));
  if (!Number.isSafeInteger(count) || count > 128) fail('Registrar count is outside the proof layout bound');
  const entries = await Promise.all(Array.from({ length: count }, (_, index) => read(config.registrar.address, build.artifact.abi, 'operators', [BigInt(index)])));
  const expectedLabels = new Set(config.operators.map(op => toHex(op.label, { size: 32 })));
  if (entries.some(entry => entry[3] && BigInt(entry[2]) > now && !expectedLabels.has(entry[0]))) fail('Registrar has an active operator absent from config; explicitly delist it before changing the intended pool');
  for (const op of config.operators) {
    const id = labelId(op.label), packedLabel = toHex(op.label, { size: 32 });
    const index = entries.findIndex(entry => entry[0] === packedLabel), entry = entries[index];
    const state = await read(subregistry, registryAbi, 'getState', [id]);
    if (!entry || BigInt(entry[2]) <= now) {
      if (state.status !== 0) fail(`${op.label} ENS name is not available for registration`);
      add(`register-${op.label}`, `Register ${op.label}.derpc.eth free, expiring, and non-transferable`, config.curator, config.registrar.address, build.artifact.abi, 'register', [op.label, op.operator, resolvers[op.label], op.payee, BigInt(op.expiry)]);
      continue;
    }
    if (!entry[3] || !sameAddress(entry[1], op.operator) || !sameAddress(entry[4], op.payee)) fail(`${op.label} existing listing is removed or has a conflicting operator/payee; do not relist or change payment identity implicitly`);
    if (state.status !== 2 || !sameAddress(state.latestOwner, op.operator) || BigInt(state.expiry) !== BigInt(entry[2]) || !sameAddress(await read(subregistry, registryAbi, 'getResolver', [op.label]), resolvers[op.label])) fail(`${op.label} ENS state does not match its registrar entry`);
    if (await read(subregistry, registryAbi, 'roleCount', [id]) !== 0n) fail(`${op.label} name unexpectedly grants roles`);
    if (BigInt(entry[2]) < BigInt(op.expiry)) add(`renew-${op.label}`, `Renew ${op.label} to the fixed configured expiry`, config.curator, config.registrar.address, build.artifact.abi, 'renew', [BigInt(index), BigInt(op.expiry)]);
    else if (BigInt(entry[2]) !== BigInt(op.expiry)) fail(`${op.label} existing lease exceeds config; update config to the existing lease rather than silently shortening it`);
  }
  if (plan.transactions.length) return finish('register-or-renew-operators');
  plan.status = 'state-matches-config';
  plan.operators = config.operators.map(op => ({ name: `${op.label}.${config.parentName}`, resolver: resolvers[op.label], operator: op.operator, coldOwner: op.coldOwner, hotKey: op.hotKey, expiry: op.expiry, payee: op.payee, records: operatorRecords(op) }));
  return finish('complete');
}

async function main() {
  const [configFile, output, rpc] = process.argv.slice(2);
  if (!configFile || !output) fail('usage: node contracts/scripts/ens-plan.mjs config.json output.json [public-rpc-url]');
  const plan = await preparePlan({ config: loadConfig(configFile), client: adminClient(rpc) });
  save(output, plan);
  console.log(`${plan.stage}: ${plan.transactions.length} unsigned transaction(s) saved to ${output}. No transaction was sent.`);
}
if (isMain(import.meta.url)) main().catch(reportError);
