// Public evidence checks shared by the website and the local wallet review service.
import { addresses, json, sameAddress } from './ens-common.mjs';
const clone = value => JSON.parse(json(value));
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

export function directoryPins(manifest) {
  if (manifest?.kind !== 'derpc-ens-deployment' || manifest.chainId !== 1 || manifest.localOnly !== false ||
      !['receipts', 'canonicalBlocks', 'stateMatchesConfig', 'hotKeyEventAudit'].every(key => manifest.verification?.[key] === true) ||
      !Number.isSafeInteger(manifest.verification.minimumConfirmations) || manifest.verification.minimumConfirmations < 12) throw new Error('A public receipt-checked ENS manifest with twelve confirmations is required');
  const pins = { chainId: 1, ethRegistry: manifest.upstream?.ETHRegistry?.address,
    registrar: { address: manifest.registrar?.address, codeHash: manifest.registrar?.codeHash, registry: manifest.subregistry } };
  if (![pins.ethRegistry, pins.registrar.address, pins.registrar.registry].every(value => /^0x[0-9a-fA-F]{40}$/.test(value ?? '') && !/^0x0+$/i.test(value)) ||
      !hashPattern.test(pins.registrar.codeHash ?? '') || /^0x0+$/i.test(pins.registrar.codeHash) || !sameAddress(pins.ethRegistry, addresses.ETHRegistry)) throw new Error('Manifest has invalid mainnet directory pins');
  return pins;
}

/** Public administrative reads only. There is deliberately no wallet or send RPC here. */
export async function checkSubmittedTransaction(client, item, hash, reviewBlock) {
  if (!hashPattern.test(hash)) throw new Error('Expected a transaction hash');
  if (await client.getChainId() !== 1) throw new Error('Administrative RPC is not Ethereum mainnet');
  let tx;
  try { tx = await client.getTransaction({ hash }); }
  catch (error) { if (error.name === 'TransactionNotFoundError') return null; throw error; }
  const expected = item.walletRequest.params[0];
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || !sameAddress(tx.from, expected.from) ||
      (expected.to ? !sameAddress(tx.to, expected.to) : tx.to !== null) || tx.input.toLowerCase() !== expected.data.toLowerCase() ||
      tx.value !== 0n || tx.chainId !== 1 || expected.nonce !== undefined && BigInt(tx.nonce) !== BigInt(expected.nonce)) {
    throw new Error('Transaction does not match the reviewed sender, destination, calldata, value, network or nonce');
  }
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error.name === 'TransactionReceiptNotFoundError') return null; throw error; }
  if (receipt.status !== 'success') throw new Error('Transaction reverted. Resolve its receipt before attempting a replacement');
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || !sameAddress(receipt.from, expected.from) ||
      receipt.blockNumber <= BigInt(reviewBlock) || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber ||
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Transaction receipt is not canonical or does not follow the review block');
  return clone({ hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
}

