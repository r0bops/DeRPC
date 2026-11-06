import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { DelegationState } from "../src/delegation.ts";
import { FileDelegationStore } from "../src/node-store.ts";

const key = `31337:0x${"61".repeat(20)}:9`;
const user = `0x${"62".repeat(20)}`;
const initial = (): DelegationState => ({ session: key, budget: 100n, refundAfter: 3000, total: 0n, grants: {}, reservations: {} });

describe.skipIf(process.platform !== "linux")("unknown commit outcomes", () => {
  it("rereads the committed grant after a real crash between rename and acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "derpc-ack-loss-"));
    const preload = join(directory, "kill-after-rename.mjs");
    const originalOptions = process.env.NODE_OPTIONS;
    let store: FileDelegationStore | undefined;
    try {
      store = await FileDelegationStore.open(directory);
      await store.transact(key, () => ({ state: initial(), value: undefined }));
      await store.close();
      await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (...args) => {
  const result = await rename(...args);
  if (process.argv[1]?.endsWith('/node-worker.ts')) process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
      process.env.NODE_OPTIONS = `${originalOptions ?? ""} --import=${pathToFileURL(preload).href}`;
      store = await FileDelegationStore.open(directory);
      await expect(store.transact(key, state => {
        state!.grants[user] = { cap: 25n, spent: 0n, nextNonce: 0n, expiresAt: 2000, revoked: false };
        return { state: state!, value: undefined };
      })).rejects.toThrow();
      await store.close();
      if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalOptions;
      store = await FileDelegationStore.open(directory);
      const recovered = await store.transact(key, state => ({ state: state!, value: state! }));
      expect(recovered.grants[user]).toEqual({ cap: 25n, spent: 0n, nextNonce: 0n, expiresAt: 2000, revoked: false });
      expect(recovered.total).toBe(0n);
    } finally {
      if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalOptions;
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);

  it("rejects internally valid counter rollback without changing its durable ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "derpc-no-rollback-"));
    const store = await FileDelegationStore.open(directory);
    try {
      const state = initial();
      state.total = 10n;
      state.grants[user] = { cap: 25n, spent: 10n, nextNonce: 1n, expiresAt: 2000, revoked: false };
      state.reservations[`${user}:0`] = { userKey: user as `0x${string}`, nonce: 0n, charge: 10n, cumulative: 10n, digest: `0x${"63".repeat(32)}` };
      await store.transact(key, () => ({ state, value: undefined }));
      await expect(store.transact(key, () => ({ state: initial(), value: undefined }))).rejects.toThrow("rollback");
      const recovered = await store.transact(key, current => ({ state: current!, value: current! }));
      expect(recovered).toEqual(state);
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
