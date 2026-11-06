import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, getContractAddress, http, isAddress, keccak256, stringToHex, toHex } from 'viem';
import solc from 'solc';
import { compile } from './compile.mjs';

export const TEST_PAYMENT_CHAINS = new Map([[11155111, 'Sepolia'], [560048, 'Hoodi']]);
const LOCAL_CHAINS = new Set([1337, 31337]);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HASH = /^0x[\da-fA-F]{64}$/;

export function escrowBuild() {
  const artifact = compile()['QueryEscrow.sol'].QueryEscrow;
  const creationBytecode = `0x${artifact.evm.bytecode.object}`;
  const runtimeBytecode = `0x${artifact.evm.deployedBytecode.object}`;
  if (creationBytecode === '0x' || runtimeBytecode === '0x') throw new Error('QueryEscrow did not compile to deployable bytecode');
  return {
    artifact,
    creationBytecode,
    runtimeBytecode,
    creationCodeHash: keccak256(creationBytecode),
    codeHash: keccak256(runtimeBytecode),
    sourceHash: keccak256(stringToHex(readFileSync(`${ROOT}/src/QueryEscrow.sol`, 'utf8'))),
    compiler: { version: solc.version(), evmVersion: 'shanghai', optimizerRuns: 200 },
  };
}

function assertChain(chainId, local) {
  if (!Number.isSafeInteger(chainId) || !(local ? LOCAL_CHAINS.has(chainId) : TEST_PAYMENT_CHAINS.has(chainId))) {
    throw new Error('payment deployment supports Sepolia/Hoodi test funds only; --local permits only chain 1337 or 31337');
  }
}

export function administrativeClient(url, local = false) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid administrative RPC URL');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  if (local && !loopback) throw new Error('--local requires a loopback RPC endpoint');
  if (!loopback && parsed.protocol !== 'https:') throw new Error('remote administrative RPC must use HTTPS');
  return createPublicClient({ transport: http(url, { retryCount: 0, timeout: 15_000 }) });
}

/** No wallet, signing key or transaction submission exists in this module. */
export async function prepareDeployment({ chainId, from, client, local = false, build = escrowBuild(), now = () => new Date().toISOString() }) {
  assertChain(chainId, local);
  if (typeof from !== 'string' || !isAddress(from) || /^0x0{40}$/i.test(from)) throw new Error('supply the deploying wallet address with --from');
  const transaction = { from: getAddress(from), data: build.creationBytecode, value: '0x0', chainId: toHex(chainId) };
  const plan = {
    schemaVersion: 1,
    kind: 'derpc-query-escrow-deployment-plan',
    testPayments: true,
    localOnly: local,
    chainId,
    name: TEST_PAYMENT_CHAINS.get(chainId) ?? 'Local development',
    createdAt: now(),
    compiler: build.compiler,
    sourceHash: build.sourceHash,
    creationCodeHash: build.creationCodeHash,
    codeHash: build.codeHash,
    walletRequest: { method: 'eth_sendTransaction', params: [transaction] },
    review: [
      'Contract creation, zero transferred value, no constructor arguments.',
      'Test funds only. Review the exact bytecode/source and wallet network before sending.',
      'The script never signs or submits this request. A wallet owner sends it after review.',
    ],
  };
  if (client) {
    if (await client.getChainId() !== chainId) throw new Error('administrative RPC chain does not match the requested chain');
    const [gas, gasPrice, balance, block] = await Promise.all([
      client.estimateGas({ account: transaction.from, data: transaction.data, value: 0n }),
      client.getGasPrice(), client.getBalance({ address: transaction.from }), client.getBlock(),
    ]);
    plan.preflight = {
      checkedAt: now(), blockNumber: block.number.toString(), blockHash: block.hash,
      estimatedGas: gas.toString(), sampledGasPriceWei: gasPrice.toString(),
      sampledFeeWei: (gas * gasPrice).toString(), walletBalanceWei: balance.toString(),
      hasBalanceAtSampledGasPrice: balance >= gas * gasPrice,
      trust: 'administrative RPC observations; not light-client verified',
    };
  }
  return plan;
}

export function validatePlan(plan, build, local = false) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'derpc-query-escrow-deployment-plan' || plan.testPayments !== true) throw new Error('invalid deployment plan');
  assertChain(plan.chainId, local);
  if (plan.localOnly !== local) throw new Error('local and public-testnet plans cannot be mixed');
  if (plan.sourceHash !== build.sourceHash || plan.creationCodeHash !== build.creationCodeHash || plan.codeHash !== build.codeHash || JSON.stringify(plan.compiler) !== JSON.stringify(build.compiler)) {
    throw new Error('compiled source differs from the reviewed plan; regenerate and review a new plan');
  }
  const tx = plan.walletRequest?.params?.[0];
  if (plan.walletRequest?.method !== 'eth_sendTransaction' || plan.walletRequest.params.length !== 1 || !tx || !isAddress(tx.from) || tx.to != null || tx.data !== build.creationBytecode || tx.value !== '0x0' || tx.chainId !== toHex(plan.chainId)) throw new Error('deployment transaction differs from the reviewed plan');
  return tx;
}

