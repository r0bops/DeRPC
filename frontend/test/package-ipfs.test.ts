// @vitest-environment node
// The release pipeline derives the ENS contenthash from the IPFS root and checks public retrieval
// against the manifest. Both decide what a name owner signs, so they are tested without a network.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contenthashFromCid } from "../../scripts/package-ipfs.mjs";
import { findProvider, parseVerificationArgs, verifyDirectory, verifyRetrieval } from "../../scripts/verify-ipfs.mjs";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "derpc-retrieval-"));
  temporaryRoots.push(root);
  const dir = join(root, "fetched");
  mkdirSync(join(dir, "demo"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "site");
  writeFileSync(join(dir, "demo/index.html"), "demo");
  const manifest = { cid: "fixture", files: { "index.html": sha256("site"), "demo/index.html": sha256("demo") } };
  return { root, dir, manifest };
}

describe("contenthash from an IPFS root", () => {
  it("reproduces the pair recorded for the first packaged release", () => {
    // web/deployment-ens-ipfs-2026-11-06.json: Kubo's base16 form of the same CID.
    expect(contenthashFromCid("bafybeihuaqdmtdjlu3rcucz2b7qho4flteohpy2zdmttk3nlnkosem4gqa"))
      .toBe("0xe30101701220f40406c98d2ba6e22a0b3a0fe07770ab991c77e3591b27356dab6a9d22338680");
  });

  it("refuses roots that are not a CIDv1 dag-pb sha2-256 directory", () => {
    expect(() => contenthashFromCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toThrow();
    // A raw-leaf file CID (codec 0x55) must not be published as the site root.
    expect(() => contenthashFromCid("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku")).toThrow();
    expect(() => contenthashFromCid("bafybeihuaq")).toThrow();
    expect(() => contenthashFromCid(undefined as never)).toThrow();
  });
});

describe("public retrieval check", () => {
  const manifest = { cid: "bafybeihuaqdmtdjlu3rcucz2b7qho4flteohpy2zdmttk3nlnkosem4gqa", files: { "index.html": sha256("site"), "demo/index.html": sha256("demo") } };
  const serve = (pages: Record<string, string>) => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = pages[new URL(url).pathname];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  }));
  const options = { manifest, gateways: ["https://{cid}.ipfs.example"], attempts: 1, delayMs: 0, paceMs: 0, log: () => {} };

  it("passes when every file matches the manifest", async () => {
    serve({ "/index.html": "site", "/demo/index.html": "demo" });
    await expect(verifyRetrieval(options)).resolves.toEqual({ gateway: `https://${manifest.cid}.ipfs.example`, filesChecked: 2 });
  });

  it("fails on different bytes or a missing file, and never reports a partial pass", async () => {
    serve({ "/index.html": "site", "/demo/index.html": "tampered" });
    await expect(verifyRetrieval(options)).rejects.toThrow(/bytes differ/);
    serve({ "/index.html": "site" });
    await expect(verifyRetrieval(options)).rejects.toThrow(/HTTP 404/);
  });

  it("tries the next gateway when the first one fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new URL(url).host.endsWith("down.example")
      ? new Response("", { status: 504 })
      : new Response(new URL(url).pathname === "/index.html" ? "site" : "demo")));
    const result = await verifyRetrieval({ ...options, gateways: ["https://{cid}.down.example", "https://{cid}.up.example"] });
    expect(result.gateway).toBe(`https://${manifest.cid}.up.example`);
  });
});

