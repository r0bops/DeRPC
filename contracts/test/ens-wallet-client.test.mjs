import { describe, expect, it, vi } from 'vitest';
import { createENSWalletController, createENSWalletDiscovery, validateENSWalletRequest, validateENSWalletState } from '../scripts/ens-wallet-client.mjs';

const from = '0x' + '11'.repeat(20), to = '0x' + '22'.repeat(20), other = '0x' + '33'.repeat(20);
const hash = '0x' + 'ab'.repeat(32), token = 'cd'.repeat(32);
const clone = value => structuredClone(value);
function initial() {
  return {
    token, complete: false, readyToVerify: false, manifest: null, stageNumber: 1,
    plan: { schemaVersion: 1, kind: 'derpc-ens-unsigned-plan', chainId: 1, stage: 'deploy-ens-proxies', sourceHash: '0x' + '12'.repeat(32),
      resumeConfig: { schemaVersion: 1, chainId: 1, parentName: 'derpc.eth', operators: [{ label: 'demo-1' }, { label: 'demo-2' }] },
      roleTable: [{ account: from, roles: 'SET_TEXT' }],
      transactions: [0, 1].map(i => ({ id: `deploy-${i}`, purpose: `Deploy proxy ${i}`, estimatedGas: '100000', walletRequest: { method: 'eth_sendTransaction', params: [{ from, to, data: `0x600${i}`, value: '0x0', chainId: '0x1' }] } })),
    },
    entries: [0, 1].map(i => ({ id: `deploy-${i}`, status: 'ready' })),
  };
}
function fakeWallet() {
  const listeners = new Map(), calls = [];
  const wallet = {
    account: from, chain: '0x1', calls, listeners, onRequest: undefined, send: async () => hash,
    on(event, listener) { listeners.set(event, listener); }, removeListener(event) { listeners.delete(event); },
    emit(event, value) { listeners.get(event)?.(value); },
    async request(request) {
      calls.push(clone(request));
      await wallet.onRequest?.(request);
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [wallet.account];
      if (request.method === 'eth_chainId') return wallet.chain;
      if (request.method === 'wallet_switchEthereumChain') { wallet.chain = request.params[0].chainId; wallet.emit('chainChanged', wallet.chain); return null; }
      if (request.method === 'eth_sendTransaction') return wallet.send(request);
      throw new Error('Unexpected wallet request');
    },
  };
  return wallet;
}
function fakeServer() {
  const server = { saved: initial(), calls: [], now: Date.now, beforeReturnBegin: undefined, mutatePermit: undefined, failBegin: false, failRecord: false, failRejected: false, onRefresh: undefined };
  server.action = async request => {
    expect(request.token).toBe(token); server.calls.push(clone(request));
    const saved = server.saved.entries.find(entry => entry.id === request.id);
    if (request.action === 'begin') {
      if (saved.status !== 'ready' || server.saved.entries.some(entry => ['pending', 'submitted'].includes(entry.status))) throw new Error('pending');
      saved.status = 'pending';
      if (server.failBegin) throw new Error('begin response lost');
      await server.beforeReturnBegin?.();
      const permit = { id: request.id, walletRequest: clone(server.saved.plan.transactions.find(tx => tx.id === request.id).walletRequest), expiresAt: server.now() + 60000 };
      server.mutatePermit?.(permit);
      return { ...clone(server.saved), permit };
    }
    if (request.action === 'record') {
      if (server.failRecord) throw Object.assign(new Error('record persistence unavailable'), { code: 4001 });
      saved.status = 'submitted'; saved.hash = request.hash;
    }
    if (request.action === 'rejected') {
      if (server.failRejected) throw new Error('rejection response lost');
      saved.status = 'ready'; delete saved.hash;
    }
    if (request.action === 'refresh') await server.onRefresh?.();
    if (request.action === 'verify') {
      if (!server.saved.readyToVerify) throw new Error('not ready');
      server.saved.complete = true; server.saved.manifest = { verification: { receipts: true, minimumConfirmations: 12 } };
    }
    return clone(server.saved);
  };
  return server;
}
async function setup({ connect = true, now } = {}) {
  const wallet = fakeWallet(), server = fakeServer();
  if (now) server.now = now;
  const controller = createENSWalletController({ initialState: server.saved, action: server.action, ...(now ? { now } : {}) });
  controller.selectWallet(wallet, 'Test wallet'); controller.selectTransaction('deploy-0');
  if (connect) { await controller.connect(); controller.setReviewed(true); }
  return { wallet, server, controller };
}
const sends = wallet => wallet.calls.filter(call => call.method === 'eth_sendTransaction');

