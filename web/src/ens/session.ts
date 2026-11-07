/** Browser-local administrative journal. It never owns a wallet or sends a transaction. */
export const JOURNAL_KEY = "derpc:ens:operator-session:v1";
export const serialise = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
const clone = <T>(value: T): T => JSON.parse(serialise(value));
const same = (a: unknown, b: unknown) => serialise(a) === serialise(b);
const HASH = /^0x[0-9a-fA-F]{64}$/;
export type Data = Record<string, any>;
export interface SessionAdapter {
  id: string;
  build: Data;
  validateInput(input: Data): Data;
  checkIdentity(a: Data, b: Data): void;
  reconstruct(item: Data, config: Data, plan: Data): Data;
  prepare(config: Data, client: Data, stages: Data[]): Promise<Data>;
  verify(config: Data, stages: Data[], client: Data): Promise<Data>;
  pins(manifest: Data): Data;
  checkTransaction(client: Data, item: Data, hash: string, reviewBlock: string): Promise<Data | null>;
  recheck?(config: Data, plan: Data, client: Data): Promise<unknown>;
}
export interface JournalOptions {
  config: Data; adapter: SessionAdapter; clients: [Data, Data];
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  locks: Pick<LockManager, "request">;
  key?: string;
}

export function savedBrowserSession(storage: Pick<Storage, "getItem">, key = JOURNAL_KEY): Data | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  if (raw.length > 8 * 1024 * 1024) throw new Error("Saved ENS evidence is too large. Export it before recovery.");
  const saved = JSON.parse(raw);
  if (saved?.kind !== "derpc-browser-ens-session" || saved.version !== 1 || !Array.isArray(saved.stages)) throw new Error("Saved ENS journal is invalid. It has not been replaced.");
  return saved;
}

