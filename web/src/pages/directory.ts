import "../directory/directory.css";

import { NETWORKS, OPERATORS } from "../directory/operators.ts";
import {
  host,
  isVerified,
  operatorsFor,
  type DirectoryOperator,
  type NetworkId,
} from "../directory/model.ts";
import type { PageResult } from "../page.ts";
import { avatarTone, demoHref, escapeHtml, icon } from "../ui.ts";

type DirectoryView = "operators" | "networks";

interface DirectoryState {
  by: DirectoryView;
  q: string;
  verifiedOnly: boolean;
}

function parseState(params: URLSearchParams): DirectoryState {
  const by = params.get("by");
  return {
    by: by === "networks" || by === "network" ? "networks" : "operators",
    q: params.get("q") ?? "",
    verifiedOnly: params.get("verified") === "1",
  };
}

function buildUrl(state: DirectoryState): string {
  const params = new URLSearchParams();
  params.set("by", state.by);
  if (state.q.trim()) params.set("q", state.q.trim());
  if (state.verifiedOnly) params.set("verified", "1");
  return `#/directory?${params}`;
}

function initials(text: string): string {
  return text
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function personAvatar(label: string, seed: string): string {
  return `<span class="avatar ${avatarTone(seed)}" aria-hidden="true">${escapeHtml(initials(label))}</span>`;
}

export function netChip(id: NetworkId): string {
  const network = NETWORKS.find((item) => item.id === id);
  const verified = isVerified(NETWORKS, id);
  const label = network?.short ?? id;
  const title = `${network?.name ?? id}: ${verified ? "reads proven by DeRPC" : "listed, not verified by DeRPC"}`;
  return `<span class="net-chip ${verified ? "v" : "l"}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

export function tierChip(tier: 1 | 2): string {
  const priority = tier - 1;
  const title =
    priority === 0
      ? "Priority 0 in MAINNET_OPERATORS. Finalized proofs were fast and reliable through Tor on Nov 5, 2026."
      : "Priority 1 in MAINNET_OPERATORS. Slower, or proof-window errors through some Tor exits, on Nov 5, 2026.";
  return `<span class="tier t${tier}" title="${title}">Priority ${priority}</span>`;
}

export const mockBadge =
  '<span class="mock" title="Placeholder name: nothing is registered under derpc.eth yet">mock ENS</span>';

function matchesOperator(operator: DirectoryOperator, query: string): boolean {
  if (!query) return true;
  return (
    operator.ens.includes(query) ||
    operator.operator.toLowerCase().includes(query) ||
    host(operator.endpoint).includes(query) ||
    operator.networks.some((entry) => {
      const network = NETWORKS.find((item) => item.id === entry.network);
      return (
        entry.network.includes(query) ||
        network?.name.toLowerCase().includes(query) ||
        String(network?.chainId) === query
      );
    })
  );
}

function operatorRows(state: DirectoryState): string {
  const query = state.q.trim().toLowerCase();
  const rows = OPERATORS.filter((operator) => matchesOperator(operator, query)).sort(
    (a, b) => a.tier - b.tier || a.operator.localeCompare(b.operator),
  );
  if (rows.length === 0) {
    return `<tr><td colspan="6" class="empty">No operator matches “${escapeHtml(state.q)}”.</td></tr>`;
  }
  return rows
    .map((operator) => {
      const href = `#/operator/${escapeHtml(operator.ens)}`;
      const networks = state.verifiedOnly
        ? operator.networks.filter((entry) => isVerified(NETWORKS, entry.network))
        : operator.networks;
      return `
        <tr data-href="${href}">
          <td>
            <a class="row-link" href="${href}">
              ${personAvatar(operator.operator, operator.ens)}
              <span>
                <span class="row-title">${escapeHtml(operator.operator)}</span>
                <span class="row-hint">${escapeHtml(operator.ens)} ${mockBadge}</span>
              </span>
            </a>
          </td>
          <td data-label="Networks"><div class="chip-row">${networks.map((entry) => netChip(entry.network)).join("")}</div></td>
          <td data-label="Live health"><a class="check-link" href="${escapeHtml(demoHref())}?operator=${encodeURIComponent(operator.ens)}#routing">Check in dashboard</a></td>
          <td data-label="Priority" class="hide-m">${tierChip(operator.tier)}</td>
          <td data-label="Endpoint" class="mono hide-m">${escapeHtml(host(operator.endpoint))}</td>
          <td class="col-chevron hide-m">${icon("chevron")}</td>
        </tr>
      `;
    })
    .join("");
}

function networkRows(state: DirectoryState): string {
  const query = state.q.trim().toLowerCase();
  const rows = NETWORKS.filter(
    (network) =>
      (!state.verifiedOnly || network.verification === "light-client") &&
      (!query ||
        network.name.toLowerCase().includes(query) ||
        String(network.chainId) === query ||
        network.id.includes(query)),
  );
  if (rows.length === 0) {
    return `<tr><td colspan="4" class="empty">No network matches “${escapeHtml(state.q)}”.</td></tr>`;
  }
  return rows
    .map((network) => {
      const href = `#/network/${network.id}`;
      const operators = operatorsFor(OPERATORS, network.id);
      const verified = network.verification === "light-client";
      return `
        <tr data-href="${href}">
          <td>
            <a class="row-link" href="${href}">
              ${personAvatar(network.short, network.id)}
              <span>
                <span class="row-title">${escapeHtml(network.name)}</span>
                <span class="row-hint">Chain ID ${network.chainId}</span>
              </span>
            </a>
          </td>
          <td data-label="Verification">${
            verified
              ? '<span class="verified"><span class="ok-dot" aria-hidden="true"></span>Reads proven</span>'
              : '<span class="net-chip l">Listed, not verified</span>'
          }</td>
          <td data-label="Operators">${operators.map((operator) => escapeHtml(operator.operator)).join(", ")} <span class="row-hint">(${operators.length})</span></td>
          <td class="col-chevron hide-m">${icon("chevron")}</td>
        </tr>
      `;
    })
    .join("");
}