describe('ENS browser request validation', () => {
  it('accepts exact zero-value mainnet requests and rejects network/value/calldata/extra-field changes', () => {
    const request = initial().plan.transactions[0].walletRequest;
    expect(validateENSWalletRequest(request)).toEqual(request);
    for (const change of [{ value: '0x1' }, { chainId: '0x5' }, { data: '0x0' }, { from: '0x' + '00'.repeat(20) }, { gas: '0x123' }, { nonce: '-1' }]) {
      expect(() => validateENSWalletRequest({ ...request, params: [{ ...request.params[0], ...change }] })).toThrow();
    }
    expect(() => validateENSWalletRequest({ ...request, params: [request.params[0], request.params[0]] })).toThrow();
  });

  it('does not accept a completed deployment without a final verified manifest', () => {
    expect(() => validateENSWalletState({ ...initial(), complete: true })).toThrow(/manifest/);
    expect(() => validateENSWalletState({ ...initial(), readyToVerify: true })).toThrow(/Final verification/);
  });

  it('discovers wallets without requesting an account, chain or signature', () => {
    const target = new EventTarget(), wallet = fakeWallet();
    target.ethereum = wallet;
    const discovery = createENSWalletDiscovery(target);
    expect(discovery.list()).toHaveLength(1);
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { provider: wallet, info: { uuid: '11111111-1111-4111-8111-111111111111', name: '<img src=x>', rdns: 'io.metamask' } } }));
    expect(discovery.list()[0].name).toBe('<img src=x>');
    expect(wallet.calls).toEqual([]);
    discovery.close();
  });
});

