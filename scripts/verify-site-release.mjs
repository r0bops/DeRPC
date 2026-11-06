// Read-only release gate. Never imports a CAR or private key, publishes a name, or touches a shared daemon.
// IPFS_BIN=/path/to/ipfs node scripts/verify-site-release.mjs --manifest release/manifest.json --phase pinned --out pinned.json
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contenthashFromCid } from "./package-ipfs.mjs";

export const WEBSITE_NAME = "k51qzi5uqu5dip6ttqcmj10rokc1dq8ppmppbo05grxwha1yvabumx7k1k9jhc";
export const WEBSITE_ORIGIN = "https://derpc.eth.limo";
export const RECORD_URL = `https://delegated-ipfs.dev/routing/v1/ipns/${WEBSITE_NAME}`;
export const PROVIDER_PEER = "/ip4/45.76.81.48/tcp/4001/p2p/12D3KooWJTj1tLNu65UUryNtmuv8Fw6HvKXrF9fNMXRYLvkibEbW";
export const LIMITS = Object.freeze({ totalMs: 480_000, requestMs: 30_000, retryMs: 20_000, manifestBytes: 1_048_576, recordBytes: 16_384, listingBytes: 1_048_576, fileBytes: 16_777_216, totalBytes: 134_217_728, files: 2000 });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const plainObject = value => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function safePath(path) {
  return typeof path === "string" && path.length <= 512 && path.split("/").every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".." && part !== "__proto__");
}

/** Only the package format and canonical UnixFS directory roots produced by our packager are accepted. */
export function validateManifest(input, limits = LIMITS) {
  requireThat(plainObject(input) && input.schemaVersion === 1 && input.kind === "derpc-ipfs-package", "unsupported release manifest");
  const cid = input.cid;
  requireThat(typeof cid === "string" && /^b[a-z2-7]{58}$/.test(cid) && ("abcdefghijklmnopqrstuvwxyz234567".indexOf(cid.at(-1)) & 3) === 0, "non-canonical release CID");
  const contenthash = contenthashFromCid(cid);
  requireThat(input.contentUri === undefined || input.contentUri === `ipfs://${cid}`, "manifest content URI differs from CID");
  requireThat(input.contenthash === undefined || input.contenthash === contenthash, "manifest contenthash differs from CID");
  requireThat(plainObject(input.files), "manifest files must be an object");
  const entries = Object.entries(input.files);
  requireThat(entries.length > 0 && entries.length <= limits.files, "manifest file count exceeds bounds");
  requireThat(input.fileCount === undefined || input.fileCount === entries.length, "manifest file count differs");
  const paths = new Set(entries.map(([path]) => path));
  for (const [path, digest] of entries) {
    requireThat(safePath(path), "unsafe manifest path");
    requireThat(typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest), `invalid SHA-256 for ${path}`);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) requireThat(!paths.has(parts.slice(0, i).join("/")), "manifest file/directory collision");
  }
  requireThat(paths.has("index.html") && paths.has("demo/index.html"), "manifest omits required website pages");
  return { cid, files: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
});

