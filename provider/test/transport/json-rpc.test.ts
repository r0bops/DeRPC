import { describe, expect, it } from "vitest";
import { createJsonRpcSend } from "../../src/transport/json-rpc.ts";
import type { AnonFetchOptions, AnonTransport } from "../../src/transport/anon-transport.ts";

function transportAnswering(status: number, body: string) {
  const calls: { url: string; options: AnonFetchOptions }[] = [];
  const transport = {
    fetch: async (url: string, options: AnonFetchOptions = {}) => {
      calls.push({ url, options });
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    },
  } as unknown as AnonTransport;
  return { transport, calls };
}

describe("createJsonRpcSend", () => {
  it("POSTs a JSON-RPC request to the endpoint through the transport, under the given isolation key", async () => {
    const { transport, calls } = transportAnswering(200, '{"jsonrpc":"2.0","id":1,"result":"0x2a"}');
    const send = createJsonRpcSend(transport, "https://rpc.test/");

    const result = await send("eth_blockNumber", [], { isolationKey: "derpc:account:0xabc" });

    expect(result).toBe("0x2a");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://rpc.test/");
    expect(calls[0]!.options).toMatchObject({ method: "POST", isolationKey: "derpc:account:0xabc", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(calls[0]!.options.body))).toMatchObject({ jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
  });

  it("throws the endpoint's JSON-RPC error instead of returning a result", async () => {
    const { transport } = transportAnswering(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"distance to target block exceeds maximum proof window"}}');

    await expect(createJsonRpcSend(transport, "https://rpc.test/")("eth_getProof", [], { isolationKey: "k" })).rejects.toThrow(
      "distance to target block exceeds maximum proof window",
    );
  });

  it("throws on an HTTP error status", async () => {
    const { transport } = transportAnswering(429, "rate limited");

    await expect(createJsonRpcSend(transport, "https://rpc.test/")("eth_getProof", [], { isolationKey: "k" })).rejects.toThrow("429");
  });
});
