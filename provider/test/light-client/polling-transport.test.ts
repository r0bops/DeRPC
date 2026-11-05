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
const FINALITY_PATH = "/eth/v1/beacon/light_client/finality_update";
const ATTESTED_SLOT = Number(JSON.parse(responses[OPTIMISTIC_PATH]!.body).data.attested_header.beacon.slot);
const FINALIZED_SLOT = Number(JSON.parse(responses[FINALITY_PATH]!.body).data.finalized_header.beacon.slot);

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

function recordedWithSlot(response: RecordedResponse, setSlot: (data: any) => void): RecordedResponse {
  const body = JSON.parse(response.body);
  setSlot(body.data);
  return { ...response, body: JSON.stringify(body) };
}

function sequencedFetch(sequences: Record<string, RecordedResponse[]>) {
  const requested: string[] = [];
  const next = new Map<string, number>();
  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(BEACON.length);
    requested.push(path);
    const sequence = sequences[path];
    if (!sequence?.length) return new Response("no fixture", { status: 404 });
    const index = Math.min(next.get(path) ?? 0, sequence.length - 1);
    next.set(path, index + 1);
    const recorded = sequence[index]!;
    return new Response(recorded.body, { status: recorded.status, headers: recorded.headers });
  };
  return { fetch: fetchFn as typeof fetch, requested };
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

  it("applies valid lower-slot updates after a rejected high-slot optimistic update", async () => {
    const invalidHigh = recordedWithSlot(responses[OPTIMISTIC_PATH]!, (data) => {
      data.attested_header.beacon.slot = String(ATTESTED_SLOT + 1_000);
    });
    const served = sequencedFetch({ [OPTIMISTIC_PATH]: [invalidHigh, responses[OPTIMISTIC_PATH]!] });
    const api = getClient({ urls: [BEACON], fetch: served.fetch }, { config });
    let verifiedSlot = -1;
    transport = new PollingLightClientTransport(api, { intervalMs: 5, getVerifiedHeadSlot: () => verifiedSlot });
    const heads: number[] = [];

    transport.onOptimisticUpdate((update) => {
      const slot = update.attestedHeader.beacon.slot;
      if (slot !== ATTESTED_SLOT) throw new Error("invalid update");
      verifiedSlot = slot;
      heads.push(slot);
    });

    await vi.waitFor(() => expect(heads).toEqual([ATTESTED_SLOT]));
  });

  it("applies valid lower-slot updates after a rejected high-slot finality update", async () => {
    const invalidHigh = recordedWithSlot(responses[FINALITY_PATH]!, (data) => {
      data.finalized_header.beacon.slot = String(FINALIZED_SLOT + 1_000);
    });
    const served = sequencedFetch({ [FINALITY_PATH]: [invalidHigh, responses[FINALITY_PATH]!] });
    const api = getClient({ urls: [BEACON], fetch: served.fetch }, { config });
    let verifiedSlot = -1;
    transport = new PollingLightClientTransport(api, { intervalMs: 5, getVerifiedFinalizedSlot: () => verifiedSlot });
    const finalized: number[] = [];

    transport.onFinalityUpdate((update) => {
      const slot = update.finalizedHeader.beacon.slot;
      if (slot !== FINALIZED_SLOT) throw new Error("invalid update");
      verifiedSlot = slot;
      finalized.push(slot);
    });

    await vi.waitFor(() => expect(finalized).toEqual([FINALIZED_SLOT]));
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
