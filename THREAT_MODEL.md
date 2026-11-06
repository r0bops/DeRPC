# DeRPC threat model

This covers the read-only browser provider in this repo. DeRPC is a hackathon prototype and has not had an external audit.

**What DeRPC aims to give you:** an RPC endpoint can't tell which IP is asking, and can't make the app accept a false answer. If either property can't be kept, the read fails. It never falls back to a direct request.

**What it doesn't give you:** it doesn't hide what you ask, and it doesn't keep your reads unlinkable from each other.

## Who sees what

| Party | Sees | Doesn't see | Can do |
|---|---|---|---|
| RPC or beacon endpoint | Query content and timing, the Tor exit's IP | The user's IP | Refuse, stall, or lie (lies fail the proof check) |
| Tor exit | Which endpoint is contacted, and when | Content (TLS runs inside the worker), the user's IP | Drop or delay traffic |
| Tor gateway | The user's IP, encrypted traffic | Destinations, content | Refuse service; log who connects |
| jsDelivr | The IP that downloads the worker bundle | Queries | Refuse service (the bundle is hash-checked) |
| Page host | Visitors, as any website does | Queries, unless it serves altered code | Serve altered code (see below) |
| The worker | Every query and destination | — | Deanonymize or refuse, but not forge a read |

## Trust assumptions

- **The pinned checkpoint.** `MAINNET_CHECKPOINT` is the root of trust for every verified read. Two beacon APIs agreed on it when it was pinned, but that is a human decision and nothing proves it. The app refuses a checkpoint older than 7 days, measured from the verified bootstrap.
- **The sync committee.** Verified headers assume at least 2/3 of the 512-member committee is honest. Forced committee updates are patched off (#27), because Lodestar's default let one signer install a new committee. Crossing a period therefore needs a safe update from a beacon endpoint.
- **The worker pin.** The harness only runs a bundle that matches the pinned hash. After startup, the pinned hash is compared with the specifier contract's slot 1, proven through the worker. Reads wait for that check. The pin values were read without a proof, and they become trusted only when this check passes.
- **The page and its build.** The provider, verifier and pins all ship in the page. A host that serves altered code can change any of them, so DeRPC can't protect a user from the page they loaded.
- **Dependencies.** The light client and harness versions are pinned, and the Lodestar fixes are a local patch. The Lodestar light client is unmaintained and doesn't support Gloas, so it has to be replaced before that fork reaches mainnet.

## What is checked

- Account, balance, nonce and storage values are checked against EIP-1186 proofs and the verified state root. Code is checked against the proven code hash.
- All attempts of one read are proven at one pinned block, and freshness is checked again before a value is returned.
- A finalized header older than 30 minutes is refused.
- An endpoint whose proof fails is excluded locally for the session. Other failures put it on a cooldown.
- Errors in the anonymity network aren't counted against operators, so an outage shows up as disconnected rather than as bad endpoints.
- Each attempt has an 8 s timeout, and the whole read has a 30 s budget. A result that arrives after the budget is discarded.
- Response bodies are limited in both size and time.

## What attackers can and can't do

| Attacker | Goal | Outcome |
|---|---|---|
| Lying endpoint | Return a false value | Refused by the proof check; the endpoint is excluded and another one is tried |
| Lying beacon endpoint | Install a false header | Refused unless it has 2/3 of the sync committee's signatures |
| Stalling endpoint or beacon | Deny service, serve stale state | The read fails. Availability is lost, but no stale value is accepted |
| Every endpoint colludes | Deny service | Reads fail. They can't forge answers |
| Endpoint logs queries | Profile a user | **Works.** It sees which addresses are queried and when, without the IP. Repeated queries can be linked by content |
| Endpoint and gateway collude | Link IP to queries by timing | **Not defended.** Tor doesn't stop an observer who sees both ends |
| Network observer | Learn that someone uses Tor | **Works.** The gateway connection and the jsDelivr download are direct |
| Malicious worker | Deanonymize users | Stopped only by the pin, which is why it is checked on-chain |
| Malicious page host | Anything | **Not defended** |

## Known limits

- **Account isolation is unproven.** Reads use a different isolation key per account and per attempt, and tor-js documents one circuit per key. We've seen that once but haven't proven it, so DeRPC makes no unlinkability claim.
- **Operators are curated and hard-coded.** The `*.derpc.eth` names are placeholders (`ENS_NAMES_ARE_MOCK`), and several URLs don't prove several independent operators. Curated operators can log queries, and proofs won't show it.
- **Finalized data only.** Reads lag the chain head by about 13 minutes. This is a design choice, not an attack.
- **Read-only.** No `eth_call`, logs or transactions. These are refused rather than forwarded, because they can't be proven here.
- **Direct traffic exists.** See [Traffic outside the worker](README.md#traffic-outside-the-worker). The demo's direct-connections panel uses resource timing and doesn't show the WebRTC gateway link.
- **Gateway defaults.** Until a public gateway is deployed (#13), the default is the tor-js demo gateway, which has limited capacity and may disappear.
