// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOperatorBuild, operatorReleaseMetadata, parseOperatorDeployment } from "../../web/build/ens-operator.ts";
// @ts-expect-error Node build adapter is intentionally JavaScript.
import { operatorBuild } from "../../web/build/ens-operator-node.mjs";
import viteConfig, { operatorWalletConfig } from "../../web/vite.config.ts";
import { syntheticOperatorManifest, syntheticOperatorPins } from "./ens-operator-fixture.ts";

const build = operatorBuild();
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture() {
  const manifest = syntheticOperatorManifest(build);
  return { manifest, directory: JSON.stringify(syntheticOperatorPins(manifest)) };
}

describe("operator wallet release configuration", () => {
  it("keeps absent configuration disabled without a network request", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
    for (const input of [undefined, " "]) {
      const deployment = parseOperatorDeployment(input, undefined, build);
      expect(deployment).toBeNull();
      expect(operatorReleaseMetadata(deployment, build)).toMatchObject({ enabled: false, directory: null, manifestHash: null, sourceHash: build.sourceHash });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts only a matching reviewed-format deployment and directory", () => {
    const { manifest, directory } = fixture();
    expect(parseOperatorDeployment(JSON.stringify(manifest), directory, build)).toEqual(manifest);
    expect(operatorReleaseMetadata(manifest, build)).toMatchObject({ enabled: true, directory: JSON.parse(directory), sourceHash: build.sourceHash, compiler: build.compiler });
    expect(() => parseOperatorDeployment(JSON.stringify(manifest), undefined, build)).toThrow("identical reviewed directory pins");
    const changed = JSON.parse(directory); changed.registrar.registry = `0x${"ab".repeat(20)}`;
    expect(() => parseOperatorDeployment(JSON.stringify(manifest), JSON.stringify(changed), build)).toThrow("identical reviewed directory pins");
  });

  it.each(["local", "source", "compiler", "receipts", "canonicalBlocks", "stateMatchesConfig", "hotKeyEventAudit", "confirmations", "upstream"])("refuses invalid %s evidence without enabling the wallet", field => {
    const { manifest, directory } = fixture();
    if (field === "local") manifest.localOnly = true;
    else if (field === "source") manifest.sourceHash = `0x${"ff".repeat(32)}`;
    else if (field === "compiler") manifest.compiler.optimizerRuns++;
    else if (field === "confirmations") manifest.verification.minimumConfirmations = 11;
    else if (field === "upstream") manifest.upstream.ETHRegistry!.normalizedRuntimeCodeHash = `0x${"ff".repeat(32)}`;
    else manifest.verification[field as "receipts"] = false;
    expect(() => parseOperatorDeployment(JSON.stringify(manifest), directory, build)).toThrow("public, source-matched");
  });

  it.each(["null", "[]", "{", " ".repeat(128 * 1024) + "{}"])("refuses malformed or oversized supplied configuration %#", input => {
    expect(() => parseOperatorDeployment(input, fixture().directory, build)).toThrow("VITE_ENS_OPERATOR_DEPLOYMENT");
  });

  it.each(["operator", "registrar", "record", "initial-record", "transaction", "upstream", "upstream-artifact", "nested-scalar", "role-table"])("rejects unexpected nested %s data before browser serialization", field => {
    const { manifest, directory } = fixture();
    const value = "fixture-only-not-a-real-secret";
    if (field === "operator") Object.assign(manifest.operators[0]!, { privateKey: value });
    else if (field === "registrar") Object.assign(manifest.registrar, { localPath: value });
    else if (field === "record") Object.assign(manifest.operators[0]!.records, { privateKey: value });
    else if (field === "initial-record") Object.assign(manifest.operators[0]!, { initialRecords: { privateKey: value } });
    else if (field === "transaction") Object.assign(manifest, { transactions: [{ id: "fixture", privateKey: value }] });
    else if (field === "upstream") Object.assign(manifest.upstream, { privateData: { privateKey: value } });
    else if (field === "upstream-artifact") Object.assign(manifest.upstream.ETHRegistry!, { privateKey: value });
    else if (field === "nested-scalar") Object.assign(manifest, { rpcTrust: { privateKey: value } });
    else Object.assign(manifest, { roleTable: [{ resource: { privateKey: value } }] });
    let error: unknown;
    try { parseOperatorDeployment(JSON.stringify(manifest), directory, build); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain(value);
  });

  it("preserves record initializer order when accepting a public verifier export", () => {
    const { manifest, directory } = fixture();
    Object.assign(manifest.operators[0]!.records, { "derpc.caps": '{"chainId":1,"methods":["eth_getProof","eth_getCode"]}', "derpc.signer": manifest.operators[0]!.operator });
    Object.assign(manifest.operators[0]!, { initialRecords: { ...manifest.operators[0]!.records } });
    const input = JSON.stringify(manifest);
    expect(JSON.stringify(parseOperatorDeployment(input, directory, build))).toBe(input);
  });

  it("exports only the browser runtime subset and detaches mutable compiler arrays", () => {
    const compiled = structuredClone(build);
    Object.assign(compiled, { sourcePath: "/synthetic/compiler-source", paymentCodeHash: "unneeded" });
    Object.assign(compiled.compiler, { invocation: "unneeded" });
    Object.assign(compiled.artifact, { storageLayout: "unneeded" });
    Object.assign(compiled.artifact.evm, { bytecode: { object: "creation-code" } });
    Object.assign(compiled.artifact.evm.deployedBytecode, { sourceMap: "unneeded", generatedSources: ["unneeded"] });
    const browser = browserOperatorBuild(compiled);
    expect(Object.keys(browser)).toEqual(["sourceHash", "compiler", "artifact"]);
    expect(Object.keys(browser.artifact)).toEqual(["abi", "evm"]);
    expect(Object.keys(browser.artifact.evm)).toEqual(["deployedBytecode"]);
    expect(Object.keys(browser.artifact.evm.deployedBytecode)).toEqual(["object", "immutableReferences"]);
    expect(JSON.stringify(browser)).not.toMatch(/sourcePath|sourceMap|generatedSources|storageLayout|creation-code|paymentCodeHash|invocation/);
    expect(browser.artifact.abi).not.toBe(compiled.artifact.abi);
    expect(browser.artifact.evm.deployedBytecode.immutableReferences).not.toBe(compiled.artifact.evm.deployedBytecode.immutableReferences);
    expect(operatorBuild()).toBe(build);
  });

  it("captures shell authority once and emits matching metadata while disabling dotenv loading", () => {
    const { manifest, directory } = fixture();
    vi.stubEnv("VITE_ENS_OPERATOR_DEPLOYMENT", JSON.stringify(manifest)); vi.stubEnv("VITE_ENS_DIRECTORY", directory);
    const plugin = operatorWalletConfig() as unknown as { load: (id: string) => string; generateBundle: (this: { emitFile: ReturnType<typeof vi.fn> }) => void };
    vi.stubEnv("VITE_ENS_OPERATOR_DEPLOYMENT", "invalid later value"); vi.stubEnv("VITE_ENS_DIRECTORY", "invalid later value");
    const body = plugin.load("\0virtual:derpc-ens-operator");
    const payload = JSON.parse(body.slice("export default ".length, -1));
    expect(payload.deployment).toEqual(manifest); expect(payload.build).toEqual(build);
    const emitFile = vi.fn(); plugin.generateBundle.call({ emitFile });
    expect(emitFile).toHaveBeenCalledWith({ type: "asset", fileName: "ens-operator.json", source: `${JSON.stringify(operatorReleaseMetadata(manifest, build), null, 2)}\n` });
    expect(viteConfig).toHaveProperty("envDir", false);
  });
});
