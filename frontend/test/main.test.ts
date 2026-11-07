// The demo page shows text from the worker, the beacon nodes and the operators. All of it is untrusted,
// so it must reach the page as text, never as markup (#20).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeRPCStatus } from "@derpc/provider";
import page from "../index.html?raw";

const harness = vi.hoisted(() => ({
  traffic: undefined as DeRPCStatus["traffic"],
  networkStatus: undefined as DeRPCStatus["network"],
  transportStatus: { state: "booting" } as DeRPCStatus["transport"],
  operatorStatus: [] as DeRPCStatus["operators"],
  onStatus: undefined as ((status: unknown) => void) | undefined,
  setOperators: vi.fn(),
  setRouting: vi.fn(),
  initialOptions: undefined as Record<string, unknown> | undefined,
  routingStatus: undefined as DeRPCStatus["routing"],
  getStatus: undefined as (() => unknown) | undefined,
  verifiedCall: vi.fn(),
  getBalance: vi.fn(),
  refreshDirectory: vi.fn(),
}));

vi.mock("@derpc/provider", () => ({
  ENS_NAMES_ARE_MOCK: true,
  MAINNET_BEACON_ENDPOINTS: ["https://beacon.example"],
  MAINNET_OPERATORS: [{ id: "bootstrap", ens: "bootstrap.derpc.eth", operator: "Public Provider", url: "https://rpc.example/", priority: 0 }],
  operatorUrl: (input: string) => new URL(input),
  operatorKey: (input: { operatorId?: string; ens?: string; id?: string; url: string }) => input.operatorId ?? input.ens ?? input.id ?? input.url,
  MAINNET_TOKENS: { WETH: { address: `0x${"00".repeat(20)}`, decimals: 18 } },
  TOR_JS_PIN: { name: "tor", workerHash: `0x${"00".repeat(32)}`, resolvers: [] },
  simulatedLyingOperator: (op: { id: string }) => ({ ...op, id: `simulated-liar:${op.id}` }),
  createDeRPC: (opts: { onStatus: (status: unknown) => void }) => {
    harness.onStatus = opts.onStatus;
    harness.initialOptions = opts as unknown as Record<string, unknown>;
    const status = () => ({ worker: { name: "tor" }, checkpoint: { epoch: 1 }, transport: harness.transportStatus, lightClient: { state: "waiting" }, pin: { state: "waiting-for-operators" }, operators: harness.operatorStatus, routing: harness.routingStatus, traffic: harness.traffic, network: harness.networkStatus });
    harness.getStatus = status;
    return {
      ready: Promise.resolve(),
      reader: {},
      setOperators: harness.setOperators,
      setRouting: harness.setRouting,
      refreshDirectory: harness.refreshDirectory,
      verifiedCall: harness.verifiedCall,
      close: () => {},
      status,
    };
  },
}));
vi.mock("@derpc/provider/viem", () => ({ derpcTransport: () => ({}) }));
vi.mock("viem", async importOriginal => ({ ...await importOriginal<typeof import("viem")>(), createPublicClient: () => ({ getBalance: harness.getBalance }) }));
vi.mock("viem/chains", () => ({ mainnet: {} }));

const PAYLOAD = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("VITE_ENS_DIRECTORY", undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("")));
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  localStorage.clear();
  history.replaceState(null, "", "/");
  harness.setOperators.mockClear();
  harness.setRouting.mockReset();
  harness.setRouting.mockImplementation((options, operators) => {
    harness.routingStatus = { selection: options.selection, source: "explicit" };
    if (operators) harness.setOperators(operators);
  });
  harness.routingStatus = undefined;
  harness.traffic = undefined;
  harness.networkStatus = undefined;
  harness.transportStatus = { state: "booting" };
  harness.operatorStatus = [];
  harness.refreshDirectory.mockReset();
  harness.verifiedCall.mockReset();
  harness.getBalance.mockReset();
  document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");

  await import("../src/main.ts");
});

