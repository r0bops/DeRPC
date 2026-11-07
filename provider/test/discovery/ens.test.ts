// ENS metadata is a controlled ABI-response fixture; capability proofs are recorded mainnet data.
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, hexToBytes, keccak256, stringToHex, type Hex } from "viem";
import { discoverOperators, DiscoveryReadError, dnsName, registryAbi, resolverAbi, retainChosenOperators, RECORD_KEYS, type DiscoveryOptions } from "../../src/discovery/ens.ts";
import { CallRevertedError, createVerifiedExecutor, ExecutionLimitError, UnsupportedExecutionError, type ExecutionLimits } from "../../src/execution/verified-call.ts";
import { PoolExhaustedError } from "../../src/pool/pool.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import { NetworkUnavailableError, TransportUnavailableError, type AnonFetchOptions, type AnonTransport } from "../../src/transport/anon-transport.ts";
import { ProofVerificationError, type AccountProof } from "../../src/verify/index.ts";
import fixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };
import { registrarProofs } from "./proofs.ts";
import { serializeOperatorEndpoints, type OperatorEndpointRecord } from "../../src/operators/endpoints.ts";
import { provenFixture, RETURN_42 } from "../execution/proven-fixture.ts";

const addr = (byte: string) => `0x${byte.repeat(20)}` as Hex;
const ROOT = addr("a1"), SUB = addr("a2"), PARENT_RESOLVER = addr("b1"), SIGNER = addr("11"), OWNER = addr("22"), ESCROW = addr("33");
const now = Math.floor(fixture.capturedAt / 1000);
const HEADER: VerifiedHeader = { slot: 1, blockNumber: fixture.block.number, blockHash: fixture.block.hash as Hex, stateRoot: fixture.block.stateRoot as Hex, timestamp: now };
const decodeDns = (hex: Hex) => {
  const bytes = hexToBytes(hex), labels: string[] = [];
  for (let i = 0; i < bytes.length && bytes[i];) { const length = bytes[i++]!; labels.push(new TextDecoder().decode(bytes.slice(i, i + length))); i += length; }
  return labels.join(".");
};
const isBobsRecords = (to: Hex, data: Hex) => {
  if (to.toLowerCase() !== addr("b2")) return false;
  const decoded = decodeFunctionData({ abi: resolverAbi, data });
  return decoded.functionName === "resolve" && decodeDns(decoded.args[0]) === "bob.derpc.eth";
};

function setup(labels: unknown = ["alice", "bob"], header = HEADER) {
  const states = new Map<string, { status: number; expiry: bigint; latestOwner: Hex; tokenId: bigint; resource: bigint }>();
  const records = new Map<string, Record<string, string>>();
  const offchain = new Set<string>(), corrupted = new Set<string>(), wrongIdentity = new Set<string>();
  const identities = new Map<string, { ens: string; endpointId?: string }>();
  for (const [i, label] of ["derpc", "alice", "bob", "mallory"].entries()) {
    states.set(label, { status: 2, expiry: BigInt(now + 3600), latestOwner: OWNER, tokenId: BigInt(i + 1), resource: 0n });
    if (label !== "derpc") records.set(label, {
      "derpc.endpoint": `https://${label}.example/rpc`, "derpc.beacon": `https://${label}.example`, "derpc.signer": SIGNER,
      "derpc.caps": JSON.stringify({ chainId: 1, methods: ["eth_getProof", "eth_getCode"], beacon: true }), "derpc.gateways": "[]",
      "derpc.price": "1000", "derpc.payee": SIGNER, "derpc.paymentChain": "560048", "derpc.escrow": ESCROW,
    });
  }
  let index = labels;
  let capabilityProof = fixture.proof as AccountProof;
  function answer(to: Hex, data: Hex): Hex {
    if ([ROOT, SUB].includes(to.toLowerCase() as Hex)) {
      const decoded = decodeFunctionData({ abi: registryAbi, data });
      if (decoded.functionName === "getState") {
        const label = [...states.keys()].find(label => BigInt(keccak256(stringToHex(label))) === decoded.args[0]);
        if (!label) throw new Error("unknown label");
        return encodeFunctionResult({ abi: registryAbi, functionName: "getState", result: states.get(label)! });
      }
      if (decoded.functionName === "getSubregistry") return encodeFunctionResult({ abi: registryAbi, functionName: "getSubregistry", result: SUB });
      return encodeFunctionResult({ abi: registryAbi, functionName: "getResolver", result: decoded.args[0] === "derpc" ? PARENT_RESOLVER : addr("b2") });
    }
    const outer = decodeFunctionData({ abi: resolverAbi, data });
    if (outer.functionName !== "resolve") throw new Error("standalone resolver read forbidden");
    const name = decodeDns(outer.args[0]), label = name.split(".")[0]!;
    if (offchain.has(label)) throw new Error("OffchainLookup: https://attacker.example/ccip");
    const profile = (data: Hex): Hex => {
      const inner = decodeFunctionData({ abi: resolverAbi, data });
      if (inner.functionName === "multicall") return encodeFunctionResult({ abi: resolverAbi, functionName: "multicall", result: inner.args[0].map(profile) });
      if (inner.functionName !== "text") throw new Error("unsupported profile");
      const value = label === "derpc" ? JSON.stringify(index) : records.get(label)?.[inner.args[1]] ?? "";
      return encodeFunctionResult({ abi: resolverAbi, functionName: "text", result: value });
    };
    return encodeFunctionResult({ abi: resolverAbi, functionName: "resolve", result: profile(outer.args[1]) });
  }
  const fetches: { url: string; options: AnonFetchOptions }[] = [];
  const transport: AnonTransport = {
    pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => "ready", close: () => {},
    async fetch(url, options = {}) {
      options.signal?.throwIfAborted();
      fetches.push({ url, options });
      const label = new URL(url).hostname.split(".")[0]!;
      if (!options.body) return Response.json({ ...identities.get(label), ens: wrongIdentity.has(label) ? "not-this.derpc.eth" : identities.get(label)?.ens ?? `${label}.derpc.eth`, signer: SIGNER, chains: [1], version: "1", service: "demo-proxy" });
      const request = JSON.parse(String(options.body));
      if (request.method === "eth_getProof") {
        expect(request.params).toEqual([TOR_JS_PIN.specifier, ["0x1"], `0x${header.blockNumber.toString(16)}`]);
        const proof = structuredClone(capabilityProof);
        if (corrupted.has(label)) proof.balance = "0x1";
        return Response.json({ jsonrpc: "2.0", id: request.id, result: proof });
      }
      expect(url).toBe("https://bootstrap.example/");
      expect(request.method).toBe("eth_call");
      expect(request.params[1]).toBe(`0x${header.blockNumber.toString(16)}`);
      try { return Response.json({ jsonrpc: "2.0", id: request.id, result: answer(request.params[0].to, request.params[0].data) }); }
      catch (error) { return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: 3, message: (error as Error).message, data: "0x556f1830" } }); }
    },
  };
  const options: DiscoveryOptions = { transport, executionUrl: "https://bootstrap.example/", ethRegistry: ROOT, headers: { finalized: () => header, assertFresh: () => {} }, now: () => now * 1000 };
  return { options, answer, fetches, records, states, offchain, corrupted, wrongIdentity, identities, setIndex: (value: unknown) => { index = value; }, setCapabilityProof: (proof: AccountProof) => { capabilityProof = proof; } };
}

