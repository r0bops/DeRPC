import { describe, expect, it, vi } from "vitest";
import { toHex, type Hex } from "viem";
import { readProvenOperators } from "../../src/discovery/registrar.ts";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import type { JsonRpcSend } from "../../src/verify/reader.ts";
import { registrarProofs } from "./proofs.ts";

const owner = `0x${"11".repeat(20)}` as Hex, payee = `0x${"22".repeat(20)}` as Hex;
const now = 1_700_000_000;
const entry = (label = "alice") => ({ label, owner, payee, expiry: now + 3600, active: true });
function setup(entries = [entry()], opts: Parameters<typeof registrarProofs>[1] = {}) {
  const fixture = registrarProofs(entries, opts);
  const header: VerifiedHeader = { slot: 1, blockNumber: 100, blockHash: `0x${"ab".repeat(32)}`, stateRoot: fixture.stateRoot, timestamp: now };
  const sent: { method: string; params: unknown[] }[] = [];
  const send: JsonRpcSend = async (method, params) => { sent.push({ method, params }); return fixture.proof(params[1] as Hex[]); };
  const options = { headers: { finalized: () => header, assertFresh: vi.fn() }, send, registrar: { address: fixture.address, codeHash: fixture.codeHash }, now: () => now * 1000 };
  return { fixture, header, sent, options };
}

describe("storage-proven operator list", () => {
  it("authenticates the full three-slot layout and excludes expired or removed entries", async () => {
    const { options, sent, header } = setup([entry(), { ...entry("bob"), active: false }, { ...entry("carol"), expiry: now }]);
    const result = await readProvenOperators(options);
    expect(result.value).toEqual([{ label: "alice", operator: owner, payee, expiry: now + 3600 }]);
    expect(result.block).toEqual(header);
    expect(sent.every(c => c.method === "eth_getProof" && c.params[2] === "0x64")).toBe(true);
    expect(sent).toHaveLength(2);
  });
  it("chunks all entries into at most 32 storage keys at one fixed block", async () => {
    const { options, sent, header } = setup(Array.from({ length: 12 }, (_, i) => entry(`op${i}`)));
    let nextBlock = false;
    options.headers.finalized = () => { const value = { ...header, blockNumber: nextBlock ? 101 : 100 }; nextBlock = true; return value; };
    expect((await readProvenOperators(options)).value).toHaveLength(12);
    expect(sent.map(c => (c.params[1] as unknown[]).length)).toEqual([1, 32, 4]);
    expect(sent.every(c => c.params[2] === "0x64")).toBe(true);
  });
  it("rejects tampered array values, wrong runtime pins and a too-large list", async () => {
    const fixture = setup();
    const send: JsonRpcSend = async (_method, params) => { const proof = fixture.fixture.proof(params[1] as Hex[]); proof.storageProof[0]!.value = "0x10"; return proof; };
    await expect(readProvenOperators({ ...fixture.options, send })).rejects.toThrow("storage value");
    await expect(readProvenOperators({ ...fixture.options, registrar: { ...fixture.options.registrar, codeHash: `0x${"00".repeat(32)}` } })).rejects.toThrow("trusted pin");
    await expect(readProvenOperators(setup([], { count: 129n }).options)).rejects.toThrow("protocol limit");
  });
  it("rejects truncated proofs, reordered storage proofs and malformed fixed entries", async () => {
    const { options, fixture } = setup();
    const send: JsonRpcSend = async (_method, params) => { const proof = fixture.proof(params[1] as Hex[]); if ((params[1] as Hex[]).length > 1) proof.storageProof.reverse(); return proof; };
    await expect(readProvenOperators({ ...options, send })).rejects.toThrow("not the requested");
    await expect(readProvenOperators({ ...options, send: async () => ({ ...fixture.proof(["0x0"]), storageProof: [] }) })).rejects.toThrow("incomplete");
    await expect(readProvenOperators(setup([entry()], { malformed: new Map([[fixture.base, BigInt(toHex("bad.name", { size: 32 }))]]) }).options)).rejects.toThrow("invalid registrar label");
    await expect(readProvenOperators(setup([entry(), entry()]).options)).rejects.toThrow("duplicate");
    // ENS normalization refuses hyphens in the third and fourth places, and the registrar never lists such a label.
    await expect(readProvenOperators(setup([entry("ab--cd")]).options)).rejects.toThrow("invalid registrar label");
    expect((await readProvenOperators(setup([entry("a--b")]).options)).value[0]!.label).toBe("a--b");
  });
  it("checks cancellation before making a request and freshness after receiving proofs", async () => {
    const { options, sent } = setup();
    await expect(readProvenOperators({ ...options, signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled");
    expect(sent).toEqual([]);
    options.headers.assertFresh.mockImplementationOnce(() => {}).mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("stale"); });
    await expect(readProvenOperators(options)).rejects.toThrow("stale");
  });
});