/** Bounds the decoded response body too; Content-Length alone does not protect chunked/compressed bodies. */
export async function fetchBounded(url, { fetchImpl = fetch, signal, maxBytes, timeoutMs = LIMITS.requestMs, accept, method = "GET" } = {}) {
  const scoped = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  const response = await abortable(fetchImpl(url, { method, redirect: "error", signal: scoped, headers: { "cache-control": "no-cache", ...(accept ? { accept } : {}) } }), scoped);
  let reader;
  try {
    requireThat(response.ok, `HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    requireThat(length === null || (/^\d+$/.test(length) && Number(length) <= maxBytes), "response exceeds byte limit");
    requireThat(response.body, "response body is missing");
    reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    for (;;) {
      const item = await abortable(reader.read(), scoped);
      if (item.done) break;
      bytes += item.value.byteLength;
      requireThat(bytes <= maxBytes, "response exceeds byte limit");
      chunks.push(Buffer.from(item.value));
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers, status: response.status };
  } finally {
    // Do not wait on an uncooperative remote stream's cancellation promise.
    if (reader) void reader.cancel().catch(() => {});
    else void response.body?.cancel().catch(() => {});
  }
}

/** No shell, bounded stdout/stderr and a hard kill on deadline/overflow. */
export function runCommand(binary, args, { env, signal, maxBytes = LIMITS.listingBytes, timeoutMs = LIMITS.requestMs, input } = {}) {
  const scoped = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  scoped.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; let size = 0, stderrSize = 0, failure;
    const fail = error => { failure ??= error; child.kill("SIGKILL"); };
    const label = args.find(arg => !arg.startsWith("--")) ?? "command";
    const abort = () => fail(new Error(`Kubo ${label} deadline exceeded`));
    scoped.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => { size += chunk.length; if (size > maxBytes) fail(new Error("Kubo output exceeds byte limit")); else chunks.push(chunk); });
    child.stderr.on("data", chunk => { stderrSize += chunk.length; if (stderrSize > 65536) fail(new Error("Kubo diagnostics exceed byte limit")); });
    child.on("error", error => { failure ??= new Error(`Kubo process could not start (${error.code ?? "unknown"})`); });
    child.on("close", code => {
      scoped.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error(`Kubo ${args.find(arg => !arg.startsWith("--"))} failed (exit ${code})`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Creates a private repository and, only for pinned retrieval, an isolated daemon. */
export async function createFreshKubo({ phase, signal, ipfs = process.env.IPFS_BIN || "ipfs", limits = LIMITS, routing = "none", execute = runCommand, spawnDaemon = spawn, fetchImpl = fetch }) {
  requireThat(routing === "none" || routing === "auto", "invalid isolated routing mode");
  const repo = mkdtempSync(join(tmpdir(), "derpc-release-verifier-"));
  const env = { ...process.env, IPFS_PATH: repo };
  let daemon;
  const command = (args, options = {}) => execute(ipfs, args, { env, signal, timeoutMs: limits.requestMs, ...options });
  const apiUrl = command => {
    const address = readFileSync(join(repo, "api"), "utf8").trim();
    const match = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)$/.exec(address);
    requireThat(match && Number(match[1]) > 0 && Number(match[1]) < 65536, "isolated Kubo API address is invalid");
    return new URL(`http://127.0.0.1:${match[1]}/api/v0/${command}`);
  };
  const close = async () => {
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => daemon.kill("SIGKILL"), 1500);
        daemon.once("exit", () => { clearTimeout(timer); resolve(); });
        daemon.kill("SIGTERM");
      });
    }
    rmSync(repo, { recursive: true, force: true });
  };
  try {
    const version = (await command(["version", "--number"])).toString().trim();
    requireThat(version === "0.43.1", "release verification requires Kubo 0.43.1");
    if (phase === "pinned") {
      await command(["init", "--profile=server"]);
      const configPath = join(repo, "config");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.Addresses.API = "/ip4/127.0.0.1/tcp/0";
      config.Addresses.Gateway = "/ip4/127.0.0.1/tcp/0";
      config.Addresses.Swarm = ["/ip4/0.0.0.0/tcp/0", "/ip4/0.0.0.0/udp/0/quic-v1"];
      config.Swarm.DisableNatPortMap = true;
      config.Datastore.StorageMax = "128MB";
      config.Bootstrap = [];
      config.Routing.Type = routing;
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      daemon = spawnDaemon(ipfs, ["daemon", "--enable-gc"], { env, stdio: "ignore" });
      let daemonError;
      daemon.on("error", () => { daemonError = true; });
      const ready = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      for (;;) {
        ready.throwIfAborted();
        requireThat(!daemonError && daemon.exitCode === null && daemon.signalCode === null, "isolated Kubo daemon exited before readiness");
        // Do not start CLI commands before the API is ready: standalone CLI commands can
        // contend for the repository lock and connect transient peers without the daemon.
        try {
          const response = await fetchBounded(apiUrl("version"), { method: "POST", fetchImpl, signal: ready, maxBytes: 4096, timeoutMs: 1000 });
          requireThat(JSON.parse(response.bytes).Version === version, "isolated Kubo API version differs");
          break;
        }
        catch { await pause(200, ready); }
      }
    }
    // Kubo 0.43.1's CLI ls uses a custom text encoder even with --enc=json.
    // Its owned loopback API exposes the typed UnixFS links needed to reject symlinks/extras.
    const list = async (path, { maxBytes = limits.listingBytes } = {}) => {
      const url = apiUrl("ls");
      url.search = new URLSearchParams({ arg: path, "resolve-type": "true", size: "true" }).toString();
      return (await fetchBounded(url, { method: "POST", fetchImpl, signal, maxBytes, timeoutMs: limits.requestMs })).bytes;
    };
    return { command, list, close, version, routing };
  } catch (error) { await close(); throw error; }
}

