import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openFilePaymentStore, type StoredPaymentSession } from "../src/payment-store.ts";

const gate = vi.hoisted(() => ({ rename: undefined as undefined | (() => Promise<void>) }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await gate.rename?.();
      return actual.rename(...args);
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function session(reads: number): StoredPaymentSession {
  const address = `0x${"11".repeat(20)}` as const;
  return {
    version: 1, chainId: 31337, escrow: address, sessionId: "1",
    payer: address, operator: address, sessionKey: address,
    price: "10", deposit: "1000", refundAfter: 2_000_000_000,
    served: reads,
    reads: Object.fromEntries(Array.from({ length: reads }, (_, index) => [
      `0x${(index + 1).toString(16).padStart(64, "0")}`,
      { kind: "proof", requests: {} },
    ])),
    highest: { amount: String(reads * 10), signature: `0x${"22".repeat(65)}` },
    settlement: { state: "open" },
  };
}

describe("payment journal shutdown", () => {
  it.each([false, true])("retains the writer lock until an accepted save finishes (failure: %s)", async failWrite => {
    const directory = await mkdtemp(join(tmpdir(), "derpc-journal-close-"));
    const store = await openFilePaymentStore(directory);
    const entered = deferred(), release = deferred();
    let next: Awaited<ReturnType<typeof openFilePaymentStore>> | undefined;
    let closing: Promise<void> | undefined;
    let saving: Promise<unknown> | undefined;
    try {
      await store.save(session(1));
      gate.rename = async () => {
        entered.resolve();
        await release.promise;
        if (failWrite) throw new Error("simulated disk failure");
      };
      saving = store.save(session(2));
      const saved = saving.then(() => "saved", error => error.message);
      await entered.promise;
      closing = store.close();
      let secondCloseFinished = false;
      const secondClose = store.close().then(() => { secondCloseFinished = true; });
      await expect(openFilePaymentStore(directory).then(value => { next = value; })).rejects.toThrow("already has a writer");
      expect(secondCloseFinished).toBe(false);
      await expect(store.save(session(3))).rejects.toThrow("closed");
      await expect(store.load("1")).rejects.toThrow("closed");
      await expect(store.list()).rejects.toThrow("closed");
      release.resolve();
      expect(await saved).toBe(failWrite ? "simulated disk failure" : "saved");
      await Promise.all([closing, secondClose]);
      gate.rename = undefined;
      next = await openFilePaymentStore(directory);
      expect((await next.load("1"))?.highest?.amount).toBe(failWrite ? "10" : "20");
      await next.save(session(3));
      expect((await next.load("1"))?.highest?.amount).toBe("30");
    } finally {
      release.resolve();
      await saving?.catch(() => {});
      await closing;
      await store.close();
      await next?.close();
      gate.rename = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
