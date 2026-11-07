// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnsDirectory } from "../build/ens-directory.ts";
import viteConfig from "../vite.config.ts";

// Synthetic deployment pins for offline configuration tests only.
const pins = {
  chainId: 1,
  ethRegistry: `0x${"AA".repeat(20)}`,
  registrar: { address: `0x${"BB".repeat(20)}`, codeHash: `0x${"CC".repeat(32)}`, registry: `0x${"DD".repeat(20)}` },
};
const canonical = {
  chainId: 1,
  ethRegistry: `0x${"aa".repeat(20)}`,
  registrar: { address: `0x${"bb".repeat(20)}`, codeHash: `0x${"cc".repeat(32)}`, registry: `0x${"dd".repeat(20)}` },
};
afterEach(() => vi.unstubAllEnvs());

describe("ENS deployment pin configuration", () => {
  it("keeps unset configuration distinct from a configured deployment", () => {
    expect(parseEnsDirectory(undefined)).toBeNull();
    expect(parseEnsDirectory("  ")).toBeNull();
    expect(() => parseEnsDirectory("null")).toThrow("VITE_ENS_DIRECTORY");
  });

  it("canonicalizes a complete mainnet deployment without depending on browser APIs", () => {
    expect(parseEnsDirectory(JSON.stringify(pins))).toEqual(canonical);
  });

  it.each([
    "{", "[]", "false", JSON.stringify({ ...pins, chainId: 11155111 }),
    JSON.stringify({ ...pins, chainId: "1" }),
    JSON.stringify({ ethRegistry: pins.ethRegistry, registrar: pins.registrar }),
    JSON.stringify({ ...pins, ethRegistry: `0x${"00".repeat(20)}` }),
    JSON.stringify({ ...pins, ethRegistry: "0x1234" }),
    JSON.stringify({ ...pins, verifiedRecords: false }),
    JSON.stringify({ ...pins, registrar: { ...pins.registrar, address: "" } }),
    JSON.stringify({ ...pins, registrar: { address: pins.registrar.address, codeHash: pins.registrar.codeHash } }),
    JSON.stringify({ ...pins, registrar: { ...pins.registrar, registry: `0x${"00".repeat(20)}` } }),
    JSON.stringify({ ...pins, registrar: { ...pins.registrar, codeHash: `0x${"00".repeat(32)}` } }),
    JSON.stringify({ ...pins, registrar: { ...pins.registrar, codeHash: "0x1234" } }),
    JSON.stringify({ ...pins, registrar: { ...pins.registrar, extra: true } }),
  ])("refuses invalid or incomplete configuration %# instead of falling back", input => {
    expect(() => parseEnsDirectory(input)).toThrow("VITE_ENS_DIRECTORY");
  });
});

describe("release ENS pin asset", () => {
  const config = viteConfig as unknown as (env: { command: "build"; mode: string }) => {
    envDir: false;
    define: Record<string, string>;
    plugins: { name: string; generateBundle?: (this: { emitFile: ReturnType<typeof vi.fn> }) => void }[];
  };
  function release(input: string | undefined, mode = "production") {
    vi.stubEnv("VITE_TOR_GATEWAYS", "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ");
    vi.stubEnv("VITE_ENS_DIRECTORY", input);
    return config({ command: "build", mode });
  }

  it("refuses incomplete pins during build configuration", () => {
    expect(() => release(JSON.stringify({ chainId: 1 }))).toThrow("VITE_ENS_DIRECTORY");
  });

  it.each(["production", "staging"])("emits explicit null pins on every unconfigured %s release", mode => {
    const built = release(undefined, mode);
    const emitFile = vi.fn();
    built.plugins.find(plugin => plugin.name === "derpc:ens-directory-pin")!.generateBundle!.call({ emitFile });
    expect(built.envDir).toBe(false);
    expect(JSON.parse(built.define["import.meta.env.VITE_ENS_DIRECTORY"]!)).toBe("");
    expect(emitFile).toHaveBeenCalledWith({ type: "asset", fileName: "ens-directory.json", source: "null\n" });
  });

  it("compiles the same canonical pins that it emits for the offline checker", () => {
    const built = release(JSON.stringify(pins));
    const emitFile = vi.fn();
    built.plugins.find(plugin => plugin.name === "derpc:ens-directory-pin")!.generateBundle!.call({ emitFile });
    const emitted = emitFile.mock.calls[0]![0];
    expect(emitted.fileName).toBe("ens-directory.json");
    expect(JSON.parse(emitted.source)).toEqual(canonical);
    expect(parseEnsDirectory(JSON.parse(built.define["import.meta.env.VITE_ENS_DIRECTORY"]!))).toEqual(JSON.parse(emitted.source));
  });
});
