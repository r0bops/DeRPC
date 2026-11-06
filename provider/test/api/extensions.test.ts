import { describe, expect, it, vi } from "vitest";
import { createDeRPCWith, simulatedLyingOperator, type DeRPCOptions, type DeRPCPaymentClient, type DeRPCOperator } from "../../src/api/derpc.ts";
import { TOR_JS_PIN } from "../../src/config/mainnet.ts";
import type { AnonTransport, AnonFetchOptions } from "../../src/transport/anon-transport.ts";
import type { HeaderSourceOptions, VerifiedHeader, VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import { StaleHeaderError } from "../../src/light-client/header-source.ts";
import pinFixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };
import { createEip1193Provider } from "../../src/api/eip1193.ts";
import { PaymentClient, voucherTypedData } from "@derpc/payments";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

type Hex = `0x${string}`;
const ADDRESS = pinFixture.specifier as Hex;
const HEADER: VerifiedHeader = {
  slot: 0, blockNumber: pinFixture.block.number, blockHash: pinFixture.block.hash as Hex,
  stateRoot: pinFixture.block.stateRoot as Hex, timestamp: Math.floor(pinFixture.capturedAt / 1000),
};
const A: DeRPCOperator = { id: "a", url: "https://a.example/rpc", priority: 0 };
const B: DeRPCOperator = { id: "b", url: "https://b.example/rpc", priority: 1 };

function payments() {
  const committed: string[] = [], failed: string[] = [], started: { id: string; kind: string }[] = [];
  const client: DeRPCPaymentClient = {
    has: () => true,
    async begin(id, kind) {
      started.push({ id, kind });
      return {
        headers: () => ({ "x-derpc-read-id": `read-${started.length}`, "x-derpc-session": id }),
        verified: async () => { committed.push(id); }, failed: () => { failed.push(id); },
      };
    },
    latestVoucher: () => ({ sessionId: 1n, amount: 5n, signature: "0x01" }),
    prepareClose: async () => ({ voucher: { sessionId: 1n, amount: 5n, signature: "0x01" }, closeAuthorization: "0x02", closeDeadline: 123 }),
  };
  return { client, committed, failed, started };
}

function setup(options: DeRPCOptions = {}) {
  const requests: { url: string; options: AnonFetchOptions; body?: any }[] = [];
  let closed = false;
  let startHeaders!: HeaderSourceOptions;
  const transport: AnonTransport = {
    pin: TOR_JS_PIN, ready: Promise.resolve(), state: () => closed ? "closed" : "ready", close: () => { closed = true; },
    async fetch(url, options = {}) {
      if (closed) throw new Error("closed");
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ url, options, body });
      if (url.endsWith("/payments/voucher")) return Response.json({ highestAmount: body.amount, settlement: { state: "submitted", transactionHash: "0x1234" } });
      if (body?.method !== "eth_getProof" || body.params[0].toLowerCase() !== ADDRESS.toLowerCase()) throw new Error("no fixture");
      const proof = structuredClone(pinFixture.proof);
      if (!body.params[1].length) proof.storageProof = [];
      return Response.json({ jsonrpc: "2.0", id: body.id, result: proof });
    },
  };
  const headers: VerifiedHeaderSource = { finalized: () => HEADER, assertFresh: () => {}, close: () => {}, pollHealth: () => ({ consecutiveFailures: 0 }) };
  const derpc = createDeRPCWith({ startTransport: () => transport, startHeaders: async opts => { startHeaders = opts; return headers; } }, { operators: [A], ...options });
  return { derpc, requests, transport, headers, headerOptions: () => startHeaders };
}

