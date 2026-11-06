import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { getAddress } from "viem";
import { createOperatorConfigFragment, createOperatorDraft, MAX_DRAFT_NODES, type OperatorDeploymentInput, type OperatorDraftInput } from "../../web/src/directory/operator-draft.ts";
import { parseOperatorEndpoints } from "../../provider/src/operators/endpoints.ts";
import { operatePage } from "../../web/src/pages/operate.ts";

const OWNER = `0x${"11".repeat(20)}`;
const SIGNER = `0x${"22".repeat(20)}`;
const ONION = "g7nasyegiclqszahjp6jnkdrvlzntfams6bgawi6caaprlleq4mc2eid.onion";
const NOW = Date.parse("2026-11-06T15:00:00Z") / 1000;
const deploymentInput = (): OperatorDeploymentInput => ({ coldOwner: `0x${"33".repeat(20)}`, hotKey: `0x${"44".repeat(20)}`, payee: `0x${"55".repeat(20)}`, expiryUtc: "2026-11-07T12:00" });
const fixture = (): OperatorDraftInput => ({
  name: "alice", owner: OWNER, signer: SIGNER,
  nodes: [{ key: "1", label: "Lisbon", endpoint: `http://${ONION}/rpc`, beacon: `http://${ONION}` }],
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("operator onboarding draft", () => {
  it("groups endpoint pairs under one identity without claiming any verification or deployment", () => {
    const input = fixture();
    input.nodes.push({ key: "2", label: "Paris", endpoint: "https://rpc.example/rpc", beacon: "https://beacon.example" });
    const { draft, errors } = createOperatorDraft(input);
    expect(errors).toBeUndefined();
    expect(draft).toMatchObject({ kind: "derpc-operator-onboarding-draft", version: 1, status: "draft-not-registered", name: "alice.derpc.eth", chainId: 1 });
    expect(draft!.nodes).toHaveLength(2);
    expect(draft!.nodes.every(node => node.health === "unchecked")).toBe(true);
    expect(Object.values(draft!.checks)).toEqual(["unchecked", "unchecked", "unchecked", "unchecked"]);
    expect(draft!.economics).toEqual({ mode: "free", planned: { identityStake: "undecided", perNodeStake: "traffic-dependent", pricePerQuery: "operator-configurable" } });
  });

  it.each([
    "http://rpc.example/rpc", "https://user:secret@rpc.example/rpc", "https://rpc.example/?key=secret",
    "https://localhost/rpc", "https://127.0.0.1/rpc", "https://[::1]/rpc", "https://node.local/rpc",
    "javascript:alert(1)", `http://${"a".repeat(56)}.onion/rpc`, "https://rpc.example/#secret",
  ])("rejects unsafe or nonpublic endpoint draft %s", endpoint => {
    const input = fixture();
    input.nodes[0]!.endpoint = endpoint;
    const result = createOperatorDraft(input);
    expect(result.draft).toBeUndefined();
    expect(result.errors?.["node-1-endpoint"]).toBeTruthy();
    expect(JSON.stringify(result.errors)).not.toContain("key=secret");
  });

  it("rejects canonical duplicate endpoints and duplicate node IDs", () => {
    const input = fixture();
    input.nodes[0]!.endpoint = "https://rpc.example";
    input.nodes.push({ key: "1", label: "Duplicate", endpoint: "https://RPC.EXAMPLE/", beacon: "https://beacon.example" });
    const result = createOperatorDraft(input);
    expect(result.errors?.["operator-nodes"]).toContain("unique");
    expect(result.errors?.["node-1-endpoint"]).toContain("already listed");
  });

  it("requires public address syntax, a valid ENS label and a bounded nonempty node list", () => {
    const result = createOperatorDraft({ ...fixture(), name: "alice.ops", owner: `0x${"00".repeat(20)}`, signer: `0x${"11".repeat(32)}`, nodes: [] });
    expect(Object.keys(result.errors!)).toEqual(expect.arrayContaining(["operator-name", "operator-owner", "operator-signer", "operator-nodes"]));
    const input = fixture();
    input.nodes = Array.from({ length: MAX_DRAFT_NODES + 1 }, (_, i) => ({ ...input.nodes[0]!, key: String(i), endpoint: `https://rpc${i}.example` }));
    expect(createOperatorDraft(input).errors?.["operator-nodes"]).toContain("between");
  });

  it("uses the registrar label limit and stable unique endpoint IDs independently of form row keys", () => {
    expect(createOperatorDraft({ ...fixture(), name: "a".repeat(31) }).draft).toBeDefined();
    expect(createOperatorDraft({ ...fixture(), name: "a".repeat(32) }).errors?.["operator-name"]).toContain("1–31");
    const input = fixture();
    input.nodes[0]!.id = "lisbon-1";
    expect(createOperatorDraft(input).draft?.nodes[0]!.id).toBe("lisbon-1");
    input.nodes.push({ key: "2", id: "lisbon-1", label: "Duplicate ID", endpoint: "https://rpc2.example", beacon: "https://beacon2.example" });
    expect(createOperatorDraft(input).errors?.["node-2-id"]).toContain("unique");
    input.nodes[1]!.id = "-edge";
    expect(createOperatorDraft(input).errors?.["node-2-id"]).toContain("edge hyphen");
  });

  it("rejects incorrect mixed-case address checksums and an oversized complete endpoint record", () => {
    const checksummed = getAddress(`0x${"ab".repeat(20)}`);
    const corrupt = `${checksummed.slice(0, 2)}${checksummed[2] === checksummed[2]!.toUpperCase() ? checksummed[2]!.toLowerCase() : checksummed[2]!.toUpperCase()}${checksummed.slice(3)}`;
    expect(createOperatorDraft({ ...fixture(), owner: corrupt }).errors?.["operator-owner"]).toContain("checksum");
    const input = fixture();
    input.nodes = Array.from({ length: 3 }, (_, i) => ({ key: String(i), label: "Node", endpoint: `https://rpc${i}.example/${"a".repeat(1200)}`, beacon: `https://beacon${i}.example/${"b".repeat(400)}` }));
    expect(createOperatorDraft(input).errors?.["operator-nodes"]).toContain("4,096 UTF-8 bytes");
  });
});

describe("deployment operator-config conversion", () => {
  it("exports one free plural operator entry and the exact shared record without a transaction or full config claim", () => {
    const draft = createOperatorDraft(fixture()).draft!;
    const result = createOperatorConfigFragment(draft, deploymentInput(), NOW);
    expect(result.errors).toBeUndefined();
    const fragment = result.fragment!;
    expect(fragment).toMatchObject({ schemaVersion: 1, kind: "derpc-ens-operator-config-fragment", status: "unsigned-unverified-fragment", chainId: 1, parentName: "derpc.eth" });
    expect(Object.keys(fragment.operatorConfig).sort()).toEqual(["label", "operator", "coldOwner", "hotKey", "signer", "payee", "endpoints", "caps", "expiry"].sort());
    expect(fragment.operatorConfig.expiry).toBe(Date.parse("2026-11-07T12:00:00Z") / 1000);
    expect(parseOperatorEndpoints(fragment.record.value)).toEqual(fragment.operatorConfig.endpoints);
    expect(fragment.record.key).toBe("derpc.endpoints");
    expect(fragment.remainingChecks.join(" ")).toContain("2–3 independent operators");
    expect(fragment.remainingChecks.join(" ")).toContain("parent lease");
  });

  it.each(["coldOwner", "hotKey", "payee"] as const)("requires a public nonzero %s address", field => {
    const result = createOperatorConfigFragment(createOperatorDraft(fixture()).draft!, { ...deploymentInput(), [field]: `0x${"00".repeat(20)}` }, NOW);
    expect(result.fragment).toBeUndefined();
    expect(Object.keys(result.errors!)).toHaveLength(1);
  });

  it("keeps the hot key separate from operator and resolver ownership", () => {
    const draft = createOperatorDraft(fixture()).draft!;
    for (const hotKey of [draft.owner, deploymentInput().coldOwner]) {
      expect(createOperatorConfigFragment(draft, { ...deploymentInput(), hotKey }, NOW).errors?.["operator-hot-key"]).toContain("distinct");
    }
  });

  it.each(["2026-11-06T15:00", "2026-12-07T15:00", "2026-02-31T12:00", "tomorrow", "2026-11-07T12:00Z"])("rejects invalid or out-of-window fixed expiry %s", expiryUtc => {
    const result = createOperatorConfigFragment(createOperatorDraft(fixture()).draft!, { ...deploymentInput(), expiryUtc }, NOW);
    expect(result.errors?.["operator-expiry"]).toContain("fixed UTC expiry");
  });

  it("preserves the exact selected expiry across repeated reviews and rechecks mutated draft input", () => {
    const draft = createOperatorDraft(fixture()).draft!;
    const a = createOperatorConfigFragment(draft, deploymentInput(), NOW).fragment!;
    const b = createOperatorConfigFragment(draft, deploymentInput(), NOW + 60).fragment!;
    expect(a.operatorConfig.expiry).toBe(b.operatorConfig.expiry);
    draft.nodes[0]!.id = "invalid.id";
    expect(createOperatorConfigFragment(draft, deploymentInput(), NOW).fragment).toBeUndefined();
  });

  it("passes the actual ENS config validator when combined with the remaining deployment inputs", () => {
    const fragment = createOperatorConfigFragment(createOperatorDraft(fixture()).draft!, deploymentInput(), NOW).fragment!;
    const config = {
      schemaVersion: 1, chainId: 1, parentName: "derpc.eth", deploymentId: "onboarding-check",
      curator: `0x${"ff".repeat(20)}`, deployer: `0x${"ff".repeat(20)}`,
      operators: [fragment.operatorConfig, {
        ...fragment.operatorConfig, label: "bob", operator: `0x${"66".repeat(20)}`, coldOwner: `0x${"77".repeat(20)}`, hotKey: `0x${"88".repeat(20)}`,
        signer: `0x${"99".repeat(20)}`, payee: `0x${"aa".repeat(20)}`,
        endpoints: [{ id: "bob-1", url: "https://bob.example/rpc", beaconUrl: "https://bob.example/" }],
      }],
    };
    // Run the actual administrative module in Node: its source pins are local file URLs,
    // while happy-dom intentionally rewrites module URLs into the browser's origin.
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { validateConfig, operatorRecords } from '../contracts/scripts/ens-common.mjs';
      const config = JSON.parse(readFileSync(0, 'utf8'));
      const checked = validateConfig(config);
      let curatorConflictRejected = false;
      try { validateConfig({ ...config, curator: config.operators[0].hotKey }); }
      catch { curatorConflictRejected = true; }
      console.log(JSON.stringify({ operator: checked.operators[0], record: operatorRecords(checked.operators[0])['derpc.endpoints'], curatorConflictRejected }));
    `], { encoding: "utf8", input: JSON.stringify(config), timeout: 10_000 }));
    expect(result.operator).toEqual(fragment.operatorConfig);
    expect(result.record).toBe(fragment.record.value);
    expect(result.curatorConflictRejected).toBe(true);
  });
});

function mount() {
  const page = operatePage();
  document.body.innerHTML = page.html;
  page.bind!(document.body);
}
function value(id: string, content: string) {
  (document.getElementById(id) as HTMLInputElement).value = content;
}
function fill() {
  value("operator-name", "alice");
  value("operator-owner", OWNER);
  value("operator-signer", SIGNER);
  value("node-1-label", "Lisbon");
  value("node-1-endpoint", `http://${ONION}/rpc`);
  value("node-1-beacon", `http://${ONION}`);
}
function submit() {
  document.getElementById("operate-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function fillDeployment() {
  const role = deploymentInput();
  value("operator-cold-owner", role.coldOwner);
  value("operator-hot-key", role.hotKey);
  value("operator-payee", role.payee);
  value("operator-expiry", new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 16));
}

describe("operator draft form", () => {
  it("reviews untrusted labels as text and never calls a wallet or network", () => {
    const fetch = vi.fn();
    const request = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("ethereum", { request });
    mount();
    fill();
    const payload = '<img src=x onerror="alert(1)">';
    value("node-1-label", payload);
    submit();
    const review = document.getElementById("operator-draft-review")!;
    expect(review.hidden).toBe(false);
    expect(JSON.parse(document.getElementById("operator-draft-json")!.textContent!).nodes[0].label).toBe(payload);
    expect(review.querySelector("img")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("invalidates a reviewed draft after edits so an outdated configuration cannot be downloaded", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    mount();
    fill();
    submit();
    value("operator-name", "bob");
    document.getElementById("operator-name")!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.getElementById("operator-draft-review")!.hidden).toBe(true);
    document.getElementById("download-operator-draft")!.click();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps nodes separate while adding/removing rows and refuses to remove the last node", () => {
    mount();
    const add = document.getElementById("add-node") as HTMLButtonElement;
    add.click();
    value("node-2-label", "Paris");
    (document.querySelector('[data-remove-node="1"]') as HTMLButtonElement).click();
    expect(document.querySelectorAll("[data-node]")).toHaveLength(1);
    expect((document.getElementById("node-2-label") as HTMLInputElement).value).toBe("Paris");
    expect((document.querySelector("[data-remove-node]") as HTMLButtonElement).disabled).toBe(true);
    for (let i = 1; i < MAX_DRAFT_NODES; i++) add.click();
    expect(add.disabled).toBe(true);
    expect(document.querySelectorAll("[data-node]")).toHaveLength(MAX_DRAFT_NODES);
  });

  it("shows field errors, focuses the first invalid field and preserves input", () => {
    mount();
    value("operator-name", "bad.name");
    submit();
    expect(document.activeElement?.id).toBe("operator-name");
    expect(document.getElementById("operator-name")!.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("operator-name-error")!.hidden).toBe(false);
    expect((document.getElementById("operator-name") as HTMLInputElement).value).toBe("bad.name");
    expect(document.getElementById("operator-draft-review")!.hidden).toBe(true);
  });

  it("requires deployment role fields only for fragment review and opens their inline errors", () => {
    mount();
    fill();
    submit();
    expect(document.getElementById("operator-draft-review")!.hidden).toBe(false);
    document.getElementById("review-operator-config")!.click();
    expect((document.getElementById("operator-deployment-fields") as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement?.id).toBe("operator-cold-owner");
    expect(document.getElementById("operator-config-review")!.hidden).toBe(true);
  });

  it("reviews a fragment without network/wallet calls and invalidates both downloads after a node ID edit", () => {
    const fetch = vi.fn();
    const request = vi.fn();
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("ethereum", { request });
    mount();
    fill();
    fillDeployment();
    document.getElementById("review-operator-config")!.click();
    expect(document.getElementById("operator-config-review")!.hidden).toBe(false);
    expect(document.activeElement?.id).toBe("operator-config-title");
    const json = JSON.parse(document.getElementById("operator-config-json")!.textContent!);
    expect(json.operatorConfig.endpoints[0].id).toBe("node-1");
    expect(fetch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    value("node-1-id", "replacement");
    document.getElementById("node-1-id")!.dispatchEvent(new Event("input", { bubbles: true }));
    for (const id of ["operator-config-review", "operator-draft-review"]) expect(document.getElementById(id)!.hidden).toBe(true);
    document.getElementById("download-operator-config")!.click();
    document.getElementById("download-operator-draft")!.click();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("downloads the reviewed fragment bytes with a clear fragment filename and releases the local object URL", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:operator-fragment");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
    mount();
    fill();
    fillDeployment();
    document.getElementById("review-operator-config")!.click();
    const reviewed = document.getElementById("operator-config-json")!.textContent!;
    document.getElementById("download-operator-config")!.click();
    expect(filenames).toEqual(["alice.derpc.eth-operator-fragment.json"]);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toBe(reviewed + "\n");
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:operator-fragment");
  });
});
