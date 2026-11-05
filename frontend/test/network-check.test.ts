import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  onState: undefined as ((state: string, detail?: string) => void) | undefined,
  pin: undefined as { config?: { logLevel?: string } } | undefined,
}));

vi.mock("@derpc/provider", () => {
  const transport = {
    fetch: vi.fn(async () => new Response("{}")),
    ready: Promise.resolve(),
    state: () => "ready",
  };
  return {
    MAINNET_BEACON_ENDPOINTS: ["https://beacon.example"],
    MAINNET_CHECKPOINT: { root: `0x${"00".repeat(32)}`, epoch: 1 },
    MAINNET_EXECUTION_ENDPOINTS: ["https://rpc.example"],
    TOR_JS_PIN: { name: "tor", resolvers: [] },
    asFetch: () => vi.fn(),
    startAnonTransport: (opts: {
      pin: { config?: { logLevel?: string } };
      onState: (state: string, detail?: string) => void;
    }) => {
      harness.pin = opts.pin;
      harness.onState = opts.onState;
      return transport;
    },
    startVerifiedHeaderSource: async () => ({
      finalized: () => ({
        slot: 1,
        blockNumber: 1,
        blockHash: `0x${"00".repeat(32)}`,
        stateRoot: `0x${"00".repeat(32)}`,
        timestamp: Math.floor(Date.now() / 1000),
      }),
      close: () => {},
    }),
    withGateways: (pin: unknown) => pin,
  };
});

function add(id: string, tag = "div") {
  const el = document.createElement(tag);
  el.id = id;
  document.body.append(el);
  return el;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  document.body.replaceChildren();
  for (const id of ["worker-status", "worker-log", "results", "direct", "lc-status", "lc-header"]) add(id);
  add("run", "button");

  await import("../src/network-check.ts");
});

afterEach(() => {
  harness.onState = undefined;
  harness.pin = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("frontend status rendering", () => {
  it("keeps info logging on the network check page", () => {
    expect(harness.pin?.config?.logLevel).toBe("info");
  });

  it("shows HTML in a worker error as plain text", () => {
    const payload = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script>';

    harness.onState?.("failed", payload);

    const status = document.getElementById("worker-status")!;
    expect(status.textContent).toBe(`failed — ${payload} (no direct fallback)`);
    expect(status.innerHTML).toContain("&lt;img");
    expect(status.querySelector("img")).toBeNull();
    expect(status.querySelector("script")).toBeNull();
    expect(status.children).toHaveLength(1);
    expect(status.children[0]!.className).toBe("bad");
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
