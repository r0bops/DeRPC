// Package the assembled site (web/dist) for IPFS: a CAR file, its root CID, the ENSIP-7 contenthash
// for derpc.eth, and a manifest with every file's SHA-256. Used by CI and for local releases.
// Offline: it starts no IPFS daemon, publishes nothing and prepares no transaction.
// Usage: IPFS_BIN=/path/to/ipfs node scripts/package-ipfs.mjs [--site web/dist] [--out web/out/ipfs-release]
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
// The settings the first release used; changing any of them changes the CID for the same files.
export const PACKAGING = { cidVersion: 1, rawLeaves: true, chunker: "size-262144" };
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** ENSIP-7 contenthash for an IPFS directory: the ipfs namespace (0xe3 0x01) followed by the binary CIDv1. */
export function contenthashFromCid(cid) {
  if (typeof cid !== "string" || !/^b[a-z2-7]+$/.test(cid)) throw new Error("expected a base32 CIDv1 (multibase prefix b)");
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of cid.slice(1)) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 0xff); }
  }
  // CIDv1, dag-pb (0x70), sha2-256 (0x12) with a 32-byte digest: what `ipfs add` produces for a directory.
  if (bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x70 || bytes[2] !== 0x12 || bytes[3] !== 0x20) {
    throw new Error("expected a CIDv1 dag-pb sha2-256 directory root");
  }
  return `0xe301${Buffer.from(bytes).toString("hex")}`;
}

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");

function listFiles(site) {
  const files = {};
  for (const entry of readdirSync(site, { recursive: true, withFileTypes: true })) {
    const absolute = resolve(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink in site: ${relative(site, absolute)}`);
    if (entry.isFile()) files[relative(site, absolute).split(sep).join("/")] = sha256(absolute);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1));
}

function git(...args) {
  try { return execFileSync("git", args, { cwd: REPOSITORY, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}

export function packageSite({ site = resolve(REPOSITORY, "web/dist"), out = resolve(REPOSITORY, "web/out/ipfs-release"), ipfs = process.env.IPFS_BIN || "ipfs", now = new Date() } = {}) {
  site = resolve(site); out = resolve(out);
  for (const page of ["index.html", "demo/index.html"]) {
    if (!existsSync(join(site, page))) throw new Error(`${page} is missing from ${site}; run pnpm build:site first`);
  }
  mkdirSync(out, { recursive: true });
  const repo = mkdtempSync(join(tmpdir(), "derpc-ipfs-"));
  const env = { ...process.env, IPFS_PATH: repo };
  const run = (...args) => execFileSync(ipfs, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const version = run("version", "--number");
    run("init", "--profile=server");
    const cid = run("--offline", "add", `--cid-version=${PACKAGING.cidVersion}`, `--raw-leaves=${PACKAGING.rawLeaves}`,
      `--chunker=${PACKAGING.chunker}`, "--recursive", "--quieter", site);
    const car = join(out, "site.car");
    const fd = openSync(car, "w");
    try {
      const exported = spawnSync(ipfs, ["--offline", "dag", "export", cid], { env, stdio: ["ignore", fd, "pipe"] });
      if (exported.status !== 0) throw new Error(`ipfs dag export failed: ${exported.stderr}`);
    } finally { closeSync(fd); }
    const files = listFiles(site);
    const manifest = {
      schemaVersion: 1,
      kind: "derpc-ipfs-package",
      createdAt: now.toISOString(),
      status: "packaged-not-published",
      cid,
      contentUri: `ipfs://${cid}`,
      contenthash: contenthashFromCid(cid),
      car: { file: "site.car", sha256: sha256(car), bytes: statSync(car).size },
      packaging: { kuboVersion: version, ...PACKAGING, offline: true },
      source: { gitHead: git("rev-parse", "HEAD"), uncommittedChanges: Boolean(git("status", "--porcelain")) },
      compiledGateways: (process.env.VITE_TOR_GATEWAYS ?? "").split(",").map(value => value.trim()).filter(Boolean),
      fileCount: Object.keys(files).length,
      files,
    };
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  try {
    const manifest = packageSite({ site: option("--site"), out: option("--out") });
    console.log(`Packaged ${manifest.fileCount} files (${manifest.car.bytes} bytes) with Kubo ${manifest.packaging.kuboVersion}.`);
    console.log(`CID:         ${manifest.cid}`);
    console.log(`Contenthash: ${manifest.contenthash}`);
    console.log("Not published: pin the CAR, check retrieval, then the name owner sets the contenthash.");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `cid=${manifest.cid}\ncontenthash=${manifest.contenthash}\n`);
  } catch (error) {
    console.error(`Packaging failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
