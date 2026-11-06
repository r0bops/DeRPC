import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeRPCWith, DIRECTORY_SNAPSHOT_TTL_MS, DirectorySnapshotExpiredError, type DeRPC, type DeRPCOperator, type DeRPCOptions, type DeRPCPaymentClient } from "../../src/api/derpc.ts";
import { operatorKey } from "../../src/pool/pool.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import type { Directory } from "../../src/discovery/ens.ts";
import type { AnonTransport } from "../../src/transport/anon-transport.ts";
import type { VerifiedHeader, VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import fixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };

const discovery = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock("../../src/discovery/ens.ts", async original => ({ ...await original<typeof import("../../src/discovery/ens.ts")>(), discoverOperators: discovery.scan }));
type Hex = `0x${string}`;
const ADDRESS = fixture.specifier as Hex;
const BASE = Math.floor(fixture.capturedAt / 1000) * 1000;
const BOOTSTRAP: DeRPCOperator = { id: "bootstrap", url: "https://bootstrap.example/rpc", priority: 0 };
const WEST: DeRPCOperator = { id: "alice.derpc.eth#west", operatorId: "alice.derpc.eth", endpointId: "west", ens: "alice.derpc.eth", ensOwner: ADDRESS, operator: "Alice", url: "https://alice-west.example/rpc", priority: 0, wrapperIdentity: { signer: ADDRESS } };
const EAST: DeRPCOperator = { ...WEST, id: "alice.derpc.eth#east", endpointId: "east", url: "https://alice-east.example/rpc" };
const BOB: DeRPCOperator = { id: "bob.derpc.eth", operatorId: "bob.derpc.eth", ens: "bob.derpc.eth", operator: "Bob", url: "https://bob.example/rpc", priority: 0 };
const REQUEST = { ethRegistry: ADDRESS, registrar: { address: ADDRESS, codeHash: fixture.block.hash as Hex }, verifiedRecords: true };
const providers: DeRPC[] = [];
let now: number;

function setup(options: DeRPCOptions = {}) {
  let header: VerifiedHeader = { slot: 0, blockNumber: fixture.block.number, blockHash: fixture.block.hash as Hex, stateRoot: fixture.block.stateRoot as Hex, timestamp: BASE / 1000 };
  let closed = false;
  const requests: { url: string; method: string; params: any[] }[] = [];
  const identities = new Map<string, Record<string, unknown>>();
  const failed = new Set<string>(), corrupt = new Set<string>();
  const transport: AnonTransport = {
    pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => closed ? "closed" : "ready", close: () => { closed = true; },
    async fetch(url, options = {}) {
      if (url.endsWith("/.well-known/derpc.json")) return Response.json(identities.get(new URL(url).origin));
      const body = JSON.parse(String(options.body));
      requests.push({ url, method: body.method, params: body.params });
      if (failed.has(url)) throw new Error("node unavailable");
      if (body.method !== "eth_getProof" || body.params[0].toLowerCase() !== ADDRESS.toLowerCase()) throw new Error("no fixture");
      const proof = structuredClone(fixture.proof);
      if (!body.params[1].length) proof.storageProof = [];
      if (corrupt.has(url)) proof.balance = "0xffff";
      return Response.json({ jsonrpc: "2.0", id: body.id, result: proof });
    },
  };
  function identity(operator: DeRPCOperator) {
    identities.set(new URL(operator.url).origin, { version: "1", ens: operator.ens, signer: operator.wrapperIdentity?.signer ?? ADDRESS,
      chains: [1], service: "node", ...(operator.endpointId ? { endpointId: operator.endpointId } : {}) });
  }
  [WEST, EAST, BOB, ...(options.operators ?? [])].forEach(identity);
  const headers: VerifiedHeaderSource = { finalized: () => header, assertFresh() {}, pollHealth: () => ({ consecutiveFailures: 0 }), close() {} };
  const derpc = createDeRPCWith({ startTransport: () => transport, startHeaders: async () => headers }, { operators: [WEST, EAST, BOB], selection: "balanced", verifiedCalls: true, ...options });
  providers.push(derpc);
  function directory(operators: DeRPCOperator[] = [WEST, EAST, BOB]): Directory {
    operators.forEach(identity);
    return { operators: operators.map(operator => ({ ...operator, ens: operator.ens!, expiry: BASE / 1000 + 7200, proofVerifiedAt: header.blockNumber })), rejected: [], listVerification: "proven", recordVerification: "proven", blockNumber: header.blockNumber, blockHash: header.blockHash };
  }
  discovery.scan.mockImplementation(async () => directory());
  function nextBlock() { now += 60_000; header = { ...header, blockNumber: header.blockNumber + 1, blockHash: `0x${header.blockNumber.toString(16).padStart(64, "0")}` as Hex, timestamp: now / 1000 - 60 }; }
  return { derpc, requests, transport, identities, failed, corrupt, directory, nextBlock };
}

