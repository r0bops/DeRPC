import { afterEach, describe, expect, it, vi } from "vitest";
import { startVerifiedHeaderSource, type VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import type { RecordedResponse } from "../helpers/fixture-fetch.ts";
import fixture from "../fixtures/mainnet-light-client.json" with { type: "json" };

const recorded = fixture.responses as Record<string, RecordedResponse>;
const checkpoint = { root: fixture.checkpoint.root as `0x${string}`, epoch: fixture.checkpoint.epoch };
const bootstrapPath = `/eth/v1/beacon/light_client/bootstrap/${checkpoint.root}`;
const expectedHash = JSON.parse(recorded[bootstrapPath]!.body).data.header.execution.block_hash;
const beacons = Array.from({ length: 5 }, (_, i) => `https://beacon-${i + 1}.example`);
let source: VerifiedHeaderSource | undefined;

afterEach(() => { source?.close(); source = undefined; vi.useRealTimers(); });

function fixtureClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fixture.capturedAt);
}

function response(path: string, invalidSignature = false): Response {
  const entry = recorded[path];
  if (!entry) return new Response("missing fixture", { status: 404 });
  const body = JSON.parse(entry.body);
  function corrupt(value: any) {
    if (!value || typeof value !== "object") return;
    if (value.sync_aggregate) {
      const signature: string = value.sync_aggregate.sync_committee_signature;
      value.sync_aggregate.sync_committee_signature = signature.slice(0, -2) + (signature.endsWith("00") ? "01" : "00");
    }
    for (const child of Object.values(value)) corrupt(child);
  }
  if (invalidSignature) corrupt(body);
  return new Response(JSON.stringify(body), { status: entry.status, headers: entry.headers });
}

describe("recorded BLS startup failover", () => {
  it("uses the healthy second beacon after a failed first bootstrap, with a new fetch attempt", async () => {
    fixtureClock();
    const requests: { attempt: number; origin: string; signal: AbortSignal }[] = [];
    source = await startVerifiedHeaderSource({
      network: "mainnet", checkpoint, beaconUrl: beacons[0]!, beaconUrls: [beacons[1]!],
      fetch: async () => { throw new Error("must use attempt fetch"); },
      fetchForAttempt: attempt => async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push({ attempt, origin: url.origin, signal: init!.signal! });
        if (url.origin === beacons[0]) return new Response("unavailable", { status: 503 });
        return response(url.pathname + url.search);
      },
      pollIntervalMs: 5, readyTimeoutMs: 1500,
    });
    expect(source.finalized().blockHash).toBe(expectedHash);
    expect([...new Set(requests.map(r => [r.attempt, r.origin].join("|")))]).toEqual([`1|${beacons[0]}`, `2|${beacons[1]}`]);
    expect(requests.filter(r => r.attempt === 1).every(r => r.signal.aborted)).toBe(true);
    expect(requests.filter(r => r.attempt === 2).some(r => !r.signal.aborted)).toBe(true);
    source.close();
    expect(requests.every(r => r.signal.aborted)).toBe(true);
  });

  it("reserves time for the second beacon after a valid bootstrap but forged update signatures", async () => {
    fixtureClock();
    const requests: { origin: string; path: string; signal: AbortSignal }[] = [];
    source = await startVerifiedHeaderSource({
      network: "mainnet", checkpoint, beaconUrl: beacons[0]!, beaconUrls: [beacons[1]!],
      fetch: async () => { throw new Error("must use attempt fetch"); },
      fetchForAttempt: () => async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        requests.push({ origin: url.origin, path: url.pathname, signal: init!.signal! });
        return response(url.pathname + url.search, url.origin === beacons[0]);
      },
      pollIntervalMs: 20, readyTimeoutMs: 1800,
    });
    expect(source.finalized().blockHash).toBe(expectedHash);
    expect(requests.some(r => r.origin === beacons[0] && r.path.endsWith("optimistic_update"))).toBe(true);
    expect(requests.some(r => r.origin === beacons[1] && r.path.endsWith("optimistic_update"))).toBe(true);
    expect(requests.filter(r => r.origin === beacons[0]).every(r => r.signal.aborted)).toBe(true);
    const oldCount = requests.filter(r => r.origin === beacons[0]).length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(requests.filter(r => r.origin === beacons[0])).toHaveLength(oldCount);
  });

  it("tries every configured beacon before repeating one, including beyond the old four-attempt cap", async () => {
    fixtureClock();
    const visited: string[] = [];
    const attempts: number[] = [];
    source = await startVerifiedHeaderSource({
      network: "mainnet", checkpoint, beaconUrl: beacons[0]!, beaconUrls: beacons.slice(1),
      fetch: async () => { throw new Error("must use attempt fetch"); },
      fetchForAttempt: attempt => {
        attempts.push(attempt);
        return async input => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === bootstrapPath) visited.push(url.origin);
          return url.origin === beacons[4] ? response(url.pathname + url.search) : new Response("unavailable", { status: 503 });
        };
      },
      pollIntervalMs: 5, readyTimeoutMs: 1500,
    });
    expect(source.finalized().blockHash).toBe(expectedHash);
    expect(visited).toEqual(beacons);
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
  });

  it("bounds unresponsive bootstrap fetches and aborts them even if the fetch ignores cancellation", async () => {
    fixtureClock();
    const signals: AbortSignal[] = [];
    const started = performance.now();
    const result = startVerifiedHeaderSource({
      network: "mainnet", checkpoint, beaconUrl: beacons[0]!, beaconUrls: [beacons[1]!],
      fetch: async (_input, init) => { signals.push(init!.signal!); return new Promise(() => {}); },
      readyTimeoutMs: 100, startupAttempts: 2,
    });
    await expect(result).rejects.toMatchObject({ name: "HeaderSourceNotReadyError" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("cancels an abandoned bootstrap without starting another beacon or accepting its late response", async () => {
    fixtureClock();
    const controller = new AbortController();
    let release!: (response: Response) => void;
    const signals: AbortSignal[] = [];
    const pending = startVerifiedHeaderSource({
      network: "mainnet", checkpoint, beaconUrl: beacons[0]!, beaconUrls: [beacons[1]!], signal: controller.signal,
      fetch: async (_input, init) => { signals.push(init!.signal!); return new Promise(resolve => { release = resolve; }); },
      readyTimeoutMs: 1000,
    });
    const stopped = expect(pending).rejects.toThrow("provider closed");
    controller.abort(new Error("provider closed"));
    await stopped;
    release(response(bootstrapPath));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });
});
