import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  onState: undefined as ((state: string, detail?: string) => void) | undefined,
  pin: undefined as { config?: { logLevel?: string } } | undefined,
  fetch: vi.fn<(url: string, options?: { isolationKey?: string }) => Promise<Response>>(),
}));

vi.mock("@derpc/provider", () => {
  const transport = {
    fetch: harness.fetch,
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
  harness.fetch.mockReset().mockResolvedValue(new Response("{}"));
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

describe("Tor isolation diagnostics", () => {
  async function run(probes: (unknown | Error)[]) {
    let probe = 0;
    harness.fetch.mockImplementation(async url => {
      if (url === "https://check.torproject.org/api/ip") {
        const reply = probes[probe++];
        if (reply instanceof Error) throw reply;
        return new Response(JSON.stringify(reply));
      }
      return new Response(JSON.stringify({ result: { accountProof: [], storageProof: [] } }));
    });
    harness.onState?.("ready");
    const button = document.getElementById("run") as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(probe).toBe(4);
    const rows = [...document.querySelectorAll<HTMLTableRowElement>("#results tr")];
    const observation = rows.find(row => row.cells[0]!.textContent === "Isolation observation (not proof)")!.cells[1]!;
    return { observation, probes: rows.slice(0, 4).map(row => row.cells[1]!) };
  }
  const tor = (IP: string) => ({ IsTor: true, IP });
  const a = tor("192.0.2.1"), b = tor("2001:db8::2");

  it("reports an inconclusive observation when every exit request fails", async () => {
    const { observation, probes } = await run(Array.from({ length: 4 }, () => new Error("Tor check unavailable")));
    expect(probes.every(result => result.className === "bad")).toBe(true);
    expect(observation.className).toBe("warn");
    expect(observation.textContent).toContain("Inconclusive");
    expect(observation.textContent).toContain("key-a 0/2, key-b 0/2");
    expect(observation.textContent).not.toContain("no overlap");
  });

  it.each([
    ["request failure", new Error("Timeout")],
    ["non-Tor reply", { IsTor: false, IP: "198.51.100.1" }],
    ["missing IP", { IsTor: true }],
    ["empty IP", tor("")],
    ["invalid IPv4", tor("999.0.2.1")],
    ["invalid IPv6", tor("2001:::1")],
    ["arbitrary text", tor("undefined")],
  ])("does not infer isolation from incomplete observations: %s", async (_label, invalid) => {
    const { observation, probes } = await run([a, b, a, invalid]);
    expect(probes[3]!.className).toBe("bad");
    expect(observation.className).toBe("warn");
    expect(observation.textContent).toContain("key-a 2/2, key-b 1/2");
  });

  it("reports no observed overlap only after all four valid Tor replies", async () => {
    const { observation, probes } = await run([a, b, a, b]);
    expect(probes.every(result => result.className === "ok")).toBe(true);
    expect(observation.className).toBe("ok");
    expect(observation.textContent).toBe("key-a exits {192.0.2.1} vs key-b exits {2001:db8::2}: no overlap");
  });

  it("recognizes equivalent IPv6 spellings as a shared exit", async () => {
    const { observation } = await run([b, tor("2001:db8:0:0:0:0:0:2"), b, b]);
    expect(observation.className).toBe("bad");
    expect(observation.textContent).toBe("shared exit 2001:db8::2 (may happen by chance)");
  });
});
