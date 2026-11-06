# Research prompt: agreement and fairness mechanisms for a decentralized RPC pool

**Author:** Rob (r0bops). The prompt text was drafted by Claude Code at Rob's request.
**Date:** 2026-11-06
**Tool:** Claude Code (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8).

## Prompt (verbatim)

```text
I'm working on DeRPC, an open-source, client-side RPC pool for Ethereum. I need a
theory review of which agreement and incentive mechanisms a pool like this needs in
order to be decentralized and fair, and which it can avoid. I'll use it to decide
what to build next and to check the claims in our roadmap, so I need to be able to
rely on every statement in it.

WHAT EXISTS TODAY
- The client runs in the user's browser. Each read goes through Tor (using the
  Ethereum Foundation's Anon-RPC standard) to an RPC operator. The operator doesn't
  see the user's IP, but it does see the query.
- Every answer comes with an eth_getProof Merkle proof. The client checks it against
  a state root from its own sync-committee light client, started from a pinned
  finalized checkpoint. Methods that can't be proven (eth_call, logs) are refused.
- The user picks operators from a list. An operator whose proof fails is dropped
  locally; one that times out rests for a minute. There is no central router.
- Not built: open operator registration, discovery (the list is five curated public
  endpoints), signed responses, payments, staking, reputation.

THE POSITION I WANT TESTED
Because correctness comes from proofs, the pool needs no consensus about answers.
My working theory is that agreement is needed, if at all, only for: who the
operators are, what the starting checkpoint is, how operators get paid, and how
misbehavior is punished. I also think fairness needs three rules: verify instead of
voting; pay only from the user for proven answers, never from a shared reward pool;
punish only signed answers that fail their proof. Tell me where this is wrong or
incomplete.

QUESTIONS
1. Where agreement is needed. For operator membership, discovery, the checkpoint,
   service measurement, payment settlement and disputes: what is the weakest form of
   agreement that is enough (none, local only, gossip, a quorum, a blockchain)? What
   is known to be impossible without a trusted party?
2. Sybil resistance without a gatekeeper. Since answers are verified, an attacker
   with many fake operators gains query visibility and fees, not the ability to lie.
   What do cost-per-identity schemes and selection caps guarantee about the share of
   traffic an attacker can capture?
3. Measuring service without a trusted measurer. How do existing designs decide how
   much work a provider did? What does the fair-exchange literature say about paying
   for an answer?
4. Accountability. Which faults can be attributed with evidence anyone can check,
   and which can't (omission, delay, selective censorship)? What do signed responses
   plus fraud proofs achieve, and what do they miss?
5. Client-side selection. Which strategies balance speed, a fair chance for new
   operators, and limiting what any one operator learns about a user?
6. Payment versus anonymity. Which payment schemes keep a user's queries unlinkable
   to each other and to the payer?
7. Light-client trust. What are the security assumptions of Ethereum's
   sync-committee light client and of weak subjectivity, and how can a checkpoint be
   chosen without a single trusted source?
8. Query privacy. Briefly: how far is private information retrieval from being
   practical for Ethereum state reads?

Leads worth checking, not a required list: how Tor agrees on its relay list and
measures relay capacity, mixnet reward schemes, storage and retrieval markets,
relay-proof schemes in existing RPC networks, anonymous tokens and usage credits,
probabilistic micropayments, accountable-safety results from proof-of-stake research.

HOW TO WORK
- Mechanisms, not products. Mention a project only as an example of a mechanism, and
  describe what its paper or spec says, not its marketing.
- Every finding needs a source and a link, placed right next to the claim and not
  only in a list at the end. This covers definitions, numbers, dates, attacks,
  impossibility results and every project you name as an example.
- Use primary sources: papers, specs, EIPs, protocol documentation. For each one give
  the title, author or organization, date and a direct URL (the paper, spec section
  or EIP itself, not a homepage or a search page). Name the section or page the claim
  comes from, and quote the passage it rests on.
- Only link pages you opened and read in this session. Don't cite from memory.
- If you can't find a source for something, keep it but label it "no source found".
  Don't attach a loosely related link to make it look sourced.
- Mark every claim as "read in the source", "my inference" or "couldn't verify".
  Earlier reports I received mixed these up and misattributed some mechanisms. I'd
  rather have fewer claims that are solid.
- State the assumption behind each guarantee: cryptographic, honest majority,
  economic, or a trusted party.
- Where the literature disagrees or is thin, say so.

WHAT TO RETURN
1. A one-paragraph verdict on the working theory.
2. For each question: the finding, its assumptions and known attacks, each with its
   source link inline.
3. A table: role, weakest sufficient mechanism, assumption, cost, source link.
4. What is impossible or unsolved, and which claims we should not make, each with
   its source link.
5. A full source list: title, author or organization, date, URL, and which findings
   each source supports.
6. Sources you wanted to read but couldn't open, with their URLs.
```
