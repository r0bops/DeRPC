// This process owns both the kernel lock and all state-file IO. Never import it in a browser.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { decodeStoreValue, encodeStoreValue, MAX_STATE_BYTES, validateState } from "./node-codec.ts";

const directory = process.argv[2];
if (!directory) throw new Error("store directory missing");
const filename = (session: string) => join(directory, `${createHash("sha256").update(session).digest("hex")}.json`);
const directoryHandle = await open(directory, "r");

// A prior crash may leave an uncommitted temp file; no signature was authorized by that file.
for (const file of await readdir(directory)) if (/^[0-9a-f]{64}\.json\.[0-9a-f]{24}\.tmp$/.test(file)) await rm(join(directory, file));
process.stdout.write('{"ready":true}\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let inputSize = 0;
process.stdin.on("data", chunk => {
  inputSize += chunk.length;
  if (inputSize > MAX_STATE_BYTES + 65536) process.exit(2);
  if (String(chunk).includes("\n")) inputSize = 0;
});

for await (const line of lines) {
  let id: number | undefined;
  try {
    if (Buffer.byteLength(line) > MAX_STATE_BYTES + 32768) throw new Error("store command exceeds limit");
    const request = decodeStoreValue(line) as { id: number; operation: string; session: string; state?: unknown };
    id = request.id;
    if (!Number.isSafeInteger(id) || id < 1 || typeof request.session !== "string" || request.session.length > 256) throw new Error("invalid store command");
    const target = filename(request.session);
    if (request.operation === "read") {
      let state: unknown;
      try {
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error("invalid delegation state file");
          state = decodeStoreValue(await file.readFile("utf8"));
          validateState(state, request.session);
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      process.stdout.write(encodeStoreValue({ id, state }) + "\n");
    } else if (request.operation === "commit") {
      validateState(request.state, request.session);
      const text = encodeStoreValue(request.state);
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("delegation state exceeds size limit");
      const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, target);
      await directoryHandle.sync();
      process.stdout.write(encodeStoreValue({ id, committed: true }) + "\n");
    } else throw new Error("unknown store command");
  } catch (error) {
    process.stdout.write(encodeStoreValue({ id, error: error instanceof Error ? error.message : "store failed" }) + "\n");
    // Unknown durability or malformed persisted state is terminal. A new process must reread disk.
    process.exitCode = 1;
    break;
  }
}
await directoryHandle.close();
lines.close();
process.stdin.destroy();
