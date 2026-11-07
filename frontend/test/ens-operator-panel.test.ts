// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountOperatorWallet, operatorWalletHtml } from "../../web/src/ens/panel.ts";
import { JOURNAL_KEY, type Data, type SessionAdapter } from "../../web/src/ens/session.ts";
import type { OperatorRuntime } from "../../web/src/ens/runtime.ts";

const ADDRESS = `0x${"11".repeat(20)}`, TO = `0x${"22".repeat(20)}`, BLOCK = `0x${"33".repeat(32)}`, HASH = `0x${"44".repeat(32)}`;
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();
const ready = (id: string) => vi.waitFor(() => {
  if ((document.getElementById(id) as HTMLButtonElement).disabled) throw new Error(`${id} remains disabled: ${document.getElementById("ens-web-message")?.textContent}`);
});
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function fixture(configured = true) {
  let mined = 0, held = false;
  const listeners = new Map<string, () => void>();
  const wallet = { request: vi.fn(async (request: Data) => {
    if (request.method === "eth_requestAccounts" || request.method === "eth_accounts") return [ADDRESS];
    if (request.method === "eth_chainId") return "0x1";
    if (request.method === "eth_sendTransaction") { mined++; return hash(mined); }
    throw new Error("Unexpected wallet request");
  }), on: (name: string, fn: () => void) => listeners.set(name, fn), removeListener: (name: string) => listeners.delete(name) };
  Object.defineProperty(window, "ethereum", { configurable: true, value: wallet }); cleanup.push(() => { delete (window as any).ethereum; });
  const locks = { request: async (_name: string, _options: Data, fn: (lock: Data | null) => Promise<unknown>) => { if (held) return fn(null); held = true; try { return await fn({ name: "test" }); } finally { held = false; } } };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks }); cleanup.push(() => { delete (navigator as any).locks; });
  const config = { schemaVersion: 1, chainId: 1, parentName: "derpc.eth", operators: [{ label: "alice", operator: ADDRESS }] };
  const tx = (id: number) => ({ from: ADDRESS, to: TO, data: `0x600${id}`, value: "0x0", chainId: "0x1" });
  const build = { sourceHash: HASH, compiler: { version: "test" } };
  const adapter: SessionAdapter = {
    id: "operator-join", build, validateInput: value => value,
    checkIdentity: (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Identity changed"); },
    reconstruct: item => tx(Number(item.id.slice(-1))),
    prepare: vi.fn(async (input, client) => { const block = await client.getBlock({ blockTag: "latest" }); return {
      schemaVersion: 1, kind: "derpc-ens-unsigned-plan", chainId: 1, flow: "operator-join", stage: mined < 3 ? `stage-${mined}` : "complete",
      status: mined < 3 ? "needs-wallet" : "state-matches-config", sourceHash: build.sourceHash, compiler: build.compiler,
      resumeConfig: input, roleTable: [], preflight: { blockNumber: block.number.toString(), blockHash: BLOCK, localOnly: false },
      transactions: mined < 3 ? [{ id: `join-${mined}`, purpose: `Operator step ${mined + 1}`, estimatedGas: "50000", walletRequest: { method: "eth_sendTransaction", params: [tx(mined)] } }] : [],
    }; }),
    verify: vi.fn(async () => ({ kind: "verified-test-enrollment", verification: { receipts: true }, pins: { registrar: TO } })),
    pins: manifest => manifest.pins, checkTransaction: vi.fn(async (_client, _item, transactionHash) => ({ hash: transactionHash, blockNumber: String(100 + mined), blockHash: BLOCK })),
  };
  const client = { getBlock: vi.fn(async (args: Data) => ({ number: args.blockNumber ?? BigInt(100 + mined), hash: BLOCK })) };
  const runtime: OperatorRuntime = { configured, origins: ["https://source-one.example", "https://source-two.example"], clients: [client, { ...client }],
    join: vi.fn(() => ({ config, adapter })), restore: vi.fn(() => ({ config, adapter })), operators: vi.fn(() => []), manage: vi.fn(() => { throw new Error("Not a management fixture"); }) };
  const root = document.createElement("div"); root.innerHTML = operatorWalletHtml(); document.body.append(root);
  const mounted = mountOperatorWallet(root, { operator: () => config.operators[0], loadRuntime: async () => runtime }); cleanup.push(mounted.close);
  return { root, mounted, runtime, adapter, wallet, listeners, config };
}

