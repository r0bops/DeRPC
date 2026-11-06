// Runs OFFLINE by default using the dated recorded mainnet proof/code fixture.
// To recapture, start a disposable Anvil at a recent finalized mainnet block, then set
// DERPC_ENS_EXECUTION_FORK_RPC to its loopback URL and DERPC_ENS_EXECUTION_PROOF_RPC to an
// administrative mainnet source supporting eth_getProof. Explicit output paths are required
// to write a replacement fixture or evidence report; ordinary tests never write to disk.
// Example: DERPC_ENS_EXECUTION_FORK_RPC=http://127.0.0.1:8864 \
// DERPC_ENS_EXECUTION_PROOF_RPC=https://rpc.mevblocker.io \
// DERPC_ENS_EXECUTION_FIXTURE_OUTPUT=test/fixtures/ens-mainnet-execution-2026-11-06.json \
// DERPC_ENS_EXECUTION_REPORT=test/fixtures/ens-mainnet-execution-evidence-2026-11-06.json \
// pnpm --filter @derpc/provider exec vitest run test/execution/verified-ens-mainnet.test.ts
// Capture traces actual deployed contracts and records genuine mainnet proofs/code in memory.
// During verified execution only the recorded fixture is accessible. The injected mainnet root
// is NOT consensus verified here. There is no anonymity or DeRPC public-deployment claim.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex, zeroAddress } from "viem";
import { namehash } from "viem/ens";
import { createVerifiedExecutor, DEFAULT_EXECUTION_LIMITS } from "../../src/execution/verified-call.ts";
import {
  DEFAULT_VERIFIED_ENS_LIMITS, ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT, MAINNET_ENS_UNIVERSAL_RESOLVER_V2,
  resolveVerifiedEns, type VerifiedEnsRecord,
} from "../../src/execution/verified-ens.ts";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import { hexToBytes, type Hex } from "../../src/verify/hex.ts";
import { ProofVerificationError, verifyAccountProof, verifyCode, verifyStorageProof, type AccountProof } from "../../src/verify/index.ts";
import type { JsonRpcSend } from "../../src/verify/reader.ts";

const forkUrl = process.env.DERPC_ENS_EXECUTION_FORK_RPC;
const proofUrl = process.env.DERPC_ENS_EXECUTION_PROOF_RPC;
const captureMode = Boolean(forkUrl || proofUrl);
const fixtureFile = new URL("../fixtures/ens-mainnet-execution-2026-11-06.json", import.meta.url);
const SCOPE = "Actual deployed mainnet code and EIP-1186 proofs; local in-memory transport fixture; injected root is not consensus verified; no anonymity or DeRPC public-deployment claim";
const ROOT_REGISTRY: Hex = "0x2553c09be6447beffdb86fa622ad41fb8f77a91e";
const ETH_REGISTRY: Hex = "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2";
const RESOLVER_IMPLEMENTATION: Hex = "0x565b0f456a04ac9b48758190e90030623cff57c5";
const universalAbi = parseAbi(["function resolveWithGateways(bytes name,bytes data,string[] gateways) view returns(bytes,address)"]);
const addressAbi = parseAbi(["function addr(bytes32 node) view returns(address)"]);
const coinAbi = parseAbi(["function addr(bytes32 node,uint256 coinType) view returns(bytes)"]);
const textAbi = parseAbi(["function text(bytes32 node,string key) view returns(string)"]);
const contentAbi = parseAbi(["function contenthash(bytes32 node) view returns(bytes)"]);
const scenarios: { name: string; record: VerifiedEnsRecord }[] = [
  { name: "vitalik.eth", record: { type: "address" } },
  { name: "derpc.eth", record: { type: "address" } },
  { name: "nick.eth", record: { type: "address" } },
  { name: "vitalik.eth", record: { type: "text", key: "url" } },
  { name: "derpc.eth", record: { type: "text", key: "description" } },
  { name: "vitalik.eth", record: { type: "contenthash" } },
  { name: "vitalik.eth", record: { type: "coinAddress", coinType: 60n } },
];
type Prestate = Record<string, { code?: Hex; storage?: Record<Hex, Hex> }>;
type RpcBlock = {
  number: Hex; hash: Hex; stateRoot: Hex; timestamp: Hex; miner: Hex; mixHash: Hex;
  gasLimit: Hex; baseFeePerGas: Hex; excessBlobGas?: Hex;
};
type FixtureAccount = { code: Hex; proof: AccountProof; slots: Set<string> };
type RequestRecord = { method: string; params: unknown[]; isolationKey: string };
type ArtifactPin = {
  name: string; address: Hex; source: string; normalizedRuntimeCodeHash: Hex;
  runtimeCodeHash: Hex; immutableRanges: { start: number; length: number }[];
};
type RecordedFixture = {
  schemaVersion: 1;
  kind: "derpc-ens-mainnet-execution-fixture";
  capturedAt: string;
  scope: string;
  sourceCommit: string;
  proofSourceOrigin: string;
  block: Omit<VerifiedHeader, "execution"> & {
    execution: { feeRecipient: Hex; prevRandao: Hex; gasLimit: string; baseFeePerGas: string; excessBlobGas?: string };
  };
  sourceArtifactPins: ArtifactPin[];
  cases: { name: string; record: unknown; raw: Hex; resolver: Hex; value: string }[];
  accounts: { address: Hex; code: Hex; proof: AccountProof; slots: string[] }[];
};
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";

