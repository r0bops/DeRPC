import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { namehash } from "viem/ens";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import type { Hex } from "../../src/verify/hex.ts";
import { InputError } from "../../src/verify/reader.ts";
import { ProofVerificationError, type AccountProof } from "../../src/verify/index.ts";
import { CallRevertedError, createVerifiedExecutor, ExecutionLimitError, UnsupportedExecutionError, type VerifiedCallInput } from "../../src/execution/verified-call.ts";
import { EnsBlockChangedError, EnsResolutionError, MAINNET_ENS_UNIVERSAL_RESOLVER_V2, resolveVerifiedEns, type VerifiedEnsLimits, type VerifiedEnsRecord } from "../../src/execution/verified-ens.ts";
import { IMPLEMENTATION, provenFixture, TARGET, word } from "./proven-fixture.ts";

// Exact public ABI signatures from the pinned official UniversalResolverV2 artifact and ENS profiles.
const universalAbi = parseAbi(["function resolveWithGateways(bytes name,bytes data,string[] gateways) view returns (bytes,address)"]);
const profiles = parseAbi([
  "function addr(bytes32 node) view returns(address)",
  "function addr(bytes32 node,uint256 coinType) view returns(bytes)",
  "function text(bytes32 node,string key) view returns(string)",
  "function contenthash(bytes32 node) view returns(bytes)",
]);
const addressAbi = parseAbi(["function addr(bytes32 node) view returns(address)"]);
const coinAbi = parseAbi(["function addr(bytes32 node,uint256 coinType) view returns(bytes)"]);
const textAbi = parseAbi(["function text(bytes32 node,string key) view returns(string)"]);
const contentAbi = parseAbi(["function contenthash(bytes32 node) view returns(bytes)"]);
const addressResult = encodeFunctionResult({ abi: addressAbi, functionName: "addr", result: TARGET });
const responseFor = (result: Hex, resolver: Hex = IMPLEMENTATION) => encodeFunctionResult({ abi: universalAbi, functionName: "resolveWithGateways", result: [result, resolver] });

async function unitContext(result: Hex = addressResult) {
  const { block } = await provenFixture([]);
  const headers = { finalized: vi.fn(() => block), assertFresh: vi.fn() };
  const verifiedCall = vi.fn(async (_input: VerifiedCallInput) => ({ value: responseFor(result), block }));
  return { block, headers, verifiedCall };
}

