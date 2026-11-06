// Keeps the website's directory (web/src/directory) honest against the provider's operator list,
// and proves the directory's validator rejects the mistakes it exists to catch.
import { describe, expect, it } from "vitest";
import { MAINNET_OPERATORS } from "../../src/config/mainnet.ts";
import { isVerified, validateDirectory, type DirectoryOperator, type Network } from "../../../web/src/directory/model.ts";
import { NETWORKS, OPERATORS } from "../../../web/src/directory/operators.ts";

const clone = <T>(x: T): T => structuredClone(x);

describe("directory data", () => {
  it("passes its own invariants", () => {
    expect(validateDirectory(NETWORKS, OPERATORS)).toEqual([]);
  });

  it("lists exactly the operators the provider can use, with the same facts", () => {
    expect(OPERATORS.map((o) => o.ens).sort()).toEqual(MAINNET_OPERATORS.map((o) => o.ens).sort());
    for (const p of MAINNET_OPERATORS) {
      const d = OPERATORS.find((o) => o.ens === p.ens)!;
      expect({ operator: d.operator, website: d.website, endpoint: d.endpoint, tier: d.tier }).toEqual({
        operator: p.operator, website: p.website, endpoint: p.url, tier: p.priority + 1,
      });
    }
  });

  it("marks only Ethereum mainnet as verified, because the provider proves only chain 1", () => {
    expect(NETWORKS.filter((n) => isVerified(NETWORKS, n.id)).map((n) => n.chainId)).toEqual([1]);
  });

  it("gives every operator an Ethereum mainnet entry that DeRPC tested", () => {
    for (const o of OPERATORS) expect(o.networks.find((n) => n.network === "ethereum-mainnet")?.tested).toBe(true);
  });
});

describe("validateDirectory catches", () => {
  const bad = (edit: (nets: Network[], ops: DirectoryOperator[]) => void): string[] => {
    const nets = clone(NETWORKS), ops = clone(OPERATORS);
    edit(nets, ops);
    return validateDirectory(nets, ops);
  };

  it("an unverifiable network marked verified", () => {
    expect(bad((n) => { n.find((x) => x.id === "base")!.verification = "light-client"; }).join()).toMatch(/base is marked verified/);
  });
  it("a claim without a source", () => {
    expect(bad((_, o) => { o[0]!.networks[1]!.source = ""; }).join()).toMatch(/source must be an https URL/);
  });
  it("tested=true on a network DeRPC cannot verify", () => {
    expect(bad((_, o) => { o[0]!.networks[1]!.tested = true; }).join()).toMatch(/tested=true/);
  });
  it("an unknown network, a duplicate network and a duplicate operator", () => {
    expect(bad((_, o) => { o[1]!.networks[0]!.network = "nowhere" as never; }).join()).toMatch(/unknown network nowhere/);
    expect(bad((_, o) => { o[0]!.networks.push({ ...o[0]!.networks[0]! }); }).join()).toMatch(/listed twice/);
    expect(bad((_, o) => { o[1]!.ens = o[0]!.ens; }).join()).toMatch(/duplicate operator/);
  });
  it("an operator with no network", () => {
    expect(bad((_, o) => { o[0]!.networks = []; }).join()).toMatch(/lists no network/);
  });
});