afterEach(async () => {
  // Finish the page's asynchronous read/error rendering before restoring its mocked transport.
  await vi.advanceTimersByTimeAsync(0);
  harness.onStatus = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function expectPlainText(id: string) {
  const el = document.getElementById(id)!;
  expect(el.textContent).toContain(PAYLOAD);
  expect(el.querySelector("img")).toBeNull();
  expect(el.querySelector("script")).toBeNull();
}

const pluralOperators = () => ["east", "west"].map(endpointId => ({ id: `alice.derpc.eth#${endpointId}`, operatorId: "alice.derpc.eth", endpointId, ens: "alice.derpc.eth", url: `https://${endpointId}.example/rpc`, priority: 0 }));
async function refreshOperators(operators: unknown[]) {
  harness.refreshDirectory.mockResolvedValue({ operators, rejected: [], blockNumber: 42, blockHash: `0x${"ab".repeat(32)}`, listVerification: "proven", recordVerification: "proven" });
  (document.getElementById("ens-registry") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
  document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect((document.getElementById("refresh-directory") as HTMLButtonElement).disabled).toBe(false));
}

const directoryPins = {
  chainId: 1,
  ethRegistry: `0x${"11".repeat(20)}`,
  registrar: { address: `0x${"22".repeat(20)}`, codeHash: `0x${"33".repeat(32)}`, registry: `0x${"44".repeat(20)}` },
};
async function loadConfiguredDirectory() {
  await vi.advanceTimersByTimeAsync(0);
  vi.resetModules(); vi.clearAllTimers();
  vi.stubEnv("VITE_ENS_DIRECTORY", JSON.stringify(directoryPins));
  document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
  await import("../src/main.ts");
}

function lifecycleEvidence() {
  const hash = `0x${"ab".repeat(32)}`;
  return {
    schemaVersion: 1, kind: "derpc-ens-lifecycle-evidence", chainId: 1, localOnly: false,
    verifiedAt: "2026-11-06T12:00:00.000Z", manifestHash: hash,
    action: { type: "delist", label: "alice" }, transactionHash: hash,
    receipt: { blockNumber: "40", blockHash: hash, transactionIndex: 0, from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, gasUsed: "100000", confirmations: "12" },
    before: {}, after: {}, current: {},
    verification: { canonicalReceipt: true, exactRequest: true, receiptParentPreconditions: true, receiptBlockState: true, currentState: true, rolesAndRuntime: true },
    finality: { status: "pending-finality", finalizedBlock: { number: "39", hash }, clientRefreshVerified: false },
  };
}
async function importLifecycle(file: Pick<File, "size" | "text">) {
  const input = document.getElementById("lifecycle-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(input.disabled).toBe(false));
}

describe("demo page status rendering", () => {
  it("displays the real bootstrap provider while keeping its placeholder solely as an internal selection key", () => {
    const choice = document.querySelector<HTMLInputElement>("#operators input")!;
    expect(choice.value).toBe("bootstrap.derpc.eth");
    expect(document.getElementById("operators")!.textContent).toContain("Public Provider");
    expect(document.getElementById("operators")!.textContent).toContain("Public bootstrap");
    expect(document.getElementById("pool")!.textContent).toContain("Public Provider");
    expect(document.getElementById("pool")!.textContent).toContain("not ENS-enrolled");
    expect(document.body.textContent).not.toContain("bootstrap.derpc.eth");
    choice.checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    const candidates = harness.setRouting.mock.lastCall![1];
    expect(candidates).toEqual([expect.objectContaining({ id: "bootstrap", operatorId: "bootstrap.derpc.eth", operator: "Public Provider" })]);
    expect(candidates[0]).not.toHaveProperty("ens");
    expect(localStorage.getItem("derpc:chosen-operators")).toBe('["bootstrap.derpc.eth"]');
    expect(document.getElementById("choice-status")!.textContent).toContain("using Public Provider");
    (harness.initialOptions!.onPoolEvent as (event: unknown) => void)({ type: "success", endpoint: "bootstrap", at: Date.now() });
    expect(document.getElementById("pool-events")!.textContent).toContain("Public Provider");
    expect(document.body.textContent).not.toContain("bootstrap.derpc.eth");
  });

  it("restores legacy saved bootstrap choices without restoring placeholder ENS identity metadata", async () => {
    localStorage.setItem("derpc:chosen-operators", '["bootstrap.derpc.eth"]');
    vi.resetModules(); vi.clearAllTimers();
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../src/main.ts");
    const candidates = harness.initialOptions!.operators as Record<string, unknown>[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: "bootstrap", operatorId: "bootstrap.derpc.eth" });
    expect(candidates[0]).not.toHaveProperty("ens");
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("bootstrap.derpc.eth");
  });

  it("does not promote a selected bootstrap placeholder into a matching newly discovered ENS identity", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await refreshOperators([{ id: "bootstrap.derpc.eth", ens: "bootstrap.derpc.eth", url: "https://registered.example/rpc", priority: 0 }]);
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(0);
    expect(document.getElementById("choice-status")!.textContent).toContain("no operators; reads are stopped");
    expect(document.getElementById("directory-status")!.textContent).toContain("1 previous choice(s) removed");
    expect(document.getElementById("operators")!.textContent).toContain("bootstrap.derpc.eth");
    expect(document.getElementById("pool")!.textContent).toContain("ENS list proven · records proven");
    expect(harness.setRouting).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("derpc:chosen-operators")).toBe("[]");
  });

  it("prefills configured deployment pins without refreshing or selecting operators, then explicitly refreshes with every pin", async () => {
    await loadConfiguredDirectory();
    const values = {
      "ens-registry": directoryPins.ethRegistry,
      "ens-registrar": directoryPins.registrar.address,
      "ens-code-hash": directoryPins.registrar.codeHash,
      "ens-subregistry": directoryPins.registrar.registry,
    };
    for (const [id, value] of Object.entries(values)) {
      expect((document.getElementById(id) as HTMLInputElement).value).toBe(value);
      expect((document.getElementById(id) as HTMLInputElement).readOnly).toBe(true);
    }
    expect((document.getElementById("ens-verified-records") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("ens-verified-records") as HTMLInputElement).disabled).toBe(true);
    expect(document.getElementById("directory-status")!.textContent).toContain("has not been verified");
    expect(harness.refreshDirectory).not.toHaveBeenCalled();
    expect(harness.setRouting).not.toHaveBeenCalled();
    expect(harness.initialOptions!.operators).toEqual([]);
    await refreshOperators(pluralOperators());
    expect(harness.refreshDirectory).toHaveBeenCalledWith({
      ethRegistry: directoryPins.ethRegistry, registrar: directoryPins.registrar, verifiedRecords: true,
    });
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(0);
    expect(harness.setRouting).not.toHaveBeenCalled();
    expect(document.getElementById("refresh-directory")!.textContent).toBe("Refresh proven ENS directory");
  });

  it.each(["ens-registry", "ens-registrar", "ens-code-hash", "ens-subregistry", "ens-verified-records"])("cannot silently remove configured %s protection", async id => {
    await loadConfiguredDirectory();
    const field = document.getElementById(id) as HTMLInputElement;
    if (field.type === "checkbox") field.checked = false;
    else field.value = "";
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(harness.refreshDirectory).not.toHaveBeenCalled();
    expect(harness.setOperators).not.toHaveBeenCalled();
    expect(document.getElementById("directory-status")!.textContent).toContain("no unverified refresh was sent");
  });

  it("keeps the displayed roster unchanged if a configured refresh does not return both proofs", async () => {
    await loadConfiguredDirectory();
    const before = document.getElementById("operators")!.textContent;
    harness.refreshDirectory.mockResolvedValue({
      operators: pluralOperators(), rejected: [], blockNumber: 42, blockHash: `0x${"ab".repeat(32)}`,
      listVerification: "proven", recordVerification: "unverified",
    });
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect((document.getElementById("refresh-directory") as HTMLButtonElement).disabled).toBe(false));
    expect(document.getElementById("operators")!.textContent).toBe(before);
    expect(document.getElementById("directory-status")!.textContent).toContain("requires proven membership and records");
    expect(harness.setRouting).not.toHaveBeenCalled();
  });

  it("forwards a manually supplied expected subregistry and rejects an orphaned subregistry pin", async () => {
    (document.getElementById("ens-registry") as HTMLInputElement).value = directoryPins.ethRegistry;
    (document.getElementById("ens-subregistry") as HTMLInputElement).value = directoryPins.registrar.registry;
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(harness.refreshDirectory).not.toHaveBeenCalled();
    expect(document.getElementById("directory-status")!.textContent).toContain("requires a registrar");
    (document.getElementById("ens-registrar") as HTMLInputElement).value = directoryPins.registrar.address;
    (document.getElementById("ens-code-hash") as HTMLInputElement).value = directoryPins.registrar.codeHash;
    (document.getElementById("ens-verified-records") as HTMLInputElement).checked = true;
    await refreshOperators([]);
    expect(harness.refreshDirectory).toHaveBeenCalledWith({
      ethRegistry: directoryPins.ethRegistry, registrar: directoryPins.registrar, verifiedRecords: true,
    });
  });

  it("labels worker logs as diagnostics and leaves transport state and controls authoritative", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const disabledBefore = (document.getElementById("read-again") as HTMLButtonElement).disabled;
    const chosenBefore = document.getElementById("choice-status")!.textContent;
    (harness.initialOptions!.onWorkerLog as (line: unknown) => void)({ level: "warn", text: "all gateways failed: dial timed out" });
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("worker-status")!.textContent).toContain("worker log reports a gateway dial failure");
    expect(document.getElementById("worker-status")!.textContent).toContain("waiting for transport status");
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(disabledBefore);
    expect(document.getElementById("choice-status")!.textContent).toBe(chosenBefore);
    expect(harness.transportStatus.state).toBe("booting");
    harness.transportStatus = { state: "ready" };
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("worker-status")!.textContent).not.toContain("gateway dial failure");
    expect(document.getElementById("worker-status")!.textContent).not.toContain("nothing goes direct");
  });

  it("explains slow startup without guessing which gateway failed", () => {
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 31_000);
    harness.onStatus?.(harness.getStatus!());
    const status = document.getElementById("worker-status")!.textContent;
    expect(status).toContain("taking longer than usual");
    expect(status).toContain("no direct RPC fallback");
    expect(status).not.toContain("gateway not answering");
  });

  it("keeps cumulative fetch attempts separate from retained resource observations", async () => {
    expect(document.getElementById("traffic")!.textContent).toContain("count unavailable");
    harness.traffic = { throughWorker: 0 };
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("traffic")!.textContent).toContain("0 fetch attempts");
    harness.traffic = { throughWorker: 12 };
    harness.networkStatus = { state: "unavailable", error: "last attempt failed" };
    vi.mocked(performance.getEntriesByType).mockReturnValue([
      { name: "https://rpc.example/a", entryType: "resource", startTime: 1, duration: 2 },
      { name: "https://rpc.example/b", entryType: "resource", startTime: 2, duration: 2 },
    ] as PerformanceEntry[]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.getElementById("traffic")!.textContent).toContain("12 fetch attempts handed to Anon-RPC");
    expect(document.getElementById("traffic")!.textContent).not.toMatch(/%|direct|successful/);
    expect(document.getElementById("direct-status")!.textContent).toContain("2 HTTP(S) resource timing observations retained");
    vi.mocked(performance.getEntriesByType).mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.getElementById("direct-status")!.textContent).toContain("2 HTTP(S)");
    expect(document.getElementById("traffic")!.textContent).toContain("12 fetch attempts");
    vi.mocked(performance.getEntriesByType).mockImplementation(() => { throw new Error("timing disabled"); });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.getElementById("direct-status")!.textContent).toContain("snapshot is unavailable");
    expect(document.getElementById("direct")!.textContent).toContain("rpc.example");
    expect(document.getElementById("traffic")!.textContent).toContain("12 fetch attempts");
    harness.traffic = undefined;
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("traffic")!.textContent).toContain("count unavailable");
  });

  it("shows typed network outages as text, preserves retry controls and clears stale diagnostics on recovery", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(0);
    harness.transportStatus = { state: "ready" };
    harness.networkStatus = { state: "unavailable", error: PAYLOAD };
    harness.onStatus?.(harness.getStatus!());
    expectPlainText("network-status");
    expect(document.getElementById("network-status")!.textContent).toContain("Anonymous request failed");
    expect(document.getElementById("read-policy-status")!.textContent).toContain("You can retry");
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("run-verified-call") as HTMLButtonElement).disabled).toBe(false);
    harness.networkStatus = { state: "ok" };
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("network-status")!.textContent).toBe("");
    expect(document.getElementById("read-policy-status")!.textContent).not.toContain("request failed");
    harness.networkStatus = undefined;
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("network-status")!.textContent).toBe("");
  });

  it("classifies discovered ENS RPC/beacon hosts and custom selected endpoints, even after a directory rotation", async () => {
    await refreshOperators([{ ...pluralOperators()[0], beaconUrl: "https://custom-beacon.example/" }]);
    harness.operatorStatus = [{ id: "custom", url: "https://selected.example/rpc", priority: 0, state: "eligible" }];
    vi.mocked(performance.getEntriesByType).mockReturnValue([
      { name: "https://east.example/rpc", entryType: "resource", startTime: 1, duration: 2 },
      { name: "https://custom-beacon.example/bootstrap", entryType: "resource", startTime: 2, duration: 2 },
      { name: "https://selected.example/rpc", entryType: "resource", startTime: 3, duration: 2 },
    ] as PerformanceEntry[]);
    await vi.advanceTimersByTimeAsync(3_000);
    const classified = () => [...document.querySelectorAll("#direct tr")].map(row => row.textContent);
    expect(classified()).toEqual([
      expect.stringContaining("east.exampleRPC/beacon resource"),
      expect.stringContaining("custom-beacon.exampleRPC/beacon resource"),
      expect.stringContaining("selected.exampleRPC/beacon resource"),
    ]);
    harness.operatorStatus = [];
    await refreshOperators([]);
    vi.mocked(performance.getEntriesByType).mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(classified().every(row => row?.includes("RPC/beacon resource"))).toBe(true);
  });

  it("shows a network-unavailable attempt without blaming or penalizing its selected endpoint", () => {
    harness.transportStatus = { state: "ready" };
    harness.operatorStatus = [{ id: "bootstrap", url: "https://rpc.example/", priority: 0, state: "eligible" }];
    harness.networkStatus = { state: "unavailable", error: "anonymous fetch failed" };
    const emit = harness.initialOptions!.onPoolEvent as (event: unknown) => void;
    emit({ type: "attempt", endpoint: "bootstrap", attempt: 1, at: 1_000 });
    emit({ type: "network-unavailable", endpoint: "bootstrap", attempt: 1, at: 2_000 });
    harness.onStatus?.(harness.getStatus!());
    expect(document.querySelector("#pool-events li")!.className).toBe("warn");
    expect(document.querySelector("#pool-events li")!.textContent).toContain("no operator verdict");
    expect(document.getElementById("pool")!.textContent).toContain("0 rejected · 0 unavailable");
    expect(document.getElementById("pool")!.textContent).not.toContain("Read unavailable");
    expect(document.getElementById("pool")!.textContent).not.toContain("Checking a selected read");
    expect(document.getElementById("network-status")!.textContent).toContain("Anonymous request failed");
  });

  it("selects every endpoint under one operator checkbox and restricts automatic routing by operator identity", async () => {
    const endpoints = pluralOperators();
    await refreshOperators(endpoints);
    expect(document.querySelectorAll("#operators input")).toHaveLength(1);
    const checkbox = document.querySelector<HTMLInputElement>("#operators input")!;
    expect(checkbox.value).toBe("alice.derpc.eth");
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    expect(document.getElementById("use-operators")!.textContent).toContain("1 operator / 2 endpoints");
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "manual" }, endpoints.map(endpoint => expect.objectContaining(endpoint)));
    expect(document.getElementById("choice-status")!.textContent).toContain("1 operator(s) / 2 endpoint(s)");
    expect(JSON.parse(localStorage.getItem("derpc:routing")!).allowedOperators).toEqual(["alice.derpc.eth"]);
    expect(localStorage.getItem("derpc:chosen-operators")).toBe("[]");
    harness.routingStatus = { selection: "manual", source: "verified-ens" };
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "reliable"; mode.dispatchEvent(new Event("change"));
    (document.getElementById("routing-scope-selected") as HTMLInputElement).checked = true;
    document.getElementById("routing-scope")!.dispatchEvent(new Event("change"));
    expect(harness.setRouting).toHaveBeenCalledTimes(1);
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "reliable", allowedOperators: ["alice.derpc.eth"] }, undefined);
  });

  it("retains the group choice after a sibling disappears and forgets proof observations on URL rotation", async () => {
    const endpoints = pluralOperators();
    await refreshOperators(endpoints);
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    (harness.initialOptions!.onPoolEvent as (event: unknown) => void)({ type: "success", endpoint: endpoints[0]!.id, at: Date.now() });
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("pool")!.textContent).toContain("Proof checked on this page");
    await refreshOperators([{ ...endpoints[0], url: "https://rotated.example/rpc" }]);
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(1);
    expect(document.getElementById("choice-status")!.textContent).toContain("1 operator(s) / 1 endpoint(s)");
    expect(document.getElementById("pool")!.textContent).toContain("Not observed this session");
    expect(document.getElementById("pool")!.textContent).not.toContain("Proof checked on this page");
    expect(harness.setRouting).toHaveBeenCalledTimes(1);
    await refreshOperators([]);
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(0);
    expect(document.getElementById("choice-status")!.textContent).toContain("no operators; reads are stopped");
    expect(JSON.parse(localStorage.getItem("derpc:routing")!).allowedOperators).toEqual([]);
  });

  it("removes every sibling when its shared operator listing expires", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 2;
    await refreshOperators(pluralOperators().map(endpoint => ({ ...endpoint, expiry })));
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.querySelectorAll("#operators input")).toHaveLength(0);
    expect(document.getElementById("directory-status")!.textContent).toContain("1 expired operator(s) removed");
    expect(harness.setOperators).toHaveBeenLastCalledWith([]);
  });

  it("tracks a local imported receipt without routing side effects, observes proven state, and reverts to pending at expiry", async () => {
    const file = new File([JSON.stringify(lifecycleEvidence())], "update.json", { type: "application/json" });
    await importLifecycle(file);
    expect(document.getElementById("lifecycle-status")!.textContent).toBe("Administrative receipt recorded");
    expect(harness.setRouting).not.toHaveBeenCalled();
    expect(harness.setOperators).not.toHaveBeenCalled();
    expect(harness.refreshDirectory).not.toHaveBeenCalled();
    expect(localStorage.getItem("derpc:routing")).toBeNull();
    harness.routingStatus = { selection: "manual", source: "verified-ens", directorySnapshot: {
      blockNumber: 42, blockHash: `0x${"ab".repeat(32)}`, verifiedAt: Date.now(), expiresAt: Date.now() + 2_000, state: "fresh", requiredForReads: false,
    } };
    await refreshOperators([]);
    expect(document.getElementById("lifecycle-status")!.textContent).toBe("Expected state observed in proven directory");
    expect(document.getElementById("lifecycle-details")!.textContent).toContain("does not identify why it is absent");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(document.getElementById("lifecycle-status")!.textContent).toBe("Awaiting proven directory refresh");
    document.getElementById("lifecycle-clear")!.click();
    expect(document.getElementById("lifecycle-status")!.textContent).toBe("No ENS update tracked.");
    expect(document.getElementById("lifecycle-metadata")!.textContent).toBe("");
  });

  it("bounds local evidence before reading and preserves the previous tracked receipt on import failure", async () => {
    await importLifecycle(new File([JSON.stringify(lifecycleEvidence())], "valid.json"));
    const text = vi.fn();
    await importLifecycle({ size: 131073, text });
    expect(text).not.toHaveBeenCalled();
    expect(document.getElementById("lifecycle-import-error")!.textContent).toContain("no larger than 128 KiB");
    expect(document.getElementById("lifecycle-status")!.textContent).toBe("Administrative receipt recorded");
    await importLifecycle(new File([PAYLOAD], "invalid.json"));
    expect(document.getElementById("lifecycle-panel")!.querySelector("img")).toBeNull();
    expect(document.getElementById("lifecycle-status")!.textContent).toBe("Administrative receipt recorded");
  });

  it("expires ENS read controls on the clock, leaves restriction/refresh available, and does not renew a failed refresh", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(false);
    const snapshot = { blockNumber: 42, blockHash: `0x${"ab".repeat(32)}` as `0x${string}`, verifiedAt: Date.now(), expiresAt: Date.now() + 1_000, state: "fresh" as const, requiredForReads: true };
    harness.routingStatus = { selection: "manual", source: "verified-ens", directorySnapshot: snapshot };
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("directory-snapshot-status")!.textContent).toContain("block 42 · fresh");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(document.getElementById("directory-snapshot-status")!.textContent).toContain("block 42 · stale");
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("run-verified-call") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("refresh-directory") as HTMLButtonElement).disabled).toBe(false);
    document.getElementById("verified-call-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(harness.verifiedCall).not.toHaveBeenCalled();
    (document.querySelector("#operators input") as HTMLInputElement).checked = false;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    expect((document.getElementById("use-operators") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("routing-pending")!.textContent).toContain("Pending");
    expect(harness.setRouting).toHaveBeenCalledTimes(1);
    harness.refreshDirectory.mockRejectedValue(new Error("anonymous route timed out"));
    (document.getElementById("ens-registry") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("directory-status")!.textContent).toContain("Directory refresh failed"));
    expect(harness.routingStatus.directorySnapshot).toBe(snapshot);
    expect(document.getElementById("directory-snapshot-status")!.textContent).toContain(new Date(snapshot.expiresAt).toISOString());
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps independent explicit reads usable beside a stale cached ENS snapshot", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(false);
    harness.routingStatus = { selection: "manual", source: "explicit", directorySnapshot: {
      blockNumber: 42, blockHash: `0x${"ab".repeat(32)}`, verifiedAt: Date.now() - 2_000, expiresAt: Date.now() - 1_000, state: "stale", requiredForReads: false,
    } };
    harness.onStatus?.(harness.getStatus!());
    expect(document.getElementById("directory-snapshot-status")!.textContent).toContain("current explicit routes do not depend on it");
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById("run-verified-call") as HTMLButtonElement).disabled).toBe(false);
  });

  it("resets prior account affinity only when explicitly injecting the simulated liar", async () => {
    harness.transportStatus = { state: "ready" };
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.setOperators.mock.calls.every(([operators]) => operators.length > 0)).toBe(true);
    harness.setOperators.mockClear();
    const button = document.getElementById("inject-liar") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    expect(harness.setOperators).toHaveBeenCalledTimes(2);
    expect(harness.setOperators).toHaveBeenNthCalledWith(1, []);
    expect(harness.setOperators).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ id: "simulated-liar:bootstrap" }), expect.objectContaining({ id: "bootstrap" }),
    ]);
    expect([...document.querySelectorAll<HTMLInputElement>("#operators input:checked")].map(input => input.value)).toEqual(["bootstrap.derpc.eth"]);
  });

  it("puts the injected proof before a personal node's negative priority", async () => {
    harness.transportStatus = { state: "ready" };
    (document.getElementById("personal-endpoint") as HTMLInputElement).value = `http://${"a".repeat(56)}.onion/rpc`;
    (document.getElementById("personal-token") as HTMLInputElement).value = "ab".repeat(32);
    document.getElementById("personal-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById("personal-status")!.textContent).toContain("Your node is selected");
    harness.onStatus?.(harness.getStatus!());
    harness.setOperators.mockClear();
    expect((document.getElementById("inject-liar") as HTMLButtonElement).disabled).toBe(false);
    (document.getElementById("inject-liar") as HTMLButtonElement).click();
    expect(harness.setOperators).toHaveBeenNthCalledWith(1, []);
    expect(harness.setOperators).toHaveBeenNthCalledWith(2, [
      expect.objectContaining({ id: "simulated-liar:my-personal-node", priority: -2 }),
      expect.objectContaining({ id: "my-personal-node", priority: -1 }),
    ]);
  });

  it("cannot reset the operator selection while a verified call is in progress", async () => {
    harness.transportStatus = { state: "ready" };
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(100);
    let complete!: (result: unknown) => void;
    harness.verifiedCall.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    (document.getElementById("call-address") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
    (document.getElementById("call-data") as HTMLInputElement).value = "0x";
    document.getElementById("verified-call-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(harness.verifiedCall).toHaveBeenCalledOnce();
    harness.setOperators.mockClear();
    const button = document.getElementById("inject-liar") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new Event("click"));
    expect(harness.setOperators).not.toHaveBeenCalled();
    complete({ value: "0x", block: { blockNumber: 42 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
  });

  it("cannot reset the operator selection while a proof read is in progress", async () => {
    harness.transportStatus = { state: "ready" };
    let complete!: (balance: bigint) => void;
    harness.getBalance.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.getBalance).toHaveBeenCalledOnce();
    harness.setOperators.mockClear();
    const button = document.getElementById("inject-liar") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.dispatchEvent(new Event("click"));
    expect(harness.setOperators).not.toHaveBeenCalled();
    complete(0n);
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(false);
  });

  it("reports a refused demo replacement and keeps the cleared selection stopped", async () => {
    harness.transportStatus = { state: "ready" };
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    await vi.advanceTimersByTimeAsync(100);
    harness.setOperators.mockClear();
    harness.setOperators.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("ENS listing expired"); });
    (document.getElementById("inject-liar") as HTMLButtonElement).click();
    expect(harness.setOperators).toHaveBeenCalledTimes(2);
    expect(harness.setOperators).toHaveBeenNthCalledWith(1, []);
    expect(document.getElementById("routing-error")!.textContent).toContain("reads remain stopped");
    expect(document.getElementById("routing-error")!.textContent).toContain("ENS listing expired");
    expect(document.getElementById("choice-status")!.textContent).toContain("no operators; reads are stopped");
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(0);
    expect((document.getElementById("read-again") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps automatic strategy edits pending until Apply and submits all eligible candidates atomically", () => {
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "balanced"; mode.dispatchEvent(new Event("change"));
    expect(harness.setRouting).not.toHaveBeenCalled();
    expect(harness.setOperators).not.toHaveBeenCalled();
    expect(document.getElementById("choice-status")!.textContent).toContain("Active: manual");
    expect(document.getElementById("routing-pending")!.textContent).toContain("Pending: balanced, 1");
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "balanced" }, [expect.objectContaining({ id: "bootstrap" })]);
    expect(document.getElementById("choice-status")!.textContent).toContain("Active: balanced");
    expect(JSON.parse(localStorage.getItem("derpc:routing")!)).toMatchObject({ selection: "balanced", scope: "all" });
  });

  it("mirrors the strategy cards and the routing mode in both directions without applying", () => {
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    const card = (value: string) => document.querySelector(`input[name="routing-strategy"][value="${value}"]`) as HTMLInputElement;
    expect(card("manual").checked).toBe(true);
    card("fastest").checked = true; card("fastest").dispatchEvent(new Event("change", { bubbles: true }));
    expect(mode.value).toBe("fastest");
    expect(document.getElementById("routing-scope")!.hidden).toBe(false);
    expect(document.getElementById("routing-pending")!.textContent).toContain("Pending: fastest");
    expect(harness.setRouting).not.toHaveBeenCalled();
    mode.value = "reliable"; mode.dispatchEvent(new Event("change"));
    expect(card("reliable").checked).toBe(true);
    expect(card("fastest").checked).toBe(false);
  });

  it("allows explicitly applying an empty restricted automatic list", () => {
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "fastest"; mode.dispatchEvent(new Event("change"));
    const restricted = document.getElementById("routing-scope-selected") as HTMLInputElement;
    restricted.checked = true; restricted.dispatchEvent(new Event("change", { bubbles: true }));
    expect((document.getElementById("use-operators") as HTMLButtonElement).disabled).toBe(false);
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "fastest", allowedOperators: [] }, [expect.objectContaining({ id: "bootstrap" })]);
    expect(document.getElementById("choice-status")!.textContent).toContain("no operators; reads are stopped");
    mode.value = "manual"; mode.dispatchEvent(new Event("change"));
    expect((document.getElementById("use-operators") as HTMLButtonElement).disabled).toBe(false);
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "manual" }, []);
  });

  it("does not persist or report failed routing changes as active", () => {
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "reliable"; mode.dispatchEvent(new Event("change"));
    harness.setRouting.mockImplementationOnce(() => { throw new Error("rejected configuration"); });
    document.getElementById("use-operators")!.click();
    expect(localStorage.getItem("derpc:routing")).toBeNull();
    expect(document.getElementById("choice-status")!.textContent).toContain("Active: manual");
    expect(document.getElementById("routing-error")!.textContent).toContain("Routing was not changed");
  });

  it("restores saved bootstrap opt-in at construction but pauses saved ENS routing", async () => {
    const saved = { version: 1, selection: "reliable", scope: "all", allowedOperators: [], source: "bootstrap" };
    localStorage.setItem("derpc:routing", JSON.stringify(saved));
    vi.resetModules(); vi.clearAllTimers();
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../src/main.ts");
    expect(harness.initialOptions).toMatchObject({ selection: "reliable", operators: [expect.objectContaining({ id: "bootstrap" })] });
    localStorage.setItem("derpc:routing", JSON.stringify({ ...saved, source: "ens" }));
    localStorage.setItem("derpc:chosen-operators", JSON.stringify(["bootstrap.derpc.eth"]));
    vi.resetModules(); vi.clearAllTimers();
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../src/main.ts");
    expect(harness.initialOptions?.selection).toBeUndefined();
    expect(harness.initialOptions?.operators).toEqual([]);
    expect(document.getElementById("routing-restore")!.textContent).toContain("saved ENS routing is paused");
  });

  it("refuses personal-node activation while automatic routing is active", () => {
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "balanced"; mode.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    harness.setOperators.mockClear();
    (document.getElementById("personal-endpoint") as HTMLInputElement).value = `http://${"a".repeat(56)}.onion/rpc`;
    (document.getElementById("personal-token") as HTMLInputElement).value = "ab".repeat(32);
    document.getElementById("personal-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(harness.setOperators).not.toHaveBeenCalled();
    expect(document.getElementById("personal-status")!.textContent).toContain("Apply Manual routing");
    expect(localStorage.getItem("derpc:routing")).not.toContain("ababab");
  });

  it("does not transfer a restricted bootstrap policy to a matching ENS identity", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "balanced"; mode.dispatchEvent(new Event("change"));
    const selected = document.getElementById("routing-scope-selected") as HTMLInputElement;
    selected.checked = true; selected.dispatchEvent(new Event("change"));
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "balanced", allowedOperators: ["bootstrap.derpc.eth"] }, expect.any(Array));
    (document.getElementById("ens-registry") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(harness.refreshDirectory).not.toHaveBeenCalled();
    expect(document.getElementById("directory-status")!.textContent).toContain("Public provider choices do not authorize matching ENS names");
    expect(JSON.parse(localStorage.getItem("derpc:routing")!).source).toBe("bootstrap");
  });

  it("uses the provider's proven directory without replacing it when automatic routing is applied", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    harness.refreshDirectory.mockImplementation(async () => {
      harness.routingStatus = { selection: "manual", source: "verified-ens" };
      return { operators: [{ id: "real.derpc.eth", ens: "real.derpc.eth", url: "https://real.example/", priority: 0 }], rejected: [], blockNumber: 42n, listVerification: "proven", recordVerification: "proven" };
    });
    (document.getElementById("ens-registry") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("directory-status")!.textContent).toContain("records: proven"));
    expect(localStorage.getItem("derpc:chosen-operators")).toBe("[]");
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "balanced"; mode.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "balanced" }, undefined);
    expect(document.getElementById("choice-status")!.textContent).toContain("real.derpc.eth");
    expect(JSON.parse(localStorage.getItem("derpc:routing")!).source).toBe("ens");
  });

  it("does not promote an unverified ENS roster into automatic explicit candidates", async () => {
    harness.refreshDirectory.mockResolvedValue({ operators: [{ id: "unverified.derpc.eth", ens: "unverified.derpc.eth", url: "https://unverified.example/", priority: 0 }], rejected: [], blockNumber: 42n, listVerification: "unverified", recordVerification: "unverified" });
    (document.getElementById("ens-registry") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("directory-status")!.textContent).toContain("records: unverified"));
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "balanced"; mode.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).not.toHaveBeenCalled();
    expect(document.getElementById("routing-error")!.textContent).toContain("Prove the ENS operator list and records");
    expect(document.getElementById("choice-status")!.textContent).toContain("Active: manual");
  });

  it("treats a directory operator link as a suggestion requiring an explicit choice", async () => {
    vi.resetModules();
    vi.clearAllTimers();
    history.replaceState(null, "", "/?operator=bootstrap.derpc.eth#operator-dashboard");
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../src/main.ts");
    expect((document.querySelector("#operators input") as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById("operator-suggestion")!.textContent).toContain("active operators have not changed");
    expect(document.getElementById("operator-suggestion")!.textContent).toContain("Suggested public provider: Public Provider");
    expect(document.getElementById("operator-suggestion")!.textContent).not.toContain("bootstrap.derpc.eth");
    expect(document.getElementById("pool-summary")!.textContent).toContain("0 operators selected");
    expect(harness.setOperators).not.toHaveBeenCalled();
    expect(localStorage.getItem("derpc:chosen-operators")).toBeNull();
  });

  it("ignores unknown directory suggestions instead of accepting arbitrary endpoint URLs", async () => {
    vi.resetModules();
    vi.clearAllTimers();
    history.replaceState(null, "", "/?operator=https%3A%2F%2Funtrusted.example%2Frpc");
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    await import("../src/main.ts");
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(0);
    expect(document.getElementById("operator-suggestion")!.textContent).toBe("");
    expect(harness.setOperators).not.toHaveBeenCalled();
  });

  it("starts without paid sessions or wallet access", () => {
    expect((document.getElementById("enable-payments") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("payment-controls") as HTMLFieldSetElement).disabled).toBe(true);
    expect(document.getElementById("payment-status")!.textContent).toContain("Free reads do not need a wallet");
    expect(harness.setOperators).not.toHaveBeenCalled();
  });

  it("removes revoked choices on full refresh without selecting a new name", async () => {
    (document.querySelector("#operators input") as HTMLInputElement).checked = true;
    document.getElementById("operators")!.dispatchEvent(new Event("change"));
    document.getElementById("use-operators")!.click();
    harness.refreshDirectory.mockResolvedValue({ operators: [{ id: "new.derpc.eth", ens: PAYLOAD, url: "https://new.example/", priority: 0 }], rejected: [{ name: PAYLOAD, reason: "revoked" }], blockNumber: 42n, listVerification: "unverified", recordVerification: "unverified" });
    (document.getElementById("ens-registry") as HTMLInputElement).value = `0x${"11".repeat(20)}`;
    document.getElementById("directory-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById("directory-status")!.textContent).toContain("1 previous choice(s) removed"));
    // The provider refresh owns removal. The UI must not replace its verified directory afterward.
    expect(harness.setOperators).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("#operators input:checked")).toHaveLength(0);
    expectPlainText("operators");
    expectPlainText("directory-rejected");
    expect(localStorage.getItem("derpc:chosen-operators")).toBe("[]");
  });

  it("keeps personal credentials out of persisted choices and clears the form", () => {
    const token = "ab".repeat(32);
    (document.getElementById("personal-endpoint") as HTMLInputElement).value = `http://${"a".repeat(56)}.onion/rpc`;
    (document.getElementById("personal-token") as HTMLInputElement).value = token;
    document.getElementById("personal-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(harness.setOperators).toHaveBeenLastCalledWith([expect.objectContaining({ personalToken: token })]);
    expect((document.getElementById("personal-token") as HTMLInputElement).value).toBe("");
    document.getElementById("use-operators")!.click();
    expect(localStorage.getItem("derpc:chosen-operators")).toBe("[]");
    expect(document.getElementById("operators")!.textContent).not.toContain(token);
    document.getElementById("remove-personal")!.click();
    expect(harness.setOperators).toHaveBeenLastCalledWith([]);
  });

  it("shows HTML in worker, light-client, pin and operator text as plain text", () => {
    harness.onStatus?.({
      worker: { name: "tor" },
      checkpoint: { epoch: 1 },
      transport: { state: "failed", error: PAYLOAD },
      lightClient: { state: "failed", error: PAYLOAD },
      pin: { state: "mismatch", error: PAYLOAD },
      operators: [{ id: "https://rpc.example/", priority: 0, state: "eligible", operator: PAYLOAD }],
    });

    for (const id of ["worker-status", "lc-status", "pin-status", "pool"]) expectPlainText(id);
    expect(document.getElementById("worker-status")!.querySelector(".bad")?.textContent).toBe("failed");
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
