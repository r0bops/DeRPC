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
  slot: number;
  blockNumber: number;
  blockHash: `0x${string}`;
  stateRoot: `0x${string}`;
  /** Execution block timestamp, in seconds. */
  timestamp: number;
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
  /** Anonymized fetch. Every request of the light client goes through it. */
  fetch: typeof fetch;
  /** Refuse to start from an older checkpoint. Default: 7 days. */
  maxCheckpointAgeMs?: number;
  /** Never report a finalized header older than this. Default: 30 minutes (finality normally lags ~13). */
  maxFinalizedAgeMs?: number;
  pollIntervalMs?: number;
  /** How long to wait for a signature-verified head and a fresh finalized header. Default: 60 s. */
  readyTimeoutMs?: number;
  onLog?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

export interface PollHealth {
  /** Head polls that failed in a row. Zero after any successful poll. */
  consecutiveFailures: number;
  lastError?: string;
}

export interface VerifiedHeaderSource {
  /** The latest verified finalized header. Throws StaleHeaderError instead of returning stale data. */
  finalized(): VerifiedHeader;
  /** Whether head polling is currently failing, so callers can show it before the header goes stale. */
  pollHealth(): PollHealth;
  close(): void;
}

/**
 * Start the light client from a pinned checkpoint and resolve once it is safe to read from:
 * at least one head update has passed sync-committee signature verification (the bootstrap alone is
 * trusted only through the pinned root), and the finalized header is fresh.
 */
export async function startVerifiedHeaderSource(opts: HeaderSourceOptions): Promise<VerifiedHeaderSource> {
  const genesis = GENESIS[opts.network];
  const maxCheckpointAgeMs = opts.maxCheckpointAgeMs ?? 7 * DAY_MS;
  const maxFinalizedAgeMs = opts.maxFinalizedAgeMs ?? 30 * MINUTE_MS;

  const checkpointTimeMs = (genesis.genesisTime + opts.checkpoint.epoch * SLOTS_PER_EPOCH * SECONDS_PER_SLOT) * 1000;
  const checkpointAgeMs = Date.now() - checkpointTimeMs;
  if (checkpointAgeMs > maxCheckpointAgeMs) {
    throw new StaleCheckpointError(
      `pinned checkpoint (epoch ${opts.checkpoint.epoch}) is ${(checkpointAgeMs / DAY_MS).toFixed(1)} days old; refresh it`,
    );
  }

  const config = getChainForkConfigFromNetwork(opts.network);
  const api = getClient({ urls: [opts.beaconUrl], fetch: opts.fetch }, { config });
  let lc: Lightclient | undefined;
  let health: PollHealth = { consecutiveFailures: 0 };
  const transport = new PollingLightClientTransport(api, {
    intervalMs: opts.pollIntervalMs,
    // Polling must skip based on what the light client actually verified, not on the last response
    // the beacon endpoint returned. A rejected high-slot update must not hide a later valid one.
    getVerifiedHeadSlot: () => lc?.getHead().beacon.slot ?? -1,
    getVerifiedFinalizedSlot: () => lc?.getFinalized().beacon.slot ?? -1,
    onPollError: (error, consecutiveFailures) => {
      const message = error instanceof Error ? error.message : String(error);
      health = { consecutiveFailures, lastError: message };
      opts.onLog?.("warn", `head poll failed (${consecutiveFailures} in a row): ${message}`);
    },
  });
  const log = opts.onLog ?? (() => {});
  const logger = {
    error: (msg: string) => log("error", msg),
    warn: (msg: string) => log("warn", msg),
    info: (msg: string) => log("info", msg),
    debug: (msg: string) => log("debug", msg),
  };

  const close = () => {
    lc?.stop();
    transport.close();
  };

  const isFresh = (header: VerifiedHeader) => Date.now() - header.timestamp * 1000 <= maxFinalizedAgeMs;

  try {
    lc = await Lightclient.initializeFromCheckpointRoot({
      config,
      logger,
      transport,
      genesisData: genesis,
      checkpointRoot: fromHex(opts.checkpoint.root),
    });
    const client = lc;
    const bootstrapSlot = client.getHead().beacon.slot;
    void client.start();
    await waitFor(
      () => client.getHead().beacon.slot > bootstrapSlot && isFresh(toVerifiedHeader(client.getFinalized())),
      opts.readyTimeoutMs ?? 60_000,
      () => new HeaderSourceNotReadyError("no signature-verified head update and fresh finalized header arrived in time"),
    );
  } catch (error) {
    close();
    throw error;
  }

  const client = lc;
  return {
    finalized() {
      const header = toVerifiedHeader(client.getFinalized());
      if (!isFresh(header)) {
        const ageMin = (Date.now() / 1000 - header.timestamp) / 60;
        throw new StaleHeaderError(`latest verified finalized header (block ${header.blockNumber}) is ${ageMin.toFixed(0)} min old`);
      }
      return header;
    },
    pollHealth() {
      return transport.consecutivePollFailures() === 0 ? { consecutiveFailures: 0 } : { ...health };
    },
    close,
  };
}

function toVerifiedHeader(header: LightClientHeader): VerifiedHeader {
  const execution = (header as { execution?: { blockNumber: number; blockHash: Uint8Array; stateRoot: Uint8Array; timestamp: number } }).execution;
  if (!execution) throw new Error("light client header has no execution payload header (pre-Capella)");
  return {
    slot: header.beacon.slot,
    blockNumber: Number(execution.blockNumber),
    blockHash: toHex(execution.blockHash) as `0x${string}`,
    stateRoot: toHex(execution.stateRoot) as `0x${string}`,
    timestamp: Number(execution.timestamp),
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number, onTimeout: () => Error): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw onTimeout();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