/** Enumerates every link before reading any file. Empty extra directories and symlinks also fail. */
export async function verifyPinned(manifest, { node, signal, limits = LIMITS, onStep = () => {} }) {
  onStep({ stage: "connect-public-provider" });
  await node.command(["swarm", "connect", PROVIDER_PEER]);
  const expectedFiles = new Set(Object.keys(manifest.files)), expectedDirectories = new Set([""]);
  for (const path of expectedFiles) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join("/"));
  }
  const found = new Map(), pending = [""], seenDirectories = new Set();
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop(); seenDirectories.add(directory);
    onStep({ stage: "list-ipfs-directory", path: directory || "/" });
    const response = await node.list(`/ipfs/${manifest.cid}${directory ? `/${directory}` : ""}`, { maxBytes: limits.listingBytes });
    requireThat(response.length <= limits.listingBytes, "directory listing exceeds byte limit");
    const listing = JSON.parse(response.toString());
    requireThat(Array.isArray(listing.Objects) && listing.Objects.length === 1 && Array.isArray(listing.Objects[0].Links), "invalid IPFS directory listing");
    const names = new Set();
    for (const link of listing.Objects[0].Links) {
      requireThat(safePath(link.Name) && !link.Name.includes("/") && !names.has(link.Name), "invalid or duplicate IPFS link name");
      names.add(link.Name);
      const path = directory ? `${directory}/${link.Name}` : link.Name;
      if (link.Type === 1) {
        requireThat(expectedDirectories.has(path) && !seenDirectories.has(path), `unexpected directory: ${path}`);
        pending.push(path);
      } else {
        requireThat(link.Type === 2, `unsupported IPFS entry type: ${path}`);
        requireThat(expectedFiles.has(path), `unexpected file: ${path}`);
        requireThat(Number.isSafeInteger(link.Size) && link.Size >= 0 && link.Size <= limits.fileBytes, `file exceeds byte limit: ${path}`);
        found.set(path, link.Size);
      }
    }
  }
  requireThat(found.size === expectedFiles.size && [...expectedFiles].every(path => found.has(path)), "IPFS directory is missing manifest files");
  requireThat([...found.values()].reduce((sum, size) => sum + size, 0) <= limits.totalBytes, "release exceeds total byte limit");
  const files = []; let bytes = 0;
  for (const path of expectedFiles) {
    signal.throwIfAborted();
    onStep({ stage: "hash-ipfs-file", path, filesAlreadyChecked: files.length });
    const body = await node.command(["cat", `/ipfs/${manifest.cid}/${path}`], { maxBytes: Math.min(limits.fileBytes, limits.totalBytes - bytes) });
    bytes += body.length;
    requireThat(body.length <= limits.fileBytes && bytes <= limits.totalBytes, "release exceeds byte limit");
    requireThat(body.length === found.get(path), `IPFS file size differs: ${path}`);
    const digest = sha256(body);
    requireThat(digest === manifest.files[path], `file hash differs: ${path}`);
    files.push({ path, bytes: body.length, sha256: digest });
  }
  return { freshRepository: true, carImported: false, publicIpfsRetrieval: true, explicitPeer: PROVIDER_PEER, peerConnection: { connected: true }, routing: node.routing ?? "none", bootstrapPeers: [], autonomousDiscoveryClaim: false, noExtraEntries: true, filesChecked: files.length, bytes, files };
}

