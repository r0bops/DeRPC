import { describe, expect, it, vi } from "vitest";
import { createBrowserSession, JOURNAL_KEY, savedBrowserSession, type Data, type SessionAdapter } from "../../web/src/ens/session.ts";
import { createENSWalletController } from "../../contracts/scripts/ens-wallet-client.mjs";

const FROM = `0x${"11".repeat(20)}`, TO = `0x${"22".repeat(20)}`, HASH = `0x${"ab".repeat(32)}`, BLOCK = `0x${"cd".repeat(32)}`;
const copy = <T>(value: T): T => structuredClone(value);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

function fixture() {
  let held = false, complete = false;
  const saved = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { saved.set(key, value); }), removeItem: vi.fn((key: string) => { saved.delete(key); }) };
  const locks = { request: async (_name: string, _options: Data, callback: (lock: Data | null) => Promise<unknown>) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({ name: "test-lock" }); } finally { held = false; }
  } } as unknown as Pick<LockManager, "request">;
  const clients = [0, 1].map(id => ({ id, getBlock: vi.fn(async (request: Data) => ({
    number: request.blockTag === "finalized" ? 80n : request.blockNumber ?? 100n,
    hash: BLOCK, timestamp: 1000n,
  })) })) as [Data, Data];
  const config = { schemaVersion: 1, chainId: 1, parentName: "derpc.eth", operators: [{ label: "alice" }] };
  const tx = { from: FROM, to: TO, data: "0x1234", value: "0x0", chainId: "0x1" };
  const build = { sourceHash: HASH, compiler: { version: "test-fixture" } };
  const adapter: SessionAdapter = {
    id: "security-fixture", build,
    validateInput: input => copy(input),
    checkIdentity: (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("identity changed"); },
    reconstruct: () => copy(tx),
    prepare: vi.fn(async (input, client) => {
      const block = await client.getBlock({ blockTag: "latest" });
      return { schemaVersion: 1, kind: "derpc-ens-unsigned-plan", chainId: 1,
        flow: "operator-join", stage: complete ? "complete" : "register-operator",
        status: complete ? "state-matches-config" : "needs-wallet-transactions",
        sourceHash: build.sourceHash, compiler: build.compiler, resumeConfig: copy(input), roleTable: [],
        preflight: { blockNumber: block.number.toString(), blockHash: block.hash, localOnly: false },
        transactions: complete ? [] : [{ id: "register-alice", purpose: "Register Alice", walletRequest: { method: "eth_sendTransaction", params: [copy(tx)] } }],
      };
    }),
    verify: vi.fn(async () => ({ kind: "test-manifest", pins: { registrar: TO }, verified: true })),
    pins: manifest => manifest.pins,
    checkTransaction: vi.fn(async () => ({ hash: HASH, blockNumber: "101", blockHash: BLOCK })),
  };
  const open = () => createBrowserSession({ config, adapter, clients, storage, locks });
  return { config, adapter, clients, storage, locks, open, finish: () => { complete = true; } };
}

function wallet() {
  const listeners = new Map<string, () => void>();
  const result = {
    send: vi.fn(async () => HASH),
    request: vi.fn(async (request: Data) => {
      if (["eth_accounts", "eth_requestAccounts"].includes(request.method)) return [FROM];
      if (request.method === "eth_chainId") return "0x1";
      if (request.method === "eth_sendTransaction") return result.send();
      throw new Error("unexpected wallet request");
    }),
    on: (event: string, callback: () => void) => { listeners.set(event, callback); },
    removeListener: (event: string) => { listeners.delete(event); },
    emit: (event: string) => { listeners.get(event)?.(); },
  };
  return result;
}

async function controller(session: Awaited<ReturnType<typeof createBrowserSession>>, action = session.action) {
  const selected = wallet();
  const api = createENSWalletController({ initialState: session.state(), action });
  api.selectWallet(selected); api.selectTransaction("register-alice");
  await api.connect(); api.setReviewed(true);
  return { api, wallet: selected };
}

