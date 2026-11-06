// The demo page shows text from the worker, the beacon nodes and the operators. All of it is untrusted,
// so it must reach the page as text, never as markup (#20).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  onStatus: undefined as ((status: unknown) => void) | undefined,
}));

vi.mock("@derpc/provider", () => ({
  ENS_NAMES_ARE_MOCK: true,
  MAINNET_BEACON_ENDPOINTS: ["https://beacon.example"],
  MAINNET_OPERATORS: [],
  MAINNET_TOKENS: { WETH: { address: `0x${"00".repeat(20)}`, decimals: 18 } },
  TOR_JS_PIN: { name: "tor", workerHash: `0x${"00".repeat(32)}`, resolvers: [] },
  simulatedLyingOperator: (op: unknown) => op,
  createDeRPC: (opts: { onStatus: (status: unknown) => void }) => {
    harness.onStatus = opts.onStatus;
    return {
      ready: Promise.resolve(),
      reader: {},
      setOperators: () => {},
      close: () => {},
      status: () => ({ transport: { state: "booting" }, lightClient: { state: "waiting" }, pin: { state: "waiting-for-operators" }, operators: [] }),
    };
  },
}));
vi.mock("@derpc/provider/viem", () => ({ derpcTransport: () => ({}) }));
vi.mock("viem", () => ({ createPublicClient: () => ({}), erc20Abi: [], formatUnits: () => "0" }));
vi.mock("viem/chains", () => ({ mainnet: {} }));

const IDS = ["worker-status", "network-status", "lc-status", "lc-header", "pin-status", "worker-log", "operators", "choice-status", "reads", "pool", "pool-events", "direct"];
const BUTTONS = ["use-operators", "read-again", "inject-liar", "cut-network"];
const PAYLOAD = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  document.body.replaceChildren();
  for (const id of IDS) document.body.append(Object.assign(document.createElement(id === "pool" ? "tbody" : "div"), { id }));
  for (const id of BUTTONS) document.body.append(Object.assign(document.createElement("button"), { id }));

  await import("../src/main.ts");
});

afterEach(() => {
  harness.onStatus = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function expectPlainText(id: string) {
  const el = document.getElementById(id)!;
  expect(el.textContent).toContain(PAYLOAD);
  expect(el.querySelector("img")).toBeNull();
  expect(el.querySelector("script")).toBeNull();
}

describe("demo page status rendering", () => {
  it("shows HTML in worker, network, light-client, pin and operator text as plain text", () => {
    harness.onStatus?.({
      worker: { name: "tor" },
      checkpoint: { epoch: 1 },
      transport: { state: "failed", error: PAYLOAD },
      network: { state: "unavailable", error: PAYLOAD },
      lightClient: { state: "failed", error: PAYLOAD },
      pin: { state: "mismatch", error: PAYLOAD },
      operators: [{ id: "https://rpc.example/", priority: 0, state: "eligible", operator: PAYLOAD }],
    });

    for (const id of ["worker-status", "network-status", "lc-status", "pin-status", "pool"]) expectPlainText(id);
    expect(document.getElementById("worker-status")!.querySelector(".bad")?.textContent).toBe("failed");
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
