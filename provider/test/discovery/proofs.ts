// Synthetic Merkle-Patricia fixtures. Production verification is never mocked.
import { keccak256, toHex, toRlp, type Hex } from "viem";
import type { AccountProof, StorageProofEntry } from "../../src/verify/index.ts";

type Node = Hex | Node[];
type Entry = { key: string; value: Hex };
const raw = (n: bigint): Hex => n === 0n ? "0x" : toHex(n);
const word = (n: bigint) => toHex(n, { size: 32 });
const rlp = (node: Node): Hex => toRlp(node as never);
const compact = (path: string, leaf: boolean): Hex => {
  const flag = leaf ? 2 : 0;
  return `0x${path.length % 2 ? (flag + 1).toString(16) + path : flag.toString(16) + "0" + path}`;
};
function trie(entries: Entry[]): { root: Hex; proof(key: Hex): Hex[] } {
  const byHash = new Map<Hex, Node[]>();
  const reference = (node: Node[]): Node => {
    const encoded = rlp(node), hash = keccak256(encoded);
    byHash.set(hash, node);
    return encoded.length < 66 ? node : hash;
  };
  function build(items: Entry[], offset: number): Node[] {
    if (items.length === 1) return [compact(items[0]!.key.slice(offset), true), items[0]!.value];
    let common = offset;
    while (common < 64 && items.every(item => item.key[common] === items[0]!.key[common])) common++;
    if (common > offset) return [compact(items[0]!.key.slice(offset, common), false), reference(build(items, common))];
    const branch: Node[] = Array.from({ length: 17 }, () => "0x" as Hex);
    for (let digit = 0; digit < 16; digit++) {
      const selected = items.filter(item => item.key[offset] === digit.toString(16));
      if (selected.length) branch[digit] = reference(build(selected, offset + 1));
    }
    return branch;
  }
  const rootNode = build(entries, 0), root = keccak256(rlp(rootNode));
  byHash.set(root, rootNode);
  function proof(key: Hex): Hex[] {
    const path = key.slice(2), result: Hex[] = [];
    let node = rootNode, offset = 0, hashed = true;
    for (;;) {
      if (hashed) result.push(rlp(node));
      let next: Node;
      if (node.length === 17) next = node[parseInt(path[offset++]!, 16)]!;
      else {
        const encodedPath = (node[0] as Hex).slice(2), flag = parseInt(encodedPath[0]!, 16);
        if (flag >= 2) break;
        offset += encodedPath.length - (flag & 1 ? 1 : 2);
        next = node[1]!;
      }
      if (next === "0x") break;
      hashed = !Array.isArray(next);
      node = Array.isArray(next) ? next : byHash.get(next)!;
      if (!node) throw new Error("fixture missing node");
    }
    return result;
  }
  return { root, proof };
}

export function registrarProofs(entries: { label: string; owner: Hex; expiry: number; active: boolean; payee: Hex }[], options: { count?: bigint; malformed?: Map<bigint, bigint>; bootstrap?: Hex } = {}) {
  const address = ("0x" + "45".repeat(20)) as Hex;
  const codeHash = keccak256("0x60006000f3"), base = BigInt(keccak256(word(0n)));
  const storage = new Map<bigint, bigint>([[0n, options.count ?? BigInt(entries.length)]]);
  for (const [i, entry] of entries.entries()) {
    storage.set(base + BigInt(i * 3), BigInt(toHex(entry.label, { size: 32 })));
    storage.set(base + BigInt(i * 3 + 1), BigInt(entry.owner) | BigInt(entry.expiry) << 160n | BigInt(entry.active ? 1 : 0) << 224n);
    storage.set(base + BigInt(i * 3 + 2), BigInt(entry.payee));
  }
  for (const [key, value] of options.malformed ?? []) storage.set(key, value);
  const storageTrie = trie([...storage].map(([key, value]) => ({ key: keccak256(word(key)).slice(2), value: rlp(raw(value)) })));
  const accountValue = rlp(["0x01", "0x", storageTrie.root, codeHash]);
  const bootstrapStorage = trie([{ key: keccak256(word(1n)).slice(2), value: rlp("0x01") }]);
  const accounts = trie([
    { key: keccak256(address).slice(2), value: accountValue },
    ...(options.bootstrap ? [{ key: keccak256(options.bootstrap).slice(2), value: rlp(["0x01", "0x", bootstrapStorage.root, codeHash]) }] : []),
  ]);
  const proof = (slots: Hex[]): AccountProof => ({
    address, balance: "0x0", nonce: "0x1", codeHash, storageHash: storageTrie.root,
    accountProof: accounts.proof(keccak256(address)),
    storageProof: slots.map(key => ({ key, value: toHex(storage.get(BigInt(key)) ?? 0n), proof: storageTrie.proof(keccak256(word(BigInt(key)))) }) as StorageProofEntry),
  });
  const bootstrapProof: AccountProof | undefined = options.bootstrap ? {
    address: options.bootstrap, balance: "0x0", nonce: "0x1", codeHash, storageHash: bootstrapStorage.root,
    accountProof: accounts.proof(keccak256(options.bootstrap)),
    storageProof: [{ key: "0x1", value: "0x1", proof: bootstrapStorage.proof(keccak256(word(1n))) }],
  } : undefined;
  return { address, codeHash, stateRoot: accounts.root, base, proof, bootstrapProof };
}
