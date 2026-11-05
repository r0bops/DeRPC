// The stock LightClientRestTransport subscribes to the beacon node's Server-Sent Events stream for
// head updates. EventSource opens its own HTTP connection, outside the injected (anonymized) fetch,
// so the beacon endpoint would see the user's real IP. DeRPC's transport must poll instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getClient } from "@lodestar/api";
import { getChainForkConfigFromNetwork } from "@lodestar/light-client/utils";
import { PollingLightClientTransport } from "../../src/light-client/polling-transport.ts";
import { fixtureFetch, type RecordedResponse } from "../helpers/fixture-fetch.ts";
import fixture from "../fixtures/mainnet-light-client.json" with { type: "json" };

const BEACON = "https://beacon.test";
const responses = fixture.responses as Record<string, RecordedResponse>;
const OPTIMISTIC_PATH = "/eth/v1/beacon/light_client/optimistic_update";
const ATTESTED_SLOT = Number(JSON.parse(responses[OPTIMISTIC_PATH]!.body).data.attested_header.beacon.slot);

const config = getChainForkConfigFromNetwork("mainnet");
let transport: PollingLightClientTransport | undefined;
afterEach(() => transport?.close());

function setup() {
  const served = fixtureFetch(BEACON, responses);
  const api = getClient({ urls: [BEACON], fetch: served.fetch }, { config });
  const eventstream = vi.spyOn(api.events, "eventstream");
  transport = new PollingLightClientTransport(api, { intervalMs: 5 });
  return { served, eventstream, transport };
}

describe("PollingLightClientTransport", () => {
  it("delivers optimistic updates by polling through the injected fetch, never the event stream", async () => {
    const { served, eventstream, transport } = setup();
    const heads: number[] = [];

    transport.onOptimisticUpdate((update) => heads.push(update.attestedHeader.beacon.slot));

    await vi.waitFor(() => expect(heads).toEqual([ATTESTED_SLOT]));
    expect(served.requested).toContain(OPTIMISTIC_PATH);
    expect(eventstream).not.toHaveBeenCalled();
  });

  it("delivers each head once even though polling keeps returning it", async () => {
    const { served, transport } = setup();
    const heads: number[] = [];

    transport.onOptimisticUpdate((update) => heads.push(update.attestedHeader.beacon.slot));

    await vi.waitFor(() => expect(served.requested.filter((p) => p === OPTIMISTIC_PATH).length).toBeGreaterThanOrEqual(3));
    expect(heads).toEqual([ATTESTED_SLOT]);
  });

  it("stops polling after close()", async () => {
    const { served, transport } = setup();
    transport.onOptimisticUpdate(() => {});
    await vi.waitFor(() => expect(served.requested.length).toBeGreaterThan(0));

    transport.close();
    const countAtClose = served.requested.length;
    await new Promise((r) => setTimeout(r, 50));

    expect(served.requested.length).toBeLessThanOrEqual(countAtClose + 2); // at most in-flight polls finish
  });
});
