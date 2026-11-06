# Research prompt: paying operators per query in a private, verified RPC pool

**Author:** Rob (r0bops). The prompt text was drafted by Claude Code at Rob's request.
**Date:** 2026-11-06
**Tool:** Claude Code (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8).

## Prompt (verbatim)

```text
I'm working on DeRPC, an open-source, client-side RPC pool for Ethereum. I want
operators to be paid per query, and I need research on which payment design fits
best. The payers are of three kinds: people using a browser app, apps that embed
DeRPC for their users, and autonomous agents running on servers. I'm leaning toward
probabilistic micropayments ("lottery tickets"), but I want that choice tested
against the alternatives. Every statement needs a source I can open.

WHAT DeRPC IS TODAY
- The client runs in the user's browser. Each read goes through Tor to an RPC
  operator, using the Ethereum Foundation's Anon-RPC standard with the tor-js worker
  (Arti compiled to WebAssembly). The operator doesn't see the user's IP, but it does
  see the query.
- Every answer comes with an eth_getProof Merkle proof, checked against a state root
  from the client's own sync-committee light client on Ethereum mainnet. A wrong
  answer is rejected on the device, so the client knows whether an answer was
  correct before it decides anything else.
- Reads for different accounts go out under different Tor circuits, so an operator
  shouldn't be able to link one user's accounts to each other.
- The client holds no keys today and makes no payments. Operators are five public,
  free endpoints that never registered.
- Planned: operators register under an ENS name (ENSv2 on mainnet) with records for
  their endpoint and signing key, and run a small wrapper next to their node,
  possibly reachable as a Tor onion service.

WHAT I WANT FROM PAYMENTS
1. An operator earns a small amount for each answer it serves, without an on-chain
   transaction per query.
2. Paying must not undo the privacy: it must not reveal the payer's IP or identity
   to the operator, and it must not let an operator link queries that the Tor
   circuits keep apart.
3. The same pool must work for a person in a browser, an app paying for its users,
   and an agent with its own budget.

THE DESIGN I'M LEANING TOWARD
Each request carries a signed lottery ticket. A small fraction of tickets win, and
only winning tickets are redeemed on-chain against the payer's deposit. The client
sends the ticket after the answer's proof verifies, so either side can lose at most
one query's worth. Tell me where this is wrong, unsafe or impractical, and what I'd
have to add to make it private.

FIXED CONSTRAINTS
- The client verifies every answer itself. Payment never replaces verification, and
  an operator is never trusted because it was paid.
- The client is a browser running WebAssembly. Anything a payer has to compute or
  store must work there, and on a phone.
- No central server of ours: no account system, no payment processor we run, no
  custody of user funds by the project.
- No fallback to a direct connection. If payment fails, the read fails.
- A single read is worth a fraction of a cent, so fees and per-request overhead
  matter more than anything else.
- The project will not issue a token.

QUESTIONS
1. The options. Compare the ways to pay per request for an API: probabilistic
   micropayments, payment channels, prepaid credits, signed receipts aggregated
   later, HTTP 402 schemes such as x402, anonymous tokens bought in advance (blind
   signatures), zero-knowledge usage credits, and plain subscriptions or API keys.
   For each: how many on-chain transactions per thousand queries, what it costs,
   what each party must hold and trust, and how mature it is.
2. Lottery tickets in detail. How do deployed systems build them: ticket format,
   who supplies the randomness and how neither side can bias it, win probability
   and face value, expiry, deposits, and the penalty that stops a payer from
   double-spending one deposit across many operators? What income variance does an
   operator face, and how do real networks size tickets to keep it tolerable? What
   does redeeming a winning ticket cost, and how is front-running of redemptions
   prevented?
3. Privacy of the payer. With each option, what can an operator learn from the
   payment alone, and what becomes public on-chain? In particular: does a ticket
   signed by one key link all queries paid from that deposit, and does redemption
   show which deposit paid which operator? Compare the fixes: one deposit per
   account, deposits funded through a privacy tool, blind-signature tokens, and
   zero-knowledge credits with a spending limit. Which of them are practical in a
   browser today, and what do they cost in proving time, bytes and round trips?
4. Fair exchange. The client can check an answer before paying. What is the best
   order of steps so that neither side can cheat for more than one query? How do
   existing networks handle a payer who stops paying, an operator who takes a
   ticket and serves nothing, and tickets that are valid in form but worthless?
5. Three kinds of payer.
   - A person in a browser: how do they fund a deposit, with or without a wallet,
     and what does first use look like? Can they start with free queries?
   - An app paying for its users: can it hold one deposit and delegate limited
     spending keys to users' browsers, and what happens when such a key leaks?
     Does the app then become the party that can link its users' queries?
   - An agent on a server: how do agent payment protocols work today, what do they
     assume about keys and budgets, and how do spending limits get enforced?
   Can one mechanism serve all three, or should the pool accept several behind one
   interface?
6. x402 and related agent payment schemes. What do they specify today: payment
   schemes, who settles, how long settlement takes, and what a single paid request
   costs end to end? Are they usable for sub-cent amounts, and do they involve a
   facilitator that sees the payer? Give the version of each specification you read.
7. Where to settle. Compare Ethereum mainnet, the main rollups and any other
   settlement option for deposits and redemptions: cost per redemption, finality,
   and what the operator has to check before trusting a ticket. DeRPC's light
   client follows mainnet only; does the payer need to read the settlement chain at
   all, and if so, how could that read be verified? Stablecoin or ETH?
8. Price. What do RPC providers charge per request or per compute unit today, and
   how do they price eth_getProof specifically? What does it cost an operator to
   serve one? How do service networks let operators publish prices and clients
   compare them, and how are price changes handled mid-session?
9. Abuse. When every caller is anonymous, how do paid networks stop floods of
   requests with invalid or unfunded tickets? What does verifying a ticket cost the
   operator per request, and does payment remove the need for other rate limits?
10. The operator's side. What must an operator run to check tickets, track
    deposits and redeem winners, and how are the redemption keys kept? What have
    operators of existing networks reported about this work?
11. Free and paid together. Free public endpoints exist. What have comparable
    networks offered paying users that free endpoints don't, and did it hold up?
    How should a pool mix free and paid operators without leaking which users pay?
12. Law. Which rules are most likely to apply to a non-custodial deposit contract
    and to operators who receive anonymous payments: money transmission, payment
    services, sanctions screening? Point to official guidance and to how comparable
    projects describe their position. I know this isn't legal advice.
13. What can't be promised. Which privacy or fairness claims can't be made for each
    option, even when it works as designed?

Leads worth checking, not a required list: Rivest's paper on electronic lottery
tickets as micropayments; Orchid's nanopayments; Livepeer's probabilistic
micropayments; The Graph's payment receipts; Pocket and Lava; payment channels and
402-based schemes on Lightning; x402; Privacy Pass; rate-limiting nullifiers; the
"ZK API usage credits" proposal; Chaumian e-cash; Privacy Pools; EIP-3009 and
ERC-4337 where they affect how deposits are funded.

HOW TO WORK
- Check the current state of each project from its own repository and documentation
  before describing it. Give the version or commit you looked at.
- Every finding needs a source and a link, placed right next to the claim and not
  only in a list at the end. This covers definitions, numbers, dates, settings,
  measurements and every project you name as an example.
- Use primary sources: repositories, official documentation, specifications,
  proposals, papers. For each one give the title, author or organization, date and a
  direct URL (the page, section or file itself, not a homepage or a search page).
  Name the section or line the claim comes from, and quote the passage it rests on.
- Only link pages you opened and read in this session. Don't cite from memory.
- If you can't find a source for something, keep it but label it "no source found".
  Don't attach a loosely related link to make it look sourced.
- Mark every claim as "read in the source", "my inference" or "couldn't verify".
  Earlier reports I received mixed these up, so I'd rather have fewer claims that are
  solid.
- For costs and performance numbers, say who measured them, when and under what
  conditions. Give fees in the unit the source uses and the date of the price.
- Describe what software does, not what its marketing says.

WHAT TO RETURN
1. A short verdict on lottery tickets for DeRPC: sound or not, and the three biggest
   risks.
2. For each question: the finding, its limits, and source links inline.
3. A comparison table of the payment options against: on-chain transactions per
   thousand queries, cost per query, what the operator learns, what is public
   on-chain, browser feasibility, fit for people, apps and agents, maturity, and
   license of the reference implementation.
4. A recommended design for each kind of payer, and whether one mechanism can serve
   all three.
5. The smallest version worth building first: its parts, what each relies on, and
   what it must leave out.
6. The privacy cost of that smallest version, stated plainly, and the step that
   would remove it.
7. What DeRPC must never claim about payments, each with its source link.
8. A full source list: title, author or organization, date, URL, and which findings
   each source supports.
9. Sources you wanted to read but couldn't open, with their URLs.
```