describe("browser ENS journal adversarial recovery", () => {
  it("leaves no empty journal when the first administrative preflight fails", async () => {
    const test = fixture();
    test.adapter.prepare = vi.fn(async () => { throw new Error("preflight unavailable"); });
    await expect(test.open()).rejects.toThrow("preflight unavailable");
    expect(savedBrowserSession(test.storage)).toBeNull();
  });

  it("does not let an old lost rejection acknowledgement clear another tab's live wallet attempt", async () => {
    const test = fixture(), first = await test.open();
    const a = await controller(first, async request => {
      const response = await first.action(request);
      if (request.action === "rejected") throw new Error("rejection acknowledgement lost after durable save");
      return response;
    });
    a.wallet.send.mockRejectedValue({ code: 4001, message: "User rejected" });
    await expect(a.api.send()).rejects.toThrow("not confirmed");
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0].status).toBe("ready");

    const second = await test.open(), b = await controller(second), pending = deferred<string>();
    b.wallet.send.mockImplementation(() => pending.promise);
    const sending = b.api.send();
    await vi.waitFor(() => expect(b.wallet.send).toHaveBeenCalledOnce());
    const reservation = savedBrowserSession(test.storage)!.stages[0].entries[0].reservation;
    await expect(a.api.refresh()).rejects.toThrow(/attempt|reservation|locked/);
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0]).toMatchObject({ status: "pending", reservation });
    const third = await test.open();
    await expect(third.action({ token: third.state().token, action: "begin", id: "register-alice" })).rejects.toThrow();
    pending.resolve(HASH); await sending;
    expect(b.wallet.send).toHaveBeenCalledOnce();
  });

  it("allows at most one begin while another tab holds the journal lock", async () => {
    const test = fixture(), a = await test.open(), b = await test.open(), gate = deferred<void>();
    const prepare = test.adapter.prepare;
    test.adapter.prepare = async (...args) => { await gate.promise; return prepare(...args); };
    const first = a.action({ token: a.state().token, action: "begin", id: "register-alice" });
    await Promise.resolve();
    await expect(b.action({ token: b.state().token, action: "begin", id: "register-alice" })).rejects.toThrow("Another tab");
    gate.resolve(); await first;
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0].status).toBe("pending");
  });

  it.each(["write failure", "failed readback"])("requests no wallet send when durable reservation has a %s", async mode => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    test.storage.setItem.mockImplementation(() => { if (mode === "write failure") throw new Error("quota exceeded"); });
    await expect(selected.api.send()).rejects.toThrow();
    expect(selected.wallet.send).not.toHaveBeenCalled();
    expect(selected.api.state().canSend).toBe(false);
  });

  it("keeps an unknown submission locked across reload and rejects a replacement configuration", async () => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    selected.wallet.send.mockRejectedValue(new Error("wallet connection lost after possible broadcast"));
    await expect(selected.api.send()).rejects.toThrow();
    const reloaded = await test.open();
    await expect(reloaded.action({ token: reloaded.state().token, action: "begin", id: "register-alice" })).rejects.toThrow();
    await expect(reloaded.action({ token: reloaded.state().token, action: "rejected", id: "register-alice" })).rejects.toThrow();
    await expect(createBrowserSession({ ...test, config: { ...test.config, operators: [{ label: "bob" }] } })).rejects.toThrow("Another operation");
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0].status).toBe("pending");
  });

  it("persists a returned hash before any failing receipt query and preserves it on reload", async () => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    test.adapter.checkTransaction = vi.fn(async () => {
      expect(savedBrowserSession(test.storage)!.stages[0].entries[0]).toMatchObject({ status: "submitted", hash: HASH });
      throw new Error("receipt RPC unavailable");
    });
    await expect(selected.api.send()).rejects.toThrow(HASH);
    const reloaded = await test.open();
    expect(reloaded.state().entries[0]).toMatchObject({ status: "submitted", hash: HASH });
    expect(selected.wallet.send).toHaveBeenCalledOnce();
  });

  it("refuses a restored journal whose zero-value calldata differs from local reconstruction", async () => {
    const test = fixture(); await test.open();
    const saved = savedBrowserSession(test.storage)!;
    saved.stages[0].plan.transactions[0].walletRequest.params[0].data = "0xdeadbeef";
    test.storage.setItem(JOURNAL_KEY, JSON.stringify(saved));
    await expect(test.open()).rejects.toThrow("locally reconstructed intent");
  });

  it("cannot discard an uncertain wallet send or archive replayed completion from storage", async () => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    selected.wallet.send.mockRejectedValue(new Error("unknown send"));
    await expect(selected.api.send()).rejects.toThrow();
    await expect(session.discardUnsent()).rejects.toThrow("uncertain");
    const saved = savedBrowserSession(test.storage)!;
    saved.manifest = { verified: true }; saved.pins = { registrar: TO };
    test.storage.setItem(JOURNAL_KEY, JSON.stringify(saved));
    await expect(session.archive()).rejects.toThrow("Verify");
    expect(savedBrowserSession(test.storage)).not.toBeNull();
  });

  it("discards only a never-attempted review and retains rejected-attempt evidence", async () => {
    const test = fixture(), unsent = await test.open();
    await unsent.discardUnsent(); expect(savedBrowserSession(test.storage)).toBeNull();
    const session = await test.open(), selected = await controller(session);
    selected.wallet.send.mockRejectedValue({ code: 4001, message: "User rejected" });
    await expect(selected.api.send()).rejects.toThrow("rejected");
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0]).toMatchObject({ status: "ready", attempted: true });
    await expect(session.discardUnsent()).rejects.toThrow("cannot be discarded");
  });

  it("invalidates a connection if the account changes while its account request is outstanding", async () => {
    const test = fixture(), session = await test.open(), selected = wallet(), accounts = deferred<string[]>();
    selected.request.mockImplementation(async request => request.method === "eth_requestAccounts" ? accounts.promise : "0x1");
    const api = createENSWalletController({ initialState: session.state(), action: session.action });
    api.selectWallet(selected); api.selectTransaction("register-alice");
    const connecting = api.connect(); selected.emit("accountsChanged"); accounts.resolve([FROM]);
    await expect(connecting).rejects.toThrow("changed");
    api.setReviewed(true);
    expect(api.state()).toMatchObject({ connected: false, reviewed: false, canSend: false });
    expect(selected.send).not.toHaveBeenCalled();
  });
});