beforeEach(() => { now = BASE + 60_000; vi.spyOn(Date, "now").mockImplementation(() => now); vi.spyOn(Math, "random").mockReturnValue(0); discovery.scan.mockReset(); });
afterEach(() => { providers.splice(0).forEach(provider => provider.close()); vi.restoreAllMocks(); });

describe("operator-level routing with several endpoints", () => {
  it("uses all groups when omitted, and selects every endpoint of an allowed operator", () => {
    const { derpc } = setup();
    expect(derpc.status().operators).toHaveLength(3);
    expect(new Set(derpc.status().operators.map(operatorKey))).toEqual(new Set([WEST.operatorId, BOB.operatorId]));
    derpc.setRouting({ selection: "fastest", allowedOperators: [WEST.operatorId!] });
    expect(derpc.status().operators.map(operator => operator.id)).toEqual([WEST.id, EAST.id]);
    derpc.setRouting({ selection: "reliable", allowedOperators: [] });
    expect(derpc.status().operators).toEqual([]);
  });

  it.each([WEST.id!, EAST.id!, WEST.endpointId!])("does not interpret a node key %s as an operator allowlist", node => {
    const { derpc, requests } = setup({ allowedOperators: [node] });
    expect(derpc.status().operators).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("retains the legacy singleton ID alias even when it differs from the ENS name", () => {
    const { derpc } = setup({ operators: [{ ...BOB, id: "legacy-bob" }], allowedOperators: ["legacy-bob"] });
    expect(derpc.status().operators.map(operator => operator.id)).toEqual(["legacy-bob"]);
  });

  it("fails over to a sibling before disclosing the account to another operator", async () => {
    const { derpc, failed, requests } = setup();
    await derpc.reader.getTransactionCount(ADDRESS);
    const count = requests.length;
    failed.add(WEST.url);
    await expect(derpc.reader.getBalance(ADDRESS)).resolves.toMatchObject({ value: 0n });
    expect(requests.slice(count).map(request => request.url)).toEqual([WEST.url, EAST.url]);
  });

  it.each([
    [{ ...WEST, endpointId: "Uppercase" }], [{ ...WEST, endpointId: "a".repeat(32) }], [{ ...WEST, endpointId: "-edge" }],
    [WEST, { ...EAST, endpointId: "west" }], [WEST, { ...EAST, operatorId: "another-group" }],
    [WEST, { ...EAST, wrapperIdentity: { signer: `0x${"22".repeat(20)}` as Hex } }],
    Array.from({ length: 9 }, (_, i) => ({ ...WEST, id: `alice.derpc.eth#node-${i}`, endpointId: `node-${i}`, url: `https://node-${i}.example/rpc` })),
  ])("rejects inconsistent explicit groups before worker startup, including manual mode", operators => {
    for (const selection of [undefined, "balanced"] as const) {
      const startTransport = vi.fn(() => { throw new Error("must not start"); });
      expect(() => createDeRPCWith({ startTransport, startHeaders: vi.fn() }, { operators, selection })).toThrow();
      expect(startTransport).not.toHaveBeenCalled();
    }
  });

  it.each(["metadata", "node session", "group session"])("refuses plural paid %s before startup", kind => {
    const terms = { price: 1n, payee: ADDRESS, chainId: 560048, escrow: ADDRESS, payeeProven: true, recordsProven: true };
    const operators = kind === "metadata" ? [{ ...WEST, payment: terms }] : [WEST, EAST];
    const payments = { has: (id: string) => kind === "node session" ? id === WEST.id : kind === "group session" && id === WEST.operatorId, begin: vi.fn() } as unknown as DeRPCPaymentClient;
    const startTransport = vi.fn(() => { throw new Error("must not start"); });
    expect(() => createDeRPCWith({ startTransport, startHeaders: vi.fn() }, { operators, payments })).toThrow("paid multi-endpoint");
    expect(startTransport).not.toHaveBeenCalled();
    expect(payments.begin).not.toHaveBeenCalled();
  });

  it("cannot activate a paid node session later through a previously free manual group", async () => {
    let funded = false;
    const begin = vi.fn();
    const { derpc, requests } = setup({ selection: undefined, payments: { has: () => funded, begin } as unknown as DeRPCPaymentClient });
    await derpc.reader.getBalance(ADDRESS);
    funded = true;
    const count = requests.length;
    await expect(derpc.reader.getTransactionCount(ADDRESS)).rejects.toThrow("paid multi-endpoint");
    expect(requests).toHaveLength(count);
    expect(begin).not.toHaveBeenCalled();
    expect(() => derpc.registerPaymentOperator(WEST)).toThrow("paid multi-endpoint");
  });

  it("keeps a legacy single funded endpoint working", async () => {
    const verified = vi.fn(async () => {});
    const begin = vi.fn(async () => ({ headers: () => ({}), verified, failed: vi.fn() }));
    const { derpc } = setup({ operators: [BOB], selection: undefined, payments: { has: () => true, begin } as unknown as DeRPCPaymentClient });
    await derpc.reader.getBalance(ADDRESS);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(begin.mock.calls[0]![0]).toBe(BOB.id);
    expect(verified).toHaveBeenCalledTimes(1);
  });

  it("checks the node ID in wrapper identity before sending an account query", async () => {
    const { derpc, identities, requests } = setup();
    identities.set(new URL(WEST.url).origin, { version: "1", ens: WEST.ens, signer: ADDRESS, endpointId: "wrong-node", chains: [1], service: "node" });
    await derpc.reader.getBalance(ADDRESS);
    expect(requests.some(request => request.url === WEST.url)).toBe(false);
    expect(requests.some(request => request.url === EAST.url)).toBe(true);
    expect(requests.some(request => request.url === BOB.url)).toBe(false);
  });
});

describe("proven endpoint grouping, rotation and expiry", () => {
  it.each(["operatorId", "endpointId", "ensOwner", "wrapperIdentity", "all fields"])("refuses stripped %s on a known plural endpoint", async field => {
    const { derpc } = setup({ operators: [BOOTSTRAP] });
    const directory = await derpc.refreshDirectory(REQUEST);
    const candidate: DeRPCOperator = field === "all fields" ? { url: WEST.url, priority: 0 } : { ...directory.operators[0]!, [field]: undefined };
    expect(() => derpc.setRouting({ selection: "manual" }, [candidate])).toThrow();
    expect(derpc.status().operators.map(operator => operator.id)).toEqual([WEST.id, EAST.id, BOB.id]);
  });

  it("retains group selection across endpoint removal, then drops every sibling on operator revocation", async () => {
    const { derpc, directory, nextBlock } = setup({ operators: [BOOTSTRAP] });
    await derpc.refreshDirectory(REQUEST);
    derpc.setRouting({ selection: "balanced", allowedOperators: [WEST.operatorId!] });
    nextBlock(); discovery.scan.mockResolvedValueOnce(directory([EAST, BOB]));
    await derpc.refreshDirectory(REQUEST);
    expect(derpc.status().operators.map(operator => operator.id)).toEqual([EAST.id]);
    nextBlock(); discovery.scan.mockResolvedValueOnce(directory([BOB]));
    await derpc.refreshDirectory(REQUEST);
    expect(derpc.status().operators).toEqual([]);
    expect(() => derpc.setOperators([WEST])).toThrow("removed");
  });

  it("does not carry an old URL's exclusion to a proven replacement under the same node ID", async () => {
    const { derpc, directory, corrupt, nextBlock } = setup({ operators: [BOOTSTRAP] });
    await derpc.refreshDirectory(REQUEST);
    corrupt.add(WEST.url);
    await derpc.reader.getBalance(ADDRESS);
    expect(derpc.status().operators.find(operator => operator.id === WEST.id)?.state).toBe("excluded");
    const replacement = { ...WEST, url: "https://alice-west-new.example/rpc" };
    nextBlock(); discovery.scan.mockResolvedValueOnce(directory([replacement, EAST, BOB]));
    await derpc.refreshDirectory(REQUEST);
    const changed = derpc.status().operators.find(operator => operator.id === WEST.id)!;
    expect(changed.state).toBe("eligible");
    expect(changed.observations).toBeUndefined();
    derpc.setRouting({ selection: "manual" }, [directory([replacement]).operators[0]!]);
    await expect(derpc.reader.getBalance(ADDRESS)).resolves.toMatchObject({ value: 0n });
    expect(() => derpc.setOperators([{ url: WEST.url, priority: 0 }])).toThrow("removed");
  });

  it.each(["same owner", "new owner", "new signer", "legacy to plural"])("preserves only authenticated operator affinity during all-node rotation: %s", async change => {
    const { derpc, directory, nextBlock, requests } = setup({ operators: [BOOTSTRAP] });
    const legacy = { ...WEST, id: WEST.operatorId!, endpointId: undefined };
    discovery.scan.mockResolvedValueOnce(directory(change === "legacy to plural" ? [legacy, BOB] : [WEST, EAST, BOB]));
    await derpc.refreshDirectory(REQUEST);
    await derpc.reader.getBalance(ADDRESS);
    const other = `0x${"22".repeat(20)}` as Hex;
    const replacements = [WEST, EAST].map(operator => ({ ...operator, url: operator.url.replace(".example", "-new.example"),
      ...(change === "new owner" ? { ensOwner: other } : {}), ...(change === "new signer" ? { wrapperIdentity: { signer: other } } : {}) }));
    nextBlock(); discovery.scan.mockResolvedValueOnce(directory([...replacements, BOB]));
    await derpc.refreshDirectory(REQUEST);
    expect(derpc.status().operators.filter(operator => operatorKey(operator) === WEST.operatorId).every(operator => !operator.observations)).toBe(true);
    vi.mocked(Math.random).mockReturnValue(0.99); // Without owner affinity, the unknown Bob group would be selected.
    const before = requests.length;
    await derpc.reader.getTransactionCount(ADDRESS);
    const destination = requests.slice(before).at(-1)!.url;
    expect(destination).toBe(change === "new owner" || change === "new signer" ? BOB.url : replacements[1]!.url);
  });

  it("does not treat explicit owner claims as authenticated continuity after all URLs change", async () => {
    const { derpc, directory, requests } = setup();
    await derpc.reader.getBalance(ADDRESS);
    const replacements = [WEST, EAST].map(operator => ({ ...operator, url: operator.url.replace(".example", "-new.example") }));
    directory(replacements); // supply the reciprocal fixture identity documents, not a proven refresh
    derpc.setOperators([...replacements, BOB]);
    vi.mocked(Math.random).mockReturnValue(0.99);
    const before = requests.length;
    await derpc.reader.getTransactionCount(ADDRESS);
    expect(requests.slice(before).at(-1)!.url).toBe(BOB.url);
  });

  it("does not retroactively prove a mixed pool's owner claim when the same snapshot gains a group", async () => {
    const { derpc, directory, requests } = setup({ operators: [BOOTSTRAP] });
    discovery.scan.mockResolvedValueOnce(directory([WEST, EAST]));
    const initial = await derpc.refreshDirectory(REQUEST);
    const claimedBob = { ...BOB, ensOwner: ADDRESS, wrapperIdentity: { signer: ADDRESS }, url: "https://bob-old.example/rpc" };
    directory([claimedBob]); // Reciprocal identity response only; no proven Bob entry exists yet.
    derpc.setRouting({ selection: "balanced" }, [...initial.operators, claimedBob]);
    vi.mocked(Math.random).mockReturnValue(0.99);
    await derpc.reader.getBalance(ADDRESS);
    expect(requests.at(-1)!.url).toBe(claimedBob.url);
    const verifiedBob = { ...claimedBob, url: "https://bob-new.example/rpc" };
    // A full scan of the same block now accepts Bob. It must not rewrite the old pool's evidence.
    discovery.scan.mockResolvedValueOnce(directory([WEST, EAST, verifiedBob]));
    await derpc.refreshDirectory(REQUEST);
    vi.mocked(Math.random).mockReturnValue(0);
    const before = requests.length;
    await derpc.reader.getTransactionCount(ADDRESS);
    expect(requests.slice(before).at(-1)!.url).toBe(WEST.url);
  });

  it("does not let a local ID rename clear a rejected destination's exclusion", async () => {
    const { derpc, corrupt, requests } = setup({ operators: [BOOTSTRAP, BOB] });
    corrupt.add(BOOTSTRAP.url);
    await derpc.reader.getBalance(ADDRESS);
    derpc.setRouting({ selection: "manual" }, [{ ...BOOTSTRAP, id: "renamed" }]);
    expect(derpc.status().operators[0]!.state).toBe("excluded");
    const count = requests.length;
    await expect(derpc.reader.getTransactionCount(ADDRESS)).rejects.toThrow("excluded");
    expect(requests).toHaveLength(count);
  });

  it("preserves snapshot expiry when changing grouped selection and closes every sibling at the deadline", async () => {
    const { derpc } = setup({ operators: [BOOTSTRAP] });
    await derpc.refreshDirectory(REQUEST);
    const expiresAt = derpc.status().routing!.directorySnapshot!.expiresAt;
    derpc.setRouting({ selection: "reliable", allowedOperators: [WEST.operatorId!] });
    expect(derpc.status().operators).toHaveLength(2);
    expect(derpc.status().routing?.directorySnapshot?.expiresAt).toBe(expiresAt);
    now += DIRECTORY_SNAPSHOT_TTL_MS;
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toBeInstanceOf(DirectorySnapshotExpiredError);
    derpc.setRouting({ selection: "balanced", allowedOperators: [] });
    expect(derpc.status().operators).toEqual([]);
  });
});
