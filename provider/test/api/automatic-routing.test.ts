import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeRPCWith, simulatedLyingOperator, type DeRPC, type DeRPCOperator, type DeRPCOptions, type DeRPCPaymentClient } from "../../src/api/derpc.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import type { AnonTransport } from "../../src/transport/anon-transport.ts";
import type { VerifiedHeader, VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import { StaleHeaderError } from "../../src/light-client/header-source.ts";
import type { Directory, DiscoveredOperator } from "../../src/discovery/ens.ts";
import fixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };

// These are API trust/lifecycle tests. Real ENS proof execution is covered by discovery and fork tests.
const discovery = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock("../../src/discovery/ens.ts", async original => ({ ...await original<typeof import("../../src/discovery/ens.ts")>(), discoverOperators: discovery.scan }));
type Hex = `0x${string}`;
const ADDRESS = fixture.specifier as Hex;
const HEADER: VerifiedHeader = { slot: 0, blockNumber: fixture.block.number, blockHash: fixture.block.hash as Hex, stateRoot: fixture.block.stateRoot as Hex, timestamp: Math.floor(fixture.capturedAt / 1000) };
const A: DeRPCOperator = { id: "a", ens: "a.derpc.eth", url: "https://a.example/rpc", priority: 0 };
const B: DeRPCOperator = { id: "b", ens: "b.derpc.eth", url: "https://b.example/rpc", priority: 1 };
const C: DeRPCOperator = { id: "c", ens: "c.derpc.eth", url: "https://c.example/rpc", priority: 2 };
const request = { ethRegistry: ADDRESS, registrar: { address: ADDRESS, codeHash: HEADER.blockHash }, verifiedRecords: true };
const providers: DeRPC[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function listed(operator: DeRPCOperator): DiscoveredOperator { return { ...operator, ens: operator.ens!, expiry: Math.floor(Date.now() / 1000) + 3600, proofVerifiedAt: HEADER.blockNumber }; }
function directory(operators = [A, B]): Directory { return { operators: operators.map(listed), rejected: [], listVerification: "proven", recordVerification: "proven", blockNumber: HEADER.blockNumber, blockHash: HEADER.blockHash }; }

function setup(options: DeRPCOptions = {}, headersAfter?: Promise<void>) {
  const requests: { url: string; method: string; params: unknown[] }[] = [];
  let closed = false;
  const transport: AnonTransport = {
    pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => closed ? "closed" : "ready", close: () => { closed = true; },
    async fetch(url, options = {}) {
      const body = JSON.parse(String(options.body));
      requests.push({ url, method: body.method, params: body.params });
      if (body.method !== "eth_getProof" || body.params[0].toLowerCase() !== ADDRESS.toLowerCase()) throw new Error("no fixture");
      const proof = structuredClone(fixture.proof);
      if (!body.params[1].length) proof.storageProof = [];
      return Response.json({ jsonrpc: "2.0", id: body.id, result: proof });
    },
  };
  const headers: VerifiedHeaderSource = { finalized: () => HEADER, assertFresh: () => {}, pollHealth: () => ({ consecutiveFailures: 0 }), close: () => {} };
  const startTransport = vi.fn(() => transport);
  const derpc = createDeRPCWith({ startTransport, startHeaders: async () => { await headersAfter; return headers; } }, { ...options });
  providers.push(derpc);
  return { derpc, requests, headers, transport, startTransport };
}

beforeEach(() => {
  // Directory authority is bounded by its authenticated block's age, even with fixture headers.
  vi.spyOn(Date, "now").mockReturnValue(HEADER.timestamp * 1000);
  discovery.scan.mockReset(); discovery.scan.mockResolvedValue(directory());
});
afterEach(() => { providers.splice(0).forEach(provider => provider.close()); vi.restoreAllMocks(); });

describe("explicit automatic routing", () => {
  it("keeps absent configuration manual and never invents candidates", async () => {
    const { derpc, requests } = setup();
    await derpc.ready;
    expect(derpc.status().routing).toEqual({ selection: "manual", allowedOperators: undefined, source: "explicit" });
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("no operators chosen");
    derpc.setRouting({ selection: "balanced" });
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("no operators chosen");
    expect(requests).toEqual([]);
  });

  it("uses every supplied free candidate when auto has no allowlist, including lower priority entries", () => {
    const { derpc } = setup({ operators: [A, B, C], selection: "balanced", chainId: 1 });
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a", "b", "c"]);
    expect(derpc.status().routing).toMatchObject({ selection: "balanced", source: "explicit" });
  });

  it("distinguishes an omitted, restrictive and empty allowlist; widening restores original candidates", async () => {
    const { derpc, requests } = setup({ operators: [A, B], selection: "fastest", allowedOperators: [B.ens!] });
    await derpc.reader.getBalance(ADDRESS);
    expect(requests.every(request => request.url === B.url)).toBe(true);
    derpc.setRouting({ selection: "reliable", allowedOperators: [] });
    expect(derpc.status().operators).toEqual([]);
    const before = requests.length;
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("no operators chosen");
    expect(requests).toHaveLength(before);
    derpc.setRouting({ selection: "balanced", allowedOperators: ["missing.derpc.eth"] });
    expect(derpc.status().operators).toEqual([]);
    derpc.setRouting({ selection: "balanced" });
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a", "b"]);
  });

  it("atomically applies source and restriction without a pin request to a denied endpoint", async () => {
    const { derpc, requests } = setup();
    await derpc.ready;
    derpc.setRouting({ selection: "balanced", allowedOperators: ["b"] }, [A, B]);
    await derpc.reader.getBalance(ADDRESS);
    expect(requests.map(request => request.url)).toEqual([B.url, B.url]);
  });

  it("copies configuration and status allowlists so caller mutation cannot expand authorization", async () => {
    const allowed = ["a"];
    const candidates = [{ ...A }, { ...B }];
    const { derpc, requests } = setup({ operators: candidates, selection: "balanced", allowedOperators: allowed });
    allowed.push("b"); candidates[0]!.url = "https://changed.example";
    derpc.status().routing!.allowedOperators!.push("b");
    await derpc.reader.getBalance(ADDRESS);
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a"]);
    expect(requests.every(request => request.url === A.url)).toBe(true);
  });

  it.each([
    { selection: "cheapest" }, { selection: null }, { allowedOperators: ["a"] }, { selection: "balanced", allowedOperators: null },
    { selection: "balanced", allowedOperators: ["a", "a"] }, { selection: "balanced", allowedOperators: [""] },
    { selection: "balanced", allowedOperators: Array(1) }, { chainId: 11155111 }, { chainId: "1" },
  ])("rejects malformed policy before creating any worker: %j", invalid => {
    const startTransport = vi.fn(() => { throw new Error("worker must not start"); });
    expect(() => createDeRPCWith({ startTransport, startHeaders: vi.fn() }, invalid as DeRPCOptions)).toThrow();
    expect(startTransport).not.toHaveBeenCalled();
  });

  it.each([
    [A, { ...B, id: "a" }], [A, { ...B, id: A.ens! }], [A, { ...B, url: A.url }],
    [A, { ...B, ens: A.ens!.toUpperCase() }], [A, { ...B, url: "https://a.example:443/rpc" }],
  ])("refuses ambiguous automatic identities before startup and preserves an active selection", candidates => {
    const startTransport = vi.fn(() => { throw new Error("worker must not start"); });
    expect(() => createDeRPCWith({ startTransport, startHeaders: vi.fn() }, { operators: candidates, selection: "balanced" })).toThrow();
    expect(startTransport).not.toHaveBeenCalled();
    const { derpc } = setup({ operators: [C], selection: "reliable" });
    expect(() => derpc.setRouting({ selection: "balanced" }, candidates)).toThrow();
    expect(derpc.status().routing?.selection).toBe("reliable");
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["c"]);
  });

  it("excludes paid, expired and simulated candidates and never activates an existing funded session", async () => {
    const begin = vi.fn();
    const payment: DeRPCOperator = { ...B, payment: { price: 1n, payee: ADDRESS, chainId: 560048, escrow: ADDRESS, payeeProven: true, recordsProven: true } };
    const { derpc } = setup({ operators: [A, payment, { ...C, expiry: 1 }, simulatedLyingOperator(A)], selection: "balanced", payments: { has: () => true, begin } as unknown as DeRPCPaymentClient });
    await derpc.reader.getBalance(ADDRESS);
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a"]);
    expect(begin).not.toHaveBeenCalled();
  });

  it("keeps observations and in-flight free requests when only the category changes", async () => {
    const { derpc } = setup({ operators: [A], selection: "balanced" });
    await derpc.reader.getBalance(ADDRESS);
    const before = derpc.status().operators[0]!.observations;
    derpc.setRouting({ selection: "fastest" });
    expect(derpc.status().operators[0]!.observations).toEqual(before);
    derpc.setRouting({ selection: "fastest" });
    expect(derpc.status().operators[0]!.observations).toEqual(before);
  });

  it("cancels a funded manual attempt when switching to free auto, before it can sign", async () => {
    const begin = vi.fn(async () => ({ headers: () => ({}), verified, failed: vi.fn() }));
    const verified = vi.fn(async () => {});
    const { derpc, transport } = setup({ operators: [A], payments: { has: () => true, begin } as unknown as DeRPCPaymentClient });
    const original = transport.fetch;
    const entered = deferred<void>(), release = deferred<void>();
    transport.fetch = async (url, options) => {
      const body = JSON.parse(String(options?.body));
      if (!body.params[1].length) { entered.resolve(); await release.promise; }
      return original(url, options);
    };
    const pending = derpc.reader.getBalance(ADDRESS);
    const result = expect(pending).rejects.toThrow("operator selection changed");
    await entered.promise;
    derpc.setRouting({ selection: "balanced" });
    release.resolve();
    await result;
    expect(begin).toHaveBeenCalledTimes(1);
    expect(verified).not.toHaveBeenCalled();
    await derpc.reader.getBalance(ADDRESS);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it.each(["reader", "eip1193", "verifiedCall", "eip1193-call"])("does not let a free %s request waiting for startup inherit later manual spending authorization", async kind => {
    const begin = vi.fn();
    const headers = deferred<void>();
    const { derpc } = setup({ operators: [A], selection: "balanced", verifiedCalls: { eip1193: true }, payments: { has: () => true, begin } as unknown as DeRPCPaymentClient }, headers.promise);
    const pending = kind === "reader" ? derpc.reader.getBalance(ADDRESS)
      : kind === "verifiedCall" ? derpc.verifiedCall({ to: ADDRESS, data: "0x" })
      : derpc.provider.request(kind === "eip1193" ? { method: "eth_getBalance", params: [ADDRESS, "finalized"] } : { method: "eth_call", params: [{ to: ADDRESS }, "finalized"] });
    const rejected = expect(pending).rejects.toThrow("operator selection changed");
    derpc.setRouting({ selection: "manual" });
    headers.resolve();
    await rejected;
    await derpc.ready;
    expect(begin).not.toHaveBeenCalled();
  });
});

describe("automatic adoption of ENS directories", () => {
  it("requires a registrar and proven records before any discovery traffic", async () => {
    const { derpc, requests } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    await expect(derpc.refreshDirectory({ ethRegistry: ADDRESS })).rejects.toThrow("proven ENS records");
    expect(discovery.scan).not.toHaveBeenCalled();
    expect(requests.every(request => (request.params[1] as unknown[]).length === 1)).toBe(true);
  });

  it("adopts all eligible proven entries, copies their identity, and preserves the full directory across manual subsets", async () => {
    const { derpc } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    const returned = await derpc.refreshDirectory(request);
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a", "b"]);
    expect(derpc.status().routing).toMatchObject({ source: "verified-ens", directory: "derpc.eth" });
    derpc.setRouting({ selection: "manual" }, [returned.operators[1]!]);
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["b"]);
    expect(derpc.status().routing?.source).toBe("verified-ens");
    returned.operators[0]!.url = "https://mutated.example";
    derpc.setRouting({ selection: "reliable" });
    expect(derpc.status().operators.map(operator => operator.url)).toEqual([A.url, B.url]);
  });

  it("does not widen an explicitly replaced automatic source when only the category changes", async () => {
    const { derpc } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    const result = await derpc.refreshDirectory(request);
    derpc.setRouting({ selection: "balanced" }, [result.operators[0]!]);
    derpc.setRouting({ selection: "fastest" });
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a"]);
  });

  it.each(["unverified list", "unverified records", "different block", "failed scan"])("does not replace the pool after %s", async failure => {
    const { derpc } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    const next = directory([B]);
    if (failure === "unverified list") next.listVerification = "unverified";
    if (failure === "unverified records") next.recordVerification = "unverified";
    if (failure === "different block") next.blockNumber++;
    if (failure === "failed scan") discovery.scan.mockRejectedValue(new Error("metadata incomplete"));
    else discovery.scan.mockResolvedValue(next);
    await expect(derpc.refreshDirectory(request)).rejects.toThrow();
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a"]);
    expect(derpc.status().routing?.source).toBe("explicit");
  });

  it("filters the newly proven directory by exact allowlist and expiry without reintroducing old bootstrap entries", async () => {
    const { derpc } = setup({ operators: [A], selection: "balanced", allowedOperators: ["a", "c"], verifiedCalls: true });
    const result = directory([B, C]);
    result.operators[1]!.expiry = 1;
    discovery.scan.mockResolvedValue(result);
    await derpc.refreshDirectory(request);
    expect(derpc.status().operators).toEqual([]);
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("no operators chosen");
  });

  it("recovers an empty proven directory only on explicit administrative refresh, never for a user read", async () => {
    const { derpc, requests } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    discovery.scan.mockResolvedValueOnce(directory([]));
    await derpc.refreshDirectory(request);
    const count = requests.length;
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("no operators chosen");
    expect(requests).toHaveLength(count);
    discovery.scan.mockResolvedValueOnce(directory([B]));
    await derpc.refreshDirectory(request);
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["b"]);
    expect(requests.slice(count).every(request => (request.params[1] as unknown[]).length === 1)).toBe(true);
  });

  it("does not use administrative bootstrap when the allowlist is explicitly empty", async () => {
    const { derpc, requests } = setup({ operators: [A], selection: "balanced", allowedOperators: [], verifiedCalls: true });
    await expect(derpc.refreshDirectory(request)).rejects.toThrow("no operators chosen");
    expect(requests).toEqual([]);
    expect(discovery.scan).not.toHaveBeenCalled();
  });

  it("rejects an older overlapping refresh and applies only the newer snapshot", async () => {
    const { derpc } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    const first = deferred<Directory>(), entered = deferred<void>();
    discovery.scan.mockImplementationOnce(() => { entered.resolve(); return first.promise; });
    const old = derpc.refreshDirectory(request);
    const oldResult = expect(old).rejects.toThrow(/superseded|selection changed/);
    await entered.promise;
    discovery.scan.mockResolvedValueOnce(directory([C]));
    await derpc.refreshDirectory(request);
    first.resolve(directory([B]));
    await oldResult;
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["c"]);
  });

  it("invalidates a refresh when only denied source candidates change", async () => {
    const { derpc } = setup({ operators: [A, B], selection: "balanced", allowedOperators: ["a"], verifiedCalls: true });
    const scan = deferred<Directory>(), entered = deferred<void>();
    discovery.scan.mockImplementationOnce(() => { entered.resolve(); return scan.promise; });
    const pending = derpc.refreshDirectory(request);
    const result = expect(pending).rejects.toThrow("routing changed");
    await entered.promise;
    derpc.setRouting({ selection: "balanced", allowedOperators: ["a"] }, [A, C]);
    scan.resolve(directory([B]));
    await result;
    derpc.setRouting({ selection: "balanced" });
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a", "c"]);
  });

  it("allows revocation when cached provenance becomes stale, while refusing expansion", async () => {
    const { derpc, headers } = setup({ operators: [A], selection: "balanced", verifiedCalls: true });
    const result = await derpc.refreshDirectory(request);
    derpc.setRouting({ selection: "manual" }, [result.operators[0]!]);
    headers.assertFresh = () => { throw new StaleHeaderError("cached ENS snapshot stale"); };
    expect(() => derpc.setRouting({ selection: "balanced" })).toThrow("authenticated block is stale");
    expect(() => derpc.setRouting({ selection: "manual" }, [])).not.toThrow();
    expect(() => derpc.setRouting({ selection: "balanced", allowedOperators: [] })).not.toThrow();
    expect(derpc.status().operators).toEqual([]);
  });

  it("does not upgrade a manually accepted unverified directory into automatic authorization", async () => {
    const { derpc } = setup({ operators: [A], verifiedCalls: true });
    discovery.scan.mockResolvedValue({ ...directory([A, B]), recordVerification: "unverified" });
    await derpc.refreshDirectory({ ethRegistry: ADDRESS });
    expect(derpc.status().routing?.source).toBe("unverified-ens");
    expect(() => derpc.setRouting({ selection: "balanced" })).toThrow("proven ENS records");
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["a"]);
    // Revocation does not need trusted metadata: [] must always be able to close the pool.
    expect(() => derpc.setRouting({ selection: "balanced", allowedOperators: [] })).not.toThrow();
    expect(derpc.status().operators).toEqual([]);
  });
});