function wireName(name: string): Hex {
  const labels = name.split(".").map(label => new TextEncoder().encode(label));
  return toHex(Uint8Array.from([...labels.flatMap(bytes => [bytes.length, ...bytes]), 0]));
}
function profileData(name: string, record: VerifiedEnsRecord): Hex {
  const node = namehash(name);
  if (record.type === "address") return encodeFunctionData({ abi: addressAbi, functionName: "addr", args: [node] });
  if (record.type === "coinAddress") return encodeFunctionData({ abi: coinAbi, functionName: "addr", args: [node, record.coinType] });
  if (record.type === "text") return encodeFunctionData({ abi: textAbi, functionName: "text", args: [node, record.key] });
  return encodeFunctionData({ abi: contentAbi, functionName: "contenthash", args: [node] });
}
function decodeProfile(record: VerifiedEnsRecord, data: Hex): string {
  if (record.type === "address") return decodeFunctionResult({ abi: addressAbi, functionName: "addr", data });
  if (record.type === "coinAddress") return decodeFunctionResult({ abi: coinAbi, functionName: "addr", data });
  if (record.type === "text") return decodeFunctionResult({ abi: textAbi, functionName: "text", data });
  return decodeFunctionResult({ abi: contentAbi, functionName: "contenthash", data });
}

let rpcId = 0;
async function administrativeRpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  // This capture utility has no write, impersonation, or transaction capability.
  if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getProof", "eth_call", "debug_traceCall", "anvil_nodeInfo"].includes(method)) throw new Error("fixture RPC is read-only");
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`administrative fixture RPC returned HTTP ${response.status}`);
  const body = await response.json() as { result: T; error?: { message: string } };
  if (body.error) throw new Error(`administrative ${method}: ${body.error.message}`);
  return body.result;
}

