import { describe, expect, it } from "vitest";
import { createPool, type Pool, type PoolEndpoint, type PoolOptions, type PoolRunOptions, type SelectionMode } from "../../src/pool/pool.ts";
import { ProofVerificationError } from "../../src/verify/mpt.ts";
import { StaleHeaderError } from "../../src/light-client/header-source.ts";

const endpoints: PoolEndpoint[] = [
  { id: "a", url: "https://a.example", ens: "a.derpc.eth", priority: 0 },
  { id: "b", url: "https://b.example", ens: "b.derpc.eth", priority: 0 },
  { id: "c", url: "https://c.example", ens: "c.derpc.eth", priority: 1 },
];

function harness(options: Partial<PoolOptions> = {}) {
  let now = 1_000_000;
  const randoms: number[] = [], used: string[] = [];
  const pool = createPool({
    endpoints, sendFor: () => async () => undefined, now: () => now,
    random: () => randoms.shift() ?? 0.5, maxAttempts: 1, cooldownMs: 1, ...options,
  });
  const run = (ms = 10, opts?: PoolRunOptions, failure?: Error) => pool.run(async (_send, context) => {
    used.push(context.endpoint.id!); now += ms;
    if (failure) throw failure;
    return context.endpoint.id;
  }, opts);
  async function train(index: number, ms: number, success = true) {
    pool.setSelection(undefined);
    // All fixture endpoints use the same manual tier while training.
    randoms.push((index + 0.1) / (options.endpoints ?? endpoints).length);
    if (success) await run(ms);
    else await run(ms, undefined, new Error("network timeout")).catch(() => {});
    now += 2; // clear the fixture's 1 ms cooldown without aging the observations
  }
  return { pool, randoms, used, run, train, advance: (ms: number) => { now += ms; }, now: () => now };
}

const sameTier = endpoints.map(endpoint => ({ ...endpoint, priority: 0 }));
const modes: SelectionMode[] = ["balanced", "fastest", "reliable"];

