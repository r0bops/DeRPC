# Research prompt: ENS use cases for a private, verified RPC pool

**Author:** Rob (r0bops). The prompt text was drafted by Claude Code at Rob's request.
**Date:** 2026-11-06
**Tool:** Claude Code (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8).

## Prompt (verbatim)

```text
I'm working on DeRPC, an open-source, client-side RPC pool for Ethereum. I want to
know every way ENS could be used in it that is useful and hard to find elsewhere:
existing examples of ENS combined with RPC or service discovery, the theory behind
naming systems as registries, and anything else that applies. I'll use the result to
pick what to build with ENSv2 and to explain why it matters, so every statement needs
a source I can open.

WHAT DeRPC IS TODAY
- The client runs in the user's browser. Each read goes through Tor (using the
  Ethereum Foundation's Anon-RPC standard) to an RPC operator. The operator doesn't
  see the user's IP, but it does see the query.
- Every answer comes with an eth_getProof Merkle proof, checked against a state root
  from the client's own sync-committee light client. Only balance, nonce, code,
  storage and block number are served, at the finalized block.
- The user picks operators from a list of five curated public endpoints. Each shows a
  placeholder name such as alice.derpc.eth; no real ENS names exist yet.

WHAT WE ALREADY PLAN WITH ENS
- An operator registry under derpc.eth using ENSv2: each operator holds a subname
  whose records carry its endpoint, the operator can edit only its own records, a
  curator can revoke, and listings expire unless renewed.
- The client reads that list through Tor and proves it with eth_getProof against the
  resolver's storage, so the list needs nothing new to trust.
- An idea under discussion: the operator's endpoint is a Tor onion address. An onion
  address is a public key, so the ENS record would bind a name to a key the operator
  must hold to answer at all.

CONSTRAINTS THAT SHAPE THE ANSWER
- No eth_call. Normal ENS resolution goes through the Universal Resolver with
  eth_call, which carries no proof, so DeRPC refuses it. Anything we read from ENS
  has to be read as raw storage slots and proven. Event logs are refused too, so
  subnames can't be listed by scanning logs.
- Ethereum mainnet only. Our light client can't follow Sepolia at the moment.
- No server of ours in the path. Everything runs in the browser and goes through Tor.
- Offchain resolution (CCIP-Read) returns data that a state proof can't cover.

QUESTIONS
1. Prior art. Who has used ENS, or another naming system, to publish RPC endpoints,
   service endpoints, node identities or chain metadata? What did they store, in
   which record types, and what happened to the project?
2. ENS as a registry of operators. Beyond "a subname with an endpoint record", what
   can ENSv2's features (hierarchical registries, subname registries, wildcard
   resolution, Enhanced Access Control, the Permissioned Resolver, aliasing, expiring
   subnames) express that a plain registry contract can't? Which of these make ENS
   central to the product and not decoration?
3. What a record could carry. For each of these, is there an existing record type or
   standard, and what are the pitfalls: endpoint URL or onion address, a public key
   for signed responses, supported chains and methods, a payment address and price, a
   Tor gateway address, software version, a proof that the operator controls both
   the name and the node?
4. Proving ENS records without eth_call. Where does ENSv2 store text records,
   addresses and contenthash, and how are the storage slots derived? Has anyone
   resolved ENS names from storage proofs through a light client? How can a client
   list the subnames of a parent without logs or an indexer?
5. Private and verified name resolution as a feature. Today a wallet that resolves a
   name tells its RPC provider which name it looked up, and trusts the answer. Could
   DeRPC offer ENS resolution that hides who is asking and proves the result? Which
   kinds of names would this cover, and which not (offchain and wildcard resolvers)?
6. Names for more than operators. Assess each: curated operator lists published
   under a name so users can choose a curator; gateways and worker versions published
   under a name; per-chain subregistries; paying an operator by name; agents finding
   their RPC pool by name; hosting the app itself through contenthash.
7. Naming theory. What do the literature on decentralized naming and service
   discovery, and the experience of DNS-based service records, say about using a name
   system as a registry: squatting, revocation, expiry, key rotation, who holds the
   root, and what happens when the parent name's owner misbehaves?
8. Costs and limits. What does it cost to create and update a subname on mainnet
   under ENSv2? What are the trust assumptions of the parent name's owner, and how
   can they be reduced?

Leads worth checking, not a required list: the ENS improvement proposals for text
records, multichain addresses, contenthash and wildcard resolution; CCIP-Read;
proposals for chain-specific and interoperable names; on-chain chain registries;
how Tor, IPFS and other peer-to-peer networks publish node identities; light-client
wallets that resolve names.

HOW TO WORK
- Check the current state of ENSv2 from its own documentation and contracts before
  describing it. Say which version and which deployment you looked at.
- Every finding needs a source and a link, placed right next to the claim and not
  only in a list at the end. This covers definitions, numbers, dates, costs, storage
  layouts and every project you name as an example.
- Use primary sources: ENS documentation and contracts, ENSIPs, EIPs, papers,
  project repositories. For each one give the title, author or organization, date and
  a direct URL (the page, section or file itself, not a homepage or a search page).
  Name the section or line the claim comes from, and quote the passage it rests on.
- Only link pages you opened and read in this session. Don't cite from memory.
- If you can't find a source for something, keep it but label it "no source found".
  Don't attach a loosely related link to make it look sourced.
- Mark every claim as "read in the source", "my inference" or "couldn't verify".
  Earlier reports I received mixed these up, so I'd rather have fewer claims that are
  solid.
- For each use case say plainly whether you found someone already doing it. "I found
  no example" is a useful answer; don't call something new without having looked.

WHAT TO RETURN
1. A short verdict: the three ENS uses that fit DeRPC best, and why.
2. For each use case: what it is, who has done something similar (with links), which
   ENS features it uses, how DeRPC would read and prove it, what can't be proven, and
   a rough effort (under a day, a few days, longer).
3. A table: use case, ENSv2 feature, provable with eth_getProof (yes, partly, no),
   prior art link, effort.
4. For question 4, the storage layout details with links to the contract source.
5. What doesn't work or isn't worth doing, and why, each with its source link.
6. Questions we should ask the ENS team directly.
7. A full source list: title, author or organization, date, URL, and which findings
   each source supports.
8. Sources you wanted to read but couldn't open, with their URLs.
```
