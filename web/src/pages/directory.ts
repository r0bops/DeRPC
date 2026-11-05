import type { PageResult } from "../page.ts";
import type { Operator } from "../data.ts";
import { getNetwork, networks, operators } from "../data.ts";
import { demoNote, escapeHtml, icon } from "../ui.ts";
import { emptyRow, networkTable, operatorTable } from "../components/tables.ts";

type DirectoryView = "network" | "operator";
type SortKey = "score" | "price" | "latency";

interface DirectoryState {
  by: DirectoryView;
  q: string;
  sort: SortKey;
}

function parseView(value: string | null): DirectoryView {
  return value === "operator" ? "operator" : "network";
}

function parseSort(value: string | null): SortKey {
  return value === "price" || value === "latency" ? value : "score";
}

function parseState(params: URLSearchParams): DirectoryState {
  return {
    by: parseView(params.get("by")),
    q: params.get("q") ?? "",
    sort: parseSort(params.get("sort")),
  };
}

function searchPlaceholder(view: DirectoryView): string {
  return view === "network"
    ? "Search networks, e.g. Base or 8453"
    : "Search operators, ENS names, regions or networks";
}

function buildUrl(state: DirectoryState): string {
  const params = new URLSearchParams();
  if (state.by === "operator") {
    params.set("by", "operator");
  }
  if (state.q.trim()) {
    params.set("q", state.q.trim());
  }
  if (state.by === "operator" && state.sort !== "score") {
    params.set("sort", state.sort);
  }
  const query = params.toString();
  return "#/directory" + (query ? "?" + query : "");
}

function visibleNetworks(state: DirectoryState) {
  const query = state.q.trim().toLowerCase();
  if (!query) {
    return networks;
  }
  return networks.filter((network) =>
    [network.name, network.id, network.short, String(network.chainId)]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

function visibleOperators(state: DirectoryState): Operator[] {
  const query = state.q.trim().toLowerCase();
  const filtered = query
    ? operators.filter((operator) =>
        [
          operator.label,
          operator.ens,
          operator.name,
          operator.region,
          ...operator.networks.map((id) => getNetwork(id)?.name ?? id),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : operators;

  return [...filtered].sort((a, b) => {
    if (state.sort === "price") {
      return a.pricePer1k - b.pricePer1k;
    }
    if (state.sort === "latency") {
      return a.latencyMs - b.latencyMs;
    }
    return b.score - a.score;
  });
}

function resultsMarkup(state: DirectoryState): string {
  if (state.by === "network") {
    const rows = visibleNetworks(state);
    const table =
      rows.length === 0
        ? `<div class="table-card"><table class="data-table"><caption class="sr-only">Networks in the DeRPC directory</caption><tbody>${emptyRow(6, "network", state.q.trim())}</tbody></table></div>`
        : networkTable(rows, "Networks in the DeRPC directory");
    return table + demoNote();
  }

  const rows = visibleOperators(state);
  const table =
    rows.length === 0
      ? `<div class="table-card"><table class="data-table"><caption class="sr-only">Operators in the DeRPC directory</caption><tbody>${emptyRow(8, "operator", state.q.trim())}</tbody></table></div>`
      : operatorTable(rows, "Operators in the DeRPC directory");
  return table + demoNote();
}

export function directoryPage(params: URLSearchParams): PageResult {
  const state = parseState(params);
  const placeholder = searchPlaceholder(state.by);

  return {
    title: "Directory",
    html: `
      <div class="page">
        <div class="container">
          <div class="page__head">
            <div>
              <p class="kicker">Directory</p>
              <h1 class="page-title">Who serves what.</h1>
              <p class="page-lead">Search by network or by operator. Every row opens the same underlying record: ENS name, stake, score and price.</p>
            </div>
          </div>

          <div class="toolbar">
            <div class="segmented" role="group" aria-label="Directory view">
              <button class="segmented__btn" type="button" data-view="network" aria-pressed="${state.by === "network"}">By network</button>
              <button class="segmented__btn" type="button" data-view="operator" aria-pressed="${state.by === "operator"}">By operator</button>
            </div>
            <div class="search">
              ${icon("search")}
              <label class="sr-only" for="directory-search">Search the directory</label>
              <input id="directory-search" type="search" placeholder="${placeholder}" value="${escapeHtml(state.q)}" autocomplete="off" />
            </div>
            <div class="select" id="directory-sort"${state.by === "network" ? " hidden" : ""}>
              <label class="sr-only" for="directory-sort-select">Sort operators</label>
              <select id="directory-sort-select">
                <option value="score"${state.sort === "score" ? " selected" : ""}>Sort: Score</option>
                <option value="price"${state.sort === "price" ? " selected" : ""}>Sort: Price</option>
                <option value="latency"${state.sort === "latency" ? " selected" : ""}>Sort: Latency</option>
              </select>
              ${icon("chevron").replace("<svg ", '<svg class="select__icon" ')}
            </div>
          </div>

          <div id="directory-results">${resultsMarkup(state)}</div>
        </div>
      </div>
    `,
    bind(root) {
      const results = root.querySelector<HTMLElement>("#directory-results");
      const search = root.querySelector<HTMLInputElement>("#directory-search");
      const sortWrap = root.querySelector<HTMLElement>("#directory-sort");
      const sort = root.querySelector<HTMLSelectElement>("#directory-sort-select");
      if (!results || !search || !sortWrap || !sort) {
        return;
      }

      const update = () => {
        results.innerHTML = resultsMarkup(state);
        sortWrap.hidden = state.by !== "operator";
        search.placeholder = searchPlaceholder(state.by);
        root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.view === state.by));
        });
        history.replaceState(null, "", buildUrl(state));
      };

      root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
        button.addEventListener("click", () => {
          const view = button.dataset.view;
          if (view === "network" || view === "operator") {
            state.by = view;
            update();
          }
        });
      });

      search.addEventListener("input", () => {
        state.q = search.value;
        update();
      });

      sort.addEventListener("change", () => {
        const value = sort.value;
        if (value === "score" || value === "price" || value === "latency") {
          state.sort = value;
          update();
        }
      });

      results.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("[data-clear-search]")) {
          return;
        }
        state.q = "";
        search.value = "";
        update();
        search.focus();
      });

      update();
    },
  };
}
