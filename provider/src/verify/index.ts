import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToBigInt, bytesToHex, hexToBytes, leftPad, quantityToBigInt, type Hex } from "./hex.ts";
import { EMPTY_TRIE_ROOT, ProofVerificationError, verifyMerkleProof } from "./mpt.ts";
import { decodeRlp } from "./rlp.ts";

export { ProofVerificationError, EMPTY_TRIE_ROOT } from "./mpt.ts";
export type { Hex } from "./hex.ts";

/** keccak256 of empty code. */
export const EMPTY_CODE_HASH: Hex = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/** One entry of an eth_getProof `storageProof` array (EIP-1186). */
export interface StorageProofEntry {
  key: Hex;
  value: Hex;
  proof: Hex[];
}

/** An eth_getProof response (EIP-1186). Everything in it is a claim until verified. */
export interface AccountProof {
  address: Hex;
  balance: Hex;
  nonce: Hex;
  codeHash: Hex;
  storageHash: Hex;
  accountProof: Hex[];
  storageProof: StorageProofEntry[];
}

export interface VerifiedAccount {
  exists: boolean;
  nonce: bigint;
  balance: bigint;
  storageRoot: Hex;
  codeHash: Hex;
}

/**
 * Verify an account proof against a trusted state root. Values are derived from the proof; the
 * response's own fields must match them, or the response is rejected.
 */
export function verifyAccountProof(args: { stateRoot: Hex; address: Hex; proof: AccountProof }): VerifiedAccount {
  const { stateRoot, address, proof } = args;
  const addressBytes = hexToBytes(address);
  if (addressBytes.length !== 20) throw new ProofVerificationError("requested address is not 20 bytes");
  if (proof.address.toLowerCase() !== address.toLowerCase()) {
    throw new ProofVerificationError(`proof is for ${proof.address}, not the requested ${address}`);
  }

  const leaf = verifyMerkleProof(hexToBytes(stateRoot), keccak_256(addressBytes), proof.accountProof.map(hexToBytes));
  const account = leaf === null ? absentAccount() : decodeAccount(leaf);

  mustEqual("balance", quantityToBigInt(proof.balance), account.balance);
  mustEqual("nonce", quantityToBigInt(proof.nonce), account.nonce);
  if (account.exists) {
    mustEqual("storageHash", proof.storageHash.toLowerCase(), account.storageRoot);
    mustEqual("codeHash", proof.codeHash.toLowerCase(), account.codeHash);
  } else {
    // Clients report absent accounts' hashes as zero or as the empty values; both mean "nothing".
    mustBeOneOf("storageHash", proof.storageHash.toLowerCase(), [ZERO_HASH, bytesToHex(EMPTY_TRIE_ROOT)]);
    mustBeOneOf("codeHash", proof.codeHash.toLowerCase(), [ZERO_HASH, EMPTY_CODE_HASH]);
  }
  return account;
}

/** Verify one storage slot against the account's verified storage root. Absent slots are zero. */
export function verifyStorageProof(args: { storageRoot: Hex; slot: Hex; proof: StorageProofEntry }): bigint {
  const { storageRoot, slot, proof } = args;
  if (quantityToBigInt(proof.key) !== quantityToBigInt(slot)) {
    throw new ProofVerificationError(`storage proof is for slot ${proof.key}, not the requested ${slot}`);
  }
  const slotKey = keccak_256(leftPad(hexToBytes(normalizeSlot(slot)), 32));
  const leaf = verifyMerkleProof(hexToBytes(storageRoot), slotKey, proof.proof.map(hexToBytes));
  let value = 0n;
  if (leaf !== null) {
    const decoded = decodeRlp(leaf);
    if (Array.isArray(decoded)) throw new ProofVerificationError("storage value is not a byte string");
    value = bytesToBigInt(decoded);
  }
  mustEqual("storage value", quantityToBigInt(proof.value), value);
  return value;
}

/** Verify contract code against the account's verified code hash. */
export function verifyCode(args: { codeHash: Hex; code: Hex }): void {
  const actual = bytesToHex(keccak_256(hexToBytes(args.code)));
  if (actual !== args.codeHash.toLowerCase()) throw new ProofVerificationError("code does not match the proven code hash");
}

function absentAccount(): VerifiedAccount {
  return { exists: false, nonce: 0n, balance: 0n, storageRoot: bytesToHex(EMPTY_TRIE_ROOT), codeHash: EMPTY_CODE_HASH };
}

function decodeAccount(leaf: Uint8Array): VerifiedAccount {
  const fields = decodeRlp(leaf);
  if (!Array.isArray(fields) || fields.length !== 4 || fields.some(Array.isArray)) {
    throw new ProofVerificationError("account leaf is not [nonce, balance, storageRoot, codeHash]");
  }
  const [nonce, balance, storageRoot, codeHash] = fields as Uint8Array[];
  if (storageRoot!.length !== 32 || codeHash!.length !== 32) throw new ProofVerificationError("account hashes are not 32 bytes");
  return { exists: true, nonce: bytesToBigInt(nonce!), balance: bytesToBigInt(balance!), storageRoot: bytesToHex(storageRoot!), codeHash: bytesToHex(codeHash!) };
}

function normalizeSlot(slot: Hex): Hex {
  const digits = slot.slice(2);
  return (digits.length % 2 === 0 ? slot : `0x0${digits}`) as Hex;
}

function mustEqual<T>(field: string, claimed: T, proven: T): void {
  if (claimed !== proven) throw new ProofVerificationError(`claimed ${field} ${String(claimed)} differs from the proven ${String(proven)}`);
}

function mustBeOneOf(field: string, claimed: string, allowed: string[]): void {
  if (!allowed.includes(claimed)) throw new ProofVerificationError(`claimed ${field} ${claimed} for an account that does not exist`);
}

