// The EIP-1193 request interface: what an integrator (or viem) sees. Every value it returns is proven;
// everything else is refused before anything is sent.
import { describe, expect, it } from "vitest";
import { createEip1193Provider, ProviderRpcError, type ReadBackend } from "../../src/api/eip1193.ts";
import { createPool, NoOperatorsChosenError } from "../../src/pool/pool.ts";
import { createPooledReader } from "../../src/pool/pooled-reader.ts";
import { TransportUnavailableError } from "../../src/transport/anon-transport.ts";
import type { VerifiedReader } from "../../src/verify/reader.ts";
import { BLOCK_TAG, RECORDED_HEADER, recordedEndpoint } from "../helpers/recorded-endpoint.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };

const { HOLDER, WETH, holderSlot } = fixture.inputs;
const hex = (v: bigint | number) => `0x${v.toString(16)}`;

function backend(opts: { tamper?: (method: string, result: any) => any } = {}) {
  const endpoint = recordedEndpoint(opts.tamper);
  const pool = createPool({ endpoints: [{ url: "https://operator.example", priority: 0 }], sendFor: () => endpoint.send });
  const headers = { finalized: () => RECORDED_HEADER };
  const reader = createPooledReader({ headers, pool });
  const b: ReadBackend = { chainId: 1, headers: async () => headers, reader: async () => reader };
  return { backend: b, calls: endpoint.calls };
}

/** A backend whose reads fail with `error`, as the DeRPC wiring would report it. */
function failingBackend(error: Error): ReadBackend {
  return { chainId: 1, headers: async () => ({ finalized: () => RECORDED_HEADER }), reader: async () => { throw error; } };
}

const untouchable: ReadBackend = {
  chainId: 1,
  headers: () => { throw new Error("headers must not be needed"); },
  reader: () => { throw new Error("reader must not be needed"); },
};

async function rpcError(promise: Promise<unknown>): Promise<ProviderRpcError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRpcError);
  return error as ProviderRpcError;
}