describe('ENS explicit wallet submission', () => {
  it('requires the operator wallet for a join, even when the namespace owner is connected', async () => {
    const server = fakeServer(), wallet = fakeWallet();
    server.saved.plan.flow = 'operator-join';
    server.saved.plan.stage = 'register-operator';
    server.saved.plan.resumeConfig.curator = from;
    server.saved.plan.resumeConfig.operators = [{ label: 'alice', operator: other }];
    server.saved.plan.transactions = [server.saved.plan.transactions[0]];
    server.saved.plan.transactions[0].walletRequest.params[0].from = other;
    server.saved.entries = [server.saved.entries[0]];
    const controller = createENSWalletController({ initialState: server.saved, action: server.action });
    expect(controller.state().message).toContain("operator's own wallet");
    controller.selectWallet(wallet, 'Namespace owner'); controller.selectTransaction('deploy-0');
    await expect(controller.connect()).rejects.toThrow(/sender/);
    controller.setReviewed(true);
    expect(controller.state().canSend).toBe(false);
    await expect(controller.send()).rejects.toThrow();
    expect(server.calls).toEqual([]); expect(sends(wallet)).toEqual([]);
    wallet.account = other;
    await controller.connect(); controller.setReviewed(true); await controller.send();
    expect(sends(wallet)).toEqual([server.saved.plan.transactions[0].walletRequest]);
    expect(server.calls.map(call => call.action)).toEqual(['begin', 'record']);
  });

  it('keeps a join locked without sending if the wallet switches to the namespace owner after reservation', async () => {
    const server = fakeServer(), wallet = fakeWallet();
    server.saved.plan.flow = 'operator-join';
    server.saved.plan.resumeConfig.curator = from;
    server.saved.plan.resumeConfig.operators = [{ label: 'alice', operator: other }];
    server.saved.plan.transactions[0].walletRequest.params[0].from = other;
    wallet.account = other;
    const controller = createENSWalletController({ initialState: server.saved, action: server.action });
    controller.selectWallet(wallet); controller.selectTransaction('deploy-0');
    await controller.connect(); controller.setReviewed(true);
    server.beforeReturnBegin = () => { wallet.account = from; };
    await expect(controller.send()).rejects.toThrow(/sender/);
    expect(server.saved.entries[0].status).toBe('pending');
    expect(server.calls.map(call => call.action)).toEqual(['begin']);
    expect(sends(wallet)).toEqual([]);
  });

  it('sends nothing on import, wallet selection, connection or review, then reserves before one exact send', async () => {
    const { wallet, server, controller } = await setup({ connect: false });
    expect(wallet.calls).toEqual([]); expect(server.calls).toEqual([]);
    controller.setReviewed(true); expect(controller.state().canSend).toBe(false);
    await controller.connect(); expect(sends(wallet)).toEqual([]); controller.setReviewed(true);
    wallet.send = async request => { expect(server.saved.entries[0].status).toBe('pending'); expect(request).toEqual(initial().plan.transactions[0].walletRequest); return hash; };
    await controller.send();
    expect(server.calls.map(call => call.action)).toEqual(['begin', 'record']);
    expect(sends(wallet)).toHaveLength(1);
    expect(wallet.calls.filter(call => call.method === 'eth_accounts')).toHaveLength(2);
    expect(controller.state()).toMatchObject({ reviewed: false, canSend: false, complete: false, hashes: [{ id: 'deploy-0', hash }] });
  });

  it('requires explicit mainnet switching and a fresh review after the switch', async () => {
    const { wallet, controller, server } = await setup({ connect: false });
    wallet.chain = '0x107d';
    await expect(controller.connect()).rejects.toThrow('Switch');
    expect(controller.state().canSwitchNetwork).toBe(true);
    controller.setReviewed(true); expect(controller.state().canSend).toBe(false);
    await controller.switchNetwork();
    expect(controller.state()).toMatchObject({ connected: true, chainId: 1, reviewed: false, canSend: false });
    expect(wallet.calls.find(call => call.method === 'wallet_switchEthereumChain')).toEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    expect(sends(wallet)).toEqual([]); expect(server.calls).toEqual([]);
  });

  it.each(['accountsChanged', 'chainChanged', 'disconnect'])('invalidates the review on %s', async event => {
    const { wallet, controller } = await setup(); wallet.emit(event, []);
    expect(controller.state()).toMatchObject({ connected: false, reviewed: false, canSend: false });
    await expect(controller.send()).rejects.toThrow('review'); expect(sends(wallet)).toEqual([]);
  });

  it.each(['account', 'chain'])('rechecks a silent %s change before reserving a send', async field => {
    const { wallet, server, controller } = await setup(); wallet[field] = field === 'account' ? other : '0x2';
    await expect(controller.send()).rejects.toThrow();
    expect(server.calls).toEqual([]); expect(sends(wallet)).toEqual([]);
  });

  it.each(['account', 'chain', 'event'])('rechecks a %s change after the server reserves the transaction', async field => {
    const { wallet, server, controller } = await setup();
    server.beforeReturnBegin = () => { if (field === 'event') wallet.emit('accountsChanged', [from]); else wallet[field] = field === 'account' ? other : '0x2'; };
    await expect(controller.send()).rejects.toThrow();
    expect(server.saved.entries[0].status).toBe('pending'); expect(sends(wallet)).toEqual([]);
    expect(controller.state().canSend).toBe(false);
  });

  it.each(['data', 'sender', 'expiry', 'id'])('rejects a changed or expired %s permit before asking the wallet to send', async change => {
    const { wallet, server, controller } = await setup();
    server.mutatePermit = permit => {
      if (change === 'data') permit.walletRequest.params[0].data = '0xabcd';
      if (change === 'sender') permit.walletRequest.params[0].from = other;
      if (change === 'expiry') permit.expiresAt = Date.now() - 1;
      if (change === 'id') permit.id = 'deploy-1';
    };
    await expect(controller.send()).rejects.toThrow(); expect(sends(wallet)).toEqual([]);
    expect(server.saved.entries[0].status).toBe('pending');
  });

  it('rechecks permit expiry after the second wallet observation', async () => {
    let time = 100000;
    const { wallet, server, controller } = await setup({ now: () => time });
    wallet.onRequest = request => { if (request.method === 'eth_accounts' && wallet.calls.filter(call => call.method === 'eth_accounts').length === 2) time += 60001; };
    await expect(controller.send()).rejects.toThrow('expired'); expect(sends(wallet)).toEqual([]);
    expect(server.saved.entries[0].status).toBe('pending');
  });

  it('blocks duplicate sends, wallet selection and refresh while a wallet request is pending', async () => {
    const { wallet, controller } = await setup(); let resolveSend;
    wallet.send = () => new Promise(resolve => { resolveSend = resolve; });
    const sending = controller.send(); await vi.waitFor(() => expect(sends(wallet)).toHaveLength(1));
    await expect(controller.send()).rejects.toThrow('pending'); await expect(controller.refresh()).rejects.toThrow('pending');
    expect(() => controller.selectWallet(fakeWallet())).toThrow('pending');
    resolveSend(hash); await sending; expect(sends(wallet)).toHaveLength(1);
  });

  it('keeps an ambiguous wallet error locked after refresh and reload without calling rejected', async () => {
    const { wallet, server, controller } = await setup(); wallet.send = async () => { throw Object.assign(new Error('transport lost'), { code: -32002 }); };
    await expect(controller.send()).rejects.toThrow(); await controller.refresh();
    expect(server.calls.some(call => call.action === 'rejected')).toBe(false);
    expect(controller.state().entries[0].status).toBe('pending');
    const restored = createENSWalletController({ initialState: server.saved, action: server.action });
    restored.selectWallet(wallet); restored.selectTransaction('deploy-0'); await restored.connect(); restored.setReviewed(true);
    expect(restored.state().canSend).toBe(false);
  });

  it('does not clear a lost begin response, an invalid hash, or an observation error with code 4001', async () => {
    for (const mode of ['begin', 'hash', 'observation']) {
      const { wallet, server, controller } = await setup();
      if (mode === 'begin') server.failBegin = true;
      if (mode === 'hash') wallet.send = async () => 'not-a-hash';
      if (mode === 'observation') server.beforeReturnBegin = () => { wallet.onRequest = async () => { throw { code: 4001 }; }; };
      await expect(controller.send()).rejects.toThrow();
      expect(server.saved.entries[0].status).toBe('pending'); expect(server.calls.some(call => call.action === 'rejected')).toBe(false);
    }
  });

  it('clears only an explicit send rejection, and retries its failed release only on manual refresh', async () => {
    const { wallet, server, controller } = await setup();
    wallet.send = async () => { throw { code: 4001, message: 'User rejected' }; }; server.failRejected = true;
    await expect(controller.send()).rejects.toThrow('not confirmed'); expect(controller.state().entries[0].status).toBe('pending');
    server.failRejected = false; await controller.refresh();
    expect(server.calls.map(call => call.action)).toEqual(['begin', 'rejected', 'rejected', 'refresh']);
    expect(controller.state()).toMatchObject({ reviewed: false, canSend: false }); expect(server.saved.entries[0].status).toBe('ready');
  });

  it('keeps a returned hash visible when record fails and reconciles it without resending', async () => {
    const { wallet, server, controller } = await setup(); server.failRecord = true;
    await expect(controller.send()).rejects.toThrow(hash);
    expect(controller.state().hashes).toEqual([{ id: 'deploy-0', hash }]);
    expect(server.calls.some(call => call.action === 'rejected')).toBe(false);
    server.failRecord = false; await controller.reconcile('deploy-0', hash);
    expect(sends(wallet)).toHaveLength(1); expect(server.saved.entries[0]).toMatchObject({ status: 'submitted', hash });
    await expect(controller.reconcile('deploy-0', '0x' + 'ef'.repeat(32))).rejects.toThrow('original hash');
  });

  it('requires manual refresh to advance and explicit verification to report complete', async () => {
    const { wallet, server, controller } = await setup(); await controller.send();
    expect(controller.state().plan.stage).toBe('deploy-ens-proxies');
    server.onRefresh = () => {
      server.saved.plan = { ...server.saved.plan, stage: 'complete', status: 'state-matches-config', transactions: [] };
      server.saved.entries = []; server.saved.readyToVerify = true;
    };
    await controller.refresh(); expect(controller.state()).toMatchObject({ canVerify: true, complete: false, reviewed: false, selectedId: '' });
    await controller.verify(); expect(controller.state()).toMatchObject({ complete: true, canSend: false, canVerify: false });
    expect(sends(wallet)).toHaveLength(1);
    server.onRefresh = () => { server.saved.complete = false; server.saved.manifest = null; };
    await controller.refresh(); expect(controller.state().complete).toBe(false);
  });

  it('does not let consumer snapshot mutation replace the exact reviewed request', async () => {
    const { wallet, controller } = await setup(); controller.state().plan.transactions[0].walletRequest.params[0].data = '0xdead';
    await controller.send(); expect(sends(wallet)[0].params[0].data).toBe('0x6000');
  });
});
