import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnonTransport } from "../../src/transport/anon-transport.ts";
import { asFetch } from "../../src/transport/fetch-adapter.ts";
import { createJsonRpcSend } from "../../src/transport/json-rpc.ts";
import { readResponseBody } from "../../src/transport/response-body.ts";

afterEach(() => vi.useRealTimers());

function stream(chunks: string[] = [], close = false, cancel = vi.fn()) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (close) controller.close();
    },
    cancel,
  });
  return { response: new Response(body), cancel };
}

describe("bounded response bodies", () => {
  it("counts bytes across chunks and accepts a response exactly at the cap", async () => {
    const { response } = stream(["ab", "€"], true);
    const bytes = await readResponseBody(response, { timeoutMs: 100, maxBytes: 5 });
    expect(new TextDecoder().decode(bytes)).toBe("ab€");
    expect(response.body!.locked).toBe(false);
  });

  it("cancels an oversized stream before accepting the extra bytes", async () => {
    const { response, cancel } = stream(["abcd", "efghi"]);
    await expect(readResponseBody(response, { timeoutMs: 100, maxBytes: 8 })).rejects.toThrow("exceeded 8 bytes");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it("rejects a stalled body and cancels it even if cancellation never resolves", async () => {
    vi.useFakeTimers();
    const { response, cancel } = stream(["partial"], false, vi.fn(() => new Promise<void>(() => {})));
    const result = readResponseBody(response, { timeoutMs: 20, maxBytes: 100 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ message: expect.stringContaining("request deadline") });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  });

  it("cancels on caller abort and detaches the listener", async () => {
    const { response, cancel } = stream();
    const controller = new AbortController();
    const detach = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("caller stopped the read");
    const result = readResponseBody(response, { timeoutMs: 100, maxBytes: 100, signal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("also cancels when the signal was already aborted", async () => {
    const { response, cancel } = stream();
    await expect(readResponseBody(response, { timeoutMs: 100, maxBytes: 100, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("detaches the abort listener after success", async () => {
    const { response, cancel } = stream(["done"], true);
    const controller = new AbortController();
    const detach = vi.spyOn(controller.signal, "removeEventListener");
    await readResponseBody(response, { timeoutMs: 100, maxBytes: 100, signal: controller.signal });
    expect(detach).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe.each(["RPC", "beacon"] as const)("%s adapter", (kind) => {
  function read(transport: AnonTransport, options: { timeoutMs: number; maxBodyBytes: number }, signal?: AbortSignal) {
    return kind === "RPC"
      ? createJsonRpcSend(transport, "https://rpc.test", options)("eth_getProof", [], { isolationKey: "test", signal })
      : asFetch(transport, { ...options, isolationKey: "test" })("https://beacon.test", { signal });
  }

  it("uses the remaining request time for the body instead of starting a second deadline", async () => {
    vi.useFakeTimers();
    const { response, cancel } = stream();
    const transport = {
      fetch: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return response; },
    } as unknown as AnonTransport;
    const result = read(transport, { timeoutMs: 100, maxBodyBytes: 100 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await result).toMatchObject({ message: expect.stringContaining("request deadline") });
  });

  it("enforces the byte cap on untrusted response streams", async () => {
    const { response, cancel } = stream(["1234", "56789"]);
    const transport = { fetch: async () => response } as unknown as AnonTransport;
    await expect(read(transport, { timeoutMs: 100, maxBodyBytes: 8 })).rejects.toThrow("exceeded 8 bytes");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
