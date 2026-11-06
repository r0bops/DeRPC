import { NETWORKS } from "../directory/operators.ts";
import type { PageResult } from "../page.ts";
import { escapeHtml, icon } from "../ui.ts";

function networkChoices(): string {
  return NETWORKS
    .map(
      (network, index) => `
        <label>
          <input type="checkbox" name="networks" value="${escapeHtml(network.id)}"${index === 0 ? " checked" : ""} />
          <span>${escapeHtml(network.name)}</span>
        </label>
      `,
    )
    .join("");
}

export function operatePage(): PageResult {
  return {
    title: "Run an operator",
    html: `
      <div class="page">
        <div class="container">
          <div class="page__head">
            <div>
              <p class="kicker">Run an operator</p>
              <h1 class="page-title">Put your node behind a name.</h1>
              <p class="page-lead">This is a preview of the onboarding flow. Names, stake and pricing will register on-chain once the operator registry is deployed.</p>
            </div>
          </div>

          <div class="operate-grid">
            <form id="operate-form" novalidate>
              <div class="stepper">
                <section class="step">
                  <div class="step__num">1</div>
                  <div>
                    <h2 class="step__title">Choose a name</h2>
                    <p class="step__desc">Your ENS name is your identity in the directory.</p>
                    <div class="field">
                      <label for="operator-name">Name</label>
                      <div class="input-group">
                        <input id="operator-name" name="name" type="text" placeholder="yourname" autocomplete="off" aria-describedby="name-hint" />
                        <span class="input-group__suffix">.ops.derpc.eth</span>
                      </div>
                      <p class="field__hint" id="name-hint">Lowercase letters, numbers and hyphens.</p>
                    </div>
                  </div>
                </section>

                <section class="step">
                  <div class="step__num">2</div>
                  <div>
                    <h2 class="step__title">Set stake and price <span class="mock">roadmap</span></h2>
                    <p class="step__desc">Preview only. Stake, scores and paid reads are not live in this build.</p>
                    <div class="form-row">
                      <div class="field">
                        <label for="operator-stake">Stake</label>
                        <div class="input-group">
                          <input id="operator-stake" name="stake" type="number" min="0" step="1" placeholder="1000" />
                          <span class="input-group__suffix">ETH</span>
                        </div>
                      </div>
                      <div class="field">
                        <label for="operator-price">Price</label>
                        <div class="input-group">
                          <input id="operator-price" name="price" type="number" min="0" step="0.01" placeholder="0.40" />
                          <span class="input-group__suffix">$ / 1k</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="step">
                  <div class="step__num">3</div>
                  <div>
                    <h2 class="step__title">Publish endpoint and networks</h2>
                    <p class="step__desc">The endpoint stays behind the private route. Callers never connect to it directly.</p>
                    <div class="field">
                      <label for="operator-endpoint">Endpoint</label>
                      <div class="input-group">
                        <input id="operator-endpoint" name="endpoint" type="url" placeholder="https://rpc.yourname.derpc.eth" autocomplete="off" />
                      </div>
                    </div>
                    <fieldset class="field field--plain">
                      <legend>Networks</legend>
                      <div class="network-list">${networkChoices()}</div>
                    </fieldset>
                  </div>
                </section>
              </div>

              <div class="form-actions">
                <button class="btn btn--lime" type="submit" disabled title="Registration is disabled until the registry contracts are deployed.">Publish operator</button>
                <span class="form-hint">Preview only. Registration opens when the registry contracts are live.</span>
              </div>
            </form>

            <aside class="panel panel--dark">
              <p class="panel__kicker">What operators get</p>
              <h2 class="panel__title">Endpoint listing today. Registry later.</h2>
              <p class="panel__text">Callers can pin your endpoint now. ENS names, scores, stake and payments are roadmap, not live.</p>
              <ul class="panel__list">
                <li>${icon("check")}List an endpoint callers can choose today.</li>
                <li>${icon("check")}ENS name under .ops.derpc.eth: planned.</li>
                <li>${icon("check")}Watcher scores, stake and paid reads: planned.</li>
                <li>${icon("check")}Private route: callers do not connect to your node directly.</li>
              </ul>
            </aside>
          </div>
        </div>
      </div>
    `,
    bind(root) {
      const form = root.querySelector<HTMLFormElement>("#operate-form");
      form?.addEventListener("submit", (event) => {
        event.preventDefault();
      });
    },
  };
}
