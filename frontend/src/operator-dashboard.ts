import type { DeRPCStatus, PoolEvent } from "@derpc/provider";
import { textCell } from "./render.ts";

export interface DashboardOperator {
  id?: string;
  url: string;
  ens?: string;
  operator?: string;
  source: "bootstrap" | "ens" | "personal";
  listVerification?: "proven" | "unverified";
  recordVerification?: "proven" | "unverified";
}

interface Observation {
  verified: number;
  rejected: number;
  unavailable: number;
  lastVerifiedAt?: number;
  lastOutcome?: PoolEvent["type"];
  latencyMs?: number;
  pending: number;
  startedAt?: number;
  overlapping: boolean;
}

/** Local observations only. Pool success is emitted after the operation's proof checks. */
export class OperatorObservations {
  private readonly entries = new Map<string, Observation>();

  get(id: string): Readonly<Observation> | undefined { return this.entries.get(id); }

  forget(id: string): void { this.entries.delete(id); }

  record(event: PoolEvent): void {
    if (!event.endpoint || event.type === "exhausted") return;
    let entry = this.entries.get(event.endpoint);
    if (!entry) {
      entry = { verified: 0, rejected: 0, unavailable: 0, pending: 0, overlapping: false };
      this.entries.set(event.endpoint, entry);
    }
    if (event.type === "attempt") {
      if (entry.pending === 0) entry.startedAt = event.at;
      else entry.overlapping = true;
      entry.pending++;
      return;
    }
    entry.lastOutcome = event.type;
    if (event.type === "success") {
      entry.verified++;
      entry.lastVerifiedAt = event.at;
      // Events have no request ID. Concurrent attempts cannot be paired reliably.
      entry.latencyMs = entry.pending === 1 && !entry.overlapping && entry.startedAt !== undefined && event.at >= entry.startedAt
        ? event.at - entry.startedAt : undefined;
    }
    if (event.type === "invalid-proof") entry.rejected++;
    if (event.type === "transient-failure") entry.unavailable++;
    entry.pending = Math.max(0, entry.pending - 1);
    if (!entry.pending) { entry.startedAt = undefined; entry.overlapping = false; }
  }
}

const idOf = (operator: DashboardOperator) => operator.id ?? operator.url;
const OBSERVATION_RECENT_MS = 60_000;

function identity(operator: DashboardOperator): string {
  if (operator.source === "personal") return "Private configuration · ENS not checked";
  if (operator.source === "bootstrap") return "Mock ENS · bootstrap list";
  return `ENS list ${operator.listVerification === "proven" ? "proven" : "unverified"} · records ${operator.recordVerification === "proven" ? "proven" : "unverified"}`;
}

export function renderOperatorDashboard(input: {
  body: HTMLElement;
  summary: HTMLElement;
  available: DashboardOperator[];
  chosen: DashboardOperator[];
  status: DeRPCStatus;
  observations: OperatorObservations;
  now?: number;
}): void {
  const { status, observations } = input;
  const now = input.now ?? Date.now();
  const rows = [...input.available];
  for (const endpoint of status.operators) {
    if (!rows.some(operator => idOf(operator) === endpoint.id || operator.url === endpoint.id || operator.url === endpoint.url)) {
      // setOperators can synchronously publish status before the personal form updates `available`.
      rows.push({ ...endpoint, source: endpoint.id === "my-personal-node" ? "personal" : "bootstrap" });
    }
  }
  const selectedIds = new Set(input.chosen.map(idOf));
  let verifiedCount = 0, rejectionCount = 0;
  const rendered = rows.map(operator => {
    const id = idOf(operator);
    const state = status.operators.find(endpoint => endpoint.id === id || endpoint.id === operator.url || endpoint.url === operator.url);
    const observed = observations.get(state?.id ?? id);
    const simulation = id.startsWith("simulated-liar:");
    const selected = selectedIds.has(id) || simulation && !!state;
    const name = simulation ? "Simulated lying operator" : operator.operator ?? operator.ens ?? "My own node";
    const identityCell = textCell(name);
    identityCell.className = "dashboard-name";
    identityCell.append(Object.assign(document.createElement("span"), {
      className: "dashboard-detail muted", textContent: simulation ? "Demo injection" : operator.ens ?? "Unpublished identity",
    }));
    // Status text can contain untrusted operator labels; never interpret it as HTML.
    if (state?.operator && state.operator !== name) identityCell.append(Object.assign(document.createElement("span"), {
      className: "dashboard-detail muted", textContent: state.operator,
    }));
    identityCell.append(Object.assign(document.createElement("span"), {
      className: "dashboard-detail", textContent: selected ? "Selected" : "Not selected",
    }));

    let health = "Not observed this session", tone = "muted";
    if (state?.state === "expired") { health = "Listing expired · unavailable"; tone = "warn"; }
    else if (state?.state === "excluded" || observed?.lastOutcome === "invalid-proof") { health = "Proof rejected · excluded locally"; tone = "bad"; }
    else if (state?.state === "cooldown" || observed?.lastOutcome === "transient-failure") { health = "Read unavailable · retry allowed"; tone = "warn"; }
    else if (observed?.pending) health = "Checking a selected read…";
    else if (observed?.lastOutcome === "stopped") health = "Read stopped · no operator verdict";
    else if (observed?.lastVerifiedAt !== undefined) {
      health = now - observed.lastVerifiedAt > OBSERVATION_RECENT_MS ? "Past proof checked · needs a new read" : "Proof checked on this page";
      tone = now - observed.lastVerifiedAt > OBSERVATION_RECENT_MS ? "muted" : "ok";
    } else if (selected && state) health = "Ready to try · no result yet";
    if (selected && (status.transport.state === "closed" || status.transport.state === "failed")) {
      health = status.transport.state === "closed" ? "Anonymous route closed" : "Anonymous route unavailable";
      tone = "bad";
    }
    const lastVerified = observed?.lastVerifiedAt;
    if (lastVerified !== undefined && !simulation) verifiedCount++;
    rejectionCount += observed?.rejected ?? 0;
    const proofTime = textCell(lastVerified === undefined ? "No verified response" : new Date(lastVerified).toLocaleTimeString());
    if (lastVerified !== undefined) proofTime.title = new Date(lastVerified).toISOString();
    const failures = observed ? `${observed.rejected} rejected · ${observed.unavailable} unavailable` : "None observed";
    const endpoint = operator.source === "personal" ? "Unpublished onion" : operator.url;
    const row = document.createElement("tr");
    row.dataset.operatorId = operator.source === "personal" ? "personal" : id;
    row.append(
      identityCell,
      textCell(health, tone),
      proofTime,
      textCell(endpoint, "dashboard-endpoint"),
      textCell(simulation ? "Simulation" : identity(operator)),
      textCell(observed?.latencyMs === undefined ? "—" : `${(observed.latencyMs / 1000).toFixed(2)} s`),
      textCell(failures),
    );
    return row;
  });
  if (!rendered.length) {
    const row = document.createElement("tr");
    const empty = textCell("No active listings. Refresh the ENS directory or add your own node.", "muted");
    empty.colSpan = 7; row.append(empty); rendered.push(row);
  }
  input.body.replaceChildren(...rendered);
  const summary = `${input.available.length} listed · ${input.chosen.length} selected · ${verifiedCount} with a proof checked this session · ${rejectionCount} rejected responses (including simulations)`;
  if (input.summary.textContent !== summary) input.summary.textContent = summary;
}
