import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSetupRecordProposal } from "../src/setup.ts";

const signer = "0x" + "11".repeat(20);
const key = Buffer.alloc(32, 7);
const checksum = createHash("sha3-256").update(".onion checksum").update(key).update(Uint8Array.of(3)).digest();
const bytes = Buffer.concat([key, checksum.subarray(0, 2), Buffer.of(3)]);
const binary = [...bytes].map(byte => byte.toString(2).padStart(8, "0")).join("");
const onion = binary.match(/.{5}/g)!.map(group => "abcdefghijklmnopqrstuvwxyz234567"[parseInt(group, 2)]).join("") + ".onion";
const base = { name: "alice.derpc.eth", signer, onion };

describe("public wrapper setup proposals", () => {
  it("exports an explicit merge-required node fragment compatible with the provider's canonical schema", async () => {
    // Keep the browser provider's compile-time type graph outside the Node-only wrapper build.
    const schemaModule = new URL("../../provider/src/operators/endpoints.ts", import.meta.url).href;
    const { parseOperatorEndpoints, serializeOperatorEndpoints } = await import(schemaModule);
    const proposal = createSetupRecordProposal({ ...base, endpointId: "node-a" });
    expect(proposal).toMatchObject({ kind: "derpc-endpoint-record-proposal", status: "merge-required-not-published", name: base.name });
    if (!proposal.singleEndpointRecord || !proposal.commonRecords) throw new Error("expected plural proposal");
    expect(proposal.endpoint).toEqual({ id: "node-a", url: `http://${onion}/rpc`, beaconUrl: `http://${onion}/` });
    expect(JSON.parse(proposal.singleEndpointRecord["derpc.endpoints"])).toEqual({ version: 1, endpoints: [proposal.endpoint] });
    expect(parseOperatorEndpoints(proposal.singleEndpointRecord["derpc.endpoints"])).toEqual([proposal.endpoint]);
    expect(serializeOperatorEndpoints([proposal.endpoint])).toBe(proposal.singleEndpointRecord["derpc.endpoints"]);
    expect(proposal.commonRecords["derpc.signer"]).toBe(signer);
    expect(proposal.review).toContain("Preserve sibling IDs and URLs");
    expect(proposal.review).toContain("did not read current ENS records");
    expect(proposal).not.toHaveProperty("derpc.endpoint");
    expect(proposal).not.toHaveProperty("derpc.beacon");
    expect(proposal).not.toHaveProperty("derpc.price");
  });

  it("retains legacy singular output and accepts its original payment records", () => {
    const paymentRecords = { "derpc.price": "10", "derpc.payee": signer };
    const proposal = createSetupRecordProposal({ ...base, paymentRecords });
    expect(proposal).toMatchObject({ name: base.name, "derpc.endpoint": `http://${onion}/rpc`, "derpc.beacon": `http://${onion}`, ...paymentRecords });
    expect(proposal).not.toHaveProperty("singleEndpointRecord");
  });

  it("refuses malformed onion identity, invalid node ID and paid plural proposals", () => {
    expect(() => createSetupRecordProposal({ ...base, onion: "a".repeat(56) + ".onion", endpointId: "node-a" })).toThrow("valid v3 hostname");
    expect(() => createSetupRecordProposal({ ...base, onion: "user:secret@" + onion, endpointId: "node-a" })).toThrow("valid v3 hostname");
    expect(() => createSetupRecordProposal({ ...base, endpointId: "node-" })).toThrow("DERPC_ENDPOINT_ID");
    expect(() => createSetupRecordProposal({ ...base, endpointId: "node-a", paymentRecords: { "derpc.price": "10" } })).toThrow("free-only");
  });

  it("enforces the registrar's 31-character operator label before producing a proposal", () => {
    expect(() => createSetupRecordProposal({ ...base, name: "a".repeat(31) + ".derpc.eth", endpointId: "node-a" })).not.toThrow();
    expect(() => createSetupRecordProposal({ ...base, name: "a".repeat(32) + ".derpc.eth", endpointId: "node-a" })).toThrow("1–31 character label");
  });

  it.each(["main.ts", "setup.ts"])("%s rejects paid plural mode before Docker, key access or listening", script => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../src/${script}`, import.meta.url))], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: "", DERPC_ENS_NAME: base.name, DERPC_SIGNER: signer, DERPC_ENDPOINT_ID: "node-a", DERPC_PAYMENT_ESCROW: signer },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("free-only");
    expect(result.stdout).not.toContain("listening");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it.each(["main.ts", "setup.ts"])("%s rejects malformed IDs before starting a service", script => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../src/${script}`, import.meta.url))], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: "", DERPC_ENS_NAME: base.name, DERPC_SIGNER: signer, DERPC_ENDPOINT_ID: "bad node" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DERPC_ENDPOINT_ID");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it.each(["main.ts", "setup.ts"])("%s rejects an undeployable ENS label before starting a service", script => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../src/${script}`, import.meta.url))], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: "", DERPC_ENS_NAME: "a".repeat(32) + ".derpc.eth", DERPC_SIGNER: signer, DERPC_ENDPOINT_ID: "node-a" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1–31 character label");
    expect(result.stderr).not.toContain("ENOENT");
  });
});
