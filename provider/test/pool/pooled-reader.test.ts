// Verified reads through the pool, with the real verifier and real mainnet proofs.
import { describe, expect, it } from "vitest";
import { createPool } from "../../src/pool/pool.ts";
import { createPooledReader } from "../../src/pool/pooled-reader.ts";
import { InputError, type JsonRpcSend } from "../../src/verify/reader.ts";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };

type Hex = `0x${string}`;
const { HOLDER } = fixture.inputs;
const tagOf = (n: number) => "0x" + n.toString(16);
const header = (blockNumber: number): VerifiedHeader => ({
  slot: 0,
  blockNumber,
  blockHash: blockNumber === fixture.block.number ? (fixture.block.hash as Hex) : (`0x${"ab".repeat(32)}` as Hex),
  stateRoot: fixture.block.stateRoot as Hex,
  timestamp: Math.floor(fixture.capturedAt / 1000),
});

function endpoints(behaviour: Record<string, "honest" | "liar" | "down">) {
  const calls: { url: string; params: unknown[] }[] = [];
  const sendFor = ({ url }: { url: string }): JsonRpcSend => async (method, params) => {
    calls.push({ url, params });
    if (behaviour[url] === "down") throw new Error("exit circuit closed");
    if (method !== "eth_getProof" || JSON.stringify(params).toLowerCase() !== JSON.stringify([HOLDER, [], tagOf(fixture.block.number)]).toLowerCase()) {
      throw new Error(`no recorded answer for ${method} ${JSON.stringify(params)}`);
    }
    const proof = structuredClone(fixture.responses.holderAccount);
    if (behaviour[url] === "liar") proof.balance = "0xde0b6b3a7640000"; // claims 1 ETH
    return proof;
  };
  return { sendFor, calls };
}

describe("createPooledReader", () => {
  it("rejects a lying endpoint's answer, excludes it, and answers from an honest one", async () => {
    const eps = endpoints({ liar: "liar", honest: "honest" });
    const pool = createPool({ endpoints: [{ url: "liar", priority: 0 }, { url: "honest", priority: 0 }], sendFor: eps.sendFor, random: () => 0 });
    const reader = createPooledReader({ headers: { finalized: () => header(fixture.block.number) }, pool });

    const result = await reader.getBalance(HOLDER as Hex);

    expect(result.value).toBe(BigInt(fixture.reference.holderBalance));
    expect(eps.calls.map((c) => c.url)).toEqual(["liar", "honest"]);
    expect(pool.status().find((s) => s.url === "liar")?.state).toBe("excluded");
  });

  it("keeps an account's reads with the operator that served it", async () => {
    const eps = endpoints({ x: "honest", y: "honest" });
    const randoms = [0, 0.99];
    const pool = createPool({ endpoints: [{ url: "x", priority: 0 }, { url: "y", priority: 0 }], sendFor: eps.sendFor, random: () => randoms.shift() ?? 0 });
    const reader = createPooledReader({ headers: { finalized: () => header(fixture.block.number) }, pool });

    await reader.getBalance(HOLDER as Hex); //          random 0    → x
    await reader.getTransactionCount(HOLDER as Hex); // sticky      → x, although random would say y

    expect(eps.calls.map((c) => c.url)).toEqual(["x", "x"]);
  });

  it("serves a repeated read at the same verified block from cache, without asking again", async () => {
    const eps = endpoints({ honest: "honest" });
    const pool = createPool({ endpoints: [{ url: "honest", priority: 0 }], sendFor: eps.sendFor });
    const reader = createPooledReader({ headers: { finalized: () => header(fixture.block.number) }, pool });

    const first = await reader.getBalance(HOLDER as Hex);
    const second = await reader.getBalance(HOLDER as Hex);

    expect(second.value).toBe(first.value);
    expect(eps.calls).toHaveLength(1);
  });

  it("asks again once the verified block has moved on", async () => {
    const eps = endpoints({ honest: "honest" });
    const pool = createPool({ endpoints: [{ url: "honest", priority: 0 }], sendFor: eps.sendFor, maxAttempts: 1 });
    let block = fixture.block.number;
    const reader = createPooledReader({ headers: { finalized: () => header(block) }, pool });

    await reader.getBalance(HOLDER as Hex);
    block += 1;
    await reader.getBalance(HOLDER as Hex).catch(() => {}); // no recorded proof for the next block

    expect(eps.calls.map((c) => c.params[2])).toEqual([tagOf(fixture.block.number), tagOf(fixture.block.number + 1)]);
  });

  it("keeps every retry of one read pinned to the block the read started at", async () => {
    const eps = endpoints({ down: "down", honest: "honest" });
    const pool = createPool({ endpoints: [{ url: "down", priority: 0 }, { url: "honest", priority: 0 }], sendFor: eps.sendFor, random: () => 0 });
    let finalizedCalls = 0;
    const moving = {
      finalized: () => header(finalizedCalls++ === 0 ? fixture.block.number : fixture.block.number + 1),
    };
    const reader = createPooledReader({ headers: moving, pool });

    const result = await reader.getBalance(HOLDER as Hex);

    expect(result.block.blockNumber).toBe(fixture.block.number);
    expect(eps.calls.filter((c) => c.url === "honest").map((c) => c.params[2])).toEqual([tagOf(fixture.block.number)]);
  });

  it("rejects caller input before any operator is asked", async () => {
    const eps = endpoints({ honest: "honest" });
    const pool = createPool({ endpoints: [{ url: "honest", priority: 0 }], sendFor: eps.sendFor });
    const reader = createPooledReader({ headers: { finalized: () => header(fixture.block.number) }, pool });

    await expect(reader.getBalance("0x123" as Hex)).rejects.toBeInstanceOf(InputError);
    expect(eps.calls).toEqual([]);
  });
});
