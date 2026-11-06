// The DeRPC wiring: worker → light client → the user's operators → worker-pin check → reads.
// The worker and light client are fakes; proofs and the worker pin are real mainnet recordings.
import { describe, expect, it } from "vitest";
import { createDeRPCWith, simulatedLyingOperator, type DeRPCOperator, type DeRPCStatus } from "../../src/api/derpc.ts";
import { ProviderRpcError } from "../../src/api/eip1193.ts";
import { TOR_JS_PIN, type WorkerPin } from "../../src/config/mainnet.ts";
import { StaleCheckpointError, type VerifiedHeader, type VerifiedHeaderSource } from "../../src/light-client/header-source.ts";
import { TransportUnavailableError, type AnonTransport, type StartOptions, type TransportState } from "../../src/transport/anon-transport.ts";
import fixture from "../fixtures/mainnet-worker-pin.json" with { type: "json" };

type Hex = `0x${string}`;
const SPECIFIER = fixture.specifier as Hex;
const TAG = "0x" + fixture.block.number.toString(16);
const HEADER: VerifiedHeader = {
  slot: 0,
  blockNumber: fixture.block.number,
  blockHash: fixture.block.hash as Hex,
  stateRoot: fixture.block.stateRoot as Hex,
  timestamp: Math.floor(fixture.capturedAt / 1000),
};
const A: DeRPCOperator = { url: "https://a.example", priority: 0, ens: "a.derpc.eth" };
const B: DeRPCOperator = { url: "https://b.example", priority: 0, ens: "b.derpc.eth" };
const balanceOfSpecifier = { method: "eth_getBalance", params: [SPECIFIER, "finalized"] };

/**
 * A worker that answers the recorded specifier proofs (slot 1, or no slots) at the recorded block.
 * Like the real transport, it reports "booting" before it returns.
 */
function fakeTransport(start: StartOptions, opts: { bootError?: Error; pinGate?: Promise<void> } = {}) {
  let state: TransportState = "booting";
  const sent: { url: string; method: string; params: any[] }[] = [];
  const ready = opts.bootError ? Promise.reject(opts.bootError) : Promise.resolve();
  ready.then(
    () => { state = "ready"; start.onState?.("ready"); },
    (e) => { state = "failed"; start.onState?.("failed", e.message); },
  );
  start.onState?.("booting");
  const answer = (method: string, params: any[]) => {
    if (method !== "eth_getProof" || params[0].toLowerCase() !== SPECIFIER.toLowerCase() || params[2] !== TAG) return undefined;
    const keys = (params[1] as string[]).map(BigInt);
    if (keys.length === 0) return { ...fixture.proof, storageProof: [] };
    if (keys.length === 1 && keys[0] === 1n) return structuredClone(fixture.proof);
    return undefined;
  };
  const transport: AnonTransport = {
    pin: TOR_JS_PIN,
    ready,
    state: () => state,
    async fetch(url, init = {}) {
      if (state === "failed" || state === "closed") throw new TransportUnavailableError(state);
      const { id, method, params } = JSON.parse(String(init.body));
      sent.push({ url, method, params });
      if (opts.pinGate && method === "eth_getProof" && params[0]?.toLowerCase() === SPECIFIER.toLowerCase() && params[2] === TAG && params[1].length === 1) {
        await opts.pinGate;
      }
      if (url.includes("down.example")) throw new Error("tor: operation timed out at exit");
      const result = answer(method, params);
      const body = result === undefined ? { jsonrpc: "2.0", id, error: { code: -32000, message: "no recorded answer" } } : { jsonrpc: "2.0", id, result };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    close: () => {
      state = "closed";
      start.onState?.("closed");
    },
  };
  return { transport, sent };
}

function setup(opts: {
  operators?: DeRPCOperator[];
  pin?: WorkerPin;
  bootError?: Error;
  headersError?: Error;
  headersAfter?: Promise<void>;
  onStatus?: (s: DeRPCStatus) => void;
} = {}) {
  let fake!: ReturnType<typeof fakeTransport>;
  const headers: VerifiedHeaderSource = { finalized: () => HEADER, close: () => {} };
  const derpc = createDeRPCWith(
    {
      startTransport: (start) => (fake = fakeTransport(start, { bootError: opts.bootError, pinGate: opts.pinGate })).transport,
      startHeaders: async () => {
        await opts.headersAfter;
        if (opts.headersError) throw opts.headersError;
        return headers;
      },
    },
    { operators: opts.operators, worker: opts.pin ?? TOR_JS_PIN, onStatus: opts.onStatus },
  );
  derpc.ready.catch(() => {});
  return { derpc, sent: fake.sent };
}

async function rpcError(promise: Promise<unknown>): Promise<ProviderRpcError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ProviderRpcError);
  return error as ProviderRpcError;
}