describe("createEip1193Provider", () => {
  it("answers chain id, network version and accounts locally, without any read", async () => {
    const { provider } = createEip1193Provider(untouchable);

    expect(await provider.request({ method: "eth_chainId" })).toBe("0x1");
    expect(await provider.request({ method: "net_version" })).toBe("1");
    expect(await provider.request({ method: "eth_accounts" })).toEqual([]);
  });

  it("returns a proven ETH balance as a hex quantity", async () => {
    const { backend: b, calls } = backend();
    const { provider } = createEip1193Provider(b);

    const balance = await provider.request({ method: "eth_getBalance", params: [WETH, "finalized"] });

    expect(balance).toBe(hex(BigInt(fixture.responses.wethWithSlots.balance)));
    expect(calls.map((c) => c.params[2])).toEqual([BLOCK_TAG]);
  });

  it("returns the proven nonce, code and storage word", async () => {
    const { provider } = createEip1193Provider(backend().backend);

    expect(await provider.request({ method: "eth_getTransactionCount", params: [HOLDER, "finalized"] })).toBe(hex(BigInt(fixture.reference.holderNonce)));
    expect(await provider.request({ method: "eth_getCode", params: [WETH, "finalized"] })).toBe(fixture.responses.wethCode);
    expect(await provider.request({ method: "eth_getStorageAt", params: [WETH, holderSlot, "finalized"] })).toBe(fixture.reference.holderWethBalanceOf);
  });

  it("reports the verified finalized block as the block number, without asking an operator", async () => {
    const { backend: b, calls } = backend();
    const { provider } = createEip1193Provider(b);

    expect(await provider.request({ method: "eth_blockNumber" })).toBe(BLOCK_TAG);
    expect(calls).toEqual([]);
  });

  it("accepts the verified block by number or by hash (EIP-1898) as well as by the finalized tag", async () => {
    const { provider } = createEip1193Provider(backend().backend);
    const expected = hex(BigInt(fixture.responses.wethWithSlots.balance));

    expect(await provider.request({ method: "eth_getBalance", params: [WETH, BLOCK_TAG] })).toBe(expected);
    expect(await provider.request({ method: "eth_getBalance", params: [WETH, { blockHash: fixture.block.hash }] })).toBe(expected);
    expect(await provider.request({ method: "eth_getBalance", params: [WETH, { blockNumber: BLOCK_TAG }] })).toBe(expected);
  });

  it.each(["latest", "safe", "pending", "earliest", "0x1"])("refuses block %s with invalid params, and sends nothing", async (block) => {
    const { backend: b, calls } = backend();
    const { provider } = createEip1193Provider(b);

    const error = await rpcError(provider.request({ method: "eth_getBalance", params: [WETH, block] }));

    expect(error.code).toBe(-32602);
    expect(error.message).toContain("finalized");
    expect(calls).toEqual([]);
  });

  it.each(["eth_call", "eth_getLogs", "eth_estimateGas", "eth_sendRawTransaction", "eth_getBlockByNumber", "eth_requestAccounts"])(
    "refuses %s as unsupported (4200) rather than forwarding an unproven answer",
    async (method) => {
      const { provider } = createEip1193Provider(untouchable);

      const error = await rpcError(provider.request({ method, params: [] }));

      expect(error.code).toBe(4200);
    },
  );

  it.each([["not an address", "0x1234"], ["no 0x prefix", WETH.slice(2)], ["not a string", 42]])("rejects %s with invalid params", async (_name, address) => {
    const { backend: b, calls } = backend();
    const { provider } = createEip1193Provider(b);

    const error = await rpcError(provider.request({ method: "eth_getBalance", params: [address, "finalized"] }));

    expect(error.code).toBe(-32602);
    expect(calls).toEqual([]);
  });

  it("never returns a lying operator's claim: the read fails instead", async () => {
    const { provider } = createEip1193Provider(backend({ tamper: (m, r) => (m === "eth_getProof" ? { ...r, balance: "0x1" } : r) }).backend);

    const error = await rpcError(provider.request({ method: "eth_getBalance", params: [WETH, "finalized"] }));

    expect(error.code).toBe(-32002);
    expect(error.data).toEqual({ reason: "PoolExhaustedError" });
  });

  it("reports a dead anonymous network as disconnected (4900)", async () => {
    const { provider } = createEip1193Provider(failingBackend(new TransportUnavailableError("anonymous transport is closed")));

    const error = await rpcError(provider.request({ method: "eth_getBalance", params: [WETH, "finalized"] }));

    expect(error.code).toBe(4900);
    expect(error.data).toEqual({ reason: "TransportUnavailableError" });
  });

  it("reports reads refused for safety (no operator chosen) as resource unavailable, with the reason", async () => {
    const { provider } = createEip1193Provider(failingBackend(new NoOperatorsChosenError()));

    const error = await rpcError(provider.request({ method: "eth_getBalance", params: [WETH, "finalized"] }));

    expect(error.code).toBe(-32002);
    expect(error.data).toEqual({ reason: "NoOperatorsChosenError" });
  });

  it("reports an unexpected failure as an internal error", async () => {
    const { provider } = createEip1193Provider(failingBackend(new Error("boom")));

    expect((await rpcError(provider.request({ method: "eth_getBalance", params: [WETH, "finalized"] }))).code).toBe(-32603);
  });

  it("refuses a value proven at a different block than the one asked for", async () => {
    // The verified block moves on between the request and the read.
    const { backend: b } = backend();
    const moved = { ...RECORDED_HEADER, blockNumber: RECORDED_HEADER.blockNumber + 1 };
    const reader = await b.reader();
    const racing: ReadBackend = {
      ...b,
      reader: async () => ({ ...reader, getBalance: async (a) => ({ ...(await reader.getBalance(a)), block: moved }) }) as VerifiedReader,
    };
    const { provider } = createEip1193Provider(racing);

    const error = await rpcError(provider.request({ method: "eth_getBalance", params: [WETH, BLOCK_TAG] }));

    expect(error.code).toBe(-32602);
  });

  it("delivers connect and disconnect events to listeners until they are removed", () => {
    const { provider, emit } = createEip1193Provider(untouchable);
    const seen: unknown[] = [];
    const listener = (info: unknown) => seen.push(info);

    provider.on("connect", listener);
    emit("connect", { chainId: "0x1" });
    provider.removeListener("connect", listener);
    emit("connect", { chainId: "0x1" });

    expect(seen).toEqual([{ chainId: "0x1" }]);
  });
});
