import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeRPCWith, type DeRPCPaymentClient } from "../../src/api/derpc.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import type { AnonTransport } from "../../src/transport/anon-transport.ts";
import { provenFixture, RETURN_42, TARGET, word } from "../execution/proven-fixture.ts";
import { StaleHeaderError } from "../../src/light-client/header-source.ts";

afterEach(() => vi.useRealTimers());

describe("provider local execution budget", () => {
  it("refuses a local execution result that becomes stale during signing without retrying", async () => {
    const fixture = await provenFixture([
      { address: TOR_JS_PIN.specifier, storage: { 1: BigInt(TOR_JS_PIN.workerHash) } },
      { address: TARGET, code: RETURN_42 },
    ]);
    let stale = false;
    const paid = vi.fn(async () => { stale = true; });
    const begin = vi.fn(async () => ({ headers: () => ({}), verified: paid, failed: () => {} }));
    const payments: DeRPCPaymentClient = { has: () => true, begin, latestVoucher: () => undefined, prepareClose: async () => { throw new Error("unused"); } };
    const send = fixture.endpoint();
    const urls: string[] = [];
    const transport: AnonTransport = {
      pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => "ready", close() {},
      async fetch(url, options = {}) {
        urls.push(url);
        const body = JSON.parse(String(options.body));
        const result = await send(body.method, body.params, { isolationKey: options.isolationKey!, signal: options.signal });
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    };
    const derpc = createDeRPCWith({ startTransport: () => transport, startHeaders: async () => ({
      ...fixture.headers, assertFresh() { if (stale) throw new StaleHeaderError("header expired during call signing"); },
      close() {}, pollHealth: () => ({ consecutiveFailures: 0 }),
    }) }, {
      operators: [{ url: "https://a.example", priority: 0 }, { url: "https://b.example", priority: 1 }],
      payments, verifiedCalls: true,
    });
    try {
      await expect(derpc.verifiedCall({ to: TARGET })).rejects.toThrow("header expired during call signing");
      expect(begin).toHaveBeenCalledOnce();
      expect(paid).toHaveBeenCalledOnce();
      expect(new Set(urls)).toEqual(new Set(["https://a.example"]));
    } finally { derpc.close(); }
  });

  it.each([
    ["allows a verified call beyond the ordinary 30-second read budget", undefined, true],
    ["enforces a shorter configured total budget without paying a late result", 25_000, false],
  ] as const)("%s", async (_name, timeoutMs, succeeds) => {
    const fixture = await provenFixture([
      { address: TOR_JS_PIN.specifier, storage: { 1: BigInt(TOR_JS_PIN.workerHash) } },
      { address: TARGET, code: RETURN_42 },
    ]);
    await import("../../src/execution/index.ts");
    vi.useFakeTimers();
    let sawFirst!: () => void;
    const firstRequest = new Promise<void>(resolve => { sawFirst = resolve; });
    const send = fixture.endpoint();
    const paid = vi.fn(async () => {});
    const payments: DeRPCPaymentClient = {
      has: () => true,
      begin: async () => ({ headers: () => ({}), verified: paid, failed: () => {} }),
      latestVoucher: () => undefined,
      prepareClose: async () => { throw new Error("unused"); },
    };
    const transport: AnonTransport = {
      pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => "ready", close() {},
      async fetch(_url, options = {}) {
        const body = JSON.parse(String(options.body));
        // Two independently bounded requests total 35 seconds, as on a slower onion circuit.
        if (body.params[0] === TARGET) {
          sawFirst();
          await new Promise(resolve => setTimeout(resolve, 17_500));
        }
        const result = await send(body.method, body.params, { isolationKey: options.isolationKey!, signal: options.signal });
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    };
    const derpc = createDeRPCWith({ startTransport: () => transport, startHeaders: async () => ({ ...fixture.headers, assertFresh() {}, close() {}, pollHealth: () => ({ consecutiveFailures: 0 }) }) }, {
      operators: [{ id: "test", url: "https://operator.example", priority: 0 }], payments,
      verifiedCalls: timeoutMs === undefined ? true : { limits: { timeoutMs } },
    });
    try {
      const outcome = derpc.verifiedCall({ to: TARGET }).then(value => ({ value }), error => ({ error }));
      await firstRequest;
      await vi.advanceTimersByTimeAsync(35_001);
      const result = await outcome;
      if (succeeds) {
        expect(result).toMatchObject({ value: { value: word(42n) } });
        expect(paid).toHaveBeenCalledOnce();
      } else {
        expect(result).toHaveProperty("error");
        expect(paid).not.toHaveBeenCalled();
      }
      expect(fixture.calls.every(call => call.method !== "eth_call")).toBe(true);
    } finally { derpc.close(); }
  });
});
