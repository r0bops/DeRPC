// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CERT = "uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
const CURRENT = `10.0.0.138:12298:${CERT}`;
const STALE = `10.0.0.58:12298:${CERT}`;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runHelper(options: { logged: string; existing?: string; shell?: string; interfacesAvailable?: boolean; macos?: boolean; lsofNames?: string[]; expectStatus?: number }) {
  const root = mkdtempSync(join(tmpdir(), "derpc-dev-services-"));
  temporaryRoots.push(root);
  for (const directory of ["scripts", "frontend", ".dev-logs", "node_modules", "bin"]) mkdirSync(join(root, directory));
  const script = join(root, "scripts/dev-services.sh");
  copyFileSync(fileURLToPath(new URL("../../scripts/dev-services.sh", import.meta.url)), script);
  writeFileSync(join(root, ".dev-logs/gateway.log"), `gateway ready at ${options.logged}\n`);
  const envFile = join(root, "frontend/.env.local");
  if (options.existing !== undefined) writeFileSync(envFile, options.existing);
  // Run the real helper with local stand-ins: no sockets, gateway processes, Vite or repository env files.
  const mocks = {
    ss: "printf '%s\\n' 'UNCONN 0 0 0.0.0.0:12298 0.0.0.0:*'",
    ip: "[ \"$QA_IP_STATUS\" = 0 ] || exit \"$QA_IP_STATUS\"\nprintf '%s\\n' '2: eth0 inet 10.0.0.138/24 brd 10.0.0.255 scope global eth0'",
    pnpm: "printf '%s\\n' \"$*\" > \"$QA_PNPM_CALLS\"",
  };
  // macOS ships neither ss nor ip: the helper must use lsof and ifconfig there.
  // lsof -Fn prints one "n<name>" line per socket: "*:12298" when bound, "local->remote" when connected.
  const lsofNames = options.lsofNames ?? ["*:12298"];
  Object.assign(mocks, options.macos
    ? { ss: "exit 127", ip: "exit 127", lsof: `printf '%s\\n' p4242 ${lsofNames.map(name => `'n${name}'`).join(" ")}`, ifconfig: "printf 'en0: flags=8863\\n\\tinet 10.0.0.138 netmask 0xffffff00\\n'" }
    : { ifconfig: "exit 0" });
  for (const [command, body] of Object.entries(mocks)) writeFileSync(join(root, "bin", command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const calls = join(root, "pnpm-calls");
  const result = spawnSync("bash", [script], {
    encoding: "utf8", timeout: 25_000, // macOS scans each new mock script before it first runs
    env: {
      ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
      // Never a real binary: a run that finds no gateway must stop, not start one.
      TOR_JS_GATEWAY: join(root, "no-gateway"),
      VITE_TOR_GATEWAYS: options.shell ?? "", QA_IP_STATUS: options.interfacesAvailable === false ? "1" : "0", QA_PNPM_CALLS: calls,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(options.expectStatus ?? 0);
  if (!options.expectStatus) expect(readFileSync(calls, "utf8")).toBe("dev:site\n");
  return { env: existsSync(envFile) ? readFileSync(envFile, "utf8") : undefined, stdout: result.stdout, stderr: result.stderr };
}

describe("local dev gateway configuration", { timeout: 30_000 }, () => {
  it("finds a running gateway and its address with the macOS tools", () => {
    const { env, stdout } = runHelper({ logged: CURRENT, macos: true });
    expect(stdout).toContain("already listening");
    expect(env).toBe(`VITE_TOR_GATEWAYS=${CURRENT}\n`);
  });

  it("does not take a client socket connected to port 12298 for a running gateway", () => {
    const { stdout, stderr } = runHelper({
      logged: CURRENT, macos: true, expectStatus: 1,
      lsofNames: ["127.0.0.1:60090->127.0.0.1:12298", "[::1]:60091->[::1]:12298"],
    });
    expect(stdout).not.toContain("already listening");
    // With no gateway found and no binary in the temporary root, the helper stops before starting anything.
    expect(stderr).toContain("tor-js-gateway not found");
  });

  it("finds a gateway bound to one address next to a connected client socket", () => {
    const { stdout } = runHelper({ logged: CURRENT, macos: true, lsofNames: ["127.0.0.1:60090->127.0.0.1:12298", "10.0.0.138:12298"] });
    expect(stdout).toContain("already listening");
  });

  it("does not overwrite a corrected address with a surviving gateway's stale log", () => {
    const existing = `OTHER_SETTING=keep\nVITE_TOR_GATEWAYS=${CURRENT}\n`;
    const result = runHelper({ logged: STALE, existing });
    expect(result.env).toBe(existing);
    expect(result.stderr).toContain("not confirmed on a current interface");
  });

  it("updates a stale env address when the advertised address is still assigned", () => {
    const result = runHelper({ logged: CURRENT, existing: `OTHER_SETTING=keep\nVITE_TOR_GATEWAYS=${STALE}\n` });
    expect(result.env).toBe(`OTHER_SETTING=keep\nVITE_TOR_GATEWAYS=${CURRENT}\n`);
  });

  it("creates the local configuration only from a current address", () => {
    expect(runHelper({ logged: CURRENT }).env).toBe(`VITE_TOR_GATEWAYS=${CURRENT}\n`);
    expect(runHelper({ logged: STALE }).env).toBeUndefined();
  });

  it("preserves an explicit shell gateway without rewriting the local file", () => {
    const existing = `VITE_TOR_GATEWAYS=${STALE}\n`;
    const result = runHelper({ logged: CURRENT, existing, shell: `95.216.10.20:12298:${CERT}` });
    expect(result.env).toBe(existing);
    expect(result.stdout).toContain("using VITE_TOR_GATEWAYS from the shell");
  });

  it("preserves local configuration when interface detection is unavailable", () => {
    const existing = `VITE_TOR_GATEWAYS=${CURRENT}\n`;
    const result = runHelper({ logged: CURRENT, existing, interfacesAvailable: false });
    expect(result.env).toBe(existing);
    expect(result.stderr).toContain("not confirmed on a current interface");
  });
});
