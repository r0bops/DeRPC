import "../directory/directory.css";

import { NETWORKS, OPERATORS } from "../directory/operators.ts";
import { host } from "../directory/model.ts";
import { mountExplainerSlot } from "../explainer/ExplainerSlot.ts";
import type { PageResult } from "../page.ts";
import { avatar, codeCard, escapeHtml, icon } from "../ui.ts";
import { mockBadge, netChip, tierChip } from "./directory.ts";

const verifiedNetworks = NETWORKS.filter((network) => network.verification === "light-client");

function namesAt(tier: 1 | 2): string {
  const names = OPERATORS.filter((operator) => operator.tier === tier).map((operator) => operator.operator);
  const last = names.at(-1);
  if (!last || names.length === 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${last}`;
}

function operatorTable(): string {
  const rows = [...OPERATORS].sort((a, b) => a.tier - b.tier || a.operator.localeCompare(b.operator));
  return rows
    .map((operator) => {
      const href = `#/operator/${escapeHtml(operator.ens)}`;
      return `
        <tr data-href="${href}">
          <td>
            <a class="row-link" href="${href}">
              ${avatar(operator.operator, operator.ens)}
              <span>
                <span class="row-title">${escapeHtml(operator.operator)}</span>
                <span class="row-hint">${escapeHtml(operator.ens)} ${mockBadge}</span>
              </span>
            </a>
          </td>
          <td data-label="Priority">${tierChip(operator.tier)}</td>
          <td data-label="Endpoint" class="mono">${escapeHtml(host(operator.endpoint))}</td>
          <td data-label="Networks"><div class="chip-row">${operator.networks.map((entry) => netChip(entry.network)).join("")}</div></td>
        </tr>
      `;
    })
    .join("");
}

