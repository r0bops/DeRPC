# AI Usage

DeRPC is being built at ETHGlobal Mumbai (Nov 5–7, 2026), with AI tools as assistants. ETHGlobal requires teams to document where and how AI was used, and to keep their spec files, prompts and planning artifacts in the repo (see [`specs/SUBMISSION.md`](specs/SUBMISSION.md)). This file records that. [`REPO_LAYOUT.md`](REPO_LAYOUT.md) maps where everything lives.

Tools used:
- **Claude Code**, working inside this repo;
- **OpenAI Codex**, which drafted the roadmap and revised the other planning docs to match it;
- **Claude (claude.ai)** for planning;
- **the MumballyETH assistant**, which relays Grok, Claude, ChatGPT and Gemini, for planning and reviews.

---

## How we work with AI

- **Planning:** ideas were explored and reviewed in AI conversations, kept verbatim in [`specs/prompts/`](specs/prompts/).
- **Spec-driven development:** the team records direction in [`specs/`](specs/) (`CONTEXT.md`, `ROADMAP.md`, `TRACKS.md`, `SUBMISSION.md`, `ANON_RPC.md`). Coding agents must read them before working.
- **Standing instructions:** local instruction files, kept out of the repo, point every agent session at [`specs/`](specs/) and repeat the rules recorded there: fail closed with no direct RPC fallback, keep verification in the host, and write all code during the hackathon.
- **Human-directed history:** the team authorizes the commit scope and split; commit messages carry no AI co-author lines. Agents may make local commits when the team authorizes them, but do not push. Claude Code ran the first code commits (workspace, provider and frontend, Nov 5) at the team's explicit request. A later Nov 6 series recorded the accumulated non-Markdown changes in 30 dependency-ordered local commits, with no push. In this session, the team authorized OpenAI Codex to make a further dependency-ordered series covering the follow-up implementation, evidence, package guides and README; those commits also remain local.

---

The team subsequently authorized branch reconciliation and merging into `main` through a reviewed integration branch. This authorization is separate from site publication and production deployment.

## Authored by humans, no AI assistance

*Pending. The team fills this in.*

---

## Planning and specs

