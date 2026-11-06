// Observation-only live harness. The original verifier methods make every trust decision.
import '../../src/runtime/node-globals.ts';
import { Lightclient } from '@lodestar/light-client';
import { toLightClientUpdateSummary } from '@lodestar/light-client/spec';
import { serializeSyncCommittee } from '@lodestar/light-client/utils';
import { ssz } from '@lodestar/types';
import { toHex } from '@lodestar/utils';
import { createDeRPCWith } from '../../src/api/derpc.ts';
import { startAnonTransport } from '../../src/transport/anon-transport.ts';
import { startVerifiedHeaderSource, GENESIS } from '../../src/light-client/header-source.ts';
import { MAINNET_CHECKPOINT, TOR_JS_PIN } from '../../src/config/mainnet.ts';

const TARGET = 1904, SLOTS_PER_PERIOD = 8192;
const ORIGINAL = { epoch: 487173, root: '0x35bd26d77ecef24031f37b86d4be488fd66c472eb68c11595ca1f327a9a54f24' };
const boundaryMs = (GENESIS.mainnet.genesisTime + TARGET * SLOTS_PER_PERIOD * 12) * 1000;
const period = slot => Math.floor(slot / SLOTS_PER_PERIOD);
const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const errorShape = error => ({ name: error?.name, message: error?.message ?? String(error) });
const countBits = bytes => [...bytes].reduce((sum, byte) => { while (byte) { sum += byte & 1; byte >>>= 1; } return sum; }, 0);
const committeeRoot = committee => toHex(ssz.altair.SyncCommittee.hashTreeRoot(committee));
const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function runPeriodColdStart(options) {
  const { mode, gateway, beacons, rpcs } = options;
  const startedAt = Date.now();
  if (mode === 'live' && startedAt < boundaryMs) throw Error('Live run must start after the real period boundary');
  if (MAINNET_CHECKPOINT.epoch !== ORIGINAL.epoch || MAINNET_CHECKPOINT.root !== ORIGINAL.root) throw Error('Original period-1903 checkpoint changed');
  const progress = async entry => window.periodProgress?.(clean(entry));
  const events = [], fetched = [], initializations = [], traffic = [], headerLogs = [], poolEvents = [];
  const clients = new Map(), originals = new Map();
  const nowPeriod = () => period(Math.floor((Date.now() / 1000 - GENESIS.mainnet.genesisTime) / 12));
  const snapshot = client => {
    const spec = client.lightclientSpec;
    return {
      headSlot: client.getHead().beacon.slot,
      finalizedSlot: client.getFinalized().beacon.slot,
      allowForcedUpdates: spec.opts.allowForcedUpdates,
      installedCommittees: [...spec.store.syncCommittees].map(([at, committee]) => ({ period: at, root: committeeRoot(serializeSyncCommittee(committee)) })),
    };
  };
  // Wrap only to observe inputs and the real store after the original method returns.
  // Never modify updates, clocks, store entries, verifier options or return values.
  for (const method of ['start', 'processSyncCommitteeUpdate', 'processOptimisticUpdate', 'processFinalizedUpdate']) {
    const original = Lightclient.prototype[method];
    originals.set(method, original);
    Lightclient.prototype[method] = function (...args) {
      if (!clients.has(this)) clients.set(this, clients.size + 1);
      const clientId = clients.get(this), before = snapshot(this);
      if (method === 'start') {
        initializations.push({ clientId, at: new Date().toISOString(), ...before });
        return original.apply(this, args);
      }
      const update = args[0];
      const entry = {
        clientId, method, at: new Date().toISOString(), signatureSlot: update.signatureSlot,
        signaturePeriod: period(update.signatureSlot), attestedSlot: update.attestedHeader.beacon.slot,
        finalizedSlot: update.finalizedHeader?.beacon.slot,
        participants: countBits(update.syncAggregate.syncCommitteeBits.uint8Array), before,
        ...(method === 'processSyncCommitteeUpdate' ? {
          summary: toLightClientUpdateSummary(update), nextCommitteeRoot: committeeRoot(update.nextSyncCommittee),
        } : {}),
      };
      events.push(entry);
      try {
        const result = original.apply(this, args);
        entry.returnedNormally = true;
        entry.after = snapshot(this);
        entry.headAdvanced = entry.after.headSlot > before.headSlot;
        entry.acceptedHead = entry.headAdvanced && entry.after.headSlot >= entry.attestedSlot;
        return result;
      } catch (error) {
        entry.error = errorShape(error);
        entry.after = snapshot(this);
        throw error;
      }
    };
  }
  const observeFetch = underlying => async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const response = await underlying(input, init);
    if (new URL(url).pathname.includes('/light_client/')) {
      const entry = { url, status: response.status, receivedAt: new Date().toISOString() };
      fetched.push(entry);
      try {
        // Production asFetch has already read and bounded the body; inspecting a clone makes no request.
        const body = await response.clone().text();
        entry.bodySha256 = await sha256(body);
        const raw = JSON.parse(body), values = Array.isArray(raw) ? raw : [raw];
        entry.updates = values.map(envelope => {
          const data = envelope.data;
          if (!data?.signature_slot) return { version: envelope.version, bootstrapSlot: data?.header?.beacon?.slot };
          const bits = data.sync_aggregate.sync_committee_bits.slice(2).match(/../g).map(byte => parseInt(byte, 16));
          return { version: envelope.version, signatureSlot: Number(data.signature_slot), signaturePeriod: period(Number(data.signature_slot)),
            attestedSlot: Number(data.attested_header.beacon.slot), finalizedSlot: data.finalized_header ? Number(data.finalized_header.beacon.slot) : null,
            participants: countBits(bits), finalityBranchPresent: !!data.finality_branch?.some(node => !/^0x0+$/.test(node)),
            nextCommitteeBranchPresent: !!data.next_sync_committee_branch?.some(node => !/^0x0+$/.test(node)) };
        });
      } catch (error) { entry.captureError = errorShape(error); }
    }
    return response;
  };
  let transport, d, activeClientId, phase = 'worker-startup', outcome = {};
  const bounded = async (promise, ms, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} exceeded harness bound ${ms}ms`)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const transition = () => {
    for (const accepted of events) {
      if (accepted.clientId !== activeClientId) continue;
      if (!accepted.returnedNormally || !accepted.acceptedHead || accepted.signaturePeriod !== TARGET || accepted.after.allowForcedUpdates !== false) continue;
      const installed = accepted.after.installedCommittees.find(committee => committee.period === TARGET);
      const safe = events.find(candidate => candidate.clientId === accepted.clientId && candidate.returnedNormally && candidate.signaturePeriod === TARGET - 1 &&
        candidate.summary?.activeParticipants >= 342 && candidate.summary.isFinalityUpdate && candidate.summary.isSyncCommitteeUpdate &&
        candidate.nextCommitteeRoot === installed?.root);
      const initial = initializations.find(candidate => candidate.clientId === accepted.clientId);
      if (safe && initial?.installedCommittees.length === 1 && initial.installedCommittees[0].period === TARGET - 1 && initial.allowForcedUpdates === false) {
        return { clientId: accepted.clientId, safeUpdateEvent: events.indexOf(safe), acceptedHeadEvent: events.indexOf(accepted), committeeRoot: installed.root,
          signatureSlot: accepted.signatureSlot, headSlot: accepted.after.headSlot };
      }
    }
    return null;
  };
  try {
    d = createDeRPCWith({
      startTransport: options => {
        transport = startAnonTransport(options);
        const original = transport.fetch.bind(transport);
        transport.fetch = async (url, init) => {
          const entry = { phase, url, at: new Date().toISOString() };
          if (typeof init?.body === 'string') { try { entry.method = JSON.parse(init.body).method; } catch {} }
          traffic.push(entry);
          try { const response = await original(url, init); entry.status = response.status; return response; }
          catch (error) { entry.error = errorShape(error); throw error; }
        };
        return transport;
      },
      startHeaders: async options => {
        const headers = await startVerifiedHeaderSource({ ...options,
          fetch: observeFetch(options.fetch),
          fetchForAttempt: attempt => observeFetch(options.fetchForAttempt ? options.fetchForAttempt(attempt) : options.fetch),
          onLog: (level, message) => headerLogs.push({ level, message, at: new Date().toISOString() }),
        });
        // Abandoned startup attempts have terminally aborted lifecycles. Bind the evidence to
        // the one client whose header source actually returned, not an earlier discarded attempt.
        const active = [...clients].filter(([client]) => client.lifecycle?.signal.aborted === false);
        if (active.length !== 1) { headers.close(); throw Error('Cannot identify one active verified header client'); }
        activeClientId = active[0][1];
        return headers;
      },
    }, { checkpoint: ORIGINAL, worker: TOR_JS_PIN, gateways: [gateway], beaconUrl: beacons[0], beaconUrls: beacons.slice(1),
      operators: rpcs.map((url, index) => ({ id: `live-proof-${index}`, url, priority: index })),
      onPoolEvent: event => poolEvents.push(event),
    });
    await bounded(transport.ready, 45000, 'worker startup');
    await progress({ phase: 'worker-ready', mode, at: new Date().toISOString() });
    phase = 'consensus-startup';
    await bounded(d.ready, 75000, 'production header startup');
    await progress({ phase: 'headers-ready', mode, at: new Date().toISOString(), header: d.status().lightClient.header });
    if (mode === 'live') {
      phase = 'await-accepted-target-signature';
      const deadline = performance.now() + 90000;
      while (!transition()) {
        if (performance.now() >= deadline) throw Error('No verified period-1904 head advance with a matching safe period-1903 committee');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await progress({ phase: 'target-signature-accepted', mode, transition: transition(), at: new Date().toISOString() });
    }
    phase = 'worker-pin-and-balance';
    const read = await bounded(d.reader.getBalance('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), 65000, 'worker pin and proven balance');
    outcome = { functionalPass: true, readAt: new Date().toISOString(), readPeriod: nowPeriod(), pin: d.status().pin,
      balance: read.value.toString(), readHeader: read.block, finalizedPeriod: period(read.block.slot), transition: transition() };
    await progress({ phase: 'balance-verified', at: outcome.readAt, blockNumber: read.block.blockNumber, finalizedPeriod: outcome.finalizedPeriod });
  } catch (error) { outcome = { functionalPass: false, phase, error: errorShape(error), status: d && clean(d.status()) }; }
  finally {
    phase = 'closed';
    d?.close();
    const before = traffic.length;
    let refusal;
    try { await d?.reader.getBalance('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'); } catch (error) { refusal = errorShape(error); }
    await new Promise(resolve => setTimeout(resolve, 1000));
    outcome.close = { callsAfterClose: traffic.length - before, refusal, iframeCount: document.querySelectorAll('iframe').length };
    for (const [method, original] of originals) Lightclient.prototype[method] = original;
  }
  outcome.boundaryValidated = mode === 'live' && startedAt >= boundaryMs && outcome.readPeriod === TARGET && !!outcome.transition && outcome.functionalPass;
  return clean({ mode, startedAt: new Date(startedAt).toISOString(), startPeriod: period(Math.floor((startedAt / 1000 - GENESIS.mainnet.genesisTime) / 12)),
    checkpoint: ORIGINAL, boundary: { period: TARGET, slot: TARGET * SLOTS_PER_PERIOD, at: new Date(boundaryMs).toISOString() },
    productionTimeoutOverrides: false, activeClientId, outcome, initializations, fetched, events, traffic, headerLogs, poolEvents });
}
