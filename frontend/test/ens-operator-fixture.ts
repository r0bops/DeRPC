import type { OperatorBuild } from "../../web/build/ens-operator.ts";
// @ts-expect-error Shared JavaScript module has no declaration file.
import { UPSTREAM, addresses } from "../../contracts/lib/ens-common.mjs";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** Synthetic format fixture only: no deployment, public receipt or live verification is claimed. */
export function syntheticOperatorManifest(build: OperatorBuild) {
  const subregistry = address(3), registrar = address(4), codeHash = hash(5);
  return {
    schemaVersion: 1, kind: "derpc-ens-deployment", chainId: 1, localOnly: false,
    parentName: "derpc.eth", curator: address(1), deployer: address(2), subregistry,
    registrar: { address: registrar, codeHash, runtimeCodeHash: codeHash, registry: subregistry, subregistry },
    sourceHash: build.sourceHash, compiler: { ...build.compiler },
    observedBlock: { number: "100", hash: hash(100) }, transactions: [],
    verification: { receipts: true, canonicalBlocks: true, stateMatchesConfig: true, hotKeyEventAudit: true, minimumConfirmations: 12 },
    upstream: Object.fromEntries(Object.entries(UPSTREAM.artifacts as Record<string, { address: string; normalizedRuntimeCodeHash: string }>).map(([name, artifact]) => [name, { address: artifact.address, runtimeCodeHash: hash(6), normalizedRuntimeCodeHash: artifact.normalizedRuntimeCodeHash }])),
    operators: [{ name: "fixture.derpc.eth", operator: address(10), coldOwner: address(10), hotKey: address(11), payee: address(10), resolver: address(12), records: { "derpc.endpoint": "https://fixture.example/rpc" } }],
  };
}

export function syntheticOperatorPins(manifest: ReturnType<typeof syntheticOperatorManifest>) {
  return { chainId: 1, ethRegistry: addresses.ETHRegistry, registrar: { address: manifest.registrar.address, codeHash: manifest.registrar.codeHash, registry: manifest.subregistry } };
}