export function landingPage(): PageResult {
  return {
    title: "Private, verified RPC for Ethereum",
    html: `
      <section class="hero">
        <div class="container hero__inner">
          <div>
            <span class="eyebrow"><span class="eyebrow__dot" aria-hidden="true"></span>Private reads. Verified answers.</span>
            <h1 class="display">Choose your operators.<br /><span class="lime">Verify their answers.</span></h1>
            <p class="lead">DeRPC routes supported reads through Anon-RPC (tor-js 0.4.4) and checks EIP-1186 proofs against a Lodestar 1.43.0 light client. The route hides your IP from the endpoint; the endpoint still sees the query. If the route or the proof is missing, the read fails closed.</p>
            <div class="hero__actions">
              <a class="btn btn--lime" href="#/directory">Browse operators ${icon("arrow")}</a>
              <a class="btn btn--ghost" href="#/operate">Run an operator</a>
            </div>
          </div>
          <div class="hero__card">${codeCard()}</div>
        </div>
      </section>

      <section class="stats" aria-label="What is live">
        <div class="container">
          <div class="stats__grid">
            <div class="stat">
              <div class="stat__value">${OPERATORS.length}</div>
              <div class="stat__caption">Operators you can choose</div>
            </div>
            <div class="stat">
              <div class="stat__value">${NETWORKS.length}</div>
              <div class="stat__caption">Listed networks</div>
            </div>
            <div class="stat">
              <div class="stat__value">${verifiedNetworks.length}</div>
              <div class="stat__caption">Verified network, Ethereum</div>
            </div>
            <div class="stat">
              <div class="stat__value">0</div>
              <div class="stat__caption">Direct RPC fallbacks</div>
            </div>
          </div>
          <p class="stats__note">Five curated endpoints. Only Ethereum mainnet is verified, and only at the finalized block. Hiding an IP does not hide the query. ENS names in the directory are mock.</p>
        </div>
      </section>

      <section class="section" id="how-it-works">
        <div class="container">
          <div class="section__head">
            <p class="kicker">Why it holds</p>
            <h2 class="h2">Choice, privacy and proof.</h2>
            <p class="subtitle">The route hides your IP. The proof checks the answer. Remove either one and the call fails.</p>
          </div>

          <div class="explainer-slot">
            <p class="kicker">Interactive explainer</p>
            <h3 class="explainer-slot__title">How a read moves.</h3>
            <p class="explainer-slot__text">The frame below is the slot for the read-path player. A static diagram stands in until that player is mounted.</p>
            <div id="explainer-mount" data-explainer-slot></div>
          </div>

          <div class="card-grid">
            <article class="card">
              <div class="step-num">01</div>
              <h3 class="card__title">Private by route</h3>
              <p class="card__text">Reads go through the tor-js 0.4.4 worker in @anon-rpc/browser-harness. The endpoint sees a Tor exit, not your IP, and still sees the query and its timing. If the worker fails, the read errors. There is no direct RPC.</p>
            </article>
            <article class="card">
              <div class="step-num">02</div>
              <h3 class="card__title">Verified by proof</h3>
              <p class="card__text">The host checks each eth_getProof answer, EIP-1186, against the state root from a Lodestar 1.43.0 light client. An invalid proof is rejected before the answer reaches your app.</p>
            </article>
            <article class="card">
              <div class="step-num">03</div>
              <h3 class="card__title">Open by choice</h3>
              <p class="card__text">You pass the operators. Priority 0 is ${escapeHtml(namesAt(1))}. Priority 1 is ${escapeHtml(namesAt(2))}. A bad proof excludes that endpoint for this session. Directory names are mock.</p>
            </article>
          </div>
        </div>
      </section>

      <section class="section section--band" id="operators" aria-labelledby="operators-title">
        <div class="container">
          <div class="section__head">
            <p class="kicker">Operator directory</p>
            <h2 class="h2" id="operators-title">Five endpoints. You choose.</h2>
            <p class="subtitle">The same list as <span class="mono">MAINNET_OPERATORS</span>. Priority 0 is preferred. Priority 1 is the fallback. A filled ETH chip means DeRPC proved reads there. Other chips are listed, not verified.</p>
          </div>
          <div class="table-card">
            <table class="data-table">
              <caption class="sr-only">Operators in the DeRPC bootstrap list</caption>
              <thead>
                <tr>
                  <th scope="col">Operator</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Networks</th>
                </tr>
              </thead>
              <tbody>${operatorTable()}</tbody>
            </table>
          </div>
          <p class="stats-follow">PublicNode was unreliable for proofs through Tor. Blast announced a shutdown; the endpoint still answered on Nov 5, 2026.</p>
          <div class="hero__actions">
            <a class="btn btn--ink" href="#/directory">Open directory ${icon("arrow")}</a>
          </div>
        </div>
      </section>

      <section class="section" id="limits">
        <div class="container">
          <div class="section__head">
            <p class="kicker">Limits</p>
            <h2 class="h2">What a read can prove.</h2>
            <p class="subtitle">Ethereum mainnet, the finalized block, and the methods that carry a proof. This is a hackathon build, not a production RPC.</p>
          </div>
          <div class="card-grid">
            <article class="card">
              <h3 class="card__title">Proven today</h3>
              <p class="card__text">Balance, nonce, code and storage, from EIP-1186 proofs. The block number comes from the verified Lodestar header. <span class="mono">eth_chainId</span> is <span class="mono">0x1</span>. <span class="mono">eth_accounts</span> is empty: DeRPC holds no keys.</p>
            </article>
            <article class="card">
              <h3 class="card__title">Refused</h3>
              <p class="card__text"><span class="mono">latest</span>, <span class="mono">safe</span>, <span class="mono">pending</span>, and any other block. Logs, gas estimates and writes. <span class="mono">eth_call</span> is refused by default. A missing worker, a missing proof, or no chosen operator fails the read.</p>
            </article>
            <article class="card">
              <h3 class="card__title">Not this build</h3>
              <p class="card__text">Query privacy. Verified reads on other networks. Registered ENS names: the labels are mock, and real names are roadmap. A Nym worker pin exists and has not been validated. DeRPC is not a wallet.</p>
            </article>
          </div>
        </div>
      </section>

      <section class="section section--tight">
        <div class="container">
          <div class="panel-pair">
            <article class="panel panel--dark">
              <p class="panel__kicker">For app builders</p>
              <h2 class="panel__title">Add verified reads to your app.</h2>
              <p class="panel__text">Call createDeRPC on the user's device. derpc.provider is an EIP-1193 provider. derpcTransport wraps it for viem. Pass blockTag "finalized" on Ethereum mainnet.</p>
              <ul class="panel__list">
                <li>${icon("check")}No direct RPC if the route or the proof is missing.</li>
                <li>${icon("check")}You pass the operators. A bad proof excludes that endpoint.</li>
                <li>${icon("check")}No wallet connection. eth_accounts stays empty.</li>
              </ul>
              <div class="panel__actions">
                <a class="btn btn--ghost" href="#/directory">Open directory ${icon("arrow")}</a>
              </div>
            </article>
            <article class="panel panel--lime">
              <p class="panel__kicker">For operators</p>
              <h2 class="panel__title">One operator. A home for your nodes.</h2>
              <p class="panel__text">Prepare an operator identity and node endpoints, then run the wrapper beside your node. The free runtime can use more than one endpoint. Public enrollment is not live.</p>
              <ul class="panel__list">
                <li>${icon("check")}The draft stays in the browser until you download it.</li>
                <li>${icon("check")}Directory names are mock ENS labels. Real names are roadmap.</li>
                <li>${icon("check")}Callers use Anon-RPC. The node still sees the query.</li>
              </ul>
              <div class="panel__actions">
                <a class="btn btn--ink" href="#/operate">Run an operator ${icon("arrow")}</a>
              </div>
            </article>
          </div>
        </div>
      </section>
    `,
    bind(root) {
      const slot = root.querySelector<HTMLElement>("#explainer-mount");
      if (slot) mountExplainerSlot(slot);
    },
  };
}
