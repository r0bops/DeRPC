import { describe, expect, it, vi } from "vitest";
import { createPool } from "../../src/pool/pool.ts";
import { createPooledReader } from "../../src/pool/pooled-reader.ts";
import { recordedEndpoint, RECORDED_HEADER } from "../helpers/recorded-endpoint.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };
import { ProofVerificationError } from "../../src/verify/index.ts";
import { StaleHeaderError } from "../../src/light-client/header-source.ts";

describe("pool verification lifecycle", () => {
  it("does not retry or pay twice when completion rejects after signing may have started", async () => {
    const paid: string[] = [];
    const operation = vi.fn(async () => 42);
    const pool = createPool({
      endpoints: [{ url: "a", priority: 0 }, { url: "b", priority: 1 }], sendFor: () => async () => undefined,
      prepareAttempt: async (context, send) => ({ send, verified: async () => {
        paid.push(context.endpoint.url);
        throw new Error("signing outcome is uncertain");
      } }),
    });
    await expect(pool.run(operation)).rejects.toThrow("signing outcome is uncertain");
    expect(operation).toHaveBeenCalledOnce();
    expect(paid).toEqual(["a"]);
    expect(pool.status().every(endpoint => endpoint.state === "eligible")).toBe(true);
  });

  it("rechecks freshness after signing without retrying or caching the refused answer", async () => {
    const endpoint = recordedEndpoint();
    let stale = false;
    const paid = vi.fn(async () => { stale = true; });
    const pool = createPool({
      endpoints: [{ url: "a", priority: 0 }, { url: "b", priority: 1 }], sendFor: () => endpoint.send,
      prepareAttempt: async (_context, send) => ({ send, verified: paid }),
    });
    const reader = createPooledReader({ headers: {
      finalized: () => RECORDED_HEADER,
      assertFresh: () => { if (stale) throw new StaleHeaderError("expired while signing"); },
    }, pool });
    await expect(reader.getBalance(fixture.inputs.HOLDER as `0x${string}`)).rejects.toThrow("expired while signing");
    expect(paid).toHaveBeenCalledOnce();
    expect(endpoint.calls).toHaveLength(1);
    stale = false;
    paid.mockImplementation(async () => {});
    await reader.getBalance(fixture.inputs.HOLDER as `0x${string}`);
    expect(endpoint.calls).toHaveLength(2);
  });

  it.each(["preparation", "proof"])("does not pay a listing that expires during %s", async phase => {
    let now = 1_000_000;
    const sent: string[] = [], paid: string[] = [];
    const pool = createPool({
      endpoints: [{ url: "a", priority: 0, expiry: 1001 }, { url: "b", priority: 1 }], now: () => now,
      sendFor: endpoint => async () => { sent.push(endpoint.url); if (phase === "proof") now += 1000; },
      prepareAttempt: async (context, send) => {
        if (phase === "preparation") now += 1000;
        return { send, verified: async () => { paid.push(context.endpoint.url); } };
      },
    });
    await pool.run(send => send("eth_getProof", [], { isolationKey: "account" }));
    expect(sent).toEqual(phase === "preparation" ? ["b"] : ["a", "b"]);
    expect(paid).toEqual(["b"]);
  });

  it("refuses a listing that expires during signing without paying another operator", async () => {
    let now = 1_000_000;
    const paid: string[] = [];
    const pool = createPool({
      endpoints: [{ url: "a", priority: 0, expiry: 1001 }, { url: "b", priority: 1 }], now: () => now,
      sendFor: () => async () => undefined,
      prepareAttempt: async (context, send) => ({ send, verified: async () => { paid.push(context.endpoint.url); now += 1000; } }),
    });
    await expect(pool.run(async () => 42)).rejects.toThrow("operator listing expired");
    expect(paid).toEqual(["a"]);
    expect(pool.status()[0]!.state).toBe("expired");
  });

  it("treats account proof plus code as one paid unit after both checks succeed", async () => {
    const endpoint = recordedEndpoint();
    const events: string[] = [];
    const pool = createPool({
      endpoints: [{ url: "a", priority: 0 }], sendFor: () => endpoint.send,
      prepareAttempt: async (context, send) => {
        events.push(`begin:${context.kind}`);
        return { send: async (...args) => { events.push(args[0]); return send(...args); }, verified: async () => { events.push("verified"); } };
      },
    });
    const reader = createPooledReader({ headers: { finalized: () => RECORDED_HEADER }, pool });
    await reader.getCode(fixture.inputs.WETH as `0x${string}`);
    await reader.getCode(fixture.inputs.WETH as `0x${string}`);
    expect(events).toEqual(["begin:code", "eth_getProof", "eth_getCode", "verified"]);
  });

  it("reserves the account's operator before parallel requests await their answers", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const used: string[] = [];
    let random = 0;
    const pool = createPool({ endpoints: [{ url: "a", priority: 0 }, { url: "b", priority: 0 }], random: () => random++ % 2 ? 0.99 : 0,
      sendFor: endpoint => async () => { used.push(endpoint.url); await pending; return true; },
    });
    const read = () => pool.run(send => send("eth_getProof", [], { isolationKey: "account" }), { account: "same" });
    const first = read(), second = read();
    expect(used).toEqual(["a", "a"]);
    release(); await Promise.all([first, second]);
  });

  it("bounds a stuck operation and never pays its late answer", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const paid = vi.fn(async () => {}), failed = vi.fn();
    let signal!: AbortSignal;
    const pool = createPool({ endpoints: [{ url: "a", priority: 0 }], totalTimeoutMs: 10, sendFor: () => async () => {},
      prepareAttempt: async (context, send) => { signal = context.signal; return { send, verified: paid, failed }; },
    });
    await expect(pool.run(async () => { await pending; return 1; })).rejects.toThrow("all 1 attempts failed");
    expect(signal.aborted).toBe(true);
    release(); await Promise.resolve();
    expect(paid).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("does not pay an operator excluded by a concurrent read before this read completes", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const paid: string[] = [];
    const pool = createPool({ endpoints: [{ url: "a", priority: 0 }, { url: "b", priority: 1 }],
      sendFor: () => async () => undefined,
      prepareAttempt: async (context, send) => ({ send, verified: async () => { paid.push(context.endpoint.url); } }),
    });
    const slow = pool.run(async (_send, context) => { if (context.endpoint.url === "a") await pending; return 1; });
    await pool.run(async (_send, context) => { if (context.endpoint.url === "a") throw new ProofVerificationError("bad proof"); return 2; });
    release();
    expect(await slow).toBe(1);
    expect(paid).toEqual(["b", "b"]);
    expect(pool.status()[0]!.state).toBe("excluded");
  });

  it("uses different retry circuits across repeated reads and replaced pools", async () => {
    const keys: string[] = [];
    const makePool = () => createPool({ endpoints: [{ url: "a", priority: 0 }], maxAttempts: 2,
      sendFor: () => async (_method, _params, options) => { keys.push(options.isolationKey); throw new Error("network timeout"); },
    });
    const read = (pool: ReturnType<typeof makePool>) => pool.run(send => send("eth_getProof", [], { isolationKey: "account" }));
    const first = makePool();
    await read(first).catch(() => {}); await read(first).catch(() => {}); await read(makePool()).catch(() => {});
    const retries = keys.filter(k => k !== "account");
    expect(new Set(retries).size).toBe(retries.length);
  });
});
