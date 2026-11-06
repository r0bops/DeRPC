// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRelease } from "../../scripts/check-release.mjs";
import { MAINNET_CHECKPOINT, TOR_JS_DEMO_GATEWAY } from "../../provider/src/config/mainnet.ts";

const CERT = TOR_JS_DEMO_GATEWAY.split(":")[2];
const GATEWAY = `95.216.10.20:12298:${CERT}`;
const CHECKPOINT_TIME = (1_606_824_023 + MAINNET_CHECKPOINT.epoch * 384) * 1000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(gateways = [GATEWAY]) {
  const root = mkdtempSync(join(tmpdir(), "derpc-release-check-"));
  roots.push(root);
  const artifact = join(root, "web/dist");
  const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  for (const path of ["README.md", "THREAT_MODEL.md", "AI_USAGE.md", "specs/OPERATIONS.md", "specs/SUBMISSION.md", "scripts/assemble-site.mjs"]) write(path, "fixture");
  for (const [path, names] of [["package.json", ["build:site", "typecheck"]], ["frontend/package.json", ["build", "test"]], ["web/package.json", ["build", "preview"]]] as const) {
    write(path, JSON.stringify({ scripts: Object.fromEntries(names.map(name => [name, "fixture"])) }));
  }
  write("web/dist/index.html", '<script type="module" src="./assets/site.js"></script>');
  write("web/dist/assets/site.js", "/* site */");
  const entry = '<script type="module" src="./assets/demo.js"></script>';
  write("web/dist/demo/index.html", `${entry}<input id="enable-payments" type="checkbox"><fieldset id="payment-controls" disabled></fieldset>`);
  for (const page of ["example", "network-check"]) write(`web/dist/demo/${page}.html`, entry);
  write("web/dist/demo/assets/demo.js", `const checkpoint=${JSON.stringify(MAINNET_CHECKPOINT)};const gateways=${JSON.stringify(gateways)};const rpc="https://eth.drpc.org";`);
  const run = (extra = {}) => checkRelease({ root, artifact, configuredGateways: GATEWAY, now: CHECKPOINT_TIME + 86_400_000, ...extra });
  return { root, artifact, write, run };
}

describe("offline assembled release check", () => {
  it("accepts a complete site and intentional public RPC URLs without claiming live readiness", () => {
    const report = fixture().run();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.gatewayCount).toBe(1);
    expect(report.limits.join(" ")).toContain("do not establish gateway reachability");
    expect(report.limits.join(" ")).toContain("initial built HTML only");
  });

  it.each([CHECKPOINT_TIME - 1, CHECKPOINT_TIME + 7 * 86_400_000 + 1])("refuses future or expired checkpoint time %s", now => {
    expect(fixture().run({ now }).errors).toContainEqual(expect.objectContaining({ check: "checkpoint" }));
  });

  it("detects a stale build with a different checkpoint or configured gateway", () => {
    const { run, write } = fixture();
    write("web/dist/demo/assets/demo.js", `const oldCheckpoint={epoch:1,root:"0x00"};const gateways=["${TOR_JS_DEMO_GATEWAY}"];`);
    expect(run().errors.map(error => error.check)).toEqual(expect.arrayContaining(["checkpoint-artifact", "gateway-artifact"]));
  });

  it("requires valid explicit gateways and records demo-only availability as unverified", () => {
    const { run } = fixture();
    for (const configuredGateways of [undefined, `kps:${GATEWAY}`, "10.0.0.8:12298:not-a-certificate"]) {
      expect(run({ configuredGateways }).errors).toContainEqual(expect.objectContaining({ check: "gateways" }));
    }
    const report = fixture([TOR_JS_DEMO_GATEWAY]).run({ configuredGateways: TOR_JS_DEMO_GATEWAY });
    expect(report.ok).toBe(true);
    expect(report.warnings).toContainEqual(expect.objectContaining({ check: "demo-gateway" }));
  });

  it("checks every explicitly configured gateway without adding an implicit backup", () => {
    const configuredGateways = `${GATEWAY},${TOR_JS_DEMO_GATEWAY},${GATEWAY}`;
    expect(fixture().run({ configuredGateways }).errors).toContainEqual(expect.objectContaining({ check: "gateway-artifact" }));
    const report = fixture([GATEWAY, TOR_JS_DEMO_GATEWAY]).run({ configuredGateways });
    expect(report.ok).toBe(true);
    expect(report.gatewayCount).toBe(2);
  });

  it("reports missing assembled pages before scanning a non-site target", () => {
    const { root, run } = fixture();
    rmSync(join(root, "web/dist/demo/example.html"));
    const report = run();
    expect(report.filesChecked).toBe(0);
    expect(report.errors).toContainEqual(expect.objectContaining({ check: "pages", path: "demo/example.html" }));
  });

  it("checks relative page assets exist within the release", () => {
    const { run, write } = fixture();
    write("web/dist/index.html", '<script src="./missing.js"></script><link rel="stylesheet" href="/root-only.css">');
    expect(run().errors.filter(error => error.check === "page-assets")).toHaveLength(2);
  });

  it.each([
    '<input id="enable-payments" type="checkbox" checked="false"><fieldset id="payment-controls" disabled></fieldset>',
    '<input id="enable-payments" type="checkbox"><fieldset id="payment-controls"></fieldset>',
  ])("rejects enabled payment markup", html => {
    const { run, write } = fixture();
    write("web/dist/demo/index.html", html);
    expect(run().errors).toContainEqual(expect.objectContaining({ check: "payment-markup" }));
  });

  it("reports LAN and secret patterns by category/path without revealing the matched values", () => {
    const { run, write } = fixture();
    const secret = "ab".repeat(32);
    write("web/dist/assets/leak.js", `const privateKey="0x${secret}";const url="http://10.11.12.13/rpc";`);
    write("web/dist/.env.local", `PERSONAL_TOKEN=${secret}`);
    const report = run();
    expect(report.errors.map(error => error.check)).toEqual(expect.arrayContaining(["artifact-addresses", "artifact-secrets", "artifact-files"]));
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("10.11.12.13");
  });

  it("allows exact node-setup copy only in directory assets while refusing runtime loopback URLs", () => {
    const { run, write } = fixture();
    const instructions = "export DERPC_EXECUTION_URL=http://127.0.0.1:8545\nexport DERPC_BEACON_URL=http://127.0.0.1:5052\n";
    write("web/dist/assets/site.js", `const instructions=${JSON.stringify(instructions)};`);
    expect(run().ok).toBe(true);
    write("web/dist/assets/runtime.js", 'fetch("http://127.0.0.1:8545")');
    write("web/dist/demo/assets/instructions.js", instructions);
    expect(run().errors.filter(error => error.check === "artifact-addresses").map(error => error.path)).toEqual(expect.arrayContaining(["assets/runtime.js", "demo/assets/instructions.js"]));
  });

  it("reports absent release instructions and missing build commands", () => {
    const { run, root, write } = fixture();
    rmSync(join(root, "THREAT_MODEL.md"));
    write("web/package.json", JSON.stringify({ scripts: { build: "vite build" } }));
    expect(run().errors.map(error => error.check)).toEqual(expect.arrayContaining(["release-files", "commands"]));
  });
});
