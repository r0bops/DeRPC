// Test utility: an execution endpoint that answers only the recorded mainnet requests, and records what it was asked.
import type { JsonRpcSend } from "../../src/verify/reader.ts";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };

type Hex = `0x${string}`;
const { HOLDER, WETH, holderSlot } = fixture.inputs;
export const BLOCK_TAG = "0x" + fixture.block.number.toString(16);

/** The block the recorded proofs belong to, as the light client would report it. */
export const RECORDED_HEADER: VerifiedHeader = {
  slot: 0,
  blockNumber: fixture.block.number,
  blockHash: fixture.block.hash as Hex,
  stateRoot: fixture.block.stateRoot as Hex,
  timestamp: Math.floor(fixture.capturedAt / 1000),
};

export interface RecordedCall {
  method: string;
  params: unknown[];
  isolationKey: string;
}

export function recordedEndpoint(tamper?: (method: string, result: any) => any) {
  const calls: RecordedCall[] = [];
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
