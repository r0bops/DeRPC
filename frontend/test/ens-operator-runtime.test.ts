// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperatorRuntime } from "../../web/src/ens/runtime.ts";
import { syntheticOperatorManifest } from "./ens-operator-fixture.ts";

const build = { sourceHash: `0x${"01".repeat(32)}`, compiler: { version: "fixture", optimizerRuns: 200, evmVersion: "prague" }, artifact: { abi: [], evm: { deployedBytecode: { object: "00", immutableReferences: {} } } } };
const operator = JSON.parse(readFileSync(new URL("../../contracts/deployments/ens-two-demo-operators-config-2026-11-07.json", import.meta.url), "utf8")).operators[0];
const adminRpcUrls = ["https://one.example", "https://two.example"] as const;
afterEach(() => vi.restoreAllMocks());

describe("operator runtime trust boundary", () => {
  it("keeps an absent configured deployment disabled and does not contact administrative RPCs", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected request"));
    const runtime = createOperatorRuntime({ deployment: null, build, adminRpcUrls });
    expect(runtime.configured).toBe(false);
    expect(() => runtime.join(operator)).toThrow(/disabled/);
    expect(() => runtime.manage({ type: "renew" })).toThrow(/disabled/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts equivalent checksummed pins but refuses a restored input's replacement authority", () => {
    const deployment = syntheticOperatorManifest(build);
    deployment.subregistry = `0x${"cd".repeat(20)}`;
    deployment.registrar = { address: `0x${"ab".repeat(20)}`, codeHash: `0x${"EF".repeat(32)}`, runtimeCodeHash: `0x${"EF".repeat(32)}`, registry: deployment.subregistry, subregistry: deployment.subregistry };
    deployment.upstream.ETHRegistry!.address = deployment.upstream.ETHRegistry!.address.toLowerCase();
    const runtime = createOperatorRuntime({ deployment, build, adminRpcUrls });
    const prepared = runtime.join(operator);
    expect(() => prepared.adapter.validateInput(prepared.config)).not.toThrow();
    expect(prepared.config.directory.registrar.codeHash).toBe(deployment.registrar.codeHash.toLowerCase());
    const changed = structuredClone(prepared.config); changed.directory.registrar.address = `0x${"12".repeat(20)}`;
    expect(() => runtime.restore({ adapter: "operator-join", input: changed })).toThrow(/website's reviewed deployment pins/);
    const owner = structuredClone(prepared.config); owner.curator = `0x${"34".repeat(20)}`;
    expect(() => prepared.adapter.validateInput(owner)).toThrow(/namespace owner/);
  });
});
