import { describe, expect, it, vi } from "vitest";
import { sha3_256 } from "@noble/hashes/sha3";
import { assertSeparateGateway, checkOperatorIdentity, operatorUrl } from "../../src/operators/endpoint.ts";
import type { AnonTransport } from "../../src/transport/anon-transport.ts";

function onion(key: number): string {
  const publicKey = new Uint8Array(32).fill(key);
  const checksum = sha3_256(new Uint8Array([...new TextEncoder().encode(".onion checksum"), ...publicKey, 3]));
  const data = new Uint8Array([...publicKey, checksum[0]!, checksum[1]!, 3]);
  let bits = 0, accumulator = 0, result = "";
  for (const byte of data) {
    accumulator = (accumulator << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += "abcdefghijklmnopqrstuvwxyz234567"[(accumulator >> bits) & 31]; }
  }
  return result + ".onion";
}

describe("operator endpoints", () => {
  it("accepts checksum-valid v3 onions and HTTPS, rejects cleartext exit and malformed onion URLs", () => {
    expect(operatorUrl(`http://${onion(1)}/rpc`).hostname).toBe(onion(1));
    expect(operatorUrl("https://rpc.example/").protocol).toBe("https:");
    for (const url of ["http://rpc.example", "https://user:secret@rpc.example", `http://${"a".repeat(56)}.onion`, `http://sub.${onion(1)}`, "https://rpc.example/#fragment", "file:///tmp/test"]) {
      expect(() => operatorUrl(url)).toThrow();
    }
  });

  it("binds identity name, signer and chain through the worker, including onion rotation", async () => {
    const expected = { ens: "alice.derpc.eth", signer: "0x" + "11".repeat(20) };
    let document: unknown = { ...expected, chains: [1], version: "1", service: "demo-proxy" };
    const send = vi.fn(async () => Response.json(document));
    const transport = { fetch: send } as unknown as AnonTransport;
    for (const key of [1, 2]) await checkOperatorIdentity(transport, `http://${onion(key)}/rpc`, expected);
    expect(send.mock.calls).toHaveLength(2);
    const calls = send.mock.calls as unknown as [string, { redirect: string; isolationKey: string }][];
    expect(calls[0]![0]).toBe(`http://${onion(1)}/.well-known/derpc.json`);
    expect(calls[1]![0]).toBe(`http://${onion(2)}/.well-known/derpc.json`);
    expect(calls[0]![1]).toMatchObject({ redirect: "error", isolationKey: "derpc:operator-discovery" });
    document = { ...expected, ens: "attacker.derpc.eth", chains: [1], version: "1", service: "node" };
    await expect(checkOperatorIdentity(transport, `http://${onion(2)}/rpc`, expected)).rejects.toThrow("does not match");
    document = { ...expected, chains: [2], version: "1", service: "node" };
    await expect(checkOperatorIdentity(transport, `http://${onion(2)}/rpc`, expected)).rejects.toThrow("does not match");
  });

  it("refuses same-operator gateways even at a different network address", () => {
    const selected = ["gateway.example:12298:key-one"];
    expect(() => assertSeparateGateway({ gateways: ["192.0.2.1:12298:key-one"] }, selected)).toThrow("share an operator");
    expect(() => assertSeparateGateway({ ens: "alice.derpc.eth" }, selected, { "other.example:1234:key-one": "alice.derpc.eth" })).toThrow("share an operator");
    expect(() => assertSeparateGateway({ gateways: ["other:12298:key-two"] }, selected)).not.toThrow();
  });
});
