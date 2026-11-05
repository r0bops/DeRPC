export type Hex = `0x${string}`;

export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError(`invalid hex: ${hex.slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Left-pad to `length` bytes (storage slot keys are hashed as 32-byte words). */
export function leftPad(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length > length) throw new RangeError(`value longer than ${length} bytes`);
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

/** Accepts quantity hex like "0x0" or "0x1a" (eth_getProof returns slot keys and values unpadded). */
export function quantityToBigInt(hex: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new TypeError(`invalid quantity: ${hex.slice(0, 20)}`);
  return BigInt(hex);
}
