/**
 * Isolated Firefox benchmark; uses generated trie proofs, never a network RPC.
 * Run from the repo root:
 * node provider/test/execution/browser-measure.mjs --puppeteer=/path/to/puppeteer-core.js
 * Optional: --browser=/path/to/firefox --samples=5
 * Requires the workspace dependencies. Build artifacts and JSON report stay under /tmp.
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createMPT, createMerkleProof } from "@ethereumjs/mpt";
import { createAccount, bytesToHex, hexToBytes } from "@ethereumjs/util";
import { keccak_256 } from "@noble/hashes/sha3";
import { build } from "../../../frontend/node_modules/vite/dist/node/index.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const split = arg.indexOf("=");
  if (split < 0) throw new Error(`Expected --name=value, received ${arg}`);
  return [arg.slice(0, split), arg.slice(split + 1)];
}));
const puppeteerPath = args.get("--puppeteer");
if (!puppeteerPath) throw new Error("Pass --puppeteer=/absolute/path/to/puppeteer-core.js");
const samples = Number(args.get("--samples") ?? 5);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 50) throw new Error("samples must be 1–50");
const puppeteer = (await import(pathToFileURL(resolve(puppeteerPath)).href)).default;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceFilename = join(repository, "provider/src/execution/verified-call.ts");
const sourceHash = async () => createHash("sha256").update(await readFile(sourceFilename)).digest("hex");
const executionSourceSha256 = await sourceHash();
const temporary = await mkdtemp(join(tmpdir(), "derpc-execution-browser-"));
const outDir = join(temporary, "dist");
const contract = `0x${"11".repeat(20)}`;
const caller = `0x${"00".repeat(20)}`;
const feeRecipient = `0x${"22".repeat(20)}`;
const slot = `0x${"00".repeat(32)}`;
const code = "0x60005460005260206000f3"; // SLOAD(0), return the full 32-byte value.
const storage = await createMPT({ useKeyHashing: true });
await storage.put(hexToBytes(slot), Uint8Array.of(42)); // Single-byte RLP encoding.
const account = createAccount({ nonce: 1n, storageRoot: storage.root(), codeHash: keccak_256(hexToBytes(code)) });
const state = await createMPT({ useKeyHashing: true });
await state.put(hexToBytes(contract), account.serialize());
const proofs = {};
for (const address of [contract, caller, feeRecipient]) {
  const entry = address === contract ? account : createAccount({});
  proofs[address] = {
    address, nonce: `0x${entry.nonce.toString(16)}`, balance: `0x${entry.balance.toString(16)}`,
    codeHash: bytesToHex(entry.codeHash), storageHash: bytesToHex(entry.storageRoot),
    accountProof: (await createMerkleProof(state, hexToBytes(address))).map(bytesToHex),
    storageProof: [],
  };
}
const storageProof = { key: slot, value: "0x2a", proof: (await createMerkleProof(storage, hexToBytes(slot))).map(bytesToHex) };
const fixture = { contract, caller, feeRecipient, code, proofs, storageProof, stateRoot: bytesToHex(state.root()) };

await writeFile(join(temporary, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><script type="module" src="/main.js"></script></body></html>');
await writeFile(join(temporary, "main.js"), `
const fixture = ${JSON.stringify(fixture)};
window.runMeasurement = async () => {
  const began = performance.now();
  const { createVerifiedExecutor } = await import(${JSON.stringify(join(repository, "provider/src/execution/index.ts"))});
  const imported = performance.now();
  const calls = [];
  const header = {
    network: "mainnet", slot: 12345678, blockNumber: 26355000, blockHash: "0x" + "33".repeat(32),
    stateRoot: fixture.stateRoot, timestamp: 1793960000,
    execution: { feeRecipient: fixture.feeRecipient, prevRandao: "0x" + "44".repeat(32),
      gasLimit: 30000000n, baseFeePerGas: 1n, excessBlobGas: 0n }
  };
  const executor = createVerifiedExecutor({
    headers: { finalized: () => header, assertFresh: (block) => { if (block !== header) throw Error("changed fixture header"); } },
    send: async (method, params) => {
      calls.push({method, params});
      const [address, keys, tag] = params;
      if (method === "eth_getCode" && address === fixture.contract && keys === "0x" + header.blockNumber.toString(16)) return fixture.code;
      if (method !== "eth_getProof" || tag !== "0x" + header.blockNumber.toString(16)) throw Error("unexpected fixture RPC");
      const proof = structuredClone(fixture.proofs[address]);
      if (!proof) throw Error("unknown fixture address " + address);
      if (keys.length) {
        if (address !== fixture.contract || keys.length !== 1 || BigInt(keys[0]) !== 0n) throw Error("unknown fixture slot");
        proof.storageProof = [structuredClone(fixture.storageProof)];
      }
      return proof;
    },
  });
  const created = performance.now();
  const result = await executor.call({ to: fixture.contract });
  const completed = performance.now();
  if (BigInt(result.value) !== 42n || result.block.stateRoot !== fixture.stateRoot) throw Error("incorrect fixture execution result");
  return { importMs: imported - began, factoryMs: created - imported,
    firstCallMs: completed - created, totalMs: completed - began, result: result.value, calls };
};
`);
await build({ configFile: false, root: temporary, logLevel: "warn", build: {
  outDir, target: "es2022", minify: true, sourcemap: false,
} });

const assets = [];
for (const entry of await readdir(join(outDir, "assets"), { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const bytes = await readFile(join(outDir, "assets", entry.name));
  assets.push({ file: entry.name, rawBytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length });
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const filename = path === "/" ? join(outDir, "index.html") : join(outDir, path);
    if (!filename.startsWith(outDir + "/")) throw Error("invalid path");
    const bytes = await readFile(filename);
    response.writeHead(200, { "Content-Type": filename.endsWith(".js") ? "application/javascript" : "text/html", "Cache-Control": "no-store" });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ browser: "firefox", executablePath: args.get("--browser") ?? "/usr/bin/firefox", headless: true, protocolTimeout: 120_000 });
  const requests = [];
  const externalRequests = [];
  const runs = [];
  for (let i = 0; i < samples; i++) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      requests.push(url);
      if (url.startsWith(origin + "/") || url.startsWith("data:")) void request.continue();
      else { externalRequests.push(url); void request.abort(); }
    });
    await page.goto(origin, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => typeof window.runMeasurement === "function");
    runs.push(await page.evaluate(() => window.runMeasurement()));
    await page.close();
  }
  if (externalRequests.length) throw Error(`Unexpected external requests: ${externalRequests.join(", ")}`);
  if (await sourceHash() !== executionSourceSha256) throw Error("Execution source changed during the measurement; rerun for a consistent source hash");
  const median = (key) => [...runs].map((run) => run[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const report = {
    measuredAt: new Date().toISOString(), browser: await browser.version(), node: process.version,
    scope: "Fresh browser realms; dynamic import over loopback HTTP, factory setup, first local EVM call with generated valid account/storage trie proofs. No live chain, worker, or RPC latency is measured.",
    executionSourceSha256,
    ethereumjsEvmVersion: JSON.parse(await readFile(join(repository, "provider/node_modules/@ethereumjs/evm/package.json"), "utf8")).version,
    assets, totalRawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
    totalGzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    median: Object.fromEntries(["importMs", "factoryMs", "firstCallMs", "totalMs"].map((key) => [key, median(key)])),
    runs, requests, externalRequests, artifactDirectory: temporary,
  };
  await writeFile(join(temporary, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
