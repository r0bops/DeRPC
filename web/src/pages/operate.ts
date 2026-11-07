import "../directory/directory.css";

import { createOperatorConfigFragment, createOperatorDraft, MAX_DRAFT_NODES, type OperatorConfigFragment, type OperatorDraft } from "../directory/operator-draft.ts";
import { PENDING_OPERATORS, TEAM_REGISTRATION_CONFIG, TEAM_REGISTRATION_PLAN, teamRegistrationFragment } from "../directory/pending-operators.ts";
import type { PageResult } from "../page.ts";
import { demoHref, escapeHtml, snippet } from "../ui.ts";
import { mountOperatorWallet, operatorWalletHtml } from "../ens/panel.ts";

function field(id: string, label: string, placeholder: string, type = "text"): string {
  return `<div class="field">
    <label for="${id}">${label} (required)</label>
    <div class="input-group"><input id="${id}" name="${id}" type="${type}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" required aria-describedby="${id}-error" /></div>
    <p class="field__hint operator-draft-error" id="${id}-error" hidden></p>
  </div>`;
}

function nodeFields(key: number): string {
  return `<fieldset class="operator-node" data-node="${key}">
    <legend>Node ${key}</legend>
    <p class="field__hint">Ethereum mainnet · <span class="state-unknown">Health: unchecked</span></p>
    <div class="field">
      <label for="node-${key}-id">Stable node ID (required)</label>
      <div class="input-group"><input id="node-${key}-id" type="text" value="node-${key}" maxlength="31" autocomplete="off" spellcheck="false" required aria-describedby="node-${key}-id-hint node-${key}-id-error" /></div>
      <p class="field__hint" id="node-${key}-id-hint">Use the same ID in this node's DERPC_ENDPOINT_ID setting. Keep it when rotating the node's URL.</p>
      <p class="field__hint operator-draft-error" id="node-${key}-id-error" hidden></p>
    </div>
    ${field(`node-${key}-label`, "Node label", "Lisbon node")}
    ${field(`node-${key}-endpoint`, "Public RPC endpoint", "http://your-v3-address.onion/rpc", "url")}
    ${field(`node-${key}-beacon`, "Public beacon base URL", "http://your-v3-address.onion", "url")}
    <button type="button" class="btn btn--ghost btn--small" data-remove-node="${key}" aria-label="Remove node ${key}">Remove node</button>
  </fieldset>`;
}

const setup = `export DERPC_ENS_NAME=yourname.derpc.eth
export DERPC_SIGNER=0xYOUR_PUBLIC_SIGNER_ADDRESS
export DERPC_ENDPOINT_ID=node-1
export DERPC_EXECUTION_URL=http://127.0.0.1:8545
export DERPC_BEACON_URL=http://127.0.0.1:5052
unset DERPC_PAYMENT_ESCROW
pnpm --filter @derpc/wrapper run setup`;

