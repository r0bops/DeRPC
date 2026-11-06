# Research prompt: the easiest way to pay operators per query

**Author:** Rob (r0bops). The prompt text was drafted by Claude Code at Rob's request.
**Date:** 2026-11-06
**Tool:** Claude Code (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8).

The first draft listed candidate payment schemes and leads. Rob asked for an open brief instead, so the researcher finds the options and proposes new ones; the lists were removed before the prompt was run.

## Prompt (verbatim)

```text
I'm working on DeRPC, an open-source, client-side RPC pool for Ethereum. I want
operators to be paid for the queries they serve, and I'm looking for the EASIEST
payment design to build and to use. I am deliberately not giving you a list of
options. Research how paying per request is done today, anywhere, and then think
of new designs that fit this system better than anything you found. Every factual
statement needs a source I can open; your own ideas must be marked as yours.

WHAT DeRPC IS TODAY
- The client runs in the user's browser. Each read goes through Tor to an RPC
  operator, using the Ethereum Foundation's Anon-RPC standard. The operator doesn't
  see the user's IP, but it does see the query.
- Every answer comes with an eth_getProof Merkle proof, checked on the device
  against a state root from the client's own light client on Ethereum mainnet. The
  client knows whether an answer was correct before it decides anything else.
- The client can prove any account balance or storage slot on mainnet for itself.
- The client holds no keys today and makes no payments. Operators are five public,
  free endpoints that never registered.
- Planned: operators register under an ENS name (ENSv2 on mainnet) with records for
  their endpoint and signing key, and run a small wrapper next to their node.

WHO PAYS
Three kinds of payer: a person using a browser app, an app that embeds DeRPC and
pays for its users, and an autonomous agent running on a server.

WHAT "EASIEST" MEANS HERE, IN THIS ORDER
1. Least to build: few moving parts, and existing audited contracts and maintained
   libraries wherever possible.
2. Least for the payer to do: few steps before the first paid read, and no
   per-query confirmation.
3. Least for the operator to run.
4. Low cost: a read is worth a fraction of a cent, so there can't be an on-chain
   transaction per query.

WHAT I'M GIVING UP ON PURPOSE
The payer does not need to be private. An operator may link all queries paid from
one account, and payments may be public on-chain. Reads still go through Tor, so
the operator doesn't get the payer's IP. Tell me plainly what else is lost by this
choice.

FIXED CONSTRAINTS
- The client verifies every answer itself. Payment never replaces verification.
- The project runs no server, holds no user funds, and issues no token.
- The payer's side must work in a browser, and for an agent with a key on a server.
- If payment fails, the read fails. There is no fallback to a direct connection.
- An operator is untrusted: it may take payment and not serve. A payer should be
  able to lose only a small, known amount.

PART 1: RESEARCH WHAT EXISTS
Find out how per-request and metered payments are actually done, and don't limit
the search to blockchains or to RPC. Look at:
- networks that pay node operators or service providers for work;
- pay-per-call APIs and machine-to-machine or agent payment protocols;
- metered services outside crypto (telecom, cloud, utilities, toll systems, transit
  fares, prepaid cards) and what makes them cheap to settle;
- academic work on micropayments, including the schemes that failed and why.
For each distinct mechanism you find, record: how it works in one paragraph, who
uses it in production, what each side must hold and run, how often anything touches
a chain or a settlement system, what it costs, and what can go wrong. Group what you
find into families yourself; don't assume a taxonomy in advance.

PART 2: MAP THE DESIGN SPACE
From Part 1, work out the independent choices any per-query payment design has to
make (for example when money moves relative to the answer, who holds it in between,
and what is trusted). Lay them out as a grid and show which combinations are used
today and which are empty. Say why each empty cell is empty: impossible,
impractical, or simply untried.

PART 3: PROPOSE NEW OPTIONS
Now design. Propose at least five payment designs for DeRPC that are NOT a straight
copy of an existing system. Start from what is unusual about DeRPC and ask what
each property makes possible:
- the client can check every answer before deciding to pay;
- the client can prove mainnet state by itself, without trusting anyone;
- operators will have on-chain names with records they control;
- the payer needn't be private;
- every query is tiny, uniform and cheap to repeat elsewhere.
Also try borrowing a mechanism from one of the non-crypto fields in Part 1, and try
at least one design that removes a component everyone else assumes is needed. For
each proposal give: the idea in three sentences, the message flow for one paid
read, what must be built and what already exists, the steps for each of the three
payers, the most each side can lose, and the first thing that would break it.
Unusual ideas are welcome; unsupported claims are not. Mark every step of your own
reasoning as "my proposal" or "my inference".

PART 4: ATTACK YOUR OWN PROPOSALS
For each proposal, write the strongest objection a skeptical protocol engineer
would raise, then answer it or concede. Drop proposals that don't survive, and say
that you dropped them and why.

PART 5: CHOOSE
Rank the surviving proposals together with the best existing mechanisms from
Part 1, using the four meanings of "easiest" above. Pick one.

ALSO ANSWER
- Price: what do RPC providers charge per request or per compute unit today, and
  how do they price eth_getProof? How should an operator publish a price?
- Where to settle: what does a deposit or a settlement cost today on Ethereum
  mainnet and on the main rollups, and does the payer's client need to read the
  settlement chain during normal use?
- Abuse: how do paid services stop requests with invalid or unfunded payments from
  costing the provider real work?
- Law: which rules are most likely to apply to the design you picked? Point to
  official guidance. I know this isn't legal advice.
- Later privacy: can the design you picked add payer privacy later without being
  replaced?

HOW TO WORK
- Search before you conclude. Don't start from the mechanisms you already know;
  look for ones you don't.
- Check the current state of each project from its own repository and documentation
  before describing it. Give the version or commit you looked at.
- Every factual finding needs a source and a link, placed right next to the claim
  and not only in a list at the end. This covers definitions, numbers, dates,
  measurements and every project you name as an example.
- Use primary sources: repositories, official documentation, specifications,
  proposals, papers. For each one give the title, author or organization, date and a
  direct URL (the page, section or file itself, not a homepage or a search page).
  Quote the passage the claim rests on.
- Only link pages you opened and read in this session. Don't cite from memory.
- If you can't find a source for something, keep it but label it "no source found".
  Don't attach a loosely related link to make it look sourced.
- Mark every claim as "read in the source", "my inference", "my proposal" or
  "couldn't verify". Earlier reports I received mixed these up.
- For costs, say who measured them, when and under what conditions.
- Before calling a proposal new, search for prior work on it and report what you
  found. "I found nothing like it" is an acceptable result; "this is novel" without
  a search is not.

WHAT TO RETURN
1. One recommendation in five sentences, with its biggest weakness.
2. The catalogue from Part 1: each mechanism, who uses it, and its source links.
3. The design-space grid from Part 2, with the empty cells explained.
4. Your proposals from Part 3, each with its message flow, its strongest objection
   and your answer, and the prior-work search you ran for it.
5. The proposals you dropped, and why.
6. A ranked table of the survivors and the best existing mechanisms against: steps
   for the payer, on-chain transactions per thousand queries, cost per query, what
   the operator runs, what exists already versus what I must write, maximum loss
   for each side, and fit for people, apps and agents.
7. A build plan for the recommended design: what fits in one day, one week and
   later.
8. What is lost by not protecting the payer, and the cheapest later step to win it
   back.
9. A full source list: title, author or organization, date, URL, and which findings
   each source supports.
10. Sources you wanted to read but couldn't open, with their URLs.
```
