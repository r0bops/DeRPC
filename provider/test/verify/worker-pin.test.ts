// The worker boots from a local pin (no RPC at boot). Before any user read, DeRPC proves that the
// specifier contract's storage slot 1 (workerHash) equals that pin, against the light client's
// verified state, through the worker. Until then, and forever after a failure, reads are refused.
import { describe, expect, it } from "vitest";
import { createVerifiedReader, type JsonRpcSend, type VerifiedReader } from "../../src/verify/reader.ts";
import { ProofVerificationError } from "../../src/verify/index.ts";
import { checkWorkerPin, gateReader, WorkerPinChainError, WorkerPinMismatchError } from "../../src/verify/worker-pin.ts";
import { StaleHeaderError, type VerifiedHeader } from "../../src/light-client/header-source.ts";
import { TOR_JS_PIN, type WorkerPin } from "../../src/config/mainnet.ts";
import fixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };

type Hex = `0x${string}`;
const BLOCK_TAG = "0x" + fixture.block.number.toString(16);
const VERIFIED: VerifiedHeader = {
  slot: 0,
  blockNumber: fixture.block.number,
  blockHash: fixture.block.hash as Hex,
  stateRoot: fixture.block.stateRoot as Hex,
  timestamp: Math.floor(fixture.capturedAt / 1000),
};
const headers = { finalized: () => VERIFIED };

function specifierEndpoint(tamper?: (proof: any) => any) {
  const calls: { method: string; params: unknown[] }[] = [];
  const send: JsonRpcSend = async (method, params) => {
    calls.push({ method, params });
    const expected = JSON.stringify(["eth_getProof", [fixture.specifier, [fixture.slot], BLOCK_TAG]]).toLowerCase();
    if (JSON.stringify([method, params]).toLowerCase() !== expected) throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
    const proof = structuredClone(fixture.proof);
    return tamper ? tamper(proof) : proof;
  };
  return { send, calls };
}

describe("checkWorkerPin", () => {
  it("accepts the pin when the proven slot 1 equals the pinned workerHash", async () => {
    const reader = createVerifiedReader({ headers, send: specifierEndpoint().send });

    const result = await checkWorkerPin({ pin: TOR_JS_PIN, network: "mainnet", reader });

    expect(result.workerHash).toBe(fixture.reference.workerHash);
    expect(result.block.blockNumber).toBe(fixture.block.number);
  });

  it("rejects a pin that differs from the proven on-chain workerHash", async () => {
    const reader = createVerifiedReader({ headers, send: specifierEndpoint().send });
    const otherPin: WorkerPin = { ...TOR_JS_PIN, workerHash: `0x${"11".repeat(32)}` };

    await expect(checkWorkerPin({ pin: otherPin, network: "mainnet", reader })).rejects.toBeInstanceOf(WorkerPinMismatchError);
  });

  it("rejects when the endpoint's proof of slot 1 does not verify", async () => {
    const liar = specifierEndpoint((proof) => {
      proof.storageProof[0].value = TOR_JS_PIN.workerHash.replace(/.$/, "0"); // claims a different value
      return proof;
    });
    const reader = createVerifiedReader({ headers, send: liar.send });

    await expect(checkWorkerPin({ pin: TOR_JS_PIN, network: "mainnet", reader })).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("rejects without sending anything when the verified header is stale", async () => {
    const endpoint = specifierEndpoint();
    const stale = { finalized: (): VerifiedHeader => { throw new StaleHeaderError("stale"); } };
    const reader = createVerifiedReader({ headers: stale, send: endpoint.send });

    await expect(checkWorkerPin({ pin: TOR_JS_PIN, network: "mainnet", reader })).rejects.toBeInstanceOf(StaleHeaderError);
    expect(endpoint.calls).toEqual([]);
  });

  it("rejects a mainnet pin checked against another chain's state, before sending anything", async () => {
    const endpoint = specifierEndpoint();
    const reader = createVerifiedReader({ headers, send: endpoint.send });

    await expect(checkWorkerPin({ pin: TOR_JS_PIN, network: "hoodi", reader })).rejects.toBeInstanceOf(WorkerPinChainError);
    expect(endpoint.calls).toEqual([]);
  });
});

describe("gateReader", () => {
  function countingReader() {
    let calls = 0;
    const reader = {
      getBalance: async () => { calls++; return { value: 7n, block: VERIFIED }; },
    } as unknown as VerifiedReader;
    return { reader, calls: () => calls };
  }

  it("serves reads once the pin check has passed", async () => {
    const inner = countingReader();
    const gated = gateReader(inner.reader, Promise.resolve());

    await expect(gated.getBalance("0x0000000000000000000000000000000000000001")).resolves.toMatchObject({ value: 7n });
    expect(inner.calls()).toBe(1);
  });

  it("holds reads until the pin check settles", async () => {
    const inner = countingReader();
    let pass!: () => void;
    const gated = gateReader(inner.reader, new Promise<void>((resolve) => (pass = resolve)));

    const pending = gated.getBalance("0x0000000000000000000000000000000000000001");
    await new Promise((r) => setTimeout(r, 10));
    expect(inner.calls()).toBe(0);

    pass();
    await pending;
    expect(inner.calls()).toBe(1);
  });

  it("refuses every read with the check's error when the pin check fails, without reading", async () => {
    const inner = countingReader();
    const gated = gateReader(inner.reader, Promise.reject(new WorkerPinMismatchError("on-chain workerHash differs from the pin")));

    await expect(gated.getBalance("0x0000000000000000000000000000000000000001")).rejects.toBeInstanceOf(WorkerPinMismatchError);
    await expect(gated.getBalance("0x0000000000000000000000000000000000000002")).rejects.toBeInstanceOf(WorkerPinMismatchError);
    expect(inner.calls()).toBe(0);
  });
});
