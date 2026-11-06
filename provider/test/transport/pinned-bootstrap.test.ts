import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import { NYM_PIN, TOR_JS_DEMO_GATEWAY, TOR_JS_PIN, withGateways, type WorkerPin } from "../../src/config/mainnet.ts";
import { createPinnedBootstrapProvider } from "../../src/transport/pinned-bootstrap.ts";

const HASH_SELECTOR = "0x3898587d";
const RESOLVERS_SELECTOR = "0x1c67ff29";
const hash = TOR_JS_PIN.workerHash.slice(2);
const path = `/keccak/${hash.slice(0, 2)}/${hash.slice(2)}`;
const key = TOR_JS_DEMO_GATEWAY.slice(TOR_JS_DEMO_GATEWAY.lastIndexOf(":") + 1);
const call = (pin: WorkerPin, data: string) => ({ method: "eth_call", params: [{ to: pin.specifier, data }, "latest"] });
async function resolvers(pin: WorkerPin) {
  const provider = createPinnedBootstrapProvider(pin);
  const raw = await provider.request(call(pin, RESOLVERS_SELECTOR));
  return decodeAbiParameters([{ type: "string[]" }], raw as `0x${string}`)[0];
}

describe("pinned bundle bootstrap", () => {
  it("prefers the configured gateway mirror and retains every public bundle fallback", async () => {
    const gateway = `gateway.example:12298:${key}`;
    const pin = withGateways(TOR_JS_PIN, [gateway]);
    const before = structuredClone(pin);
    expect(await resolvers(pin)).toEqual([`kps:${gateway}${path}`, ...TOR_JS_PIN.resolvers]);
    expect(await createPinnedBootstrapProvider(pin).request(call(pin, HASH_SELECTOR))).toBe(TOR_JS_PIN.workerHash);
    expect(pin).toEqual(before);
    expect(TOR_JS_PIN.config.gateways).toEqual([TOR_JS_DEMO_GATEWAY]);
  });

  it("moves the built-in gateway first without duplicating its original entry", async () => {
    const result = await resolvers(TOR_JS_PIN);
    expect(result).toEqual([TOR_JS_PIN.resolvers[3], ...TOR_JS_PIN.resolvers.slice(0, 3)]);
    expect(result).toHaveLength(TOR_JS_PIN.resolvers.length);
  });

  it("supports bracketed IPv6, respects gateway order and removes duplicates", async () => {
    const ipv6 = `[2001:db8::7]:12298:${key}`;
    const second = `gateway.example:443:${key}`;
    expect(await resolvers(withGateways(TOR_JS_PIN, [ipv6, second, ipv6]))).toEqual([
      `kps:${ipv6}${path}`, `kps:${second}${path}`, ...TOR_JS_PIN.resolvers,
    ]);
  });

  it("encodes UTF-8 fallback strings and preserves entries at ABI word boundaries", async () => {
    const custom = ["https://example.test/🧅", "x".repeat(32), "y".repeat(33)];
    const result = await resolvers({ ...TOR_JS_PIN, resolvers: [...TOR_JS_PIN.resolvers, ...custom] });
    expect(result.slice(-3)).toEqual(custom);
  });

  it("keeps the original ABI answer for workers without the advertised hash-addressed KPS layout", async () => {
    const pins = [NYM_PIN, { ...TOR_JS_PIN, resolvers: ["kps:gateway.example:443:" + key + "/different-worker.js"] },
      { ...TOR_JS_PIN, workerHash: `0x${"00".repeat(32)}` as `0x${string}` }];
    for (const pin of pins) expect(await createPinnedBootstrapProvider(pin).request(call(pin, RESOLVERS_SELECTOR))).toBe(pin.resolversRaw);
  });

  it.each([`gateway.example:0:${key}`, `gateway.example:65536:${key}`, `gateway.example:443:${key}/other`, `gateway.example:443:${key}\r\nHost: injected`])("rejects an unsafe configured gateway before the harness sends a request: %s", gateway => {
    expect(() => createPinnedBootstrapProvider(withGateways(TOR_JS_PIN, [gateway]))).toThrow("invalid bundle gateway address");
  });

  it("never replaces the hash or answers a direct RPC bootstrap fallback", async () => {
    const provider = createPinnedBootstrapProvider(TOR_JS_PIN);
    await expect(provider.request({ method: "eth_getBalance", params: [TOR_JS_PIN.specifier, "latest"] })).rejects.toThrow("refusing eth_getBalance");
    await expect(provider.request({ method: "eth_call", params: [{ to: NYM_PIN.specifier, data: RESOLVERS_SELECTOR }, "latest"] })).rejects.toThrow("refusing eth_call");
    await expect(provider.request(call(TOR_JS_PIN, "0x12345678"))).rejects.toThrow("refusing eth_call");
    expect(await provider.request(call(TOR_JS_PIN, HASH_SELECTOR))).toBe(TOR_JS_PIN.workerHash);
  });
});
