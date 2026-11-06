import { describe, expect, it } from "vitest";
import { createPool, operatorKey, PoolExhaustedError, type PoolEndpoint, type SelectionMode } from "../../src/pool/pool.ts";
import { ProofVerificationError } from "../../src/verify/mpt.ts";

const node = (owner: string, id: string): PoolEndpoint => ({
  id: `${owner}.derpc.eth#${id}`, operatorId: `${owner}.derpc.eth`, endpointId: id,
  ens: `${owner}.derpc.eth`, operator: owner, url: `https://${owner}-${id}.example`, priority: 0,
});
const a1 = node("a", "one"), a2 = node("a", "two"), b1 = node("b", "one");
const sendFor = () => async () => undefined;
const policies: (SelectionMode | undefined)[] = [undefined, "balanced", "fastest", "reliable"];

describe("operators with several endpoints", () => {
  it.each(policies)("%s selects owners evenly when one publishes eight nodes and the other one", async selection => {
    let randoms: number[] = [];
    const pool = createPool({
      endpoints: [...Array.from({ length: 8 }, (_, index) => node("a", `node-${index}`)), b1],
      selection, sendFor, random: () => randoms.shift() ?? 0.5,
    });
    const owners: string[] = [];
    for (let index = 0; index < 100; index++) {
      randoms = [(index + 0.5) / 100];
      owners.push(await pool.run(async (_send, context) => operatorKey(context.endpoint), { observe: false }));
    }
    expect(owners.filter(owner => owner === "a.derpc.eth")).toHaveLength(50);
    expect(owners.filter(owner => owner === "b.derpc.eth")).toHaveLength(50);
    expect(pool.status().every(endpoint => !endpoint.operatorObservations)).toBe(true);
  });

  it.each(policies)("%s tries a sibling before another owner and retains the successful node", async selection => {
    const randoms = [0, 0], attempts: string[] = [];
    const pool = createPool({ endpoints: [a1, a2, b1], selection, sendFor, random: () => randoms.shift() ?? 0.99 });
    const read = () => pool.run(async (_send, context) => {
      attempts.push(context.endpoint.id!);
      if (context.endpoint.id === a1.id) throw new Error("node unavailable");
      return context.endpoint.id;
    }, { account: "alice" });
    expect(await read()).toBe(a2.id);
    pool.setSelection("reliable");
    expect(await read()).toBe(a2.id);
    expect(attempts).toEqual([a1.id, a2.id, a2.id]);
    expect(pool.status()[0]!.state).toBe("cooldown");
  });

  it("reaches another owner only after the eligible siblings fail", async () => {
    const used: string[] = [];
    const pool = createPool({ endpoints: [a1, a2, b1], selection: "balanced", sendFor, random: () => 0 });
    expect(await pool.run(async (_send, context) => {
      used.push(context.endpoint.id!);
      if (context.endpoint.operatorId === a1.operatorId) throw new Error("unavailable");
      return context.endpoint.id;
    }, { account: "alice" })).toBe(b1.id);
    expect(used).toEqual([a1.id, a2.id, b1.id]);
  });

  it("keeps the three-attempt limit across nodes and owners", async () => {
    const used: string[] = [];
    const pool = createPool({
      endpoints: [a1, a2, node("a", "three"), node("a", "four"), b1],
      selection: "balanced", sendFor, random: () => 0,
    });
    await expect(pool.run(async (_send, context) => { used.push(context.endpoint.id!); throw new Error("unavailable"); })).rejects.toBeInstanceOf(PoolExhaustedError);
    expect(used).toEqual([a1.id, a2.id, "a.derpc.eth#three"]);
  });

  it("excludes a corrupt node while leaving a valid sibling available", async () => {
    const used: string[] = [];
    const pool = createPool({ endpoints: [a1, a2, b1], selection: "fastest", sendFor, random: () => 0 });
    await pool.run(async (_send, context) => {
      used.push(context.endpoint.id!);
      if (context.endpoint.id === a1.id) throw new ProofVerificationError("bad proof");
    }, { account: "alice" });
    expect(used).toEqual([a1.id, a2.id]);
    expect(pool.status().map(endpoint => endpoint.state)).toEqual(["excluded", "eligible", "eligible"]);
    expect(pool.status()[1]!.operatorObservations).toMatchObject({ attempts: 2, successes: 1, failures: 1 });
  });

  it("moves an expired node's account to an active sibling without scoring expiry as a failure", async () => {
    let now = 1_000_000;
    const pool = createPool({ endpoints: [{ ...a1, expiry: 1001 }, a2, b1], selection: "balanced", sendFor, random: () => 0, now: () => now });
    expect(await pool.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe(a1.id);
    now += 1000;
    expect(await pool.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe(a2.id);
    expect(pool.status()[0]!.state).toBe("expired");
    expect(pool.status()[1]!.operatorObservations?.failures).toBe(0);
  });

  it("bounds group observations to 32 actual outcomes, retaining completion order across nodes", async () => {
    let now = 1_000_000, randoms: number[] = [];
    const pool = createPool({ endpoints: [a1, a2], sendFor, random: () => randoms.shift() ?? 0, now: () => now });
    for (let index = 0; index < 40; index++) {
      randoms = [0, index % 2 ? 0.99 : 0];
      await pool.run(async () => { now += index + 1; });
    }
    const statuses = pool.status();
    expect(statuses.map(endpoint => endpoint.observations?.attempts)).toEqual([20, 20]);
    expect(statuses[0]!.operatorObservations).toMatchObject({ attempts: 32, successes: 32, meanVerifiedMs: 24.5 });
    expect(statuses[1]!.operatorObservations).toEqual(statuses[0]!.operatorObservations);
    now += 300_001;
    expect(pool.status().every(endpoint => !endpoint.operatorObservations)).toBe(true);
  });

  it("does not reward additional nodes by summing their reliable scores", async () => {
    let now = 1_000_000, randoms: number[] = [];
    const pool = createPool({ endpoints: [a1, a2, b1], sendFor, random: () => randoms.shift() ?? 0.5, now: () => now });
    // A has two successful reads distributed over two nodes; B has three on one node.
    for (const sequence of [[0, 0], [0, 0.99], [0.99], [0.99], [0.99]]) {
      randoms = sequence;
      await pool.run(async () => { now += 10; });
    }
    pool.setSelection("reliable"); randoms = [0.5, 0];
    expect(await pool.run(async (_send, context) => operatorKey(context.endpoint))).toBe("b.derpc.eth");
  });

  it("preserves an account's owner after removing its node when an unchanged sibling remains", async () => {
    const old = createPool({ endpoints: [a1, a2, b1], sendFor, random: () => 0 });
    expect(await old.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe(a1.id);
    const replacement = createPool({
      endpoints: [a2, b1], selection: "fastest", preserveFrom: { pool: old, ids: [a2.id!, b1.id!] }, sendFor, random: () => 0.99,
    });
    expect(await replacement.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe(a2.id);
  });

  it("forgets changed-node samples and refuses continuity into a different owner", async () => {
    const old = createPool({ endpoints: [a1, a2, b1], sendFor, random: () => 0 });
    await old.run(async () => 42, { account: "alice" });
    const rotated = { ...a1, url: "https://rotated.example" };
    const replacement = createPool({
      endpoints: [rotated, a2, b1], selection: "balanced", preserveFrom: { pool: old, ids: [a1.id!, a2.id!, b1.id!] }, sendFor, random: () => 0.99,
    });
    expect(replacement.status()[0]!.observations).toBeUndefined();
    expect(replacement.status()[0]!.operatorObservations).toBeUndefined();
    expect(await replacement.run(async (_send, context) => operatorKey(context.endpoint), { account: "alice" })).toBe("a.derpc.eth");

    const moved = { ...a1, operatorId: "different.derpc.eth", ens: "different.derpc.eth" };
    const different = createPool({
      endpoints: [moved, b1], selection: "balanced", preserveFrom: { pool: old, ids: [a1.id!, b1.id!] }, sendFor, random: () => 0.99,
    });
    expect(different.status()[0]!.observations).toBeUndefined();
    expect(await different.run(async (_send, context) => context.endpoint.id, { account: "alice" })).toBe(b1.id);
  });

  it("retains only approved owner affinity when every node URL rotates", async () => {
    let now = 1_000_000;
    const old = createPool({ endpoints: [a1, a2, b1], sendFor, random: () => 0, now: () => now });
    await old.run(async (_send, context) => {
      now += 10;
      if (context.endpoint.id === a1.id) throw new ProofVerificationError("old node corrupt");
    }, { account: "alice" });
    expect(old.status()[0]!.state).toBe("excluded");
    const rotated = [a1, a2].map(endpoint => ({ ...endpoint, url: `${endpoint.url}/replacement` }));
    const replacement = createPool({
      endpoints: [...rotated, b1], selection: "balanced", sendFor, random: () => 0.99, now: () => now,
      preserveFrom: { pool: old, ids: [b1.id!], operatorIds: ["a.derpc.eth"] },
    });
    expect(replacement.status().every(endpoint => endpoint.state === "eligible" && !endpoint.observations && !endpoint.operatorObservations)).toBe(true);
    expect(await replacement.run(async (_send, context) => operatorKey(context.endpoint), { account: "alice" })).toBe("a.derpc.eth");

    const unapproved = createPool({
      endpoints: [...rotated, b1], selection: "balanced", sendFor, random: () => 0.99, now: () => now,
      preserveFrom: { pool: old, ids: [b1.id!] },
    });
    expect(await unapproved.run(async (_send, context) => operatorKey(context.endpoint), { account: "alice" })).toBe("b.derpc.eth");
  });

  it("refuses owner-affinity approvals for removed groups or changed ENS bindings", async () => {
    const old = createPool({ endpoints: [a1, a2, b1], sendFor, random: () => 0 });
    await old.run(async () => 42, { account: "alice" });
    for (const next of [[b1], [{ ...a1, ens: "changed.derpc.eth", url: "https://changed.example" }, b1]]) {
      const replacement = createPool({
        endpoints: next, selection: "balanced", sendFor, random: () => 0.99,
        preserveFrom: { pool: old, ids: [b1.id!], operatorIds: ["a.derpc.eth"] },
      });
      expect(await replacement.run(async (_send, context) => operatorKey(context.endpoint), { account: "alice" })).toBe("b.derpc.eth");
    }
  });

  it("rejects ambiguous owners and node aliases in automatic pools", () => {
    const malformed: PoolEndpoint[][] = [
      [a1, { ...a2, operatorId: "other" }], // the same ENS cannot create two owner weights
      [a1, { ...b1, operatorId: a1.id! }], // another owner's key cannot reuse a node id
      [a1, { ...b1, operatorId: "A.DERPC.ETH" }], // aliases are case insensitive
      [a1, { ...a2, endpointId: "ONE" }],
      [a1, { ...a2, endpointId: undefined }], // no mixed legacy/plural group
      [a1, { ...a2, operator: "another owner" }],
      [a1, { ...a2, url: a1.url }],
      [{ ...a1, operatorId: undefined }], // node identities require an explicit owner
    ];
    for (const endpoints of malformed) expect(() => createPool({ endpoints, selection: "balanced", sendFor })).toThrow("automatic selection requires");
    expect(() => createPool({ endpoints: [a1, a2, b1], selection: "balanced", sendFor })).not.toThrow();
  });
});
