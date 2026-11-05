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

/** Start one long-lived anonymity worker. Calls made before it is ready are buffered by the harness. */
export function startAnonTransport({ pin, onLog, onState }: StartOptions): AnonTransport {
  let current: TransportState = "booting";
  const setState = (next: TransportState, detail?: string) => {
    current = next;
    onState?.(next, detail);
  };

  const worker = new AnonRpcWorker({
    address: pin.specifier,
    config: pin.config as never,
    preExisting: { rpcProvider: createPinnedBootstrapProvider(pin) },
  });

  const ready = worker.ready.then(
    () => setState("ready"),
    (error: unknown) => {
      setState("failed", error instanceof Error ? error.message : String(error));
      throw error;
    },
  );
  onState?.("booting");

  if (onLog) void pumpLogs(worker, onLog);

  return {
    pin,
    ready,
    state: () => current,
    async fetch(url, options = {}) {
      if (current === "failed" || current === "closed") {
        throw new Error(`DeRPC: anonymous transport is ${current}; refusing to send (no direct fallback)`);
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      return worker.fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal,
        ...(options.isolationKey ? { anonOptions: { isolationKey: options.isolationKey } } : {}),
      } as RequestInit);
    },
    close() {
      setState("closed");
      worker.close();
    },
  };
}

async function pumpLogs(worker: AnonRpcWorker, onLog: (line: WorkerLogLine) => void): Promise<void> {
  for (;;) {
    let entry;
    try {
      entry = await worker.acceptLog();
    } catch {
      return; // worker failed or closed and its retained entries are drained (SPEC §13.1)
    }
    const text = entry.args
      .map((a: unknown) => (typeof a === "string" ? a : a instanceof Uint8Array ? `<${a.length} bytes>` : JSON.stringify(a)))
      .join(" ");
    onLog({ level: entry.level, text, at: Date.now() });
  }
}
