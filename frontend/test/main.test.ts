// The demo page shows text from the worker, the beacon nodes and the operators. All of it is untrusted,
// so it must reach the page as text, never as markup (#20).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeRPCStatus } from "@derpc/provider";
import page from "../index.html?raw";

const harness = vi.hoisted(() => ({
  onStatus: undefined as ((status: unknown) => void) | undefined,
  setOperators: vi.fn(),
  setRouting: vi.fn(),
  initialOptions: undefined as Record<string, unknown> | undefined,
  routingStatus: undefined as DeRPCStatus["routing"],
  getStatus: undefined as (() => unknown) | undefined,
  verifiedCall: vi.fn(),
  refreshDirectory: vi.fn(),
}));

vi.mock("@derpc/provider", () => ({
  ENS_NAMES_ARE_MOCK: true,
  MAINNET_BEACON_ENDPOINTS: ["https://beacon.example"],
  MAINNET_OPERATORS: [{ id: "bootstrap", ens: "bootstrap.derpc.eth", url: "https://rpc.example/", priority: 0 }],
  operatorUrl: (input: string) => new URL(input),
  operatorKey: (input: { operatorId?: string; ens?: string; id?: string; url: string }) => input.operatorId ?? input.ens ?? input.id ?? input.url,
  MAINNET_TOKENS: { WETH: { address: `0x${"00".repeat(20)}`, decimals: 18 } },
  TOR_JS_PIN: { name: "tor", workerHash: `0x${"00".repeat(32)}`, resolvers: [] },
  simulatedLyingOperator: (op: unknown) => op,
  createDeRPC: (opts: { onStatus: (status: unknown) => void }) => {
    harness.onStatus = opts.onStatus;
    harness.initialOptions = opts as unknown as Record<string, unknown>;
    const status = () => ({ worker: { name: "tor" }, checkpoint: { epoch: 1 }, transport: { state: "booting" }, lightClient: { state: "waiting" }, pin: { state: "waiting-for-operators" }, operators: [], routing: harness.routingStatus });
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
vi.mock("viem", async importOriginal => ({ ...await importOriginal<typeof import("viem")>(), createPublicClient: () => ({}) }));
vi.mock("viem/chains", () => ({ mainnet: {} }));

const PAYLOAD = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
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
  harness.refreshDirectory.mockReset();
  harness.verifiedCall.mockReset();
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