describe("operator website wallet flow", () => {
  it("keeps registration and management disabled without configured public deployment and performs no wallet or RPC calls", async () => {
    const f = fixture(false);
    await vi.waitFor(() => expect(document.getElementById("ens-availability")!.textContent).toContain("no verified public registrar"));
    expect((document.getElementById("ens-prepare-join") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("ens-enrollment-file") as HTMLInputElement).disabled).toBe(true);
    click("ens-prepare-join"); expect(f.runtime.join).not.toHaveBeenCalled(); expect(f.adapter.prepare).not.toHaveBeenCalled(); expect(f.wallet.request).not.toHaveBeenCalled();
    expect(document.getElementById("ens-admin-sources")!.textContent).toContain("directly");
  });

  it("requires explicit wallet connection, review and separate sends for all three stages, then archives verified evidence", async () => {
    const f = fixture(); await ready("ens-prepare-join"); click("ens-prepare-join");
    await vi.waitFor(() => expect(document.getElementById("ens-stage-title")!.textContent).toContain("stage-0"));
    expect(f.wallet.request).not.toHaveBeenCalled();
    for (let stage = 0; stage < 3; stage++) {
      (document.querySelector("#ens-transaction-list button") as HTMLButtonElement).click();
      click("ens-web-connect"); await ready("ens-web-reviewed");
      expect((document.getElementById("ens-web-send") as HTMLButtonElement).disabled).toBe(true);
      click("ens-web-reviewed"); click("ens-web-send");
      await vi.waitFor(() => expect(f.wallet.request.mock.calls.filter(([request]) => request.method === "eth_sendTransaction")).toHaveLength(stage + 1));
      await ready("ens-web-refresh");
      expect(JSON.parse(localStorage.getItem(JOURNAL_KEY)!).stages[stage].entries[0].hash).toBe(hash(stage + 1));
      click("ens-web-refresh");
      await vi.waitFor(() => expect(document.getElementById("ens-stage-title")!.textContent).toContain(stage < 2 ? `stage-${stage + 1}` : "Ready for final verification"));
      expect((document.getElementById("ens-web-reviewed") as HTMLInputElement).checked).toBe(false);
    }
    click("ens-web-verify"); await ready("ens-archive");
    expect(f.adapter.verify).toHaveBeenCalledTimes(2);
    expect(f.wallet.request.mock.calls.filter(([request]) => request.method === "eth_sendTransaction")).toHaveLength(3);
    click("ens-archive"); await vi.waitFor(() => expect(localStorage.getItem(JOURNAL_KEY)).toBeNull());
  });

  it("closes wallet listeners and prevents a review from sending after page disposal", async () => {
    const f = fixture(); await ready("ens-prepare-join"); click("ens-prepare-join");
    await vi.waitFor(() => expect(document.querySelector("#ens-transaction-list button")).not.toBeNull());
    (document.querySelector("#ens-transaction-list button") as HTMLButtonElement).click(); click("ens-web-connect"); await ready("ens-web-reviewed"); click("ens-web-reviewed");
    f.mounted.close(); click("ens-web-send");
    expect(f.listeners.size).toBe(0);
    expect(f.wallet.request.mock.calls.some(([request]) => request.method === "eth_sendTransaction")).toBe(false);
  });

  it("allows a failed name check to be corrected without leaving a permanent journal", async () => {
    const f = fixture(); (f.adapter.prepare as any).mockRejectedValueOnce(new Error("Name already registered"));
    await ready("ens-prepare-join"); click("ens-prepare-join");
    await vi.waitFor(() => expect(document.getElementById("ens-web-message")!.textContent).toContain("Name already registered"));
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
    click("ens-prepare-join"); await vi.waitFor(() => expect(document.querySelector("#ens-transaction-list button")).not.toBeNull());
  });

  it("discards an unsent review and invalidates the old controls", async () => {
    const f = fixture(); await ready("ens-prepare-join"); click("ens-prepare-join");
    await vi.waitFor(() => expect(document.querySelector("#ens-transaction-list button")).not.toBeNull());
    click("ens-discard"); await vi.waitFor(() => { expect(localStorage.getItem(JOURNAL_KEY)).toBeNull(); expect(document.getElementById("ens-wallet-review")!.hidden).toBe(true); });
    expect(f.wallet.request).not.toHaveBeenCalled();
  });

  it("lets repeated management use the current expected state while preserving imported identity evidence", async () => {
    const f = fixture(), oldExpiry = 1794614400;
    (f.runtime.operators as any).mockReturnValue([{ name: "alice.derpc.eth", operator: ADDRESS, hotKey: TO, expiry: oldExpiry, records: { "derpc.endpoint": "https://old.example/rpc" } }]);
    (f.runtime.manage as any).mockImplementation(() => ({ config: f.config, adapter: f.adapter }));
    await ready("ens-prepare-management");
    const expected = document.getElementById("ens-expected-expiry") as HTMLInputElement, next = document.getElementById("ens-renew-expiry") as HTMLInputElement;
    expected.value = "2026-11-16T12:00:03"; next.value = "2026-11-20T12:00:04";
    click("ens-prepare-management");
    expect(f.runtime.manage).toHaveBeenCalledWith({ type: "renew", label: "alice", authority: "operator", expectedExpiry: Date.parse("2026-11-16T12:00:03Z") / 1000, expiry: Date.parse("2026-11-20T12:00:04Z") / 1000 }, undefined);
    await vi.waitFor(() => expect(document.querySelector("#ens-transaction-list button")).not.toBeNull());
    click("ens-discard"); await vi.waitFor(() => expect(localStorage.getItem(JOURNAL_KEY)).toBeNull());
    const mode = document.getElementById("ens-management-kind") as HTMLSelectElement; mode.value = "endpoint"; mode.dispatchEvent(new Event("change"));
    (document.getElementById("ens-expected-endpoint") as HTMLTextAreaElement).value = "https://current.example/rpc";
    (document.getElementById("ens-new-endpoint") as HTMLTextAreaElement).value = "https://next.example/rpc";
    click("ens-prepare-management");
    expect(f.runtime.manage).toHaveBeenLastCalledWith({ type: "rotate-endpoint", label: "alice", expectedEndpoint: "https://current.example/rpc", newEndpoint: "https://next.example/rpc" }, undefined);
    expect(f.wallet.request).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector("#ens-transaction-list button")).not.toBeNull());
  });
});
