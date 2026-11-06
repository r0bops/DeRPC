import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { DelegationState, DelegationStore } from "./delegation.ts";
import { decodeStoreValue, encodeStoreValue, MAX_STATE_BYTES, validateState, validateTransition } from "./node-codec.ts";
export { serveDelegationCoordinator, serveSponsoredCoordinator, type CoordinatorServerOptions } from "./coordinator.ts";

/**
 * Durable single-writer store for a Linux Node 24 sponsor. Requires util-linux `flock`.
 * A separate process holds the kernel lock AND performs every state-file read/write. Its death
 * ends both mutation and exclusivity, so an orphaned parent cannot write after lock release.
 */
export class FileDelegationStore implements DelegationStore {
  private readonly worker: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private failed?: Error;
  private accepting = true;
  private closePromise?: Promise<void>;
  private readonly exited: Promise<void>;

  private constructor(worker: ChildProcessWithoutNullStreams) {
    this.worker = worker;
    const lines = createInterface({ input: worker.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      try {
        if (Buffer.byteLength(line) > MAX_STATE_BYTES + 32768) throw new Error("store response exceeds limit");
        const response = decodeStoreValue(line) as { id?: number; error?: string; ready?: boolean };
        if (response.ready) return;
        const waiter = response.id === undefined ? undefined : this.pending.get(response.id);
        if (!waiter) throw new Error("unexpected store response");
        this.pending.delete(response.id!);
        if (response.error) { waiter.reject(new Error(response.error)); this.fail(new Error(response.error)); }
        else waiter.resolve(response);
      } catch (error) { this.fail(error instanceof Error ? error : new Error("store protocol failure")); }
    });
    worker.stdin.on("error", error => this.fail(error));
    worker.on("error", error => this.fail(error));
    this.exited = new Promise(resolve => worker.once("exit", () => {
      this.fail(new Error("delegation store lock-holder exited")); lines.close(); resolve();
    }));
  }

  static async open(directory: string): Promise<FileDelegationStore> {
    if (process.platform !== "linux") throw new Error("FileDelegationStore requires Linux kernel flock");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    directory = await realpath(directory);
    const info = await stat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error("delegation store requires an owner-only directory (chmod 700)");
    const lockPath = join(directory, ".writer.lock");
    const lock = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { if (!(await lock.stat()).isFile()) throw new Error("invalid delegation lock file"); }
    finally { await lock.close(); }
    const worker = spawn("flock", ["--no-fork", "--exclusive", "--nonblock", lockPath, process.execPath, fileURLToPath(new URL("./node-worker.ts", import.meta.url)), directory], { stdio: ["pipe", "pipe", "pipe"] });
    const store = new FileDelegationStore(worker);
    await new Promise<void>((resolve, reject) => {
      let stderr = "", output = "";
      const timer = setTimeout(() => { store.fail(new Error("store lock acquisition timed out")); worker.kill("SIGTERM"); reject(store.failed); }, 10_000);
      const cleanup = () => { clearTimeout(timer); worker.stdout.off("data", ready); worker.stderr.off("data", errorData); worker.off("exit", exit); worker.off("error", error); };
      const ready = (chunk: Buffer) => { output += chunk.toString(); if (output.includes('{"ready":true}\n')) { cleanup(); resolve(); } };
      const errorData = (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 1024); };
      const exit = () => { cleanup(); reject(new Error(`delegation store is locked by another process or could not start${stderr ? `: ${stderr.trim()}` : ""}`)); };
      const error = (cause: Error) => { cleanup(); reject(new Error("could not start util-linux flock for delegation store", { cause })); };
      worker.stdout.on("data", ready); worker.stderr.on("data", errorData); worker.once("exit", exit); worker.once("error", error);
    });
    return store;
  }

  /** Exposed for operational supervision; killing it makes this store permanently unavailable. */
  get workerPid(): number { return this.worker.pid!; }

  async transact<T>(session: string, update: (state: DelegationState | undefined) => { state: DelegationState; value: T }): Promise<T> {
    if (!this.accepting) throw new Error("delegation store is closing");
    if (typeof session !== "string" || !session.length || session.length > 256) throw new Error("invalid delegation session key");
    const result = this.tail.then(async () => {
      this.assertLive();
      const read = await this.command("read", session) as { state?: DelegationState };
      const next = update(read.state === undefined ? undefined : structuredClone(read.state));
      validateState(next.state, session);
      validateTransition(read.state, next.state);
      await this.command("commit", session, next.state);
      return structuredClone(next.value);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  /** Waits for accepted transactions, then closes the helper's stdin and releases its kernel lock. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.accepting = false;
      this.closePromise = (async () => {
        await this.tail;
        this.worker.stdin.end();
        await this.exited;
      })();
    }
    return this.closePromise;
  }

  private command(operation: "read" | "commit", session: string, state?: DelegationState): Promise<unknown> {
    this.assertLive();
    const id = this.nextId++;
    const line = encodeStoreValue({ id, operation, session, state }) + "\n";
    if (Buffer.byteLength(line) > MAX_STATE_BYTES + 32768) throw new Error("delegation store command exceeds limit");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.stdin.write(line, error => { if (error) this.fail(error); });
    });
  }
  private assertLive(): void { if (this.failed) throw this.failed; }
  private fail(error: Error): void {
    this.failed ??= error;
    for (const waiter of this.pending.values()) waiter.reject(this.failed);
    this.pending.clear();
    this.worker.stdin.destroy();
  }
}