describe("fetched directory check", () => {
  it("checks every nested manifest file and rejects missing, changed or extra files", () => {
    const { dir, manifest } = directoryFixture();
    expect(verifyDirectory({ dir, manifest })).toEqual({ filesChecked: 2 });
    writeFileSync(join(dir, "index.html"), "changed");
    expect(() => verifyDirectory({ dir, manifest })).toThrow(/bytes differ/);
    rmSync(join(dir, "index.html"));
    expect(() => verifyDirectory({ dir, manifest })).toThrow(/missing/);
    writeFileSync(join(dir, "index.html"), "site");
    writeFileSync(join(dir, "extra.html"), "unlisted");
    expect(() => verifyDirectory({ dir, manifest })).toThrow(/unexpected file/);
  });

  it.each(["file", "dir"] as const)("rejects an extra %s symlink even when every manifest file matches", (type) => {
    const { root, dir, manifest } = directoryFixture();
    const target = join(root, "outside");
    if (type === "dir") mkdirSync(target);
    else writeFileSync(target, "owned fixture");
    symlinkSync(target, join(dir, "unlisted-link"), type);
    expect(() => verifyDirectory({ dir, manifest })).toThrow(/symlinks and non-regular files/);
  });

  it("rejects a symlink as the fetched directory itself", () => {
    const { root, dir, manifest } = directoryFixture();
    const alias = join(root, "alias");
    symlinkSync(dir, alias, "dir");
    expect(() => verifyDirectory({ dir: alias, manifest })).toThrow(/real directory/);
  });

  it("rejects a named pipe without opening or waiting on it", () => {
    const { dir, manifest } = directoryFixture();
    execFileSync("mkfifo", [join(dir, "unlisted-pipe")]);
    expect(() => verifyDirectory({ dir, manifest })).toThrow(/symlinks and non-regular files/);
  });
});

describe("verification command options", () => {
  it.each([
    ["--dir", "fetched", "--provider", "peer"],
    ["--dir", "fetched", "--gateway", "https://gateway.example"],
    ["--provider", "peer", "--gateway", "https://gateway.example"],
  ])("refuses mixed verification modes: %s", (...args) => {
    expect(() => parseVerificationArgs(args)).toThrow(/mutually exclusive/);
  });

  it.each(["--dir", "--provider", "--gateway"])("requires a value for %s", (option) => {
    expect(() => parseVerificationArgs([option])).toThrow(/requires a value/);
    expect(() => parseVerificationArgs([option, "--gateway", "https://gateway.example"])).toThrow(/requires a value/);
    expect(() => parseVerificationArgs([option, ""])).toThrow(/requires a value/);
  });

  it("preserves default retrieval and repeated gateway fallback options", () => {
    expect(parseVerificationArgs(["manifest.json"])).toMatchObject({ manifestPath: "manifest.json", mode: "gateway", gateways: [] });
    expect(parseVerificationArgs(["--gateway", "https://first.example", "manifest.json", "--gateway", "https://second.example"]))
      .toMatchObject({ manifestPath: "manifest.json", mode: "gateway", gateways: ["https://first.example", "https://second.example"] });
  });

  it("refuses duplicate single-value options and unknown arguments", () => {
    expect(() => parseVerificationArgs(["--dir", "one", "--dir", "two"])).toThrow(/only once/);
    expect(() => parseVerificationArgs(["--provider", "one", "--provider", "two"])).toThrow(/only once/);
    expect(() => parseVerificationArgs(["--unknown"])).toThrow(/unknown option/);
    expect(() => parseVerificationArgs(["one.json", "two.json"])).toThrow(/unexpected argument/);
  });

  it("rejects mixed modes before trying to read the manifest", () => {
    const { root, dir } = directoryFixture();
    const script = fileURLToPath(new URL("../../scripts/verify-ipfs.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, join(root, "missing-manifest.json"), "--dir", dir, "--provider", "peer"], { encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stdout).not.toContain("PASS");
  });
});

describe("delegated provider listing", () => {
  const options = { cid: "fixture", peerId: "expected-peer", attempts: 2, delayMs: 0, log: () => {} };

  it("retries an unrelated listing and accepts only the requested provider ID", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ Providers: [{ ID: "another-peer" }] }))
      .mockResolvedValueOnce(Response.json({ Providers: [{ ID: "expected-peer" }] }));
    vi.stubGlobal("fetch", fetch);
    await expect(findProvider(options)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns false after bounded failed or malformed responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ Providers: "not a provider list" }));
    vi.stubGlobal("fetch", fetch);
    await expect(findProvider(options)).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
