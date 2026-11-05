// A worker that dies after startup must take the transport down with it: state goes to "failed",
// reads fail with TransportUnavailableError, and ordinary per-request errors stay retryable.
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  class FakeWorker {
    static last: FakeWorker;
    ready: Promise<void>;
    resolveReady!: () => void;
    rejectReady!: (e: unknown) => void;
    failure: unknown;
    nextError: unknown;
    logWaiters: ((e: unknown) => void)[] = [];

    constructor() {
      this.ready = new Promise((res, rej) => {
        this.resolveReady = res;
        this.rejectReady = rej;
      });
      this.ready.catch(() => {});
      FakeWorker.last = this;
    }

    // Mirrors the harness: one failure rejects ready, every later fetch, and the log queue.
    fail(error: unknown) {
      if (this.failure !== undefined) return;
      this.failure = error;
      this.rejectReady(error);
      for (const reject of this.logWaiters.splice(0)) reject(error);
    }

    async fetch(): Promise<Response> {
      if (this.failure !== undefined) throw this.failure;
      if (this.nextError !== undefined) {
        const error = this.nextError;
        this.nextError = undefined;
        throw error;
      }
      return new Response("{}", { status: 200 });
    }

    acceptLog(): Promise<never> {
      if (this.failure !== undefined) return Promise.reject(this.failure);
      return new Promise((_, reject) => this.logWaiters.push(reject));
    }

    close() {
      this.fail(new Error("worker closed"));
    }
  }
  return { FakeWorker };
});

vi.mock("@anon-rpc/browser-harness", () => ({ AnonRpcWorker: harness.FakeWorker }));

import { startAnonTransport, TransportUnavailableError } from "../../src/transport/anon-transport.ts";
import type { TransportState } from "../../src/transport/anon-transport.ts";
import type { WorkerPin } from "../../src/config/mainnet.ts";

const pin = { name: "test", specifier: "test.eth", resolvers: [], config: {} } as unknown as WorkerPin;

function workerFailed(message: string) {
  const error = new Error(message);
  error.name = "WorkerFailedError";
  return error;
}

function start(withLogs = false) {
  const states: TransportState[] = [];
  const transport = startAnonTransport({
    pin,
    onState: (state) => states.push(state),
    ...(withLogs ? { onLog: () => {} } : {}),
  });
  return { transport, states, worker: harness.FakeWorker.last };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startAnonTransport", () => {
  it("fails before readiness", async () => {
    const { transport, worker } = start();
    worker.fail(new Error("worker error: boot"));

    await expect(transport.ready).rejects.toThrow("worker error: boot");
    expect(transport.state()).toBe("failed");
    await expect(transport.fetch("https://rpc.test/")).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it("refuses every request without touching the worker when the bundle fails its hash check", async () => {
    const { transport, states, worker } = start();
    const workerFetch = vi.spyOn(worker, "fetch");
    worker.fail(new Error("no resolver yielded bytes matching workerHash"));

    await expect(transport.ready).rejects.toThrow("no resolver yielded bytes matching workerHash");
    expect(transport.state()).toBe("failed");
    expect(states).toContain("failed");
    await expect(transport.fetch("https://eth.drpc.org", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TransportUnavailableError);
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it("fails reads and reports the state when the worker dies after readiness", async () => {
    const { transport, states, worker } = start();
    worker.resolveReady();
    await transport.ready;
    expect(transport.state()).toBe("ready");

    worker.fail(workerFailed("tor client crashed"));

    const first = transport.fetch("https://rpc.test/");
    await expect(first).rejects.toBeInstanceOf(TransportUnavailableError);
    await expect(first).rejects.toMatchObject({ state: "failed" });
    expect(transport.state()).toBe("failed");
    expect(states).toEqual(["booting", "ready", "failed"]);
    await expect(transport.fetch("https://rpc.test/")).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it("learns about a failure after readiness from the log queue, before any read", async () => {
    const { transport, worker } = start(true);
    worker.resolveReady();
    await transport.ready;

    worker.fail(new Error("worker error: out of memory"));
    await vi.waitFor(() => expect(transport.state()).toBe("failed"));
  });

  it("keeps ordinary request errors retryable", async () => {
    const { transport, worker } = start();
    worker.resolveReady();
    await transport.ready;

    worker.nextError = new Error("exit circuit closed");
    await expect(transport.fetch("https://rpc.test/")).rejects.toThrow("exit circuit closed");
    expect(transport.state()).toBe("ready");
    await expect(transport.fetch("https://rpc.test/")).resolves.toBeInstanceOf(Response);
  });

  it("refuses to send after close()", async () => {
    const { transport, worker } = start(true);
    worker.resolveReady();
    await transport.ready;

    transport.close();
    await Promise.resolve();
    expect(transport.state()).toBe("closed");
    await expect(transport.fetch("https://rpc.test/")).rejects.toMatchObject({ state: "closed" });
  });
});