export function operatePage(params = new URLSearchParams()): PageResult {
  // The URL selects a reviewed local entry only. Addresses, endpoints and roles never come from it.
  const prepared = teamRegistrationFragment(params.get("prepare"));
  const team = prepared?.operatorConfig;
  return {
    title: "Run an operator",
    html: `
      <section class="facts" aria-label="Running an operator at a glance">
        <dl class="container facts__grid">
          <div class="facts__item"><dt>Cost today</dt><dd>Free · no deposit or stake</dd></div>
          <div class="facts__item"><dt>${team ? "What you review" : "What you run"}</dt><dd>${team ? "One team-run proxy and its ENS registration inputs" : "Your own mainnet nodes, plus the wrapper on each"}</dd></div>
          <div class="facts__item"><dt>How callers reach you</dt><dd>One Tor onion address per node</dd></div>
          <div class="facts__item"><dt>This page</dt><dd>A local draft · nothing is registered</dd></div>
        </dl>
      </section>
      <div class="page">
        <div class="container">
          <div class="page__head">
            <div>
              <p class="kicker">Run an operator · Free demo</p>
              <h1 class="page-title">${team ? `Review ${escapeHtml(team.label)}.derpc.eth` : "One operator. Your nodes."}</h1>
              <p class="page-lead">${team ? "Review the existing proxy's public configuration before operator-signed registration. ENS enrollment is pending; signing requires a configured registrar and your explicit wallet review." : "Prepare your operator identity and public endpoints. You sign your own registration after the namespace's one-time setup. Local drafting needs no wallet; staking and payments come later."}</p>
            </div>
          </div>

          <p class="notice" id="operator-registration-flow"><span>Open registration: the namespace owner completes the one-time registrar setup, then each operator signs its own registration transactions. No per-name owner approval or approval bot is required. Check the deployment status below before connecting a wallet. The <a href="https://github.com/r0bops/DeRPC/blob/main/contracts/README.md" target="_blank" rel="noopener noreferrer">local wallet review helper</a> remains available for namespace setup and recovery.</span></p>

          ${operatorWalletHtml()}

          ${team && prepared ? `<section id="team-registration-review" class="operator-draft-review" aria-labelledby="team-registration-title">
            <h2 id="team-registration-title">Actual proxy · unsigned registration review</h2>
            <p>Both team operators share the same owner and signer. Separate names and proxies do not make them independent operators.</p>
            <p><span class="net-chip l">ENS pending</span> · <span class="state-unknown">Health: not checked on this device</span></p>
            <dl class="kv">
              <div><dt>RPC endpoint</dt><dd class="mono" style="overflow-wrap: anywhere">${escapeHtml(team.endpoint)}</dd></div>
              <div><dt>Beacon base URL</dt><dd class="mono" style="overflow-wrap: anywhere">${escapeHtml(team.beacon)}</dd></div>
              <div><dt>Operator owner and signer</dt><dd class="mono" style="overflow-wrap: anywhere">${escapeHtml(team.operator)}<span class="row-hint">Signer: ${escapeHtml(team.signer)}</span></dd></div>
              <div><dt>Endpoint-update key</dt><dd class="mono" style="overflow-wrap: anywhere">${escapeHtml(team.hotKey)}</dd></div>
              <div><dt>Proposed expiry</dt><dd>${escapeHtml(new Date(team.expiry * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC"))}</dd></div>
            </dl>
            <p class="field__hint">This existing wrapper uses one endpoint per ENS name. The configuration preserves its singular endpoint and beacon records; no node ID is added.</p>
            <pre id="team-registration-json" tabindex="0" aria-label="Exact singular operator registration fragment">${escapeHtml(JSON.stringify(prepared, null, 2))}</pre>
            <div class="controls">
              <button id="download-team-registration" class="btn btn--lime" type="button">Download this operator entry</button>
              <button id="download-team-config" class="btn btn--ghost" type="button">Download full two-operator config</button>
            </div>
            <p id="team-registration-status" role="status" aria-live="polite">Unsigned preparation only. Name availability, authority, lease, endpoint identity and proofs require verification. Nothing has been registered or published.</p>
            <ol class="operator-config-next">
              <li>Review both operator entries, the distinct update keys, shared owner/signer and fixed lease in the full configuration.</li>
              <li>Verify the namespace's one-time setup, then prepare a fresh unsigned registration plan for each operator's own wallet.</li>
              <li>Verify receipts and finalized ENS membership/records through DeRPC before selecting these operators for reads.</li>
            </ol>
            <details id="team-unsigned-plan">
              <summary>Review the first unsigned deployment stage · ${TEAM_REGISTRATION_PLAN.transactions.length} transactions</summary>
              <p>Review this stored setup preparation and its exact transaction list. Refresh the plan for the open-registration registrar before sending; each operator's registration requires a separate review and its own signer. Administrative preflight is not a light-client proof, and predicted addresses are not deployed contracts.</p>
              <ul>${TEAM_REGISTRATION_PLAN.transactions.map(transaction => `<li>${escapeHtml(transaction.purpose)}</li>`).join("")}</ul>
              <pre id="team-plan-json" tabindex="0" aria-label="Unsigned first deployment stage JSON">${escapeHtml(JSON.stringify(TEAM_REGISTRATION_PLAN, null, 2))}</pre>
              <button id="download-team-plan" class="btn btn--ghost" type="button">Download unsigned stage 1</button>
              <p>No wallet is connected or prompted. Refresh preflight and review each transaction with the authorized signer before sending it elsewhere.</p>
            </details>
            <a href="#/directory">Back to the operator directory</a>
          </section><details id="generic-onboarding"><summary>Prepare a different operator or multiple-node draft</summary>` : `
            ${params.has("prepare") ? '<p class="notice warn" role="status">No matching team operator. Choose a registration review from the directory; the form below is a new blank draft.</p>' : ""}
            <p class="legend">Review the team's actual registration inputs: ${PENDING_OPERATORS.map(operator => `<a href="#/operate?prepare=${encodeURIComponent(operator.label)}">${escapeHtml(operator.name)}</a>`).join(" · ")}</p>
          `}
          <div class="operate-grid operator-onboarding">
            <div>
              <form id="operate-form" novalidate>
                <div class="stepper">
                  <section class="step">
                    <div class="step__num" aria-hidden="true">1</div>
                    <div>
                      <h2 class="step__title">Choose your operator identity</h2>
                      <p class="step__desc">Plan one ENS subdomain for all your nodes. Name availability and control of these public addresses have not been checked.</p>
                      <div class="field">
                        <label for="operator-name">Operator name (required)</label>
                        <div class="input-group">
                          <input id="operator-name" name="name" type="text" placeholder="yourname" maxlength="31" autocomplete="off" spellcheck="false" required aria-describedby="name-hint operator-name-error" />
                          <span class="input-group__suffix">.derpc.eth</span>
                        </div>
                        <p class="field__hint" id="name-hint">1–31 lowercase letters, numbers and hyphens. This does not reserve the name.</p>
                        <p class="field__hint operator-draft-error" id="operator-name-error" hidden></p>
                      </div>
                      ${field("operator-owner", "Public operator owner address", "0x…")}
                      ${field("operator-signer", "Public wrapper identity signer", "0x…")}
                      <p class="field__hint">Public addresses only. Keep private keys and personal-service tokens out of this draft.</p>
                    </div>
                  </section>

                  <section class="step">
                    <div class="step__num" aria-hidden="true">2</div>
                    <div>
                      <h2 class="step__title">Add your node endpoints</h2>
                      <p class="step__desc">Run the wrapper on each node host, then use the public URLs it prints. Local node APIs stay on that host. Multiple nodes under one name still have one operator.</p>
                      <div id="operator-nodes">${nodeFields(1)}</div>
                      <p class="field__hint operator-draft-error" id="operator-nodes-error" hidden></p>
                      <button class="btn btn--ghost btn--small" type="button" id="add-node">Add another node</button>
                      <p class="field__hint">Up to ${MAX_DRAFT_NODES} nodes in one ENS endpoint-list record, within 4,096 UTF-8 bytes. Each node keeps a separate ID and health observation. Preparing this list does not register it.</p>
                    </div>
                  </section>

                  <section class="step">
                    <div class="step__num" aria-hidden="true">3</div>
                    <div>
                      <h2 class="step__title">Review the free configuration</h2>
                      <p class="step__desc">Ethereum mainnet reads. No deposit, mint or payment is requested by this page.</p>
                      <dl class="operator-draft-terms">
                        <div><dt>Current pricing</dt><dd>Free</dd></div>
                        <div><dt>Identity stake</dt><dd>Planned for registration</dd></div>
                        <div><dt>Stake per node</dt><dd>Planned; required amount changes with network traffic</dd></div>
                        <div><dt>Price per query</dt><dd>Planned; set by the operator</dd></div>
                      </dl>
                      <p class="field__hint">Stake amounts, currency, traffic measurement, adjustment formula and withdrawal rules are undecided. A stake does not prove that an operator is honest. Future price changes apply to new sessions.</p>
                    </div>
                  </section>

                  <section class="step">
                    <div class="step__num" aria-hidden="true">4</div>
                    <div>
                      <h2 class="step__title">Prepare registration inputs</h2>
                      <p class="step__desc">Optional. Add public role addresses and a fixed lease to prepare one operator configuration entry. Review a fresh registration plan with your own wallet after the namespace's one-time setup. No transaction is created or signed here.</p>
                      <details id="operator-deployment-fields">
                        <summary>Role addresses and expiry</summary>
                        <p class="field__hint">These fields are required only for a deployment fragment. The operator owner and signer come from step 1.</p>
                        ${field("operator-cold-owner", "Resolver cold owner", "0x…")}
                        <p class="field__hint">Controls the operator's dedicated resolver and its permissions.</p>
                        ${field("operator-hot-key", "Endpoint-update hot key", "0x…")}
                        <p class="field__hint">May update only the endpoint-list record. Use a different address from operator owners, resolver cold owners, the curator and other hot keys.</p>
                        ${field("operator-payee", "Public registrar payee", "0x…")}
                        <p class="field__hint">Required by the registrar layout even for a free listing. This does not activate payments.</p>
                        ${field("operator-expiry", "Fixed listing expiry (UTC)", "", "datetime-local")}
                        <p class="field__hint">Choose a specific UTC time within the next 30 days. The deployment preflight must check chain time and the parent name's expiry again.</p>
                      </details>
                      <button id="review-operator-config" class="btn btn--ghost btn--small" type="button">Review deployment fragment</button>
                    </div>
                  </section>
                </div>

                <div class="form-actions">
                  <button class="btn btn--lime" type="submit">Review local draft</button>
                  <span class="form-hint">No wallet connection or network request.</span>
                </div>
                <p id="operator-draft-status" class="form-hint operator-draft-status" role="status" aria-live="polite">Draft only. Nothing has been registered, checked or published.</p>
              </form>

              <section id="operator-draft-review" class="operator-draft-review" aria-labelledby="operator-review-title" hidden>
                <h2 class="step__title" id="operator-review-title" tabindex="-1">Review your draft</h2>
                <p class="field__hint">The fields have been validated locally. Ownership, reachability and proofs remain unchecked. This planning file is not an input for the ENS deployment CLI.</p>
                <pre id="operator-draft-json" tabindex="0" aria-label="Operator draft JSON"></pre>
                <button id="download-operator-draft" type="button" class="btn btn--ghost btn--small">Download draft JSON</button>
              </section>
              <section id="operator-config-review" class="operator-draft-review" aria-labelledby="operator-config-title" hidden>
                <h2 class="step__title" id="operator-config-title" tabindex="-1">Review the deployment fragment</h2>
                <p class="field__hint">Unsigned and unverified. This is one operator entry plus its endpoint-list record, not a complete deployment configuration or proof of enrollment.</p>
                <pre id="operator-config-json" tabindex="0" aria-label="Operator deployment fragment JSON"></pre>
                <button id="download-operator-config" type="button" class="btn btn--ghost btn--small">Download deployment fragment</button>
                <h3 class="operator-config-next-title">Before registering</h3>
                <ol class="operator-config-next">
                  <li>Use <code>operatorConfig</code> as reviewed public input to the operator registration planner. This fragment alone is not a complete CLI input. Shared ownership or multiple endpoints do not establish independent operators.</li>
                  <li>Verify the namespace's one-time setup and run a fresh mainnet preflight. Check name availability, role separation, parent lease and exact ENS contract code. Use the documented local review helper with your own wallet.</li>
                  <li>Test each endpoint's matching ENS name, signer and endpointId through Anon-RPC, then verify a public proof fixture. These checks have not run on this page.</li>
                  <li>Review and sign your own registration transactions. Verify the receipts, runtime and finalized client discovery before describing the operator as registered and usable.</li>
                </ol>
                <p class="field__hint">Open registration removes per-name owner approval. Lease limits, registrar administration and resolver permissions still need review. No current public registrar deployment or enrollment is claimed here.</p>
              </section>
            </div>

            <aside class="operator-onboarding-aside">
              <section class="panel panel--dark">
                <p class="panel__kicker">How your node is used</p>
                <h2 class="panel__title">Private routing. Verified answers.</h2>
                <p class="panel__text">The caller uses DeRPC and Anon-RPC to reach your wrapper through Tor. DeRPC checks supported answers against authenticated Ethereum state on the caller's device.</p>
                <ul class="panel__list operator-plain-list">
                  <li>Your node sees the query content. Tor aims to hide the caller's IP.</li>
                  <li>An onion endpoint alone does not make an ordinary HTTP wallet private.</li>
                  <li>Health checks describe recent observations, not a permanent safety guarantee.</li>
                </ul>
                <a class="btn btn--lime" href="${escapeHtml(demoHref())}">Open the free dashboard</a>
              </section>

              <section class="operator-wrapper-guide">
                <h2 class="step__title">Run a wrapper on each node host</h2>
                <p>Use Linux, Docker Compose, Node 24, and synchronized Ethereum mainnet execution and consensus nodes. Bind the node APIs to loopback.</p>
                <details>
                  <summary>Setup command and checks</summary>
                  <p>From the repository root, replace the name, public signer address and node ID with your own values. Each host's DERPC_ENDPOINT_ID must match its ID in the endpoint list. Adjust the local node ports if needed.</p>
                  ${snippet("On each node host", setup)}
                  <p>Setup starts Tor and the filtering proxy, checks local finalized proof availability and a beacon finality update, then prints this node's endpoint proposal. Merge all sibling endpoints into the reviewed list before publishing; replacing the list with one node's output would remove its siblings.</p>
                  <p>It does not publish ENS records, check ownership, authenticate the proof against a light client, or prove public onion reachability. Test the route through DeRPC separately.</p>
                  <a class="text-link" href="https://github.com/r0bops/DeRPC/blob/main/wrapper/README.md" target="_blank" rel="noreferrer">Read the operator guide</a>
                </details>
              </section>
            </aside>
          </div>
          ${team ? "</details>" : ""}
        </div>
      </div>
    `,
    bind(root) {
      const wallet = mountOperatorWallet(root, { operator: () => {
        if (team) return team;
        reviewInput(true);
        return fragment?.operatorConfig;
      } });
      const form = root.querySelector<HTMLFormElement>("#operate-form")!;
      const nodeList = root.querySelector<HTMLElement>("#operator-nodes")!;
      const add = root.querySelector<HTMLButtonElement>("#add-node")!;
      const review = root.querySelector<HTMLElement>("#operator-draft-review")!;
      const status = root.querySelector<HTMLElement>("#operator-draft-status")!;
      const download = root.querySelector<HTMLButtonElement>("#download-operator-draft")!;
      const json = root.querySelector<HTMLElement>("#operator-draft-json")!;
      const configReview = root.querySelector<HTMLElement>("#operator-config-review")!;
      const configJson = root.querySelector<HTMLElement>("#operator-config-json")!;
      const deploymentFields = root.querySelector<HTMLDetailsElement>("#operator-deployment-fields")!;
      let nextKey = 2;
      let draft: OperatorDraft | undefined;
      let fragment: OperatorConfigFragment | undefined;
      const input = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
      const rows = () => [...nodeList.querySelectorAll<HTMLElement>("[data-node]")];
      const invalidate = () => {
        draft = undefined;
        fragment = undefined;
        review.hidden = true;
        configReview.hidden = true;
        json.textContent = "";
        configJson.textContent = "";
        status.textContent = "Draft changed. Review it again before downloading. Nothing has been published.";
      };
      const updateNodeControls = () => {
        add.disabled = rows().length >= MAX_DRAFT_NODES;
        nodeList.querySelectorAll<HTMLButtonElement>("[data-remove-node]").forEach(button => { button.disabled = rows().length === 1; });
      };
      updateNodeControls();
      form.addEventListener("input", invalidate);
      form.addEventListener("input", wallet.invalidate);
      add.addEventListener("click", () => {
        if (rows().length >= MAX_DRAFT_NODES) return;
        const key = nextKey++;
        nodeList.insertAdjacentHTML("beforeend", nodeFields(key));
        updateNodeControls();
        invalidate();
        input(`node-${key}-label`).focus();
        status.textContent = `Node ${key} added. ${rows().length} nodes in this local draft.`;
      });
      nodeList.addEventListener("click", event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-remove-node]");
        if (!button || rows().length <= 1) return;
        button.closest("[data-node]")?.remove();
        updateNodeControls();
        invalidate();
        add.focus();
        status.textContent = `Node removed. ${rows().length} nodes in this local draft.`;
      });
      const showErrors = (errors: Record<string, string>) => {
        for (const [id, message] of Object.entries(errors)) {
          const error = root.querySelector<HTMLElement>(`#${id}-error`);
          if (error) { error.textContent = message; error.hidden = false; }
          input(id)?.setAttribute("aria-invalid", "true");
        }
        const first = form.querySelector<HTMLInputElement>("input[aria-invalid]");
        if (first?.closest("#operator-deployment-fields")) deploymentFields.open = true;
        (first ?? add).focus();
        status.textContent = "Check the highlighted fields, then review again. No data was sent.";
      };
      const reviewInput = (forDeployment: boolean) => {
        invalidate();
        form.querySelectorAll<HTMLElement>(".operator-draft-error").forEach(el => { el.textContent = ""; el.hidden = true; });
        form.querySelectorAll<HTMLElement>("[aria-invalid]").forEach(el => el.removeAttribute("aria-invalid"));
        const result = createOperatorDraft({
          name: input("operator-name").value, owner: input("operator-owner").value, signer: input("operator-signer").value,
          nodes: rows().map(row => {
            const key = row.dataset.node!;
            return { key, id: input(`node-${key}-id`).value, label: input(`node-${key}-label`).value, endpoint: input(`node-${key}-endpoint`).value, beacon: input(`node-${key}-beacon`).value };
          }),
        });
        if (result.errors) {
          showErrors(result.errors);
          return;
        }
        draft = result.draft;
        if (forDeployment) {
          const converted = createOperatorConfigFragment(draft, {
            coldOwner: input("operator-cold-owner").value, hotKey: input("operator-hot-key").value,
            payee: input("operator-payee").value, expiryUtc: input("operator-expiry").value,
          });
          if (converted.errors) { showErrors(converted.errors); return; }
          fragment = converted.fragment;
          configJson.textContent = JSON.stringify(fragment, null, 2);
          configReview.hidden = false;
        }
        json.textContent = JSON.stringify(draft, null, 2);
        review.hidden = false;
        status.textContent = forDeployment
          ? "Deployment fragment ready to review. Full config/preflight, endpoint checks and authorized signatures are still required. Nothing has been published."
          : "Draft ready to review. Name, ownership, health and proofs remain unchecked; nothing has been published.";
        const heading = root.querySelector<HTMLElement>(forDeployment ? "#operator-config-title" : "#operator-review-title");
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ block: "start", behavior: "instant" });
      };
      form.addEventListener("submit", event => {
        event.preventDefault();
        reviewInput(false);
      });
      root.querySelector<HTMLButtonElement>("#review-operator-config")!.addEventListener("click", () => reviewInput(true));
      const downloadJson = (value: unknown, name: string) => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      root.querySelector<HTMLButtonElement>("#download-team-registration")?.addEventListener("click", () => {
        if (!prepared || !team) return;
        downloadJson(prepared, `${team.label}.derpc.eth-operator-fragment.json`);
        root.querySelector<HTMLElement>("#team-registration-status")!.textContent = "Operator entry download requested. It is unsigned; complete the full preflight and authorized registration stages before claiming enrollment.";
      });
      root.querySelector<HTMLButtonElement>("#download-team-config")?.addEventListener("click", () => {
        downloadJson(TEAM_REGISTRATION_CONFIG, "ens-two-demo-operators-config-2026-11-07.json");
        root.querySelector<HTMLElement>("#team-registration-status")!.textContent = "Two-operator config download requested. No transaction or registration was sent.";
      });
      root.querySelector<HTMLButtonElement>("#download-team-plan")?.addEventListener("click", () => {
        downloadJson(TEAM_REGISTRATION_PLAN, "ens-two-demo-operators-plan-1-2026-11-07.json");
        root.querySelector<HTMLElement>("#team-registration-status")!.textContent = "Unsigned stage 1 download requested. No transaction was signed or sent; later registration stages require deployment receipts.";
      });
      download.addEventListener("click", () => {
        if (!draft) return;
        downloadJson(draft, `${draft.name}-draft.json`);
        status.textContent = "Draft download requested. Registration and endpoint checks still need to be completed separately.";
      });
      root.querySelector<HTMLButtonElement>("#download-operator-config")!.addEventListener("click", () => {
        if (!fragment) return;
        downloadJson(fragment, `${fragment.operatorConfig.label}.derpc.eth-operator-fragment.json`);
        status.textContent = "Deployment fragment download requested. It is unsigned and unverified; follow the remaining checks before any deployment.";
      });
      return () => wallet.close();
    },
  };
}
