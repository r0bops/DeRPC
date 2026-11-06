import { describe, expect, it, vi } from "vitest";
import {
  CallRevertedError, createVerifiedExecutor, ExecutionLimitError,
  UnsupportedExecutionError, type ExecutionLimits, type VerifiedCallInput,
} from "../../src/execution/verified-call.ts";
import { InputError } from "../../src/verify/reader.ts";
import { ProofVerificationError, type AccountProof } from "../../src/verify/index.ts";
import type { Hex } from "../../src/verify/hex.ts";
import {
  delegateThen, IMPLEMENTATION, LOAD_SLOT_ZERO, provenFixture, RETURN_42, TARGET, THIRD, word, ZERO,
} from "./proven-fixture.ts";

describe("verified call runtime input validation", () => {
  it.each([
    ["null", null], ["array", []], ["missing object", undefined],
    ["value", { to: TARGET, value: 1n }],
    ["gasPrice", { to: TARGET, gasPrice: 1n }],
    ["input alias", { to: TARGET, input: "0x1234" }],
    ["blockTag", { to: TARGET, blockTag: "latest" }],
    ["state override", { to: TARGET, stateOverrides: {} }],
    ["block override", { to: TARGET, blockOverrides: {} }],
    ["null data", { to: TARGET, data: null }],
    ["numeric gas", { to: TARGET, gas: 30_000 }],
    ["invalid signal", { to: TARGET, signal: {} }],
    ["symbol field", { to: TARGET, [Symbol("value")]: 1n }],
    ["non-enumerable value", Object.defineProperty({ to: TARGET }, "value", { value: 1n })],
  ])("refuses %s before reading a header or sending a request", async (_label, input) => {
    const finalized = vi.fn(() => { throw new Error("must not read headers for invalid calls"); });
    const send = vi.fn();
    const executor = createVerifiedExecutor({ headers: { finalized }, send });
    await expect(executor.call(input as VerifiedCallInput)).rejects.toBeInstanceOf(InputError);
    expect(finalized).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("proof-backed local EVM execution", () => {
  it("executes a storage read against one authenticated block, proving absent caller and touched slot", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: LOAD_SLOT_ZERO, storage: { 0: 73n } }]);
    const finalized = vi.fn(() => fixture.block);
    const fresh = vi.fn();
    const executor = createVerifiedExecutor({ headers: { finalized, assertFresh: fresh }, send: fixture.endpoint() });

    const result = await executor.call({ to: TARGET });

    expect(result).toEqual({ value: word(73n), block: fixture.block });
    expect(finalized).toHaveBeenCalledOnce();
    expect(fresh).toHaveBeenCalledWith(fixture.block);
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === ZERO)).toBe(true);
    expect(fixture.calls.some(call => call.method === "eth_getProof" && (call.params[1] as Hex[]).includes(word(0n)))).toBe(true);
    expect(fixture.calls.every(call => ["eth_getProof", "eth_getCode"].includes(call.method))).toBe(true);
    expect(new Set(fixture.calls.map(call => call.params.at(-1)))).toEqual(new Set(["0x15752a0"]));
    expect(new Set(fixture.calls.map(call => call.isolationKey))).toEqual(new Set([`derpc:call:${TARGET}`]));
    expect(fixture.calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
  });

  it("proves storage non-membership instead of inventing an empty slot", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: LOAD_SLOT_ZERO, storage: { 1: 81n } }]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe(word(0n));
    expect(fixture.calls.filter(call => call.method === "eth_getProof" && (call.params[1] as Hex[]).length)).toHaveLength(1);
  });

  it("returns empty code only after proving target account absence", async () => {
    const fixture = await provenFixture([{ address: IMPLEMENTATION, code: RETURN_42 }]);
    const result = await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET });
    expect(result.value).toBe("0x");
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === TARGET)).toBe(true);
    expect(fixture.calls.some(call => call.method === "eth_getCode")).toBe(false);
  });

  it("proves absent accounts touched by BALANCE", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: `0x73${THIRD.slice(2)}3160005260206000f3` }]);
    const result = await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET });
    expect(result.value).toBe(word(0n));
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === THIRD)).toBe(true);
  });

  it("distinguishes EXTCODEHASH for an absent account from an existing empty account", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: `0x73${THIRD.slice(2)}3f60005273${IMPLEMENTATION.slice(2)}3f60205260406000f3` },
      { address: IMPLEMENTATION, balance: 1n },
    ]);
    const result = await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET });
    expect(result.value).toBe(`${word(0n)}c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`);
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === THIRD)).toBe(true);
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === IMPLEMENTATION)).toBe(true);
  });

  it("rejects code that does not match the proven account codeHash", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: LOAD_SLOT_ZERO }]);
    const send = fixture.endpoint((request, response) => request.method === "eth_getCode" ? RETURN_42 : response);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send }).call({ to: TARGET })).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("rejects a lying value in the touched slot even when the trie proof is genuine", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: LOAD_SLOT_ZERO, storage: { 0: 73n } }]);
    const send = fixture.endpoint((request, response) => {
      if (request.method === "eth_getProof" && (request.params[1] as Hex[]).length) {
        (response as AccountProof).storageProof[0]!.value = "0x4a";
      }
      return response;
    });
    await expect(createVerifiedExecutor({ headers: fixture.headers, send }).call({ to: TARGET })).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("rejects a real proof rooted in another state, even if it names the requested address", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: LOAD_SLOT_ZERO, storage: { 0: 73n } }]);
    const fork = await provenFixture([{ address: TARGET, code: LOAD_SLOT_ZERO, storage: { 0: 99n } }]);
    const send = fixture.endpoint((request, response) => request.method === "eth_getProof" && request.params[0] === TARGET
      ? fork.proof(TARGET, request.params[1] as Hex[]) : response);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send }).call({ to: TARGET })).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("executes nested DELEGATECALL using the proxy's proven storage", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: delegateThen(IMPLEMENTATION), storage: { 0: 73n } },
      { address: IMPLEMENTATION, code: delegateThen(THIRD), storage: { 0: 999n } },
      { address: THIRD, code: LOAD_SLOT_ZERO, storage: { 0: 888n } },
    ]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe(word(73n));
    const slotRequests = fixture.calls.filter(call => call.method === "eth_getProof" && (call.params[1] as Hex[]).length);
    expect(slotRequests.map(call => call.params[0])).toEqual([TARGET]);
    expect(fixture.calls.filter(call => call.method === "eth_getCode").map(call => call.params[0])).toEqual([TARGET, IMPLEMENTATION, THIRD]);
  });

  it("rematerializes a proven slot after a child read is reverted", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: delegateThen(IMPLEMENTATION, LOAD_SLOT_ZERO.slice(2)), storage: { 0: 73n } },
      { address: IMPLEMENTATION, code: "0x6000545060006000fd" },
    ]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe(word(73n));
    expect(fixture.calls.filter(call => call.method === "eth_getProof" && (call.params[1] as Hex[]).length)).toHaveLength(1);
  });

  it("never turns a nested proof failure into a catchable EVM failure", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: delegateThen(IMPLEMENTATION), storage: { 0: 73n } },
      { address: IMPLEMENTATION, code: LOAD_SLOT_ZERO },
    ]);
    const send = fixture.endpoint((request, response) => {
      if (request.method === "eth_getProof" && (request.params[1] as Hex[]).length) {
        (response as AccountProof).storageProof[0]!.proof = [];
      }
      return response;
    });
    await expect(createVerifiedExecutor({ headers: fixture.headers, send }).call({ to: TARGET })).rejects.toBeInstanceOf(ProofVerificationError);
  });

  it("does not swallow nested transport errors", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: delegateThen(IMPLEMENTATION) },
      { address: IMPLEMENTATION, code: LOAD_SLOT_ZERO },
    ]);
    const transportFailure = new Error("anonymous transport unavailable");
    const send = fixture.endpoint((request, response) => {
      if (request.method === "eth_getProof" && (request.params[1] as Hex[]).length) throw transportFailure;
      return response;
    });
    await expect(createVerifiedExecutor({ headers: fixture.headers, send }).call({ to: TARGET })).rejects.toBe(transportFailure);
  });

  it("uses proven delegation code and the delegating account's storage for EIP-7702", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: `0xef0100${IMPLEMENTATION.slice(2)}`, storage: { 0: 73n } },
      { address: IMPLEMENTATION, code: LOAD_SLOT_ZERO, storage: { 0: 999n } },
    ]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe(word(73n));
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === IMPLEMENTATION)).toBe(true);
    expect(fixture.calls.some(call => call.method === "eth_getCode" && call.params[0] === IMPLEMENTATION)).toBe(true);
  });

  it("proves absence when an EIP-7702 delegation points to an account without code", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: `0xef0100${THIRD.slice(2)}` }]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe("0x");
    expect(fixture.calls.some(call => call.method === "eth_getProof" && call.params[0] === THIRD)).toBe(true);
    expect(fixture.calls.some(call => call.method === "eth_getCode" && call.params[0] === THIRD)).toBe(false);
  });

  it("simulates storage writes locally without leaking state into later calls", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: "0x6000546001018060005560005260206000f3", storage: { 0: 73n } }]);
    const executor = createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() });
    expect((await executor.call({ to: TARGET })).value).toBe(word(74n));
    expect((await executor.call({ to: TARGET })).value).toBe(word(74n));
  });

  it("uses authenticated block context for all supported environmental opcodes", async () => {
    const opcodes = ["41", "42", "43", "44", "45", "46", "48", "32", "33", "34", "3a", "600049"];
    const assembled: Hex = `0x${opcodes.map((opcode, i) => `${opcode}61${(i * 32).toString(16).padStart(4, "0")}52`).join("")}6101806000f3`;
    const fixture = await provenFixture([{ address: TARGET, code: assembled }]);
    const context = fixture.block.execution!;
    const expected = [BigInt(context.feeRecipient), BigInt(fixture.block.timestamp), BigInt(fixture.block.blockNumber),
      BigInt(context.prevRandao), context.gasLimit, 1n, context.baseFeePerGas, BigInt(THIRD), BigInt(THIRD), 0n, 0n, 0n];
    const result = await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET, from: THIRD });
    expect(result.value).toBe(`0x${expected.map(value => word(value).slice(2)).join("")}`);
  });

  it.each([["BLOCKHASH", "0x60004060005260206000f3"], ["BLOBBASEFEE", "0x4a60005260206000f3"]] as const)("refuses unavailable authenticated %s context", async (_name, code) => {
    const fixture = await provenFixture([{ address: TARGET, code }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).rejects.toBeInstanceOf(UnsupportedExecutionError);
  });

  it("refuses missing payload context before any remote request", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const block = { ...fixture.block, execution: undefined };
    await expect(createVerifiedExecutor({ headers: { finalized: () => block }, send: fixture.endpoint() }).call({ to: TARGET })).rejects.toBeInstanceOf(UnsupportedExecutionError);
    expect(fixture.calls).toHaveLength(0);
  });

  it.each(["hoodi", undefined] as const)("refuses network %s before any remote request", async network => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const block = { ...fixture.block, network };
    await expect(createVerifiedExecutor({ headers: { finalized: () => block }, send: fixture.endpoint() }).call({ to: TARGET })).rejects.toBeInstanceOf(UnsupportedExecutionError);
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects OffchainLookup without making an offchain or eth_call request", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: "0x63556f183060e01b60005260046000fd" }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).rejects.toThrow(/CCIP-Read OffchainLookup/);
    expect(fixture.calls.every(call => ["eth_getProof", "eth_getCode"].includes(call.method))).toBe(true);
  });

  it("reports an ordinary contract revert with its exact return bytes", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: "0x602a60005260206000fd" }]);
    const result = createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET });
    await expect(result).rejects.toBeInstanceOf(CallRevertedError);
    await expect(result).rejects.toMatchObject({ data: word(42n) });
  });

  it.each([["invalid opcode", "0xfe"], ["stack underflow", "0x50"]] as const)("refuses %s instead of reporting a contract REVERT", async (_name, code) => {
    const fixture = await provenFixture([{ address: TARGET, code }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).rejects.toBeInstanceOf(UnsupportedExecutionError);
  });

  it("rejects a result if the pinned block became stale during execution", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const stale = new Error("pinned finalized block expired");
    const headers = { ...fixture.headers, assertFresh: () => { throw stale; } };
    await expect(createVerifiedExecutor({ headers, send: fixture.endpoint() }).call({ to: TARGET })).rejects.toBe(stale);
  });
});

