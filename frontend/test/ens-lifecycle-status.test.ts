import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_LIFECYCLE_EVIDENCE_BYTES, lifecycleStatus, parseLifecycleEvidence, type LifecycleDirectory, type LifecycleSnapshot } from "../src/ens-lifecycle-status.ts";

const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;
const ADDRESS = `0x${"12".repeat(20)}`;
const NOW = 1_793_980_000_000;
const rotate = { type: "rotate-endpoint", label: "alice", expectedEndpoint: "https://old.example/rpc", newEndpoint: "https://new.example/rpc" };
const nodes = [{ id: "node-a", url: "https://a.example/rpc", beaconUrl: "https://a.example/beacon" }, { id: "node-b", url: "https://b.example/rpc" }];
const plural = { type: "rotate-endpoints", label: "alice", expectedEndpoints: [{ id: "node-a", url: "https://old.example/rpc" }], newEndpoints: nodes };

function fixture(action: unknown = rotate) {
  return {
    schemaVersion: 1, kind: "derpc-ens-lifecycle-evidence", chainId: 1, localOnly: false,
    verifiedAt: "2026-11-06T15:10:37.686Z", manifestHash: HASH, action, transactionHash: OTHER_HASH,
    receipt: { blockNumber: "100", blockHash: HASH, transactionIndex: 0, from: ADDRESS, to: ADDRESS, gasUsed: "97000", confirmations: "12" },
    before: { entry: { label: "alice", active: true }, records: { "derpc.endpoint": "https://old.example/rpc" } },
    after: { records: { "derpc.endpoint": "https://new.example/rpc" } }, current: { records: { "derpc.endpoint": "https://new.example/rpc" } },
    verification: { canonicalReceipt: true, exactRequest: true, receiptParentPreconditions: true, receiptBlockState: true, currentState: true, rolesAndRuntime: true },
    finality: { status: "pending-finality", finalizedBlock: { number: "99", hash: OTHER_HASH }, clientRefreshVerified: false },
    trust: "Administrative RPC observations only.",
  };
}

function context(operators: LifecycleDirectory["operators"] = [{ ens: "alice.derpc.eth", url: rotate.newEndpoint, expiry: Math.floor(NOW / 1000) + 3600 }], blockNumber = 101) {
  const directory: LifecycleDirectory = { operators, rejected: [], listVerification: "proven", recordVerification: "proven", blockNumber, blockHash: HASH };
  const snapshot: LifecycleSnapshot = { blockNumber, blockHash: HASH, verifiedAt: NOW - 1000, expiresAt: NOW + 60_000, state: "fresh" };
  return { directory, snapshot, now: NOW };
}

afterEach(() => vi.unstubAllGlobals());

