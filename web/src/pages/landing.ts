import type { PageResult } from "../page.ts";
import { NETWORKS, OPERATORS } from "../directory/operators.ts";
import { PENDING_OPERATORS } from "../directory/pending-operators.ts";
import { codeCard, icon } from "../ui.ts";

export function landingPage(): PageResult {
  return {
    title: "Private, verified RPC for Ethereum",
    html: `
      <section class="hero">
        <div class="container hero__inner">
          <div>
            <span class="eyebrow"><span class="eyebrow__dot" aria-hidden="true"></span>Private reads. Verified answers.</span>
            <h1 class="display">Choose your operators.<br /><span class="lime">Verify their answers.</span></h1>
            <p class="lead">DeRPC routes supported reads through Anon-RPC and checks answers against authenticated Ethereum state. The route hides your IP from the RPC endpoint; the endpoint still sees the query. If the route or proof is missing, the read fails closed. Ethereum mainnet only; experimental and not ready for production.</p>
            <div class="hero__actions">
              <a class="btn btn--lime" href="#/directory">Browse operators ${icon("arrow")}</a>
              <a class="btn btn--ghost" href="#/operate">Run an operator</a>
            </div>
          </div>
          <div class="hero__card">${codeCard()}</div>
        </div>
      </section>

      <section class="stats" aria-label="Network snapshot">
        <div class="container">
          <div class="stats__grid">
            <div class="stat">
              <div class="stat__value">${PENDING_OPERATORS.length}</div>
              <div class="stat__caption">Team operators · ENS pending</div>
            </div>
            <div class="stat">
              <div class="stat__value">${NETWORKS.filter(network => network.verification === "light-client").length}</div>
              <div class="stat__caption">Verified network</div>
            </div>
            <div class="stat">
              <div class="stat__value">${OPERATORS.length}</div>
              <div class="stat__caption">Bootstrap providers</div>
            </div>
            <div class="stat">
              <div class="stat__value">0</div>
              <div class="stat__caption">Direct fallbacks</div>
            </div>
          </div>
          <p class="stats__note">Each team proxy has its own operator entry; ENS enrollment is pending. Public bootstrap providers remain available for verified mainnet reads and directory discovery. Staking and payments remain off.</p>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section__head">
            <p class="kicker">Why it holds</p>
            <h2 class="h2">Choice, privacy and proof.</h2>
            <p class="subtitle">Privacy is the route. Trust is the proof. Remove either one and the call fails. Operator stake is on the roadmap.</p>
          </div>
          <div class="card-grid">
            <article class="card">
              <div class="step-num">01</div>
              <h3 class="card__title">Private by route</h3>
              <p class="card__text">Reads travel through Anon-RPC. Tor aims to hide your IP from the endpoint; query contents and timing remain visible. There is no direct RPC fallback.</p>
            </article>
            <article class="card">
              <div class="step-num">02</div>
              <h3 class="card__title">Verified by proof</h3>
              <p class="card__text">The host verifies supported answers against state authenticated by a light client. An invalid proof is rejected before the answer reaches your app.</p>
            </article>
            <article class="card">
              <div class="step-num">03</div>
              <h3 class="card__title">Open by choice</h3>
              <p class="card__text">You pick the operators and inspect local health observations. Invalid proofs exclude an endpoint locally. ENS enrollment and staking come later.</p>
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
              <p class="panel__text">Use the <code>@derpc/provider</code> workspace package with viem for finalized mainnet reads. It is not published to npm; integrate from the repository. Anonymous routing and verification run on the user's device.</p>
              <ul class="panel__list">
                <li>${icon("check")}No direct fallback. Ever.</li>
                <li>${icon("check")}Free reads with no wallet connection.</li>
                <li>${icon("check")}Supported: <code>eth_getBalance</code>, <code>eth_getCode</code>, <code>eth_getStorageAt</code>, <code>eth_getTransactionCount</code>, <code>eth_blockNumber</code>. Pass <code>blockTag: "finalized"</code>; <code>latest</code> is refused.</li>
              </ul>
              <div class="panel__actions">
                <a class="btn btn--ghost" href="#/directory">Open directory ${icon("arrow")}</a>
              </div>
            </article>
            <article class="panel panel--lime">
              <p class="panel__kicker">For operators</p>
              <h2 class="panel__title">One operator. A home for your nodes.</h2>
              <p class="panel__text">Prepare an operator identity and node endpoints, then run the wrapper beside your node. Multi-endpoint routing is implemented; independent public enrollment and its live lifecycle demonstration remain pending.</p>
              <ul class="panel__list">
                <li>${icon("check")}Plan yourname.derpc.eth and its endpoints.</li>
                <li>${icon("check")}Staking per identity and node is planned.</li>
                <li>${icon("check")}Set a price per verified read in the later paid rollout.</li>
              </ul>
              <div class="panel__actions">
                <a class="btn btn--ink" href="#/operate">Run an operator ${icon("arrow")}</a>
              </div>
            </article>
          </div>
        </div>
      </section>
    `,
  };
}
