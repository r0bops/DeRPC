// Check a pinned release against its manifest before the ENS record changes. Read-only. Three checks:
//   default            fetch every file through public IPFS gateways (they rate-limit CI runners)
//   --dir PATH         compare a directory already fetched from the pinning node (`ipfs get CID`)
//   --provider PEERID  confirm the IPFS network lists that node as a provider of the root
// Usage: node scripts/verify-ipfs.mjs [web/out/ipfs-release/manifest.json] [--dir PATH | --provider PEERID | --gateway URL...]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
// {cid} is replaced with the root CID. Subdomain gateways first: they serve the site the way eth.limo does.
export const DEFAULT_GATEWAYS = ["https://{cid}.ipfs.dweb.link", "https://ipfs.io/ipfs/{cid}"];

async function fetchBytes(url, timeoutMs) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Resolves with the gateway that served every file correctly; throws when none did within the attempts. */
export async function verifyRetrieval({ manifest, gateways = DEFAULT_GATEWAYS, attempts = 6, delayMs = 20_000, timeoutMs = 60_000, paceMs = 400, log = console.log }) {
  const paths = Object.keys(manifest.files);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const template of gateways) {
      const base = template.replace("{cid}", manifest.cid);
      try {
        for (const [index, path] of paths.entries()) {
          // Public gateways rate-limit bursts (HTTP 429), so files are fetched one at a time with a pause.
          if (index && paceMs) await new Promise(done => setTimeout(done, paceMs));
          const bytes = await fetchBytes(`${base}/${path}`, timeoutMs);
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== manifest.files[path]) throw new Error(`${path}: bytes differ from the manifest`);
        }
        return { gateway: base, filesChecked: paths.length };
      } catch (error) {
        lastError = `${base}: ${error instanceof Error ? error.message : error}`;
        log(`attempt ${attempt}/${attempts} failed at ${lastError}`);
      }
    }
    if (attempt < attempts) await new Promise(done => setTimeout(done, delayMs));
  }
  throw new Error(`No gateway served all ${paths.length} files. Last error: ${lastError}`);
}

/** Every manifest file must be present with the same bytes, and the directory must hold nothing else. */
export function verifyDirectory({ manifest, dir }) {
  const root = resolve(dir);
  const found = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = resolve(entry.parentPath, entry.name);
    found.set(relative(root, absolute).split(sep).join("/"), createHash("sha256").update(readFileSync(absolute)).digest("hex"));
  }
  for (const [path, digest] of Object.entries(manifest.files)) {
    if (!found.has(path)) throw new Error(`${path}: missing from the fetched directory`);
    if (found.get(path) !== digest) throw new Error(`${path}: bytes differ from the manifest`);
    found.delete(path);
  }
  if (found.size) throw new Error(`unexpected file(s) not in the manifest: ${[...found.keys()].slice(0, 5).join(", ")}`);
  return { filesChecked: Object.keys(manifest.files).length };
}

export const DELEGATED_ROUTING = "https://delegated-ipfs.dev/routing/v1/providers";

/** True once the public routing service lists `peerId` as a provider of the root; false if it never does. */
export async function findProvider({ cid, peerId, endpoint = DELEGATED_ROUTING, attempts = 6, delayMs = 20_000, timeoutMs = 30_000, log = console.log }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${endpoint}/${cid}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (Array.isArray(body?.Providers) && body.Providers.some(provider => provider?.ID === peerId)) return true;
      log(`attempt ${attempt}/${attempts}: ${peerId} is not listed yet`);
    } catch (error) {
      log(`attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : error}`);
    }
    if (attempt < attempts) await new Promise(done => setTimeout(done, delayMs));
  }
  return false;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const valued = ["--gateway", "--dir", "--provider"];
  const option = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const gateways = args.flatMap((arg, index) => arg === "--gateway" && args[index + 1] ? [args[index + 1]] : []);
  const path = args.find((arg, index) => !arg.startsWith("--") && !valued.includes(args[index - 1])) ?? resolve(REPOSITORY, "web/out/ipfs-release/manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(resolve(path), "utf8"));
    if (option("--dir")) {
      const result = verifyDirectory({ manifest, dir: option("--dir") });
      console.log(`PASS: ${result.filesChecked} fetched files match the manifest for ${manifest.cid}.`);
    } else if (option("--provider")) {
      if (!await findProvider({ cid: manifest.cid, peerId: option("--provider") })) throw new Error(`the routing service does not list ${option("--provider")} as a provider of ${manifest.cid}`);
      console.log(`PASS: the IPFS network lists ${option("--provider")} as a provider of ${manifest.cid}.`);
    } else {
      const result = await verifyRetrieval({ manifest, ...(gateways.length ? { gateways } : {}) });
      console.log(`PASS: ${result.filesChecked} files match the manifest through ${result.gateway}.`);
      console.log("This shows public retrieval now, not durable pinning or the ENS record.");
    }
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
