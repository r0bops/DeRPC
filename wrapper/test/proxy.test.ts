import { describe, expect, it, vi } from "vitest";
import { createProxy, type ProxyOptions } from "../src/proxy.ts";
import { serve } from "../src/server.ts";

const account = "0x" + "11".repeat(20);
const identity = { ens: "alice.derpc.eth", signer: account, chains: [1], version: "1", service: "demo-proxy" } as const;
const rpc = (method = "eth_getProof", params: unknown[] = [account, [], "0x10"], id: string | number = 1) => ({ jsonrpc: "2.0", method, params, id });
const request = (body: unknown) => new Request("http://wrapper/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup(extra: Partial<ProxyOptions> = {}) {
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    if (!init?.body) return Response.json({ data: { finalized_header: {} } });
    const call = JSON.parse(String(init.body));
    return Response.json({ jsonrpc: "2.0", id: call.id, result: call.method === "eth_getBlockByNumber" ? { number: "0x20" } : call.method === "eth_chainId" ? "0x1" : { accountProof: ["0xab"], storageProof: [] } });
  });
  const proxy = createProxy({ executionUrl: "http://127.0.0.1:8545", beaconUrl: "http://127.0.0.1:5052", identity: { ...identity, chains: [1] }, fetch: upstream, ...extra });
  return { proxy, upstream, methods: () => upstream.mock.calls.filter(([, init]) => init?.body).map(([, init]) => JSON.parse(String(init!.body)).method) };
}

