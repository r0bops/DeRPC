import "../directory/directory.css";

import { NETWORKS, OPERATORS } from "../directory/operators.ts";
import { getNetwork, host, isVerified, operatorsFor } from "../directory/model.ts";
import type { PageResult } from "../page.ts";
import { avatarTone, escapeHtml, icon } from "../ui.ts";
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

function personAvatar(label: string, seed: string, large = false, logoUrl?: string): string {
  if (logoUrl && !large) {
    return `<span class="op-logo-wrap ${avatarTone(seed)}" aria-hidden="true">
      <img class="op-logo-img" src="${escapeHtml(logoUrl)}" alt="" loading="lazy" width="40" height="40"
        onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.removeAttribute('hidden')" />
      <span hidden>${escapeHtml(initials(label))}</span>
    </span>`;
  }
  return `<span class="avatar ${avatarTone(seed)}${large ? " avatar--lg" : ""}" aria-hidden="true">${escapeHtml(initials(label))}</span>`;
}

export function networkPage(id: string): PageResult {
  const network = getNetwork(NETWORKS, id);
  if (!network) return notFoundPage();

  const operators = operatorsFor(OPERATORS, network.id);
  const verified = isVerified(NETWORKS, network.id);

  return {
    title: network.name,
    html: `
      <div class="page">
        <div class="container">
          <a class="back-link" href="#/directory?by=networks">${icon("arrowLeft")}All networks</a>
          <div class="page__head">
            <div class="detail-head">
              ${personAvatar(network.short, network.id, true)}
              <div>
                <p class="kicker">Network</p>
                <h1 class="page-title">${escapeHtml(network.name)}</h1>
                <div class="detail-meta">
                  <span>Chain ID ${network.chainId}</span>
                  ${
                    verified
                      ? '<span class="ok-dot">Reads proven by DeRPC</span>'
                      : '<span class="net-chip l">Listed, not verified</span>'
                  }
                </div>
              </div>
            </div>
          </div>

          ${
            verified
              ? `<div class="notice" role="note"><span><b>How reads are proven.</b> Answers are checked against the light client's finalized state, so they are about 13–19 minutes behind the chain head. The provider refuses <span class="mono">latest</span>.</span></div>`
              : `<div class="notice warn" role="note"><span><b>DeRPC cannot verify reads on ${escapeHtml(network.name)} yet.</b> Each chain needs its own light client, proof format, finality rules and working endpoints. These operators say they serve it; DeRPC does not prove their answers here.</span></div>`
          }

          <div class="metrics">
            <div class="metric">
              <div class="metric__label">Operators listing it</div>
              <div class="metric__value">${operators.length}</div>
            </div>
            <div class="metric">
              <div class="metric__label">Verification</div>
              <div class="metric__value metric__value--text">${verified ? "Proven" : "None yet"}</div>
            </div>
          </div>

          <div class="table-card">
            <table class="data-table">
              <caption class="sr-only">Operators listing ${escapeHtml(network.name)}</caption>
              <thead>
                <tr>
                  <th scope="col">Operator</th>
                  <th scope="col">Tor tier</th>
                  <th scope="col">Tested by DeRPC</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                ${operators
                  .map((operator) => {
                    const entry = operator.networks.find((item) => item.network === network.id)!;
                    const href = `#/operator/${escapeHtml(operator.ens)}`;
                    return `
                      <tr data-href="${href}">
                        <td>
                          <a class="row-link" href="${href}">
                            ${personAvatar(operator.operator, operator.ens, false, operator.logoUrl)}
                            <span>
                              <span class="row-title">${escapeHtml(operator.operator)}</span>
                              <span class="row-hint">${escapeHtml(operator.ens)} ${mockBadge}</span>
                            </span>
                          </a>
                        </td>
                        <td data-label="Tor tier">${tierChip(operator.tier)}</td>
                        <td data-label="Tested">${entry.tested ? "Yes" : "No"}</td>
                        <td class="src" data-label="Source"><a href="${escapeHtml(entry.source)}" target="_blank" rel="noopener">${escapeHtml(host(entry.source))}</a></td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `,
  };
}