function publishNodes(test: ReturnType<typeof setup>, label: string, nodes: OperatorEndpointRecord[]) {
  const records = test.records.get(label)!;
  records["derpc.endpoints"] = serializeOperatorEndpoints(nodes);
  records["derpc.caps"] = JSON.stringify({ chainId: 1, methods: ["eth_getProof", "eth_getCode"] });
  for (const key of ["derpc.price", "derpc.payee", "derpc.paymentChain", "derpc.escrow"]) records[key] = "";
  for (const node of nodes) test.identities.set(new URL(node.url).hostname.split(".")[0]!, { ens: `${label}.derpc.eth`, endpointId: node.id });
}

// Metadata and Alice's identity remain controlled fixtures. Bob's refusal and
// the public capability proof use genuine generated tries and the real executor.
async function poisonedResolver(code: Hex, limits?: Partial<ExecutionLimits>) {
  const proven = await provenFixture([
    { address: addr("b2"), code, storage: { 0: 1n, 1: 2n } },
    { address: addr("b3"), code },
    { address: TOR_JS_PIN.specifier, storage: { 1: 1n } },
  ]);
  const test = setup(["alice", "bob"], proven.block);
  test.setCapabilityProof(await proven.proof(TOR_JS_PIN.specifier, ["0x1"]));
  const executor = createVerifiedExecutor({ headers: proven.headers, send: proven.endpoint(), limits });
  test.options.verifiedCall = async (to, data) => isBobsRecords(to, data)
    ? executor.call({ to, data }) : { value: test.answer(to, data), block: proven.block };
  return { ...test, proven, executor };
}

