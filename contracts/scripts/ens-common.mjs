import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult, getAddress, isAddress, keccak256, toHex, zeroAddress } from 'viem';
import { packetToBytes, namehash } from 'viem/ens';
import { parseOperatorEndpoints, serializeOperatorEndpoints } from '../../provider/src/operators/endpoints.ts';
export { parseOperatorEndpoints, serializeOperatorEndpoints };
export const dnsEncode = name => toHex(packetToBytes(name));

export const UPSTREAM = JSON.parse(readFileSync(new URL('../deployments/ens-upstream-mainnet.json', import.meta.url), 'utf8'));
export const addresses = Object.fromEntries(Object.entries(UPSTREAM.artifacts).map(([name, a]) => [name, a.address]));
export const roles = { register: 1n, setParent: 1n << 8n, renew: 1n << 16n, setSubregistry: 1n << 20n, text: 1n << 4n };
export const registrarRoles = roles.register | roles.renew;
export const curatorRoles = roles.setParent | (registrarRoles << 128n);
export const resolverOwnerRoles = roles.text | (roles.text << 128n);
export const labelId = label => BigInt(keccak256(toHex(label)));
export const endpointResource = labelId('derpc.endpoint');
export const ENDPOINT_KEYS = ['derpc.endpoint', 'derpc.endpoints'];
export const endpointRecordKey = op => Object.hasOwn(op, 'endpoints') || !!op.records?.['derpc.endpoints'] ? 'derpc.endpoints' : 'derpc.endpoint';
export const obsoleteEndpointKey = op => endpointRecordKey(op) === 'derpc.endpoints' ? 'derpc.endpoint' : 'derpc.endpoints';
export const RECORD_KEYS = ['derpc.endpoint', 'derpc.endpoints', 'derpc.beacon', 'derpc.signer', 'derpc.caps', 'derpc.gateways', 'derpc.price', 'derpc.payee', 'derpc.paymentChain', 'derpc.escrow'];
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const isEmptyCode = code => !code || code === '0x';
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export const save = (file, value) => writeFileSync(file, json(value), { flag: 'wx' });
export const isMain = url => process.argv[1] && pathToFileURL(process.argv[1]).href === url;
export const fail = message => { throw new Error(message); };
export const reportError = error => { console.error(error.name === 'Error' ? error.message : 'Administrative RPC check failed; inspect the RPC connection without exposing credentials.'); process.exitCode = 1; };

// Minimal public interfaces, checked against the pinned ENS deployment artifacts.
export const factoryAbi = parseAbi([
  'function deployProxy(address implementation,uint256 salt,bytes data) returns(address)',
  'function predictProxyAddress(address deployer,uint256 salt) view returns(address)',
  'function verifyContract(address proxy) view returns(address implementation)',
]);
export const permissionAbi = parseAbi([
  'function roles(uint256 resource,address account) view returns(uint256)',
  'function roleCount(uint256 resource) view returns(uint256)',
  'function hasRoles(uint256 resource,uint256 bitmap,address account) view returns(bool)',
  'function grantRootRoles(uint256 bitmap,address account) returns(bool)',
  'event EACRolesChanged(uint256 indexed resource,address indexed account,uint256 oldRoleBitmap,uint256 newRoleBitmap)',
]);
export const registryAbi = [...permissionAbi, ...parseAbi([
  'function initialize((address account,uint256 roleBitmap)[] grants)',
  'function getState(uint256 anyId) view returns((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))',
  'function getSubregistry(string label) view returns(address)',
  'function getResolver(string label) view returns(address)',
  'function setSubregistry(uint256 anyId,address registry)',
  'function getParent() view returns(address parent,string label)',
  'function setParent(address parent,string label)',
])];
export const resolverAbi = [...permissionAbi, ...parseAbi([
  'function initialize((address account,uint256 roleBitmap)[] grants,bytes[] calls)',
  'function setText(bytes name,string key,string value)',
  'function resolve(bytes name,bytes data) view returns(bytes)',
  'function grantSetterRoles(bytes setter,address account) returns(bool)',
  'function revokeRoles(uint256 resource,uint256 roleBitmap,address account) returns(bool)',
  'function multicall(bytes[] calls) returns(bytes[] results)',
])];
export const textAbi = parseAbi(['function text(bytes32 node,string key) view returns(string)']);
export const readAt = (client, blockNumber) => (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber });
export const setter = (name, key, value) => encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(name), key, value] });
export async function readText(read, resolver, name, key) {
  const result = await read(resolver, resolverAbi, 'resolve', [dnsEncode(name), encodeFunctionData({ abi: textAbi, functionName: 'text', args: [namehash(name), key] })]);
  return decodeFunctionResult({ abi: textAbi, functionName: 'text', data: result });
}
export function adminClient(url = process.env.ENS_RPC_URL ?? 'https://ethereum-rpc.publicnode.com') {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) fail('Invalid administrative RPC URL');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) fail('Remote administrative RPC requires HTTPS');
  // Deliberately no wallet client, signer, private key, or transaction submission path.
  return createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000 }), ccipRead: false });
}

