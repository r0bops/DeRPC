import type { Operator } from "../data.ts";
import {
  formatEth,
  formatMonth,
  formatPrice,
  formatUptime,
  getNetwork,
  uptimeSeries,
} from "../data.ts";
import type { PageResult } from "../page.ts";
import {
  avatar,
  chip,
  escapeHtml,
  icon,
  snippet,
  verified,
} from "../ui.ts";

function uptimeChart(operator: Operator): string {
  const series = uptimeSeries(operator);
  const rawMin = Math.min(...series);
  const rawMax = Math.max(...series);
  const min = rawMin - 0.08;
  const max = rawMax + 0.08;
  const range = Math.max(0.1, max - min);
  const points = series.map((value, index) => {
    const x = 10 + (index / (series.length - 1)) * 580;
    const y = 102 - ((value - min) / range) * 84;
    return [x, y] as const;
  });
  const first = points[0] ?? ([10, 102] as const);
  const last = points[points.length - 1] ?? first;
  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${last[0].toFixed(1)} 108 L${first[0].toFixed(1)} 108 Z`;
  const gradient = `uptime-gradient-${operator.name}`;
  const title = `uptime-title-${operator.name}`;
  const desc = `uptime-desc-${operator.name}`;

  return `
    <svg class="chart" viewBox="0 0 600 120" role="img" aria-labelledby="${title} ${desc}">
      <title id="${title}">30-day verified uptime for ${escapeHtml(operator.ens)}</title>
      <desc id="${desc}">Daily uptime measured by ${operator.watchers} independent watchers. The latest verified measurement is ${formatUptime(operator.uptime)}.</desc>
      <defs>
        <linearGradient id="${gradient}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2B2BFF" stop-opacity="0.22" />
          <stop offset="1" stop-color="#2B2BFF" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#${gradient})" />
      <path d="${line}" fill="none" stroke="#2B2BFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4.5" fill="#C8F63C" stroke="#0A0A0F" stroke-width="2" />
    </svg>
  `;
}

function pinSnippet(operator: Operator): string {
  return `import { createClient } from "viem";
import { derpc } from "@derpc/transport";

const client = createClient({
  chain: mainnet,
  transport: derpc({
    pin: "${operator.ens}",
  }),
});`;
}

function scoreRows(operator: Operator): string {
  const rows: Array<[string, number]> = [
    ["Verified uptime", operator.breakdown.uptime],
    ["Correctness", operator.breakdown.correctness],
    ["Latency", operator.breakdown.latency],
    ["Stake", operator.breakdown.stake],
  ];

  return rows
    .map(
      ([label, value]) => `
        <div class="bar-row">
          <span class="bar-row__label">${label}</span>
          <span class="bar-row__track"><span class="bar-row__fill" style="width:${value}%"></span></span>
          <span class="bar-row__value">${value}</span>
        </div>
      `,
    )
    .join("");
}

export function operatorPage(operator: Operator): PageResult {
  const verifiedNetworks = operator.networks.filter((id) => getNetwork(id)?.verified).length;
  const networkChips = operator.networks
    .map((id) => {
      const network = getNetwork(id);
      return chip(network?.name ?? id, `#/network/${id}`);
    })
    .join("");

  return {
    title: `${operator.ens} · Operator`,
    html: `
      <div class="page">
        <div class="container">
          <a class="back-link" href="#/directory?by=operator">${icon("arrowLeft")}All operators</a>
          <div class="page__head">
            <div class="detail-head">
              ${avatar(operator, true)}
              <div>
                <p class="kicker">Operator</p>
                <h1 class="page-title">${escapeHtml(operator.ens)}</h1>
                <div class="detail-meta">
                  <span>${escapeHtml(operator.label)}</span>
                  <span aria-hidden="true">·</span>
                  <span>${escapeHtml(operator.region)}</span>
                  <span aria-hidden="true">·</span>
                  ${verified(verifiedNetworks > 0, `Proofs on ${verifiedNetworks} network${verifiedNetworks === 1 ? "" : "s"}`)}
                </div>
              </div>
            </div>
          </div>
          <p class="page-lead">${escapeHtml(operator.about)}</p>

          <div class="metrics">
            <div class="metric">
              <div class="metric__label">Score</div>
              <div class="metric__value">${operator.score.toFixed(1)}</div>
              <div class="metric__caption">Out of 100</div>
            </div>
            <div class="metric">
              <div class="metric__label">Verified uptime</div>
              <div class="metric__value">${formatUptime(operator.uptime)}</div>
              <div class="metric__caption">${operator.watchers} independent watchers</div>
            </div>
            <div class="metric">
              <div class="metric__label">Price</div>
              <div class="metric__value">${formatPrice(operator.pricePer1k)}</div>
              <div class="metric__caption">Per 1k reads</div>
            </div>
            <div class="metric">
              <div class="metric__label">Stake</div>
              <div class="metric__value">${formatEth(operator.stakeEth)} ETH</div>
              <div class="metric__caption">Bonded</div>
            </div>
          </div>

          <div class="detail-grid">
            <div class="stack">
              <div class="chart-card">
                <div class="card-head">
                  <div>
                    <h2>30-day verified uptime</h2>
                    <p>Daily measurements</p>
                  </div>
                  <span class="verified"><span class="ok-dot" aria-hidden="true"></span>${operator.watchers} watchers</span>
                </div>
                ${uptimeChart(operator)}
                <p class="chart__note">Measured by ${operator.watchers} independent watchers against the light client. Latest verified measurement: ${formatUptime(operator.uptime)}.</p>
              </div>
              <div class="card">
                <div class="card-head">
                  <div>
                    <h2>Score breakdown</h2>
                    <p>Four components, one public number</p>
                  </div>
                  <span class="score__value">${operator.score.toFixed(1)}</span>
                </div>
                <div class="bars">${scoreRows(operator)}</div>
              </div>
            </div>
            <div class="stack">
              <div class="card">
                <div class="card-head">
                  <div>
                    <h2>ENS record</h2>
                    <p>Resolved from the operator registry</p>
                  </div>
                  <span class="chip">Resolved</span>
                </div>
                <dl class="kv">
                  <dt>Name</dt>
                  <dd class="mono">${escapeHtml(operator.ens)}</dd>
                  <dt>Endpoint</dt>
                  <dd class="mono">${escapeHtml(operator.endpoint)}</dd>
                  <dt>Region</dt>
                  <dd>${escapeHtml(operator.region)}</dd>
                  <dt>Networks</dt>
                  <dd><div class="chip-row">${networkChips}</div></dd>
                  <dt>Operating since</dt>
                  <dd>${formatMonth(operator.since)}</dd>
                  <dt>Stake</dt>
                  <dd>${formatEth(operator.stakeEth)} ETH</dd>
                </dl>
              </div>
              <div>${snippet("API preview", pinSnippet(operator))}</div>
            </div>
          </div>
        </div>
      </div>
    `,
  };
}
