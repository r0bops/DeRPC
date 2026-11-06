import { getClient } from "@lodestar/api";
import { Lightclient } from "@lodestar/light-client";
import { getChainForkConfigFromNetwork } from "@lodestar/light-client/utils";
import type { LightClientHeader } from "@lodestar/types";
import { fromHex, toHex } from "@lodestar/utils";
import { PollingLightClientTransport } from "./polling-transport.ts";

export type HeaderNetwork = "mainnet" | "hoodi";

/** Genesis data is part of the trust anchor: it fixes the chain whose signatures we accept. */
export const GENESIS: Record<HeaderNetwork, { genesisTime: number; genesisValidatorsRoot: `0x${string}` }> = {
  mainnet: { genesisTime: 1606824023, genesisValidatorsRoot: "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95" },
  hoodi: { genesisTime: 1742213400, genesisValidatorsRoot: "0x212f13fc4df078b6cb7db228f1c8307566dcecf900867401a92023d7ba99cb5f" },
};

const SECONDS_PER_SLOT = 12;
const SLOTS_PER_EPOCH = 32;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A finalized execution header, verified from the pinned checkpoint through sync-committee signatures. */
export interface VerifiedHeader {
  /** Chain selected by the checkpoint and genesis trust anchor. Required for local execution. */
  network?: HeaderNetwork;
  slot: number;
  blockNumber: number;
  blockHash: `0x${string}`;
  stateRoot: `0x${string}`;
  /** Execution block timestamp, in seconds. */
  timestamp: number;
  /** Context authenticated by the execution-payload branch; required for local EVM calls. */
  execution?: {
    feeRecipient: `0x${string}`;
    prevRandao: `0x${string}`;
    gasLimit: bigint;
    baseFeePerGas: bigint;
    excessBlobGas?: bigint;
  };
}

export class StaleCheckpointError extends Error {
  override name = "StaleCheckpointError";
}
export class StaleHeaderError extends Error {
  override name = "StaleHeaderError";
}
export class HeaderSourceNotReadyError extends Error {
  override name = "HeaderSourceNotReadyError";
}

export interface HeaderSourceOptions {
  network: HeaderNetwork;
  /** Trusted finalized checkpoint, shipped with the build. */
  checkpoint: { root: `0x${string}`; epoch: number };
  beaconUrl: string;
  /** Additional beacon endpoints to try when startup fails. */
  beaconUrls?: string[];
  /** Anonymized fetch. Every request of the light client goes through it. */
  fetch: typeof fetch;
  /** Per-startup-attempt fetch (for example a fresh isolation key). Defaults to `fetch`. */
  fetchForAttempt?: (attempt: number) => typeof fetch;
  /** Cancels startup, polling and every fetch belonging to this source. */
  signal?: AbortSignal;
  /** Refuse to start from an older checkpoint. Default: 7 days. */
  maxCheckpointAgeMs?: number;
  /** Never report a finalized header older than this. Default: 30 minutes (finality normally lags ~13). */
  maxFinalizedAgeMs?: number;
  pollIntervalMs?: number;
  /** Total startup budget, including every bootstrap and signature-verified head. Default: 60 s. */
  readyTimeoutMs?: number;
  /** Maximum startup attempts, rounded up to cover every beacon once. Default max(4, beacon count). */
  startupAttempts?: number;
  onLog?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

export interface PollHealth {
  /** Worst consecutive failure count across optimistic and finality polling. */
  consecutiveFailures: number;
  lastError?: string;
}

export interface VerifiedHeaderSource {
  /** The latest verified finalized header. Throws StaleHeaderError instead of returning stale data. */
  finalized(): VerifiedHeader;
  /** Throws StaleHeaderError when `header` is older than the freshness limit. */
  assertFresh(header: VerifiedHeader): void;
  /** Poll failures remain visible until the affected update kind recovers. */
  pollHealth(): PollHealth;
  close(): void;
}

/**
 * Start the light client from a pinned checkpoint and resolve once it is safe to read from:
 * at least one head update has passed sync-committee signature verification (the bootstrap alone is
 * trusted only through the pinned root), and the finalized header is fresh.
 */
export async function startVerifiedHeaderSource(opts: HeaderSourceOptions): Promise<VerifiedHeaderSource> {
  opts.signal?.throwIfAborted();
  const genesis = GENESIS[opts.network];
  const maxCheckpointAgeMs = opts.maxCheckpointAgeMs ?? 7 * DAY_MS;
  const maxFinalizedAgeMs = opts.maxFinalizedAgeMs ?? 30 * MINUTE_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) throw new Error("readyTimeoutMs must be a positive integer");
  if (opts.startupAttempts !== undefined && (!Number.isSafeInteger(opts.startupAttempts) || opts.startupAttempts <= 0)) throw new Error("startupAttempts must be a positive integer");
  const deadline = performance.now() + readyTimeoutMs;
  const config = getChainForkConfigFromNetwork(opts.network);
  const log = (level: "error" | "warn" | "info" | "debug", message: string) => {
    try { opts.onLog?.(level, message); } catch { /* app observer */ }
  };
  const logger = {
    error: (msg: string) => log("error", msg),
    warn: (msg: string) => log("warn", msg),
    info: (msg: string) => log("info", msg),
    debug: (msg: string) => log("debug", msg),
  };
  const beaconUrls = [...new Set([opts.beaconUrl, ...(opts.beaconUrls ?? [])])];
  const fetchForAttempt = opts.fetchForAttempt ?? (() => opts.fetch);

