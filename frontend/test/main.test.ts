// The demo page shows text from the worker, the beacon nodes and the operators. All of it is untrusted,
// so it must reach the page as text, never as markup (#20).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import page from "../index.html?raw";

const harness = vi.hoisted(() => ({
  onStatus: undefined as ((status: unknown) => void) | undefined,
  setOperators: vi.fn(),
  setRouting: vi.fn(),
  initialOptions: undefined as Record<string, unknown> | undefined,
  routingStatus: undefined as { selection: string; source: string } | undefined,
  refreshDirectory: vi.fn(),
}));

vi.mock("@derpc/provider", () => ({
  ENS_NAMES_ARE_MOCK: true,
  MAINNET_BEACON_ENDPOINTS: ["https://beacon.example"],
  MAINNET_OPERATORS: [{ id: "bootstrap", ens: "bootstrap.derpc.eth", url: "https://rpc.example/", priority: 0 }],
  operatorUrl: (input: string) => new URL(input),
  MAINNET_TOKENS: { WETH: { address: `0x${"00".repeat(20)}`, decimals: 18 } },
  TOR_JS_PIN: { name: "tor", workerHash: `0x${"00".repeat(32)}`, resolvers: [] },
  simulatedLyingOperator: (op: unknown) => op,
  createDeRPC: (opts: { onStatus: (status: unknown) => void }) => {
    harness.onStatus = opts.onStatus;
    harness.initialOptions = opts as unknown as Record<string, unknown>;
    return {
      ready: Promise.resolve(),
      reader: {},
      setOperators: harness.setOperators,
      setRouting: harness.setRouting,
      refreshDirectory: harness.refreshDirectory,
      close: () => {},
      status: () => ({ worker: { name: "tor" }, checkpoint: { epoch: 1 }, transport: { state: "booting" }, lightClient: { state: "waiting" }, pin: { state: "waiting-for-operators" }, operators: [], routing: harness.routingStatus }),
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
  document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");

  await import("../src/main.ts");
});

afterEach(() => {
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

describe("demo page status rendering", () => {
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

  it("allows explicitly applying an empty restricted automatic list", () => {
    const mode = document.getElementById("routing-mode") as HTMLSelectElement;
    mode.value = "fastest"; mode.dispatchEvent(new Event("change"));
    const restricted = document.getElementById("routing-scope-selected") as HTMLInputElement;
    restricted.checked = true; restricted.dispatchEvent(new Event("change", { bubbles: true }));
    expect((document.getElementById("use-operators") as HTMLButtonElement).disabled).toBe(false);
    document.getElementById("use-operators")!.click();
    expect(harness.setRouting).toHaveBeenLastCalledWith({ selection: "fastest", allowedOperators: [] }, [expect.objectContaining({ id: "bootstrap" })]);
    expect(document.getElementById("choice-status")!.textContent).toContain("no operators; reads are stopped");
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
    expect(document.getElementById("pool-summary")!.textContent).toContain("0 selected");
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
