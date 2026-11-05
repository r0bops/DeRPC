import type { Network } from "../data.ts";
import { formatLatency, formatPrice, networkStats, operatorsForNetwork } from "../data.ts";
import type { PageResult } from "../page.ts";
import { demoNote, escapeHtml, icon, networkAvatar, snippet, verified } from "../ui.ts";
import { operatorTable } from "../components/tables.ts";

function integrationSnippet(): string {
  return `import { createDeRPC, MAINNET_OPERATORS } from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient } from "viem";
import { mainnet } from "viem/chains";

const derpc = createDeRPC({ operators: MAINNET_OPERATORS });
const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });

await client.getBalance({ address });`;
}

export function networkPage(network: Network): PageResult {
  const stats = networkStats(network.id);
  const serving = operatorsForNetwork(network.id);

  return {
    title: `${network.name} RPC`,
    html: `
      <div class="page">
        <div class="container">
          <a class="back-link" href="#/directory">${icon("arrowLeft")}All networks</a>
          <div class="page__head">
            <div class="detail-head">
              ${networkAvatar(network.name, network.short, true)}
              <div>
                <p class="kicker">Network</p>
                <h1 class="page-title">${escapeHtml(network.name)}</h1>
                <div class="detail-meta">
                  <span class="mono">Chain ID ${network.chainId}</span>
                  <span aria-hidden="true">·</span>
                  ${verified(network.verified)}
                </div>
              </div>
            </div>
          </div>
          <p class="page-lead">Operators serving ${escapeHtml(network.name)}, with verified uptime, stake and price per 1k reads.</p>

          <div class="metrics">
            <div class="metric">
              <div class="metric__label">Operators</div>
              <div class="metric__value">${stats.operatorCount}</div>
              <div class="metric__caption">Serving ${escapeHtml(network.name)}</div>
            </div>
            <div class="metric">
              <div class="metric__label">Median price</div>
              <div class="metric__value">${formatPrice(stats.medianPrice)}</div>
              <div class="metric__caption">Per 1k reads</div>
            </div>
            <div class="metric">
              <div class="metric__label">Best latency</div>
              <div class="metric__value">${formatLatency(stats.bestLatency)}</div>
              <div class="metric__caption">Measured by watchers</div>
            </div>
            <div class="metric">
              <div class="metric__label">Top score</div>
              <div class="metric__value">${stats.topScore.toFixed(1)}</div>
              <div class="metric__caption">Out of 100</div>
            </div>
          </div>

          <div class="stack">
            <div>
              <div class="card-head">
                <div>
                  <h2>Operators</h2>
                  <p>${serving.length} operators serving ${escapeHtml(network.name)}</p>
                </div>
              </div>
              ${operatorTable(serving, `Operators serving ${network.name}`)}
              ${demoNote()}
            </div>
            <div>${snippet("API preview", integrationSnippet())}</div>
          </div>
        </div>
      </div>
    `,
  };
}