describe("open-registration resolver policy", () => {
  it.each([
    ["revert", "0x60006000fd", {}, /reverted/],
    ["offchain lookup", "0x63556f183060e01b60005260046000fd", {}, /CCIP-Read/],
    ["BLOCKHASH", "0x60004060005260206000f3", {}, /BLOCKHASH/],
    ["invalid opcode", "0xfe", {}, /halted/],
    ["steps", "0x5b600056", { steps: 12 }, /step limit/],
    ["gas", "0x5b600056", { gas: 100_000n }, /exhausted gas/],
    ["slots", "0x6000545060015400", { slots: 1 }, /storage-slot limit/],
    ["accounts", `0x73${addr("b3").slice(2)}3100`, { accounts: 2 }, /account limit/],
    ["round trips", "0x6000545060015400", { roundTrips: 4 }, /round-trip limit/],
    ["code bytes", RETURN_42, { codeBytes: 1 }, /code size limit/],
    ["output bytes", RETURN_42, { outputBytes: 16 }, /return data limit/],
    ["memory", "0x602a6120005260206000f3", { memoryBytes: 4096 }, /memory limit/],
  ] satisfies [string, Hex, Partial<ExecutionLimits>, RegExp][])('keeps the healthy candidate after a proven resolver %s refusal', async (_label, code, limits, reason) => {
    const test = await poisonedResolver(code, limits);
    const directory = await discoverOperators(test.options);
    expect(directory.operators.map(op => op.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.rejected).toEqual([{ name: "bob.derpc.eth", reason: expect.stringMatching(reason), kind: "resolver-policy" }]);
    expect(directory.recordVerification).toBe("proven");
    expect(test.fetches.filter(c => new URL(c.url).hostname === "alice.example")).toHaveLength(2);
    expect(test.fetches.some(c => new URL(c.url).hostname === "bob.example")).toBe(false);
    expect(test.proven.calls.every(c => ["eth_getProof", "eth_getCode"].includes(c.method))).toBe(true);
  });

  it.each(["target", "calldata", "caller", "gas", "block hash", "state root", "block number"])("refuses a genuine local refusal for another %s", async difference => {
    const test = await poisonedResolver("0x60006000fd");
    const wrongBlock = { ...test.proven.block,
      ...(difference === "block hash" ? { blockHash: `0x${"cd".repeat(32)}` as Hex } : {}),
      ...(difference === "state root" ? { stateRoot: `0x${"cd".repeat(32)}` as Hex } : {}),
      ...(difference === "block number" ? { blockNumber: test.proven.block.blockNumber + 1 } : {}),
    };
    // The error is authentic to the actual executor context. Discovery is given
    // a different snapshot only after execution, so proof verification remains real.
    test.options.headers = { finalized: () => wrongBlock };
    test.options.verifiedCall = async (to, data) => isBobsRecords(to, data)
      ? test.executor.call({ to: difference === "target" ? addr("b3") : to, data: difference === "calldata" ? "0x00" : data,
        ...(difference === "caller" ? { from: addr("b3") } : {}), ...(difference === "gas" ? { gas: 900_000n } : {}) })
      : { value: test.answer(to, data), block: wrongBlock };
    if (difference === "block number") {
      // Earlier public probing must use the test snapshot's tag, not fail first.
      const fetch = test.options.transport.fetch;
      test.options.transport.fetch = (url, opts = {}) => {
        if (!opts.body) return fetch(url, opts);
        const request = JSON.parse(String(opts.body));
        request.params[2] = `0x${test.proven.block.blockNumber.toString(16)}`;
        return fetch(url, { ...opts, body: JSON.stringify(request) });
      };
    }
    await expect(discoverOperators(test.options)).rejects.toBeInstanceOf(DiscoveryReadError);
  });

  it("refuses a consumed refusal replayed during a later refresh", async () => {
    const test = await poisonedResolver("0x60006000fd");
    const call = test.options.verifiedCall!;
    let failure: unknown;
    test.options.verifiedCall = async (to, data, options) => {
      if (isBobsRecords(to, data) && failure) throw failure;
      try { return await call(to, data, options); }
      catch (error) { failure = error; throw error; }
    };
    expect((await discoverOperators(test.options)).rejected[0]!.kind).toBe("resolver-policy");
    await expect(discoverOperators(test.options)).rejects.toBeInstanceOf(DiscoveryReadError);
  });
});

describe("ENSv2 anonymous directory discovery", () => {
  it("reads every indexed name before selection, probes proofs, and labels unverified records honestly", async () => {
    const test = setup();
    const direct = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("direct fetch forbidden"));
    try {
      const directory = await discoverOperators(test.options);
      expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth", "bob.derpc.eth"]);
      expect(directory).toMatchObject({ listVerification: "unverified", recordVerification: "unverified", blockNumber: HEADER.blockNumber });
      expect(directory.operators.every(o => o.proofVerifiedAt === HEADER.blockNumber)).toBe(true);
      expect(directory.operators.every(o => o.ensOwner === undefined)).toBe(true);
      expect(directory.operators[0]!.payment).toEqual({ price: 1000n, payee: SIGNER, chainId: 560048, escrow: ESCROW, payeeProven: false, recordsProven: false });
      expect(Object.isFrozen(directory.operators[0]!.payment)).toBe(true);
      expect(retainChosenOperators(directory, ["bob.derpc.eth", "gone.derpc.eth"]).map(o => o.ens)).toEqual(["bob.derpc.eth"]);
      expect(test.fetches.every(c => c.options.isolationKey === "derpc:operator-discovery")).toBe(true);
      expect(direct).not.toHaveBeenCalled();
    } finally { direct.mockRestore(); }
  });

  it("drops expired and removed names on refresh without adding new choices", async () => {
    const test = setup();
    const before = await discoverOperators(test.options);
    test.states.get("alice")!.expiry = BigInt(now);
    const after = await discoverOperators(test.options);
    expect(after.operators.map(o => o.ens)).toEqual(["bob.derpc.eth"]);
    expect(after.rejected[0]!.reason).toContain("expired");
    expect(retainChosenOperators(after, before.operators.map(o => o.ens)).map(o => o.ens)).toEqual(["bob.derpc.eth"]);
    test.setIndex(["mallory"]);
    const removed = await discoverOperators(test.options);
    expect(retainChosenOperators(removed, ["alice.derpc.eth", "bob.derpc.eth"])).toEqual([]);
  });

  it("rejects CCIP lookup and never fetches the supplied off-chain gateway", async () => {
    const test = setup();
    test.offchain.add("alice");
    await expect(discoverOperators(test.options)).rejects.toThrow("OffchainLookup");
    expect(test.fetches.some(c => c.url.includes("attacker.example"))).toBe(false);
  });

  it("aborts on a raw bootstrap network failure rather than silently dropping an entry", async () => {
    const test = setup(["alice"]);
    test.options.send = async (_method, params) => {
      const { to, data } = params[0] as { to: Hex; data: Hex };
      if (to.toLowerCase() === addr("b2")) throw new Error("network disconnected");
      return test.answer(to, data);
    };
    await expect(discoverOperators(test.options)).rejects.toThrow("network disconnected");
    expect(test.fetches).toEqual([]);
  });

  it("a lying RPC can change unverified discovery but cannot make it proven", async () => {
    const test = setup(["mallory"]);
    const result = await discoverOperators(test.options);
    expect(result.operators.map(o => o.ens)).toEqual(["mallory.derpc.eth"]);
    expect(result.listVerification).toBe("unverified");
    expect(result.recordVerification).toBe("unverified");
    expect(result.operators[0]!.payment!.payeeProven).toBe(false);
  });

  it("rejects malformed indexes before making candidate requests", async () => {
    for (const value of [["alice", "alice"], ["bad.name"], ["-alice"], ["A"], ["a".repeat(32)], {}, Array(129).fill("alice")]) {
      const test = setup(value);
      await expect(discoverOperators(test.options)).rejects.toThrow("invalid operator index");
      expect(test.fetches.every(c => c.url === "https://bootstrap.example/")).toBe(true);
    }
  });

  it("rejects wrong reciprocal identities and tampered candidate proofs", async () => {
    const test = setup();
    test.wrongIdentity.add("alice");
    test.corrupted.add("bob");
    const result = await discoverOperators(test.options);
    expect(result.operators).toEqual([]);
    expect(result.rejected.map(r => r.name)).toEqual(["alice.derpc.eth", "bob.derpc.eth"]);
    expect(result.rejected[0]!.reason).toContain("does not match");
    expect(result.rejected[1]!.reason).toContain("balance");
  });

  it.each(["declared certificate", "known owner"] as const)("rejects a shared gateway's %s before contacting the candidate", async ownership => {
    const test = setup();
    const active = "gateway.example:12298:abcdefghijklmnop";
    const alternate = "192.0.2.18:4222:abcdefghijklmnop";
    test.options.transport.pin = { ...TOR_JS_PIN, config: { ...TOR_JS_PIN.config, gateways: [active] } };
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    if (ownership === "declared certificate") test.records.get("bob")!["derpc.gateways"] = JSON.stringify([alternate]);
    else test.options.gatewayOwners = { [alternate]: "BOB.derpc.eth" };
    const directory = await discoverOperators(test.options);
    expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.rejected).toEqual([{ name: "bob.derpc.eth", reason: "gateway and RPC service share an operator; choose an independent gateway" }]);
    expect(test.fetches.filter(c => new URL(c.url).hostname === "alice.example")).toHaveLength(2);
    expect(test.fetches.some(c => new URL(c.url).hostname === "bob.example")).toBe(false);
  });

  it("probes an unrelated candidate using the actual configured worker gateways", async () => {
    const test = setup(["alice"]);
    const active = "gateway.example:12298:abcdefghijklmnop";
    test.options.transport.pin = { ...TOR_JS_PIN, config: { ...TOR_JS_PIN.config, gateways: [active] } };
    test.options.gatewayOwners = { [active]: "someone-else.derpc.eth" };
    test.records.get("alice")!["derpc.gateways"] = JSON.stringify(["gateway.example:12298:ponmlkjihgfedcba"]);
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.rejected).toEqual([]);
    expect(test.fetches).toHaveLength(2);
  });

  it.each([
    ["derpc.paymentChain", "9007199254740992"], ["derpc.price", "0"], ["derpc.price", (1n << 256n).toString()],
    ["derpc.payee", "0x" + "00".repeat(20)], ["derpc.escrow", "not-an-address"], ["derpc.gateways", '["gateway:0:abcdefghijklmnop"]'],
    ["derpc.caps", '{"chainId":1,"methods":["eth_getBalance"]}'], ["derpc.endpoint", "http://clearnet.example/"],
  ])("rejects invalid %s records before endpoint work", async (key, value) => {
    const test = setup(["alice"]);
    test.records.get("alice")![key] = value;
    expect((await discoverOperators(test.options)).operators).toEqual([]);
    expect(test.fetches.every(c => c.url === "https://bootstrap.example/")).toBe(true);
  });

  it("uses verified execution at one exact root, without remote eth_call", async () => {
    const test = setup(["alice"]);
    const calls: { to: Hex; data: Hex }[] = [];
    test.options.verifiedCall = async (to, data) => { calls.push({ to, data }); return { value: test.answer(to, data), block: HEADER }; };
    const directory = await discoverOperators(test.options);
    expect(directory).toMatchObject({ listVerification: "proven", recordVerification: "proven" });
    expect(directory.operators[0]!.payment).toMatchObject({ payeeProven: true, recordsProven: true });
    expect(test.fetches.filter(c => c.url === "https://bootstrap.example/")).toEqual([]);
    const batched = calls.filter(c => c.to.toLowerCase() === addr("b2"));
    expect(batched).toHaveLength(1);
    const outer = decodeFunctionData({ abi: resolverAbi, data: batched[0]!.data });
    expect(outer.functionName).toBe("resolve");
    if (outer.functionName !== "resolve") throw new Error("expected resolve");
    const inner = decodeFunctionData({ abi: resolverAbi, data: outer.args[1] });
    expect(inner.functionName).toBe("multicall");
    if (inner.functionName !== "multicall") throw new Error("expected multicall");
    expect(inner.args[0].map(data => decodeFunctionData({ abi: resolverAbi, data }).args[1])).toEqual(RECORD_KEYS);
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: { ...HEADER, stateRoot: `0x${"ff".repeat(32)}` } });
    await expect(discoverOperators(test.options)).rejects.toThrow("changed its verified block");
  });

  it("propagates corrupt proven records so the bootstrap pool can exclude the responsible endpoint", async () => {
    const test = setup(["alice"]);
    test.options.verifiedCall = async (to, data) => {
      if (to.toLowerCase() === addr("b2")) throw new ProofVerificationError("corrupt touched storage slot");
      return { value: test.answer(to, data), block: HEADER };
    };
    await expect(discoverOperators(test.options)).rejects.toThrow("corrupt touched storage");
  });

  it("does not turn payment or bootstrap pool exhaustion into a delisted candidate", async () => {
    const test = setup(["alice"]);
    const failure = new PoolExhaustedError([{ endpoint: "bootstrap", kind: "transient-failure", error: "funded session unavailable" }]);
    test.options.verifiedCall = async (to, data) => {
      if (to.toLowerCase() === addr("b2")) throw failure;
      return { value: test.answer(to, data), block: HEADER };
    };
    await expect(discoverOperators(test.options)).rejects.toBe(failure);
  });

  it.each([
    ["execution limit", () => new ExecutionLimitError("execution storage-slot limit")],
    ["unsupported execution", () => new UnsupportedExecutionError("BLOCKHASH needs unavailable authenticated block context")],
    ["off-chain execution", () => new UnsupportedExecutionError("CCIP-Read OffchainLookup is refused")],
    ["unbranded revert", () => new CallRevertedError("0x", "resolver reverted")],
  ])("aborts the snapshot on a second operator's %s after accepting the first", async (_label, makeError) => {
    const test = setup();
    const failure = makeError();
    test.options.verifiedCall = async (to, data) => {
      if (isBobsRecords(to, data)) throw failure;
      return { value: test.answer(to, data), block: HEADER };
    };
    await expect(discoverOperators(test.options)).rejects.toMatchObject({ name: "DiscoveryReadError", cause: failure });
    // Alice's reciprocal identity and public proof both passed before Bob became unreadable.
    expect(test.fetches.filter(c => new URL(c.url).hostname === "alice.example")).toHaveLength(2);
    expect(test.fetches.some(c => new URL(c.url).hostname === "bob.example")).toBe(false);
  });

  it.each(["raw", "verified"] as const)("aborts on a late %s metadata network failure without returning the earlier operator", async mode => {
    const test = setup();
    const failure = new NetworkUnavailableError("metadata circuit reset");
    const read = (to: Hex, data: Hex) => {
      if (isBobsRecords(to, data)) throw failure;
      return test.answer(to, data);
    };
    if (mode === "verified") test.options.verifiedCall = async (to, data) => ({ value: read(to, data), block: HEADER });
    else test.options.send = async (_method, params) => { const { to, data } = params[0] as { to: Hex; data: Hex }; return read(to, data); };
    await expect(discoverOperators(test.options)).rejects.toBeInstanceOf(DiscoveryReadError);
    expect(test.fetches.filter(c => new URL(c.url).hostname === "alice.example")).toHaveLength(2);
  });

  it.each([
    ["derpc.caps", "invalid JSON"],
    ["derpc.endpoint", "http://unapproved.example"],
    ["derpc.gateways", "x".repeat(4097)],
  ])("can reject a proven malformed second operator %s record", async (key, value) => {
    const test = setup();
    test.records.get("bob")![key] = value;
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory).toMatchObject({ listVerification: "proven", recordVerification: "proven" });
    expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.rejected.map(o => o.name)).toEqual(["bob.derpc.eth"]);
    expect(test.fetches.some(c => new URL(c.url).hostname === "bob.example")).toBe(false);
  });

  it.each([
    ["circuit reset", () => new NetworkUnavailableError("candidate circuit reset")],
    ["request timeout", () => new DOMException("candidate request timed out", "TimeoutError")],
    ["request cancellation", () => new DOMException("candidate request cancelled", "AbortError")],
  ])("treats a candidate %s as availability rejection after complete proven records", async (_label, makeError) => {
    const test = setup();
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const fetch = test.options.transport.fetch;
    test.options.transport.fetch = async (url, options) => {
      if (new URL(url).hostname === "bob.example") throw makeError();
      return fetch(url, options);
    };
    const directory = await discoverOperators(test.options);
    expect(directory).toMatchObject({ listVerification: "proven", recordVerification: "proven" });
    expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.rejected.map(o => o.name)).toEqual(["bob.derpc.eth"]);
  });

  it("still aborts the snapshot when the worker dies during a candidate probe", async () => {
    const test = setup();
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const fetch = test.options.transport.fetch;
    const failure = new TransportUnavailableError("failed");
    test.options.transport.fetch = async (url, options) => {
      if (new URL(url).hostname === "bob.example") throw failure;
      return fetch(url, options);
    };
    await expect(discoverOperators(test.options)).rejects.toBe(failure);
    expect(test.fetches.filter(c => new URL(c.url).hostname === "alice.example")).toHaveLength(2);
  });

  it.each(["identity", "proof"] as const)("keeps a second candidate's %s failure separate from authenticated metadata", async kind => {
    const test = setup();
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    (kind === "identity" ? test.wrongIdentity : test.corrupted).add("bob");
    const directory = await discoverOperators(test.options);
    expect(directory).toMatchObject({ listVerification: "proven", recordVerification: "proven" });
    expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.rejected.map(o => o.name)).toEqual(["bob.derpc.eth"]);
    expect(directory.rejected[0]!.reason).toContain(kind === "identity" ? "does not match" : "balance");
  });

  it("does not mistake cancellation of the whole scan for a candidate's request cancellation", async () => {
    const test = setup();
    const controller = new AbortController();
    const failure = new DOMException("user cancelled refresh", "AbortError");
    test.options.signal = controller.signal;
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const fetch = test.options.transport.fetch;
    test.options.transport.fetch = async (url, options) => {
      if (new URL(url).hostname === "bob.example") controller.abort(failure);
      return fetch(url, options);
    };
    await expect(discoverOperators(test.options)).rejects.toBe(failure);
    expect(test.fetches.filter(c => new URL(c.url).hostname === "alice.example")).toHaveLength(2);
  });

  it("rejects a truncated or reverted resolver batch without retrying individual records", async () => {
    for (const inner of [[], Array(RECORD_KEYS.length).fill("0x556f1830")]) {
      const test = setup(["alice"]);
      let candidateReads = 0;
      test.options.verifiedCall = async (to, data) => {
        if (to.toLowerCase() === addr("b2")) {
          candidateReads++;
          return { value: encodeFunctionResult({ abi: resolverAbi, functionName: "resolve", result: encodeFunctionResult({ abi: resolverAbi, functionName: "multicall", result: inner as Hex[] }) }), block: HEADER };
        }
        return { value: test.answer(to, data), block: HEADER };
      };
      const directory = await discoverOperators(test.options);
      expect(directory.operators).toEqual([]);
      expect(directory.rejected).toHaveLength(1);
      expect(candidateReads).toBe(1);
      expect(test.fetches).toEqual([]);
    }
  });

  it("authenticates registrar membership/payee while leaving price and escrow explicitly unverified", async () => {
    const test = setup(["mallory"]); // a lying parent index must be ignored once a registrar is pinned
    const registrar = registrarProofs([{ label: "alice", owner: OWNER, payee: SIGNER, expiry: now + 1800, active: true }], { bootstrap: TOR_JS_PIN.specifier });
    test.options.headers = { finalized: () => ({ ...HEADER, stateRoot: registrar.stateRoot }), assertFresh: () => {} };
    test.options.registrar = { address: registrar.address, codeHash: registrar.codeHash, registry: SUB };
    test.setCapabilityProof(registrar.bootstrapProof!);
    test.options.send = async (method, params) => method === "eth_getProof" ? registrar.proof(params[1] as Hex[]) : test.answer((params[0] as { to: Hex }).to, (params[0] as { data: Hex }).data);
    const directory = await discoverOperators(test.options);
    expect(directory).toMatchObject({ listVerification: "proven", recordVerification: "unverified" });
    expect(directory.operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(directory.operators[0]!.expiry).toBe(now + 1800);
    expect(directory.operators[0]!.payment).toMatchObject({ payeeProven: true, recordsProven: false });
    test.records.get("alice")!["derpc.payee"] = ESCROW;
    const wrongPayee = await discoverOperators(test.options);
    expect(wrongPayee.operators).toEqual([]);
    expect(wrongPayee.rejected[0]!.reason).toContain("proven payee");
    test.records.get("alice")!["derpc.payee"] = SIGNER;
    test.states.get("alice")!.latestOwner = ESCROW;
    expect((await discoverOperators(test.options)).rejected[0]!.reason).toContain("proven operator");
    test.options.registrar.registry = ESCROW;
    await expect(discoverOperators(test.options)).rejects.toThrow("subregistry differs");
  });

  it("cancels the entire scan under one deadline instead of returning a partial directory", async () => {
    const test = setup();
    let received: AbortSignal | undefined;
    test.options.send = async (_method, _params, opts) => { received = opts.signal; return new Promise(() => {}); };
    await expect(discoverOperators({ ...test.options, totalTimeoutMs: 10 })).rejects.toThrow("deadline exceeded");
    expect(received?.aborted).toBe(true);
    const canceled = setup();
    await expect(discoverOperators({ ...canceled.options, signal: AbortSignal.abort(new Error("user cancelled")) })).rejects.toThrow("user cancelled");
    expect(canceled.fetches).toEqual([]);
  });

  it("binds a pooled registrar read to the same block and forwards cancellation", async () => {
    const test = setup(["mallory"]);
    test.options.registrar = { address: addr("c1"), codeHash: `0x${"cc".repeat(32)}`, registry: SUB };
    const readRegistrar = vi.fn(async () => ({ value: [{ label: "alice", operator: OWNER, payee: SIGNER, expiry: now + 1800 }], block: HEADER }));
    test.options.readRegistrar = readRegistrar;
    expect((await discoverOperators(test.options)).operators.map(o => o.ens)).toEqual(["alice.derpc.eth"]);
    expect(readRegistrar).toHaveBeenCalledOnce();
    expect(readRegistrar).toHaveBeenCalledWith(test.options.registrar, { signal: expect.any(AbortSignal) });
    test.options.readRegistrar = async () => ({ value: [], block: { ...HEADER, blockNumber: HEADER.blockNumber + 1 } });
    await expect(discoverOperators(test.options)).rejects.toThrow("registrar discovery changed its verified block");
  });

  it("does not return a name that expires while its endpoint is being checked", async () => {
    const test = setup(["alice"]);
    test.states.get("alice")!.expiry = BigInt(now + 1);
    let reads = 0;
    test.options.now = () => (now + (reads++ > 0 ? 2 : 0)) * 1000;
    const directory = await discoverOperators(test.options);
    expect(directory.operators).toEqual([]);
    expect(directory.rejected[0]!.reason).toContain("expired during discovery");
  });

  it("expands a proven plural record under one operator and retains the legacy identity", async () => {
    const test = setup();
    publishNodes(test, "alice", [
      { id: "east", url: "https://alice-east.example/rpc", beaconUrl: "https://alice-east.example/beacon" },
      { id: "west", url: "https://alice-west.example/rpc" },
    ]);
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory).toMatchObject({ listVerification: "proven", recordVerification: "proven" });
    expect(directory.operators.map(o => [o.id, o.operatorId, o.endpointId, o.ens])).toEqual([
      ["alice.derpc.eth#east", "alice.derpc.eth", "east", "alice.derpc.eth"],
      ["alice.derpc.eth#west", "alice.derpc.eth", "west", "alice.derpc.eth"],
      ["bob.derpc.eth", "bob.derpc.eth", undefined, "bob.derpc.eth"],
    ]);
    expect(directory.operators.every(o => o.ensOwner?.toLowerCase() === OWNER)).toBe(true);
    expect(retainChosenOperators(directory, ["alice.derpc.eth"]).map(o => o.endpointId)).toEqual(["east", "west"]);
    expect(directory.operators.slice(0, 2).every(o => o.payment === undefined)).toBe(true);
    expect(test.fetches.some(c => new URL(c.url).hostname === "alice.example")).toBe(false);
    expect(test.fetches).toHaveLength(6); // identity + identical public proof for each endpoint
  });

  it("updates the proven owner binding when the ENS owner changes", async () => {
    const test = setup(["alice"]);
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/" }, { id: "west", url: "https://alice-west.example/" }]);
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const before = await discoverOperators(test.options);
    test.states.get("alice")!.latestOwner = ESCROW;
    const after = await discoverOperators(test.options);
    expect(after.operators.map(o => o.id)).toEqual(before.operators.map(o => o.id));
    expect(before.operators.every(o => o.ensOwner?.toLowerCase() === OWNER)).toBe(true);
    expect(after.operators.every(o => o.ensOwner?.toLowerCase() === ESCROW)).toBe(true);
  });

  it.each([
    " ", "{}", '{"version":2,"endpoints":[]}',
    '{"version":1,"endpoints":[{"id":"east","url":"https://one.example"},{"id":"east","url":"https://two.example"}]}',
    '{"version":1,"endpoints":[{"id":"east","url":"https://one.example"},{"id":"west","url":"http://bad.example"}]}',
  ])("never probes or falls back to singular records for invalid plural metadata: %s", async value => {
    const test = setup(["alice"]);
    test.records.get("alice")!["derpc.endpoints"] = value;
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory.operators).toEqual([]);
    expect(directory.rejected.map(o => o.name)).toEqual(["alice.derpc.eth"]);
    expect(test.fetches).toEqual([]);
  });

  it("ignores stale singular URLs only when a valid plural record is present", async () => {
    const test = setup(["alice"]);
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/rpc" }]);
    test.records.get("alice")!["derpc.endpoint"] = "http://old-invalid.example/";
    test.records.get("alice")!["derpc.beacon"] = "not a URL";
    const directory = await discoverOperators(test.options);
    expect(directory.operators.map(o => o.id)).toEqual(["alice.derpc.eth#east"]);
    expect(directory.recordVerification).toBe("unverified");
    test.records.get("alice")!["derpc.endpoints"] = "";
    expect((await discoverOperators(test.options)).operators).toEqual([]);
  });

  it.each(["derpc.price", "derpc.payee", "derpc.paymentChain", "derpc.escrow"])("rejects plural operators with any payment term: %s", async key => {
    const test = setup(["alice"]);
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/rpc" }]);
    test.records.get("alice")![key] = "1";
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory.operators).toEqual([]);
    expect(directory.rejected[0]!.reason).toBe("plural operator endpoints are free-only");
    expect(test.fetches).toEqual([]);
  });

  it("validates beacon requirements for the complete node set before probing any node", async () => {
    const test = setup(["alice"]);
    publishNodes(test, "alice", [
      { id: "east", url: "https://alice-east.example/", beaconUrl: "https://alice-east.example/beacon" },
      { id: "west", url: "https://alice-west.example/" },
    ]);
    test.records.get("alice")!["derpc.caps"] = JSON.stringify({ chainId: 1, methods: ["eth_getProof", "eth_getCode"], beacon: true });
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory.operators).toEqual([]);
    expect(directory.rejected[0]!.reason).toBe("beacon capability has no endpoint");
    expect(test.fetches).toEqual([]);
  });

  it.each(["missing ID", "wrong ID", "proof", "network"] as const)("keeps a healthy sibling after another node's %s failure", async kind => {
    const test = setup(["alice"]);
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/" }, { id: "west", url: "https://alice-west.example/" }]);
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    if (kind === "missing ID") test.identities.set("alice-east", { ens: "alice.derpc.eth" });
    if (kind === "wrong ID") test.identities.set("alice-east", { ens: "alice.derpc.eth", endpointId: "west" });
    if (kind === "proof") test.corrupted.add("alice-east");
    if (kind === "network") {
      const fetch = test.options.transport.fetch;
      test.options.transport.fetch = async (url, options) => {
        if (new URL(url).hostname === "alice-east.example") throw new NetworkUnavailableError("candidate unavailable");
        return fetch(url, options);
      };
    }
    const directory = await discoverOperators(test.options);
    expect(directory.operators.map(o => o.id)).toEqual(["alice.derpc.eth#west"]);
    expect(directory.rejected.map(o => o.name)).toEqual(["alice.derpc.eth#east"]);
    expect(test.fetches.some(c => new URL(c.url).hostname === "alice.example")).toBe(false);
  });

  it("rejects shared gateway ownership before contacting any plural sibling", async () => {
    const test = setup(["alice"]);
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/" }, { id: "west", url: "https://alice-west.example/" }]);
    test.options.gatewayOwners = { [(TOR_JS_PIN.config.gateways as string[])[0]!]: "alice.derpc.eth" };
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const directory = await discoverOperators(test.options);
    expect(directory.operators).toEqual([]);
    expect(directory.rejected[0]!.reason).toContain("share an operator");
    expect(test.fetches).toEqual([]);
  });

  it("aborts a later metadata failure even after proving two sibling endpoints", async () => {
    const test = setup();
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/" }, { id: "west", url: "https://alice-west.example/" }]);
    test.options.verifiedCall = async (to, data) => {
      if (isBobsRecords(to, data)) throw new ExecutionLimitError("incomplete resolver execution");
      return { value: test.answer(to, data), block: HEADER };
    };
    await expect(discoverOperators(test.options)).rejects.toBeInstanceOf(DiscoveryReadError);
    expect(test.fetches).toHaveLength(4);
  });

  it("rotates one stable endpoint ID and removes the whole operator on a later index refresh", async () => {
    const test = setup();
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east.example/" }, { id: "west", url: "https://alice-west.example/" }]);
    test.options.verifiedCall = async (to, data) => ({ value: test.answer(to, data), block: HEADER });
    const before = await discoverOperators(test.options);
    test.fetches.length = 0;
    publishNodes(test, "alice", [{ id: "east", url: "https://alice-east-new.example/" }, { id: "west", url: "https://alice-west.example/" }]);
    const rotated = await discoverOperators(test.options);
    expect(rotated.operators.map(o => o.id)).toEqual(before.operators.map(o => o.id));
    expect(rotated.operators[0]!.url).toBe("https://alice-east-new.example/");
    expect(test.fetches.some(c => new URL(c.url).hostname === "alice-east.example")).toBe(false);
    test.setIndex(["bob"]);
    const removed = await discoverOperators(test.options);
    expect(retainChosenOperators(removed, ["alice.derpc.eth", "bob.derpc.eth"]).map(o => o.id)).toEqual(["bob.derpc.eth"]);
  });

  it("encodes bounded DNS names and rejects malformed labels", () => {
    expect(decodeDns(dnsName("alice.derpc.eth"))).toBe("alice.derpc.eth");
    for (const name of ["alice..eth", "a\u0000b.eth", "a".repeat(64) + ".eth", Array(5).fill("a".repeat(63)).join(".")]) expect(() => dnsName(name)).toThrow();
  });
});
