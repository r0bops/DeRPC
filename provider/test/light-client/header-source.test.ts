// The verified header source: pinned checkpoint in, verified finalized execution header out.
// Every expected value below is read from the recorded beacon data, not computed by the code under test.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HeaderSourceNotReadyError,
  StaleCheckpointError,
  StaleHeaderError,
  startVerifiedHeaderSource,
  type VerifiedHeaderSource,
} from "../../src/light-client/header-source.ts";
import { fixtureFetch, type RecordedResponse } from "../helpers/fixture-fetch.ts";
import mainnet from "../fixtures/mainnet-light-client.json" with { type: "json" };
import hoodi from "../fixtures/hoodi-light-client.json" with { type: "json" };

const BEACON = "https://beacon.test";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const mainnetResponses = mainnet.responses as Record<string, RecordedResponse>;
const bootstrapPath = `/eth/v1/beacon/light_client/bootstrap/${mainnet.checkpoint.root}`;
const OPTIMISTIC_PATH = "/eth/v1/beacon/light_client/optimistic_update";
const bootstrapHeader = JSON.parse(mainnetResponses[bootstrapPath]!.body).data.header;
const EXPECTED = {
  blockNumber: Number(bootstrapHeader.execution.block_number),
  blockHash: bootstrapHeader.execution.block_hash as string,
  stateRoot: bootstrapHeader.execution.state_root as string,
};

let source: VerifiedHeaderSource | undefined;
afterEach(() => {
  source?.close();
  source = undefined;
  vi.useRealTimers();
});

function at(ms: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
}

function start(network: "mainnet" | "hoodi", fixture: typeof mainnet | typeof hoodi, responses: Record<string, RecordedResponse>) {
  const served = fixtureFetch(BEACON, responses);
  const pending = startVerifiedHeaderSource({
    network,
    checkpoint: { root: fixture.checkpoint.root as `0x${string}`, epoch: fixture.checkpoint.epoch },
    beaconUrl: BEACON,
    fetch: served.fetch,
    pollIntervalMs: 5,
    readyTimeoutMs: 1_500,
  });
  return { served, pending };
}

function mutate(response: RecordedResponse, change: (data: any) => void): RecordedResponse {
  const body = JSON.parse(response.body);
  change(body.data);
  return { ...response, body: JSON.stringify(body) };
}

function sequencedFetch(sequences: Record<string, RecordedResponse[]>) {
  const next = new Map<string, number>();
  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.slice(BEACON.length);
    const sequence = sequences[path] ?? [mainnetResponses[path]!];
    const index = Math.min(next.get(path) ?? 0, sequence.length - 1);
    next.set(path, index + 1);
    const recorded = sequence[index];
    if (!recorded) return new Response("no fixture", { status: 404 });
    return new Response(recorded.body, { status: recorded.status, headers: recorded.headers });
  };
  return { fetch: fetchFn as typeof fetch };
}