  // Fast, offline refusal before any request. The bootstrap check below repeats it from the slot
  // the pinned root actually resolves to (#33).
  const configuredCheckpointTimeMs = (genesis.genesisTime + opts.checkpoint.epoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT) * 1000;
  if (Date.now() - configuredCheckpointTimeMs > maxCheckpointAgeMs) {
    throw new StaleCheckpointError(
      `pinned checkpoint (epoch ${opts.checkpoint.epoch}) is ${((Date.now() - configuredCheckpointTimeMs) / DAY_MS).toFixed(1)} days old; refresh it`,
    );
  }

  const assertFresh = (header: VerifiedHeader) => {
    const ageMs = Date.now() - header.timestamp * 1000;
    if (ageMs > maxFinalizedAgeMs) {
      const ageMin = (Date.now() / 1000 - header.timestamp) / 60;
      throw new StaleHeaderError(`latest verified finalized header (block ${header.blockNumber}) is ${ageMin.toFixed(0)} min old`);
    }
  };

  let lastError: unknown;
  const attempts = Math.max(beaconUrls.length, opts.startupAttempts ?? 4);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    opts.signal?.throwIfAborted();
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    // Give each configured endpoint a turn before reusing one. A responsive bootstrap with
    // unusable updates cannot consume the time reserved for the remaining endpoints in this pass.
    const index = (attempt - 1) % beaconUrls.length;
    const turnsLeft = Math.min(beaconUrls.length - index, attempts - attempt + 1);
    const attemptMs = remainingMs / turnsLeft;
    const controller = new AbortController();
    const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    const beaconUrl = beaconUrls[index]!;
    const api = getClient({ urls: [beaconUrl], fetch: cancellableFetch(fetchForAttempt(attempt), signal) }, { config });
    let client: Lightclient | undefined;
    const transport = new PollingLightClientTransport(api, {
      intervalMs: opts.pollIntervalMs,
      // Polling must skip based on what the light client actually verified, not on the last response
      // the beacon endpoint returned. A rejected high-slot update must not hide a later valid one.
      getVerifiedHeadSlot: () => client?.getHead().beacon.slot ?? -1,
      getVerifiedFinalizedSlot: () => client?.getFinalized().beacon.slot ?? -1,
      onPollError: (error, consecutiveFailures) => {
        const message = error instanceof Error ? error.message : String(error);
        log("warn", `head poll failed (${consecutiveFailures} in a row): ${message}`);
      },
    });
    const timeout = setTimeout(() => controller.abort(new HeaderSourceNotReadyError("beacon startup attempt exceeded its time budget")), attemptMs);
    let closed = false;
    const closeAttempt = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", closeAttempt);
      controller.abort(new DOMException("light client attempt closed", "AbortError"));
      client?.stop();
      transport.close();
    };
    signal.addEventListener("abort", closeAttempt, { once: true });
    try {
      const initializing = Lightclient.initializeFromCheckpointRoot({
        config,
        logger,
        transport,
        genesisData: genesis,
        checkpointRoot: fromHex(opts.checkpoint.root),
      });
      // Even a caller-supplied fetch that ignores abort cannot keep startup waiting or return
      // a late light client that outlives the abandoned attempt.
      initializing.then(late => { if (closed) late.stop(); }, () => {});
      client = await withSignal(initializing, signal);
      const started = client;
      // #33: trust the age of the root we actually resolved, not the configured epoch.
      const bootstrapSlot = started.getHead().beacon.slot;
      const bootstrapEpoch = Math.floor(bootstrapSlot / SLOTS_PER_EPOCH);
      if (bootstrapEpoch !== opts.checkpoint.epoch) {
        throw new StaleCheckpointError(
          `pinned root resolves to epoch ${bootstrapEpoch}, but the configured checkpoint says epoch ${opts.checkpoint.epoch}; refresh it`,
        );
      }
      const bootstrapTimeMs = (genesis.genesisTime + bootstrapSlot * SECONDS_PER_SLOT) * 1000;
      if (Date.now() - bootstrapTimeMs > maxCheckpointAgeMs) {
        throw new StaleCheckpointError(
          `pinned checkpoint (bootstrap slot ${bootstrapSlot}, epoch ${bootstrapEpoch}) is ${((Date.now() - bootstrapTimeMs) / DAY_MS).toFixed(1)} days old; refresh it`,
        );
      }
      void started.start().catch(error => controller.abort(error));
      await waitFor(
        () => started.getHead().beacon.slot > bootstrapSlot && isFresh(started.getFinalized(), maxFinalizedAgeMs),
        signal,
      );
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new HeaderSourceNotReadyError("light client startup time budget exhausted");
      clearTimeout(timeout); // the startup budget must not stop a healthy running source
      return {
        finalized() {
          signal.throwIfAborted();
          const header = toVerifiedHeader(started.getFinalized(), opts.network);
          assertFresh(header);
          return header;
        },
        assertFresh,
        pollHealth: () => transport.pollHealth(),
        close: closeAttempt,
      };
    } catch (error) {
      closeAttempt();
      lastError = error;
      opts.signal?.throwIfAborted();
      if (error instanceof StaleCheckpointError) throw error;
      if (performance.now() >= deadline) break;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new HeaderSourceNotReadyError("light client did not become ready; no beacon endpoint answered");
}

