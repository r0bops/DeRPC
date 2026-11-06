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

/** The anonymity network is unreachable (exit timeout, circuit reset, worker request timeout). */
export class NetworkUnavailableError extends Error {
  override name = "NetworkUnavailableError";
  readonly code?: string | number;
  readonly kind?: string;
  readonly torKind?: string;
  constructor(message: string, options: { cause?: unknown; code?: string | number; kind?: string; torKind?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.kind = options.kind;
    this.torKind = options.torKind;
  }
}

/** The worker is gone (failed or closed). Not an endpoint problem: do not retry another operator. */
export class TransportUnavailableError extends Error {
  readonly state: "failed" | "closed";
  constructor(state: "failed" | "closed", options?: { cause?: unknown }) {
    super(`DeRPC: anonymous transport is ${state}; refusing to send (no direct fallback)`, options);
    this.name = "TransportUnavailableError";
    this.state = state;
  }
}

// Errors the harness uses when the whole worker dies (signalFailed, crash, bundle load, close).
function isWorkerFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "WorkerFailedError") return true;
  return /^worker (error:|bundle failed to load:|closed$)/.test(error.message);
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

  // The log queue closes only when the worker dies, so it also reports failures after startup.
  if (onLog) void pumpLogs(worker, onLog).then((error) => markFailed(error));

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
        if (isWorkerFailure(error)) {
          markFailed(error);
          throw new TransportUnavailableError("failed", { cause: error });
        }
        // A request-level failure while the worker stays up: the anonymity network, not the operator.
        if (error instanceof NetworkUnavailableError) throw error;
        throw new NetworkUnavailableError(error instanceof Error ? error.message : String(error), { cause: error, ...detailsOf(error) });
      }
    },
    close() {
      setState("closed");
      worker.close();
    },
  };
}

/** Harness errors carry the transport details (#14); keep the ones that tell a network failure apart. */
function detailsOf(error: unknown): { code?: string | number; kind?: string; torKind?: string } {
  if (!error || typeof error !== "object") return {};
  const e = error as { code?: unknown; kind?: unknown; torKind?: unknown };
  return {
    ...(typeof e.code === "string" || typeof e.code === "number" ? { code: e.code } : {}),
    ...(typeof e.kind === "string" ? { kind: e.kind } : {}),
    ...(typeof e.torKind === "string" ? { torKind: e.torKind } : {}),
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