describe("startVerifiedHeaderSource", () => {
  it("verifies the finalized execution header from the pinned mainnet checkpoint", async () => {
    at(mainnet.capturedAt);
    const { pending } = start("mainnet", mainnet, mainnetResponses);
    source = await pending;

    const header = source.finalized();

    expect(header.blockNumber).toBe(EXPECTED.blockNumber);
    expect(header.blockHash).toBe(EXPECTED.blockHash);
    expect(header.stateRoot).toBe(EXPECTED.stateRoot);
  });

  it("applies a valid head update after the beacon sends an invalid high-slot update", async () => {
    at(mainnet.capturedAt);
    const genuine = mainnetResponses[OPTIMISTIC_PATH]!;
    const invalidSignature = mutate(genuine, (data) => {
      const signature: string = data.sync_aggregate.sync_committee_signature;
      data.sync_aggregate.sync_committee_signature = signature.slice(0, -2) + (signature.endsWith("00") ? "01" : "00");
    });
    const invalidHighSlot = mutate(genuine, (data) => {
      data.attested_header.beacon.slot = String(Number(data.attested_header.beacon.slot) + 1_000);
    });
    const served = sequencedFetch({ [OPTIMISTIC_PATH]: [invalidSignature, invalidHighSlot, genuine] });
    source = await startVerifiedHeaderSource({
      network: "mainnet",
      checkpoint: { root: mainnet.checkpoint.root as `0x${string}`, epoch: mainnet.checkpoint.epoch },
      beaconUrl: BEACON,
      fetch: served.fetch,
      pollIntervalMs: 5,
      readyTimeoutMs: 1_500,
    });

    expect(source.finalized().blockNumber).toBe(EXPECTED.blockNumber);
  });

  it("refuses a checkpoint older than 7 days before making any request", async () => {
    const checkpointTime = (mainnet.genesisData.genesisTime + mainnet.checkpoint.epoch * 32 * 12) * 1000;
    at(checkpointTime + 8 * DAY);
    const { served, pending } = start("mainnet", mainnet, mainnetResponses);

    await expect(pending).rejects.toBeInstanceOf(StaleCheckpointError);
    expect(served.requested).toEqual([]);
  });

  it("rejects a bootstrap that does not match the pinned checkpoint root", async () => {
    at(mainnet.capturedAt);
    const tampered = JSON.parse(mainnetResponses[bootstrapPath]!.body);
    tampered.data.header.beacon.slot = String(Number(tampered.data.header.beacon.slot) + 1);
    const responses = { ...mainnetResponses, [bootstrapPath]: { ...mainnetResponses[bootstrapPath]!, body: JSON.stringify(tampered) } };
    const { pending } = start("mainnet", mainnet, responses);

    await expect(pending).rejects.toThrow();
  });

  it("refuses a pinned root that resolves to a different epoch than the configured checkpoint", async () => {
    at(mainnet.capturedAt);
    const served = fixtureFetch(BEACON, mainnetResponses);
    const pending = startVerifiedHeaderSource({
      network: "mainnet",
      checkpoint: { root: mainnet.checkpoint.root as `0x${string}`, epoch: mainnet.checkpoint.epoch + 1 },
      beaconUrl: BEACON,
      fetch: served.fetch,
      pollIntervalMs: 5,
      readyTimeoutMs: 1_500,
    });

    await expect(pending).rejects.toBeInstanceOf(StaleCheckpointError);
    expect(served.requested.length).toBeGreaterThan(0);
  });

  it("never returns a finalized header older than 30 minutes", async () => {
    at(mainnet.capturedAt);
    const { pending } = start("mainnet", mainnet, mainnetResponses);
    source = await pending;

    vi.setSystemTime(mainnet.capturedAt + 60 * MINUTE);

    expect(() => source!.finalized()).toThrow(StaleHeaderError);
  });

  it("does not become ready when no head update carries a valid sync-committee signature", async () => {
    at(mainnet.capturedAt);
    const forgeSignature = (path: string) => {
      const body = JSON.parse(mainnetResponses[path]!.body);
      const sig: string = body.data.sync_aggregate.sync_committee_signature;
      body.data.sync_aggregate.sync_committee_signature = sig.slice(0, -2) + (sig.endsWith("00") ? "01" : "00");
      return { ...mainnetResponses[path]!, body: JSON.stringify(body) };
    };
    const responses = {
      ...mainnetResponses,
      "/eth/v1/beacon/light_client/optimistic_update": forgeSignature("/eth/v1/beacon/light_client/optimistic_update"),
      "/eth/v1/beacon/light_client/finality_update": forgeSignature("/eth/v1/beacon/light_client/finality_update"),
    };
    const { pending } = start("mainnet", mainnet, responses);

    await expect(pending).rejects.toThrow();
  });

  it("retries a failed bootstrap on a fresh circuit and then succeeds", async () => {
    at(mainnet.capturedAt);
    const served = sequencedFetch({ [bootstrapPath]: [{ status: 503, body: "unavailable", headers: {} }, mainnetResponses[bootstrapPath]!] });
    const fetchForAttempt = vi.fn(() => served.fetch);
    const pending = startVerifiedHeaderSource({
      network: "mainnet",
      checkpoint: { root: mainnet.checkpoint.root as `0x${string}`, epoch: mainnet.checkpoint.epoch },
      beaconUrl: BEACON,
      fetch: served.fetch,
      fetchForAttempt,
      startupAttempts: 2,
      pollIntervalMs: 5,
      readyTimeoutMs: 1_500,
    });
    source = await pending;

    expect(fetchForAttempt).toHaveBeenCalledTimes(2);
    expect(source.finalized().blockNumber).toBe(EXPECTED.blockNumber);
  });

  it("moves startup to the second beacon endpoint after the first one fails", async () => {
    at(mainnet.capturedAt);
    const good = fixtureFetch(BEACON, mainnetResponses);
    const fetchForAttempt = (attempt: number) => (attempt < 3 ? (async () => new Response("unavailable", { status: 503 })) : good.fetch);
    const pending = startVerifiedHeaderSource({
      network: "mainnet",
      checkpoint: { root: mainnet.checkpoint.root as `0x${string}`, epoch: mainnet.checkpoint.epoch },
      beaconUrl: "https://bad-beacon.test",
      beaconUrls: [BEACON],
      fetch: good.fetch,
      fetchForAttempt,
      startupAttempts: 3,
      pollIntervalMs: 5,
      readyTimeoutMs: 1_500,
    });
    source = await pending;

    expect(source.finalized().blockNumber).toBe(EXPECTED.blockNumber);
  });

  it("reports an unusable startup as light-client-not-ready", async () => {
    at(mainnet.capturedAt);
    const pending = startVerifiedHeaderSource({
      network: "mainnet",
      checkpoint: { root: mainnet.checkpoint.root as `0x${string}`, epoch: mainnet.checkpoint.epoch },
      beaconUrl: BEACON,
      fetch: async () => new Response("unavailable", { status: 503 }),
      startupAttempts: 1,
      readyTimeoutMs: 0,
    });

    await expect(pending).rejects.toBeInstanceOf(HeaderSourceNotReadyError);
    await expect(pending).rejects.toThrow(/did not become ready/);
  });

  it("becomes ready on Hoodi with Hoodi configuration (control for the wrong-chain test)", async () => {
    at(hoodi.capturedAt);
    const { pending } = start("hoodi", hoodi, hoodi.responses as Record<string, RecordedResponse>);
    source = await pending;

    expect(source.finalized().blockNumber).toBeGreaterThan(0);
  });

  it("does not become ready on Hoodi data under mainnet configuration", async () => {
    at(hoodi.capturedAt);
    const { pending } = start("mainnet", hoodi, hoodi.responses as Record<string, RecordedResponse>);

    await expect(pending).rejects.toThrow();
  });
});