describe("operator filtering proxy", () => {
  it("publishes each node's stable ID under a shared operator without changing legacy identity", async () => {
    for (const endpointId of ["a", "node-a", "a".repeat(31)]) {
      const configuredIdentity = { ...identity, chains: [1], endpointId };
      const { proxy, upstream } = setup({ identity: configuredIdentity });
      configuredIdentity.endpointId = "changed-after-start";
      const response = await proxy(new Request("http://wrapper/.well-known/derpc.json"));
      expect(await response.json()).toEqual({ ...identity, endpointId });
      expect(upstream).not.toHaveBeenCalled();
    }
    expect(await (await setup().proxy(new Request("http://wrapper/.well-known/derpc.json"))).json()).not.toHaveProperty("endpointId");
  });

  it.each(["", "UPPER", "two words", "-node", "node-", "node_id", "a".repeat(32), "é", null, 1])("refuses invalid node ID %j before serving", endpointId => {
    expect(() => setup({ identity: { ...identity, chains: [1], endpointId: endpointId as string } })).toThrow("DERPC_ENDPOINT_ID");
  });

  it("refuses payment admission on a wrapper with a plural endpoint identity", () => {
    const admit = vi.fn(async () => {});
    expect(() => setup({
      identity: { ...identity, chains: [1], endpointId: "node-a" },
      payments: { admit, voucher: async () => { throw new Error("not reached"); } },
    })).toThrow("free-only");
    expect(admit).not.toHaveBeenCalled();
  });

  it("rejects an entire mixed batch before touching the node", async () => {
    const { proxy, upstream } = setup();
    expect((await proxy(request([rpc(), rpc("eth_sendRawTransaction", ["0xdead"], 2)]))).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [rpc("eth_getProof", [account, ["0x1", "0x2"], "0x10"]), { storageKeys: 1 }],
    [[rpc(), rpc("eth_chainId", [], 2)], { batch: 1 }],
    [rpc("eth_getCode", [account, "latest"]), {}],
    [rpc("eth_getProof", [account, ["0xz"], "0x10"]), {}],
    [[rpc(), rpc()], {}],
    [{ jsonrpc: "2.0", method: "eth_chainId", params: [] }, {}],
  ])("rejects malformed or excessive parameters", async (body, limits) => {
    const { proxy, upstream } = setup({ limits });
    expect((await proxy(request(body))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("caps bodies even without a declared content length", async () => {
    const { proxy, upstream } = setup({ limits: { bodyBytes: 32 } });
    expect((await proxy(request(rpc()))).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("caches only finalized numbered requests and restores each caller's id", async () => {
    const { proxy, methods } = setup();
    expect((await (await proxy(request(rpc()))).json()).id).toBe(1);
    expect((await (await proxy(request(rpc("eth_getProof", [account, [], "0x10"], "second")))).json()).id).toBe("second");
    expect(methods().filter(m => m === "eth_getProof")).toHaveLength(1);
    expect((await proxy(request(rpc("eth_getProof", [account, [], "0x21"])))).status).toBe(400);
    expect(methods().filter(m => m === "eth_getProof")).toHaveLength(1);
    await proxy(request(rpc("eth_getCode", [account, "finalized"])));
    expect(methods()).toContain("eth_getCode");
  });

  it("bounds cache entries, upstream bodies and batch output", async () => {
    const { proxy, methods } = setup({ limits: { cacheEntries: 1 } });
    await proxy(request(rpc()));
    await proxy(request(rpc("eth_getProof", [account, ["0x1"], "0x10"])));
    await proxy(request(rpc()));
    expect(methods().filter(m => m === "eth_getProof")).toHaveLength(3);
    const huge = setup({ limits: { responseBytes: 40 } });
    expect((await huge.proxy(request(rpc()))).status).toBe(413);
  });

  it("serves only the four beacon routes with capped queries", async () => {
    const { proxy, upstream } = setup();
    for (const path of ["finality_update", "optimistic_update", `bootstrap/0x${"ab".repeat(32)}`, "updates?start_period=1&count=4"]) {
      expect((await proxy(new Request(`http://wrapper/eth/v1/beacon/light_client/${path}`))).status).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(4);
    for (const path of ["updates?start_period=1&count=5", "updates?start_period=1&count=1&count=2", "finality_update?foo=1", "bootstrap/0x11", "../../states/head"]) {
      expect((await proxy(new Request(`http://wrapper/eth/v1/beacon/light_client/${path}`))).ok).toBe(false);
    }
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("bounds concurrent work and deadlines, then releases capacity", async () => {
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const { upstream } = setup();
    const proxy = setup({ limits: { executionConcurrency: 1 }, fetch: async (...args) => { await pause; return upstream(...args); } }).proxy;
    const first = proxy(request(rpc()));
    expect((await proxy(request(rpc()))).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await proxy(request(rpc()))).status).toBe(200);
    const stalled = setup({ limits: { timeoutMs: 10 }, fetch: async () => new Response(new ReadableStream({ start() {} })) });
    expect((await stalled.proxy(request(rpc()))).status).toBe(504);
  });

  it("requires personal authorization on every route, hides identity, and keeps caches separate", async () => {
    const { proxy: pool, upstream, methods } = setup();
    const personal = setup({ fetch: upstream, personalToken: "a".repeat(64) }).proxy;
    await pool(request(rpc()));
    expect((await personal(request(rpc()))).status).toBe(401);
    const authenticated = request(rpc());
    authenticated.headers.set("authorization", `Bearer ${"a".repeat(64)}`);
    expect((await personal(authenticated)).status).toBe(200);
    expect(methods().filter(m => m === "eth_getProof")).toHaveLength(2);
    for (const [, init] of upstream.mock.calls) expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const identityRequest = new Request("http://wrapper/.well-known/derpc.json", { headers: { authorization: `Bearer ${"a".repeat(64)}` } });
    expect((await personal(identityRequest)).status).toBe(404);
    expect(await (await pool(new Request("http://wrapper/.well-known/derpc.json"))).json()).toEqual(identity);
  });

  it("runs behind the real loopback HTTP adapter", async () => {
    const { proxy } = setup();
    const server = serve(proxy, 0);
    await new Promise<void>(resolve => server.on("listening", resolve));
    const address = server.address() as { port: number; address: string };
    expect(address.address).toBe("127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rpc()) });
      expect(response.status).toBe(200);
      expect((await response.json()).result.accountProof).toEqual(["0xab"]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
