import { describe, expect, it } from "vitest";
import { MAX_ENDPOINT_RECORD_BYTES, MAX_OPERATOR_ENDPOINTS, parseOperatorEndpoints, serializeOperatorEndpoints } from "../../src/operators/endpoints.ts";

const entry = { id: "node-a", url: "https://rpc.example/", beaconUrl: "https://beacon.example/" };
const record = (endpoints: unknown, extra = {}) => JSON.stringify({ version: 1, endpoints, ...extra });

describe("bounded plural operator endpoint records", () => {
  it("canonicalizes URLs consistently for deployment and discovery without mutating inputs", () => {
    const source = [{ id: "node-a", url: "https://RPC.EXAMPLE:443", beaconUrl: "https://BEACON.EXAMPLE:443/a/../" }];
    const before = structuredClone(source);
    const encoded = serializeOperatorEndpoints(source);
    expect(encoded).toBe(record([entry]));
    expect(parseOperatorEndpoints(encoded)).toEqual([entry]);
    expect(source).toEqual(before);
  });

  it.each([
    "", " ", "null", "[]", "{}", record([]), record([entry], { version: 2 }),
    record([entry], { ignored: true }), record([{ ...entry, ignored: true }]),
    record([{ url: entry.url }]), record([{ ...entry, id: "A" }]), record([{ ...entry, id: "-a" }]),
    record([{ ...entry, id: "a-" }]), record([{ ...entry, id: "a".repeat(32) }]),
    record([{ ...entry, beaconUrl: null }]), record([entry, { id: entry.id, url: "https://another.example/" }]),
    record([entry, { id: "node-b", url: "https://RPC.EXAMPLE:443" }]),
    record(Array.from({ length: MAX_OPERATOR_ENDPOINTS + 1 }, (_, i) => ({ id: `node-${i}`, url: `https://node-${i}.example/` }))),
  ])("rejects invalid or ambiguous records: %s", value => {
    expect(() => parseOperatorEndpoints(value)).toThrow();
  });

  it.each([
    "http://rpc.example/", "https://rpc.example/?", "https://rpc.example/?token=secret",
    "https://rpc.example/#", "https://rpc.example/#fragment", "https://user:secret@rpc.example/",
    `http://${"a".repeat(56)}.onion/`, "file:///tmp/rpc",
  ])("rejects unsafe public RPC and beacon URLs: %s", url => {
    expect(() => parseOperatorEndpoints(record([{ ...entry, url }]))).toThrow();
    expect(() => parseOperatorEndpoints(record([{ ...entry, beaconUrl: url }]))).toThrow();
  });

  it("accepts the entry-count boundary and rejects sparse serializer input", () => {
    const entries = Array.from({ length: MAX_OPERATOR_ENDPOINTS }, (_, i) => ({ id: `node-${i}`, url: `https://node-${i}.example/` }));
    expect(parseOperatorEndpoints(serializeOperatorEndpoints(entries))).toEqual(entries);
    expect(() => serializeOperatorEndpoints(Array(1))).toThrow();
  });

  it("bounds actual UTF-8 bytes and canonical serialized output", () => {
    const utf8 = record([{ id: "node-a", url: `https://rpc.example/${"é".repeat(2020)}` }]);
    expect(utf8.length).toBeLessThan(MAX_ENDPOINT_RECORD_BYTES);
    expect(new TextEncoder().encode(utf8).length).toBeGreaterThan(MAX_ENDPOINT_RECORD_BYTES);
    expect(() => parseOperatorEndpoints(utf8)).toThrow("4096 UTF-8 bytes");
    const entries = Array.from({ length: MAX_OPERATOR_ENDPOINTS }, (_, i) => ({ id: `node-${i}`, url: `https://node-${i}.example/${"a".repeat(500)}` }));
    expect(() => serializeOperatorEndpoints(entries)).toThrow("4096 UTF-8 bytes");
    const valid = record([entry]);
    expect(parseOperatorEndpoints(valid.padEnd(MAX_ENDPOINT_RECORD_BYTES, " "))).toEqual([entry]);
    expect(() => parseOperatorEndpoints(valid.padEnd(MAX_ENDPOINT_RECORD_BYTES + 1, " "))).toThrow();
  });
});
