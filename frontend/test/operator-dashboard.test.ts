import { describe, expect, it } from "vitest";
import type { DeRPCStatus, PoolEvent } from "@derpc/provider";
import { OperatorObservations, renderOperatorDashboard, type DashboardOperator } from "../src/operator-dashboard.ts";

const operator: DashboardOperator = { id: "alice", ens: "alice.derpc.eth", operator: "Alice", url: "https://alice.example/rpc", source: "bootstrap" };
const event = (type: PoolEvent["type"], at: number): PoolEvent => ({ type, endpoint: "alice", at });
function render(observations: OperatorObservations, options: { selected?: boolean; now?: number; transport?: string; operator?: DashboardOperator; state?: DeRPCStatus["operators"][number]["state"] } = {}) {
  const op = options.operator ?? operator;
  const body = document.createElement("tbody"), summary = document.createElement("p");
  const status = {
    transport: { state: options.transport ?? "ready" },
    operators: options.selected ? [{ ...op, id: op.id ?? op.url, state: options.state ?? "eligible" }] : [],
  } as DeRPCStatus;
  renderOperatorDashboard({ body, summary, available: [op], chosen: options.selected ? [op] : [], status, observations, now: options.now ?? 5_000 });
  return { body, summary };
}

describe("local operator dashboard", () => {
  it("groups sibling endpoints once and keeps proof and failure observations on their own endpoint", () => {
    const endpoints = ["east", "west"].map(endpointId => ({ ...operator, id: `alice.derpc.eth#${endpointId}`, operatorId: "alice.derpc.eth", endpointId, url: `https://${endpointId}.example/rpc` }));
    const tracker = new OperatorObservations();
    tracker.record({ type: "success", endpoint: endpoints[0]!.id, at: 4_000 });
    tracker.record({ type: "transient-failure", endpoint: endpoints[1]!.id, at: 4_100 });
    const body = document.createElement("tbody"), summary = document.createElement("p");
    renderOperatorDashboard({ body, summary, available: endpoints, chosen: endpoints, observations: tracker, now: 5_000,
      status: { transport: { state: "ready" }, operators: endpoints.map(endpoint => ({ ...endpoint, state: "eligible" })) } as DeRPCStatus });
    expect(body.querySelectorAll(".dashboard-operator-row")).toHaveLength(1);
    const rows = body.querySelectorAll(".dashboard-endpoint-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Proof checked on this page");
    expect(rows[0]!.textContent).not.toContain("Read unavailable");
    expect(rows[1]!.textContent).toContain("Read unavailable");
    expect(rows[1]!.textContent).toContain("No verified response");
    expect(summary.textContent).toContain("1 operators · 2 endpoints · 1 operators selected");
    expect(summary.textContent).toContain("1 endpoints with a proof checked");
  });

  it("keeps a simulated liar separate even when it shares the real endpoint URL and ENS name", () => {
    const tracker = new OperatorObservations();
    tracker.record({ type: "invalid-proof", endpoint: "simulated-liar:alice", at: 4_000 });
    const body = document.createElement("tbody"), summary = document.createElement("p");
    renderOperatorDashboard({ body, summary, available: [operator], chosen: [operator], observations: tracker, now: 5_000,
      status: { transport: { state: "ready" }, operators: [
        { ...operator, state: "eligible" }, { ...operator, id: "simulated-liar:alice", state: "excluded" },
      ] } as DeRPCStatus });
    expect(body.querySelectorAll(".dashboard-operator-row")).toHaveLength(2);
    const rows = body.querySelectorAll(".dashboard-endpoint-row");
    expect(rows[0]!.textContent).toContain("Ready to try · no result yet");
    expect(rows[0]!.textContent).not.toContain("Proof rejected");
    expect(rows[1]!.textContent).toContain("Proof rejected");
    expect(summary.textContent).toContain("1 operators · 1 endpoints");
    expect(summary.textContent).toContain("1 simulated endpoint");
  });

  it("never treats listing or selection as proof of health", () => {
    const tracker = new OperatorObservations();
    const idle = render(tracker);
    expect(idle.body.textContent).toContain("Not selected");
    expect(idle.body.textContent).toContain("Not observed this session");
    expect(idle.body.textContent).toContain("Public bootstrap · not ENS-enrolled");
    expect(idle.body.textContent).not.toContain("alice.derpc.eth");
    expect(idle.body.querySelector(".ok")).toBeNull();
    const selected = render(tracker, { selected: true });
    expect(selected.body.textContent).toContain("Ready to try · no result yet");
    expect(selected.body.querySelector(".ok")).toBeNull();
  });

  it("uses source provenance rather than an ENS-shaped key or incidental verification fields for identity labels", () => {
    const tracker = new OperatorObservations();
    const bootstrap = render(tracker, { operator: { ...operator, operator: undefined, operatorId: "alice.derpc.eth", listVerification: "proven", recordVerification: "proven" } });
    expect(bootstrap.body.textContent).toContain("alice.example");
    expect(bootstrap.body.textContent).toContain("Public bootstrap · not ENS-enrolled");
    expect(bootstrap.body.textContent).not.toContain("alice.derpc.eth");
    expect(bootstrap.body.textContent).not.toContain("ENS list proven");
    const discovered = render(tracker, { operator: { ...operator, source: "ens", listVerification: "proven", recordVerification: "proven" } });
    expect(discovered.body.querySelector(".dashboard-name")!.textContent).toBe("alice.derpc.eth");
    expect(discovered.body.textContent).toContain("ENS list proven · records proven");
    expect(discovered.body.textContent).not.toContain("Public bootstrap");
  });

  it("attributes successes and failures separately, preserving past verification after a later failure", () => {
    const tracker = new OperatorObservations();
    tracker.record(event("attempt", 1_000));
    tracker.record(event("success", 2_400));
    expect(tracker.get("alice")).toMatchObject({ verified: 1, latencyMs: 1_400, lastVerifiedAt: 2_400 });
    tracker.record(event("attempt", 3_000));
    tracker.record(event("transient-failure", 4_000));
    const view = render(tracker, { selected: true });
    expect(view.body.textContent).toContain("Read unavailable");
    expect(view.body.textContent).toContain("0 rejected · 1 unavailable");
    expect(view.body.textContent).toContain("1.40 s");
    expect(view.summary.textContent).toContain("1 endpoints with a proof checked this session");
  });

  it("does not fabricate latency for overlapping or unmatched events", () => {
    const tracker = new OperatorObservations();
    tracker.record(event("attempt", 1_000));
    tracker.record(event("attempt", 1_100));
    tracker.record(event("success", 2_000));
    expect(tracker.get("alice")?.latencyMs).toBeUndefined();
    tracker.record(event("success", 2_500));
    expect(tracker.get("alice")?.latencyMs).toBeUndefined();
    tracker.record(event("success", 3_000));
    expect(tracker.get("alice")?.latencyMs).toBeUndefined();
    tracker.record(event("attempt", 4_000));
    tracker.record(event("success", 5_000));
    expect(tracker.get("alice")?.latencyMs).toBe(1_000);
  });

  it("marks old observations as historical and a stopped route as unavailable", () => {
    const tracker = new OperatorObservations();
    tracker.record(event("success", 1_000));
    expect(render(tracker, { now: 62_000 }).body.textContent).toContain("Past proof checked · needs a new read");
    expect(render(tracker, { selected: true, transport: "closed" }).body.textContent).toContain("Anonymous route closed");
    expect(render(tracker, { selected: true, transport: "closed" }).body.querySelector(".ok")).toBeNull();
  });

  it("marks an expired listing unavailable even after a recent proof", () => {
    const tracker = new OperatorObservations();
    tracker.record(event("success", 4_000));
    const view = render(tracker, { selected: true, state: "expired" });
    expect(view.body.textContent).toContain("Listing expired · unavailable");
    expect(view.body.textContent).not.toContain("Proof checked on this page");
    expect(view.body.querySelector(".ok")).toBeNull();
    expect(view.summary.textContent).toContain("1 endpoints with a proof checked this session");
  });

  it("does not blame an operator for a cancelled read and forgets evidence after an endpoint rotation", () => {
    const tracker = new OperatorObservations();
    tracker.record(event("attempt", 1_000));
    tracker.record(event("stopped", 1_100));
    expect(tracker.get("alice")).toMatchObject({ rejected: 0, unavailable: 0 });
    expect(render(tracker).body.textContent).toContain("no operator verdict");
    tracker.record(event("success", 2_000));
    tracker.forget("alice");
    expect(render(tracker).body.textContent).toContain("Not observed this session");
  });

  it("keeps private URLs out of the dashboard and distinguishes unverified ENS records", () => {
    const tracker = new OperatorObservations();
    const personal = render(tracker, { operator: { ...operator, source: "personal", url: "http://secret-onion.example/rpc" } });
    expect(personal.body.innerHTML).not.toContain("secret-onion");
    expect(personal.body.textContent).toContain("Unpublished onion");
    const ens = render(tracker, { operator: { ...operator, source: "ens", listVerification: "proven", recordVerification: "unverified" } });
    expect(ens.body.textContent).toContain("ENS list proven · records unverified");
  });

  it("redacts personal URLs during the synchronous status update before form state is installed", () => {
    const body = document.createElement("tbody"), summary = document.createElement("p");
    renderOperatorDashboard({
      body, summary, available: [], chosen: [], observations: new OperatorObservations(),
      status: { transport: { state: "ready" }, operators: [{ id: "my-personal-node", url: "http://private.example/rpc", priority: -1, state: "eligible" }] } as DeRPCStatus,
    });
    expect(body.innerHTML).not.toContain("private.example");
    expect(body.textContent).toContain("Unpublished onion");
  });

  it("does not assign bootstrap or proven ENS provenance to a route before directory records are installed", () => {
    const body = document.createElement("tbody"), summary = document.createElement("p");
    renderOperatorDashboard({ body, summary, available: [], chosen: [], observations: new OperatorObservations(),
      status: { transport: { state: "ready" }, operators: [{ ...operator, id: "new.derpc.eth", ens: "new.derpc.eth", priority: 0, state: "eligible" }] } as DeRPCStatus });
    expect(body.textContent).toContain("identity provenance not loaded");
    expect(body.textContent).not.toContain("Public bootstrap");
    expect(body.textContent).not.toContain("ENS list proven");
  });
});
