// Called only after ens-fork.test.mjs has guarded and snapshotted a loopback Anvil fork.
import { expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createWalletClient, encodeFunctionData, http, zeroAddress } from 'viem';
import { checkLifecyclePlan, prepareLifecycle, verifyLifecycle } from '../scripts/ens-lifecycle.mjs';
import { dnsEncode, json, registryAbi, resolverAbi } from '../scripts/ens-common.mjs';

export async function validateForkLifecycle({ manifest, client, rpc, forkRpc, build, fork }) {
  const fixture = await rpc('evm_snapshot');
  const op = manifest.operators[0], other = manifest.operators[1];
  const label = op.name.slice(0, -'.derpc.eth'.length);
  const report = { checkedAt: new Date().toISOString(), localOnly: true, publicTransactionsSent: false, scope: 'Disposable mainnet-code fork; fixture operators are not independent public enrollments', fork, sourceHash: build.sourceHash, compiler: build.compiler, upstream: manifest.upstream, checks: [], examples: [] };
  const request = (from, to, abi, functionName, args) => ({ from, to, data: encodeFunctionData({ abi, functionName, args }), value: '0x0', chainId: '0x1' });
  const wallet = from => createWalletClient({ account: from, transport: http(forkRpc, { retryCount: 0, timeout: 30000 }) });
  const submit = tx => wallet(tx.from).sendTransaction({ chain: null, to: tx.to, data: tx.data, value: 0n, gas: 8_000_000n, ...(tx.nonce === undefined ? {} : { nonce: tx.nonce }) });
  const mine = async () => { for (let i = 0; i < 12; i++) await rpc('evm_mine'); };
  const prepare = action => prepareLifecycle({ manifest, action, client, build });
  const check = plan => checkLifecyclePlan({ manifest, plan, client, build });
  const verify = (plan, hash, override = client) => verifyLifecycle({ manifest, plan, transactionHash: hash, client: override, build });
  const isolated = async fn => { const snapshot = await rpc('evm_snapshot'); try { return await fn(); } finally { await rpc('evm_setAutomine', [true]); expect(await rpc('evm_revert', [snapshot])).toBe(true); } };
  const keep = (plan, result) => report.examples.push({ plan, evidence: { action: result.action, receipt: result.receipt, verification: result.verification, finality: result.finality, before: { entry: result.before.entry, ens: result.before.ens, endpoint: result.before.records['derpc.endpoint'] }, after: { entry: result.after.entry, ens: result.after.ens, endpoint: result.after.records['derpc.endpoint'] } } });
  try {
    const rotate = await prepare({ type: 'rotate-endpoint', label, expectedEndpoint: op.records['derpc.endpoint'], newEndpoint: 'https://rotated-lifecycle.example/rpc' });
    expect(rotate.walletRequest.params[0].from).toBe(op.hotKey);
    expect((await check(rotate)).stateStillMatches).toBe(true);
    for (const mutate of [plan => { plan.walletRequest.params[0].from = op.coldOwner; }, plan => { plan.walletRequest.params[0].value = '0x1'; }, plan => { plan.walletRequest.params[0].to = other.resolver; }, plan => { plan.before.entry.active = false; }, plan => { plan.reviewExpiresAt++; }, plan => { plan.manifestHash = '0x' + '99'.repeat(32); }]) {
      const tampered = structuredClone(rotate); mutate(tampered); await expect(check(tampered)).rejects.toThrow();
    }
    await expect(verify(rotate, '0x' + '99'.repeat(32), { ...client, getChainId: async () => 31337 })).rejects.toThrow(/chain ID/);
    await isolated(async () => {
      await submit(request(op.hotKey, op.resolver, resolverAbi, 'setText', [dnsEncode(op.name), 'derpc.endpoint', 'https://changed-before-signing.example/rpc']));
      await expect(check(rotate)).rejects.toThrow(/changed/);
    });
    await isolated(async () => {
      await submit(request(op.coldOwner, op.resolver, resolverAbi, 'grantSetterRoles', [encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(op.name), 'unknown.hot.permission', ''] }), op.hotKey]));
      await expect(check(rotate)).rejects.toThrow(/role history/);
    });
    for (const tx of [request(op.hotKey, op.resolver, resolverAbi, 'setText', [dnsEncode(op.name), 'derpc.signer', other.operator]), request(op.hotKey, op.resolver, resolverAbi, 'setText', [dnsEncode(op.name), 'derpc.payee', other.payee]), request(op.hotKey, other.resolver, resolverAbi, 'setText', [dnsEncode(other.name), 'derpc.endpoint', 'https://cross-operator.example/rpc'])]) {
      await expect(client.call({ account: tx.from, to: tx.to, data: tx.data })).rejects.toThrow();
    }
    report.checks.push('Exact reviewed sender/destination/calldata/value, manifest provenance, block preconditions, chain and unknown hot-key grants fail closed; signer/payee and cross-operator writes denied by actual ENS code');

    await isolated(async () => {
      // The cold owner can set text, but this plan is specifically a hot-key update.
      const hash = await submit({ ...rotate.walletRequest.params[0], from: op.coldOwner }); await mine();
      await expect(verify(rotate, hash)).rejects.toThrow(/Mined transaction differs/);
    });
    const rotationHash = await submit(rotate.walletRequest.params[0]); await mine();
    const pendingClient = { ...client, getBlock: options => options.blockTag === 'finalized' ? client.getBlock({ blockNumber: BigInt(rotate.before.block.number) }) : client.getBlock(options) };
    const rotated = await verify(rotate, rotationHash, pendingClient);
    expect(rotated.after.records['derpc.endpoint']).toBe(rotate.action.newEndpoint);
    expect(rotated.after.entry).toEqual(rotated.before.entry);
    expect(rotated.finality.status).toBe('pending-finality'); expect(rotated.finality.clientRefreshVerified).toBe(false);
    keep(rotate, rotated);
    await expect(verify(rotate, rotationHash, { ...client, getBlock: async options => {
      const block = await client.getBlock(options); return options.blockNumber === BigInt(rotated.receipt.blockNumber) ? { ...block, hash: '0x' + '42'.repeat(32) } : block;
    } })).rejects.toThrow(/canonical/);
    report.checks.push('Allowed hot-key endpoint rotation has canonical before/receipt/current state evidence; twelve confirmations stay separate from an injected pending-finality tag; inconsistent receipt-block hashes rejected');

    await isolated(async () => {
      const raced = await prepare({ type: 'rotate-endpoint', label, expectedEndpoint: rotate.action.newEndpoint, newEndpoint: 'https://after-race.example/rpc' });
      const nonce = await client.getTransactionCount({ address: op.hotKey, blockTag: 'pending' });
      await rpc('evm_setAutomine', [false]);
      await submit({ ...request(op.hotKey, op.resolver, resolverAbi, 'setText', [dnsEncode(op.name), 'derpc.endpoint', 'https://same-block-race.example/rpc']), nonce });
      const hash = await submit({ ...raced.walletRequest.params[0], nonce: nonce + 1 });
      await rpc('evm_mine'); await rpc('evm_setAutomine', [true]); await mine();
      await expect(verify(raced, hash)).rejects.toThrow(/receipt block/);
    });
    report.checks.push('Another managed-contract write in the same receipt block is rejected instead of being hidden by an end-of-block state match');

    await isolated(async () => {
      await rpc('evm_setNextBlockTimestamp', [rotate.before.entry.expiry + 1]); await rpc('evm_mine');
      await expect(prepare({ type: 'rotate-endpoint', label, expectedEndpoint: rotate.action.newEndpoint, newEndpoint: 'https://expired.example/rpc' })).rejects.toThrow(/expired listing/);
      const expiry = Number((await client.getBlock()).timestamp) + 3600;
      await expect(prepare({ type: 'renew', label, expectedExpiry: rotate.before.entry.expiry, expiry: expiry + 31 * 86400 })).rejects.toThrow(/30 days/);
      await expect(prepare({ type: 'renew', label, expectedExpiry: rotate.before.entry.expiry + 1, expiry })).rejects.toThrow(/expected current lease/);
      // An operator may not revive its own lapsed lease: the tool refuses to prepare it and the registrar reverts it.
      await expect(prepare({ type: 'renew', label, expectedExpiry: rotate.before.entry.expiry, expiry, authority: 'operator' })).rejects.toThrow(/curator/);
      const renew = await prepare({ type: 'renew', label, expectedExpiry: rotate.before.entry.expiry, expiry, authority: 'curator' });
      await expect(client.call({ account: op.operator, to: manifest.registrar.address, data: renew.walletRequest.params[0].data })).rejects.toThrow();
      expect(renew.before.entry.active).toBe(true); expect(renew.before.ens.status).toBe(0); expect(renew.before.resolved).toBe(zeroAddress);
      await expect(client.call({ account: other.operator, to: manifest.registrar.address, data: renew.walletRequest.params[0].data })).rejects.toThrow();
      const hash = await submit(renew.walletRequest.params[0]); await mine();
      const renewed = await verify(renew, hash);
      expect(renewed.after.ens.status).toBe(2); expect(renewed.after.resolved.toLowerCase()).toBe(op.resolver.toLowerCase());
      expect(renewed.after.ens.latestOwner).toBe(renewed.before.ens.latestOwner); expect(renewed.after.ens.tokenId).toBe(renewed.before.ens.tokenId);
      expect(renewed.after.entry.active).toBe(true); keep(renew, renewed);
    });
    report.checks.push('Expired-but-active lease recovers through the registrar only by the curator, retaining owner/token/dedicated resolver; the operator cannot revive it; expiry bounds and unauthorized renewal reject; expired endpoint rotation refuses');

    const renew = await prepare({ type: 'renew', label, expectedExpiry: rotate.before.entry.expiry, expiry: rotate.before.entry.expiry + 3600, authority: 'curator' });
    expect(renew.walletRequest.params[0].from).toBe(manifest.curator);
    const renewHash = await submit(renew.walletRequest.params[0]); await mine();
    const renewed = await verify(renew, renewHash); keep(renew, renewed);
    const remove = await prepare({ type: 'delist', label });
    expect(remove.walletRequest.params[0].from).toBe(manifest.curator);
    const removeHash = await submit(remove.walletRequest.params[0]); await mine();
    const removed = await verify(remove, removeHash);
    expect(removed.after.entry.active).toBe(false); expect(removed.after.ens).toEqual(removed.before.ens);
    expect(removed.after.resolved.toLowerCase()).toBe(op.resolver.toLowerCase()); keep(remove, removed);
    await expect(prepare({ type: 'delist', label })).rejects.toThrow(/already delisted/);
    await expect(prepare({ type: 'renew', label, expectedExpiry: renewed.after.entry.expiry, expiry: renewed.after.entry.expiry + 3600 })).rejects.toThrow(/already delisted/);
    await expect(prepare({ type: 'rotate-endpoint', label, expectedEndpoint: rotate.action.newEndpoint, newEndpoint: 'https://removed.example/rpc' })).rejects.toThrow(/already delisted/);
    await expect(client.call({ account: op.operator, to: manifest.registrar.address, data: encodeFunctionData({ abi: build.artifact.abi, functionName: 'renew', args: [BigInt(remove.before.index), BigInt(renewed.after.entry.expiry + 3600)] }) })).rejects.toThrow();
    report.checks.push('Curator renewal and registrar delisting verified; delisting preserves token/owner/resolver/expiry, clears admission, and prevents renewal or implicit relisting');
    report.complete = true;
    return report;
  } finally {
    await rpc('evm_setAutomine', [true]); expect(await rpc('evm_revert', [fixture])).toBe(true);
    if (process.env.DERPC_ENS_LIFECYCLE_REPORT) writeFileSync(process.env.DERPC_ENS_LIFECYCLE_REPORT, json(report));
  }
}
