// @vitest-environment node
// The release pipeline derives the ENS contenthash from the IPFS root and checks public retrieval
// against the manifest. Both decide what a name owner signs, so they are tested without a network.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contenthashFromCid } from "../../scripts/package-ipfs.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findProvider, verifyDirectory, verifyRetrieval } from "../../scripts/verify-ipfs.mjs";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(() => vi.unstubAllGlobals());

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

describe("release fetched back from the pinning node", () => {
  const manifest = { cid: "bafybeihuaqdmtdjlu3rcucz2b7qho4flteohpy2zdmttk3nlnkosem4gqa", files: { "index.html": sha256("site"), "demo/index.html": sha256("demo") } };
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const directory = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "derpc-verify-"));
    roots.push(root);
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    return root;
  };

  it("passes only when the directory holds exactly the manifest's files and bytes", () => {
    expect(verifyDirectory({ manifest, dir: directory({ "index.html": "site", "demo/index.html": "demo" }) })).toEqual({ filesChecked: 2 });
    expect(() => verifyDirectory({ manifest, dir: directory({ "index.html": "site", "demo/index.html": "tampered" }) })).toThrow(/bytes differ/);
    expect(() => verifyDirectory({ manifest, dir: directory({ "index.html": "site" }) })).toThrow(/missing/);
    expect(() => verifyDirectory({ manifest, dir: directory({ "index.html": "site", "demo/index.html": "demo", "extra.js": "x" }) })).toThrow(/unexpected/);
  });

  it("reports a provider only when the expected node is listed", async () => {
    const options = { cid: manifest.cid, peerId: "12D3KooWExpected", attempts: 1, delayMs: 0, log: () => {} };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Providers: [{ ID: "12D3KooWExpected" }] }))));
    await expect(findProvider(options)).resolves.toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Providers: [{ ID: "12D3KooWSomeoneElse" }] }))));
    await expect(findProvider(options)).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(findProvider(options)).resolves.toBe(false);
  });
});
