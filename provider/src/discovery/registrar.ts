import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, type Hex } from "../verify/hex.ts";
import { verifyAccountProof, verifyStorageProof, type AccountProof } from "../verify/index.ts";
import type { HeaderView, JsonRpcSend, VerifiedValue } from "../verify/reader.ts";

export interface RegistrarPin {
  address: Hex;
  codeHash: Hex;
  /** Deployment binding: a discovery response cannot silently substitute another subregistry. */
  registry?: Hex;
}
export interface ProvenOperator { label: string; operator: Hex; payee: Hex; expiry: number }

/** Authenticate our registrar's fixed layout, never a layout guessed from an upgradeable ENS resolver. */
export async function readProvenOperators(options: {
  headers: HeaderView;
  send: JsonRpcSend;
  registrar: RegistrarPin;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<VerifiedValue<ProvenOperator[]>> {
  const { headers, send, registrar } = options;
  if (!/^0x[\da-fA-F]{40}$/.test(registrar.address) || BigInt(registrar.address) === 0n || !/^0x[\da-fA-F]{64}$/.test(registrar.codeHash) || registrar.registry !== undefined && (!/^0x[\da-fA-F]{40}$/.test(registrar.registry) || BigInt(registrar.registry) === 0n)) throw new Error("invalid registrar deployment pin");
  const block = headers.finalized();
  const blockTag = `0x${block.blockNumber.toString(16)}`;
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  const address = (n: bigint) => `0x${(n & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}` as Hex;
  async function slots(keys: Hex[]): Promise<bigint[]> {
    options.signal?.throwIfAborted();
    headers.assertFresh?.(block);
    const proof = await send("eth_getProof", [registrar.address, keys, blockTag], { isolationKey: "derpc:operator-discovery", signal: options.signal }) as AccountProof;
    const account = verifyAccountProof({ stateRoot: block.stateRoot, address: registrar.address, proof });
    if (!account.exists || account.codeHash.toLowerCase() !== registrar.codeHash.toLowerCase()) throw new Error("registrar runtime does not match its trusted pin");
    if (!Array.isArray(proof.storageProof) || proof.storageProof.length !== keys.length) throw new Error("incomplete registrar storage proof");
    return keys.map((slot, i) => verifyStorageProof({ storageRoot: account.storageRoot, slot, proof: proof.storageProof[i]! }));
  }
  const [length] = await slots([word(0n)]);
  if (length! > 128n) throw new Error("registrar list exceeds its protocol limit");
  const base = BigInt(bytesToHex(keccak_256(hexToBytes(word(0n)))));
  const keys = Array.from({ length: Number(length!) * 3 }, (_, i) => word(base + BigInt(i)));
  const values: bigint[] = [];
  // Match the wrapper's 32-slot maximum; each request uses the same authenticated block.
  for (let i = 0; i < keys.length; i += 32) values.push(...await slots(keys.slice(i, i + 32)));
  const result: ProvenOperator[] = [];
  const timestamp = Math.floor((options.now ?? Date.now)() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("invalid discovery clock");
  const now = Math.max(block.timestamp, timestamp);
  const labels = new Set<string>();
  for (let i = 0; i < values.length; i += 3) {
    const labelBytes = hexToBytes(word(values[i]!));
    const end = labelBytes.indexOf(0);
    if (end < 1 || end > 31 || labelBytes.slice(end).some(b => b !== 0)) throw new Error("invalid registrar label");
    const label = new TextDecoder("utf-8", { fatal: true }).decode(labelBytes.slice(0, end));
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) throw new Error("invalid registrar label");
    if (labels.has(label)) throw new Error("duplicate registrar label");
    labels.add(label);
    const packed = values[i + 1]!;
    const expiry = Number((packed >> 160n) & ((1n << 64n) - 1n));
    const active = packed >> 224n;
    if (active > 1n || !Number.isSafeInteger(expiry) || values[i + 2]! >> 160n) throw new Error("invalid registrar entry");
    if (active === 0n || expiry <= now) continue;
    const operator = address(packed), payee = address(values[i + 2]!);
    if (BigInt(operator) === 0n || BigInt(payee) === 0n) throw new Error("zero operator or payee");
    result.push({ label, operator, payee, expiry });
  }
  headers.assertFresh?.(block);
  options.signal?.throwIfAborted();
  return { value: result, block };
}