describe("verified ENS resolution protocol", () => {
  it.each([
    ["ViTaLiK.EtH", "vitalik.eth"],
    ["e\u0301.eth", "é.eth"],
    ["RaFFY🚴‍♂️.eTh", "raffy🚴‍♂.eth"],
    ["sub.example.com", "sub.example.com"],
  ])("normalizes %s and resolves once through the pinned deployment", async (input, normalized) => {
    const context = await unitContext();
    const result = await resolveVerifiedEns({ headers: context.headers, verifiedCall: context.verifiedCall, name: input });
    expect(result).toEqual({ normalizedName: normalized, resolver: IMPLEMENTATION, record: { type: "address" }, value: TARGET, block: context.block });
    expect(context.verifiedCall).toHaveBeenCalledOnce();
    expect(context.headers.finalized).toHaveBeenCalledOnce();
    const call = context.verifiedCall.mock.calls[0]![0];
    expect(call.to).toBe(MAINNET_ENS_UNIVERSAL_RESOLVER_V2);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    const decoded = decodeFunctionData({ abi: universalAbi, data: call.data! });
    const expectedDns = `0x${normalized.split(".").map(label => {
      const bytes = new TextEncoder().encode(label);
      return bytes.length.toString(16).padStart(2, "0") + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }).join("")}00`;
    expect(decoded.args[0]).toBe(expectedDns);
    expect(decoded.args[2]).toEqual([]);
    expect(decodeFunctionData({ abi: profiles, data: decoded.args[1] })).toMatchObject({ functionName: "addr", args: [namehash(normalized)] });
  });

  it.each([
    [{ type: "text", key: "url" }, "https://example.com", encodeFunctionResult({ abi: textAbi, functionName: "text", result: "https://example.com" })],
    [{ type: "text", key: "description" }, "", encodeFunctionResult({ abi: textAbi, functionName: "text", result: "" })],
    [{ type: "contenthash" }, "0xe30101701220", encodeFunctionResult({ abi: contentAbi, functionName: "contenthash", result: "0xe30101701220" })],
    [{ type: "coinAddress", coinType: 0n }, "0x001122", encodeFunctionResult({ abi: coinAbi, functionName: "addr", result: "0x001122" })],
    [{ type: "address" }, `0x${"00".repeat(20)}`, word(0n)],
  ] as [VerifiedEnsRecord, string, Hex][])("decodes the %o profile without fetching its contents", async (record, expected, encoded) => {
    const { headers, verifiedCall } = await unitContext(encoded);
    const result = await resolveVerifiedEns({ headers, verifiedCall, name: "name.eth", record });
    expect(result.value).toBe(expected);
    expect(result.record).toEqual(record);
    expect(verifiedCall).toHaveBeenCalledOnce();
  });

  it.each(["раypal.eth", "bad..eth", ".eth", "name.eth.", `bad\u0000name.eth`, `[${"a".repeat(64)}].eth`])("rejects invalid or encoded-label input %s before execution", async name => {
    const { headers, verifiedCall } = await unitContext();
    await expect(resolveVerifiedEns({ name, headers, verifiedCall })).rejects.toBeInstanceOf(InputError);
    expect(headers.finalized).not.toHaveBeenCalled();
    expect(verifiedCall).not.toHaveBeenCalled();
  });

  it("refuses labels that cannot be encoded without substituting a labelhash", async () => {
    const { headers, verifiedCall } = await unitContext();
    await expect(resolveVerifiedEns({ name: `${"a".repeat(256)}.eth`, headers, verifiedCall })).rejects.toBeInstanceOf(UnsupportedExecutionError);
    expect(verifiedCall).not.toHaveBeenCalled();
  });

  it.each([
    ["null profile", null], ["unknown profile", { type: "dns" }],
    ["unknown profile option", { type: "address", coinType: 60n }],
    ["negative coin type", { type: "coinAddress", coinType: -1n }],
    ["noninteger coin type", { type: "coinAddress", coinType: 60 }],
    ["oversized coin type", { type: "coinAddress", coinType: 1n << 256n }],
    ["invalid key Unicode", { type: "text", key: "\ud800" }],
  ])("refuses %s before reading headers", async (_description, record) => {
    const { headers, verifiedCall } = await unitContext();
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall, record: record as VerifiedEnsRecord })).rejects.toBeInstanceOf(InputError);
    expect(headers.finalized).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied unverified resolver override", async () => {
    const { headers, verifiedCall } = await unitContext();
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall, resolver: TARGET } as never)).rejects.toBeInstanceOf(InputError);
    expect(verifiedCall).not.toHaveBeenCalled();
  });

  it.each([
    { blockHash: `0x${"ff".repeat(32)}` }, { stateRoot: `0x${"ff".repeat(32)}` },
    { blockNumber: 1 }, { timestamp: 1 }, { slot: 1 }, { network: "hoodi" },
  ])("refuses mixed block context %j", async override => {
    const { headers, block } = await unitContext();
    const verifiedCall = vi.fn(async () => ({ value: responseFor(addressResult), block: { ...block, ...override } as VerifiedHeader }));
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall })).rejects.toBeInstanceOf(EnsBlockChangedError);
  });

  it("refuses changed execution context even when block number/hash/root claims match", async () => {
    const { headers, block } = await unitContext();
    const verifiedCall = vi.fn(async () => ({ value: responseFor(addressResult), block: { ...block, execution: { ...block.execution!, baseFeePerGas: 0n } } }));
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall })).rejects.toBeInstanceOf(EnsBlockChangedError);
  });

  it("snapshots a mutable header instead of letting mutation change its comparison anchor", async () => {
    const { headers, block } = await unitContext();
    const verifiedCall = vi.fn(async () => {
      block.stateRoot = `0x${"ff".repeat(32)}`;
      return { value: responseFor(addressResult), block };
    });
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall })).rejects.toBeInstanceOf(EnsBlockChangedError);
  });

  it("checks freshness again before accepting a resolved record", async () => {
    const { headers, verifiedCall } = await unitContext();
    const stale = new Error("authenticated header expired");
    headers.assertFresh.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw stale; });
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall })).rejects.toBe(stale);
  });

  it("requires authenticated mainnet execution context before invoking the executor", async () => {
    const { headers, block, verifiedCall } = await unitContext();
    block.execution = undefined;
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall })).rejects.toBeInstanceOf(UnsupportedExecutionError);
    expect(verifiedCall).not.toHaveBeenCalled();
  });

  it.each(["0x", `${responseFor(addressResult)}00`, responseFor("0x"), responseFor(addressResult, `0x${"00".repeat(20)}`)])("rejects malformed/noncanonical result %s", async value => {
    const { headers, block } = await unitContext();
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall: async () => ({ value: value as Hex, block }) })).rejects.toBeInstanceOf(EnsResolutionError);
  });

  it("refuses an OffchainLookup without invoking a callback or gateway", async () => {
    const { headers } = await unitContext();
    const verifiedCall = vi.fn(async () => { throw new CallRevertedError("0x556f1830", "offchain lookup"); });
    await expect(resolveVerifiedEns({ name: "offchain.eth", headers, verifiedCall })).rejects.toBeInstanceOf(UnsupportedExecutionError);
    expect(verifiedCall).toHaveBeenCalledOnce();
  });
});

