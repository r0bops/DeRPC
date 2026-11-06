# /specs/prompts/

AI prompts and conversations that shaped DeRPC. ETHGlobal requires teams to disclose how AI was used. Teams that work from specs must also keep their prompts and planning artifacts in the repo, so judges can see how the AI was directed (see `specs/SUBMISSION.md`).

## What goes here

- Planning and architecture conversations that shaped a major decision
- Coding-agent prompts that led to non-trivial changes
- Any prompt longer than one sentence that produced substantial output

## What does not go here

- Trivial uses, such as renaming a variable
- Read-only questions ("explain this function")
- Output the team rejected

## Naming

`<YYYY-MM-DD>-<short-description>.md`, for example `2026-11-05-claude-planning-conversation.md`.

## Required header

```markdown
# <title>

**Author:** <teammate>
**Date:** YYYY-MM-DD
**Tool:** <assistant or agent>
**Files affected:** <list>

## Outcome
<2–3 sentences: was the output used, changed or rejected?>

## Prompt (verbatim conversation)
<the prompt or conversation, verbatim>
```

Keep the prompt or conversation verbatim. Only the header and the outcome are summaries.

## Index

| File | Tool | What it decided |
|---|---|---|
| [2026-11-05-claude-planning-conversation.md](2026-11-05-claude-planning-conversation.md) | Claude (claude.ai) | Host-side verifying wrapper, verified bootstrap, isolation keys, `eth_getProof` hour-6 test, CROPS entry |
| [2026-11-05-grok-planning-chat.md](2026-11-05-grok-planning-chat.md) | MumballyETH (Grok, Claude, ChatGPT, Gemini) | How the idea evolved, the name, review points, Q&A prep. **Review before publishing.** |
| [2026-11-06-consensus-theory-research-prompt.md](2026-11-06-consensus-theory-research-prompt.md) | Claude Code (drafting) | Nothing yet: a research prompt on agreement and fairness mechanisms for the pool, not run |
| [2026-11-06-ens-use-cases-research-prompt.md](2026-11-06-ens-use-cases-research-prompt.md) | Claude Code (drafting) | Nothing yet: a research prompt on ENS use cases for the pool, not run |
| [2026-11-06-low-resource-node-research-prompt.md](2026-11-06-low-resource-node-research-prompt.md) | Claude Code (drafting) | Nothing yet: a research prompt on the smallest mainnet node that can back an operator (proofs, light-client routes, network identity key), not run |
| [2026-11-06-operator-wrapper-research-prompt.md](2026-11-06-operator-wrapper-research-prompt.md) | Claude Code (drafting) | Nothing yet: a research prompt on an operator-side wrapper (identity, onion endpoint, proxy), not run |
| [2026-11-06-payments-research-prompt.md](2026-11-06-payments-research-prompt.md) | Claude Code (drafting) | Nothing yet: a research prompt on paying operators per query (lottery tickets and alternatives, for people, apps and agents), not run |
| [2026-11-06-simple-payments-research-prompt.md](2026-11-06-simple-payments-research-prompt.md) | Claude Code (drafting) | Nothing yet: an open research prompt on the easiest way to pay operators per query when the payer needn't be private (survey what exists, then propose new designs), not run |
| [2026-11-06-ethglobal-pitch-rules-research-prompt.md](2026-11-06-ethglobal-pitch-rules-research-prompt.md) | Grok (drafting) | Nothing yet: a research prompt on ETHGlobal pitches, demo videos, decks, winners, finalists, judges, and era trends, written so the findings can be adopted as rules, not run |
