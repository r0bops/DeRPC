import type { PageResult } from "../page.ts";
import { NETWORKS, OPERATORS } from "../directory/operators.ts";
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
              <div class="stat__value">${OPERATORS.length}</div>
              <div class="stat__caption">Operators</div>
            </div>
            <div class="stat">
              <div class="stat__value">${NETWORKS.length}</div>
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
          <p class="stats__note">Five operators you can choose today. Only Ethereum mainnet is verified. Staking, payments and the ENS operator registry are roadmap, not live.</p>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="section__head">
            <p class="kicker">How it works</p>
            <h2 class="h2">Route. Prove. Choose.</h2>
          </div>
          <div class="card-grid">
            <article class="card">
              <div class="card__icon">
                <svg viewBox="0 0 44 44" fill="none" aria-hidden="true">
                  <path d="M22 4 L6 10 v10 c0 9 7 17 16 20 9-3 16-11 16-20V10Z" stroke="#c8f63c" stroke-width="1.5" fill="rgba(200,246,60,0.09)" stroke-linejoin="round"/>
                  <path d="M14 24 a8 8 0 0 1 16 0" stroke="rgba(200,246,60,0.55)" stroke-width="1.3" stroke-linecap="round"/>
                  <path d="M17 24 a5 5 0 0 1 10 0" stroke="rgba(200,246,60,0.75)" stroke-width="1.3" stroke-linecap="round"/>
                  <circle cx="22" cy="24" r="2.5" fill="rgba(200,246,60,0.9)"/>
                </svg>
              </div>
              <h3 class="card__title">Private by route</h3>
              <p class="card__text">Reads go through Anon-RPC. Tor hides your IP from the endpoint. No direct fallback, ever.</p>
            </article>
            <article class="card">
              <div class="card__icon">
                <svg viewBox="0 0 44 44" fill="none" aria-hidden="true">
                  <rect x="4" y="12" width="15" height="12" rx="3" stroke="#8c8cff" stroke-width="1.5" fill="rgba(140,140,255,0.08)"/>
                  <rect x="25" y="12" width="15" height="12" rx="3" stroke="#c8f63c" stroke-width="1.5" fill="rgba(200,246,60,0.09)"/>
                  <path d="M19 18h6" stroke="rgba(140,140,255,0.6)" stroke-width="1.5" stroke-linecap="round"/>
                  <path d="M28.5 15.5 l2.5 3 4.5-5" stroke="#c8f63c" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M4 32h36" stroke="rgba(140,140,255,0.2)" stroke-width="1.2" stroke-linecap="round"/>
                  <path d="M4 36h22" stroke="rgba(140,140,255,0.15)" stroke-width="1.2" stroke-linecap="round"/>
                </svg>
              </div>
              <h3 class="card__title">Verified by proof</h3>
              <p class="card__text">Every answer checked against the light client's finalized state. Invalid proofs fail closed before reaching your app.</p>
            </article>
            <article class="card">
              <div class="card__icon">
                <svg viewBox="0 0 44 44" fill="none" aria-hidden="true">
                  <circle cx="22" cy="20" r="6" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" fill="rgba(255,255,255,0.07)"/>
                  <circle cx="8" cy="36" r="5" stroke="rgba(140,140,255,0.5)" stroke-width="1.5" fill="rgba(140,140,255,0.08)"/>
                  <circle cx="22" cy="36" r="5" stroke="#c8f63c" stroke-width="1.5" fill="rgba(200,246,60,0.12)"/>
                  <circle cx="36" cy="36" r="5" stroke="rgba(140,140,255,0.3)" stroke-width="1.5" fill="rgba(140,140,255,0.05)"/>
                  <path d="M17.5 23.5 L10 32" stroke="rgba(140,140,255,0.35)" stroke-width="1.2"/>
                  <path d="M22 26v5" stroke="#c8f63c" stroke-width="1.5"/>
                  <path d="M26.5 23.5 L34 32" stroke="rgba(140,140,255,0.2)" stroke-width="1.2"/>
                  <circle cx="22" cy="36" r="2" fill="rgba(200,246,60,0.7)"/>
                </svg>
              </div>
              <h3 class="card__title">Open by choice</h3>
              <p class="card__text">You pick the operators and inspect local health. ENS enrollment and staking come in the next milestone.</p>
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
              <p class="panel__text">Private workspace package — integrate from the repo. EIP-1193 and viem. All verification runs on the user's device.</p>
              <ul class="panel__list">
                <li>${icon("check")}<code>eth_getBalance</code> · <code>eth_getCode</code> · <code>eth_getStorageAt</code></li>
                <li>${icon("check")}<code>eth_getTransactionCount</code> · <code>eth_blockNumber</code></li>
                <li>${icon("check")}Pass <code>blockTag: "finalized"</code> — <code>latest</code> is refused.</li>
              </ul>
              <div class="panel__actions">
                <a class="btn btn--ghost" href="#/directory">Open directory ${icon("arrow")}</a>
              </div>
            </article>
            <article class="panel panel--lime">
              <p class="panel__kicker">For operators</p>
              <h2 class="panel__title">One identity. Up to 8 nodes.</h2>
              <p class="panel__text">Run the wrapper beside your Ethereum node. Callers reach you through Tor. ENS registration and staking come in the next milestone.</p>
              <ul class="panel__list">
                <li>${icon("check")}Free to run today — no deposit or stake.</li>
                <li>${icon("check")}Each node gets its own Tor onion address.</li>
                <li>${icon("check")}Draft your operator config locally, no wallet needed.</li>
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
