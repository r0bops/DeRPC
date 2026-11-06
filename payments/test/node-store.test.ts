import { fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { CappedDelegationSigner, delegatedReadTypedData, type DelegatedRead, type DelegationOptions, type DelegationSession } from "../src/delegation.ts";
import { FileDelegationStore } from "../src/node-store.ts";
import { voucherTypedData, type SignedVoucher } from "../src/protocol.ts";

const app = privateKeyToAccount(`0x${"51".repeat(32)}`);
const user = privateKeyToAccount(`0x${"52".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"53".repeat(32)}`);
const session: DelegationSession = { chainId: 31337, escrow: `0x${"54".repeat(20)}`, sessionId: 9n, budget: 100n, refundAfter: 3000, safetyMarginSeconds: 300 };
const read: DelegatedRead = { sessionId: session.sessionId, userKey: user.address, nonce: 0n, charge: 10n, readHash: `0x${"ee".repeat(32)}`, expiresAt: 2000 };
const evidence = { readHash: read.readHash, charge: read.charge };
const paths: string[] = [];
const stores: FileDelegationStore[] = [];
const children: ChildProcess[] = [];

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "derpc-delegation-store-"));
  paths.push(path);
  return path;
}
async function open(path: string) {
  const store = await FileDelegationStore.open(path);
  stores.push(store);
  return store;
}
function coordinator(store: FileDelegationStore, overrides: Partial<DelegationOptions<SignedVoucher>> = {}) {
  const signed = vi.fn(async (amount: bigint): Promise<SignedVoucher> => ({ sessionId: session.sessionId, amount, signature: await app.signTypedData(voucherTypedData(session, session.sessionId, amount)) }));
  const verified = vi.fn(async () => evidence);
  const options = { session, store, now: () => 1_000_000, verifyRead: verified, signCumulative: signed, ...overrides };
  return { signer: new CappedDelegationSigner(options), signed, verified, options };
}
async function reopen(path: string): Promise<FileDelegationStore> {
  let last: unknown;
  for (let i = 0; i < 50; i++) {
    try { return await open(path); } catch (error) { last = error; await wait(20); }
  }
  throw last;
}
function helper(path: string): Promise<{ child: ChildProcess; workerPid: number }> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./helpers/store-process.mjs", import.meta.url)), [path], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    const timeout = setTimeout(() => reject(new Error(`store helper did not start: ${stderr}`)), 5000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`store helper exited ${code}: ${stderr}`)); });
    child.on("message", message => {
      const result = message as { type: string; workerPid: number; message?: string };
      if (result.type === "opened") { clearTimeout(timeout); resolve({ child, workerPid: result.workerPid }); }
      if (result.type === "error") { clearTimeout(timeout); reject(new Error(result.message)); }
    });
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), wait(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  for (const store of stores.splice(0)) await store.close().catch(() => {});
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("durable delegated spending store", () => {
  it("persists grants, counters and the highest voucher across a real worker restart", async () => {
    const path = await directory();
    const store = await open(path);
    const first = coordinator(store);
    await first.signer.grant(user.address, 25n, 2000);
    const auth = await user.signTypedData(delegatedReadTypedData(session, read));
    const voucher = await first.signer.approve(read, auth, evidence);
    const oldPid = store.workerPid;
    await store.close();
    const secondStore = await open(path);
    expect(secondStore.workerPid).not.toBe(oldPid);
    const second = coordinator(secondStore);
    const snapshot = await second.signer.snapshot();
    expect(snapshot.total).toBe(10n);
    expect(snapshot.grants[user.address.toLowerCase()]).toMatchObject({ cap: 25n, spent: 10n, nextNonce: 1n });
    expect(snapshot.latestVoucher).toEqual(voucher);
    expect(await second.signer.approve(read, auth, undefined)).toEqual(voucher);
    expect(second.signed).not.toHaveBeenCalled();
    expect(second.verified).not.toHaveBeenCalled();
    const file = (await readdir(path)).find(name => name.endsWith(".json"))!;
    expect((await stat(join(path, file))).mode & 0o777).toBe(0o600);
  }, 10000);

  it("refuses corrupted committed state without replacing it with a fresh spending budget", async () => {
    const path = await directory();
    const store = await open(path);
    const first = coordinator(store);
    await first.signer.grant(user.address, 25n, 2000);
    await first.signer.approve(read, await user.signTypedData(delegatedReadTypedData(session, read)), evidence);
    await store.close();
    const filename = (await readdir(path)).find(name => name.endsWith(".json"))!;
    const target = join(path, filename);
    await writeFile(target, "{truncated committed ledger");
    const brokenStore = await open(path);
    await expect(coordinator(brokenStore).signer.snapshot()).rejects.toThrow();
    await brokenStore.close();
    expect(await readFile(target, "utf8")).toBe("{truncated committed ledger");
    const reopenedStore = await open(path);
    await expect(coordinator(reopenedStore).signer.grant(user.address, 100n, 2000)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("{truncated committed ledger");
  }, 10000);

  it("rejects a store directory accessible by other users before creating lock or state files", async () => {
    const path = await directory();
    await chmod(path, 0o755);
    await expect(open(path)).rejects.toThrow("owner-only directory");
    expect(await readdir(path)).toEqual([]);
  });

  it("rejects a second writer in another process and releases the lock when the owner dies", async () => {
    const path = await directory();
    const owner = await helper(path);
    expect(Number.isSafeInteger(owner.workerPid)).toBe(true);
    await expect(open(path)).rejects.toThrow();
    owner.child.kill("SIGKILL");
    await new Promise<void>(resolve => owner.child.once("exit", () => resolve()));
    const recovered = await reopen(path);
    await coordinator(recovered).signer.grant(user.address, 25n, 2000);
    expect((await coordinator(recovered).signer.snapshot()).grants[user.address.toLowerCase()]?.cap).toBe(25n);
  }, 10000);

  it("rejects an interrupted transaction and retains the last acknowledged state", async () => {
    const path = await directory();
    const store = await open(path);
    const first = coordinator(store);
    await first.signer.grant(user.address, 25n, 2000);
    const snapshot = await first.signer.snapshot();
    await expect(store.transact(snapshot.session, state => {
      state!.grants[bob.address.toLowerCase()] = { cap: 10n, spent: 0n, nextNonce: 0n, expiresAt: 2000, revoked: false };
      process.kill(store.workerPid, "SIGKILL");
      return { state: state!, value: undefined };
    })).rejects.toThrow();
    await store.close();
    const recovered = coordinator(await reopen(path));
    const after = await recovered.signer.snapshot();
    expect(after.grants[user.address.toLowerCase()]?.cap).toBe(25n);
    expect(after.grants[bob.address.toLowerCase()]).toBeUndefined();
    expect(after.total).toBe(0n);
  }, 10000);

  it("preserves a reservation when the signer produced a voucher but its storage acknowledgement is lost", async () => {
    const path = await directory();
    const store = await open(path);
    const first = coordinator(store);
    const crash = new CappedDelegationSigner({
      ...first.options,
      signCumulative: async amount => {
        const voucher = await first.signed(amount);
        process.kill(store.workerPid, "SIGKILL");
        return voucher;
      },
    });
    await crash.grant(user.address, 10n, 2000);
    const auth = await user.signTypedData(delegatedReadTypedData(session, read));
    await expect(crash.approve(read, auth, evidence)).rejects.toThrow();
    expect(first.signed).toHaveBeenCalledExactlyOnceWith(10n);
    await store.close();
    const recovered = coordinator(await reopen(path));
    expect((await recovered.signer.snapshot()).total).toBe(10n);
    expect((await recovered.signer.approve(read, auth, undefined)).amount).toBe(10n);
    expect(recovered.signed).toHaveBeenCalledExactlyOnceWith(10n);
    expect(recovered.verified).not.toHaveBeenCalled();
    expect((await recovered.signer.snapshot()).total).toBe(10n);
    const next = { ...read, nonce: 1n };
    await expect(recovered.signer.approve(next, await user.signTypedData(delegatedReadTypedData(session, next)), evidence)).rejects.toThrow("limit exceeded");
  }, 10000);
});
