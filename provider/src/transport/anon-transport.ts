import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import type { WorkerPin } from "../config/mainnet.ts";
import { createPinnedBootstrapProvider } from "./pinned-bootstrap.ts";

export type TransportState = "booting" | "ready" | "failed" | "closed";

export interface WorkerLogLine {
  level: "debug" | "info" | "warn" | "error";
  text: string;
  at: number;
}

export interface AnonFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Calls under different keys should not be linkable (worker-dependent, SPEC §9.3). */
  isolationKey?: string;
  /** Abort the call after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AnonTransport {
  readonly pin: WorkerPin;
  readonly ready: Promise<void>;
  state(): TransportState;
  /** Anonymized fetch through the sandboxed worker. Never falls back to a direct request. */
  fetch(url: string, options?: AnonFetchOptions): Promise<Response>;
  close(): void;
}

export interface StartOptions {
  pin: WorkerPin;
  onLog?: (line: WorkerLogLine) => void;
  onState?: (state: TransportState, detail?: string) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The worker is gone (failed or closed). Not an endpoint problem: do not retry another operator. */
export class TransportUnavailableError extends Error {
  readonly state: "failed" | "closed";
  constructor(state: "failed" | "closed", options?: { cause?: unknown }) {
    super(`DeRPC: anonymous transport is ${state}; refusing to send (no direct fallback)`, options);
    this.name = "TransportUnavailableError";
    this.state = state;
  }
}

// The harness rejects pending calls and closes the log queue in the same step, so once a call has
// failed, a dead worker has settled `died` by the next macrotask.
function settlesSoon(died: Promise<unknown>): Promise<boolean> {
  return Promise.race([died.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))]);
}

function logToConsole(line: WorkerLogLine): void {
  console[line.level]("[worker]", line.text);
}

/** Start one long-lived anonymity worker. Calls made before it is ready are buffered by the harness. */
export function startAnonTransport({ pin, onLog, onState }: StartOptions): AnonTransport {
  let current: TransportState = "booting";
  let failure: unknown;
  const setState = (next: TransportState, detail?: string) => {
    current = next;
    onState?.(next, detail);
  };
  const state = (): TransportState => current;
  const markFailed = (error: unknown) => {
    if (current === "failed" || current === "closed") return;
    failure = error;
    setState("failed", error instanceof Error ? error.message : String(error));
  };

  const worker = new AnonRpcWorker({
    address: pin.specifier,
    config: pin.config as never,
    preExisting: { rpcProvider: createPinnedBootstrapProvider(pin) },
  });

  const ready = worker.ready.then(
    () => {
      if (current === "booting") setState("ready");
    },
    (error: unknown) => {
      markFailed(error);
      throw error;
    },
  );
  onState?.("booting");

  // Always read the log queue: it closes only when the worker dies, so it also reports failures
  // after startup. Without onLog, lines go to the console as the harness would print them.
  const died = pumpLogs(worker, onLog ?? logToConsole).then((error) => markFailed(error));

  return {
    pin,
    ready,
    state,
    async fetch(url, options = {}) {
      if (current === "failed" || current === "closed") {
        throw new TransportUnavailableError(current, { cause: failure });
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        return await worker.fetch(url, {
          method: options.method ?? "GET",
          headers: options.headers,
          body: options.body,
          signal,
          ...(options.isolationKey ? { anonOptions: { isolationKey: options.isolationKey } } : {}),
        } as RequestInit);
      } catch (error) {
        // close() may have run while the call was in flight.
        if (state() === "closed") throw new TransportUnavailableError("closed", { cause: error });
        if (!(await settlesSoon(died))) throw error;
        throw new TransportUnavailableError(state() === "closed" ? "closed" : "failed", { cause: error });
      }
    },
    close() {
      setState("closed");
      worker.close();
    },
  };
}

/** Resolves with the worker's failure once it fails or closes and its retained entries are drained (SPEC §13.1). */
async function pumpLogs(worker: AnonRpcWorker, onLog: (line: WorkerLogLine) => void): Promise<unknown> {
  for (;;) {
    let entry;
    try {
      entry = await worker.acceptLog();
    } catch (error) {
      return error;
    }
    const text = entry.args
      .map((a: unknown) => (typeof a === "string" ? a : a instanceof Uint8Array ? `<${a.length} bytes>` : JSON.stringify(a)))
      .join(" ");
    onLog({ level: entry.level, text, at: Date.now() });
  }
}