describe("browser ENS independent verification boundaries", () => {
  it("caps the wallet permit at the original lifecycle review deadline and rechecks after preflight", async () => {
    const test = fixture(), prepare = test.adapter.prepare;
    const deadline = Math.floor(Date.now() / 1000) + 20;
    test.adapter.prepare = async (...args) => ({ ...await prepare(...args), lifecycle: { reviewExpiresAt: deadline } });
    test.adapter.recheck = vi.fn(async () => undefined);
    const session = await test.open();
    const result = await session.action({ token: session.state().token, action: "begin", id: "register-alice" });
    expect(result.permit.expiresAt).toBe(deadline * 1000);
    expect(test.adapter.recheck).toHaveBeenCalledTimes(4); // both sources, before and after fresh preflight
  });

  it("does not create a reservation after the original lifecycle review has expired", async () => {
    const test = fixture(), prepare = test.adapter.prepare;
    test.adapter.prepare = async (...args) => ({ ...await prepare(...args), lifecycle: { reviewExpiresAt: Math.floor(Date.now() / 1000) - 1 } });
    const session = await test.open(), selected = await controller(session);
    await expect(selected.api.send()).rejects.toThrow("expired");
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0]).toEqual({ id: "register-alice", status: "ready" });
    expect(selected.wallet.send).not.toHaveBeenCalled();
  });

  it("preserves finalized reads and ignores only informational verification timestamps", async () => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    await selected.api.send(); test.finish(); await selected.api.refresh();
    test.adapter.verify = vi.fn(async (_config, _stages, source) => {
      const final = await source.getBlock({ blockTag: "finalized" });
      expect(final.number).toBe(80n);
      return { kind: "test-manifest", pins: { registrar: TO }, verifiedAt: `time-${source.id}`, finality: { block: final.number.toString() } };
    });
    await selected.api.verify();
    expect(selected.api.state().complete).toBe(true);
    for (const source of test.clients) expect(source.getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
  });

  it("rejects differing receipt evidence despite matching public pins", async () => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    await selected.api.send(); test.finish(); await selected.api.refresh();
    test.adapter.verify = vi.fn(async (_config, _stages, source) => ({ kind: "test-manifest", pins: { registrar: TO }, receipt: { blockHash: source.id ? HASH : BLOCK } }));
    await expect(selected.api.verify()).rejects.toThrow("differs");
    expect(selected.api.state().complete).toBe(false);
    expect(savedBrowserSession(test.storage)!.manifest).toBeNull();
  });

  it("does not reuse a confirmed status after one receipt source fails", async () => {
    const test = fixture(), session = await test.open(), selected = await controller(session);
    await selected.api.send();
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0].status).toBe("confirmed");
    test.adapter.checkTransaction = vi.fn(async () => { throw new Error("source offline"); });
    await expect(selected.api.refresh()).rejects.toThrow("offline");
    expect(savedBrowserSession(test.storage)!.stages[0].entries[0]).toMatchObject({ status: "submitted", hash: HASH });
    expect(selected.api.state().complete).toBe(false);
  });
});
