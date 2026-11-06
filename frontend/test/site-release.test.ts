// @vitest-environment node
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFreshKubo, fetchBounded, LIMITS, PROVIDER_PEER, readManifestFile, RECORD_URL, runCommand, validateManifest, verifyIpnsInspection, verifyPinned, verifyPublished, verifySiteRelease, WEBSITE_NAME, WEBSITE_ORIGIN } from "../../scripts/verify-site-release.mjs";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const CID = "bafybeihuaqdmtdjlu3rcucz2b7qho4flteohpy2zdmttk3nlnkosem4gqa";
const OLD = "bafybeidksnvtvc7n4ciiflw7o2gc563lqaxtulmqix2cxvddvhc4sv24me";
const pages: Record<string, string> = { "index.html": "site", "demo/index.html": "demo" };
const manifest = () => ({ schemaVersion: 1, kind: "derpc-ipfs-package", cid: CID, fileCount: 2, files: Object.fromEntries(Object.entries(pages).map(([path, body]) => [path, hash(body)])) });
const signal = () => new AbortController().signal;
const inspection = (cid = CID) => ({ Validation: { Valid: true, Name: WEBSITE_NAME }, Entry: { Value: `/ipfs/${cid}`, ValidityType: 0, Validity: "2099-01-01T00:00:00Z", Sequence: 3, TTL: 300_000_000_000 } });
function https(path: string, body = pages[path], root = CID, ipfsPath = `/ipns/${WEBSITE_NAME}/${path}`) {
  return new Response(body, { headers: { "x-ipfs-path": ipfsPath, "x-ipfs-roots": `${root},bafkreifile` } });
}
function publishedFixture() {
  const fetchImpl = vi.fn(async (url: string) => url === RECORD_URL ? new Response("signed-record") : https(url.slice(WEBSITE_ORIGIN.length + 1)));
  const command = vi.fn(async () => Buffer.from(JSON.stringify(inspection())));
  const node = { command, close: vi.fn(async () => {}), version: "0.43.1" };
  return { node, fetchImpl, signal: signal(), maxAttempts: 1, sleep: vi.fn(async () => {}) };
}
function pinnedFixture() {
  const links: Record<string, unknown[]> = {
    "": [{ Name: "index.html", Type: 2, Size: 4 }, { Name: "demo", Type: 1, Size: 0 }],
    demo: [{ Name: "index.html", Type: 2, Size: 4 }],
  };
  const command = vi.fn(async (args: string[]) => {
    if (args[0] === "swarm") return Buffer.from("connected");
    const path = args.at(-1)!.slice(`/ipfs/${CID}`.length).replace(/^\//, "");
    if (args[0] === "ls") return Buffer.from(JSON.stringify({ Objects: [{ Links: links[path] }] }));
    if (args[0] === "cat") return Buffer.from(pages[path]);
    throw new Error("unexpected command");
  });
  return { links, node: { command, list: (path: string) => command(["ls", path]), close: vi.fn(async () => {}), version: "0.43.1" }, signal: signal() };
}

describe("release manifest boundary", () => {
  it("accepts the canonical package and rejects mismatched roots/counts", () => {
    expect(validateManifest(manifest()).cid).toBe(CID);
    expect(() => validateManifest({ ...manifest(), contentUri: `ipfs://${OLD}` })).toThrow(/URI/);
    expect(() => validateManifest({ ...manifest(), contenthash: "0xe30100" })).toThrow(/contenthash/);
    expect(() => validateManifest({ ...manifest(), fileCount: 3 })).toThrow(/count/);
    expect(() => validateManifest({ ...manifest(), cid: CID.slice(0, -1) + "b" })).toThrow(/canonical/);
    expect(() => validateManifest({ ...manifest(), cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" })).toThrow(/directory/);
  });
  it.each(["../secret", "/index.html", "demo//x", "demo/../x", "demo/%2e%2e/x", "demo\\x", "x?query", "x#fragment", "x\nname", "terminal\n", "terminal\r", "terminal\u2028", "__proto__"])("rejects malicious path %j", path => {
    expect(() => validateManifest({ ...manifest(), fileCount: 3, files: { ...manifest().files, [path]: hash("evil") } })).toThrow(/path/);
  });
  it("rejects file/directory collisions, invalid hashes, missing pages and excessive entries", () => {
    expect(() => validateManifest({ ...manifest(), fileCount: 3, files: { ...manifest().files, demo: hash("x") } })).toThrow(/collision/);
    expect(() => validateManifest({ ...manifest(), files: { ...manifest().files, "index.html": "00" } })).toThrow(/SHA/);
    expect(() => validateManifest({ ...manifest(), files: { ...manifest().files, "index.html": hash("site") + "\n" } })).toThrow(/SHA/);
    expect(() => validateManifest({ ...manifest(), fileCount: 1, files: { "index.html": hash("site") } })).toThrow(/required/);
    expect(() => validateManifest(manifest(), { ...LIMITS, files: 1 })).toThrow(/bounds/);
  });
});

describe("independent native IPFS retrieval", () => {
  it("enumerates and hashes all files, discloses explicit peer use and never imports content", async () => {
    const fixture = pinnedFixture();
    const result = await verifyPinned(validateManifest(manifest()), fixture);
    expect(result).toMatchObject({ filesChecked: 2, bytes: 8, noExtraEntries: true, carImported: false, explicitPeer: PROVIDER_PEER, autonomousDiscoveryClaim: false });
    expect(fixture.node.command.mock.calls[0][0]).toEqual(["swarm", "connect", PROVIDER_PEER]);
    expect(fixture.node.command.mock.calls.every(([args]) => ["swarm", "ls", "cat"].includes(args[0]))).toBe(true);
  });
  it.each([
    [{ Name: "extra.txt", Type: 2, Size: 0 }, /unexpected file/],
    [{ Name: "empty", Type: 1, Size: 0 }, /unexpected directory/],
    [{ Name: "link", Type: 4, Size: 0 }, /unsupported/],
    [{ Name: "../x", Type: 2, Size: 0 }, /link name/],
    [{ Name: "index.html", Type: 2, Size: 4 }, /duplicate/],
  ])("rejects extra or unsafe DAG entries %j", async (link, error) => {
    const fixture = pinnedFixture(); fixture.links[""].push(link);
    await expect(verifyPinned(validateManifest(manifest()), fixture)).rejects.toThrow(error);
    expect(fixture.node.command.mock.calls.some(([args]) => args[0] === "cat")).toBe(false);
  });
  it("rejects missing files, overlarge files, mismatched bytes and inaccurate advertised sizes", async () => {
    const missing = pinnedFixture(); missing.links.demo = [];
    await expect(verifyPinned(validateManifest(manifest()), missing)).rejects.toThrow(/missing/);
    const oversized = pinnedFixture(); oversized.links.demo = [{ Name: "index.html", Type: 2, Size: LIMITS.fileBytes + 1 }];
    await expect(verifyPinned(validateManifest(manifest()), oversized)).rejects.toThrow(/byte limit/);
    const modified = pinnedFixture(); const wrong = validateManifest(manifest()); wrong.files["demo/index.html"] = hash("wrong");
    await expect(verifyPinned(wrong, modified)).rejects.toThrow(/hash differs/);
    const wrongSize = pinnedFixture(); wrongSize.links.demo = [{ Name: "index.html", Type: 2, Size: 3 }];
    await expect(verifyPinned(validateManifest(manifest()), wrongSize)).rejects.toThrow(/size differs/);
    await expect(verifyPinned(validateManifest(manifest()), { ...pinnedFixture(), limits: { ...LIMITS, totalBytes: 7 } })).rejects.toThrow(/total byte/);
  });
});

describe("signed IPNS and website publication", () => {
  it("requires signature verification for the fixed name, exact root and future validity", () => {
    expect(verifyIpnsInspection(inspection(), CID).signatureVerified).toBe(true);
    const invalid = inspection(); invalid.Validation.Valid = false;
    expect(() => verifyIpnsInspection(invalid, CID)).toThrow(/signature/);
    const wrongName = inspection(); wrongName.Validation.Name = "other";
    expect(() => verifyIpnsInspection(wrongName, CID)).toThrow(/name/);
    expect(() => verifyIpnsInspection(inspection(OLD), CID)).toThrow(/target/);
    const expired = inspection(); expired.Entry.Validity = "2000-01-01T00:00:00Z";
    expect(() => verifyIpnsInspection(expired, CID)).toThrow(/expired/);
    expired.Entry.Validity = "not-a-date";
    expect(() => verifyIpnsInspection(expired, CID)).toThrow(/validity/);
  });
  it("verifies the raw record with Kubo and checks all HTTPS files and gateway bindings", async () => {
    const fixture = publishedFixture();
    const result = await verifyPublished(validateManifest(manifest()), fixture);
    expect(result.filesChecked).toBe(2);
    expect(fixture.node.command.mock.calls[0]).toEqual([
      ["--offline", "name", "inspect", `--verify=${WEBSITE_NAME}`, "--dump=false", "--enc=json"],
      expect.objectContaining({ input: Buffer.from("signed-record"), maxBytes: LIMITS.recordBytes }),
    ]);
    expect(fixture.fetchImpl.mock.calls.map(([url]) => url)).toEqual([RECORD_URL, `${WEBSITE_ORIGIN}/demo/index.html`, `${WEBSITE_ORIGIN}/index.html`]);
  });
  it("retries a stale signed target before fetching any website files", async () => {
    const fixture = publishedFixture(); fixture.node.command.mockResolvedValueOnce(Buffer.from(JSON.stringify(inspection(OLD))));
    const result = await verifyPublished(validateManifest(manifest()), { ...fixture, maxAttempts: 2 });
    expect(result.attempts.map((attempt: { ok: boolean }) => attempt.ok)).toEqual([false, true]);
    expect(fixture.fetchImpl.mock.calls.map(([url]) => url).slice(0, 2)).toEqual([RECORD_URL, RECORD_URL]);
  });
  it("never combines partial success from different attempts", async () => {
    const fixture = publishedFixture(); let attempt = 0;
    fixture.fetchImpl.mockImplementation(async (url: string) => {
      if (url === RECORD_URL) { attempt++; return new Response("signed-record"); }
      const path = url.slice(WEBSITE_ORIGIN.length + 1);
      return https(path, attempt === 1 && path === "index.html" || attempt === 2 && path === "demo/index.html" ? "stale" : pages[path]);
    });
    await expect(verifyPublished(validateManifest(manifest()), { ...fixture, maxAttempts: 2 })).rejects.toThrow(/hash differs/);
  });
  it.each(["missing", "hash", "root", "root-later", "path", "absent-headers"])("refuses %s website evidence", async kind => {
    const fixture = publishedFixture();
    fixture.fetchImpl.mockImplementation(async (url: string) => {
      if (url === RECORD_URL) return new Response("signed-record");
      const path = url.slice(WEBSITE_ORIGIN.length + 1);
      if (kind === "missing") return new Response("missing", { status: 404 });
      if (kind === "absent-headers") return new Response(pages[path]);
      if (kind === "root-later") return new Response(pages[path], { headers: { "x-ipfs-path": `/ipns/${WEBSITE_NAME}/${path}`, "x-ipfs-roots": `${OLD},${CID}` } });
      return https(path, kind === "hash" ? "wrong" : pages[path], kind === "root" ? OLD : CID, kind === "path" ? `/ipfs/${CID}/${path}` : undefined);
    });
    await expect(verifyPublished(validateManifest(manifest()), fixture)).rejects.toThrow(/did not verify/);
  });
  it("checks record expiry again after the last asset", async () => {
    const fixture = publishedFixture(); let current = Date.parse("2098-12-31T23:59:59Z");
    fixture.fetchImpl.mockImplementation(async (url: string) => {
      if (url === RECORD_URL) return new Response("signed-record");
      current = Date.parse("2099-01-01T00:00:01Z");
      return https(url.slice(WEBSITE_ORIGIN.length + 1));
    });
    await expect(verifyPublished(validateManifest(manifest()), { ...fixture, now: () => current })).rejects.toThrow(/expired/);
  });
});

describe("resource and time bounds", () => {
  it("bounds manifest reads and refuses non-regular inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "derpc-manifest-test-"));
    try {
      const path = join(dir, "manifest.json"); writeFileSync(path, "12345");
      expect(() => readManifestFile(path, 4)).toThrow(/byte limit/);
      expect(readManifestFile(path, 5).toString()).toBe("12345");
      expect(() => readManifestFile(dir)).toThrow(/regular/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects partial HTTP status even if returned bytes happen to match", async () => {
    await expect(fetchBounded(WEBSITE_ORIGIN, { fetchImpl: async () => new Response("site", { status: 206 }), signal: signal(), maxBytes: 4 })).rejects.toThrow(/HTTP 206/);
  });
  it("waits on its own loopback API without launching a CLI readiness probe and enumerates via typed JSON API", async () => {
    let repo = "";
    const execute = vi.fn(async (_binary: string, args: string[], { env }: { env: Record<string, string> }) => {
      repo = env.IPFS_PATH;
      if (args[0] === "version") return Buffer.from("0.43.1\n");
      if (args[0] === "init") {
        writeFileSync(join(repo, "config"), JSON.stringify({ Addresses: {}, Swarm: {}, Datastore: {}, Routing: {} }));
        return Buffer.from("");
      }
      throw new Error("unexpected CLI readiness command");
    });
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn((_signal: string) => {
      child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); return true;
    }) });
    const spawnDaemon = vi.fn(() => {
      const config = JSON.parse(readFileSync(join(repo, "config"), "utf8"));
      expect(config).toMatchObject({ Routing: { Type: "auto" }, Bootstrap: [], Addresses: { API: "/ip4/127.0.0.1/tcp/0" } });
      writeFileSync(join(repo, "api"), "/ip4/127.0.0.1/tcp/12345");
      return child;
    });
    const fetchImpl = vi.fn(async (url: URL) => new Response(url.pathname.endsWith("/version") ? JSON.stringify({ Version: "0.43.1" }) : JSON.stringify({ Objects: [{ Links: [] }] })));
    const node = await createFreshKubo({ phase: "pinned", signal: signal(), execute, spawnDaemon, fetchImpl });
    try {
      expect(JSON.parse(await node.list(`/ipfs/${CID}`))).toEqual({ Objects: [{ Links: [] }] });
      expect(execute.mock.calls.map(([, args]) => args[0])).toEqual(["version", "init"]);
      expect(fetchImpl.mock.calls[0]).toEqual([expect.objectContaining({ href: "http://127.0.0.1:12345/api/v0/version" }), expect.objectContaining({ method: "POST" })]);
      expect(fetchImpl.mock.calls[1][0].searchParams.get("arg")).toBe(`/ipfs/${CID}`);
    } finally { await node.close(); }
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(existsSync(repo)).toBe(false);
  });
  it("rejects oversized declared and streamed bodies, including absent Content-Length", async () => {
    const declared = vi.fn(async () => new Response("tiny", { headers: { "content-length": "999" } }));
    await expect(fetchBounded(WEBSITE_ORIGIN, { fetchImpl: declared, signal: signal(), maxBytes: 4 })).rejects.toThrow(/byte limit/);
    let cancelled = false;
    const streamed = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } })));
    await expect(fetchBounded(WEBSITE_ORIGIN, { fetchImpl: streamed, signal: signal(), maxBytes: 4 })).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });
  it("times out a stalled body even when a fetch implementation ignores its signal", async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    await expect(fetchBounded(WEBSITE_ORIGIN, { fetchImpl, signal: signal(), maxBytes: 4, timeoutMs: 20 })).rejects.toThrow();
  });
  it("uses strict redirect handling", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await fetchBounded(WEBSITE_ORIGIN, { fetchImpl, signal: signal(), maxBytes: 4 });
    expect(fetchImpl.mock.calls[0]).toEqual([WEBSITE_ORIGIN, expect.objectContaining({ redirect: "error" })]);
  });
  it("bounds native process output and kills a stalled subprocess", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100))"], { maxBytes: 8 })).rejects.toThrow(/byte limit/);
    await expect(runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 })).rejects.toThrow(/deadline/);
  });
  it("cleans the isolated node after success, partial failure and overall deadline", async () => {
    const success = pinnedFixture();
    expect((await verifySiteRelease({ manifest: manifest(), phase: "pinned" }, { createNode: async () => success.node })).ok).toBe(true);
    expect(success.node.close).toHaveBeenCalledOnce();
    const bad = pinnedFixture(); bad.links.demo = [];
    const failed = await verifySiteRelease({ manifest: manifest(), phase: "pinned" }, { createNode: async () => bad.node });
    expect(failed).toMatchObject({ ok: false, ownedResourcesCleaned: true }); expect(bad.node.close).toHaveBeenCalledOnce();
    const stalled = publishedFixture();
    stalled.fetchImpl.mockImplementation(async () => new Promise<Response>(() => {}));
    const timedOut = await verifySiteRelease({ manifest: manifest(), phase: "published", limits: { ...LIMITS, totalMs: 25 } }, { createNode: async () => stalled.node, fetchImpl: stalled.fetchImpl });
    expect(timedOut).toMatchObject({ ok: false, ownedResourcesCleaned: true }); expect(stalled.node.close).toHaveBeenCalledOnce();
  });
});