describe("actual deployed ENS Universal Resolver with recorded mainnet proofs", () => {
  let header: VerifiedHeader;
  let tag: Hex;
  const accounts = new Map<string, FixtureAccount>();
  const references: { raw: Hex; resolver: Hex; value: string }[] = [];
  const validations: unknown[] = [];
  const integrityChecks: string[] = [];
  const sourceArtifactChecks: string[] = [];
  const sourceArtifactPins: ArtifactPin[] = [];
  let capturedAt: string;
  let proofSourceOrigin: string;
  let denyNetwork: ReturnType<typeof vi.spyOn> | undefined;

  function validateRecordedState() {
    expect(header.network).toBe("mainnet");
    expect(header.execution).toBeDefined();
    expect(references).toHaveLength(scenarios.length);
    for (const [address, recorded] of accounts) {
      const account = verifyAccountProof({ stateRoot: header.stateRoot, address: address as Hex, proof: recorded.proof });
      verifyCode({ codeHash: account.codeHash, code: recorded.code });
      expect(new Set(recorded.proof.storageProof.map(entry => BigInt(entry.key).toString()))).toEqual(recorded.slots);
      for (const entry of recorded.proof.storageProof) {
        expect(verifyStorageProof({ storageRoot: account.storageRoot, slot: entry.key, proof: entry })).toBe(BigInt(entry.value));
      }
    }
    for (const address of [MAINNET_ENS_UNIVERSAL_RESOLVER_V2, ROOT_REGISTRY, ETH_REGISTRY, RESOLVER_IMPLEMENTATION]) expect(accounts.has(address)).toBe(true);
    expect(sourceArtifactPins).toHaveLength(4);
    for (const pin of sourceArtifactPins) {
      const code = accounts.get(pin.address)!.code;
      expect(keccak256(code)).toBe(pin.runtimeCodeHash);
      const normalized = hexToBytes(code);
      for (const range of pin.immutableRanges) normalized.fill(0, range.start, range.start + range.length);
      expect(keccak256(normalized)).toBe(pin.normalizedRuntimeCodeHash);
      expect(pin.source).toContain(`/${ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT}/contracts/deployments/mainnet/`);
      sourceArtifactChecks.push(pin.name);
    }
  }

  beforeAll(async () => {
    if (!captureMode) {
      denyNetwork = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("recorded ENS integration must remain offline"));
      const recorded = JSON.parse(readFileSync(fixtureFile, "utf8")) as RecordedFixture;
      expect(recorded.schemaVersion).toBe(1);
      expect(recorded.kind).toBe("derpc-ens-mainnet-execution-fixture");
      expect(recorded.sourceCommit).toBe(ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT);
      expect(recorded.scope).toBe(SCOPE);
      capturedAt = recorded.capturedAt;
      proofSourceOrigin = recorded.proofSourceOrigin;
      const execution = recorded.block.execution;
      header = { ...recorded.block, execution: {
        ...execution, gasLimit: BigInt(execution.gasLimit), baseFeePerGas: BigInt(execution.baseFeePerGas),
        excessBlobGas: execution.excessBlobGas === undefined ? undefined : BigInt(execution.excessBlobGas),
      } };
      tag = toHex(header.blockNumber);
      expect(recorded.cases.map(({ name, record }) => ({ name, record }))).toEqual(JSON.parse(json(scenarios)));
      for (const entry of recorded.cases) {
        const [profile, resolver] = decodeFunctionResult({ abi: universalAbi, functionName: "resolveWithGateways", data: entry.raw });
        expect(resolver).toBe(entry.resolver);
        expect(decodeProfile(scenarios[references.length]!.record, profile)).toBe(entry.value);
        references.push({ raw: entry.raw, resolver: entry.resolver, value: entry.value });
      }
      for (const account of recorded.accounts) accounts.set(account.address, { ...account, slots: new Set(account.slots) });
      sourceArtifactPins.push(...recorded.sourceArtifactPins);
      validateRecordedState();
      return;
    }
    if (!forkUrl || !proofUrl) throw new Error("capture requires both explicit fork and administrative proof RPC URLs");
    capturedAt = new Date().toISOString();
    proofSourceOrigin = new URL(proofUrl).origin;
    const loopback = new URL(forkUrl!);
    if (loopback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(loopback.hostname) || loopback.username || loopback.password) throw new Error("fixture requires a credential-free loopback Anvil URL");
    expect(BigInt(await administrativeRpc<Hex>(forkUrl!, "eth_chainId"))).toBe(31337n);
    expect(BigInt(await administrativeRpc<Hex>(proofUrl!, "eth_chainId"))).toBe(1n);
    const info = await administrativeRpc<{ forkConfig?: { forkBlockNumber?: number } }>(forkUrl!, "anvil_nodeInfo");
    if (!Number.isSafeInteger(info.forkConfig?.forkBlockNumber)) throw new Error("fixture requires an actual Anvil fork block");
    tag = toHex(info.forkConfig!.forkBlockNumber!);
    const source = await administrativeRpc<RpcBlock>(proofUrl!, "eth_getBlockByNumber", [tag, false]);
    const fork = await administrativeRpc<RpcBlock>(forkUrl!, "eth_getBlockByNumber", [tag, false]);
    expect(fork.hash).toBe(source.hash);
    expect(fork.stateRoot).toBe(source.stateRoot);
    header = {
      network: "mainnet", slot: 0, blockNumber: Number(BigInt(source.number)), blockHash: source.hash,
      stateRoot: source.stateRoot, timestamp: Number(BigInt(source.timestamp)),
      execution: {
        feeRecipient: source.miner, prevRandao: source.mixHash, gasLimit: BigInt(source.gasLimit),
        baseFeePerGas: BigInt(source.baseFeePerGas),
        ...(source.excessBlobGas === undefined ? {} : { excessBlobGas: BigInt(source.excessBlobGas) }),
      },
    };
    const traced = new Map<string, { code?: Hex; storage: Record<string, Hex> }>();
    for (const scenario of scenarios) {
      const data = encodeFunctionData({ abi: universalAbi, functionName: "resolveWithGateways", args: [wireName(scenario.name), profileData(scenario.name, scenario.record), []] });
      const call = { from: zeroAddress, to: MAINNET_ENS_UNIVERSAL_RESOLVER_V2, data, gas: "0xf4240" };
      const raw = await administrativeRpc<Hex>(forkUrl!, "eth_call", [call, tag]);
      const [profile, resolver] = decodeFunctionResult({ abi: universalAbi, functionName: "resolveWithGateways", data: raw });
      references.push({ raw, resolver, value: decodeProfile(scenario.record, profile) });
      const prestate = await administrativeRpc<Prestate>(forkUrl!, "debug_traceCall", [call, tag, { tracer: "prestateTracer" }]);
      for (const [address, account] of Object.entries(prestate)) {
        const key = address.toLowerCase();
        const prior = traced.get(key);
        traced.set(key, { ...prior, ...account, storage: { ...prior?.storage, ...account.storage } });
      }
    }
    // The standalone EVM initializes its caller account even if an Anvil tracer omits it.
    if (!traced.has(zeroAddress)) traced.set(zeroAddress, { storage: {} });
    for (const [address, prestate] of traced) {
      const slots = Object.keys(prestate.storage) as Hex[];
      const proof = await administrativeRpc<AccountProof>(proofUrl!, "eth_getProof", [address, slots, tag]);
      const code = await administrativeRpc<Hex>(proofUrl!, "eth_getCode", [address, tag]);
      const account = verifyAccountProof({ stateRoot: header.stateRoot, address: address as Hex, proof });
      verifyCode({ codeHash: account.codeHash, code });
      if (prestate.code !== undefined) expect(code).toBe(prestate.code);
      for (const slot of slots) {
        const entry = proof.storageProof.find(item => BigInt(item.key) === BigInt(slot));
        if (!entry) throw new Error(`capture lacks traced storage slot ${address}:${slot}`);
        expect(verifyStorageProof({ storageRoot: account.storageRoot, slot, proof: entry })).toBe(BigInt(prestate.storage[slot]!));
      }
      accounts.set(address, { code, proof, slots: new Set(slots.map(slot => BigInt(slot).toString())) });
    }
    // Verify deployed implementation provenance against official artifacts. The dated fixture
    // records chain bytecode and proofs as test data; it includes no foreign Solidity sources.
    for (const [name, address] of [["UniversalResolverV2", MAINNET_ENS_UNIVERSAL_RESOLVER_V2], ["RootRegistry", ROOT_REGISTRY], ["ETHRegistry", ETH_REGISTRY], ["PermissionedResolverImpl", RESOLVER_IMPLEMENTATION]] as const) {
      const url = `https://raw.githubusercontent.com/ensdomains/contracts-v2/${ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT}/contracts/deployments/mainnet/${name}.json`;
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`official ${name} artifact unavailable: ${response.status}`);
      const artifact = await response.json() as { address: string; deployedBytecode: Hex; immutableReferences: Record<string, { start: number; length: number }[]> };
      expect(artifact.address.toLowerCase()).toBe(address);
      const actual = hexToBytes(accounts.get(address)!.code);
      const expected = hexToBytes(artifact.deployedBytecode);
      for (const range of Object.values(artifact.immutableReferences).flat()) {
        actual.fill(0, range.start, range.start + range.length);
        expected.fill(0, range.start, range.start + range.length);
      }
      expect(keccak256(actual)).toBe(keccak256(expected));
      sourceArtifactPins.push({ name, address, source: url, normalizedRuntimeCodeHash: keccak256(expected),
        runtimeCodeHash: keccak256(accounts.get(address)!.code), immutableRanges: Object.values(artifact.immutableReferences).flat() });
    }
    validateRecordedState();
  }, 180_000);

  function fixtureEndpoint(tamper?: (method: string, response: unknown) => unknown) {
    const calls: RequestRecord[] = [];
    const send: JsonRpcSend = async (method, params, { isolationKey }) => {
      calls.push({ method, params, isolationKey });
      if (params.at(-1) !== tag) throw new Error("recorded fixture refuses an unpinned block");
      const account = accounts.get(String(params[0]).toLowerCase());
      if (!account) throw new Error(`executor touched an untraced account ${params[0]}`);
      let result: unknown;
      if (method === "eth_getCode") result = account.code;
      else if (method === "eth_getProof") {
        const slots = params[1] as Hex[];
        const storageProof = slots.map(slot => {
          if (!account.slots.has(BigInt(slot).toString())) throw new Error(`executor touched an untraced storage slot ${params[0]}:${slot}`);
          return account.proof.storageProof.find(entry => BigInt(entry.key) === BigInt(slot))!;
        });
        result = structuredClone({ ...account.proof, storageProof });
      } else throw new Error(`execution attempted forbidden remote method ${method}`);
      return tamper ? tamper(method, result) : result;
    };
    return { calls, send };
  }

  it.each(scenarios.map((scenario, index) => [scenario.name, scenario.record.type, index] as const))("resolves %s %s with the actual hierarchy and proof-backed EVM", async (_name, _type, index) => {
    const fixture = fixtureEndpoint();
    const headers = { finalized: () => header };
    const executor = createVerifiedExecutor({ headers, send: fixture.send });
    const verifiedCall = vi.fn(executor.call);
    const result = await resolveVerifiedEns({ ...scenarios[index]!, headers, verifiedCall });
    expect(result.value).toBe(references[index]!.value);
    expect(result.resolver).toBe(references[index]!.resolver);
    expect(result.normalizedName).toBe(scenarios[index]!.name);
    expect(result.block).toEqual(header);
    expect(verifiedCall).toHaveBeenCalledOnce();
    expect(fixture.calls.every(call => ["eth_getProof", "eth_getCode"].includes(call.method))).toBe(true);
    expect(new Set(fixture.calls.map(call => call.params.at(-1)))).toEqual(new Set([tag]));
    validations.push({ ...scenarios[index], value: result.value, resolver: result.resolver, verifiedEvmCalls: verifiedCall.mock.calls.length, proofRequests: fixture.calls.filter(call => call.method === "eth_getProof").length, codeRequests: fixture.calls.filter(call => call.method === "eth_getCode").length });
  }, 30_000);

  it("rejects a lie in an actual touched registry storage slot", async () => {
    let altered = false;
    const fixture = fixtureEndpoint((method, response) => {
      if (!altered && method === "eth_getProof" && (response as AccountProof).storageProof.length) {
        const entry = (response as AccountProof).storageProof[0]!;
        entry.value = toHex(BigInt(entry.value) ^ 1n);
        altered = true;
      }
      return response;
    });
    const headers = { finalized: () => header };
    await expect(resolveVerifiedEns({ ...scenarios[0]!, headers, verifiedCall: createVerifiedExecutor({ headers, send: fixture.send }).call })).rejects.toBeInstanceOf(ProofVerificationError);
    expect(altered).toBe(true);
    integrityChecks.push("Altered value in a genuine touched registry storage proof rejected");
  });

  it("rejects altered deployed Universal Resolver code", async () => {
    const fixture = fixtureEndpoint((method, response) => method === "eth_getCode" ? "0x60006000f3" : response);
    const headers = { finalized: () => header };
    await expect(resolveVerifiedEns({ ...scenarios[0]!, headers, verifiedCall: createVerifiedExecutor({ headers, send: fixture.send }).call })).rejects.toBeInstanceOf(ProofVerificationError);
    integrityChecks.push("Altered deployed Universal Resolver code rejected");
  });

  afterAll(() => {
    const offlineFetches = denyNetwork?.mock.calls.length;
    if (denyNetwork) {
      expect(denyNetwork).not.toHaveBeenCalled();
      denyNetwork.mockRestore();
    }
    const complete = validations.length === scenarios.length && integrityChecks.length === 2;
    // Refuse to persist incomplete captures. Neither output is written without an explicit path.
    if (!complete) return;
    if (process.env.DERPC_ENS_EXECUTION_FIXTURE_OUTPUT) {
      if (!captureMode) throw new Error("fixture output is available only in explicit capture mode");
      writeFileSync(process.env.DERPC_ENS_EXECUTION_FIXTURE_OUTPUT, json({
        schemaVersion: 1, kind: "derpc-ens-mainnet-execution-fixture", capturedAt, scope: SCOPE,
        sourceCommit: ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT, proofSourceOrigin, block: header, sourceArtifactPins,
        cases: scenarios.map((scenario, index) => ({ ...scenario, ...references[index] })),
        accounts: [...accounts].map(([address, account]) => ({ address, code: account.code, proof: account.proof, slots: [...account.slots] })),
      }));
    }
    if (!process.env.DERPC_ENS_EXECUTION_REPORT) return;
    const recordedPath = captureMode ? process.env.DERPC_ENS_EXECUTION_FIXTURE_OUTPUT : fixtureFile;
    const fixtureSha256 = recordedPath ? createHash("sha256").update(readFileSync(recordedPath)).digest("hex") : undefined;
    writeFileSync(process.env.DERPC_ENS_EXECUTION_REPORT, json({
      schemaVersion: 1, kind: "derpc-ens-mainnet-execution-evidence", capturedAt, checkedAt: new Date().toISOString(), complete,
      scope: SCOPE, sourceCommit: ENS_UNIVERSAL_RESOLVER_SOURCE_COMMIT, proofSourceOrigin, sourceArtifactChecks, block: header,
      verificationMode: captureMode ? "administrative capture and local execution" : "offline recorded proof replay",
      fixtureSha256,
      reproduce: "pnpm --filter @derpc/provider exec vitest run test/execution/verified-ens-mainnet.test.ts",
      capture: {
        administrativeRpcMethods: ["eth_chainId", "anvil_nodeInfo", "eth_getBlockByNumber", "eth_call", "debug_traceCall", "eth_getProof", "eth_getCode"],
        sourceArtifactReads: "Official HTTPS deployment artifacts at the pinned source commit",
        limits: { rpcTimeoutMs: 30_000, setupTimeoutMs: 180_000, referenceCallGas: "1000000" },
      },
      execution: {
        coreLimits: DEFAULT_EXECUTION_LIMITS, ensLimits: DEFAULT_VERIFIED_ENS_LIMITS,
        verifiedEvmCallsPerResolution: 1, remoteRpcMethods: ["eth_getProof", "eth_getCode"],
        transport: "In-memory recorded proofs and code; no remote eth_call or debug_traceCall",
        offlineNetworkFetches: offlineFetches,
      },
      accounts: [...accounts].map(([address, account]) => ({ address, codeHash: keccak256(account.code), codeBytes: (account.code.length - 2) / 2, storageSlots: account.slots.size })),
      validations, integrityChecks,
    }));
  });
});
