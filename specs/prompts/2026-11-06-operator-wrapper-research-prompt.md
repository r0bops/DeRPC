# Research prompt: an operator wrapper for a private, verified RPC pool

**Author:** Rob (r0bops). The prompt text was drafted by Claude Code at Rob's request.
**Date:** 2026-11-06
**Tool:** Claude Code (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8).

## Prompt (verbatim)

```text
I'm working on DeRPC, an open-source, client-side RPC pool for Ethereum. I want to
design a small "operator wrapper": software a node operator runs next to their own
Ethereum node so it can join the pool. I need research on how comparable software is
built and on the specific techniques below, so I can decide what the wrapper must do
and what it must not promise. I'll write it from scratch, so I'm after designs and
lessons, not code to reuse. Every statement needs a source I can open.

WHAT DeRPC IS TODAY
- The client runs in the user's browser. Each read goes through Tor to an RPC
  operator, using the Ethereum Foundation's Anon-RPC standard with the tor-js worker
  (Arti compiled to WebAssembly). The operator doesn't see the user's IP, but it does
  see the query.
- Every answer comes with an eth_getProof Merkle proof, checked against a state root
  from the client's own sync-committee light client. The client asks an operator for
  eth_getProof at the finalized block, and asks beacon nodes for light-client data
  (bootstrap, updates, finality and optimistic updates).
- The user picks operators from a list on a dashboard. Today that list is five
  curated public endpoints that never registered and run nothing of ours.

WHAT THE WRAPPER SHOULD DO
1. Prove the node belongs to the operator. The wrapper holds a key and produces
   something the operator pastes into the dashboard to add the node.
2. Turn the node into a valid pool endpoint that can be published under the
   operator's ENS name.
3. Receive calls only anonymously.
The reference point in my head is Dshackle, an open-source proxy that some RPC
providers run in front of their nodes. Check what it actually does before comparing.

THE DESIGN I'M LEANING TOWARD
The wrapper publishes the node as a Tor v3 onion service and passes only the methods
the pool needs to the node. The onion address is a public key, so it serves as the
operator's identity: it is what gets pasted into the dashboard and stored in the ENS
record. Calls can only arrive through Tor, so the operator never sees an IP, and no
exit node is involved. tor-js documents client connections to onion services since
version 0.4.2, without client authorization; we haven't tested it. Tell me where
this design is wrong, slow or fragile.

FIXED CONSTRAINTS
- The client verifies every answer itself. The wrapper is never trusted, and nothing
  in it may weaken that.
- The client is a browser running Arti in WebAssembly. Anything the wrapper requires
  from callers has to be something that client can do.
- No central server of ours, and no fallback to a direct connection.

QUESTIONS
1. Comparable software. What do operator-side proxies and node software in RPC and
   other service networks do: routing, health checks, method allowlists, caching,
   authentication, signing, metering, registration? Cover Dshackle and at least four
   others from different kinds of network (RPC marketplaces, indexing networks,
   anonymity networks, storage networks). For each, how is the operator's identity
   tied to the node, and under what license is it published?
2. Proving a node belongs to an operator. Compare: an onion service key, a pinned TLS
   key published in a name record, a signed challenge and response, signed responses,
   and the node's own network identity key. What can a remote client check with
   each? Is there any way to tell an operator running their own node from one
   reselling another provider's endpoint?
3. Hosting an onion service in front of JSON-RPC. How is it set up with the Tor
   daemon and with Arti, and how mature is each? What latency and throughput should
   we expect compared with a connection through an exit? What do single-hop onion
   services, onion load balancing and the onion-service proof-of-work defense do,
   and which of them work with an Arti client in the browser? How are the service
   keys stored, backed up and rotated?
4. The registration artifact. What should the wrapper output for the dashboard and
   the ENS record? Compare formats for a signed statement that binds name, key,
   chain and expiry in both directions, with replay protection. What existing
   conventions for "proof of control" records could we follow?
5. Limiting abuse when every caller is anonymous. With no IPs, how do onion services
   and anonymous APIs rate-limit and resist denial of service: per-circuit limits,
   proof of work, anonymous tokens, global caps? Which cost the honest user least?
6. Serving proofs well. Which Ethereum execution clients serve eth_getProof for the
   finalized block, with which settings, and how far back does each go? How
   expensive is a proof to produce, and can proofs at a finalized block be cached
   safely? Which JSON-RPC methods are dangerous to expose and must be blocked?
7. Serving light-client data. Should the wrapper also expose the beacon light-client
   endpoints from the operator's consensus node, so an operator can serve everything
   a DeRPC client needs? Which consensus clients serve them, and with which settings?
8. Signed responses. How have other systems bound a response to the request, the
   chain, the block and the operator's key, so that a wrong answer is evidence
   anyone can check? What does it cost per request, and what can't it prove?
9. Running a Tor entry gateway in the same package. tor-js reaches Tor through a
   gateway that sees the client's IP but not its destinations. If an operator runs
   both a gateway and an RPC endpoint, what can they learn by matching timing? How
   does Tor's path selection deal with one party running several relays?
10. What can't be verified. Which wrapper promises can a client never check from
    outside (for example "no query logs")? How do other networks word such promises?
11. Packaging and safety for operators. How do comparable projects ship (single
    binary, container set), handle upgrades and keys, and keep an operator's node
    from being exposed more than intended?

Leads worth checking, not a required list: Dshackle and other RPC proxies; provider
software from decentralized RPC and indexing networks; the Tor Project's onion
service documentation and proposals; Arti's onion service status; HTTP message
signatures; anonymous token schemes; execution-client documentation on state history
and proofs; the beacon API light-client routes.

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
- For performance numbers, say who measured them, when and under what conditions.
- Describe what software does, not what its marketing says. Quote configuration
  options and commands only from the documentation of the version you checked.

WHAT TO RETURN
1. A short verdict on the onion-service design: sound or not, and the three biggest
   risks.
2. For each question: the finding, its limits, and source links inline.
3. A comparison table of the operator-side software you studied: what it does, how
   identity is bound, how it registers, license, link.
4. A recommended minimum wrapper: its components, what each one does, which existing
   tool it relies on, and what can be built in under a day versus later.
5. The exact client and node settings an operator needs, with links to the
   documentation they come from.
6. What the wrapper must never claim, and what stays unverifiable, each with its
   source link.
7. A full source list: title, author or organization, date, URL, and which findings
   each source supports.
8. Sources you wanted to read but couldn't open, with their URLs.
```
