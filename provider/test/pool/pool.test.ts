// The endpoint pool: which endpoint serves a read, and what happens when one fails.
import { describe, expect, it } from "vitest";
import { createPool, NoOperatorsChosenError, PoolExhaustedError, type PoolEndpoint, type PoolEvent } from "../../src/pool/pool.ts";
import type { JsonRpcSend } from "../../src/verify/reader.ts";
import { ProofVerificationError } from "../../src/verify/index.ts";
import { StaleHeaderError } from "../../src/light-client/header-source.ts";
import { WorkerPinMismatchError } from "../../src/verify/worker-pin.ts";
import { TransportUnavailableError } from "../../src/transport/anon-transport.ts";

const KEY = "derpc:account:0xabc";
type Behavior = () => unknown;

function harness(endpoints: PoolEndpoint[], behaviors: Record<string, Behavior[] | Behavior>, opts: { random?: number[]; stepMs?: number; excluded?: string[] } = {}) {
  const calls: { url: string; isolationKey: string }[] = [];
  const events: string[] = [];
  let now = 1_000_000;
  const randoms = [...(opts.random ?? [])];
  const sendFor = (endpoint: PoolEndpoint): JsonRpcSend => async (_method, _params, { isolationKey }) => {
    const url = endpoint.id ?? endpoint.url;
    calls.push({ url, isolationKey });
    now += opts.stepMs ?? 0;
    const b = behaviors[url];
    const behavior = Array.isArray(b) ? (b.length > 1 ? b.shift()! : b[0]!) : b!;
    return behavior();
  };
  const pool = createPool({
    endpoints,
    sendFor,
    random: () => randoms.shift() ?? 0,
    now: () => now,
    maxAttempts: 3,
    totalTimeoutMs: 30_000,
    cooldownMs: 60_000,
    excluded: opts.excluded,
    onEvent: (e: PoolEvent) => events.push(`${e.type} ${e.endpoint ?? ""}`.trim()),
  });
  // An operation like a verified read: one request, then a "verification" that rejects lies.
  const read = (account?: string) =>
    pool.run(async (send) => {
      const answer = await send("eth_getProof", [], { isolationKey: KEY });
      if (answer === "lie") throw new ProofVerificationError("proof does not match the verified state root");
      return answer;
    }, account ? { account } : undefined);
  return { pool, read, calls, events, advance: (ms: number) => (now += ms) };
}

const ok = () => "ok";
const lie = () => "lie";
const exitTimeout = () => { throw new Error("Failed to connect: tor: operation timed out at exit"); };
const PREFERRED: PoolEndpoint[] = [{ url: "a", priority: 0 }, { url: "b", priority: 0 }, { url: "c", priority: 1 }];

