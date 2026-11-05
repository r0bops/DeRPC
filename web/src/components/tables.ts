import type { Network, Operator } from "../data.ts";
import { formatEth, formatLatency, formatPrice, formatUptime, getNetwork, networkStats } from "../data.ts";
import {
  avatar,
  avatarTone,
  chip,
  escapeHtml,
  icon,
  scoreMarkup,
  verified,
} from "../ui.ts";

export function networkTable(rows: Network[], caption: string): string {
  const body =
    rows.length === 0
      ? emptyRow(6, "network", "")
      : rows
          .map((network) => {
            const stats = networkStats(network.id);
            const href = `#/network/${network.id}`;
            return `
              <tr data-href="${href}">
                <td>
                  <a class="row-link" href="${href}">
                    <span class="avatar ${avatarTone(network.name)}" aria-hidden="true">${escapeHtml(network.short)}</span>
                    <span>
                      <span class="row-title">${escapeHtml(network.name)}</span>
                      <span class="row-hint">Chain ID ${network.chainId}</span>
                    </span>
                  </a>
                </td>
                <td data-label="Operators" class="num">${stats.operatorCount}</td>
                <td data-label="Median price" class="num">${formatPrice(stats.medianPrice)}</td>
                <td data-label="Best latency" class="num">${formatLatency(stats.bestLatency)}</td>
                <td data-label="Verification">${verified(network.verified)}</td>
                <td class="col-chevron">${icon("chevron")}</td>
              </tr>
            `;
          })
          .join("");

  return `
    <div class="table-card">
      <table class="data-table">
        <caption class="sr-only">${escapeHtml(caption)}</caption>
        <thead>
          <tr>
            <th scope="col">Network</th>
            <th scope="col">Operators</th>
            <th scope="col">Median price</th>
            <th scope="col">Best latency</th>
            <th scope="col">Verification</th>
            <th scope="col"><span class="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

export function operatorTable(rows: Operator[], caption: string): string {
  const body =
    rows.length === 0
      ? emptyRow(8, "operator", "")
      : rows
          .map((operator) => {
            const href = `#/operator/${operator.ens}`;
            const networks = operator.networks
              .slice(0, 3)
              .map((id) => {
                const network = getNetwork(id);
                return chip(network?.name ?? id, `#/network/${id}`);
              })
              .join("");
            const extra = operator.networks.length - 3;
            const more = extra > 0 ? `<span class="chip">+${extra}</span>` : "";

            return `
              <tr data-href="${href}">
                <td>
                  <a class="row-link" href="${href}">
                    ${avatar(operator)}
                    <span>
                      <span class="row-title">${escapeHtml(operator.label)}</span>
                      <span class="row-hint">${escapeHtml(operator.ens)} · ${escapeHtml(operator.region)}</span>
                    </span>
                  </a>
                </td>
                <td data-label="Networks"><div class="chip-row">${networks}${more}</div></td>
                <td data-label="Score">${scoreMarkup(operator.score)}</td>
                <td data-label="Verified uptime" class="num">${formatUptime(operator.uptime)}</td>
                <td data-label="Stake" class="num">${formatEth(operator.stakeEth)} ETH</td>
                <td data-label="Price / 1k" class="num">${formatPrice(operator.pricePer1k)}</td>
                <td data-label="Latency" class="num">${formatLatency(operator.latencyMs)}</td>
                <td class="col-chevron">${icon("chevron")}</td>
              </tr>
            `;
          })
          .join("");

  return `
    <div class="table-card">
      <table class="data-table data-table--operators">
        <caption class="sr-only">${escapeHtml(caption)}</caption>
        <thead>
          <tr>
            <th scope="col">Operator</th>
            <th scope="col">Networks</th>
            <th scope="col">Score</th>
            <th scope="col">Verified uptime</th>
            <th scope="col">Stake</th>
            <th scope="col">Price / 1k</th>
            <th scope="col">Latency</th>
            <th scope="col"><span class="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

export function emptyRow(colspan: number, kind: string, query: string): string {
  return `
    <tr>
      <td colspan="${colspan}">
        <div class="empty">
          <strong>No ${escapeHtml(kind)} matches “${escapeHtml(query)}”.</strong>
          <p>Try a different search or clear it.</p>
          <button type="button" data-clear-search>Clear search</button>
        </div>
      </td>
    </tr>
  `;
}