export function normalizedRuntimeHash(code, artifact) {
  if (isEmptyCode(code) || (code.length - 2) / 2 !== artifact.runtimeBytes) fail('ENS upstream runtime length differs from the pinned source');
  let normalized = code.slice(2);
  for (const { start, length } of artifact.immutableRanges) normalized = normalized.slice(0, start * 2) + '0'.repeat(length * 2) + normalized.slice((start + length) * 2);
  return keccak256(`0x${normalized}`);
}

export async function preflight(client) {
  if (await client.getChainId() !== 1) fail('ENS deployment is mainnet only; administrative RPC chain ID must be 1');
  const block = await client.getBlock({ blockTag: 'latest' });
  const read = readAt(client, block.number);
  const upstream = {};
  for (const [name, artifact] of Object.entries(UPSTREAM.artifacts)) {
    const code = await client.getBytecode({ address: artifact.address, blockNumber: block.number });
    if (normalizedRuntimeHash(code, artifact) !== artifact.normalizedRuntimeCodeHash) fail(`${name} runtime does not match the pinned official ENS artifact`);
    upstream[name] = { address: artifact.address, runtimeCodeHash: keccak256(code), normalizedRuntimeCodeHash: artifact.normalizedRuntimeCodeHash };
  }
  const [state, subregistry, resolver] = await Promise.all([
    read(addresses.ETHRegistry, registryAbi, 'getState', [labelId('derpc')]),
    read(addresses.ETHRegistry, registryAbi, 'getSubregistry', ['derpc']),
    read(addresses.ETHRegistry, registryAbi, 'getResolver', ['derpc']),
  ]);
  if (state.status !== 2 || state.expiry <= block.timestamp) fail('derpc.eth must be registered and unexpired');
  const rpcOrigin = client.transport?.url ? new URL(client.transport.url).origin : 'injected administrative client';
  const localOnly = !client.transport?.url || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(client.transport.url).hostname);
  return { schemaVersion: 1, kind: 'derpc-ens-preflight', chainId: 1, rpcOrigin, localOnly, checkedAt: new Date().toISOString(), blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, upstreamSource: UPSTREAM.source, upstreamSourceCommit: UPSTREAM.sourceCommit, upstream, parent: { name: 'derpc.eth', registry: addresses.ETHRegistry, ...state, subregistry, resolver }, trust: 'Read-only administrative RPC observations; not light-client verified. No transactions sent.' };
}

