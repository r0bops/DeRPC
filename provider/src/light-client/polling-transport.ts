import type { ApiClient } from "@lodestar/api";
import { LightClientRestTransport, type LightClientTransport } from "@lodestar/light-client/transport";
import type { LightClientFinalityUpdate, LightClientOptimisticUpdate } from "@lodestar/types";

export interface PollingTransportOptions {
  /** How often to poll for new head updates. Mainnet produces a block every 12 s. */
  intervalMs?: number;
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
  private readonly optimisticHandlers: ((update: LightClientOptimisticUpdate) => void)[] = [];
  private readonly finalityHandlers: ((update: LightClientFinalityUpdate) => void)[] = [];
  private lastOptimisticSlot = -1;
  private lastFinalizedSlot = -1;
  private running = false;
  private stopped = false;

  constructor(api: ApiClient, opts: PollingTransportOptions = {}) {
    this.rest = new LightClientRestTransport(api);
    this.intervalMs = opts.intervalMs ?? 12_000;
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
      if (data.attestedHeader.beacon.slot <= this.lastOptimisticSlot) return;
      this.lastOptimisticSlot = data.attestedHeader.beacon.slot;
      for (const handler of this.optimisticHandlers) handler(data);
    } catch {
      // A failed poll is retried on the next tick; the light client keeps its last verified head.
    }
  }

  private async pollFinality(): Promise<void> {
    try {
      const { data } = await this.rest.getFinalityUpdate();
      if (data.finalizedHeader.beacon.slot <= this.lastFinalizedSlot) return;
      this.lastFinalizedSlot = data.finalizedHeader.beacon.slot;
      for (const handler of this.finalityHandlers) handler(data);
    } catch {
      // As above.
    }
  }
}
