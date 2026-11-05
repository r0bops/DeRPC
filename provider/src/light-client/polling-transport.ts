import type { ApiClient } from "@lodestar/api";
import { LightClientRestTransport, type LightClientTransport } from "@lodestar/light-client/transport";
import type { LightClientFinalityUpdate, LightClientOptimisticUpdate } from "@lodestar/types";

export interface PollingTransportOptions {
  /** How often to poll for new head updates. Mainnet produces a block every 12 s. */
  intervalMs?: number;
  /**
   * Slot of the optimistic head the light client has actually accepted. Used to skip duplicate
   * polls without letting a rejected high-slot response hide a later valid update.
   */
  getVerifiedHeadSlot?: () => number;
  /** Slot of the finalized header the light client has actually accepted. */
  getVerifiedFinalizedSlot?: () => number;
  /** Called on every failed poll with the number of consecutive failures; any success resets it. */
  onPollError?: (error: unknown, consecutiveFailures: number) => void;
}

/**
 * A light-client transport that never opens the beacon node's event stream.
 *
 * Lodestar's LightClientRestTransport gets head updates over Server-Sent Events. EventSource makes
 * its own HTTP connection outside the injected fetch, so through Anon-RPC it would leak the user's
 * IP to the beacon endpoint. This transport keeps the fetch-based getters and polls for heads.
 */
export class PollingLightClientTransport implements LightClientTransport {
  private readonly rest: LightClientRestTransport;
  private readonly intervalMs: number;
  private readonly getVerifiedHeadSlot: (() => number) | undefined;
  private readonly getVerifiedFinalizedSlot: (() => number) | undefined;
  private readonly onPollError: ((error: unknown, consecutiveFailures: number) => void) | undefined;
  private readonly optimisticHandlers: ((update: LightClientOptimisticUpdate) => void)[] = [];
  private readonly finalityHandlers: ((update: LightClientFinalityUpdate) => void)[] = [];
  private lastOptimisticSlot = -1;
  private lastFinalizedSlot = -1;
  private consecutiveFailures = 0;
  private running = false;
  private stopped = false;

  constructor(api: ApiClient, opts: PollingTransportOptions = {}) {
    this.rest = new LightClientRestTransport(api);
    this.intervalMs = opts.intervalMs ?? 12_000;
    this.getVerifiedHeadSlot = opts.getVerifiedHeadSlot;
    this.getVerifiedFinalizedSlot = opts.getVerifiedFinalizedSlot;
    this.onPollError = opts.onPollError;
  }

  getUpdates: LightClientTransport["getUpdates"] = (startPeriod, count) => this.rest.getUpdates(startPeriod, count);
  getOptimisticUpdate: LightClientTransport["getOptimisticUpdate"] = () => this.rest.getOptimisticUpdate();
  getFinalityUpdate: LightClientTransport["getFinalityUpdate"] = () => this.rest.getFinalityUpdate();
  getBootstrap: LightClientTransport["getBootstrap"] = (blockRoot) => this.rest.getBootstrap(blockRoot);

  onOptimisticUpdate(handler: (update: LightClientOptimisticUpdate) => void): void {
    this.optimisticHandlers.push(handler);
    this.startPolling();
  }

  onFinalityUpdate(handler: (update: LightClientFinalityUpdate) => void): void {
    this.finalityHandlers.push(handler);
    this.startPolling();
  }

  close(): void {
    this.stopped = true;
  }

  consecutivePollFailures(): number {
    return this.consecutiveFailures;
  }

  private startPolling(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.optimisticHandlers.length > 0) await this.pollOptimistic();
      if (this.finalityHandlers.length > 0 && !this.stopped) await this.pollFinality();
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
    this.running = false;
  }

  private async pollOptimistic(): Promise<void> {
    try {
      const { data } = await this.rest.getOptimisticUpdate();
      this.consecutiveFailures = 0;
      const slot = data.attestedHeader.beacon.slot;
      const verifiedSlot = this.getVerifiedHeadSlot?.() ?? this.lastOptimisticSlot;
      if (slot <= verifiedSlot) return;
      for (const handler of this.optimisticHandlers) handler(data);
      // Only remember the polled slot after every handler accepted it. When the light client's
      // verified slot is available it remains authoritative, since a handler can accept without
      // advancing the head (for example when participation is below the safety threshold).
      this.lastOptimisticSlot = slot;
    } catch (error) {
      // Retried on the next tick; the light client keeps its last verified head.
      this.reportFailure(error);
    }
  }

  private async pollFinality(): Promise<void> {
    try {
      const { data } = await this.rest.getFinalityUpdate();
      this.consecutiveFailures = 0;
      const slot = data.finalizedHeader.beacon.slot;
      const verifiedSlot = this.getVerifiedFinalizedSlot?.() ?? this.lastFinalizedSlot;
      if (slot <= verifiedSlot) return;
      for (const handler of this.finalityHandlers) handler(data);
      this.lastFinalizedSlot = slot;
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.onPollError?.(error, this.consecutiveFailures);
  }
}
