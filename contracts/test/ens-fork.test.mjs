// Optional deployment validation against actual ENSv2 bytecode on a disposable LOCAL fork.
// Start Anvil separately (the public upstream is read-only):
// anvil --fork-url "$ENS_FORK_UPSTREAM_RPC" --fork-block-number 26355441 --chain-id 31337 --port 8855 --silent
// Loopback + initial chain 31337 + Anvil fork state are checked before any mutation.
// The planner scenario temporarily sets this local node's chain ID to 1, then restores it.
// Example: DERPC_ENS_FORK_RPC=http://127.0.0.1:8855 pnpm --filter @derpc/contracts exec vitest run test/ens-fork.test.mjs
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, decodeFunctionData, decodeFunctionResult, encodeFunctionData, http, keccak256, namehash, parseAbi, stringToHex, zeroAddress } from 'viem';
import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from '../scripts/compile.mjs';
import { preparePlan, registrarBuild } from '../scripts/ens-plan.mjs';
import { verifyDeployment } from '../scripts/ens-verify.mjs';
import { validateForkLifecycle } from './ens-lifecycle-fork.mjs';
import { validateForkEndpoints } from './ens-endpoints-fork.mjs';
import { validateTeamDemoFork } from './ens-team-demo-fork.mjs';

const forkRpc = process.env.DERPC_ENS_FORK_RPC;
// Deployment records from ensdomains/contracts-v2 at 4f47cbcc11462fb413196e6b5c0f8090247a6c08.
const addresses = {
  factory: '0x77510ba162dfea3d8989e3f0928a691b345730d2',
  registryImplementation: '0xfaa23592aca10a6d8875b18ea86954e8eb6d8d72',
  resolverImplementation: '0x565b0f456a04ac9b48758190e90030623cff57c5',
  ethRegistry: '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2',
};
const factoryAbi = parseAbi([
  'function deployProxy(address implementation,uint256 salt,bytes data) returns(address)',
  'function predictProxyAddress(address deployer,uint256 salt) view returns(address)',
  'function verifyContract(address proxy) view returns(address)',
]);
const registryAbi = parseAbi([
  'function initialize((address account,uint256 roleBitmap)[] grants)',
  'function grantRootRoles(uint256 roleBitmap,address account) returns(bool)',
  'function hasRootRoles(uint256 roleBitmap,address account) view returns(bool)',
  'function roles(uint256 resource,address account) view returns(uint256)',
  'function roleCount(uint256 resource) view returns(uint256)',
  'function getState(uint256 anyId) view returns((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))',
  'function getSubregistry(string label) view returns(address)',
  'function getResolver(string label) view returns(address)',
  'function setParent(address parent,string label)',
  'function setSubregistry(uint256 anyId,address registry)',
  'function unsafeTransfer(address to,uint256 tokenId,bytes data)',
  'function setResolver(uint256 anyId,address resolver)',
]);
const resolverAbi = parseAbi([
  'function initialize((address account,uint256 roleBitmap)[] grants,bytes[] calls)',
  'function setText(bytes name,string key,string value)',
  'function grantSetterRoles(bytes setter,address account) returns(bool)',
  'function resolve(bytes name,bytes data) view returns(bytes)',
  'function text(bytes32 node,string key) view returns(string)',
]);
const registerAndRenew = 1n | (1n << 16n);
const setParent = 1n << 8n;
const setText = 1n << 4n;
const labelHash = label => BigInt(keccak256(stringToHex(label)));
const dns = name => `0x${name.split('.').map(label => label.length.toString(16).padStart(2, '0') + Buffer.from(label).toString('hex')).join('')}00`;
const evidence = { checkedAt: new Date().toISOString(), scope: 'local mainnet fork; no public-chain transactions', localOnly: true, complete: false, sourceCommit: '4f47cbcc11462fb413196e6b5c0f8090247a6c08', addresses, checks: [] };
let client, rpc, curator, alice, bob, hot, outsider, registry, resolverAlice, resolverBob, registrar, registrarAbi, snapshot;

async function localReceipt(hash) {
  // Poll the exact submitted hash. A fork's source block stream is not a receipt oracle.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { return await client.getTransactionReceipt({ hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`local fork did not mine submitted transaction ${hash}`);
}

async function write(wallet, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, chain: null, gas: 8_000_000n });
  const receipt = await localReceipt(hash);
  if (receipt.status !== 'success') {
    await client.simulateContract({ account: wallet.account, address, abi, functionName, args });
    throw new Error(`local ${functionName} transaction reverted: ${hash}`);
  }
  return receipt;
}
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
async function deployProxy(implementation, salt, data) {
  const expected = await read(addresses.factory, factoryAbi, 'predictProxyAddress', [curator.account.address, salt]);
  await write(curator, addresses.factory, factoryAbi, 'deployProxy', [implementation, salt, data]);
  expect((await read(addresses.factory, factoryAbi, 'verifyContract', [expected])).toLowerCase()).toBe(implementation.toLowerCase());
  return expected;
}
async function textRecord(resolver, name, key) {
  const query = encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [namehash(name), key] });
  const encoded = await read(resolver, resolverAbi, 'resolve', [dns(name), query]);
  return decodeFunctionResult({ abi: resolverAbi, functionName: 'text', data: encoded });
}