function address(value, field) {
  if (typeof value !== 'string' || !isAddress(value) || sameAddress(value, zeroAddress)) fail(`${field} must be a nonzero public address`);
  return getAddress(value);
}
function endpoint(value, field) {
  if (typeof value !== 'string' || value.length > 2048) fail(`${field} must be an endpoint URL`);
  let u; try { u = new URL(value); } catch { fail(`${field} must be an endpoint URL`); }
  if (u.username || u.password || u.hash || u.search) fail(`${field} cannot contain credentials, query parameters or fragments`);
  if (u.hostname.endsWith('.onion')) {
    const label = u.hostname.slice(0, -6);
    if (!/^[a-z2-7]{56}$/.test(label) || !['http:', 'https:'].includes(u.protocol)) fail(`${field} must be a v3 onion URL`);
    let bits = 0, acc = 0; const bytes = [];
    for (const c of label) { acc = (acc << 5) | 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
    const decoded = Buffer.from(bytes);
    const checksum = createHash('sha3-256').update(Buffer.concat([Buffer.from('.onion checksum'), decoded.subarray(0, 32), Buffer.from([3])])).digest();
    if (decoded[34] !== 3 || !decoded.subarray(32, 34).equals(checksum.subarray(0, 2))) fail(`${field} has an invalid onion checksum`);
  } else if (u.protocol !== 'https:') fail(`${field} requires HTTPS or a v3 onion service`);
  return value;
}
export { endpoint as validateEndpoint };
export function validateConfig(input) {
  if (!input || input.schemaVersion !== 1 || input.chainId !== 1 || input.parentName !== 'derpc.eth') fail('Use ENS config schemaVersion 1, chainId 1 and parentName derpc.eth');
  const only = (object, keys) => { if (Object.keys(object).some(key => !keys.includes(key))) fail('Unknown configuration field; this tool accepts public deployment data only'); };
  only(input, ['schemaVersion', 'chainId', 'parentName', 'curator', 'deployer', 'deploymentId', 'operators', 'registrar']);
  const c = structuredClone(input);
  c.curator = address(c.curator, 'curator');
  c.deployer = address(c.deployer ?? c.curator, 'deployer');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(c.deploymentId)) fail('deploymentId must be a stable 1–40 character identifier');
  if (!Array.isArray(c.operators) || c.operators.length < 1 || c.operators.length > 3) fail('Supply 1–3 explicitly configured operators');
  const labels = new Set(); const hotKeys = new Set();
  for (const op of c.operators) {
    only(op, ['label', 'operator', 'coldOwner', 'hotKey', 'signer', 'payee', 'endpoint', 'beacon', 'endpoints', 'caps', 'expiry', 'gateways', 'payment']);
    if (typeof op.label !== 'string' || !/^(?!..--)[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(op.label) || labels.has(op.label)) fail('Operator labels must be unique, lowercase ASCII, 1–31 characters with no edge hyphen and no hyphens in both the third and fourth places');
    labels.add(op.label);
    for (const key of ['operator', 'coldOwner', 'hotKey', 'signer', 'payee']) op[key] = address(op[key], `${op.label}.${key}`);
    if (sameAddress(op.hotKey, op.coldOwner) || sameAddress(op.hotKey, op.operator) || sameAddress(op.hotKey, c.curator) || hotKeys.has(op.hotKey.toLowerCase())) fail('Each hot key must be distinct from operator owners, cold owners, curator and other hot keys');
    hotKeys.add(op.hotKey.toLowerCase());
    if (Object.hasOwn(op, 'endpoints')) {
      if (Object.hasOwn(op, 'endpoint') || Object.hasOwn(op, 'beacon') || Object.hasOwn(op, 'payment')) fail('Plural endpoints are free-only and exclusive with endpoint, beacon and payment fields');
      op.endpoints = parseOperatorEndpoints(serializeOperatorEndpoints(op.endpoints));
    } else {
      op.endpoint = endpoint(op.endpoint, `${op.label}.endpoint`);
      if (op.beacon) op.beacon = endpoint(op.beacon, `${op.label}.beacon`);
    }
    if (!Number.isSafeInteger(op.expiry) || op.expiry <= 0) fail('Set a fixed Unix expiry for each operator; do not regenerate the lease on each run');
    if (op.caps?.chainId !== 1 || !Array.isArray(op.caps.methods) || op.caps.methods.length !== 2 || new Set(op.caps.methods).size !== 2 || !['eth_getProof', 'eth_getCode'].every(m => op.caps.methods.includes(m))) fail('Capabilities must declare mainnet eth_getProof and eth_getCode');
    only(op.caps, ['chainId', 'methods', 'beacon']);
    if (op.caps.beacon !== undefined && typeof op.caps.beacon !== 'boolean') fail('caps.beacon must be a boolean');
    if (op.caps.beacon === true && (op.endpoints ? !op.endpoints.every(entry => entry.beaconUrl) : !op.beacon)) fail('Beacon capability requires a beacon URL for every declared endpoint');
    if (op.gateways !== undefined && (!Array.isArray(op.gateways) || op.gateways.some(g => typeof g !== 'string' || g.length > 512))) fail('gateways must be a list of public KPS addresses');
    if (op.payment) {
      const p = op.payment;
      only(p, ['priceWei', 'deployment']);
      if (typeof p.priceWei !== 'string' || !/^[1-9][0-9]*$/.test(p.priceWei) || BigInt(p.priceWei) >= 1n << 256n) fail('Payment price must be a positive decimal uint256');
      const d = p.deployment;
      if (!d || d.kind !== 'derpc-query-escrow' || d.testPayments !== true || d.localOnly !== false || ![560048, 11155111].includes(d.chainId) || d.verification?.receipt !== true || d.verification?.creationInput !== true || d.verification?.runtimeCode !== true || !/^[0-9]+$/.test(String(d.verification?.confirmations)) || BigInt(d.verification.confirmations) < 12n || !/^0x[0-9a-fA-F]{64}$/.test(d.transactionHash) || !/^0x[0-9a-fA-F]{64}$/.test(d.codeHash)) fail('Payment records require a receipt-checked public testnet deployment manifest from payment-deploy.mjs with at least 12 confirmations');
      d.escrow = address(d.escrow, 'payment.deployment.escrow');
    }
  }
  for (const op of c.operators) if (c.operators.some(other => sameAddress(op.hotKey, other.coldOwner) || sameAddress(op.hotKey, other.operator))) fail('A hot key cannot be another operator or resolver cold owner');
  if (c.registrar !== undefined) {
    c.registrar.address = address(c.registrar.address, 'registrar.address');
    if (!Number.isSafeInteger(c.registrar.nonce) || c.registrar.nonce < 0) fail('registrar.nonce must be its reviewed deployment nonce');
  }
  return c;
}
export function operatorRecords(op) {
  const records = Object.hasOwn(op, 'endpoints') ? { 'derpc.endpoints': serializeOperatorEndpoints(op.endpoints), 'derpc.endpoint': '', 'derpc.beacon': '', 'derpc.signer': op.signer, 'derpc.caps': JSON.stringify(op.caps) } : { 'derpc.endpoint': op.endpoint, 'derpc.signer': op.signer, 'derpc.caps': JSON.stringify(op.caps) };
  if (op.beacon) records['derpc.beacon'] = op.beacon;
  if (op.gateways) records['derpc.gateways'] = JSON.stringify(op.gateways);
  if (op.payment) Object.assign(records, { 'derpc.price': op.payment.priceWei, 'derpc.payee': op.payee, 'derpc.paymentChain': String(op.payment.deployment.chainId), 'derpc.escrow': op.payment.deployment.escrow });
  return records;
}
/** A reviewed cold-owner transaction moves permissions and records together. */
export function endpointMigrationCalls(op, name) {
  const selected = endpointRecordKey(op), obsolete = obsoleteEndpointKey(op), records = operatorRecords(op);
  return [
    encodeFunctionData({ abi: resolverAbi, functionName: 'revokeRoles', args: [labelId(obsolete), roles.text, op.hotKey] }),
    setter(name, obsolete, ''),
    setter(name, 'derpc.beacon', records['derpc.beacon'] ?? ''),
    setter(name, selected, records[selected]),
    encodeFunctionData({ abi: resolverAbi, functionName: 'grantSetterRoles', args: [setter(name, selected, ''), op.hotKey] }),
  ];
}
export async function endpointState(read, resolver, name, hotKey) {
  const [roleEntries, countEntries, recordEntries] = await Promise.all([
    Promise.all(ENDPOINT_KEYS.map(async key => [key, await read(resolver, resolverAbi, 'roles', [labelId(key), hotKey])])),
    Promise.all(ENDPOINT_KEYS.map(async key => [key, await read(resolver, resolverAbi, 'roleCount', [labelId(key)])])),
    Promise.all([...ENDPOINT_KEYS, 'derpc.beacon'].map(async key => [key, await readText(read, resolver, name, key)])),
  ]);
  return { roles: Object.fromEntries(roleEntries), counts: Object.fromEntries(countEntries), records: Object.fromEntries(recordEntries) };
}
export async function endpointMigrationState(read, resolver, name, op) {
  const [endpoints, ownerRoot, hotRoot, rootCount, protectedEntries] = await Promise.all([
    endpointState(read, resolver, name, op.hotKey),
    read(resolver, resolverAbi, 'roles', [0n, op.coldOwner]), read(resolver, resolverAbi, 'roles', [0n, op.hotKey]), read(resolver, resolverAbi, 'roleCount', [0n]),
    Promise.all(RECORD_KEYS.filter(key => !ENDPOINT_KEYS.includes(key) && key !== 'derpc.beacon').map(async key => [key, await readText(read, resolver, name, key)])),
  ]);
  return { ...endpoints, ownerRoot, hotRoot, rootCount, protectedRecords: Object.fromEntries(protectedEntries) };
}
export const deploymentSalt = (config, kind) => BigInt(keccak256(toHex(`DeRPC:${config.parentName}:${config.deploymentId}:${kind}`)));
export const roleTable = config => [
  { resource: 'UserRegistry root', account: config.curator, roles: 'SET_PARENT; REGISTRAR_ADMIN; RENEW_ADMIN', bitmap: curatorRoles.toString() },
  { resource: 'UserRegistry root', account: config.registrar?.address ?? 'registrar address assigned after subregistry deployment', roles: 'REGISTRAR; RENEW', bitmap: registrarRoles.toString() },
  ...config.operators.flatMap(op => [
    { resource: `${op.label} resolver root`, account: op.coldOwner, roles: 'SET_TEXT; SET_TEXT_ADMIN', bitmap: resolverOwnerRoles.toString() },
    { resource: `${op.label} resolver key ${endpointRecordKey(op)} only`, account: op.hotKey, roles: 'SET_TEXT', bitmap: roles.text.toString() },
    { resource: `${op.label} ENS name`, account: op.operator, roles: 'none (non-transferable)', bitmap: '0' },
  ]),
];
