import { describe, expect, it, vi } from "vitest";
import { createDeRPCWith, type DeRPCOperator, type DeRPCOptions, type DeRPCPaymentClient } from "../../src/api/derpc.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import { MAINNET_ENS_UNIVERSAL_RESOLVER_V2 } from "../../src/execution/verified-ens.ts";
import type { HeaderSourceOptions, VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import type { AnonFetchOptions, AnonTransport } from "../../src/transport/anon-transport.ts";
import type { AccountProof, Hex } from "../../src/verify/index.ts";
import { IMPLEMENTATION, provenFixture, TARGET } from "../execution/proven-fixture.ts";

const OPERATOR: DeRPCOperator = { id: "resolver-node", url: "https://resolver.example/rpc", priority: 0 };
// Original bytecode returns ABI (bytes(address at slot 0), resolver), matching UniversalResolverV2.
const UNIVERSAL_CODE: Hex = `0x604060005273${IMPLEMENTATION.slice(2)}602052602060405260005460605260806000f3`;

async function setup(options: { verifiedCalls?: DeRPCOptions["verifiedCalls"]; deferHeaders?: boolean; corruptStorage?: boolean; operators?: DeRPCOptions["operators"] } = {}) {
  const fixture = await provenFixture([
    { address: TOR_JS_PIN.specifier, storage: { 1: BigInt(TOR_JS_PIN.workerHash) } },
    { address: MAINNET_ENS_UNIVERSAL_RESOLVER_V2, code: UNIVERSAL_CODE, storage: { 0: BigInt(TARGET) } },
  ]);
  const verified = vi.fn(async (_signal?: AbortSignal) => {});
  const failed = vi.fn();
  const begin = vi.fn(async (_operator: string, _kind: "proof" | "code" | "call") => ({
    headers: () => ({ "x-derpc-session": "fixture-session" }), verified, failed,
  }));
  const payments: DeRPCPaymentClient = {
    has: () => true, begin,
    latestVoucher: () => undefined,
    prepareClose: async () => { throw new Error("resolution must not settle a session"); },
  };
  const endpoint = fixture.endpoint((request, response) => {
    if (options.corruptStorage && request.method === "eth_getProof" &&
        (request.params[0] as string).toLowerCase() === MAINNET_ENS_UNIVERSAL_RESOLVER_V2 &&
        (request.params[1] as Hex[]).length) {
      (response as AccountProof).storageProof[0]!.value = "0x01";
    }
    return response;
  });
  const requests: { url: string; options: AnonFetchOptions; method: string; params: unknown[] }[] = [];
  let closed = false;
  const transport: AnonTransport = {
    pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => closed ? "closed" : "ready",
    close: () => { closed = true; },
    async fetch(url, options = {}) {
      if (closed) throw new Error("fixture transport closed");
      if (url !== OPERATOR.url) throw new Error("unexpected fixture destination");
      const body = JSON.parse(String(options.body));
      requests.push({ url, options, method: body.method, params: body.params });
      const result = await endpoint(body.method, body.params, { isolationKey: options.isolationKey ?? "", signal: options.signal });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  };
  const headers: VerifiedHeaderSource = {
    ...fixture.headers, assertFresh: vi.fn(), close: vi.fn(), pollHealth: () => ({ consecutiveFailures: 0 }),
  };
  const pendingHeaders = Promise.withResolvers<VerifiedHeaderSource>();
  const startHeaders = vi.fn(async (_options: HeaderSourceOptions) => options.deferHeaders ? pendingHeaders.promise : headers);
  const onPoolEvent = vi.fn();
  const derpc = createDeRPCWith({ startTransport: () => transport, startHeaders }, {
    operators: options.operators ?? [OPERATOR], verifiedCalls: options.verifiedCalls, payments, onPoolEvent,
  });
  return { derpc, fixture, headers, requests, begin, verified, failed, startHeaders, onPoolEvent, releaseHeaders: () => pendingHeaders.resolve(headers) };
}

describe("public verified ENS resolution", () => {
  it("requires explicit verifiedCalls opt-in before making a resolution request", async () => {
    const { derpc, requests, begin } = await setup({ operators: [] });
    try {
      await expect(derpc.resolveEns({ name: "example.eth" })).rejects.toMatchObject({ code: 4200 });
      expect(requests).toEqual([]);
      expect(begin).not.toHaveBeenCalled();
    } finally { derpc.close(); }
  });

  it("returns a normalized record and its proven block through one paid local execution", async () => {
    const { derpc, fixture, requests, begin, verified, failed } = await setup({ verifiedCalls: true });
    try {
      const result = await derpc.resolveEns({ name: "Example.ETH" });
      expect(result).toEqual({
        normalizedName: "example.eth", record: { type: "address" },
        resolver: IMPLEMENTATION, value: TARGET, block: fixture.block,
      });
      expect(requests.every(request => request.url === OPERATOR.url && ["eth_getProof", "eth_getCode"].includes(request.method))).toBe(true);
      expect(requests.every(request => request.params.at(-1) === `0x${fixture.block.blockNumber.toString(16)}`)).toBe(true);
      expect(requests.some(request => request.method === "eth_getProof" &&
        request.params[0] === MAINNET_ENS_UNIVERSAL_RESOLVER_V2 && (request.params[1] as Hex[]).length === 1)).toBe(true);
      expect(begin).toHaveBeenCalledOnce();
      expect(begin.mock.calls[0]!.slice(0, 2)).toEqual([OPERATOR.id, "call"]);
      expect(verified).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
      expect(requests[0]!.params[0]).toBe(TOR_JS_PIN.specifier);
      expect(requests[0]!.options.headers?.["x-derpc-session"]).toBeUndefined();
      expect(requests.slice(1).every(request => request.options.headers?.["x-derpc-session"] === "fixture-session")).toBe(true);
    } finally { derpc.close(); }
  });

  it("refuses a forged ENS storage claim without authorizing payment", async () => {
    const { derpc, begin, verified, failed } = await setup({ verifiedCalls: true, corruptStorage: true });
    try {
      await expect(derpc.resolveEns({ name: "example.eth" })).rejects.toThrow();
      expect(begin).toHaveBeenCalledOnce();
      expect(verified).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(derpc.status().operators[0]!.state).toBe("excluded");
    } finally { derpc.close(); }
  });

  it("applies the caller's ENS limits before reserving payment or executing resolver code", async () => {
    const { derpc, requests, begin } = await setup({ verifiedCalls: true });
    try {
      await expect(derpc.resolveEns({ name: "example.eth", limits: { nameBytes: 3 } })).rejects.toMatchObject({ name: "ExecutionLimitError" });
      expect(begin).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.params[0]).toBe(TOR_JS_PIN.specifier);
    } finally { derpc.close(); }
  });

  it("aborts deferred payment completion at the ENS deadline without recording success or retrying", async () => {
    const { derpc, requests, begin, verified, failed, onPoolEvent } = await setup({ verifiedCalls: true });
    const completionEntered = Promise.withResolvers<AbortSignal | undefined>();
    const completion = Promise.withResolvers<void>();
    verified.mockImplementation(async signal => {
      completionEntered.resolve(signal);
      await completion.promise; // Deliberately noncooperative payment completion.
    });
    try {
      await derpc.ready;
      await vi.waitFor(() => expect(derpc.status().pin.state).toBe("verified"));
      const observations = structuredClone(derpc.status().operators[0]!.observations);
      onPoolEvent.mockClear();

      const pending = derpc.resolveEns({ name: "example.eth", limits: { timeoutMs: 1000 } });
      const rejected = expect(pending).rejects.toMatchObject({ name: "ExecutionLimitError", message: "verified ENS resolution deadline exceeded" });
      const completionSignal = await completionEntered.promise;
      expect(completionSignal).toBeInstanceOf(AbortSignal);
      expect(completionSignal!.aborted).toBe(false);
      const requestCount = requests.length;

      await rejected;
      expect(completionSignal!.aborted).toBe(true);
      expect(completionSignal!.reason).toMatchObject({ name: "ExecutionLimitError" });
      await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
      expect(begin).toHaveBeenCalledOnce();
      expect(verified).toHaveBeenCalledOnce();
      expect(onPoolEvent.mock.calls.filter(([event]) => event.type === "attempt")).toHaveLength(1);
      expect(onPoolEvent.mock.calls.some(([event]) => event.type === "success")).toBe(false);
      expect(derpc.status().operators[0]!.observations).toEqual(observations);

      completion.resolve();
      await new Promise(resolve => setTimeout(resolve, 0)); // Let the late completion continuation run.
      expect(requests).toHaveLength(requestCount);
      expect(begin).toHaveBeenCalledOnce();
      expect(failed).toHaveBeenCalledOnce();
      expect(onPoolEvent.mock.calls.some(([event]) => event.type === "success")).toBe(false);
      expect(derpc.status().operators[0]!.observations).toEqual(observations);
    } finally { completion.resolve(); derpc.close(); }
  });

  it("cancels during header startup and never resumes resolution or payment after headers arrive", async () => {
    const { derpc, headers, requests, begin, verified, failed, startHeaders, releaseHeaders } = await setup({ verifiedCalls: true, deferHeaders: true });
    const controller = new AbortController();
    const reason = new Error("user cancelled ENS lookup");
    try {
      const pending = derpc.resolveEns({ name: "example.eth", signal: controller.signal });
      const rejected = expect(pending).rejects.toBe(reason);
      await vi.waitFor(() => expect(startHeaders).toHaveBeenCalledOnce());
      await vi.dynamicImportSettled(); // The public call has reached the unresolved header wait.
      controller.abort(reason);
      await rejected; // Cancellation must settle while the header source is still unresolved.
      expect(requests).toEqual([]);
      expect(begin).not.toHaveBeenCalled();

      releaseHeaders();
      await derpc.ready;
      await vi.waitFor(() => expect(derpc.status().pin.state).toBe("verified"));
      // Independent startup may prove the worker pin, but the cancelled lookup never enters a pool read.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.params[0]).toBe(TOR_JS_PIN.specifier);
      expect(begin).not.toHaveBeenCalled();
      expect(verified).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect(headers.close).not.toHaveBeenCalled(); // A caller's abort does not kill the shared provider.
    } finally { derpc.close(); releaseHeaders(); }
  });
});