describe("verified ENS bounds", () => {
  it.each([
    [{ inputCharacters: 3 }, undefined], [{ labels: 1 }, undefined], [{ nameBytes: 4 }, undefined],
    [{ calldataBytes: 32 }, undefined], [{ textKeyBytes: 2 }, { type: "text", key: "🚀" }],
  ] as [Partial<VerifiedEnsLimits>, VerifiedEnsRecord | undefined][])("bounds input using %j", async (limits, record) => {
    const { headers, verifiedCall } = await unitContext();
    await expect(resolveVerifiedEns({ name: "name.eth", record, headers, verifiedCall, limits })).rejects.toBeInstanceOf(ExecutionLimitError);
    expect(verifiedCall).not.toHaveBeenCalled();
  });

  it("bounds ABI response bytes before decoding", async () => {
    const { headers, verifiedCall } = await unitContext();
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall, limits: { resultBytes: 32 } })).rejects.toBeInstanceOf(ExecutionLimitError);
  });

  it("bounds a noncooperative injected executor with one whole-resolution deadline", async () => {
    const { headers } = await unitContext();
    const verifiedCall = vi.fn(async () => new Promise<never>(() => {}));
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall, limits: { timeoutMs: 5 } })).rejects.toBeInstanceOf(ExecutionLimitError);
    expect(verifiedCall).toHaveBeenCalledOnce();
    expect((verifiedCall.mock.calls[0] as unknown as [VerifiedCallInput])[0].signal?.aborted).toBe(true);
  });

  it("cancels before reading headers or dispatching execution", async () => {
    const { headers, verifiedCall } = await unitContext();
    const controller = new AbortController();
    const reason = new Error("user cancelled resolution");
    controller.abort(reason);
    await expect(resolveVerifiedEns({ name: "name.eth", headers, verifiedCall, signal: controller.signal })).rejects.toBe(reason);
    expect(headers.finalized).not.toHaveBeenCalled();
    expect(verifiedCall).not.toHaveBeenCalled();
  });
});

describe("verified ENS generated proof boundary", () => {
  // Original small ABI fixture: encode (bytes(address stored in slot 0), resolver). This validates
  // the proof-to-helper boundary; the separate recorded mainnet test executes real ENS bytecode.
  const code: Hex = `0x604060005273${IMPLEMENTATION.slice(2)}602052602060405260005460605260806000f3`;
  it("decodes a result produced by local EVM execution using a genuinely proven slot", async () => {
    const fixture = await provenFixture([{ address: MAINNET_ENS_UNIVERSAL_RESOLVER_V2, code, storage: { 0: BigInt(TARGET) } }]);
    const executor = createVerifiedExecutor({ headers: fixture.headers, send: fixture.endpoint() });
    const result = await resolveVerifiedEns({ name: "example.eth", headers: fixture.headers, verifiedCall: executor.call });
    expect(result.value).toBe(TARGET);
    expect(result.resolver).toBe(IMPLEMENTATION);
    expect(result.block.stateRoot).toBe(fixture.block.stateRoot);
    expect(fixture.calls.every(call => ["eth_getProof", "eth_getCode"].includes(call.method))).toBe(true);
  });

  it("rejects a forged touched slot instead of returning a fabricated ENS value", async () => {
    const fixture = await provenFixture([{ address: MAINNET_ENS_UNIVERSAL_RESOLVER_V2, code, storage: { 0: BigInt(TARGET) } }]);
    const send = fixture.endpoint((request, response) => {
      if (request.method === "eth_getProof" && (request.params[1] as Hex[]).length) (response as AccountProof).storageProof[0]!.value = "0x01";
      return response;
    });
    const executor = createVerifiedExecutor({ headers: fixture.headers, send });
    await expect(resolveVerifiedEns({ name: "example.eth", headers: fixture.headers, verifiedCall: executor.call })).rejects.toBeInstanceOf(ProofVerificationError);
  });
});