/** One lock per origin, plus a persistent pending reservation that survives lock release/reload. */
export async function createBrowserSession(options: JournalOptions) {
  const { adapter, clients, storage, locks } = options, key = options.key ?? JOURNAL_KEY;
  if (!locks?.request || !storage?.setItem) throw new Error("Signing needs Web Locks and persistent browser storage. Keep drafts or use the documented local helper.");
  const input = clone(adapter.validateInput(options.config));
  let session: Data;
  let verifiedDigest: string | undefined;
  const reservations = new Map<string, string>();
  const locked = <T>(fn: () => Promise<T>) => locks.request(`${key}:write`, { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock) throw new Error("Another tab is updating this ENS session. Wait, then refresh saved status.");
    return fn();
  });
  const save = () => {
    const value = serialise(session);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error("ENS journal persistence failed. No new wallet request is permitted.");
  };
  const checkPlan = (plan: Data, entries: Data[]) => {
    if (plan.kind !== "derpc-ens-unsigned-plan" || plan.schemaVersion !== 1 || plan.chainId !== 1 ||
        plan.sourceHash !== adapter.build.sourceHash || !same(plan.compiler, adapter.build.compiler) ||
        !Array.isArray(plan.transactions) || entries.length !== plan.transactions.length || !Array.isArray(plan.roleTable)) throw new Error("Saved ENS plan or reviewed build changed.");
    adapter.checkIdentity(input, plan.resumeConfig);
    const ids = new Set<string>();
    for (const [index, item] of plan.transactions.entries()) {
      const entry = entries[index]!;
      if (ids.has(item.id) || entry.id !== item.id || !["ready", "pending", "submitted", "confirmed"].includes(entry.status) ||
          entry.hash !== undefined && !HASH.test(entry.hash) || ["submitted", "confirmed"].includes(entry.status) && !HASH.test(entry.hash ?? "") ||
          !same(item.walletRequest, { method: "eth_sendTransaction", params: [adapter.reconstruct(item, plan.resumeConfig, plan)] })) throw new Error("Saved ENS transaction does not match its locally reconstructed intent.");
      ids.add(item.id);
    }
  };
  const reload = () => {
    const saved = savedBrowserSession(storage, key);
    if (!saved || saved.adapter !== adapter.id || saved.sourceHash !== adapter.build.sourceHash || !same(saved.input, input)) throw new Error("Another operation owns the saved journal. Resume its original inputs; pending transactions cannot be replaced.");
    adapter.checkIdentity(input, adapter.validateInput(saved.config));
    for (const stage of saved.stages) checkPlan(stage.plan, stage.entries);
    if (saved.finalPlan) checkPlan(saved.finalPlan, []);
    session = saved;
  };
  const evidence = () => session.stages.map((stage: Data) => ({ plan: stage.plan, transactionHashes: stage.entries.map((entry: Data) => entry.hash) }));
  // Both sources are read at one explicitly cross-checked block. Different head heights must not produce a false agreement.
  const atSharedHead = async () => {
    const head = await clients[0].getBlock({ blockTag: "latest" });
    if (!head.hash || head.number === null || (await clients[1].getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error("Administrative RPC sources disagree on the canonical head.");
    return clients.map(client => ({ ...client,
      getBlock: (args: Data = {}) => client.getBlock(args.blockNumber !== undefined || args.blockHash !== undefined || args.blockTag && args.blockTag !== "latest" ? args : { ...args, blockTag: undefined, blockNumber: head.number }),
      getBlockNumber: async () => head.number,
    })) as unknown as [Data, Data];
  };
  const planIntent = (plan: Data) => ({ stage: plan.stage, status: plan.status, flow: plan.flow, sourceHash: plan.sourceHash, compiler: plan.compiler,
    subregistry: plan.subregistry, resolvers: plan.resolvers, registrationSlot: plan.registrationSlot, config: plan.resumeConfig,
    roleTable: plan.roleTable, lifecycle: plan.lifecycle ? { action: plan.lifecycle.action, before: plan.lifecycle.before, manifestHash: plan.lifecycle.manifestHash, reviewExpiresAt: plan.lifecycle.reviewExpiresAt } : undefined,
    transactions: plan.transactions.map((item: Data) => ({ id: item.id, walletRequest: item.walletRequest })) });
  const freshPlan = async () => {
    const sources = await atSharedHead();
    const a = clone(await adapter.prepare(session.config, sources[0], evidence()));
    const b = clone(await adapter.prepare(session.config, sources[1], evidence()));
    checkPlan(a, a.transactions.map((item: Data) => ({ id: item.id, status: "ready" })));
    checkPlan(b, b.transactions.map((item: Data) => ({ id: item.id, status: "ready" })));
    if (a.preflight.localOnly !== false || b.preflight.localOnly !== false || !same(planIntent(a), planIntent(b)) || a.preflight.blockHash !== b.preflight.blockHash) throw new Error("The two administrative sources disagree on this operator plan.");
    for (const client of clients) if ((await client.getBlock({ blockNumber: BigInt(a.preflight.blockNumber) })).hash !== a.preflight.blockHash) throw new Error("The review block changed during preflight.");
    return a;
  };
  const updateReceipts = async () => {
    for (const stage of session.stages) for (let i = 0; i < stage.entries.length; i++) {
      const entry = stage.entries[i]; if (!entry.hash) continue;
      // Invalidate an old success before any network await; errors must not retain a stale confirmed status.
      entry.status = "submitted"; delete entry.receipt; save();
      const checks = await Promise.all(clients.map(client => adapter.checkTransaction(client, stage.plan.transactions[i], entry.hash, stage.plan.preflight.blockNumber)));
      if (checks.every(Boolean) && same(checks[0], checks[1])) { entry.status = "confirmed"; entry.receipt = checks[0]; }
      save();
    }
  };
  const clearVerification = () => { session.manifest = null; session.pins = null; session.finalPlan = null; save(); };
  const refresh = async () => {
    clearVerification(); await updateReceipts();
    if (session.stages.some((stage: Data) => stage.entries.some((entry: Data) => entry.status !== "confirmed"))) return;
    const plan = await freshPlan(); session.config = plan.resumeConfig;
    if (plan.status === "state-matches-config") session.finalPlan = plan;
    else session.stages.push({ plan, entries: plan.transactions.map((item: Data) => ({ id: item.id, status: "ready" })) });
    save();
  };
  const state = () => clone({ token: session.token, plan: session.finalPlan ?? session.stages.at(-1)?.plan,
    entries: session.finalPlan ? [] : session.stages.at(-1)?.entries ?? [], readyToVerify: !!session.finalPlan,
    complete: !!session.manifest, manifest: session.manifest, directoryPins: session.pins, stageNumber: session.stages.length });
  await locked(async () => {
    const saved = savedBrowserSession(storage, key);
    if (saved) { reload(); session.manifest = null; session.pins = null; save(); if (!session.stages.length) await refresh(); }
    else {
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      session = { kind: "derpc-browser-ens-session", version: 1, adapter: adapter.id, sourceHash: adapter.build.sourceHash,
        token, input, config: input, stages: [], finalPlan: null, manifest: null, pins: null };
      // No submission is possible yet. A failed first preflight must not strand an empty journal.
      const plan = await freshPlan();
      if (plan.status === "state-matches-config") session.finalPlan = plan;
      else session.stages.push({ plan, entries: plan.transactions.map((item: Data) => ({ id: item.id, status: "ready" })) });
      save();
    }
  });
  return { state, export: () => clone(session), async discardUnsent() {
    return locked(async () => {
      reload();
      if (session.stages.some((stage: Data) => stage.entries.some((entry: Data) => entry.status !== "ready" || entry.hash || entry.startedAt || entry.attempted || entry.reservation))) throw new Error("A submitted or uncertain transaction cannot be discarded. Reconcile its original hash.");
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error("Could not remove the unsent review.");
    });
  }, async archive() {
    return locked(async () => {
      reload();
      if (!session.manifest || serialise(session) !== verifiedDigest) throw new Error("Verify this completed session again before archiving it and starting another operation.");
      const archiveKey = `${key}:archive:${session.token}`, value = serialise(session);
      storage.setItem(archiveKey, value);
      if (storage.getItem(archiveKey) !== value) throw new Error("Could not persist completed evidence. The current session remains saved.");
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error("Could not archive the current journal.");
    });
  }, async action(request: Data) {
    const reviewed = state();
    return locked(async () => {
      reload();
      if (request.token !== session.token) throw new Error("The saved session changed. Resume it before continuing.");
      try {
        if (request.action === "refresh") { await refresh(); return state(); }
        if (request.action === "verify") {
          const wasReady = !!session.finalPlan; clearVerification(); await updateReceipts();
          if (!wasReady || session.stages.some((stage: Data) => stage.entries.some((entry: Data) => entry.status !== "confirmed"))) throw new Error("Every reviewed stage needs a matching canonical receipt.");
          const plan = await freshPlan();
          if (plan.status !== "state-matches-config") throw new Error("Operator state changed; refresh and review again.");
          const sources = await atSharedHead();
          const manifests = await Promise.all(sources.map(client => adapter.verify(session.config, evidence(), client)));
          const comparable = (manifest: Data) => { const value = clone(manifest); delete value.checkedAt; delete value.verifiedAt; return value; };
          const pins = adapter.pins(manifests[0]!);
          if (!same(pins, adapter.pins(manifests[1]!)) || !same(comparable(manifests[0]!), comparable(manifests[1]!))) throw new Error("Final verification differs between the two administrative sources.");
          session.finalPlan = plan; session.manifest = clone(manifests[0]); session.pins = clone(pins); save(); verifiedDigest = serialise(session); return state();
        }
        const stage = session.stages.at(-1), index = stage?.entries.findIndex((entry: Data) => entry.id === request.id) ?? -1;
        if (index < 0 || session.finalPlan) throw new Error("Choose a transaction in the current saved stage.");
        const entry = stage.entries[index], item = stage.plan.transactions[index];
        if (request.action === "begin") {
          if (!same(reviewed.plan, state().plan) || entry.status !== "ready" || session.stages.some((s: Data) => s.entries.some((e: Data) => ["pending", "submitted"].includes(e.status)))) throw new Error("Another tab or earlier submission changed this review. Refresh; existing submissions stay locked.");
          await updateReceipts();
          if (session.stages.some((s: Data) => s.entries.some((e: Data) => ["pending", "submitted"].includes(e.status)))) throw new Error("An earlier receipt is no longer confirmed.");
          for (const client of clients) if ((await client.getBlock({ blockNumber: BigInt(stage.plan.preflight.blockNumber) })).hash !== stage.plan.preflight.blockHash) throw new Error("Original review block is no longer canonical.");
          if (adapter.recheck) await Promise.all(clients.map(client => adapter.recheck!(session.config, stage.plan, client)));
          const fresh = await freshPlan(), current = fresh.transactions.find((tx: Data) => tx.id === item.id);
          if (!current || !same(current.walletRequest, item.walletRequest)) throw new Error("The live operator intent changed. No wallet request is enabled.");
          if (adapter.recheck) await Promise.all(clients.map(client => adapter.recheck!(session.config, stage.plan, client)));
          const expiresAt = Math.min(Date.now() + 60_000, stage.plan.lifecycle ? Number(stage.plan.lifecycle.reviewExpiresAt) * 1000 : Infinity);
          if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("The reviewed operation expired during preflight. Prepare a fresh review before signing.");
          entry.status = "pending"; entry.attempted = true; entry.startedAt = new Date().toISOString(); entry.reservation = crypto.randomUUID(); save();
          reservations.set(item.id, entry.reservation);
          return { ...state(), permit: { id: item.id, reservationId: entry.reservation, walletRequest: clone(item.walletRequest), expiresAt } };
        }
        if (request.action === "record") {
          if (!["pending", "submitted"].includes(entry.status) || !HASH.test(request.hash ?? "") || entry.hash && entry.hash.toLowerCase() !== request.hash.toLowerCase()) throw new Error("Reconcile the original pending transaction hash; it cannot be replaced.");
          if (session.stages.some((s: Data) => s.entries.some((e: Data) => e !== entry && e.hash?.toLowerCase() === request.hash.toLowerCase()))) throw new Error("This hash already belongs to another transaction.");
          entry.hash = request.hash; entry.status = "submitted"; save(); await updateReceipts(); return state();
        }
        if (request.action === "rejected") {
          if (entry.status !== "pending" || entry.hash || !entry.reservation || reservations.get(entry.id) !== entry.reservation || request.reservationId !== entry.reservation) throw new Error("Only this wallet attempt's explicit rejection can release its reservation. A different tab's attempt remains locked.");
          entry.status = "ready"; delete entry.startedAt; delete entry.reservation; save(); return state();
        }
        throw new Error("Unsupported browser journal action.");
      } catch (error) { if (error instanceof Error) Object.assign(error, { state: state() }); throw error; }
    });
  } };
}