function isFresh(header: LightClientHeader, maxAgeMs: number): boolean {
  return Date.now() - toVerifiedHeader(header).timestamp * 1000 <= maxAgeMs;
}

function toVerifiedHeader(header: LightClientHeader, network?: HeaderNetwork): VerifiedHeader {
  const execution = (header as { execution?: {
    blockNumber: number; blockHash: Uint8Array; stateRoot: Uint8Array; timestamp: number;
    feeRecipient: Uint8Array; prevRandao: Uint8Array; gasLimit: number | bigint;
    baseFeePerGas: bigint; excessBlobGas?: number | bigint;
  } }).execution;
  if (!execution) throw new Error("light client header has no execution payload header (pre-Capella)");
  return {
    ...(network ? { network } : {}),
    slot: header.beacon.slot,
    blockNumber: Number(execution.blockNumber),
    blockHash: toHex(execution.blockHash) as `0x${string}`,
    stateRoot: toHex(execution.stateRoot) as `0x${string}`,
    timestamp: Number(execution.timestamp),
    execution: {
      feeRecipient: toHex(execution.feeRecipient) as `0x${string}`,
      prevRandao: toHex(execution.prevRandao) as `0x${string}`,
      gasLimit: BigInt(execution.gasLimit),
      baseFeePerGas: BigInt(execution.baseFeePerGas),
      ...(execution.excessBlobGas !== undefined ? { excessBlobGas: BigInt(execution.excessBlobGas) } : {}),
    },
  };
}

async function waitFor(condition: () => boolean, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    if (condition()) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 25);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { work.catch(() => {}); reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function cancellableFetch(fetch: typeof globalThis.fetch, attemptSignal: AbortSignal): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const requestSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = requestSignal ? AbortSignal.any([attemptSignal, requestSignal]) : attemptSignal;
    signal.throwIfAborted();
    const response = fetch(input, { ...init, signal }).then(response => {
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw signal.reason; }
      return response;
    });
    return withSignal(response, signal);
  };
}
