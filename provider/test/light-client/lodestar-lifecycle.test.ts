import { afterEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@lodestar/api";
import { Lightclient, RunStatusCode } from "@lodestar/light-client";
import { getChainForkConfigFromNetwork } from "@lodestar/light-client/utils";
import { fromHex } from "@lodestar/utils";
import { GENESIS } from "../../src/light-client/header-source.ts";
import { PollingLightClientTransport } from "../../src/light-client/polling-transport.ts";
import { fixtureFetch, type RecordedResponse } from "../helpers/fixture-fetch.ts";
import fixture from "../fixtures/mainnet-light-client.json" with { type: "json" };

let client: Lightclient | undefined;
let transport: PollingLightClientTransport | undefined;
afterEach(() => { client?.stop(); transport?.close(); vi.useRealTimers(); });

async function initialized(now = fixture.capturedAt) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const config = getChainForkConfigFromNetwork("mainnet");
  const served = fixtureFetch("https://beacon.example", fixture.responses as Record<string, RecordedResponse>);
  transport = new PollingLightClientTransport(getClient({ urls: ["https://beacon.example"], fetch: served.fetch }, { config }), { intervalMs: 5 });
  client = await Lightclient.initializeFromCheckpointRoot({
    config, transport, genesisData: GENESIS.mainnet, checkpointRoot: fromHex(fixture.checkpoint.root),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  return { client, transport, served };
}

describe("Lodestar attempt lifecycle patch", () => {
  it("stops a just-initialized client before it can subscribe or fetch updates", async () => {
    const { client, transport, served } = await initialized();
    const subscribe = vi.spyOn(transport, "onOptimisticUpdate");
    client.stop();
    await expect(client.start()).rejects.toMatchObject({ name: "AbortError" });
    expect(client.status).toBe(RunStatusCode.stopped);
    expect(subscribe).not.toHaveBeenCalled();
    expect(served.requested).toHaveLength(1); // the genuine, root-verified bootstrap only
  });

  it("does not process a late initial optimistic update or install handlers after stop", async () => {
    const { client, transport } = await initialized();
    const valid = await transport.getOptimisticUpdate();
    let release!: (update: typeof valid) => void;
    transport.getOptimisticUpdate = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const subscribe = vi.spyOn(transport, "onOptimisticUpdate");
    const bootstrapSlot = client.getHead().beacon.slot;
    await client.start();
    client.stop();
    release(valid);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(client.status).toBe(RunStatusCode.stopped);
    expect(client.getHead().beacon.slot).toBe(bootstrapSlot);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each(["request", "retry sleep"] as const)("stops during a committee sync %s without background retries", async phase => {
    // Move the local clock one committee period ahead: the genuine bootstrap now needs sync.
    const { client, transport } = await initialized(fixture.capturedAt + 8192 * 12 * 1000);
    let reject!: (error: Error) => void;
    const getUpdates = vi.fn(() => phase === "request"
      ? new Promise<never>((_, rejectRequest) => { reject = rejectRequest; })
      : Promise.reject(new Error("beacon unavailable")));
    transport.getUpdates = getUpdates;
    const starting = client.start();
    const stopped = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(client.status).toBe(RunStatusCode.syncing);
    expect(getUpdates).toHaveBeenCalledOnce();
    client.stop();
    if (phase === "request") reject(new Error("late request failure"));
    await stopped;
    await new Promise(resolve => setTimeout(resolve, 1050));
    expect(client.status).toBe(RunStatusCode.stopped);
    expect(getUpdates).toHaveBeenCalledOnce();
  });
});
