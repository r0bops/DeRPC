import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeRPCWith, DirectorySnapshotExpiredError, DIRECTORY_SNAPSHOT_TTL_MS, DIRECTORY_SNAPSHOT_MAX_BLOCK_AGE_MS,
  type DeRPC, type DeRPCOperator, type DeRPCOptions, type DeRPCPaymentClient } from "../../src/api/derpc.ts";
import type { Directory, DiscoveryOptions } from "../../src/discovery/ens.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import type { AnonTransport } from "../../src/transport/anon-transport.ts";
import type { VerifiedHeader, VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import fixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };

const discovery = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock("../../src/discovery/ens.ts", async original => ({ ...await original<typeof import("../../src/discovery/ens.ts")>(), discoverOperators: discovery.scan }));
type Hex = `0x${string}`;
const ADDRESS = fixture.specifier as Hex;
const BASE = Math.floor(fixture.capturedAt / 1000) * 1000;
const A: DeRPCOperator = { id: "bootstrap", url: "https://bootstrap.example/rpc", priority: 0 };
const B: DeRPCOperator = { id: "b", ens: "b.derpc.eth", url: "https://b.example/rpc", priority: 0 };
const C: DeRPCOperator = { id: "c", ens: "c.derpc.eth", url: "https://c.example/rpc", priority: 0 };
const REQUEST = { ethRegistry: ADDRESS, registrar: { address: ADDRESS, codeHash: fixture.block.hash as Hex }, verifiedRecords: true };
let wall: number, monotonic: number;
const providers: DeRPC[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function advance(ms: number) { wall += ms; monotonic += ms; }

function setup(options: DeRPCOptions = {}) {
  let header: VerifiedHeader = { slot: 0, blockNumber: fixture.block.number, blockHash: fixture.block.hash as Hex,
    stateRoot: fixture.block.stateRoot as Hex, timestamp: BASE / 1000 };
  let closed = false;
  const requests: { url: string; body: any }[] = [];
  const transport: AnonTransport = {
    pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => closed ? "closed" : "ready", close: () => { closed = true; },
    async fetch(url, options = {}) {
      if (url.endsWith("/.well-known/derpc.json")) return Response.json({ version: "1", ens: B.ens, signer: ADDRESS, chains: [1], service: "node" });
      const body = JSON.parse(String(options.body)); requests.push({ url, body });
      if (url.endsWith("/payments/voucher")) return Response.json({ highestAmount: body.amount, settlement: { state: "submitted" } });
      if (body.method !== "eth_getProof" || body.params[0].toLowerCase() !== ADDRESS.toLowerCase()) throw new Error("no fixture");
      const proof = structuredClone(fixture.proof);
      if (!body.params[1].length) proof.storageProof = [];
      return Response.json({ jsonrpc: "2.0", id: body.id, result: proof });
    },
  };
  const headers: VerifiedHeaderSource = { finalized: () => header, assertFresh: () => {}, pollHealth: () => ({ consecutiveFailures: 0 }), close() {} };
  const derpc = createDeRPCWith({ startTransport: () => transport, startHeaders: async () => headers }, { operators: [A], selection: "balanced", verifiedCalls: true, ...options });
  providers.push(derpc);
  function directory(operators: DeRPCOperator[] = [B, C]): Directory {
    return { operators: operators.map(operator => ({ ...operator, ens: operator.ens!, expiry: BASE / 1000 + 7200, proofVerifiedAt: header.blockNumber })), rejected: [],
      listVerification: "proven", recordVerification: "proven", blockNumber: header.blockNumber, blockHash: header.blockHash };
  }
  function nextBlock() { header = { ...header, blockNumber: header.blockNumber + 1, blockHash: `0x${header.blockNumber.toString(16).padStart(64, "0")}` as Hex, timestamp: Math.floor(wall / 1000) - 60 }; }
  discovery.scan.mockImplementation(async () => directory());
  return { derpc, headers, requests, transport, directory, nextBlock, setHeader: (value: Partial<VerifiedHeader>) => { header = { ...header, ...value }; } };
}

beforeEach(() => {
  wall = BASE + 5 * 60_000; monotonic = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  discovery.scan.mockReset();
});
afterEach(() => { providers.splice(0).forEach(provider => provider.close()); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("bounded ENS snapshot authorization", () => {
  it("reports authenticated provenance and the shorter ten-minute deadline", async () => {
    const { derpc } = setup();
    await derpc.refreshDirectory(REQUEST);
    expect(derpc.status().routing?.directorySnapshot).toEqual({ blockNumber: fixture.block.number, blockHash: fixture.block.hash,
      verifiedAt: wall, expiresAt: wall + DIRECTORY_SNAPSHOT_TTL_MS, state: "fresh", requiredForReads: true });
  });

  it("never authorizes a snapshot beyond thirty minutes after its authenticated block", async () => {
    wall = BASE + 25 * 60_000;
    const { derpc } = setup();
    await derpc.refreshDirectory(REQUEST);
    expect(derpc.status().routing?.directorySnapshot?.expiresAt).toBe(BASE + DIRECTORY_SNAPSHOT_MAX_BLOCK_AGE_MS);
    advance(5 * 60_000);
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
  });

  it("rejects stale cached reads without requesting another proof and maps the EIP-1193 refusal", async () => {
    const { derpc, requests } = setup();
    await derpc.refreshDirectory(REQUEST);
    await derpc.reader.getBalance(ADDRESS);
    const count = requests.length;
    advance(DIRECTORY_SNAPSHOT_TTL_MS - 1);
    await derpc.reader.getBalance(ADDRESS);
    expect(requests).toHaveLength(count);
    advance(1);
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    await expect(derpc.provider.request({ method: "eth_getBalance", params: [ADDRESS, "finalized"] })).rejects.toMatchObject({ code: -32002, data: { reason: "DirectorySnapshotExpiredError" } });
    expect(requests).toHaveLength(count);
    expect(derpc.status().routing?.directorySnapshot?.state).toBe("stale");
  });

  it("checks expiry again when a previously cached result is about to return", async () => {
    const { derpc, headers, requests } = setup();
    await derpc.refreshDirectory(REQUEST);
    await derpc.reader.getBalance(ADDRESS);
    const count = requests.length;
    advance(DIRECTORY_SNAPSHOT_TTL_MS - 1);
    const finalized = headers.finalized;
    headers.finalized = () => { const block = finalized(); advance(1); return block; };
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(requests).toHaveLength(count);
  });

  it("does not renew the deadline through category changes, restrictions or re-supplying a known endpoint", async () => {
    const { derpc } = setup();
    const result = await derpc.refreshDirectory(REQUEST);
    const before = derpc.status().routing!.directorySnapshot!;
    advance(60_000);
    derpc.setRouting({ selection: "fastest", allowedOperators: ["b"] });
    derpc.setRouting({ selection: "manual" }, [{ ...result.operators[0]!, priority: 9, expiry: BASE / 1000 + 99999 }]);
    expect(derpc.status().routing?.directorySnapshot).toEqual(before);
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    // Removing ENS labels or changing a local priority cannot launder a known endpoint's authority.
    expect(() => derpc.setOperators([{ url: B.url, priority: 5 }])).toThrow(DirectorySnapshotExpiredError);
    expect(() => derpc.setRouting({ selection: "manual" }, [])).not.toThrow();
    expect(derpc.status().operators).toEqual([]);
    expect(derpc.status().routing?.directorySnapshot?.state).toBe("stale");
  });

  it("allows narrowing and stopping a stale pool without renewing its deadline", async () => {
    const { derpc } = setup();
    await derpc.refreshDirectory(REQUEST);
    const expiresAt = derpc.status().routing!.directorySnapshot!.expiresAt;
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    expect(() => derpc.setRouting({ selection: "reliable", allowedOperators: ["b"] })).not.toThrow();
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(() => derpc.setRouting({ selection: "balanced", allowedOperators: [] })).not.toThrow();
    expect(derpc.status().routing?.directorySnapshot?.expiresAt).toBe(expiresAt);
    expect(derpc.status().routing?.directorySnapshot?.requiredForReads).toBe(false);
  });

  it("keeps unrelated explicit reads usable while retaining stale snapshot information", async () => {
    const { derpc } = setup();
    await derpc.refreshDirectory(REQUEST);
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    derpc.setRouting({ selection: "manual" }, [A]);
    expect((await derpc.reader.getBalance(ADDRESS)).value).toBe(0n);
    expect(derpc.status().routing?.directorySnapshot).toMatchObject({ state: "stale", requiredForReads: false });
  });

  it("keeps a mixed pool gated until its known ENS entry is removed", async () => {
    const { derpc } = setup();
    const result = await derpc.refreshDirectory(REQUEST);
    derpc.setRouting({ selection: "manual" }, [result.operators[0]!, A]);
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    expect(derpc.status().routing?.directorySnapshot?.requiredForReads).toBe(true);
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    derpc.setRouting({ selection: "manual" }, [A]);
    await expect(derpc.reader.getBalance(ADDRESS)).resolves.toMatchObject({ value: 0n });
  });

  it("does not extend authority after failed or unverified refresh, or a replay of the same block", async () => {
    const { derpc, directory } = setup();
    await derpc.refreshDirectory(REQUEST);
    const expiresAt = derpc.status().routing!.directorySnapshot!.expiresAt;
    advance(60_000);
    await derpc.refreshDirectory(REQUEST);
    expect(derpc.status().routing?.directorySnapshot?.expiresAt).toBe(expiresAt);
    discovery.scan.mockRejectedValueOnce(new Error("metadata transport failed"));
    await expect(derpc.refreshDirectory(REQUEST)).rejects.toThrow("metadata transport failed");
    discovery.scan.mockResolvedValueOnce({ ...directory(), recordVerification: "unverified" });
    await expect(derpc.refreshDirectory(REQUEST)).rejects.toThrow("unverified");
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    await expect(derpc.refreshDirectory(REQUEST)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(derpc.status().routing?.directorySnapshot?.expiresAt).toBe(expiresAt);
  });

  it("uses only administrative bootstrap after expiry and requires a newer authenticated snapshot to recover", async () => {
    const { derpc, requests, nextBlock } = setup();
    await derpc.refreshDirectory(REQUEST);
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    nextBlock();
    const before = requests.length;
    await derpc.refreshDirectory(REQUEST);
    expect(requests.slice(before).map(request => request.url)).toEqual([A.url]);
    expect(requests.slice(before).every(request => request.body.params[1].length === 1)).toBe(true);
    expect(derpc.status().routing?.directorySnapshot).toMatchObject({ verifiedAt: wall, state: "fresh", requiredForReads: true });
    await expect(derpc.reader.getBalance(ADDRESS)).resolves.toMatchObject({ value: 0n });
  });

  it("does not bypass an allowlist to reach administrative bootstrap", async () => {
    const { derpc, requests, nextBlock } = setup();
    await derpc.refreshDirectory(REQUEST);
    derpc.setRouting({ selection: "balanced", allowedOperators: ["b"] });
    advance(DIRECTORY_SNAPSHOT_TTL_MS); nextBlock();
    const before = requests.length;
    await expect(derpc.refreshDirectory(REQUEST)).rejects.toThrow("no operators chosen");
    expect(requests).toHaveLength(before);
    derpc.setRouting({ selection: "balanced", allowedOperators: [] });
    await expect(derpc.refreshDirectory(REQUEST)).rejects.toThrow("no operators chosen");
    expect(requests).toHaveLength(before);
  });

  it.each(["backwards", "frozen", "forward"])("fails closed when the wall clock moves %s, without permitting later resurrection", async kind => {
    const { derpc } = setup();
    await derpc.refreshDirectory(REQUEST);
    const verifiedAt = wall;
    if (kind === "backwards") wall--;
    if (kind === "forward") wall += DIRECTORY_SNAPSHOT_TTL_MS;
    if (kind === "frozen") monotonic += DIRECTORY_SNAPSHOT_TTL_MS;
    expect(derpc.status().routing?.directorySnapshot?.state).toBe("stale");
    wall = verifiedAt + 1;
    expect(derpc.status().routing?.directorySnapshot?.state).toBe("stale");
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
  });

  it.each(["lower height", "conflicting hash"])("refuses a %s refresh without changing authority", async kind => {
    const { derpc, setHeader } = setup();
    await derpc.refreshDirectory(REQUEST);
    const snapshot = derpc.status().routing!.directorySnapshot!;
    setHeader(kind === "lower height" ? { blockNumber: fixture.block.number - 1 } : { blockHash: `0x${"ff".repeat(32)}` });
    await expect(derpc.refreshDirectory(REQUEST)).rejects.toThrow("cannot move backwards");
    expect(derpc.status().routing?.directorySnapshot).toEqual(snapshot);
  });

  it("rejects a response that completes after expiry without excluding the endpoint", async () => {
    const { derpc, transport } = setup();
    await derpc.refreshDirectory(REQUEST);
    advance(DIRECTORY_SNAPSHOT_TTL_MS - 1000);
    const original = transport.fetch;
    transport.fetch = async (url, options) => { const response = await original(url, options); advance(1000); return response; };
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(derpc.status().operators.every(operator => operator.state === "eligible")).toBe(true);
  });

  it("cancels a still-pending request at the snapshot deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { derpc, transport } = setup();
    await derpc.refreshDirectory(REQUEST);
    advance(DIRECTORY_SNAPSHOT_TTL_MS - 1000);
    await vi.advanceTimersByTimeAsync(DIRECTORY_SNAPSHOT_TTL_MS - 1000);
    const entered = deferred<void>(), release = deferred<void>();
    const original = transport.fetch;
    transport.fetch = async (url, options) => { entered.resolve(); await release.promise; return original(url, options); };
    const pending = derpc.reader.getBalance(ADDRESS);
    const rejected = expect(pending).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    await entered.promise;
    advance(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    release.resolve();
    expect(derpc.status().operators.every(operator => operator.state === "eligible")).toBe(true);
  });

  it("rechecks authority after an identity lookup before sending account data", async () => {
    const { derpc, transport, requests, directory } = setup();
    discovery.scan.mockResolvedValueOnce(directory([{ ...B, wrapperIdentity: { signer: ADDRESS } }]));
    await derpc.refreshDirectory(REQUEST);
    advance(DIRECTORY_SNAPSHOT_TTL_MS - 1000);
    const original = transport.fetch;
    transport.fetch = async (url, options) => {
      const response = await original(url, options);
      if (url.endsWith("/.well-known/derpc.json")) advance(1000);
      return response;
    };
    const before = requests.length;
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(requests).toHaveLength(before);
  });

  it("checks TTL before money starts and again after asynchronous payment completion", async () => {
    const verified = vi.fn(async () => { advance(DIRECTORY_SNAPSHOT_TTL_MS); });
    const begin = vi.fn(async () => ({ headers: () => ({}), verified, failed: vi.fn() }));
    const { derpc } = setup({ payments: { has: () => true, begin } as unknown as DeRPCPaymentClient });
    const result = await derpc.refreshDirectory(REQUEST);
    derpc.setRouting({ selection: "manual" }, [result.operators[0]!]);
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(verified).toHaveBeenCalledTimes(1);
    await expect(derpc.reader.getTransactionCount(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("lets a user cancel an in-flight ENS read and never accepts the later response", async () => {
    const { derpc, transport } = setup();
    await derpc.refreshDirectory(REQUEST);
    const entered = deferred<void>(), release = deferred<void>();
    const original = transport.fetch;
    transport.fetch = async (url, options) => { entered.resolve(); await release.promise; return original(url, options); };
    const pending = derpc.reader.getBalance(ADDRESS);
    const rejected = expect(pending).rejects.toThrow("operator selection changed");
    await entered.promise;
    derpc.setRouting({ selection: "balanced", allowedOperators: [] });
    release.resolve(); await rejected;
    expect(derpc.status().operators).toEqual([]);
  });

  it("preserves the old deadline when the user cancels a newer directory refresh", async () => {
    const { derpc, directory, nextBlock } = setup();
    await derpc.refreshDirectory(REQUEST);
    const snapshot = derpc.status().routing!.directorySnapshot!;
    advance(60_000); nextBlock();
    const entered = deferred<void>(), release = deferred<Directory>();
    discovery.scan.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const controller = new AbortController();
    const pending = derpc.refreshDirectory({ ...REQUEST, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("cancelled by user");
    await entered.promise;
    controller.abort(new Error("cancelled by user"));
    release.resolve(directory());
    await rejected;
    expect(derpc.status().routing?.directorySnapshot).toEqual(snapshot);
  });

  it("does not allow re-supplying a removed or rotated ENS endpoint", async () => {
    const { derpc, directory, nextBlock } = setup();
    const result = await derpc.refreshDirectory(REQUEST);
    advance(60_000); nextBlock();
    discovery.scan.mockResolvedValueOnce(directory([C]));
    await derpc.refreshDirectory(REQUEST);
    expect(() => derpc.setOperators([result.operators[0]!])).toThrow("removed");
    expect(() => derpc.setRouting({ selection: "manual" }, [{ url: B.url, priority: 2 }])).toThrow("removed");
    expect(() => derpc.setRouting({ selection: "manual" }, [{ id: B.ens, url: "https://replacement.example/rpc", priority: 2 }])).toThrow("removed");
  });

  it("does not apply directory expiry to settlement of an already funded session", async () => {
    const payments: DeRPCPaymentClient = { has: () => true, begin: vi.fn(), latestVoucher: () => ({ sessionId: 1n, amount: 2n, signature: "0x01" }), prepareClose: vi.fn() };
    const { derpc, requests } = setup({ payments });
    await derpc.refreshDirectory(REQUEST);
    advance(DIRECTORY_SNAPSHOT_TTL_MS);
    await expect(derpc.settlePayment("b")).resolves.toMatchObject({ highestAmount: "2" });
    expect(requests.at(-1)!.url).toBe("https://b.example/payments/voucher");
    expect(payments.begin).not.toHaveBeenCalled();
  });
});
