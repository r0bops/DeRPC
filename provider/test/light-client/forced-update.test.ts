// Lodestar's Lightclient hardcodes ALLOW_FORCED_UPDATES = true. When the next sync committee is
// missing at a period boundary, a forced update adopts it from the best stored update even if that
// update had under 2/3 participation and no finality proof. A minority of the committee could then
// hand the client a committee of its choosing. DeRPC patches the flag off: stall and fail closed.
import { describe, expect, it } from "vitest";
import { Lightclient } from "@lodestar/light-client";
import { LightclientSpec, toLightClientUpdateSummary } from "@lodestar/light-client/spec";
import { computeSyncPeriodAtSlot, getChainForkConfigFromNetwork, serializeSyncCommittee } from "@lodestar/light-client/utils";
import { createBeaconConfig } from "@lodestar/config";
import { sszTypesFor } from "@lodestar/types";
import { fromHex } from "@lodestar/utils";
import fixture from "../fixtures/mainnet-light-client.json" with { type: "json" };

type Responses = Record<string, { body: string }>;
const responses = fixture.responses as Responses;
const json = (path: string) => JSON.parse(responses[path]!.body);

const forkConfig = getChainForkConfigFromNetwork("mainnet");
const bootstrapJson = json(`/eth/v1/beacon/light_client/bootstrap/${fixture.checkpoint.root}`);
const updateJson = json("/eth/v1/beacon/light_client/updates?start_period=1903&count=1")[0].data;
const types = sszTypesFor(bootstrapJson.version);

// Two thirds of the 512-member sync committee, rounded up.
const SAFE_PARTICIPANTS = 342;

function productionSpec(): LightclientSpec {
  const lc = new Lightclient({
    config: forkConfig,
    genesisData: fixture.genesisData,
    bootstrap: types.LightClientBootstrap.fromJson(bootstrapJson.data),
    transport: {} as never,
  });
  return (lc as unknown as { lightclientSpec: LightclientSpec }).lightclientSpec;
}

// Store the genuine period-1903 update as the best candidate, reporting the given participation.
function storeCandidate(spec: LightclientSpec, activeParticipants: number) {
  const update = types.LightClientUpdate.fromJson(updateJson);
  const period = computeSyncPeriodAtSlot(update.signatureSlot);
  spec.store.bestValidUpdates.set(period, {
    update,
    summary: { ...toLightClientUpdateSummary(update), activeParticipants },
  });
  return { period, farFuture: update.signatureSlot + 100_000 };
}

function forceUpdate(spec: LightclientSpec, slot: number) {
  try {
    spec.forceUpdate(slot);
  } catch {
    // "No SyncCommittee for period ..." is the fail-closed outcome.
  }
}

describe("light client: forced sync committee updates", () => {
  it("runs with forced updates disabled", () => {
    expect((productionSpec() as unknown as { opts: { allowForcedUpdates?: boolean } }).opts.allowForcedUpdates).toBe(false);
  });

  it("never adopts the next committee from an update under 2/3 participation", () => {
    const spec = productionSpec();
    const { period, farFuture } = storeCandidate(spec, SAFE_PARTICIPANTS - 1);

    forceUpdate(spec, farFuture);

    expect(spec.store.syncCommittees.has(period + 1)).toBe(false);
  });

  it("still adopts the next committee from a safe update (sanity check of the setup)", () => {
    const spec = productionSpec();
    const { period, farFuture } = storeCandidate(spec, SAFE_PARTICIPANTS);

    forceUpdate(spec, farFuture);

    expect(spec.store.syncCommittees.has(period + 1)).toBe(true);
  });

  it("verifies a genuine signed update before installing its exact next committee", () => {
    const spec = productionSpec();
    const update = types.LightClientUpdate.fromJson(updateJson);
    const period = computeSyncPeriodAtSlot(update.signatureSlot);

    spec.onUpdate(update.signatureSlot, update);
    const accepted = spec.store.bestValidUpdates.get(period)!;
    expect(accepted.summary.activeParticipants).toBeGreaterThanOrEqual(SAFE_PARTICIPANTS);
    expect(accepted.summary.isFinalityUpdate).toBe(true);
    expect(accepted.summary.isSyncCommitteeUpdate).toBe(true);
    spec.forceUpdate(update.signatureSlot + 100_000);

    expect(serializeSyncCommittee(spec.store.syncCommittees.get(period + 1)!)).toEqual(update.nextSyncCommittee);
  });

  it.each(["signature", "finality branch"] as const)("does not store a candidate with a corrupted %s", corruption => {
    const spec = productionSpec();
    const update = types.LightClientUpdate.fromJson(updateJson);
    const period = computeSyncPeriodAtSlot(update.signatureSlot);
    if (corruption === "signature") update.syncAggregate.syncCommitteeSignature = new Uint8Array(96);
    else update.finalityBranch[0] = new Uint8Array(32);

    expect(() => spec.onUpdate(update.signatureSlot, update)).toThrow();
    expect(spec.store.bestValidUpdates.has(period)).toBe(false);
    forceUpdate(spec, update.signatureSlot + 100_000);
    expect(spec.store.syncCommittees.has(period + 1)).toBe(false);
  });

  it("does not install a supermajority candidate without finality", () => {
    const spec = productionSpec();
    const { period, farFuture } = storeCandidate(spec, 512);
    // Exercise the adoption policy independently of signature/branch validation above.
    spec.store.bestValidUpdates.get(period)!.summary.isFinalityUpdate = false;

    forceUpdate(spec, farFuture);

    expect(spec.store.syncCommittees.has(period + 1)).toBe(false);
  });

  it("would adopt the unsafe committee with forced updates on (the hole being closed)", () => {
    const spec = new LightclientSpec(
      createBeaconConfig(forkConfig, fromHex(fixture.genesisData.genesisValidatorsRoot)),
      { allowForcedUpdates: true, onSetFinalizedHeader: () => {}, onSetOptimisticHeader: () => {} },
      types.LightClientBootstrap.fromJson(bootstrapJson.data),
    );
    const { period, farFuture } = storeCandidate(spec, SAFE_PARTICIPANTS - 1);

    forceUpdate(spec, farFuture);

    expect(spec.store.syncCommittees.has(period + 1)).toBe(true);
  });
});