describe("public ENS lifecycle evidence import", () => {
  it("reduces CLI evidence to immutable display metadata without fetching, trusting or retaining arbitrary text", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const data = fixture();
    data.trust = '<img src=x onerror="alert(1)">';
    const parsed = parseLifecycleEvidence(JSON.stringify(data));
    expect(parsed.name).toBe("alice.derpc.eth");
    expect(parsed.receipt).toEqual({ blockNumber: 100, blockHash: HASH });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.action)).toBe(true);
    expect(Object.isFrozen(parsed.receipt)).toBe(true);
    expect(parsed).not.toHaveProperty("trust");
    expect(parsed).not.toHaveProperty("verification");
    expect(parsed).not.toHaveProperty("current");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts all supported actions and validates canonical plural endpoints with the shared ENS schema", () => {
    for (const action of [rotate, plural, { type: "delist", label: "alice" }, { type: "renew", label: "alice", expectedExpiry: 123, expiry: 456, authority: "operator" }]) {
      expect(parseLifecycleEvidence(JSON.stringify(fixture(action))).action.type).toBe(action.type);
    }
    const parsed = parseLifecycleEvidence(JSON.stringify(fixture({ ...plural, newEndpoints: [{ id: "node-a", url: "https://EXAMPLE.com" }] })));
    expect(parsed.action).toMatchObject({ newEndpoints: [{ id: "node-a", url: "https://example.com/" }] });
  });

  it.each([
    { ...rotate, label: '<script>' },
    { ...rotate, privateKey: HASH },
    { ...rotate, newEndpoint: 'javascript:alert(1)' },
    { ...rotate, newEndpoint: 'https://user:secret@example.com/' },
    { ...rotate, newEndpoint: 'https://example.com/?key=secret' },
    { ...rotate, newEndpoint: 'https://example.com/#secret' },
    { ...rotate, newEndpoint: `http://${"a".repeat(56)}.onion/rpc` },
    { ...rotate, newEndpoint: rotate.expectedEndpoint },
    { type: "renew", label: "alice", expectedExpiry: 100, expiry: 100, authority: "operator" },
    { type: "renew", label: "alice", expectedExpiry: 100, expiry: 101, authority: "anyone" },
    { type: "transfer", label: "alice" },
    { type: "delist", label: "alice", transaction: {} },
  ])("rejects malformed or broadened actions %#", action => {
    expect(() => parseLifecycleEvidence(JSON.stringify(fixture(action)))).toThrow();
  });

  it.each([
    [],
    Array.from({ length: 9 }, (_, i) => ({ id: `node-${i}`, url: `https://node-${i}.example/` })),
    [{ id: "one", url: "https://one.example/" }, { id: "one", url: "https://two.example/" }],
    [{ id: "one", url: "https://same.example" }, { id: "two", url: "https://SAME.example/" }],
    [{ id: "one", url: "https://one.example/", payee: ADDRESS }],
    [{ id: "one", url: "https://one.example/", beaconUrl: "http://127.0.0.1:8545" }],
    [{ id: "one", url: `https://one.example/${"a".repeat(2040)}` }],
  ])("rejects invalid plural node lists %#", newEndpoints => {
    expect(() => parseLifecycleEvidence(JSON.stringify(fixture({ ...plural, newEndpoints })))).toThrow();
  });

  it("enforces the 4096-byte record bound even when each endpoint is individually valid", () => {
    const newEndpoints = Array.from({ length: 8 }, (_, i) => ({ id: `node-${i}`, url: `https://${i}.example/${"a".repeat(550)}` }));
    expect(() => parseLifecycleEvidence(JSON.stringify(fixture({ ...plural, newEndpoints })))).toThrow(/4096/);
  });

  it("rejects claimed browser verification, wrong chain, unexpected roots and invalid receipt numbers", () => {
    const mutations = [
      { ...fixture(), chainId: 560048 },
      { ...fixture(), provider: "https://attacker.example/" },
      { ...fixture(), kind: "derpc-ens-lifecycle-plan" },
      { ...fixture(), finality: { ...fixture().finality, clientRefreshVerified: true } },
      { ...fixture(), finality: { ...fixture().finality, status: "finalized" } },
      { ...fixture(), receipt: { ...fixture().receipt, blockNumber: "9007199254740992" } },
      { ...fixture(), receipt: { ...fixture().receipt, confirmations: "1" } },
      { ...fixture(), verification: { ...fixture().verification, exactRequest: false } },
    ];
    for (const input of mutations) expect(() => parseLifecycleEvidence(JSON.stringify(input))).toThrow();
  });

  it("bounds UTF-8 bytes and recursive complexity before retaining evidence", () => {
    expect(() => parseLifecycleEvidence(" ".repeat(MAX_LIFECYCLE_EVIDENCE_BYTES + 1))).toThrow(/128 KiB/);
    expect(() => parseLifecycleEvidence(JSON.stringify({ ...fixture(), trust: "é".repeat(MAX_LIFECYCLE_EVIDENCE_BYTES / 2) }))).toThrow(/128 KiB/);
    let deep: unknown = {};
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => parseLifecycleEvidence(JSON.stringify({ ...fixture(), before: deep }))).toThrow(/complex/);
    expect(() => parseLifecycleEvidence(JSON.stringify(fixture()).replace('"before":{', '"before":{"__proto__":{},'))).toThrow(/key/);
  });
});

