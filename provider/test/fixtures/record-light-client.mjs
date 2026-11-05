// Records real mainnet beacon light-client responses as test fixtures.
// Run from provider/: node test/fixtures/record-light-client.mjs [beaconUrl] [network]
// It syncs the real Lodestar light client from the current finalized checkpoint through a
// recording fetch, so the fixtures contain exactly the requests the light client makes.
// The recording happens on the developer's machine with a direct connection; it is test data, not app traffic.
import { writeFileSync } from "node:fs";
import { getClient } from "@lodestar/api";
import { Lightclient } from "@lodestar/light-client";
import { LightClientRestTransport } from "@lodestar/light-client/transport";
import { getChainForkConfigFromNetwork, getConsoleLogger } from "@lodestar/light-client/utils";
import { fromHex } from "@lodestar/utils";

const BEACON = process.argv[2] ?? "https://ethereum-beacon-api.publicnode.com";
const NETWORK = process.argv[3] ?? "mainnet";
const OUT = new URL(`./${NETWORK}-light-client.json`, import.meta.url);
const GENESIS = {
  mainnet: { genesisTime: 1606824023, genesisValidatorsRoot: "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95" },
};

const recorded = {};
const recordingFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const res = await fetch(input, init);
  const type = res.headers.get("content-type") ?? "";
  const binary = !type.includes("json");
  const buf = Buffer.from(await res.clone().arrayBuffer());
  const body = binary ? buf.toString("base64") : buf.toString("utf8");
  const path = url.replace(BEACON, "");
  recorded[path] = { status: res.status, headers: Object.fromEntries(res.headers.entries()), encoding: binary ? "base64" : "utf8", body };
  return res;
};

const fc = await (await fetch(`${BEACON}/eth/v1/beacon/states/head/finality_checkpoints`)).json();
const checkpoint = { root: fc.data.finalized.root, epoch: Number(fc.data.finalized.epoch) };
const config = getChainForkConfigFromNetwork(NETWORK);
const api = getClient({ urls: [BEACON], fetch: recordingFetch }, { config });
const genesisData = GENESIS[NETWORK] ?? (await (await fetch(`${BEACON}/eth/v1/beacon/genesis`)).json()).data;

const capturedAt = Date.now();
const lc = await Lightclient.initializeFromCheckpointRoot({
  config,
  logger: getConsoleLogger({ logDebug: false }),
  transport: new LightClientRestTransport(api),
  genesisData: { genesisTime: Number(genesisData.genesisTime ?? genesisData.genesis_time), genesisValidatorsRoot: genesisData.genesisValidatorsRoot ?? genesisData.genesis_validators_root },
  checkpointRoot: fromHex(checkpoint.root),
});
// Sync the current period's updates, then fetch head updates through the transport's fetch-based
// getters. We never call lc.start(): its run loop subscribes to the beacon event stream (SSE), which
// does not go through the injected fetch.
const period = Math.floor(checkpoint.epoch / 256);
await lc.sync(period, period);
const transport = new LightClientRestTransport(api);
await transport.getOptimisticUpdate();
await transport.getFinalityUpdate();

writeFileSync(OUT, JSON.stringify({ network: NETWORK, beacon: BEACON, capturedAt, checkpoint, genesisData, responses: recorded }, null, 1) + "\n");
console.log(`wrote ${OUT.pathname}: ${Object.keys(recorded).length} responses, checkpoint epoch ${checkpoint.epoch}`);
for (const [path, r] of Object.entries(recorded)) console.log(`  ${r.status} ${path.replace(/0x[0-9a-f]{64}/, "<root>")} (${(r.body.length / 1024).toFixed(1)} KB, version ${r.headers["eth-consensus-version"] ?? "-"})`);
process.exit(0);
