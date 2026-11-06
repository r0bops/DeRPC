# Research prompt: the smallest Ethereum node that can back a DeRPC operator

**Author:** Rob (r0bops). The prompt text was drafted by Claude Code at Rob's request.
**Date:** 2026-11-06
**Tool:** Claude Code (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8).

## Prompt (verbatim)

```text
I'm working on DeRPC, an open-source, client-side RPC pool for Ethereum. I need to
find the smallest and cheapest Ethereum mainnet node setup that can sit behind a
DeRPC operator, so we can run one on a rented server for a demo and tell future
operators what they need. I want real, current numbers and exact settings, not
general advice. Every statement needs a source I can open.

WHAT DeRPC IS
- The client runs in the user's browser. Each read goes through Tor to an RPC
  operator. The client checks every answer itself: it follows the chain with a
  sync-committee light client and checks eth_getProof Merkle proofs against the
  state root of the finalized block.
- An operator runs a small "wrapper" next to their node: a filtering proxy plus a
  Tor onion service, in Docker Compose on Linux, on the same machine as the node.
  The node's APIs stay bound to 127.0.0.1.
- We also want the operator to prove they hold the key of a real node, by signing a
  short statement with the node's peer-to-peer network identity key.

WHAT THE NODE MUST DO
Execution side (JSON-RPC, Ethereum mainnet):
1. eth_getProof for one account and up to 32 storage slots, at the finalized block.
   The finalized block is usually 64 to 96 blocks behind the head, and can fall
   much further behind if the chain stops finalizing.
2. eth_getCode at the finalized block.
3. eth_chainId, and eth_getBlockByNumber("finalized").
Nothing else is needed: no logs, no traces, no eth_call, no old history.

Consensus side (beacon REST API, mainnet):
4. GET /eth/v1/beacon/light_client/bootstrap/{block_root}, for a finalized
   checkpoint that may be up to 7 days old.
5. GET /eth/v1/beacon/light_client/updates?start_period=&count= (count 1 to 4).
6. GET /eth/v1/beacon/light_client/finality_update and optimistic_update.

Identity:
7. A persistent network identity key (the one behind the node's ENR or peer ID)
   that the operator can use to sign a statement, and that a third party can see
   live on the mainnet peer-to-peer network.

WHAT WE FOUND SO FAR (not confirmed, please check each one)
- Reth serves proofs for older blocks only when --rpc.eth-proof-window is raised
  from its default of zero; we use 256. Lighthouse serves the light-client routes
  unless its light-client server is disabled.
- Erigon 3's documentation lists about 350 GB of disk for a mainnet node in
  --prune.mode=minimal, with 16 GB of RAM as the minimum. We don't know whether
  that mode can serve eth_getProof at the finalized block.
- Nimbus documents a --no-el option (run with no execution client, stay
  "optimistically synced") and recommends 4 GB of RAM and 200 GB of disk for the
  consensus node alone. We don't know whether a node run that way serves the
  light-client routes.
- A light client can't produce eth_getProof, because building a proof needs the
  full state. Tell me if that is wrong for any current client.

QUESTIONS
1. The smallest node that does the whole job. For each execution client (Geth,
   Reth, Erigon, Nethermind, Besu, and any other maintained one), what is the
   smallest configuration that serves eth_getProof at the finalized block? Give
   disk used today on mainnet, RAM, CPU, the exact flags, and how far back from
   the head proofs are available by default and at most.
2. Pruned and minimal modes. Which pruning modes keep enough state to prove the
   finalized block, and which silently can't? What does each client return when
   the requested block is outside its proof range? What happens to proofs during
   a long period without finality?
3. The consensus node. Which consensus client is lightest (Nimbus, Lighthouse,
   Lodestar, Teku, Prysm, Grandine)? For each: the flags that turn the
   light-client routes on, how long bootstrap data for old checkpoints is kept,
   disk and RAM today, and how long checkpoint sync takes.
4. A consensus node without an execution client. Which clients allow it, what
   works and what doesn't in that state, and does such a node still serve the
   light-client routes and take part in the peer-to-peer network normally?
5. Single-binary setups. Erigon ships an embedded consensus client (Caplin), and
   Nimbus has been working on a unified client. Does the embedded consensus side
   expose the light-client routes and a standard node identity? Is either
   production-ready on mainnet?
6. The network identity key. For each client on both layers: where the key is
   stored, its format, whether it survives restarts and upgrades, which API shows
   the public identity (admin_nodeInfo, /eth/v1/node/identity), and whether any
   existing tool signs an arbitrary message with it. What does the ENR contain,
   and how can a third party confirm that a node holding that key is live on
   mainnet (discovery ping, RLPx or libp2p handshake, public crawlers)? Is it
   risky to sign non-protocol messages with this key, and how should the message
   be domain-separated?
7. Getting synced fast. For the smallest setups: how long does a sync from
   scratch take on modest hardware, and what are the quicker routes (snap sync,
   checkpoint sync, published snapshots)? For downloaded snapshots, who publishes
   them and what do you have to trust?
8. Disk and hosting. What disk performance does each small setup need (IOPS,
   local NVMe versus network block storage)? Which rented servers meet it at the
   lowest monthly price, including bandwidth limits? How much bandwidth does such
   a node use per month?
9. Anything smaller. Can any stateless, partial-state, Portal-network or
   light-client software produce account and storage proofs for the finalized
   block today? "No" is a useful answer; say what each one is missing.
10. The hybrid. If we run only our own consensus node and forward execution
    requests to someone else's RPC, what does that honestly demonstrate, and what
    does it not?
11. What changes next. How will the next mainnet forks (Glamsterdam and after),
    history expiry and state growth change these requirements over the next year?

Leads worth checking, not a required list: each client's hardware and pruning
documentation; history expiry (EIP-4444) and what clients dropped; the beacon API
light-client routes and the consensus-specs light-client sync protocol; EIP-778
(ENR) and the discovery v5 and RLPx specs; client release notes from 2026; public
node-size dashboards; snapshot providers; stateless-client work.

HOW TO WORK
- Check the current release of each client from its own repository and
  documentation before describing it. Give the version and the date you looked at.
- Every finding needs a source and a link, placed right next to the claim and not
  only in a list at the end. This covers disk sizes, memory figures, flags,
  defaults, sync times, prices and every project you name.
- Use primary sources: client documentation, repositories, release notes,
  specifications, the hosting provider's own price page. For each one give the
  title, author or organization, date and a direct URL (the page, section or file
  itself, not a homepage or a search page). Name the section or line the claim
  comes from, and quote the passage it rests on.
- Only link pages you opened and read in this session. Don't cite from memory.
- If you can't find a source for something, keep it but label it "no source found".
  Don't attach a loosely related link to make it look sourced.
- Mark every claim as "read in the source", "my inference" or "couldn't verify".
  Earlier reports I received mixed these up, so I'd rather have fewer claims that
  are solid.
- For disk sizes and sync times, say who measured them, when, on what hardware and
  with which version. Sizes grow, so an undated number is not useful.
- Quote flags and commands only from the documentation of the version you checked.
- Don't recommend a setup you couldn't confirm serves requirement 1. Say so
  instead.

WHAT TO RETURN
1. A short verdict with three picks: the cheapest setup that only gives a real
   network identity key (for a demo), the smallest setup that does the whole job,
   and a comfortable setup for a long-running operator.
2. A comparison table of the setups you studied: execution client and mode,
   consensus client, disk, RAM, CPU, sync time, proofs at the finalized block
   (yes, no, unconfirmed), light-client routes (yes, no, unconfirmed), monthly
   cost, link.
3. For each pick: the exact install and start commands and flags, with links to
   the documentation they come from.
4. The commands to confirm a node qualifies: one eth_getProof request at the
   finalized block, and one request for each light-client route.
5. For question 6: a per-client table of key location, format, public identity
   API and signing options, with links.
6. What doesn't work or isn't worth trying, and why, each with its source link.
7. Open questions that only a test on a real node can settle.
8. A full source list: title, author or organization, date, URL, and which
   findings each source supports.
9. Sources you wanted to read but couldn't open, with their URLs.
```