export function verifyIpnsInspection(inspection, cid, now = Date.now()) {
  requireThat(inspection?.Validation?.Valid === true && inspection.Validation.Name === WEBSITE_NAME, "IPNS signature/name verification failed");
  const entry = inspection.Entry;
  requireThat(entry?.Value === `/ipfs/${cid}`, "IPNS target is stale or differs from release CID");
  requireThat(entry.ValidityType === 0 && typeof entry.Validity === "string" && Number.isFinite(Date.parse(entry.Validity)) && Date.parse(entry.Validity) > now, "IPNS record is expired or has invalid validity");
  requireThat(Number.isSafeInteger(entry.Sequence) && entry.Sequence >= 0, "IPNS sequence is invalid");
  return { signatureVerified: true, name: WEBSITE_NAME, target: entry.Value, validity: entry.Validity, sequence: entry.Sequence, ttlNanoseconds: entry.TTL };
}

/** Every attempt starts over: successes from different stale releases cannot form a partial pass. */
export async function verifyPublished(manifest, { node, signal, limits = LIMITS, fetchImpl = fetch, sleep = pause, now = Date.now, maxAttempts = 25, onAttempt = () => {}, onStep = () => {} }) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted();
    const began = now();
    try {
      onStep({ stage: "fetch-signed-ipns-record", attempt });
      const record = await fetchBounded(RECORD_URL, { fetchImpl, signal, maxBytes: limits.recordBytes, timeoutMs: limits.requestMs, accept: "application/vnd.ipfs.ipns-record" });
      const inspected = await node.command(["--offline", "name", "inspect", `--verify=${WEBSITE_NAME}`, "--dump=false", "--enc=json"], { input: record.bytes, maxBytes: limits.recordBytes });
      requireThat(inspected.length <= limits.recordBytes, "IPNS inspection exceeds byte limit");
      const inspection = JSON.parse(inspected.toString());
      const binding = verifyIpnsInspection(inspection, manifest.cid, now());
      const files = []; let bytes = 0;
      for (const [path, expected] of Object.entries(manifest.files)) {
        onStep({ stage: "hash-https-file", path, attempt, filesAlreadyChecked: files.length });
        const response = await fetchBounded(`${WEBSITE_ORIGIN}/${path}`, { fetchImpl, signal, maxBytes: Math.min(limits.fileBytes, limits.totalBytes - bytes), timeoutMs: limits.requestMs });
        const ipfsPath = response.headers.get("x-ipfs-path"), roots = response.headers.get("x-ipfs-roots");
        requireThat(ipfsPath === `/ipns/${WEBSITE_NAME}/${path}`, `HTTPS IPNS path differs: ${path}`);
        requireThat(roots && roots.length <= 8192 && roots.split(",").map(root => root.trim())[0] === manifest.cid, `HTTPS root differs: ${path}`);
        const digest = sha256(response.bytes); bytes += response.bytes.length;
        requireThat(digest === expected, `HTTPS file hash differs: ${path}`);
        files.push({ path, bytes: response.bytes.length, sha256: digest, ipfsPath, ipfsRoots: roots });
      }
      verifyIpnsInspection(inspection, manifest.cid, now());
      attempts.push({ attempt, durationMs: now() - began, ok: true }); onAttempt(attempts.at(-1));
      return { recordSource: RECORD_URL, recordSha256: sha256(record.bytes), recordBytes: record.bytes.length, binding, origin: WEBSITE_ORIGIN, filesChecked: files.length, bytes, files, attempts };
    } catch (error) {
      attempts.push({ attempt, durationMs: now() - began, ok: false, error: String(error.message).slice(0, 500) }); onAttempt(attempts.at(-1));
      signal.throwIfAborted();
      if (attempt === maxAttempts) throw new Error(`Published release did not verify: ${error.message}`);
      await sleep(limits.retryMs, signal);
    }
  }
}