/** Rejects missing/reverted/noncanonical/wrong-code transactions; only then exports a deployment. */
export async function verifyDeployment({ plan, transactionHash, client, confirmations = 12, local = false, build = escrowBuild(), now = () => new Date().toISOString() }) {
  const expected = validatePlan(plan, build, local);
  if (!HASH.test(transactionHash)) throw new Error('expected a 32-byte deployment transaction hash');
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('confirmations must be a positive integer');
  if (await client.getChainId() !== plan.chainId) throw new Error('administrative RPC chain does not match the deployment plan');
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: transactionHash }), client.getTransaction({ hash: transactionHash }),
  ]);
  if (receipt.status !== 'success' || !receipt.contractAddress || !isAddress(receipt.contractAddress)) throw new Error('deployment has no successful contract-creation receipt');
  if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || transaction.hash.toLowerCase() !== transactionHash.toLowerCase()) throw new Error('transaction hash mismatch');
  if (transaction.to !== null || transaction.from.toLowerCase() !== expected.from.toLowerCase() || receipt.from.toLowerCase() !== expected.from.toLowerCase() || transaction.value !== 0n || transaction.input !== build.creationBytecode) throw new Error('mined creation transaction differs from the reviewed wallet request');
  if (getContractAddress({ from: transaction.from, nonce: BigInt(transaction.nonce) }).toLowerCase() !== receipt.contractAddress.toLowerCase()) throw new Error('receipt contract address is not derived from the creation transaction');
  if (transaction.chainId !== undefined && transaction.chainId !== plan.chainId) throw new Error('mined transaction chain mismatch');
  if (transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber) throw new Error('transaction and receipt block mismatch');
  const [block, latest, atCreation, currentCode] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 }),
    client.getBytecode({ address: receipt.contractAddress, blockNumber: receipt.blockNumber }),
    client.getBytecode({ address: receipt.contractAddress }),
  ]);
  if (block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) throw new Error('receipt block is no longer canonical');
  const observedConfirmations = latest - receipt.blockNumber + 1n;
  if (observedConfirmations < BigInt(confirmations)) throw new Error(`deployment needs ${confirmations} confirmations; observed ${observedConfirmations}`);
  if (atCreation !== build.runtimeBytecode || currentCode !== build.runtimeBytecode) throw new Error('deployed runtime differs from the reviewed compilation');
  let finalized = false;
  try { finalized = (await client.getBlock({ blockTag: 'finalized' })).number >= receipt.blockNumber; } catch { /* Some local/admin RPCs do not implement this tag. */ }
  return {
    schemaVersion: 1,
    kind: 'derpc-query-escrow',
    testPayments: true,
    localOnly: local,
    chainId: plan.chainId,
    name: plan.name,
    asset: { symbol: 'ETH', decimals: 18 },
    escrow: getAddress(receipt.contractAddress),
    codeHash: build.codeHash,
    creationCodeHash: build.creationCodeHash,
    sourceHash: build.sourceHash,
    compiler: build.compiler,
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    deployer: getAddress(transaction.from),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
    transactionFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    verifiedAt: now(),
    verification: { receipt: true, creationInput: true, runtimeCode: true, confirmations: observedConfirmations.toString(), requiredConfirmations: confirmations, finalized },
    rpcTrust: 'administrative RPC; not light-client verified',
  };
}

function argumentsOf(argv) {
  const command = argv[0];
  if (!['prepare', 'verify'].includes(command)) throw new Error('usage: payment-deploy.mjs prepare --chain-id 560048 --from <wallet> --out <plan.json> [--rpc <url>] | verify --plan <plan.json> --tx <hash> --rpc <url> --out <manifest.json> [--confirmations 12]; local tests add --local');
  const values = { command, local: false };
  const supported = new Set(['chain-id', 'from', 'out', 'rpc', 'plan', 'tx', 'confirmations']);
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--local') { if (values.local) throw new Error('duplicate --local'); values.local = true; continue; }
    if (!key?.startsWith('--') || !supported.has(key.slice(2)) || values[key.slice(2)] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('unknown, duplicate or missing argument');
    values[key.slice(2)] = argv[++i];
  }
  if (!values.out) throw new Error('--out is required');
  return values;
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  const client = args.rpc ? administrativeClient(args.rpc, args.local) : undefined;
  let result;
  if (args.command === 'prepare') result = await prepareDeployment({ chainId: Number(args['chain-id']), from: args.from, client, local: args.local });
  else {
    if (!client || !args.plan || !args.tx) throw new Error('verify requires --rpc, --plan and --tx');
    result = await verifyDeployment({ plan: JSON.parse(readFileSync(args.plan, 'utf8')), transactionHash: args.tx, client, local: args.local, confirmations: Number(args.confirmations ?? 12) });
  }
  // Refuse accidental overwrite of an earlier reviewed plan or deployment record.
  writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(`${args.command === 'prepare' ? 'Unsigned deployment plan' : 'Receipt-checked deployment manifest'} written to ${args.out}. No transaction was sent.`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  // RPC errors may embed credential-bearing URLs. Avoid printing raw provider messages.
  console.error(error.name === 'Error' ? error.message : 'Deployment preflight/verification failed; check the configured RPC and transaction.');
  process.exitCode = 1;
});