describe("local execution resource bounds", () => {
  it.each([
    ["steps", { steps: 12 }, "0x5b600056"],
    ["accounts", { accounts: 1 }, RETURN_42],
    ["slots", { slots: 1 }, "0x6000545060015460005260206000f3"],
    ["round trips", { roundTrips: 1 }, RETURN_42],
    ["code bytes", { codeBytes: 1 }, RETURN_42],
    ["output bytes", { outputBytes: 16 }, RETURN_42],
    ["memory", { memoryBytes: 64 }, "0x602a60805260206000f3"],
  ] satisfies [string, Partial<ExecutionLimits>, Hex][])("enforces %s", async (_label, limits, code) => {
    const fixture = await provenFixture([{ address: TARGET, code, storage: { 0: 1n, 1: 2n } }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint(), limits }).call({ to: TARGET })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it("bounds memory expanded by the final RETURN instruction", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: "0x6101006000f3" }]);
    const limits = { memoryBytes: 64, outputBytes: 512 };
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint(), limits }).call({ to: TARGET })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it.each([
    ["RETURN size", `0x7f${"ff".repeat(32)}6000f3`],
    ["REVERT size", `0x7f${"ff".repeat(32)}6000fd`],
    ["MSTORE offset", `0x60017f${"ff".repeat(32)}52`],
  ] as [string, Hex][])("rejects a 256-bit %s before allocating memory", async (_label, code) => {
    const fixture = await provenFixture([{ address: TARGET, code }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint(), limits: { memoryBytes: 64 } }).call({ to: TARGET })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it("keeps a nested memory-limit violation fatal when its caller discards the result", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: delegateThen(IMPLEMENTATION) },
      { address: IMPLEMENTATION, code: `0x7f${"ff".repeat(32)}6000fd` },
    ]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint(), limits: { memoryBytes: 64 } }).call({ to: TARGET })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it("bounds nested call depth even when the caller ignores failure", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: delegateThen(IMPLEMENTATION) }, { address: IMPLEMENTATION, code: RETURN_42 }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint(), limits: { depth: 1 } }).call({ to: TARGET })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it("enforces transaction gas including intrinsic calldata cost", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const executor = createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() });
    await expect(executor.call({ to: TARGET, gas: 1_000_001n })).rejects.toBeInstanceOf(ExecutionLimitError);
    await expect(executor.call({ to: TARGET, gas: 21_000n, data: "0x01" })).rejects.toBeInstanceOf(ExecutionLimitError);
    expect(fixture.calls).toHaveLength(0);
  });

  it("halts a gas-exhausting loop without trusting a remote execution result", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: "0x5b600056" }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET, gas: 21_100n })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it("distinguishes insufficient local gas from a proven contract revert", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const executor = createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() });
    await expect(executor.call({ to: TARGET, gas: 21_003n })).rejects.toBeInstanceOf(ExecutionLimitError);
    expect((await executor.call({ to: TARGET, gas: 21_100n })).value).toBe(word(42n));
  });

  it("preserves a successful outer result after handled child gas exhaustion", async () => {
    const fixture = await provenFixture([
      // The parent deliberately limits the child to 100 gas, discards failure, then returns 42.
      { address: TARGET, code: `0x602060006000600073${IMPLEMENTATION.slice(2)}6064f450${RETURN_42.slice(2)}` },
      { address: IMPLEMENTATION, code: "0x5b600056" },
    ]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe(word(42n));
  });

  it("preserves a genuine outer REVERT after handled child gas exhaustion", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: `0x602060006000600073${IMPLEMENTATION.slice(2)}6064f45060006000fd` },
      { address: IMPLEMENTATION, code: "0x5b600056" },
    ]);
    const result = createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET });
    await expect(result).rejects.toBeInstanceOf(CallRevertedError);
    await expect(result).rejects.toMatchObject({ data: "0x" });
  });

  it("preserves a successful outer result after a handled child invalid opcode", async () => {
    const fixture = await provenFixture([
      { address: TARGET, code: delegateThen(IMPLEMENTATION, RETURN_42.slice(2)) },
      { address: IMPLEMENTATION, code: "0xfe" },
    ]);
    expect((await createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() }).call({ to: TARGET })).value).toBe(word(42n));
  });

  it("rejects over-limit calldata before remote requests", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    await expect(createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint(), limits: { inputBytes: 1 } }).call({ to: TARGET, data: "0x0102" })).rejects.toBeInstanceOf(ExecutionLimitError);
    expect(fixture.calls).toHaveLength(0);
  });

  it("aborts promptly when an endpoint ignores its cancellation signal", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const controller = new AbortController();
    const error = new Error("cancelled by caller");
    const send = fixture.endpoint(async () => {
      controller.abort(error);
      return new Promise(() => {});
    });
    await expect(createVerifiedExecutor({ headers: fixture.headers, send }).call({ to: TARGET, signal: controller.signal })).rejects.toBe(error);
  });

  it("times out a hung proof request without waiting for transport cooperation", async () => {
    const fixture = await provenFixture([{ address: TARGET, code: RETURN_42 }]);
    const send = fixture.endpoint(async () => new Promise(() => {}));
    await expect(createVerifiedExecutor({ headers: fixture.headers, send, limits: { timeoutMs: 30 } }).call({ to: TARGET })).rejects.toThrow(/timeout|deadline/i);
  });
});