async function validateForkDiscovery(config, plan, build) {
  const { discoverOperators, readProvenOperators, retainChosenOperators, RECORD_KEYS, registryAbi: directoryRegistryAbi, resolverAbi: directoryResolverAbi } = await import('../../provider/src/discovery/ens.ts');
  const { createVerifiedExecutor } = await import('../../provider/src/execution/verified-call.ts');
  const { createJsonRpcSend } = await import('../../provider/src/transport/json-rpc.ts');
  const { TOR_JS_PIN } = await import('../../provider/src/config/mainnet.ts');
  const { verifyAccountProof, verifyStorageProof, verifyCode } = await import('../../provider/src/verify/index.ts');
  const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
  const quantity = value => `0x${BigInt(value).toString(16)}`;
  const call = (to, abi, functionName, args = []) => ({ to, data: encodeFunctionData({ abi, functionName, args }) });
  const registrarPin = { address: config.registrar.address, codeHash: plan.registrar.runtimeCodeHash, registry: plan.subregistry };

  // Populate all nine real resolver records. This unfunded escrow and its terms
  // exist only in the disposable test chain; they are not a public payment deployment.
  const escrowBuild = compile()['QueryEscrow.sol'].QueryEscrow;
  const escrowHash = await curator.deployContract({ abi: escrowBuild.abi, bytecode: `0x${escrowBuild.evm.bytecode.object}`, chain: null, gas: 8_000_000n });
  const localEscrow = (await localReceipt(escrowHash)).contractAddress;
  for (const op of config.operators) {
    const owner = createWalletClient({ account: op.coldOwner, transport: http(forkRpc, { retryCount: 0 }) });
    for (const [key, value] of Object.entries({ 'derpc.beacon': `https://${op.label}.example/`, 'derpc.gateways': '[]', 'derpc.price': '1000', 'derpc.payee': op.payee, 'derpc.paymentChain': '31337', 'derpc.escrow': localEscrow })) {
      await write(owner, plan.resolvers[op.label], resolverAbi, 'setText', [dns(`${op.label}.derpc.eth`), key, value]);
    }
  }

  const calls = [
    call(addresses.ethRegistry, directoryRegistryAbi, 'getState', [labelHash('derpc')]),
    call(addresses.ethRegistry, directoryRegistryAbi, 'getSubregistry', ['derpc']),
    call(config.registrar.address, build.artifact.abi, 'operatorCount'),
    call(TOR_JS_PIN.specifier, parseAbi(['function workerHash() view returns(bytes32)']), 'workerHash'),
    ...config.operators.flatMap((op, index) => [
      call(config.registrar.address, build.artifact.abi, 'operators', [BigInt(index)]),
      call(plan.subregistry, directoryRegistryAbi, 'getState', [labelHash(op.label)]),
      call(plan.subregistry, directoryRegistryAbi, 'getResolver', [op.label]),
      call(plan.resolvers[op.label], directoryResolverAbi, 'resolve', [dns(`${op.label}.derpc.eth`), encodeFunctionData({ abi: directoryResolverAbi, functionName: 'multicall', args: [RECORD_KEYS.map(key => encodeFunctionData({ abi: directoryResolverAbi, functionName: 'text', args: [namehash(`${op.label}.derpc.eth`), key] }))] })]),
    ]),
  ];
  const stats = { localOnly: true, consensusVerified: false, anonymousTransportVerified: false,
    trust: 'Injected local proof root and transport/identity fixture. Exact prestate is traced from genuine fork contracts; no consensus or public deployment claim.',
    materializations: [], rpcMethods: {}, referenceCalls: 0, materializationReferenceCalls: 0, resolverBatches: 0, identities: 0,
    paymentTerms: { localOnly: true, chainId: 31337, escrow: localEscrow, funded: false } };
  let header, allowedAccounts, allowedSlots, tamperAddress;
  const wrongIdentity = new Set();

  async function materializeExactPrestate() {
    const source = await rpc('eth_getBlockByNumber', ['latest', false]);
    const traced = new Map(), reference = [];
    // Anvil's fork trie includes only materialized local state; mined fork blocks
    // report a zero stateRoot. Preserve exact traced values, then inject that trie root.
    for (const request of calls) {
      reference.push(await rpc('eth_call', [request, source.number]));
      const prestate = await rpc('debug_traceCall', [request, source.number, { tracer: 'prestateTracer' }]);
      for (const [address, account] of Object.entries(prestate)) {
        const previous = traced.get(address) ?? {};
        traced.set(address, { ...previous, ...account, storage: { ...previous.storage, ...account.storage } });
      }
    }
    expect(traced.size).toBeLessThanOrEqual(24);
    let codeBytes = 0, storageSlots = 0;
    const accountRecords = [];
    allowedAccounts = new Set(traced.keys());
    allowedSlots = new Map();
    for (const [address, account] of traced) {
      // Read every account field from the actual fork, including empty addresses;
      // a missing upstream account must not silently become a valid absence proof.
      const code = await rpc('eth_getCode', [address, source.number]);
      const balance = await rpc('eth_getBalance', [address, source.number]);
      const nonce = await rpc('eth_getTransactionCount', [address, source.number]);
      if (account.code) expect(code.toLowerCase()).toBe(account.code.toLowerCase());
      codeBytes += (code.length - 2) / 2;
      const slots = new Set(Object.keys(account.storage).map(word));
      allowedSlots.set(address, slots);
      storageSlots += slots.size;
      expect(codeBytes).toBeLessThanOrEqual(256 * 1024);
      expect(storageSlots).toBeLessThanOrEqual(256);
      accountRecords.push({ address, code, codeHash: keccak256(code), codeBytes: (code.length - 2) / 2, storageSlots: slots.size });
      await rpc('anvil_setCode', [address, code]);
      await rpc('anvil_setBalance', [address, balance]);
      await rpc('anvil_setNonce', [address, nonce]);
      for (const [key, value] of Object.entries(account.storage)) {
        expect(word(await rpc('eth_getStorageAt', [address, key, source.number]))).toBe(word(value));
        await rpc('anvil_setStorageAt', [address, word(key), word(value)]);
      }
    }
    await rpc('evm_mine');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    const proof = await rpc('eth_getProof', [registrarPin.address, [], block.number]);
    const stateRoot = keccak256(proof.accountProof[0]);
    // Audit every hydrated account and slot against this SAME local trie root,
    // including values not subsequently needed by a filtered directory refresh.
    for (const account of accountRecords) {
      const keys = [...allowedSlots.get(account.address)];
      const authenticated = await rpc('eth_getProof', [account.address, keys, block.number]);
      const verifiedAccount = verifyAccountProof({ stateRoot, address: account.address, proof: authenticated });
      verifyCode({ codeHash: verifiedAccount.codeHash, code: account.code });
      expect(authenticated.storageProof).toHaveLength(keys.length);
      for (const [index, key] of keys.entries()) expect(verifyStorageProof({ storageRoot: verifiedAccount.storageRoot, slot: key, proof: authenticated.storageProof[index] })).toBe(BigInt(traced.get(account.address).storage[key]));
    }
    for (const [index, request] of calls.entries()) {
      expect(await rpc('eth_call', [request, block.number])).toBe(reference[index]);
      stats.materializationReferenceCalls++;
    }
    header = { network: 'mainnet', slot: 0, blockNumber: Number(BigInt(block.number)), blockHash: block.hash, stateRoot,
      timestamp: Number(BigInt(block.timestamp)), execution: { feeRecipient: block.miner, prevRandao: block.mixHash, gasLimit: BigInt(block.gasLimit), baseFeePerGas: BigInt(block.baseFeePerGas) } };
    stats.materializations.push({ blockNumber: header.blockNumber, blockHash: header.blockHash, injectedStateRoot: stateRoot, nodeReportedStateRoot: block.stateRoot, accounts: traced.size, codeBytes, storageSlots,
      everyAccountCodeAndSlotProven: true, accountRecords: accountRecords.map(({ code: _code, ...record }) => record) });
  }

  const headers = { finalized: () => header, assertFresh: observed => {
    expect(observed.blockHash).toBe(header.blockHash);
    expect(observed.stateRoot).toBe(header.stateRoot);
  } };
  // This is explicitly a transport fixture. Real proof/code bytes come from the
  // local node; identity documents are fixtures. No .example URL is fetched.
  const transport = { pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => 'ready', close() {}, async fetch(url, options = {}) {
    options.signal?.throwIfAborted();
    expect(typeof options.isolationKey).toBe('string');
    const parsed = new URL(url), op = config.operators.find(item => parsed.hostname === `${item.label}.example`);
    expect(parsed.hostname === 'bootstrap.example' || !!op).toBe(true);
    if (!options.body) {
      expect(parsed.pathname).toBe('/.well-known/derpc.json');
      stats.identities++;
      return Response.json({ ens: `${wrongIdentity.has(op.label) ? 'wrong' : op.label}.derpc.eth`, signer: op.signer, chains: [1], version: '1', service: 'demo-proxy' });
    }
    const request = JSON.parse(String(options.body));
    expect(['eth_getProof', 'eth_getCode']).toContain(request.method);
    expect(request.params.at(-1)).toBe(quantity(header.blockNumber));
    const address = request.params[0].toLowerCase();
    expect(allowedAccounts.has(address)).toBe(true);
    stats.rpcMethods[request.method] = (stats.rpcMethods[request.method] ?? 0) + 1;
    const params = [...request.params];
    if (request.method === 'eth_getProof') {
      // Anvil requires full byte words even though Ethereum RPC accepts quantities.
      params[1] = params[1].map(word);
      for (const slot of params[1]) expect(allowedSlots.get(address).has(slot)).toBe(true);
    }
    const result = await rpc(request.method, params);
    if (request.method === 'eth_getProof') {
      expect(keccak256(result.accountProof[0])).toBe(header.stateRoot);
      if (tamperAddress === address && result.storageProof.length) result.storageProof[0].value = quantity(BigInt(result.storageProof[0].value) ^ 1n);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  } };
  const send = createJsonRpcSend(transport, 'https://bootstrap.example/');
  const executor = createVerifiedExecutor({ headers, send });
  const options = { transport, executionUrl: 'https://bootstrap.example/', headers, send, registrar: registrarPin,
    ethRegistry: addresses.ethRegistry, now: () => header.timestamp * 1000,
    async verifiedCall(to, data, opts) {
      if (Object.values(plan.resolvers).some(address => address.toLowerCase() === to.toLowerCase())) {
        const outer = decodeFunctionData({ abi: directoryResolverAbi, data });
        expect(outer.functionName).toBe('resolve');
        const inner = decodeFunctionData({ abi: directoryResolverAbi, data: outer.args[1] });
        expect(inner.functionName).toBe('multicall');
        expect(inner.args[0].map(item => decodeFunctionData({ abi: directoryResolverAbi, data: item }).args[1])).toEqual(RECORD_KEYS);
        stats.resolverBatches++;
      }
      const result = await executor.call({ to, data, signal: opts.signal });
      // Administrative reference read only: never supplied to provider discovery.
      expect(result.value).toBe(await rpc('eth_call', [{ to, data }, quantity(header.blockNumber)]));
      stats.referenceCalls++;
      return result;
    } };

  await materializeExactPrestate();
  const members = await readProvenOperators({ headers, send, registrar: registrarPin, now: options.now });
  expect(members.value).toEqual(config.operators.map(op => ({ label: op.label, operator: op.operator.toLowerCase(), payee: op.payee.toLowerCase(), expiry: op.expiry })));
  const beforeInitial = { ...stats.rpcMethods };
  const initial = await discoverOperators(options);
  stats.initialDirectoryRequests = Object.fromEntries(Object.entries(stats.rpcMethods).map(([method, count]) => [method, count - (beforeInitial[method] ?? 0)]));
  expect(initial.rejected).toEqual([]);
  expect(initial.operators.map(op => op.ens)).toEqual(['alice.derpc.eth', 'bob.derpc.eth']);
  expect(initial).toMatchObject({ listVerification: 'proven', recordVerification: 'proven' });
  expect(stats.resolverBatches).toBe(2);
  for (const [index, op] of initial.operators.entries()) expect(op.payment).toMatchObject({ payee: config.operators[index].payee.toLowerCase(), payeeProven: true, recordsProven: true, price: 1000n, chainId: 31337, escrow: localEscrow });

  wrongIdentity.add('alice');
  const mismatched = await discoverOperators(options);
  expect(mismatched.operators.map(op => op.ens)).toEqual(['bob.derpc.eth']);
  expect(mismatched.rejected[0].reason).toMatch(/identity does not match/);
  wrongIdentity.clear();
  for (const address of [registrarPin.address, plan.resolvers.alice]) {
    tamperAddress = address.toLowerCase();
    await expect(discoverOperators(options)).rejects.toMatchObject({ name: 'ProofVerificationError' });
  }
  tamperAddress = undefined;

  const renewedExpiry = config.operators[0].expiry + 3600;
  await write(alice, registrarPin.address, build.artifact.abi, 'renew', [0n, renewedExpiry]);
  await materializeExactPrestate();
  const renewed = await discoverOperators(options);
  expect(renewed.operators.find(op => op.ens === 'alice.derpc.eth').expiry).toBe(renewedExpiry);
  const owner = createWalletClient({ account: config.curator, transport: http(forkRpc, { retryCount: 0 }) });
  await write(owner, registrarPin.address, build.artifact.abi, 'remove', [0n, config.operators[0].operator, stringToHex(config.operators[0].label, { size: 32 })]);
  await materializeExactPrestate();
  const removed = await discoverOperators(options);
  expect(retainChosenOperators(removed, initial.operators.map(op => op.ens)).map(op => op.ens)).toEqual(['bob.derpc.eth']);
  await rpc('evm_increaseTime', [Math.max(1, config.operators[1].expiry - header.timestamp + 1)]);
  await rpc('evm_mine');
  await materializeExactPrestate();
  const expired = await discoverOperators(options);
  expect(expired.operators).toEqual([]);
  expect(expired.listVerification).toBe('proven');
  stats.assertions = ['full registrar membership and payees', 'two real nine-record resolver multicalls', 'reciprocal identity mismatch rejection', 'altered registrar and resolver storage proofs abort discovery', 'renewed lease refresh', 'delisting removes chosen operator', 'expiry empties directory'];
  evidence.discovery = stats;
  evidence.checks.push('Real fork registrar/resolver discovery using one injected local proof root per refresh; exact direct reference equality; altered proofs and identity mismatch rejected; renewal/removal/expiry applied');
}

describe.sequential.skipIf(!forkRpc)('actual ENSv2 contracts on a local mainnet fork', () => {
  beforeAll(async () => {
    const url = new URL(forkRpc);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('fork test requires a credential-free loopback HTTP endpoint');
    const transport = http(forkRpc, { retryCount: 0, timeout: 30000 });
    client = createPublicClient({ transport, pollingInterval: 20 });
    if (await client.getChainId() !== 31337) throw new Error('fork test refuses any chain other than local 31337');
    rpc = (method, params = []) => client.request({ method, params });
    const info = await rpc('anvil_nodeInfo');
    if (!info.forkConfig?.forkUrl && !info.forkConfig?.forkBlockNumber) throw new Error('expected an Anvil mainnet fork, not an arbitrary local node');
    evidence.fork = { blockNumber: info.forkConfig.forkBlockNumber, blockHash: (await client.getBlock({ blockNumber: BigInt(info.forkConfig.forkBlockNumber) })).hash, clientVersion: await rpc('web3_clientVersion') };
    snapshot = await rpc('evm_snapshot');
    const accounts = await rpc('eth_accounts');
    if (accounts.length < 5) throw new Error('five local test accounts required');
    // Publicly known development addresses can have real mainnet code (including
    // delegated accounts). Clear that code only in our snapshotted local fixture.
    for (const account of accounts.slice(0, 5)) await rpc('anvil_setCode', [account, '0x']);
    [curator, alice, bob, hot, outsider] = accounts.slice(0, 5).map(account => createWalletClient({ account, transport }));
    evidence.runtimeCodeHashes = {};
    const upstream = JSON.parse(readFileSync(new URL('../deployments/ens-upstream-mainnet.json', import.meta.url), 'utf8'));
    for (const [key, address] of Object.entries(addresses)) {
      const code = await client.getCode({ address });
      if (!code || code === '0x') throw new Error(`fork has no deployed ${key}`);
      const artifact = Object.values(upstream.artifacts).find(item => item.address.toLowerCase() === address.toLowerCase());
      expect((code.length - 2) / 2).toBe(artifact.runtimeBytes);
      const normalized = Buffer.from(code.slice(2), 'hex');
      for (const { start, length } of artifact.immutableRanges) normalized.fill(0, start, start + length);
      expect(keccak256(normalized)).toBe(artifact.normalizedRuntimeCodeHash);
      evidence.runtimeCodeHashes[key] = keccak256(code);
    }
    const init = encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [[{ account: curator.account.address, roleBitmap: setParent | (registerAndRenew << 128n) }]] });
    registry = await deployProxy(addresses.registryImplementation, 0xd3a001n, init);
    const makeResolver = async (owner, salt, name) => deployProxy(addresses.resolverImplementation, salt,
      encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[{ account: owner.account.address, roleBitmap: setText | (setText << 128n) }], [encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns(name), 'derpc.endpoint', 'https://initial.example/rpc'] })]] }));
    resolverAlice = await makeResolver(alice, 0xd3a002n, 'alice.derpc.eth');
    resolverBob = await makeResolver(bob, 0xd3a003n, 'bob.derpc.eth');
    const compiled = compile()['OperatorRegistrar.sol'].OperatorRegistrar;
    registrarAbi = compiled.abi;
    const hash = await curator.deployContract({ abi: registrarAbi, bytecode: `0x${compiled.evm.bytecode.object}`, args: [registry, curator.account.address], chain: null, gas: 8_000_000n });
    registrar = (await localReceipt(hash)).contractAddress;
    await write(curator, registry, registryAbi, 'grantRootRoles', [registerAndRenew, registrar]);
    evidence.localAddresses = { registry, resolverAlice, resolverBob, registrar };
  }, 120000);

  afterAll(async () => {
    try { if (snapshot) await rpc('evm_revert', [snapshot]); }
    finally { if (process.env.DERPC_ENS_FORK_REPORT) writeFileSync(process.env.DERPC_ENS_FORK_REPORT, JSON.stringify(evidence, (_k, value) => typeof value === 'bigint' ? value.toString() : value, 2), { flag: 'wx' }); }
  }, 40000);

  it('attaches a genuine UserRegistry below derpc.eth using only the local impersonated owner', async () => {
    const state = await read(addresses.ethRegistry, registryAbi, 'getState', [labelHash('derpc')]);
    expect(state.status).toBe(2);
    await rpc('anvil_impersonateAccount', [state.latestOwner]);
    await rpc('anvil_setBalance', [state.latestOwner, '0x56bc75e2d63100000']);
    try {
      const owner = createWalletClient({ account: state.latestOwner, transport: http(forkRpc, { retryCount: 0 }) });
      await write(owner, addresses.ethRegistry, registryAbi, 'setSubregistry', [labelHash('derpc'), registry]);
      await write(curator, registry, registryAbi, 'setParent', [addresses.ethRegistry, 'derpc']);
      expect((await read(addresses.ethRegistry, registryAbi, 'getSubregistry', ['derpc'])).toLowerCase()).toBe(registry.toLowerCase());
      evidence.checks.push('UserRegistry factory provenance and parent/subregistry attachment');
    } finally { await rpc('anvil_stopImpersonatingAccount', [state.latestOwner]); }
  }, 60000);

  it('accepts zero registration roles and forbids owner transfer or resolver replacement', async () => {
    const expiry = Number((await client.getBlock()).timestamp) + 3600;
    await expect(write(curator, registrar, registrarAbi, 'register', ['alice', alice.account.address, resolverAlice, alice.account.address, expiry])).rejects.toThrow(/revert/i);
    await write(alice, registrar, registrarAbi, 'register', ['alice', alice.account.address, resolverAlice, alice.account.address, expiry]);
    await write(bob, registrar, registrarAbi, 'register', ['bob', bob.account.address, resolverBob, bob.account.address, expiry]);
    expect(await read(registry, registryAbi, 'hasRootRoles', [registerAndRenew, registrar])).toBe(true);
    expect(await read(registry, registryAbi, 'roles', [0n, registrar])).toBe(registerAndRenew);
    expect(await read(registry, registryAbi, 'roleCount', [0n])).toBe(setParent + (registerAndRenew << 128n) + registerAndRenew);
    const state = await read(registry, registryAbi, 'getState', [labelHash('alice')]);
    expect(state.status).toBe(2);
    expect(state.latestOwner.toLowerCase()).toBe(alice.account.address.toLowerCase());
    expect(await read(registry, registryAbi, 'roleCount', [labelHash('alice')])).toBe(0n);
    expect(await read(registry, registryAbi, 'roleCount', [state.resource])).toBe(0n);
    await expect(write(alice, registry, registryAbi, 'unsafeTransfer', [outsider.account.address, state.tokenId, '0x'])).rejects.toThrow(/revert/i);
    await expect(write(alice, registry, registryAbi, 'setResolver', [labelHash('alice'), resolverBob])).rejects.toThrow(/revert/i);
    evidence.checks.push('Operators register themselves; curator cannot mint for a different operator. Registrar register+renew root roles only; zero owner role bitmap accepted; transfer/resolver replacement refused');
  }, 60000);

  it('limits a hot key to the endpoint key on one dedicated resolver', async () => {
    const setter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns('alice.derpc.eth'), 'derpc.endpoint', ''] });
    await write(alice, resolverAlice, resolverAbi, 'grantSetterRoles', [setter, hot.account.address]);
    await write(hot, resolverAlice, resolverAbi, 'setText', [dns('alice.derpc.eth'), 'derpc.endpoint', 'https://rotated.example/rpc']);
    expect(await textRecord(resolverAlice, 'alice.derpc.eth', 'derpc.endpoint')).toBe('https://rotated.example/rpc');
    await expect(write(hot, resolverAlice, resolverAbi, 'setText', [dns('alice.derpc.eth'), 'derpc.payee', outsider.account.address])).rejects.toThrow(/revert/i);
    await expect(write(hot, resolverBob, resolverAbi, 'setText', [dns('bob.derpc.eth'), 'derpc.endpoint', 'https://attacker.example/rpc'])).rejects.toThrow(/revert/i);
    expect(await textRecord(resolverBob, 'bob.derpc.eth', 'derpc.endpoint')).toBe('https://initial.example/rpc');
    evidence.checks.push('grantSetterRoles authorizes endpoint rotation only, not payee writes or another operator resolver');
  }, 60000);

  it('renews, delists and reinstates through the registrar, stops resolving expired names, and gives an expired label to a new owner', async () => {
    const expiry = Number((await client.getBlock()).timestamp) + 7200;
    await write(alice, registrar, registrarAbi, 'renew', [0n, expiry]);
    expect((await read(registry, registryAbi, 'getState', [labelHash('alice')])).expiry).toBe(BigInt(expiry));
    // Removal names the operator, so it cannot hit another occupant of the slot.
    await expect(write(curator, registrar, registrarAbi, 'remove', [0n, bob.account.address, stringToHex('alice', { size: 32 })])).rejects.toThrow(/revert/i);
    await expect(write(curator, registrar, registrarAbi, 'remove', [0n, alice.account.address, stringToHex('bob', { size: 32 })])).rejects.toThrow(/revert/i);
    await write(curator, registrar, registrarAbi, 'remove', [0n, alice.account.address, stringToHex('alice', { size: 32 })]);
    expect((await read(registrar, registrarAbi, 'operators', [0n]))[3]).toBe(false);
    await expect(write(alice, registrar, registrarAbi, 'renew', [0n, expiry + 3600])).rejects.toThrow(/revert/i);
    // Delisting removes the provable pool entry immediately; the ENS name itself keeps its lease.
    expect((await read(registry, registryAbi, 'getResolver', ['alice'])).toLowerCase()).toBe(resolverAlice.toLowerCase());
    // Only the curator undoes a removal; the operator can then extend its running lease again.
    await expect(write(alice, registrar, registrarAbi, 'reinstate', [0n, alice.account.address, stringToHex('alice', { size: 32 })])).rejects.toThrow(/revert/i);
    await expect(write(curator, registrar, registrarAbi, 'reinstate', [0n, alice.account.address, stringToHex('bob', { size: 32 })])).rejects.toThrow(/revert/i);
    await write(curator, registrar, registrarAbi, 'reinstate', [0n, alice.account.address, stringToHex('alice', { size: 32 })]);
    await write(alice, registrar, registrarAbi, 'renew', [0n, expiry + 3600]);
    expect((await read(registry, registryAbi, 'getState', [labelHash('alice')])).expiry).toBe(BigInt(expiry + 3600));
    await rpc('evm_increaseTime', [10801]);
    await rpc('evm_mine');
    expect(await read(registry, registryAbi, 'getResolver', ['alice'])).toBe(zeroAddress);
    expect((await read(registry, registryAbi, 'getState', [labelHash('alice')])).status).toBe(0);
    evidence.checks.push('Authorized renewal, immediate registrar delisting naming the operator, curator-only reinstatement, revoked renewal refusal, and ENS expiry resolution removal');
    // A lapsed operator cannot renew itself. A new unblocked owner can register the expired label,
    // and the real registry accepts that self-registration while the old token still exists.
    const later = Number((await client.getBlock()).timestamp) + 3600;
    await expect(write(alice, registrar, registrarAbi, 'renew', [0n, later])).rejects.toThrow(/revert/i);
    await write(outsider, registrar, registrarAbi, 'register', ['alice', outsider.account.address, resolverAlice, outsider.account.address, later]);
    const reused = await read(registry, registryAbi, 'getState', [labelHash('alice')]);
    expect(reused.status).toBe(2); expect(reused.expiry).toBe(BigInt(later)); expect(reused.latestOwner.toLowerCase()).toBe(outsider.account.address.toLowerCase());
    const entry = await read(registrar, registrarAbi, 'operators', [0n]);
    expect(entry[1].toLowerCase()).toBe(outsider.account.address.toLowerCase()); expect(entry[3]).toBe(true);
    expect((await read(registry, registryAbi, 'getResolver', ['alice'])).toLowerCase()).toBe(resolverAlice.toLowerCase());
    await expect(write(alice, registrar, registrarAbi, 'setPayee', [0n, alice.account.address])).rejects.toThrow(/revert/i);
    evidence.checks.push('Lapsed operator cannot renew itself; an expired label is re-registered to a new owner through the registrar in the same slot, with the previous owner losing registrar rights');
  }, 60000);

  it('executes every planner stage locally and verifies genuine receipts and hot-key role history', async () => {
    // The previous scenario is isolated from this complete deployment workflow.
    expect(await rpc('evm_revert', [snapshot])).toBe(true);
    snapshot = await rpc('evm_snapshot');
    const ownerState = await read(addresses.ethRegistry, registryAbi, 'getState', [labelHash('derpc')]);
    for (const wallet of [curator, alice, bob, hot, outsider]) await rpc('anvil_setCode', [wallet.account.address, '0x']);
    await rpc('anvil_impersonateAccount', [ownerState.latestOwner]);
    await rpc('anvil_setBalance', [ownerState.latestOwner, '0x56bc75e2d63100000']);
    // The unmodified administrative planner/verifier intentionally require chain 1.
    // Changing this already-validated local Anvil fork's ID keeps those checks real.
    await rpc('anvil_setChainId', [1]);
    try {
      // Anvil's built-in signers retain their launch chain ID after setChainId.
      // Local impersonation avoids loading any signing keys for this scenario.
      for (const wallet of [curator, alice, bob, hot, outsider]) await rpc('anvil_impersonateAccount', [wallet.account.address]);
      const now = Number((await client.getBlock()).timestamp);
      let config = { schemaVersion: 1, chainId: 1, parentName: 'derpc.eth', curator: ownerState.latestOwner,
        deployer: curator.account.address, deploymentId: 'fork-planner-fixture',
        operators: [
          { label: 'alice', operator: alice.account.address, coldOwner: alice.account.address, hotKey: hot.account.address, signer: alice.account.address, payee: alice.account.address },
          { label: 'bob', operator: bob.account.address, coldOwner: bob.account.address, hotKey: outsider.account.address, signer: bob.account.address, payee: bob.account.address },
        ].map(op => ({ ...op, endpoint: `https://${op.label}.example/rpc`, expiry: now + 7200, caps: { chainId: 1, methods: ['eth_getProof', 'eth_getCode'] } })) };
      const build = registrarBuild(), stages = [];
      let finalPlan;
      for (let round = 0; round < 8; round++) {
        const plan = await preparePlan({ config, client, build });
        config = plan.resumeConfig;
        if (plan.status === 'state-matches-config') { finalPlan = plan; break; }
        expect(plan.transactions.length).toBeGreaterThan(0);
        const transactionHashes = [];
        for (const item of plan.transactions) {
          const tx = item.walletRequest.params[0];
          if (item.id.startsWith('register-')) {
            const op = config.operators.find(op => item.id === `register-${op.label}`);
            expect(tx.from.toLowerCase()).toBe(op.operator.toLowerCase());
            expect(tx.from.toLowerCase()).not.toBe(config.curator.toLowerCase());
            await expect(client.call({ account: config.curator, to: tx.to, data: tx.data })).rejects.toThrow(/revert/i);
          }
          const wallet = createWalletClient({ account: tx.from, transport: http(forkRpc, { retryCount: 0, timeout: 30000 }) });
          const hash = await wallet.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: 0n, gas: 8_000_000n, ...(tx.nonce ? { nonce: Number(BigInt(tx.nonce)) } : {}) });
          expect((await localReceipt(hash)).status).toBe('success');
          transactionHashes.push(hash);
        }
        stages.push({ plan: structuredClone(plan), transactionHashes });
      }
      expect(finalPlan?.status).toBe('state-matches-config');
      for (let block = 0; block < 12; block++) await rpc('evm_mine');
      const verified = await verifyDeployment({ config, stages, client, confirmations: 12, build });
      expect(verified.verification).toMatchObject({ receipts: true, canonicalBlocks: true, minimumConfirmations: 12, stateMatchesConfig: true, hotKeyEventAudit: true });
      evidence.planner = { stages: stages.map(({ plan }) => ({ stage: plan.stage, transactions: plan.transactions.map(item => item.id) })), verification: verified.verification };
      evidence.checks.push('Unmodified staged planner gas estimates, exact root/name role counts, canonical receipt verification with 12 local confirmations');

      const registrations = stages.find(stage => stage.plan.transactions.some(item => item.id === 'register-alice'));
      const registrationHash = registrations.transactionHashes[registrations.plan.transactions.findIndex(item => item.id === 'register-alice')];
      await expect(verifyDeployment({ config, stages, build, confirmations: 12, client: {
        ...client,
        getTransactionReceipt: async request => {
          const receipt = await client.getTransactionReceipt(request);
          return request.hash === registrationHash ? { ...receipt, from: config.curator } : receipt;
        },
      } })).rejects.toThrow(/Mined transaction differs from the reviewed wallet request/);
      evidence.checks.push('Registration requests and actual sends use distinct operator wallets; curator minting and a receipt claiming the curator as registration sender are refused');

      // Unknown text permissions evade a fixed known-key list; event auditing must reject them.
      const authoritySnapshot = await rpc('evm_snapshot');
      try {
        const extraSetter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns('alice.derpc.eth'), 'unlisted.permission', ''] });
        await write(alice, finalPlan.resolvers.alice, resolverAbi, 'grantSetterRoles', [extraSetter, hot.account.address]);
        await expect(verifyDeployment({ config, stages, client, confirmations: 12, build })).rejects.toThrow(/hot-key event audit/);
      } finally { expect(await rpc('evm_revert', [authoritySnapshot])).toBe(true); }
      evidence.checks.push('Deployment verifier rejects a genuine extra hot-key grant for an unknown text resource');
      evidence.lifecycle = await validateForkLifecycle({ manifest: verified, client, rpc, forkRpc, build, fork: evidence.fork });
      evidence.endpoints = await validateForkEndpoints({ config, stages, manifest: verified, client, rpc, forkRpc, build, fork: evidence.fork });
      await validateForkDiscovery(config, finalPlan, build);
      evidence.complete = true;
    } finally {
      await rpc('anvil_setChainId', [31337]);
      for (const wallet of [curator, alice, bob, hot, outsider]) await rpc('anvil_stopImpersonatingAccount', [wallet.account.address]);
      await rpc('anvil_stopImpersonatingAccount', [ownerState.latestOwner]);
    }
  }, 240000);

  it.skipIf(process.env.DERPC_ENS_TEAM_DEMO !== '1')('simulates the reviewed three-demo deployment and scoped hot keys without signing', async () => {
    evidence.complete = false;
    expect(await rpc('evm_revert', [snapshot])).toBe(true);
    snapshot = await rpc('evm_snapshot');
    await rpc('anvil_setChainId', [1]);
    try {
      evidence.teamDemo = await validateTeamDemoFork({ client, rpc, forkRpc, receipt: localReceipt, build: registrarBuild(), fork: evidence.fork });
      evidence.complete = true;
    } finally {
      await rpc('anvil_setChainId', [31337]);
    }
  }, 240000);
});