describe("automatic pool selection", () => {
  it.each(modes)("%s includes every unknown eligible operator, regardless of manual priority", async selection => {
    const h = harness({ selection });
    expect(h.pool.status().every(endpoint => endpoint.observations === undefined)).toBe(true);
    h.randoms.push(0.99);
    expect(await h.run()).toBe("c");
    expect(h.used).toEqual(["c"]);
    expect(h.pool.status()[2]!.observations).toMatchObject({ attempts: 1, successes: 1, meanVerifiedMs: 10 });
  });

  it.each([
    ["fastest", "a"], ["reliable", "c"], ["balanced", "b"],
  ] as const)("%s chooses %s for the same measured tradeoff", async (selection, expected) => {
    const h = harness({ endpoints: sameTier });
    for (let n = 0; n < 2; n++) await h.train(0, 100);
    for (let n = 0; n < 3; n++) await h.train(0, 1, false);
    for (let n = 0; n < 8; n++) await h.train(1, 450);
    for (let n = 0; n < 20; n++) await h.train(2, 900);
    h.pool.setSelection(selection);
    h.randoms.push(0.5, 0); // exploit the measured scores, then break any tie
    expect(await h.run()).toBe(expected);
  });

  it("learns latency only from completed verified successes, never quick failures", async () => {
    const h = harness({ endpoints: sameTier });
    await h.train(0, 100);
    await h.train(1, 500);
    await h.train(1, 1, false);
    expect(h.pool.status()[1]!.observations).toMatchObject({ successes: 1, failures: 1, meanVerifiedMs: 500 });
    h.pool.setSelection("fastest"); h.randoms.push(0.5, 0);
    expect(await h.run()).toBe("a");
  });

  it("occasionally explores an unknown operator using only the actual sequential read", async () => {
    const h = harness({ endpoints: sameTier });
    await h.train(0, 10);
    h.pool.setSelection("fastest"); h.randoms.push(0.05, 0.99);
    expect(await h.run()).toBe("c");
    expect(h.used).toEqual(["a", "c"]);
    expect(h.pool.status()[1]!.observations).toBeUndefined();
  });

  it("ages local evidence out after five minutes, returning to unknown selection", async () => {
    const h = harness({ endpoints: sameTier });
    await h.train(0, 1);
    h.advance(300_001);
    expect(h.pool.status()[0]!.observations).toBeUndefined();
    h.pool.setSelection("fastest"); h.randoms.push(0.99);
    expect(await h.run()).toBe("c");
  });

  it("bounds each endpoint's observations to its last 32 completed attempts", async () => {
    const h = harness({ endpoints: [sameTier[0]!] });
    for (let ms = 1; ms <= 40; ms++) await h.run(ms);
    expect(h.pool.status()[0]!.observations).toMatchObject({ attempts: 32, successes: 32, failures: 0, meanVerifiedMs: 24.5 });
  });

  it("keeps established account affinity when the policy changes or exploration would prefer another", async () => {
    const h = harness({ endpoints: sameTier });
    h.randoms.push(0); await h.run(1000, { account: "Alice" });
    await h.train(1, 10);
    h.pool.setSelection("fastest"); h.randoms.push(0.05, 0.99);
    expect(await h.run(1000, { account: "ALICE" })).toBe("a");
    // The sticky read consumed no randomness, so this new account explores c.
    expect(await h.run(20, { account: "Bob" })).toBe("c");
    h.pool.setSelection("reliable");
    expect(await h.run(30, { account: "alice" })).toBe("a");
  });

  it("does not train on unverified metadata successes or failures before enabling auto mode", async () => {
    const h = harness({ endpoints: [sameTier[0]!] });
    await h.run(1, { observe: false });
    await h.run(1, { observe: false }, new Error("metadata refused")).catch(() => {});
    h.pool.setSelection("fastest");
    expect(h.pool.status()[0]!.observations).toBeUndefined();
  });

  it("keeps account affinity after caller cancellation or a local freshness refusal", async () => {
    const h = harness({ endpoints: sameTier });
    h.randoms.push(0); await h.run(1000, { account: "alice" });
    await h.train(1, 10);
    h.pool.setSelection("fastest");
    const controller = new AbortController();
    await h.pool.run(async () => { controller.abort(new Error("cancelled")); }, { account: "alice", signal: controller.signal }).catch(() => {});
    expect(await h.run(1000, { account: "alice" })).toBe("a");
    await h.run(1, { account: "alice" }, new StaleHeaderError("stale")).catch(() => {});
    expect(await h.run(1000, { account: "alice" })).toBe("a");
  });

  it("does not count caller cancellation, stale context or expired authorization as endpoint evidence", async () => {
    const controller = new AbortController();
    const h = harness({ endpoints: [{ ...sameTier[0]!, expiry: 1001 }], selection: "balanced" });
    await h.pool.run(async () => { controller.abort(new Error("cancelled")); return 42; }, { signal: controller.signal }).catch(() => {});
    await h.run(1, undefined, new StaleHeaderError("stale")).catch(() => {});
    await h.run(1000).catch(() => {});
    expect(h.pool.status()[0]!.observations).toBeUndefined();
    expect(h.pool.status()[0]!.state).toBe("expired");
  });

  it("counts neither latency nor success when final completion rejects", async () => {
    const h = harness({ endpoints: [sameTier[0]!], selection: "fastest", prepareAttempt: async (_context, send) => ({
      send, verified: async () => { throw new Error("completion uncertain"); },
    }) });
    await expect(h.run(10)).rejects.toThrow("completion uncertain");
    expect(h.pool.status()[0]!.observations).toBeUndefined();
  });

  it("measures overlapping reads from their own start times and reserves same-account affinity", async () => {
    const h = harness({ selection: "balanced" });
    let finishFirst!: () => void, finishSecond!: () => void;
    const firstPending = new Promise<void>(resolve => { finishFirst = resolve; });
    const secondPending = new Promise<void>(resolve => { finishSecond = resolve; });
    const selected: string[] = [];
    h.randoms.push(0);
    const first = h.pool.run(async (_send, context) => { selected.push(context.endpoint.id!); await firstPending; }, { account: "alice" });
    h.advance(50);
    const second = h.pool.run(async (_send, context) => { selected.push(context.endpoint.id!); await secondPending; }, { account: "alice" });
    expect(selected).toEqual(["a", "a"]);
    h.advance(50); finishFirst(); await first;
    h.advance(100); finishSecond(); await second;
    expect(h.pool.status()[0]!.observations).toMatchObject({ successes: 2, meanVerifiedMs: 125 });
  });

  it("excludes invalid proofs even when exploration would choose the endpoint again", async () => {
    const h = harness({ endpoints: sameTier, selection: "fastest" });
    h.randoms.push(0);
    await h.run(1, undefined, new ProofVerificationError("invalid")).catch(() => {});
    expect(h.pool.status()[0]!.state).toBe("excluded");
    expect(h.pool.status()[0]!.observations?.meanVerifiedMs).toBeUndefined();
    h.randoms.push(0);
    expect(await h.run()).toBe("b");
  });

  it("refuses duplicate identities in automatic modes without changing legacy demo behavior", () => {
    for (const duplicate of [
      { ...sameTier[1]!, id: "a" },
      { ...sameTier[1]!, ens: "A.DERPC.ETH" },
      { ...sameTier[1]!, url: sameTier[0]!.url },
    ]) {
      const pool = createPool({ endpoints: [sameTier[0]!, duplicate], sendFor: () => async () => undefined });
      expect(() => pool.setSelection("balanced")).toThrow("one endpoint per operator identity");
      expect(() => createPool({ endpoints: [sameTier[0]!, duplicate], selection: "fastest", sendFor: () => async () => undefined })).toThrow("one endpoint per operator identity");
    }
    expect(() => createPool({ endpoints: [], selection: "unknown" as SelectionMode, sendFor: () => async () => undefined })).toThrow("invalid pool selection");
  });

  it("retains observations and affinity only for explicitly unchanged identities on replacement", async () => {
    const h = harness({ endpoints: sameTier });
    h.randoms.push(0); await h.run(100, { account: "alice" });
    await h.train(1, 10);
    const next = createPool({
      endpoints: sameTier, selection: "fastest", preserveFrom: { pool: h.pool, ids: ["a", "b"] },
      sendFor: () => async () => undefined, now: h.now, random: () => 0.5,
    });
    expect(next.status()[0]!.observations?.meanVerifiedMs).toBe(100);
    expect(await next.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe("a");
    expect(await next.run(async (_send, context) => context.endpoint.id, { account: "new" })).toBe("b");

    const replaced = createPool({
      endpoints: [{ ...sameTier[0]!, url: "https://rotated.example" }, sameTier[1]!], selection: "balanced",
      preserveFrom: { pool: h.pool, ids: ["a"] }, sendFor: () => async () => undefined, now: h.now, random: () => 0.99,
    });
    expect(replaced.status().every(endpoint => !endpoint.observations)).toBe(true);
    expect(await replaced.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe("b");
  });

  it("carries exclusion and cooldown through a safe pool replacement", async () => {
    const h = harness({ endpoints: sameTier });
    h.randoms.push(0); await h.run(1, undefined, new ProofVerificationError("invalid")).catch(() => {});
    h.randoms.push(0); await h.run(1, undefined, new Error("timeout")).catch(() => {});
    const next: Pool = createPool({
      endpoints: sameTier, selection: "balanced", preserveFrom: { pool: h.pool, ids: ["a", "b"] },
      sendFor: () => async () => undefined, now: h.now,
    });
    expect(next.status().map(endpoint => endpoint.state)).toEqual(["excluded", "cooldown", "eligible"]);
    expect(await next.run(async (_send, context) => context.endpoint.id)).toBe("c");
  });
});