function resultsMarkup(state: DirectoryState): string {
  if (state.by === "networks") {
    return `
      <div class="table-card">
        <table class="data-table">
          <caption class="sr-only">Networks in the DeRPC directory</caption>
          <thead>
            <tr>
              <th scope="col">Network</th>
              <th scope="col">Verification</th>
              <th scope="col">Operators listing it</th>
              <th scope="col"><span class="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>${networkRows(state)}</tbody>
        </table>
      </div>
    `;
  }
  return `
    <div class="table-card">
      <table class="data-table">
        <caption class="sr-only">Operators in the DeRPC directory</caption>
        <thead>
          <tr>
            <th scope="col">Operator</th>
            <th scope="col">Networks</th>
            <th scope="col">Live health</th>
            <th scope="col" class="hide-m">Priority</th>
            <th scope="col" class="hide-m">Endpoint</th>
            <th scope="col"><span class="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>${operatorRows(state)}</tbody>
      </table>
    </div>
  `;
}

export function directoryPage(params: URLSearchParams): PageResult {
  const state = parseState(params);
  const placeholder =
    state.by === "operators"
      ? "Search operators, ENS names, endpoints or networks"
      : "Search networks, e.g. Base or 8453";
  const verifiedNetworks =
    NETWORKS.filter((network) => network.verification === "light-client")
      .map((network) => network.name)
      .join(", ") || "None yet";

  return {
    title: "Directory",
    html: `
      <section class="facts" aria-label="Directory at a glance">
        <dl class="container facts__grid">
          <div class="facts__item"><dt>Operators listed</dt><dd>${OPERATORS.length} · names are placeholders</dd></div>
          <div class="facts__item"><dt>Networks listed</dt><dd>${NETWORKS.length} · from operators' own documentation</dd></div>
          <div class="facts__item"><dt>Verified by proof</dt><dd><span class="ok-dot" aria-hidden="true"></span>${escapeHtml(verifiedNetworks)}</dd></div>
          <div class="facts__item"><dt>Live health</dt><dd>Checked on your device, in the dashboard</dd></div>
        </dl>
      </section>
      <div class="page">
        <div class="container">
          <div class="page__head">
            <div>
              <p class="kicker">Directory</p>
              <h1 class="page-title">Choose who serves your reads.</h1>
              <p class="page-lead">Browse operators, then choose your providers in the live dashboard to see local health and verified reads. Supported reads are verified on Ethereum mainnet; other listed networks are not verified.</p>
            </div>
            <a class="btn btn--lime" href="${escapeHtml(demoHref())}">Choose and check operators ${icon("arrow")}</a>
          </div>

          <div class="toolbar">
            <div class="segmented" role="group" aria-label="Directory view">
              <button class="segmented__btn" type="button" data-view="operators" aria-pressed="${state.by === "operators"}">By operator</button>
              <button class="segmented__btn" type="button" data-view="networks" aria-pressed="${state.by === "networks"}">By network</button>
            </div>
            <div class="search">
              ${icon("search")}
              <label class="sr-only" for="directory-search">Search the directory</label>
              <input id="directory-search" type="search" placeholder="${placeholder}" value="${escapeHtml(state.q)}" autocomplete="off" />
            </div>
            <label class="filter">
              <input type="checkbox" id="directory-verified" ${state.verifiedOnly ? "checked" : ""} />
              Verified networks only
            </label>
          </div>

          <p class="legend">
            <span><span class="net-chip v">ETH</span> reads proven by DeRPC</span>
            <span><span class="net-chip l">BASE</span> listed by the operator, not verified</span>
            <span>${tierChip(1)} preferred · ${tierChip(2)} fallback. Measured through Tor on Nov 5, 2026.</span>
          </p>

          <div id="directory-results">${resultsMarkup(state)}</div>
          <p class="demo-note"><span class="demo-note__square" aria-hidden="true"></span><span>Free reads need no wallet. ENS names are mock labels; registered names are roadmap. Health is observed on your device, in the dashboard.</span></p>
        </div>
      </div>
    `,
    bind(root) {
      const results = root.querySelector<HTMLElement>("#directory-results");
      const search = root.querySelector<HTMLInputElement>("#directory-search");
      const verified = root.querySelector<HTMLInputElement>("#directory-verified");
      if (!results || !search || !verified) return;

      const update = () => {
        results.innerHTML = resultsMarkup(state);
        search.placeholder =
          state.by === "operators"
            ? "Search operators, ENS names, endpoints or networks"
            : "Search networks, e.g. Base or 8453";
        root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.view === state.by));
        });
        history.replaceState(null, "", buildUrl(state));
      };

      root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
        button.addEventListener("click", () => {
          const view = button.dataset.view;
          if (view === "operators" || view === "networks") {
            state.by = view;
            update();
          }
        });
      });

      search.addEventListener("input", () => {
        state.q = search.value;
        update();
      });

      verified.addEventListener("change", () => {
        state.verifiedOnly = verified.checked;
        update();
      });

      update();
    },
  };
}
