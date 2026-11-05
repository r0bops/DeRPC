// When the harness rejects the worker (for example, no resolver served bytes matching the pinned
// workerHash), the transport must fail closed: every later request is refused, and nothing is sent.
// The real harness needs a browser (null-origin iframe + Web Worker), so it is replaced by a stand-in
// whose `ready` rejects exactly as the harness's does.
import { describe, expect, it, vi } from "vitest";

const workerFetch = vi.fn();
vi.mock("@anon-rpc/browser-harness", () => ({
  AnonRpcWorker: class {
    ready = Promise.reject(new Error("no resolver yielded bytes matching workerHash"));
    fetch = workerFetch;
    acceptLog = () => new Promise(() => {});
    close() {}
  },
}));

const { startAnonTransport, TransportUnavailableError } = await import("../../src/transport/anon-transport.ts");
const { TOR_JS_PIN } = await import("../../src/config/mainnet.ts");

describe("startAnonTransport when the worker bundle fails its hash check", () => {
  it("reports the failure and refuses every request without touching the worker", async () => {
    const states: string[] = [];
    const transport = startAnonTransport({ pin: TOR_JS_PIN, onState: (s) => states.push(s) });

    await expect(transport.ready).rejects.toThrow("no resolver yielded bytes matching workerHash");
    expect(transport.state()).toBe("failed");
    expect(states).toContain("failed");

    await expect(transport.fetch("https://eth.drpc.org", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TransportUnavailableError);
    expect(workerFetch).not.toHaveBeenCalled();
  });
});
