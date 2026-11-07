# Deliberate server faults for the demo

The two optional overlays run on the existing team-owned demo proxies. They default to **off**. They do not make these operators independent, register an ENS name, or establish anonymous browser reachability.

| Proxy | Role |
| --- | --- |
| `demo-1.derpc.eth` | Healthy reference. No fault overlay is installed. |
| `demo-2.derpc.eth` | Corrupted WETH proof, activated on demand. |
| `demo-3.derpc.eth` | RPC unavailable, activated on demand. |

From the operator's machine, with its existing SSH access:

```sh
bash scripts/vps/demo-scenario.sh demo-2 corrupt-proof 60
bash scripts/vps/demo-scenario.sh demo-3 unavailable 60

bash scripts/vps/demo-scenario.sh demo-2 status
bash scripts/vps/demo-scenario.sh demo-3 status

# End a scenario immediately.
bash scripts/vps/demo-scenario.sh demo-2 off
bash scripts/vps/demo-scenario.sh demo-3 off
```

The duration is 1–300 seconds, defaulting to 60. Each server can run either mode, but the table above is the presentation convention. Activating a mode replaces that server's previous activation. There is no public endpoint that enables or disables a fault, and the website has no SSH credential.

`corrupt-proof` changes the balance claim in successful `eth_getProof` responses **only for the public mainnet WETH account** (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`). Proof nodes stay unchanged, so the host verifier rejects the mismatch. The wrapper's own cache remains unmodified. Worker-pin and ENS account proofs are not targeted. The response carries `X-DeRPC-Demo-Scenario: corrupt-proof`.

`unavailable` returns HTTP 503 for `/rpc` without forwarding it. Identity and beacon routes remain available, which allows a prepared client to demonstrate RPC failover. This is an RPC-outage simulation, not a powered-off server. An expired, missing or invalid control file returns the overlay to normal forwarding. An observed activation also has a monotonic deadline so a wall-clock rollback cannot prolong it.

The read-only `/.well-known/derpc-demo.json` route reports the current mode and expiry. Retrieve it through Tor when checking the public onion; server-loopback access over SSH is an administrative check only. Faults affect requests reaching that demo server during the activation window, including other demo visitors. They are not restricted to the browser that requested the demonstration.

Select a healthy fallback before demonstrating a fault. A proof rejection excludes the affected endpoint locally; resetting the server does not clear that client's exclusion. Start a fresh client session to show recovery. Stop the fault explicitly after the demonstration even though it expires automatically. Shared gateway/operator ownership must remain disclosed, and the production gateway-separation checks stay enabled.

## Deployment and recovery

The overlay listens only on `127.0.0.1:8790`, forwarding to the original wrapper on `127.0.0.1:8787`. Tor's existing public onion points to the overlay. The original wrapper container and onion volume remain in place. The personal-service mapping is unchanged. No new wallet, key volume, image build or registry pull is needed.

Copy the three `.mjs` files in this directory and `scripts/vps/install-demo-faults.sh` to a staging directory on the designated server. As root, run:

```sh
bash /path/to/install-demo-faults.sh demo-2.derpc.eth /path/to/staged-demo-files
```

Use `demo-3.derpc.eth` on the other server. Startup refuses ordinary nodes, other operator names and non-loopback upstreams. The installer pins the existing wrapper image by its image ID, uses its Node runtime, starts the overlay with faults off, checks it locally, then redirects Tor without changing its onion identity. Root-owned code lives under `/opt/derpc/demo/`; root-owned public control state is `/var/lib/derpc-demo-control/scenario.json`, mounted read-only into the overlay. The administrative controller runs in a temporary offline container with write access to that directory. It uses no private keys.

To remove the overlay from public traffic, first turn the mode off, then restore Tor from its original Compose configuration:

```sh
/opt/derpc/demo/control.sh off
docker compose --project-directory /opt/derpc/app/wrapper -p wrapper \
  -f /opt/derpc/app/wrapper/compose.yaml up -d --no-deps --no-build --pull never tor
docker rm -f wrapper-demo-fault-1
```

Do not remove onion volumes. The source-based wrapper's routine `compose up` uses its original Tor route; include `/opt/derpc/demo/compose.yaml` as a second Compose file when maintaining the overlay. Operator release `wrapper-v0.1.0` remains unchanged; this is separate, deliberately enabled demonstration tooling.

## Validation

`pnpm --filter @derpc/wrapper test` includes default-off behavior, bounded lifetime, clock rollback, invalid/symlinked control files, corruption without cache contamination, HTTP control refusal, startup restrictions, and actual proof-verifier/pool rejection and failover using recorded mainnet proofs. Those tests do not claim live consensus or anonymous network verification. Operator enrollment still requires wallet-signed transactions, receipt checks and finalized proven discovery. The website's registration link prepares an onboarding draft and does not send a transaction.
