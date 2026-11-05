/** Recursive Length Prefix decoding (Ethereum yellow paper, appendix B). Strict: no trailing bytes,
 * no non-canonical length prefixes. */
export type RlpItem = Uint8Array | RlpItem[];

export class RlpError extends Error {
  override name = "RlpError";
}

export function decodeRlp(input: Uint8Array): RlpItem {
  const [item, end] = decodeAt(input, 0);
  if (end !== input.length) throw new RlpError("trailing bytes after RLP item");
  return item;
}

function decodeAt(b: Uint8Array, pos: number): [RlpItem, number] {
  const prefix = b[pos];
  if (prefix === undefined) throw new RlpError("unexpected end of input");

  if (prefix < 0x80) return [b.subarray(pos, pos + 1), pos + 1];

  if (prefix <= 0xb7) {
    const length = prefix - 0x80;
    const start = pos + 1;
    const end = checkedEnd(b, start, length);
    if (length === 1 && b[start]! < 0x80) throw new RlpError("single byte below 0x80 must not be prefixed");
    return [b.subarray(start, end), end];
  }

  if (prefix <= 0xbf) {
    const lengthOfLength = prefix - 0xb7;
    const length = readLength(b, pos + 1, lengthOfLength);
    const start = pos + 1 + lengthOfLength;
    return [b.subarray(start, checkedEnd(b, start, length)), start + length];
  }

  let start: number;
  let length: number;
  if (prefix <= 0xf7) {
    length = prefix - 0xc0;
    start = pos + 1;
  } else {
    const lengthOfLength = prefix - 0xf7;
    length = readLength(b, pos + 1, lengthOfLength);
    start = pos + 1 + lengthOfLength;
  }
  const end = checkedEnd(b, start, length);
  const items: RlpItem[] = [];
  let cursor = start;
  while (cursor < end) {
    const [item, next] = decodeAt(b.subarray(0, end), cursor);
    items.push(item);
    cursor = next;
  }
  return [items, end];
}

function readLength(b: Uint8Array, pos: number, lengthOfLength: number): number {
  if (lengthOfLength > 4) throw new RlpError("RLP length too large");
  if (b[pos] === 0) throw new RlpError("non-canonical length (leading zero)");
  let length = 0;
  for (let i = 0; i < lengthOfLength; i++) {
    const byte = b[pos + i];
    if (byte === undefined) throw new RlpError("unexpected end of input in length");
    length = length * 256 + byte;
  }
  if (length < 56) throw new RlpError("non-canonical length (long form for short item)");
  return length;
}

function checkedEnd(b: Uint8Array, start: number, length: number): number {
  const end = start + length;
  if (end > b.length) throw new RlpError("RLP item runs past the end of input");
  return end;
}
