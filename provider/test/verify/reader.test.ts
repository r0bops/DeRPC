// Verified reads: every value comes from a proof checked against the light client's verified
// finalized block. Expected values come from independent RPC calls recorded with the fixture.
import { describe, expect, it } from "vitest";
import { createVerifiedReader, type JsonRpcSend } from "../../src/verify/reader.ts";
import { ProofVerificationError } from "../../src/verify/index.ts";
import { StaleHeaderError, type VerifiedHeader } from "../../src/light-client/header-source.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };

type Hex = `0x${string}`;
const { HOLDER, WETH, holderSlot } = fixture.inputs;
const BLOCK_TAG = "0x" + fixture.block.number.toString(16);
const VERIFIED: VerifiedHeader = {
  slot: 0,
  blockNumber: fixture.block.number,
  blockHash: fixture.block.hash as Hex,
  stateRoot: fixture.block.stateRoot as Hex,
  timestamp: Math.floor(fixture.capturedAt / 1000),
};
const WETH_TOKEN = { symbol: "WETH", address: WETH as Hex, balanceSlot: 3, decimals: 18 };

/** A fake endpoint that answers exactly the recorded requests, and records what it was asked. */
function recordedEndpoint(tamper?: (method: string, result: any) => any) {
  const calls: { method: string; params: unknown[]; isolationKey: string }[] = [];
  const answers: [string, unknown[], unknown][] = [
    ["eth_getProof", [HOLDER, [], BLOCK_TAG], fixture.responses.holderAccount],
    ["eth_getProof", [WETH, [], BLOCK_TAG], { ...fixture.responses.wethWithSlots, storageProof: [] }],
    ["eth_getProof", [WETH, [holderSlot], BLOCK_TAG], { ...fixture.responses.wethWithSlots, storageProof: [fixture.responses.wethWithSlots.storageProof[0]] }],
    ["eth_getCode", [WETH, BLOCK_TAG], fixture.responses.wethCode],
  ];
  const send: JsonRpcSend = async (method, params, { isolationKey }) => {
    calls.push({ method, params, isolationKey });
    const hit = answers.find(([m, p]) => m === method && JSON.stringify(p).toLowerCase() === JSON.stringify(params).toLowerCase());
    if (!hit) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params)}`);
    const result = structuredClone(hit[2]);
    return tamper ? tamper(method, result) : result;
  };
  return { send, calls };
}

const verifiedHeaders = { finalized: () => VERIFIED };

describe("createVerifiedReader", () => {
  it("returns a proven ETH balance at the verified block, asking for that exact block under the account's key", async () => {
    const endpoint = recordedEndpoint();
    const reader = createVerifiedReader({ headers: verifiedHeaders, send: endpoint.send });

    const result = await reader.getBalance(HOLDER as Hex);

    expect(result.value).toBe(BigInt(fixture.reference.holderBalance));
    expect(result.block.blockNumber).toBe(fixture.block.number);
    expect(endpoint.calls).toEqual([
      { method: "eth_getProof", params: [HOLDER, [], BLOCK_TAG], isolationKey: `derpc:account:${HOLDER.toLowerCase()}` },
    ]);
  });

  it("returns the proven nonce", async () => {
    const reader = createVerifiedReader({ headers: verifiedHeaders, send: recordedEndpoint().send });

    expect((await reader.getTransactionCount(HOLDER as Hex)).value).toBe(BigInt(fixture.reference.holderNonce));
  });

  it("returns a proven WETH balance from the token's documented balance slot, under the holder's key", async () => {
    const endpoint = recordedEndpoint();
    const reader = createVerifiedReader({ headers: verifiedHeaders, send: endpoint.send });

    const result = await reader.getTokenBalance(WETH_TOKEN, HOLDER as Hex);

    expect(result.value).toBe(BigInt(fixture.reference.holderWethBalanceOf));
    expect(endpoint.calls[0]!.isolationKey).toBe(`derpc:account:${HOLDER.toLowerCase()}`);
  });

  it("returns contract code only after checking it against the proven code hash", async () => {
    const reader = createVerifiedReader({ headers: verifiedHeaders, send: recordedEndpoint().send });

    expect((await reader.getCode(WETH as Hex)).value).toBe(fixture.responses.wethCode);
  });

  it("rejects a lying endpoint's balance instead of returning it", async () => {
    const liar = recordedEndpoint((method, result) => (method === "eth_getProof" ? { ...result, balance: "0xde0b6b3a7640000" } : result));
    const reader = createVerifiedReader({ headers: verifiedHeaders, send: liar.send });

    await expect(reader.getBalance(HOLDER as Hex)).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("rejects altered contract code", async () => {
    const liar = recordedEndpoint((method, result) => (method === "eth_getCode" ? result.slice(0, -2) + "00" : result));
    const reader = createVerifiedReader({ headers: verifiedHeaders, send: liar.send });

    await expect(reader.getCode(WETH as Hex)).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("sends nothing when the verified header is stale", async () => {
    const endpoint = recordedEndpoint();
    const stale = { finalized: (): VerifiedHeader => { throw new StaleHeaderError("stale"); } };
    const reader = createVerifiedReader({ headers: stale, send: endpoint.send });

    await expect(reader.getBalance(HOLDER as Hex)).rejects.toBeInstanceOf(StaleHeaderError);
    expect(endpoint.calls).toEqual([]);
  });
});