describe("createDeRPC", () => {
  it("reads nothing, not even the worker-pin check, until the user chooses operators", async () => {
    const { derpc, sent } = setup();
    await derpc.ready;

    const error = await rpcError(derpc.provider.request(balanceOfSpecifier));

    expect(error.data).toEqual({ reason: "NoOperatorsChosenError" });
    expect(sent).toEqual([]);
    expect(derpc.status().pin.state).toBe("waiting-for-operators");
  });

  it("proves the worker pin through the chosen operator before the first read, then reads through it only", async () => {
    const { derpc, sent } = setup();
    await derpc.ready;
    derpc.setOperators([A]);

    expect(await derpc.provider.request(balanceOfSpecifier)).toBe("0x0");

    expect(sent.map((s) => [s.url, s.params[1].length])).toEqual([[A.url, 1], [A.url, 0]]); // slot 1, then the account
    expect(derpc.status().pin).toMatchObject({ state: "verified", block: fixture.block.number });
  });

  it("refuses every read when the on-chain workerHash differs from the pin", async () => {
    const flipped = `${TOR_JS_PIN.workerHash.slice(0, -1)}0` as Hex;
    const { derpc, sent } = setup({ operators: [A], pin: { ...TOR_JS_PIN, workerHash: flipped } });

    const error = await rpcError(derpc.provider.request(balanceOfSpecifier));

    expect(error.data).toEqual({ reason: "WorkerPinMismatchError" });
    expect(sent).toHaveLength(1); // only the pin proof
    expect(derpc.status().pin.state).toBe("mismatch");
    derpc.setOperators([B]);
    await rpcError(derpc.provider.request(balanceOfSpecifier));
    expect(sent).toHaveLength(1); // a proven mismatch is final: no new check with new operators, no read
  });

  it("checks the pin again with the next choice when the check could not finish", async () => {
    const unreachable: DeRPCOperator = { url: "https://down.example", priority: 0 };
    const { derpc } = setup({ operators: [unreachable] });

    await rpcError(derpc.provider.request(balanceOfSpecifier)); // the pin check exhausts the pool
    expect(derpc.status().pin.state).toBe("failed");
    derpc.setOperators([A]);

    expect(await derpc.provider.request(balanceOfSpecifier)).toBe("0x0");
    expect(derpc.status().pin.state).toBe("verified");
  });

  it("fails closed, as disconnected, when the worker can't start", async () => {
    const { derpc, sent } = setup({ operators: [A], bootError: new Error("worker hash mismatch") });
    const events: unknown[] = [];
    derpc.provider.on("disconnect", (e) => events.push(e));

    await expect(derpc.ready).rejects.toThrow();
    expect(events).toHaveLength(1);
    const error = await rpcError(derpc.provider.request(balanceOfSpecifier));

    expect(error.code).toBe(4900);
    expect(sent).toEqual([]);
    expect(derpc.status().transport.state).toBe("failed");
  });

  it("reports a light-client failure as the reason reads are refused", async () => {
    const { derpc } = setup({ operators: [A], headersError: new StaleCheckpointError("checkpoint is 9 days old") });

    const error = await rpcError(derpc.provider.request(balanceOfSpecifier));

    expect(error.data).toEqual({ reason: "StaleCheckpointError" });
    expect(derpc.status().lightClient.state).toBe("failed");
  });

  it("holds requests made during initialization until it finishes", async () => {
    let release!: () => void;
    const { derpc } = setup({ operators: [A], headersAfter: new Promise<void>((r) => (release = r)) });

    const pending = derpc.provider.request(balanceOfSpecifier);
    expect(derpc.status().lightClient.state).not.toBe("verified");
    release();

    expect(await pending).toBe("0x0");
  });

  it("stops every read once closed, and tells listeners it disconnected", async () => {
    const { derpc } = setup({ operators: [A] });
    await derpc.provider.request(balanceOfSpecifier);
    const events: unknown[] = [];
    derpc.provider.on("disconnect", (e) => events.push(e));

    derpc.close();
    const error = await rpcError(derpc.provider.request({ method: "eth_getBalance", params: [SPECIFIER, TAG] }));

    expect(error.code).toBe(4900);
    expect(events).toHaveLength(1);
    expect(derpc.status().transport.state).toBe("closed");
  });

  it("refuses a read waiting on the pin check when the user removes every operator", async () => {
    let release!: () => void;
    const pinGate = new Promise<void>((resolve) => (release = resolve));
    const { derpc, sent } = setup({ operators: [A], pinGate });
    await derpc.ready;

    const pending = derpc.provider.request(balanceOfSpecifier);
    derpc.setOperators([]);
    release();

    const error = await rpcError(pending);
    expect(error.data).toEqual({ reason: "NoOperatorsChosenError" });
    expect(sent.map((s) => [s.url, s.params[1].length])).toEqual([[A.url, 1]]); // the pin proof, never the account read
  });

  it("rejects a simulated lying operator, and keeps it excluded when the choice changes", async () => {
    const { derpc } = setup();
    await derpc.ready;
    derpc.setOperators([simulatedLyingOperator(A), A]);

    expect(await derpc.provider.request(balanceOfSpecifier)).toBe("0x0");
    const liar = () => derpc.status().operators.find((o) => o.id !== A.url);
    expect(liar()?.state).toBe("excluded");

    derpc.setOperators([simulatedLyingOperator(A), A, B]);
    expect(liar()?.state).toBe("excluded");
  });

  it("reports status only after it has returned, then on every change", async () => {
    const seen: string[] = [];
    let returned = false;
    const { derpc } = setup({ operators: [A], onStatus: (s) => seen.push(`${returned ? "" : "early "}${s.transport.state}/${s.lightClient.state}/${s.pin.state}`) });
    returned = true;

    await derpc.provider.request(balanceOfSpecifier);

    expect(seen.some((line) => line.startsWith("early"))).toBe(false);
    expect(seen.at(-1)).toBe("ready/verified/verified");
  });

  it("reports the verified block number once the light client is verified", async () => {
    const { derpc } = setup();
    await derpc.ready;

    expect(await derpc.provider.request({ method: "eth_blockNumber" })).toBe(TAG);
    expect(derpc.status().lightClient).toMatchObject({ state: "verified", header: { blockNumber: fixture.block.number } });
  });
});