- **Files assisted:** `THREAT_MODEL.md`, `specs/CONTEXT.md`, `specs/ROADMAP.md`, `specs/DEMO_WORKFLOW.md`, `specs/ENS_TOR_MILESTONE.md`, `specs/TRACKS.md`, `specs/SUBMISSION.md`, `specs/ANON_RPC.md`, `specs/OPERATIONS.md`, `specs/QA_REPORT.md`. The planning was done with AI.
- **Release preparation:** OpenAI Codex drafted `ARCHITECTURE.md`, `FEEDBACK.md` and `specs/SUBMISSION_DRAFT.md`, and reconciled `docs/tracks.md`, from the implementation and recorded evidence at the team's request to finish locally actionable pending work. The packet includes project/partner text, a timed recording script and external completion gates. It does not represent a delivered partner conversation, recorded human voice, public deployment or submitted application.
- **AI role:**
  - Explored and reviewed ideas in the planning conversations ([`specs/prompts/`](specs/prompts/)), including the first project brief, which became `specs/CONTEXT.md`.
  - Claude Code condensed the ETHGlobal prize and rules pages the team pasted in into `TRACKS.md` and `SUBMISSION.md`.
  - Claude Code read the upstream Anon-RPC repo and wrote `ANON_RPC.md`. It also read the deployed worker contracts' storage through a public RPC to confirm where the worker hash lives.
  - Claude Code kept `CONTEXT.md` up to date as decisions were made.
  - OpenAI Codex drafted `ROADMAP.md`, and it edited `CONTEXT.md`, `ANON_RPC.md`, `TRACKS.md` and `SUBMISSION.md` to match the roadmap.
  - OpenAI Codex turned the roadmap into [GitHub issues](https://github.com/r0bops/DeRPC/issues/1), revised their wording at the team's request, and linked them from `specs/ROADMAP.md`.
  - OpenAI Codex updated `CONTEXT.md` and `ROADMAP.md` for the Nov 6 branch integration: bounded response streams, polling health, release gateway checks and combined directory/demo packaging.
  - OpenAI Codex recorded the team's expanded ENS, wrapper and payment scope and reconciled the implementation and measured local/live evidence with outstanding public deployment and external review gates; prepared `specs/OPERATIONS.md` for those remaining steps, including sponsored read authorization, encrypted restoration, beacon startup cancellation and the local wallet review workflow.
  - OpenAI Codex refined the commit plan in `specs/OPERATIONS.md` around actual module dependencies, kept the two payment lifecycle corrections with their implementation tests, separated journal storage from settlement handling, and identified shared-file hunks that must move together.
  - After the team signed the Hoodi escrow deployment, OpenAI Codex recorded its receipt/runtime verification through two administrative RPC sources and updated the planning and operations documents to distinguish that completed deployment from the remaining ENS, paid-session and review gates.
  - OpenAI Codex recorded the team's subsequent free-release-first priority, keeping independent-operator ENS onboarding deferred and payment rollout at the end while preserving their implementation and deployment evidence.
  - OpenAI Codex translated the team's operator-dashboard workflow into `DEMO_WORKFLOW.md`, recorded their explicit free-first and traffic-dependent per-node staking decisions, and separated implemented behavior from multi-endpoint runtime and economic requirements. The plan distinguishes proof correctness, local health, ENS identity and privacy limits.
  - At the team's request, OpenAI Codex planned `ENS_TOR_MILESTONE.md`: a real ENSv2/onion operator lifecycle followed by multiple endpoints per operator, with ordered work packages, parallel ownership boundaries, public-input dependencies, permissions and finality checks, and concrete demo completion evidence. This was a planning change, not deployment or implementation of the milestone.
  - OpenAI Codex recorded the team's automatic-routing decision: balanced, fastest and reliable local selection, optional all/restricted allowlists, preserved manual behavior, proven ENS admission, free-only operation and mainnet scope. Updated the milestone and provider instructions to distinguish the current bootstrap roster from deployed ENS operators.
  - OpenAI Codex wrote the standalone threat model from the implemented browser, ENS, wrapper and payment boundaries, distinguishing tested controls from deployment and external-review gates; documented directory-snapshot lifetime and unsigned operator-lifecycle work.
  - OpenAI Codex specified the versioned multi-endpoint ENS record, stable operator/node identities, permission migration, free-only boundary and operator-first selection for M1-B, and divided implementation responsibilities for parallel work.
  - OpenAI Codex documented the M1-B code/fork/browser checkpoint, authenticated owner continuity, unsigned onboarding fragments, imported lifecycle-evidence limits and general ENS resolution, preserving the independent-enrollment, hosted-gateway and later payment gates.
  - OpenAI Codex documented the full-project QA results, reproduced defects and remaining live-release gates in `specs/QA_REPORT.md`, distinguishing automated checks, injected failure reproductions and live browser observations.
  - OpenAI Codex recorded the team's mainnet-alpha iteration decision and subsequent ENS/IPFS hosting correction, documented IPFS packaging and same-VPS pinning/gateway operation, and separated historical hosted asset checks from anonymous startup and pending on-chain website/operator updates in the context, roadmap and operations notes.
  - OpenAI Codex documented Firefox private-window diagnostics, the authenticated period-1904 cold start and branch reconciliation, keeping historical source hashes and deployment limits explicit.
- **Human role:**
  - Supplied the source material: prize pages, event rules, the EF mentor's feedback and the planning conversations.
  - Made the decisions:
    - the target track;
    - narrowing the scope after the mentor's feedback;
    - the name DeRPC, chosen from AI-generated candidates;
    - ENS as the stretch instead of Arkiv;
    - the demo app and the stack;
    - public, keyless RPCs only.

## Repository organization

- **Files assisted:** the folder structure, plus `README.md`, `REPO_LAYOUT.md`, this file, `specs/prompts/README.md` and `.gitignore`. The folder organization was done with AI.
- **AI role:** Claude Code designed and applied the layout, modeled on SibylFi, the team's earlier ETHGlobal finalist project. It moved the files, fixed the links, and wrote the agent instructions and these docs.
  - OpenAI Codex updated `REPO_LAYOUT.md` for the imported `web/`, `brand/`, `docs/`, release-build helpers and response-body reader while preparing the pending branches for integration.
  - OpenAI Codex mapped the contracts, wrapper, payments, ENS discovery, local EVM and demo payment files in `REPO_LAYOUT.md` during the Nov 6 implementation work.
  - At the team's request, OpenAI Codex refreshed `README.md` on Nov 6 to describe implemented modules, free-first operation, manual/automatic routing, dated validation evidence, setup commands and outstanding public ENS/payment release gates. A follow-up linked the hosted alpha and dashboard and retained the known gateway-startup limitation; the validation note now reflects the local commit series.
  - OpenAI Codex recorded separate Vercel-alpha and ENS/IPFS deployment evidence in the web guide and operations notes. Neither deployment evidence clears the anonymous hosted-startup gate.
- **Human role:**
  - Chose to follow SibylFi's structure.
  - Set the working rules: coherent commit splits, no AI co-author lines, and attribution for code, frontend and contracts only when the team directs.
  - Authorizes local commit work and decides when changes may be pushed.

## Prompts and conversations

- **Files:** [`specs/prompts/`](specs/prompts/).
- **AI role:** the assistants' replies, kept verbatim. Six research prompts were drafted by an assistant at the team's request; their headers say so.
  - OpenAI Codex performed the requested read-only publication review of the Grok planning transcript and recorded sensitive-context categories and line references in `specs/QA_REPORT.md`. It preserved the transcript and header and did not reproduce private URLs or decide publication on the team's behalf.
- **Human role:** the team's prompts and decisions, kept verbatim. Each file's header records its outcome.

## Still pending

The team will say when to fill these in: provider library (`provider/`), frontend (`frontend/`), contracts for the ENS stretch (`contracts/`), and debugging and deployment.
