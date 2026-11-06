import "../directory/directory.css";

import { NETWORKS, OPERATORS } from "../directory/operators.ts";
import { TIER_TEXT, getNetwork, getOperator, host, isVerified } from "../directory/model.ts";
import type { PageResult } from "../page.ts";
import { avatarTone, demoHref, escapeHtml, icon, snippet } from "../ui.ts";
import { mockBadge, tierChip } from "./directory.ts";
import { notFoundPage } from "./not-found.ts";

function initials(text: string): string {
  return text
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function personAvatar(label: string, seed: string, large = false): string {
  return `<span class="avatar ${avatarTone(seed)}${large ? " avatar--lg" : ""}" aria-hidden="true">${escapeHtml(initials(label))}</span>`;
}

function pinSnippet(ens: string): string {
  return `import { createDeRPC, MAINNET_OPERATORS } from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient } from "viem";
import { mainnet } from "viem/chains";

const derpc = createDeRPC({ operators: MAINNET_OPERATORS.filter((o) => o.ens === "${ens}") });
const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });
// Pass blockTag: "finalized". DeRPC proves state at the verified finalized block only.`;
}

export function operatorPage(ens: string): PageResult {
  const operator = getOperator(OPERATORS, ens);
  if (!operator) return notFoundPage();

  const verifiedCount = operator.networks.filter((entry) => isVerified(NETWORKS, entry.network)).length;

  return {
    title: operator.operator,
    html: `
      <div class="page">
        <div class="container">
          <a class="back-link" href="#/directory?by=operators">${icon("arrowLeft")}All operators</a>
          <div class="page__head">
            <div class="detail-head">
              ${personAvatar(operator.operator, operator.ens, true)}
              <div>
                <p class="kicker">Operator</p>
                <h1 class="page-title">${escapeHtml(operator.operator)}</h1>
                <div class="detail-meta">
                  <span class="mono">${escapeHtml(operator.ens)}</span>
                  ${mockBadge}
                </div>
              </div>
            </div>
            <a class="btn btn--lime" href="${escapeHtml(demoHref())}?operator=${encodeURIComponent(operator.ens)}#operator-dashboard">Choose in dashboard ${icon("arrow")}</a>
          </div>

          ${(operator.warnings ?? [])
            .map(
              (warning) =>
                `<div class="notice warn" role="note"><span><b>Before you choose this operator.</b> ${escapeHtml(warning)}</span></div>`,
            )
            .join("")}

          <div class="metrics">
            <div class="metric">
              <div class="metric__label">Networks listed</div>
              <div class="metric__value">${operator.networks.length}</div>
            </div>
            <div class="metric">
              <div class="metric__label">Verified by DeRPC</div>
              <div class="metric__value">${verifiedCount}</div>
              <div class="metric__caption">Ethereum mainnet only</div>
            </div>
            <div class="metric">
              <div class="metric__label">Tor reliability</div>
              <div class="metric__value">Tier ${operator.tier}</div>
              <div class="metric__caption">measured Nov 5</div>
            </div>
            <div class="metric">
              <div class="metric__label">Endpoint</div>
              <div class="metric__value metric__value--host">${escapeHtml(host(operator.endpoint))}</div>
            </div>
          </div>

          <div class="detail-grid">
            <div class="stack">
              <div class="card">
                <div class="card-head">
                  <div>
                    <h2>Networks</h2>
                    <p>Each claim links to the page that backs it. “Tested” means DeRPC ran proven reads through this operator.</p>
                  </div>
                </div>
                <div class="table-card table-card--flush">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Network</th>
                        <th scope="col">Status</th>
                        <th scope="col">Tested</th>
                        <th scope="col">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${operator.networks
                        .map((entry) => {
                          const network = getNetwork(NETWORKS, entry.network)!;
                          const verified = isVerified(NETWORKS, entry.network);
                          return `
                            <tr>
                              <td>
                                <span class="row-title">${escapeHtml(network.name)}</span>
                                <span class="row-hint">Chain ID ${network.chainId}</span>
                              </td>
                              <td>${
                                verified
                                  ? '<span class="ok-dot">Reads proven</span>'
                                  : '<span class="net-chip l">Listed, not verified</span>'
                              }</td>
                              <td>${entry.tested ? "Yes" : "No"}</td>
                              <td class="src">
                                <a href="${escapeHtml(entry.source)}" target="_blank" rel="noopener">${escapeHtml(host(entry.source))}</a>
                                ${entry.note ? `<span class="row-hint">${escapeHtml(entry.note)}</span>` : ""}
                              </td>
                            </tr>
                          `;
                        })
                        .join("")}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <div class="card-head">
                  <div>
                    <h2>About this operator</h2>
                    <p>Facts, not scores.</p>
                  </div>
                </div>
                <dl class="kv">
                  <dt>Name</dt>
                  <dd class="mono">${escapeHtml(operator.ens)} ${mockBadge}</dd>
                  <dt>Endpoint</dt>
                  <dd class="mono">${escapeHtml(operator.endpoint)}</dd>
                  <dt>Website</dt>
                  <dd><a class="src" href="${escapeHtml(operator.website)}" target="_blank" rel="noopener">${escapeHtml(host(operator.website))}</a></dd>
                  <dt>Tor tier</dt>
                  <dd>${tierChip(operator.tier)}<span class="row-hint">${escapeHtml(TIER_TEXT[operator.tier])}</span></dd>
                  <dt>Current health</dt>
                  <dd>Not checked on this page. Open the dashboard for observations from your reads.</dd>
                  <dt>Query price</dt>
                  <dd>Free in this demo. Operator-set pricing comes later.</dd>
                  <dt>Operator stake</dt>
                  <dd>Planned; no stake required by the current registrar.</dd>
                </dl>
              </div>
              <div>
                <div class="card-head" style="margin-bottom:12px">
                  <div>
                    <h2>Use only this operator</h2>
                    <p>Works today on Ethereum mainnet with <span class="mono">blockTag: "finalized"</span>.</p>
                  </div>
                </div>
                ${snippet("client.ts", pinSnippet(operator.ens))}
              </div>
            </div>
          </div>
        </div>
      </div>
    `,
  };
}
