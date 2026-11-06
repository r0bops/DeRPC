import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredVoucher { amount: string; signature: `0x${string}` }
export interface StoredRead {
  kind: "proof" | "code" | "call";
  /** Request fingerprints and their bounded retry count. */
  requests: Record<string, number>;
  methods?: Record<string, string>;
  account?: string;
  block?: string;
}
export interface StoredPaymentSession {
  version: 1;
  chainId: number;
  escrow: `0x${string}`;
  sessionId: string;
  payer: `0x${string}`;
  operator: `0x${string}`;
  sessionKey: `0x${string}`;
  price: string;
  deposit: string;
  refundAfter: number;
  served: number;
  reads: Record<string, StoredRead>;
  highest?: StoredVoucher;
  settlement: { state: "open" | "submitting" | "pending" | "confirmed" | "failed" | "expired"; transactionHash?: `0x${string}`; serializedTransaction?: `0x${string}`; amount?: string; error?: string };
}
export interface PaymentStore {
  load(sessionId: string): Promise<StoredPaymentSession | undefined>;
  save(session: StoredPaymentSession): Promise<void>;
  list(): Promise<StoredPaymentSession[]>;
}

export class MemoryPaymentStore implements PaymentStore {
  readonly sessions = new Map<string, StoredPaymentSession>();
  async load(id: string) { const value = this.sessions.get(id); return value ? structuredClone(value) : undefined; }
  async save(session: StoredPaymentSession) { this.sessions.set(session.sessionId, structuredClone(session)); }
  async list() { return [...this.sessions.values()].map(value => structuredClone(value)); }
}

const uint = /^(0|[1-9]\d{0,77})$/;
const address = /^0x[\da-fA-F]{40}$/;
export function assertStoredSession(value: unknown): asserts value is StoredPaymentSession {
  const s = value as StoredPaymentSession;
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.chainId) || s.chainId <= 0 || !uint.test(s.sessionId) ||
      ![s.escrow, s.payer, s.operator, s.sessionKey].every(v => typeof v === "string" && address.test(v)) ||
      !uint.test(s.price) || BigInt(s.price) <= 0n || !uint.test(s.deposit) || !Number.isSafeInteger(s.refundAfter) || s.refundAfter <= 0 ||
      !Number.isSafeInteger(s.served) || s.served < 0 || s.served > 4096 || !s.reads || Array.isArray(s.reads) ||
      Object.keys(s.reads).length !== s.served || !s.settlement || !["open", "submitting", "pending", "confirmed", "failed", "expired"].includes(s.settlement.state)) {
    throw new Error("invalid durable payment session");
  }
  if (s.highest && (!uint.test(s.highest.amount) || !/^0x[\da-fA-F]{130}$/.test(s.highest.signature))) throw new Error("invalid stored voucher");
  for (const [id, read] of Object.entries(s.reads)) {
    if (!/^0x[\da-fA-F]{64}$/.test(id) || !["proof", "code", "call"].includes(read.kind) || !read.requests || Object.entries(read.requests).some(([hash, count]) => !/^0x[\da-fA-F]{64}$/.test(hash) || !Number.isSafeInteger(count) || count < 1 || count > 2)) throw new Error("invalid stored read");
  }
}

/** Single-writer, atomic-replacement journal. fsync completes before a voucher or read is acknowledged. */
export async function openFilePaymentStore(directory: string): Promise<PaymentStore & { close(): Promise<void> }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "writer.lock");
  const token = randomUUID();
  // PID alone is insufficient in containers, where every restarted service may again be PID 1.
  const processStart = async (pid: number) => (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]!.split(" ")[19]!;
  const started = await processStart(process.pid);
  async function takeLock() {
    const lock = await open(lockPath, "wx", 0o600);
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, started, token })); await lock.sync(); }
    finally { await lock.close(); }
  }
  try { await takeLock(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Serialize stale recovery itself. A stale observation from another starter must never unlink
    // the new writer's lock. If the process dies during recovery, fail closed for operator inspection.
    const recoveryPath = join(directory, "recovery.lock");
    let recovery;
    try { recovery = await open(recoveryPath, "wx", 0o600); }
    catch { throw new Error("payment journal recovery is running or incomplete; inspect recovery.lock"); }
    try {
      const previous = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; started?: string };
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error("invalid payment journal lock; inspect it before starting");
      let stale = false;
      try { stale = previous.started !== await processStart(previous.pid); } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
        stale = true;
      }
      if (!stale) throw new Error("payment journal already has a writer");
      await rm(lockPath);
      await takeLock();
    } finally { await recovery.close(); await rm(recoveryPath); }
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  function operation<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("payment journal is closed"));
    const pending = work();
    active.add(pending);
    return pending.finally(() => { active.delete(pending); });
  }
  function path(id: string) {
    if (!uint.test(id)) throw new Error("invalid session id");
    return join(directory, `${id}.json`);
  }
  async function load(id: string): Promise<StoredPaymentSession | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(path(id), "utf8"));
      assertStoredSession(value);
      if (value.sessionId !== id) throw new Error("payment journal session mismatch");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  const store: PaymentStore & { close(): Promise<void> } = {
    load(id) { return operation(() => load(id)); },
    save(session) { return operation(async () => {
      assertStoredSession(session);
      const target = path(session.sessionId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(session));
        await file.sync();
      } finally { await file.close(); }
      try {
        await rename(temporary, target);
        const dir = await open(directory, "r");
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { await rm(temporary, { force: true }); }
    }); },
    list() { return operation(async () => {
      const names = (await readdir(directory)).filter(name => /^\d+\.json$/.test(name));
      if (names.length > 8192) throw new Error("payment journal session limit exceeded");
      const sessions: StoredPaymentSession[] = [];
      for (const name of names) { const session = await load(name.slice(0, -5)); if (session) sessions.push(session); }
      return sessions;
    }); },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          // Keep exclusivity until every accepted operation has stopped touching the journal.
          // In particular, a late rename must never overwrite a replacement writer's voucher.
          await Promise.allSettled([...active]);
          const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
          if (owner.token === token) await rm(lockPath);
        })();
      }
      return closing;
    },
  };
  return store;
}