describe("provider extensions", () => {
  it("refuses an expired listing at selection and stops new reads when a selected listing expires", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { derpc, requests } = setup({ operators: [{ ...A, expiry: 1001 }] });
    try {
      expect(() => derpc.setOperators([{ ...B, expiry: 999 }])).toThrow("operator listing expired");
      expect(() => derpc.setOperators([{ ...B, expiry: Number.NaN }])).toThrow("invalid operator listing expiry");
      await derpc.reader.getBalance(ADDRESS);
      const before = requests.length;
      clock.mockReturnValue(1_001_000);
      await expect(derpc.reader.getTransactionCount(ADDRESS)).rejects.toThrow("excluded or expired");
      expect(requests).toHaveLength(before);
      expect(derpc.status().operators[0]!.state).toBe("expired");
    } finally { derpc.close(); clock.mockRestore(); }
  });

  it("does not send a proof if the listing expires while its identity document is loading", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const operator = { ...A, ens: "alice.derpc.eth", expiry: 1001, wrapperIdentity: { signer: ADDRESS } };
    const { derpc, requests, transport } = setup({ operators: [operator] });
    const original = transport.fetch;
    const identities: string[] = [];
    transport.fetch = async (url, options) => {
      if (!url.endsWith("/.well-known/derpc.json")) return original(url, options);
      identities.push(url);
      await Promise.resolve();
      clock.mockReturnValue(1_001_000);
      return Response.json({ version: "1", ens: operator.ens, signer: ADDRESS, chains: [1], service: "node" });
    };
    try {
      await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow();
      expect(identities).toHaveLength(1);
      expect(requests).toEqual([]);
      expect(derpc.status().operators[0]!.state).toBe("expired");
    } finally { derpc.close(); clock.mockRestore(); }
  });

  it("can retain and settle an expired listing's existing session without selecting it", async () => {
    const p = payments();
    const { derpc, requests } = setup({ payments: p.client, operators: [] });
    try {
      derpc.registerPaymentOperator({ ...A, expiry: Math.floor(Date.now() / 1000) - 1 });
      await derpc.settlePayment("a", { close: true });
      expect(derpc.status().operators).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("https://a.example/payments/voucher");
    } finally { derpc.close(); }
  });

  it("keeps bootstrap free, signs after valid proof, and does not pay cached answers", async () => {
    const p = payments();
    const { derpc, requests } = setup({ payments: p.client });
    await derpc.reader.getBalance(ADDRESS);
    await derpc.reader.getBalance(ADDRESS);
    expect(p.started).toEqual([{ id: "a", kind: "proof" }]);
    expect(p.committed).toEqual(["a"]);
    expect(requests[0]!.options.headers?.["x-derpc-session"]).toBeUndefined();
    expect(requests[1]!.options.headers?.["x-derpc-session"]).toBe("a");
    derpc.close();
  });

  it("does not sign for corrupted proofs and pays only the successful failover operator", async () => {
    const p = payments();
    const { derpc } = setup({ payments: p.client });
    await derpc.reader.getBalance(ADDRESS); // finish the initial pin check before injecting corruption
    p.started.length = p.committed.length = 0;
    derpc.setOperators([simulatedLyingOperator(A), B]);
    expect((await derpc.reader.getTransactionCount(ADDRESS)).value).toBe(1n);
    expect(p.started.map(s => s.id)).toEqual(["a", "b"]);
    expect(p.committed).toEqual(["b"]);
    expect(p.failed).toEqual(["a"]);
    expect(derpc.status().operators[0]!.state).toBe("excluded");
    derpc.close();
  });

  it("advances the real session voucher only after verified results and preserves its signed domain", async () => {
    const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const client = new PaymentClient();
    const domain = { chainId: 31337, escrow: `0x${"22".repeat(20)}` as Hex };
    for (const [id, sessionId] of [["a", 1n], ["b", 2n]] as const) client.addSession({
      ...domain, operatorId: id, sessionId, payer: signer.address, payee: ADDRESS, signer,
      deposit: 100n, price: 5n, refundAfter: Math.floor(Date.now() / 1000) + 3600,
    });
    const { derpc, requests } = setup({ payments: client });
    await derpc.reader.getBalance(ADDRESS);
    await derpc.reader.getBalance(ADDRESS); // cache is free
    const first = client.latestVoucher("a")!;
    expect(first.amount).toBe(5n);
    expect(await recoverTypedDataAddress({ ...voucherTypedData(domain, 1n, 5n), signature: first.signature })).toBe(signer.address);
    derpc.setOperators([simulatedLyingOperator(A), B]);
    await derpc.reader.getTransactionCount(ADDRESS);
    expect(client.snapshot().map(s => [s.operatorId, s.total, s.inFlight])).toEqual([["a", 5n, 0], ["b", 5n, 0]]);
    expect(JSON.parse(requests[2]!.options.headers!["x-derpc-voucher"]!)).toEqual({ amount: "5", signature: first.signature });
    expect(requests[2]!.options.headers!["x-derpc-read-kind"]).toBe("proof");
    expect(requests[3]!.options.headers!["x-derpc-voucher"]).toBeUndefined();
    derpc.close();
  });

  it("rejects stale complete proofs without signing a voucher", async () => {
    const p = payments();
    const { derpc, headers, requests } = setup({ payments: p.client });
    // Finish pin bootstrap before making the user result stale at its final freshness check.
    await derpc.reader.getBalance(ADDRESS);
    p.committed.length = 0;
    headers.assertFresh = () => {
      if (requests.length > 2) throw new StaleHeaderError("stale result");
    };
    await expect(derpc.reader.getTransactionCount(ADDRESS)).rejects.toThrow("stale result");
    expect(p.committed).toEqual([]);
    expect(p.failed).toEqual(["a"]);
    derpc.close();
  });

  it("retains one real voucher when freshness expires during signing and never retries payment", async () => {
    const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const client = new PaymentClient();
    for (const [id, sessionId] of [["a", 1n], ["b", 2n]] as const) client.addSession({
      chainId: 31337, escrow: `0x${"22".repeat(20)}`, operatorId: id, sessionId,
      payer: signer.address, payee: ADDRESS, signer, deposit: 100n, price: 5n,
      refundAfter: Math.floor(Date.now() / 1000) + 3600,
    });
    let stale = false;
    const begin = client.begin.bind(client);
    const started = vi.spyOn(client, "begin").mockImplementation(async (...args) => {
      const attempt = await begin(...args);
      return { ...attempt, verified: async signal => {
        const voucher = await attempt.verified(signal);
        stale = true;
        return voucher;
      } };
    });
    const { derpc, headers, requests } = setup({ payments: client, operators: [A, B] });
    headers.assertFresh = () => { if (stale) throw new StaleHeaderError("header expired during signing"); };
    try {
      await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("header expired during signing");
      expect(started).toHaveBeenCalledOnce();
      expect(client.snapshot().map(s => [s.operatorId, s.total, s.inFlight])).toEqual([["a", 5n, 0], ["b", 0n, 0]]);
      expect(client.latestVoucher("a")!.amount).toBe(5n);
      expect(client.latestVoucher("b")).toBeUndefined();
      expect(requests.map(request => request.url)).toEqual([A.url, A.url]);
    } finally { derpc.close(); started.mockRestore(); }
  });

  it("does not turn throwing app observers into paid retries", async () => {
    const p = payments();
    const fail = () => { throw new Error("app observer failed"); };
    const { derpc } = setup({ payments: p.client, onStatus: fail, onPoolEvent: fail });
    expect((await derpc.reader.getBalance(ADDRESS)).value).toBe(0n);
    expect(p.committed).toEqual(["a"]);
    derpc.close();
  });

  it("refuses an advertised paid operator without a funded session before a user request", async () => {
    const { derpc, requests } = setup({ operators: [{ ...A, payment: {
      price: 1n, payee: ADDRESS, escrow: ADDRESS, chainId: 560048, payeeProven: false, recordsProven: false,
    } }] });
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow();
    expect(requests).toHaveLength(1); // only the narrowly free worker-pin proof
    derpc.close();
  });

  it("delivers the final voucher through the worker after the operator is deselected", async () => {
    const p = payments();
    const { derpc, requests } = setup({ payments: p.client });
    await derpc.reader.getBalance(ADDRESS);
    derpc.setOperators([]);
    expect((await derpc.settlePayment("a", { close: true })).settlement?.state).toBe("submitted");
    const final = requests.at(-1)!;
    expect(final.url).toBe("https://a.example/payments/voucher");
    expect(final.options.redirect).toBe("error");
    expect(final.body).toMatchObject({ amount: "5", close: true, closeAuthorization: "0x02", closeDeadline: 123 });
    derpc.close();
  });

  it("remembers a confirmed session for settlement without selecting it for reads", async () => {
    const p = payments();
    const { derpc } = setup({ payments: p.client, operators: [] });
    derpc.registerPaymentOperator(B);
    expect(derpc.status().operators).toEqual([]);
    expect((await derpc.settlePayment("b", { close: true })).highestAmount).toBe("5");
    expect(() => derpc.registerPaymentOperator({ ...B, url: "https://changed.example" })).toThrow("already pinned");
    derpc.close();
  });

  it("allows a new funded session to pin the operator's rotated endpoint", async () => {
    const p = payments();
    let sessionId = 1n;
    p.client.snapshot = () => [{ operatorId: "a", sessionId, chainId: 31337, escrow: ADDRESS }];
    p.client.latestVoucher = () => ({ sessionId, amount: 5n, signature: "0x01" });
    const { derpc, requests } = setup({ payments: p.client });
    const rotated = { ...A, url: "https://rotated.example/rpc" };
    expect(() => derpc.registerPaymentOperator(rotated)).toThrow("already pinned");
    sessionId = 2n; // a new confirmed deposit, after the prior session was removed
    derpc.registerPaymentOperator(rotated);
    await derpc.settlePayment("a");
    expect(requests.find(r => r.url.endsWith("/payments/voucher"))?.url).toBe("https://rotated.example/payments/voucher");
    derpc.close();
  });

  it("passes every operator beacon endpoint and a fresh circuit for startup attempts", async () => {
    const { derpc, headerOptions, requests } = setup({ operators: [{ ...A, beaconUrl: "https://a.example" }, { ...B, beaconUrl: "https://b.example" }] });
    await derpc.ready;
    expect(headerOptions().beaconUrl).toBe("https://a.example");
    expect(headerOptions().beaconUrls).toEqual(["https://b.example"]);
    expect(headerOptions().fetchForAttempt).toBeTypeOf("function");
    const beaconRequest = "https://a.example/eth/v1/beacon/genesis";
    await headerOptions().fetchForAttempt!(1)(beaconRequest).catch(() => {});
    await headerOptions().fetchForAttempt!(2)(beaconRequest).catch(() => {});
    expect(requests.filter(r => r.url === beaconRequest).map(r => r.options.isolationKey)).toEqual(["derpc:consensus:1", "derpc:consensus:2"]);
    derpc.close();
  });

  it("revokes removed personal credentials and uses only the replacement token for the same operator", async () => {
    const origin = "http://aeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaea37ead.onion";
    const oldToken = "11".repeat(32), newToken = "22".repeat(32);
    const personal = { id: "personal", url: `${origin}/rpc`, beaconUrl: origin, personalToken: oldToken, priority: 0 };
    const p = payments();
    const { derpc, requests, headerOptions } = setup({ operators: [personal], payments: p.client });
    await derpc.reader.getBalance(ADDRESS);
    expect(requests.at(-1)!.options.headers?.authorization).toBe(`Bearer ${oldToken}`);
    expect(p.started).toEqual([]); // own nodes never create payment attempts

    derpc.setOperators([]);
    const afterRemoval = requests.length;
    await expect(derpc.reader.getBalance(ADDRESS)).rejects.toThrow("no operators chosen");
    await expect(derpc.settlePayment("personal")).rejects.toThrow("no known paid endpoint");
    expect(requests).toHaveLength(afterRemoval);
    // Existing consensus fetch closures must also consult the current credential set.
    await headerOptions().fetch(`${origin}/eth/v1/beacon/light_client/optimistic_update`).catch(() => {});
    expect(requests.at(-1)!.options.headers?.authorization).toBeUndefined();

    derpc.setOperators([{ ...personal, personalToken: newToken }]);
    await derpc.reader.getTransactionCount(ADDRESS);
    expect(requests.at(-1)!.options.headers?.authorization).toBe(`Bearer ${newToken}`);
    await headerOptions().fetch(`${origin}/eth/v1/beacon/light_client/optimistic_update`).catch(() => {});
    expect(requests.at(-1)!.options.headers?.authorization).toBe(`Bearer ${newToken}`);
    expect(requests.slice(afterRemoval).some(r => r.options.headers?.authorization === `Bearer ${oldToken}`)).toBe(false);
    expect(JSON.stringify(derpc.status())).not.toContain(newToken);
    derpc.close();
    expect(headerOptions().signal?.aborted).toBe(true);
  });

  it("keeps default raw eth_call refused even when the explicit verified API is enabled", async () => {
    const { derpc, requests } = setup({ verifiedCalls: true, operators: [] });
    await expect(derpc.provider.request({ method: "eth_call", params: [{ to: ADDRESS }, "finalized"] })).rejects.toMatchObject({ code: 4200 });
    expect(requests).toHaveLength(0);
    derpc.close();
  });

  it("rejects malformed explicit calls before requesting execution state", async () => {
    const { derpc, requests } = setup({ verifiedCalls: true, operators: [] });
    for (const input of [null, [], { to: ADDRESS, value: 1n }, { to: ADDRESS, stateOverrides: {} }]) {
      await expect(derpc.verifiedCall(input as never)).rejects.toMatchObject({ name: "InputError" });
    }
    expect(requests).toHaveLength(0);
    derpc.close();
  });

  it("close cancels startup and subsequent block requests instead of waiting indefinitely", async () => {
    const derpc = createDeRPCWith({
      startTransport: () => ({ pin: TOR_JS_PIN, ready: new Promise(() => {}), state: () => "booting", fetch: async () => { throw new Error("unused"); }, close: () => {} }),
      startHeaders: async () => { throw new Error("must not run"); },
    });
    const ready = expect(derpc.ready).rejects.toThrow("closed");
    derpc.close();
    await ready;
    await expect(derpc.provider.request({ method: "eth_blockNumber" })).rejects.toMatchObject({ code: 4900 });
  });
});

describe("explicit EIP-1193 local execution", () => {
  it("validates block, call shape and result block without sending a raw call", async () => {
    const execute = vi.fn(async () => ({ value: "0xab" as Hex, block: HEADER }));
    const { provider } = createEip1193Provider({
      chainId: 1, headers: async () => ({ finalized: () => HEADER }), reader: async () => { throw new Error("not used"); }, verifiedCall: execute,
    });
    expect(await provider.request({ method: "eth_call", params: [{ to: ADDRESS, data: "0x1234", gas: "0x186a0" }, "finalized"] })).toBe("0xab");
    expect(execute).toHaveBeenCalledWith({ to: ADDRESS, data: "0x1234", from: undefined, gas: 100000n });
    for (const params of [[{ to: ADDRESS }, "latest"], [{ to: ADDRESS, value: "0x1" }, "finalized"], [{ to: ADDRESS }, "finalized", {}]]) {
      await expect(provider.request({ method: "eth_call", params })).rejects.toMatchObject({ code: -32602 });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
