import type { PageResult } from "../page.ts";
import { networks, operators } from "../data.ts";
import { codeCard, icon } from "../ui.ts";

export function landingPage(): PageResult {
  return {
    title: "Private, verified RPC for Ethereum",
    html: `
      <section class="hero">
        <div class="container hero__inner">
          <div>
            <span class="eyebrow"><span class="eyebrow__dot" aria-hidden="true"></span>Private reads. Verified answers.</span>
            <h1 class="display">RPC you can trust<br />and <span class="lime">nobody can watch.</span></h1>
            <p class="lead">DeRPC routes every read through an anonymity network and checks every answer against a light client. If the route or the proof is missing, the call fails closed.</p>
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
              <div class="stat__value">${operators.length}</div>
              <div class="stat__caption">Operators</div>
            </div>
            <div class="stat">
              <div class="stat__value">${networks.length}</div>
              <div class="stat__caption">Networks</div>
            </div>
            <div class="stat">
              <div class="stat__value">Roadmap</div>
              <div class="stat__caption">Staking</div>
            </div>
            <div class="stat">
              <div class="stat__value">0</div>
              <div class="stat__caption">Direct fallbacks</div>
            </div>
          </div>
          <p class="stats__note">The five public mainnet endpoints shipped with the demo. Staking, payments and the ENS operator registry are roadmap, not live.</p>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section__head">
            <p class="kicker">Why it holds</p>
            <h2 class="h2">Three guarantees, one route.</h2>
            <p class="subtitle">Privacy is the route. Trust is the proof. Remove either one and the call fails. Operator stake is on the roadmap.</p>
          </div>
          <div class="card-grid">
            <article class="card">
              <div class="step-num">01</div>
              <h3 class="card__title">Private by route</h3>
              <p class="card__text">Reads travel through Anon-RPC. The operator never sees the caller's IP address, and there is no direct fallback.</p>
            </article>
            <article class="card">
              <div class="step-num">02</div>
              <h3 class="card__title">Verified by proof</h3>
              <p class="card__text">A light client checks every response before it reaches your app. A mismatch is an error, not a warning.</p>
            </article>
            <article class="card">
              <div class="step-num">03</div>
              <h3 class="card__title">Open by choice</h3>
              <p class="card__text">You pick the operators. A bad answer excludes that endpoint locally. Stake, scores and an ENS registry are roadmap.</p>
            </article>
          </div>
        </div>
      </section>

      <section class="section section--tight">
        <div class="container">
          <div class="panel-pair">
            <article class="panel panel--dark">
              <p class="panel__kicker">For app builders</p>
              <h2 class="panel__title">Keep your reads private without changing your stack.</h2>
              <p class="panel__text">One transport swap. Your viem calls keep working; the private route and the proof happen underneath.</p>
              <ul class="panel__list">
                <li>${icon("check")}No direct fallback. Ever.</li>
                <li>${icon("check")}ENS identity you can pin.</li>
                <li>${icon("check")}Pay per read, not per seat.</li>
              </ul>
              <div class="panel__actions">
                <a class="btn btn--ghost" href="#/directory">Open directory ${icon("arrow")}</a>
              </div>
            </article>
            <article class="panel panel--lime">
              <p class="panel__kicker">For operators</p>
              <h2 class="panel__title">Run a node. Earn per verified read.</h2>
              <p class="panel__text">Publish an endpoint, stake behind your name, and let independent watchers keep the score honest.</p>
              <ul class="panel__list">
                <li>${icon("check")}An ENS name under .ops.derpc.eth.</li>
                <li>${icon("check")}A stake-backed public score.</li>
                <li>${icon("check")}Revenue from verified reads.</li>
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
