import { keccak_256 } from "@noble/hashes/sha3";
import { bytesEqual, hexToBytes } from "./hex.ts";
import { decodeRlp, type RlpItem } from "./rlp.ts";

export class ProofVerificationError extends Error {
  override name = "ProofVerificationError";
}

/** keccak256(rlp("")): the root of an empty trie (accounts without storage). */
export const EMPTY_TRIE_ROOT = hexToBytes("0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");

/**
 * Walk a Merkle-Patricia proof from `root` along `key` (already hashed: these are secure tries).
 * Returns the leaf value, or null when the proof shows the key is absent. Throws when the proof
 * doesn't link to the root, is incomplete, or carries extra nodes.
 */
export function verifyMerkleProof(root: Uint8Array, key: Uint8Array, proof: Uint8Array[]): Uint8Array | null {
  if (proof.length === 0) {
    if (bytesEqual(root, EMPTY_TRIE_ROOT)) return null;
    throw new ProofVerificationError("empty proof for a non-empty trie");
  }

  const path = toNibbles(key);
  let pos = 0;
  let used = 0;
  let expectedHash: Uint8Array = root;
  let node: RlpItem | undefined;

  const finish = (value: Uint8Array | null) => {
    if (used !== proof.length) throw new ProofVerificationError("proof has extra nodes");
    return value;
  };

  for (;;) {
    if (node === undefined) {
      const raw = proof[used];
      if (raw === undefined) throw new ProofVerificationError("proof is incomplete");
      if (!bytesEqual(keccak_256(raw), expectedHash)) {
        throw new ProofVerificationError(`proof node ${used} does not match the expected hash`);
      }
      used++;
      node = decodeRlp(raw);
    }
    if (!Array.isArray(node)) throw new ProofVerificationError("trie node is not a list");

    let next: RlpItem;
    if (node.length === 17) {
      if (pos === path.length) {
        const value = asBytes(node[16]!);
        return finish(value.length > 0 ? value : null);
      }
      next = node[path[pos]!]!;
      pos++;
    } else if (node.length === 2) {
      const { nibbles, isLeaf } = decodeHexPrefix(asBytes(node[0]!));
      const rest = path.slice(pos);
      if (isLeaf) return finish(sameNibbles(rest, nibbles) ? asBytes(node[1]!) : null);
      if (!startsWith(rest, nibbles)) return finish(null);
      pos += nibbles.length;
      next = node[1]!;
    } else {
      throw new ProofVerificationError(`trie node has ${node.length} items`);
    }

    if (Array.isArray(next)) {
      node = next; // embedded child (its RLP is shorter than 32 bytes): no separate hash
      continue;
    }
    if (next.length === 0) return finish(null); // empty branch slot: the key is absent
    if (next.length !== 32) throw new ProofVerificationError("child reference is neither embedded nor a 32-byte hash");
    expectedHash = next;
    node = undefined;
  }
}

function asBytes(item: RlpItem): Uint8Array {
  if (Array.isArray(item)) throw new ProofVerificationError("expected bytes, found a list");
  return item;
}

function toNibbles(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of bytes) out.push(b >> 4, b & 0x0f);
  return out;
}

function decodeHexPrefix(encoded: Uint8Array): { nibbles: number[]; isLeaf: boolean } {
  const nibbles = toNibbles(encoded);
  const flag = nibbles[0];
  if (flag === undefined || flag > 3) throw new ProofVerificationError("invalid hex-prefix flag");
  const odd = (flag & 1) === 1;
  if (!odd && nibbles[1] !== 0) throw new ProofVerificationError("invalid hex-prefix padding");
  return { nibbles: nibbles.slice(odd ? 1 : 2), isLeaf: flag >= 2 };
}

function startsWith(path: number[], prefix: number[]): boolean {
  return prefix.length <= path.length && prefix.every((n, i) => path[i] === n);
}

function sameNibbles(a: number[], b: number[]): boolean {
  return a.length === b.length && startsWith(a, b);
}
