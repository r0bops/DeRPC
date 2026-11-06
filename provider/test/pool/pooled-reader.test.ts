// Verified reads through the pool, with the real verifier and real mainnet proofs.
import { describe, expect, it } from "vitest";
import { createPool } from "../../src/pool/pool.ts";
import { createPooledReader } from "../../src/pool/pooled-reader.ts";
import type { JsonRpcSend } from "../../src/verify/reader.ts";
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

function endpoints(behaviour: Record<string, "honest" | "liar">) {
  const calls: { url: string; params: unknown[] }[] = [];
  const sendFor = ({ url }: { url: string }): JsonRpcSend => async (method, params) => {
    calls.push({ url, params });
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

  it.each(["initial result", "cache hit"])("isolates mutations of a returned %s from verified state", async returned => {
    const eps = endpoints({ honest: "honest" });
    let completions = 0;
    const pool = createPool({
      endpoints: [{ url: "honest", priority: 0 }], sendFor: eps.sendFor,
      prepareAttempt: async (_context, send) => ({ send, verified: async () => { completions++; } }),
    });
    // Keep one source-owned object, including execution context, to expose any shared references.
    const source: VerifiedHeader = {
      ...header(fixture.block.number), network: "mainnet",
      execution: {
        feeRecipient: `0x${"11".repeat(20)}`, prevRandao: `0x${"22".repeat(32)}`,
        gasLimit: 60_000_000n, baseFeePerGas: 1_000_000_000n, excessBlobGas: 0n,
      },
    };
    const expected = { value: BigInt(fixture.reference.holderBalance), block: structuredClone(source) };
    const reader = createPooledReader({ headers: { finalized: () => source }, pool });
    const first = await reader.getBalance(HOLDER as Hex);
    const exposed = returned === "cache hit" ? await reader.getBalance(HOLDER as Hex) : first;

    exposed.value = 999999999999999999999999n;
    Object.assign(exposed.block, {
      network: "hoodi", slot: 1, blockNumber: source.blockNumber + 1,
      blockHash: `0x${"ab".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`, timestamp: 0,
    });
    Object.assign(exposed.block.execution!, {
      feeRecipient: `0x${"33".repeat(20)}`, prevRandao: `0x${"44".repeat(32)}`,
      gasLimit: 1n, baseFeePerGas: 2n, excessBlobGas: 3n,
    });

    expect(source).toEqual(expected.block);
    expect(await reader.getBalance(HOLDER as Hex)).toEqual(expected);
    if (returned === "cache hit") expect(first).toEqual(expected);
    expect(eps.calls).toHaveLength(1);
    expect(completions).toBe(1); // cache isolation must not repeat a paid verification.
  });

  it("retains the proven block when the header source updates its object during completion", async () => {
    const eps = endpoints({ honest: "honest" });
    const source: VerifiedHeader = {
      ...header(fixture.block.number),
      execution: {
        feeRecipient: `0x${"11".repeat(20)}`, prevRandao: `0x${"22".repeat(32)}`,
        gasLimit: 60_000_000n, baseFeePerGas: 1_000_000_000n,
      },
    };
    const expected = { value: BigInt(fixture.reference.holderBalance), block: structuredClone(source) };
    const pool = createPool({
      endpoints: [{ url: "honest", priority: 0 }], sendFor: eps.sendFor,
      prepareAttempt: async (_context, send) => ({ send, verified: async () => {
        Object.assign(source, header(fixture.block.number + 1));
        source.execution!.baseFeePerGas = 2n;
      } }),
    });
    const reader = createPooledReader({ headers: { finalized: () => source }, pool });

    expect(await reader.getBalance(HOLDER as Hex)).toEqual(expected);
    expect(source.blockNumber).toBe(fixture.block.number + 1);
    // Revisit the old block to verify the stored result was also bound to the proof's block.
    Object.assign(source, structuredClone(expected.block));
    expect(await reader.getBalance(HOLDER as Hex)).toEqual(expected);
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
});
