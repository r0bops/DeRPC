// The light client expects a standard fetch(input, init). The adapter must turn every such call into
// an anonymized transport call: same URL, method, headers, body and cancellation, under the given
// isolation key. It must never reach the network any other way.
import { describe, expect, it } from "vitest";
import { asFetch } from "../../src/transport/fetch-adapter.ts";
import type { AnonFetchOptions, AnonTransport } from "../../src/transport/anon-transport.ts";

function recordingTransport() {
  const calls: { url: string; options: AnonFetchOptions }[] = [];
  const transport = {
    fetch: async (url: string, options: AnonFetchOptions = {}) => {
      calls.push({ url, options });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as AnonTransport;
  return { transport, calls };
}

describe("asFetch", () => {
  it("forwards a GET with headers under the isolation key", async () => {
    const { transport, calls } = recordingTransport();
    const fetchFn = asFetch(transport, { isolationKey: "derpc:consensus" });

    await fetchFn("https://beacon.test/eth/v1/beacon/light_client/optimistic_update", {
      headers: new Headers({ accept: "application/json" }),
    });

    expect(calls).toEqual([
      {
        url: "https://beacon.test/eth/v1/beacon/light_client/optimistic_update",
        options: expect.objectContaining({ method: "GET", headers: { accept: "application/json" }, isolationKey: "derpc:consensus" }),
      },
    ]);
  });

  it("forwards a POST body and the caller's abort signal", async () => {
    const { transport, calls } = recordingTransport();
    const fetchFn = asFetch(transport, { isolationKey: "k" });
    const controller = new AbortController();

    await fetchFn(new Request("https://rpc.test/", { method: "POST", body: '{"id":1}', headers: { "content-type": "application/json" } }), {
      signal: controller.signal,
    });

    expect(calls[0]!.options.method).toBe("POST");
    expect(calls[0]!.options.body).toBe('{"id":1}');
    expect(calls[0]!.options.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]!.options.signal).toBe(controller.signal);
  });

  it("returns the transport's response unchanged", async () => {
    const { transport } = recordingTransport();
    const res = await asFetch(transport, { isolationKey: "k" })("https://beacon.test/x");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