/** Returns durable failure evidence as well as successes; the CLI exits nonzero on failure. */
export async function verifySiteRelease({ manifest, phase, ipfs, limits = LIMITS, signal: outerSignal }, dependencies = {}) {
  const startedAt = new Date().toISOString();
  const report = { schemaVersion: 1, kind: "derpc-site-release-verification", phase, startedAt, expectedIpnsName: WEBSITE_NAME, expectedOrigin: WEBSITE_ORIGIN, ok: false, limits, attempts: [] };
  const signal = AbortSignal.any([outerSignal ?? new AbortController().signal, AbortSignal.timeout(limits.totalMs)]);
  let node;
  try {
    requireThat(phase === "pinned" || phase === "published", "phase must be pinned or published");
    const checked = validateManifest(manifest, limits); report.cid = checked.cid;
    report.manifestFilesSha256 = sha256(JSON.stringify(checked));
    report.lastStep = { stage: "create-isolated-kubo" };
    node = await (dependencies.createNode ?? createFreshKubo)({ phase, signal, ipfs, limits });
    report.kuboVersion = node.version;
    const onStep = entry => { report.lastStep = { ...entry, at: new Date().toISOString() }; };
    report.verification = phase === "pinned"
      ? await verifyPinned(checked, { node, signal, limits, onStep })
      : await verifyPublished(checked, { ...dependencies, node, signal, limits, onStep, onAttempt: entry => report.attempts.push(entry) });
    report.ok = true;
  } catch (error) { report.error = String(error.message ?? error).slice(0, 1000); }
  finally {
    if (node) {
      try { await node.close(); report.ownedResourcesCleaned = true; }
      catch { report.ownedResourcesCleaned = false; report.ok = false; report.cleanupError = "isolated Kubo cleanup failed"; }
    }
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

async function cli(args) {
  const options = {};
  requireThat(args.length === 6, "usage: --manifest PATH --phase pinned|published --out PATH");
  for (let i = 0; i < args.length; i += 2) {
    requireThat(["--manifest", "--phase", "--out"].includes(args[i]) && !Object.hasOwn(options, args[i]) && args[i + 1] && !args[i + 1].startsWith("--"), "invalid or duplicate CLI option");
    options[args[i]] = args[i + 1];
  }
  let report;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("release verification interrupted"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    requireThat(statSync(options["--manifest"]).size <= LIMITS.manifestBytes, "manifest exceeds byte limit");
    const raw = readFileSync(options["--manifest"]);
    requireThat(raw.length <= LIMITS.manifestBytes, "manifest exceeds byte limit");
    report = await verifySiteRelease({ manifest: JSON.parse(raw), phase: options["--phase"], signal: controller.signal });
    report.manifestSha256 = sha256(raw);
  } catch (error) { report = { schemaVersion: 1, kind: "derpc-site-release-verification", phase: options["--phase"], ok: false, error: String(error.message).slice(0, 1000) }; }
  finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
  writeFileSync(resolve(options["--out"]), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, phase: report.phase, cid: report.cid, filesChecked: report.verification?.filesChecked, error: report.error }));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  cli(process.argv.slice(2)).catch(error => { console.error(`Release verification failed: ${error.message}`); process.exitCode = 1; });
}