describe("lifecycle comparison with current proven ENS state", () => {
  it("never upgrades an administrative finalized claim without a browser-proven refresh", () => {
    const data = fixture();
    data.finality = { status: "finalized", finalizedBlock: { number: "120", hash: HASH }, clientRefreshVerified: false };
    const evidence = parseLifecycleEvidence(JSON.stringify(data));
    expect(lifecycleStatus(evidence).state).toBe("receipt-recorded");
    const older = context(undefined, 99);
    expect(lifecycleStatus(evidence, older).state).toBe("awaiting-proven-refresh");
    const unverified = context();
    unverified.directory.recordVerification = "unverified";
    expect(lifecycleStatus(evidence, unverified).state).toBe("awaiting-proven-refresh");
    unverified.directory.recordVerification = "proven";
    unverified.directory.listVerification = "unverified";
    expect(lifecycleStatus(evidence, unverified).state).toBe("awaiting-proven-refresh");
  });

  it("reports current expected state independently of the older administrative finality claim", () => {
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture()));
    const status = lifecycleStatus(evidence, context());
    expect(status.state).toBe("expected-state-observed");
    expect(status.provenBlockNumber).toBe(101);
    expect(status.detail).toContain("does not establish which transaction");
    expect(status.detail).toContain("canonical ancestry");
    expect(status.title).not.toMatch(/transaction verified|finalized transaction/i);
  });

  it("accepts matching state at the receipt height but rejects a conflicting imported block hash", () => {
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture()));
    expect(lifecycleStatus(evidence, context(undefined, 100)).state).toBe("expected-state-observed");
    const state = context(undefined, 100);
    state.directory.blockHash = state.snapshot.blockHash = OTHER_HASH;
    expect(lifecycleStatus(evidence, state)).toMatchObject({ state: "conflict", title: "Imported receipt conflicts with proven block" });
  });

  it("keeps missing, stale, expired, mismatched or clock-rewound snapshots pending", () => {
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture()));
    expect(lifecycleStatus(evidence, { directory: context().directory, now: NOW }).state).toBe("awaiting-proven-refresh");
    const cases = [
      { ...context().snapshot, state: "stale" as const },
      { ...context().snapshot, expiresAt: NOW },
      { ...context().snapshot, verifiedAt: NOW + 1 },
      { ...context().snapshot, blockNumber: 102 },
      { ...context().snapshot, blockHash: OTHER_HASH },
    ];
    for (const snapshot of cases) expect(lifecycleStatus(evidence, { ...context(), snapshot }).state).toBe("awaiting-proven-refresh");
  });

  it("cannot turn local-fork evidence into a public mainnet observation", () => {
    const evidence = parseLifecycleEvidence(JSON.stringify({ ...fixture(), localOnly: true }));
    expect(lifecycleStatus(evidence, context())).toMatchObject({ state: "receipt-recorded", title: "Local-fork receipt recorded" });
  });

  it("reports a mismatching legacy rotation without changing input records", () => {
    const state = context([{ ens: "alice.derpc.eth", url: rotate.expectedEndpoint }]);
    const original = JSON.stringify(state);
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture()));
    expect(lifecycleStatus(evidence, state).state).toBe("conflict");
    expect(JSON.stringify(state)).toBe(original);
  });

  it("requires the exact plural node set, including IDs and beacon endpoints", () => {
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture(plural)));
    const rows = nodes.map(node => ({ ens: "alice.derpc.eth", operatorId: "alice.derpc.eth", endpointId: node.id, url: node.url, beaconUrl: node.beaconUrl }));
    expect(lifecycleStatus(evidence, context([...rows].reverse())).state).toBe("expected-state-observed");
    for (const changed of [rows.slice(0, 1), [...rows, { ...rows[0]!, endpointId: "extra" }], rows.map(row => ({ ...row, beaconUrl: undefined })), rows.map(row => ({ ...row, endpointId: "duplicate" }))]) {
      expect(lifecycleStatus(evidence, context(changed)).state).toBe("conflict");
    }
  });

  it("does not treat an unreachable node or rejected operator as proof of delisting or complete rotation", () => {
    for (const action of [plural, { type: "delist", label: "alice" }]) {
      const evidence = parseLifecycleEvidence(JSON.stringify(fixture(action)));
      for (const name of ["alice.derpc.eth", "alice.derpc.eth#node-b"]) {
        const state = context([]);
        state.directory.rejected = [{ name, reason: "identity timed out" }];
        expect(lifecycleStatus(evidence, state).state).toBe("awaiting-proven-refresh");
      }
    }
  });

  it("reports proven absence only after the receipt height, with no target rejection", () => {
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture({ type: "delist", label: "alice" })));
    expect(lifecycleStatus(evidence, context([], 99)).state).toBe("awaiting-proven-refresh");
    expect(lifecycleStatus(evidence, context()).state).toBe("conflict");
    const absent = context([{ ens: "bob.derpc.eth", url: "https://bob.example/" }]);
    absent.directory.rejected = [{ name: "other.derpc.eth", reason: "timeout" }];
    const status = lifecycleStatus(evidence, absent);
    expect(status.state).toBe("expected-state-observed");
    expect(status.detail).toContain("does not identify why it is absent");
  });

  it("requires exact unexpired renewal across every endpoint", () => {
    const expiry = Math.floor(NOW / 1000) + 3600;
    const evidence = parseLifecycleEvidence(JSON.stringify(fixture({ type: "renew", label: "alice", expectedExpiry: expiry - 60, expiry, authority: "curator" })));
    expect(lifecycleStatus(evidence, context()).state).toBe("expected-state-observed");
    expect(lifecycleStatus(evidence, context([])).state).toBe("conflict");
    expect(lifecycleStatus(evidence, context([{ ens: "alice.derpc.eth", url: rotate.newEndpoint, expiry: expiry + 1 }])).state).toBe("conflict");
    const expired = parseLifecycleEvidence(JSON.stringify(fixture({ type: "renew", label: "alice", expectedExpiry: 1, expiry: 2, authority: "operator" })));
    expect(lifecycleStatus(expired, context([{ ens: "alice.derpc.eth", url: rotate.newEndpoint, expiry: 2 }])).state).toBe("conflict");
  });
});