describe("createPool", () => {
  it("stops choosing an expired listing, including affinity and cooldown retries", async () => {
    const h = harness([{ url: "a", priority: 0, expiry: 1001 }, { url: "b", priority: 1 }], { a: ok, b: ok });
    await h.read("account");
    h.advance(1000);
    await h.read("account");
    expect(h.calls.map(c => c.url)).toEqual(["a", "b"]);
    expect(h.pool.status()[0]!.state).toBe("expired");

    const onlyExpired = harness([{ url: "a", priority: 0, expiry: 1000 }], { a: ok });
    await expect(onlyExpired.read()).rejects.toThrow("excluded or expired");
    expect(onlyExpired.calls).toEqual([]);
  });

  it("does not send a later request in the same operation after its listing expires", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const pool = createPool({
      endpoints: [{ url: "a", priority: 0, expiry: 1001 }, { url: "b", priority: 1 }], now: () => now,
      sendFor: endpoint => async method => { calls.push(`${endpoint.url}:${method}`); now += 1000; },
    });
    await pool.run(async send => {
      await send("eth_getProof", [], { isolationKey: KEY });
      await send("eth_getCode", [], { isolationKey: KEY });
    });
    expect(calls).toEqual(["a:eth_getProof", "b:eth_getProof", "b:eth_getCode"]);
    expect(pool.status()[0]!.state).toBe("expired");
  });

  it("chooses randomly among the preferred tier and leaves the fallback tier alone while it is available", async () => {
    const h = harness(PREFERRED, { a: ok, b: ok, c: ok }, { random: [0, 0.99] });

    await h.read();
    await h.read();

    expect(h.calls.map((c) => c.url)).toEqual(["a", "b"]);
  });

  it("falls back to the next tier only when the preferred tier is unavailable", async () => {
    const h = harness(PREFERRED, { a: lie, b: lie, c: ok });

    await expect(h.read()).resolves.toBe("ok");
    expect(h.calls.map((c) => c.url)).toEqual(["a", "b", "c"]);
  });

  it("excludes an endpoint whose answer fails verification, and answers from another", async () => {
    const h = harness(PREFERRED, { a: lie, b: ok, c: ok });

    await expect(h.read()).resolves.toBe("ok");
    await h.read();

    expect(h.calls.map((c) => c.url)).toEqual(["a", "b", "b"]);
    expect(h.pool.status().find((s) => s.url === "a")?.state).toBe("excluded");
    expect(h.events.slice(0, 4)).toEqual(["attempt a", "invalid-proof a", "attempt b", "success b"]);
  });

  it("cools an endpoint down after a transient failure and uses it again once the cooldown ends", async () => {
    const h = harness(PREFERRED, { a: [exitTimeout, ok], b: ok, c: ok });

    await expect(h.read()).resolves.toBe("ok");
    expect(h.pool.status().find((s) => s.url === "a")?.state).toBe("cooldown");

    h.advance(60_001);
    expect(h.pool.status().find((s) => s.url === "a")?.state).toBe("eligible");
  });

  it("treats the proof-window error as a cooldown, not as an invalid proof", async () => {
    const proofWindow = () => { throw new Error("eth.drpc.org: distance to target block exceeds maximum proof window (-32602)"); };
    const h = harness(PREFERRED, { a: proofWindow, b: ok, c: ok });

    await h.read();

    expect(h.pool.status().find((s) => s.url === "a")?.state).toBe("cooldown");
  });

  it("retries on a fresh Tor circuit, with an isolation key derived from the same account's key", async () => {
    const h = harness(PREFERRED, { a: exitTimeout, b: exitTimeout, c: ok });

    await h.read();

    expect(h.calls[0]!.isolationKey).toBe(KEY);
    expect(h.calls[1]!.isolationKey).toMatch(/^derpc:account:0xabc#retry-\d+-\d+-2$/);
    expect(h.calls[2]!.isolationKey).toMatch(/^derpc:account:0xabc#retry-\d+-\d+-3$/);
  });

  it.each([
    ["a stale verified header", () => { throw new StaleHeaderError("stale"); }, StaleHeaderError],
    ["a worker-pin mismatch", () => { throw new WorkerPinMismatchError("differs"); }, WorkerPinMismatchError],
    ["a dead anonymous transport", () => { throw new TransportUnavailableError("closed"); }, TransportUnavailableError],
  ])("does not retry %s: it is not the endpoint's fault", async (_name, failure, type) => {
    const h = harness(PREFERRED, { a: failure, b: ok, c: ok });

    await expect(h.read()).rejects.toBeInstanceOf(type);
    expect(h.calls).toHaveLength(1);
  });

  it("reports why it stopped when an error is not the endpoint's fault", async () => {
    const h = harness(PREFERRED, { a: () => { throw new TransportUnavailableError("closed"); }, b: ok, c: ok });

    await h.read().catch(() => {});

    expect(h.events).toEqual(["attempt a", "stopped a"]);
  });

  it("gives up after the attempt limit with an error listing every attempt", async () => {
    const h = harness(
      [{ url: "a", priority: 0 }, { url: "b", priority: 0 }, { url: "c", priority: 0 }, { url: "d", priority: 0 }],
      { a: exitTimeout, b: exitTimeout, c: exitTimeout, d: ok },
    );

    const error = await h.read().catch((e) => e);

    expect(error).toBeInstanceOf(PoolExhaustedError);
    expect(error.attempts.map((a: { endpoint: string }) => a.endpoint)).toEqual(["a", "b", "c"]);
    expect(h.calls).toHaveLength(3);
  });

  it("stops when the total time budget is spent", async () => {
    const h = harness(PREFERRED, { a: exitTimeout, b: exitTimeout, c: ok }, { stepMs: 20_000 });

    await expect(h.read()).rejects.toBeInstanceOf(PoolExhaustedError);
    expect(h.calls).toHaveLength(2);
  });

  it("keeps each account on the operator that first served it (sticky per account)", async () => {
    const h = harness(PREFERRED, { a: ok, b: ok, c: ok }, { random: [0, 0.99, 0.99, 0] });

    await h.read("alice"); // random 0    → a
    await h.read("bob"); //   random 0.99 → b
    await h.read("alice"); // sticky      → a (the random value is not used)
    await h.read("bob"); //   sticky      → b

    expect(h.calls.map((c) => c.url)).toEqual(["a", "b", "a", "b"]);
  });

  it("moves an account to another chosen operator when its operator fails, and stays there", async () => {
    const h = harness(PREFERRED, { a: [exitTimeout, ok], b: ok, c: ok }, { random: [0, 0, 0] });

    await h.read("alice"); // a times out → b serves it
    h.advance(60_001); //    a is eligible again
    await h.read("alice"); // stays on b

    expect(h.calls.map((c) => c.url)).toEqual(["a", "b", "b"]);
  });

  it("keeps two entries that share a URL apart by id (a simulated liar wrapping a real operator)", async () => {
    const h = harness([{ id: "liar", url: "x", priority: -1 }, { url: "x", priority: 0 }], { liar: lie, x: ok });

    await expect(h.read()).resolves.toBe("ok");

    expect(h.calls.map((c) => c.url)).toEqual(["liar", "x"]);
    expect(h.pool.status().map((s) => [s.id, s.state])).toEqual([["liar", "excluded"], ["x", "eligible"]]);
    expect(h.events).toContain("invalid-proof liar");
  });

  it("starts with endpoints excluded earlier in the session still excluded", async () => {
    const h = harness(PREFERRED, { a: ok, b: ok, c: ok }, { excluded: ["a"] });

    await h.read();

    expect(h.calls.map((c) => c.url)).toEqual(["b"]);
    expect(h.pool.status().find((s) => s.url === "a")?.state).toBe("excluded");
  });

  it("retries the only chosen operator on a fresh circuit when its first attempt fails at the Tor exit", async () => {
    const h = harness([{ url: "a", priority: 0 }], { a: [exitTimeout, ok] });

    await expect(h.read()).resolves.toBe("ok");

    expect(h.calls.map(c => c.url)).toEqual(["a", "a"]);
    expect(h.calls[0]!.isolationKey).toBe(KEY);
    expect(h.calls[1]!.isolationKey).toMatch(/^derpc:account:0xabc#retry-\d+-\d+-2$/);
  });

  it("gives a cooling-down operator another try on a fresh circuit rather than fail, when no other is available", async () => {
    const h = harness([{ url: "a", priority: 0 }, { url: "b", priority: 0 }], { a: [exitTimeout, ok], b: [exitTimeout, ok] });

    await expect(h.read()).resolves.toBe("ok"); // a fails, b fails, then a again on a fresh circuit

    expect(h.calls.map(c => c.url)).toEqual(["a", "b", "a"]);
    expect(h.calls[0]!.isolationKey).toBe(KEY);
    expect(new Set(h.calls.map(c => c.isolationKey)).size).toBe(3);
  });

  it("sends a later read to an operator that is still cooling down on a fresh circuit, not the one that failed", async () => {
    const h = harness([{ url: "a", priority: 0 }], { a: [exitTimeout, exitTimeout, exitTimeout, ok] });

    await expect(h.read()).rejects.toBeInstanceOf(PoolExhaustedError); // three attempts, all at the exit
    await expect(h.read()).resolves.toBe("ok");

    expect(h.calls[3]?.isolationKey).toMatch(/^derpc:account:0xabc#retry-\d+-\d+-1$/);
    expect(new Set(h.calls.map(c => c.isolationKey)).size).toBe(4);
  });

  it("ends an operator's cooldown when it answers", async () => {
    const h = harness([{ url: "a", priority: 0 }], { a: [exitTimeout, ok] });

    await h.read();

    expect(h.pool.status()[0]?.state).toBe("eligible");
  });

  it("never gives an operator that returned an invalid proof another try", async () => {
    const h = harness([{ url: "a", priority: 0 }], { a: [lie, ok] });

    await expect(h.read()).rejects.toBeInstanceOf(PoolExhaustedError);
    expect(h.calls).toHaveLength(1);
  });

  it("refuses to read when the user has not chosen any operator", async () => {
    const h = harness([], {});

    await expect(h.read("alice")).rejects.toBeInstanceOf(NoOperatorsChosenError);
    expect(h.calls).toEqual([]);
  });

  it("refuses to send anything when every endpoint is excluded", async () => {
    const h = harness(PREFERRED, { a: lie, b: lie, c: lie });
    await h.read().catch(() => {});
    const before = h.calls.length;

    await expect(h.read()).rejects.toBeInstanceOf(PoolExhaustedError);
    expect(h.calls).toHaveLength(before);
  });
});
