// Regression test for the light-client hole Lodestar fixed in core (ChainSafe/lodestar PR #9419)
// after the light client had moved out of the monorepo, so @lodestar/light-client 1.43.0 still has it.
//
// The bug: `isZeroedHeader` only compared `bodyRoot` against zero. A beacon endpoint could send a
// finality update whose finalized header has bodyRoot = 0 but attacker-chosen everything else (slot,
// state roots, execution header) plus an all-zero finality branch. Validation then treated it as a
// "non-finality" update and skipped the finality-branch check, and processing still wrote it into
// `store.finalizedHeader`, because that write was gated only on participation and slot.
// For DeRPC that means a fake execution state root, so fake balances would "verify".
import { describe, expect, it } from "vitest";
import { createBeaconConfig } from "@lodestar/config";
import { LightclientSpec } from "@lodestar/light-client/spec";
import { getChainForkConfigFromNetwork } from "@lodestar/light-client/utils";
import { sszTypesFor } from "@lodestar/types";
import { fromHex, toHex } from "@lodestar/utils";
import fixture from "../fixtures/mainnet-light-client.json" with { type: "json" };

type Responses = Record<string, { body: string }>;
const responses = fixture.responses as Responses;
const json = (path: string) => JSON.parse(responses[path]!.body);

const config = createBeaconConfig(
  getChainForkConfigFromNetwork("mainnet"),
  fromHex(fixture.genesisData.genesisValidatorsRoot),
);
const bootstrapJson = json(`/eth/v1/beacon/light_client/bootstrap/${fixture.checkpoint.root}`);
const finalityJson = json("/eth/v1/beacon/light_client/finality_update");
const types = sszTypesFor(bootstrapJson.version);

// Values read straight from the recorded mainnet data, independent of the code under test.
const BOOTSTRAP_SLOT = Number(bootstrapJson.data.header.beacon.slot);
const BOOTSTRAP_STATE_ROOT = bootstrapJson.data.header.execution.state_root as string;
const ATTESTED_SLOT = Number(finalityJson.data.attested_header.beacon.slot);
const FAKE_STATE_ROOT = "0x" + "de".repeat(32);

function newSpec() {
  const bootstrap = types.LightClientBootstrap.fromJson(bootstrapJson.data);
  return new LightclientSpec(
    config,
    { allowForcedUpdates: true, onSetFinalizedHeader: () => {}, onSetOptimisticHeader: () => {} },
    bootstrap,
  );
}

function genuineFinalityUpdate() {
  return types.LightClientFinalityUpdate.fromJson(finalityJson.data);
}

describe("light client: forged finalized header (Lodestar #9419)", () => {
  it("accepts the genuine mainnet finality update (sanity check of the setup)", () => {
    const spec = newSpec();
    const update = genuineFinalityUpdate();

    spec.onFinalityUpdate(update.signatureSlot, update);

    expect(spec.store.optimisticHeader.beacon.slot).toBe(ATTESTED_SLOT);
    expect(toHex(spec.store.finalizedHeader.execution.stateRoot)).toBe(BOOTSTRAP_STATE_ROOT);
  });

  it("never adopts a finalized header with a zeroed body root and a fake state root", () => {
    const spec = newSpec();
    const forged = genuineFinalityUpdate();
    // Keep the genuine, signed attested header and sync aggregate; forge only the finalized header.
    forged.finalizedHeader = types.LightClientHeader.clone(forged.attestedHeader);
    forged.finalizedHeader.beacon.bodyRoot = new Uint8Array(32);
    forged.finalizedHeader.execution.stateRoot = fromHex(FAKE_STATE_ROOT);
    forged.finalityBranch = forged.finalityBranch.map(() => new Uint8Array(32));

    try {
      spec.onFinalityUpdate(forged.signatureSlot, forged);
    } catch {
      // Rejecting the update outright is the expected secure outcome.
    }

    expect(toHex(spec.store.finalizedHeader.execution.stateRoot)).not.toBe(FAKE_STATE_ROOT);
    expect(spec.store.finalizedHeader.beacon.slot).toBe(BOOTSTRAP_SLOT);
  });
});
