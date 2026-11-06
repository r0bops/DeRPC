import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperatorDraft, MAX_DRAFT_NODES, type OperatorDraftInput } from "../../web/src/directory/operator-draft.ts";
import { operatePage } from "../../web/src/pages/operate.ts";

const OWNER = `0x${"11".repeat(20)}`;
const SIGNER = `0x${"22".repeat(20)}`;
const ONION = "g7nasyegiclqszahjp6jnkdrvlzntfams6bgawi6caaprlleq4mc2eid.onion";
const fixture = (): OperatorDraftInput => ({
  name: "alice", owner: OWNER, signer: SIGNER,
  nodes: [{ key: "1", label: "Lisbon", endpoint: `http://${ONION}/rpc`, beacon: `http://${ONION}` }],
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
});
