import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { escrowBuild, prepareDeployment } from '../scripts/payment-deploy.mjs';
import { loadWalletPlan, MAX_PLAN_BYTES, startWalletReview } from '../scripts/payment-wallet.mjs';
import { createDeploymentSubmissionStore, createWalletDeploymentController, createWalletDiscovery, validateWalletReview, walletNetworkParameters } from '../scripts/payment-wallet-client.mjs';

let build, plan, directory, planPath;
const from = '0x1111111111111111111111111111111111111111';
const transactionHash = '0x' + 'ab'.repeat(32);
beforeAll(async () => {
  build = escrowBuild();
  plan = await prepareDeployment({ chainId: 560048, from, build });
  directory = mkdtempSync(join(tmpdir(), 'derpc-wallet-review-'));
  planPath = join(directory, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan));
}, 30000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function wallet() {
  let account = from, chain = '0x88bb0';
  const calls = [], listeners = new Map();
  const ethereum = {
    async request(request) {
      calls.push(request);
      if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_chainId') return chain;
      if (request.method === 'eth_sendTransaction') return transactionHash;
      throw new Error('unexpected method');
    },
    on: (event, listener) => listeners.set(event, listener),
    removeListener: event => listeners.delete(event),
  };
  return { ethereum, calls, listeners, account: value => { account = value; }, chain: value => { chain = value; } };
}

describe('local wallet plan gate', () => {
  it('checks the exact current compiled plan and rejects arbitrary transaction fields', () => {
    expect(loadWalletPlan(planPath, build).sourceHash).toBe(build.sourceHash);
    for (const change of [{ value: '0x1' }, { to: from }, { gas: '0x100000' }, { data: '0x00' }]) {
      const altered = structuredClone(plan);
      Object.assign(altered.walletRequest.params[0], change);
      const path = join(directory, 'altered.json');
      writeFileSync(path, JSON.stringify(altered));
      expect(() => loadWalletPlan(path, build)).toThrow();
    }
    expect(() => validateWalletReview({ ...plan, chainId: 1 })).toThrow();
    expect(() => validateWalletReview({ ...plan, localOnly: true })).toThrow();
  });

  it('refuses oversize or stale-source plans before opening a server', async () => {
    const path = join(directory, 'too-large.json');
    writeFileSync(path, ' '.repeat(MAX_PLAN_BYTES + 1));
    await expect(startWalletReview({ planPath: path, port: 0, build })).rejects.toThrow('128 KiB');
    const old = join(directory, 'old.json');
    writeFileSync(old, JSON.stringify({ ...plan, sourceHash: '0x' + '00'.repeat(32) }));
    await expect(startWalletReview({ planPath: old, port: 0, build })).rejects.toThrow('source differs');
  });

  it('serves a GET-only loopback page and refuses rebinding, cross-origin access and mutations', async () => {
    const { server, origin } = await startWalletReview({ planPath, port: 0, build });
    try {
      expect(server.address().address).toBe('127.0.0.1');
      const page = await fetch(origin);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(await page.text()).toContain('Not deployed');
      expect((await fetch(origin + '/plan.json')).status).toBe(200);
      expect((await fetch(origin + '/wallet.js')).status).toBe(200);
      const spoofedHostStatus = await new Promise((resolve, reject) => {
        get(origin, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
      });
      expect(spoofedHostStatus).toBe(403);
      expect((await fetch(origin + '/plan.json', { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
      expect((await fetch(origin, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      const navigationStatus = await new Promise((resolve, reject) => {
        get(origin, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
      });
      expect(navigationStatus).toBe(200);
      expect((await fetch(origin + '/plan.json', { method: 'POST', body: 'anything' })).status).toBe(405);
      expect((await fetch(origin + '/submit', { method: 'POST', body: transactionHash })).status).toBe(405);
      expect((await fetch(origin + '/plan.json?other=1')).status).toBe(404);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});

describe('explicit browser-wallet deployment', () => {
  it('keeps review disabled on chain 4221 and enables it only after a confirmed explicit Hoodi switch', async () => {
    const mock = wallet(); mock.chain('0x107d');
    const original = mock.ethereum.request;
    mock.ethereum.request = async request => {
      if (request.method !== 'wallet_switchEthereumChain') return original(request);
      mock.calls.push(request); mock.chain(request.params[0].chainId);
      mock.listeners.get('chainChanged')?.(request.params[0].chainId);
      return null;
    };
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
    await expect(controller.connect()).rejects.toThrow('chain 4221');
    controller.setReviewed(true);
    expect(controller.state()).toMatchObject({ connected: false, reviewed: false, canSend: false, canSwitchNetwork: true });
    expect(mock.calls.some(call => call.method.startsWith('wallet_'))).toBe(false);
    await controller.switchNetwork();
    expect(controller.state()).toMatchObject({ chainId: 560048, connected: true, reviewed: false, canSend: false, canSwitchNetwork: false });
    expect(mock.calls.slice(-3)).toEqual([
      { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x88bb0' }] },
      { method: 'eth_accounts' }, { method: 'eth_chainId' },
    ]);
    controller.setReviewed(true);
    expect(controller.state().canSend).toBe(true);
    expect(mock.calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });

  it.each([560048, 11155111])('adds only the reviewed testnet %s when the wallet reports unknown chain', async chainId => {
    const reviewedPlan = await prepareDeployment({ chainId, from, build });
    const mock = wallet(); mock.chain('0x107d');
    const original = mock.ethereum.request;
    let added = false;
    mock.ethereum.request = async request => {
      if (!request.method.startsWith('wallet_')) return original(request);
      mock.calls.push(request);
      if (request.method === 'wallet_addEthereumChain') { added = true; return null; }
      if (!added) throw { code: 4902, message: 'Unknown chain' };
      mock.chain(request.params[0].chainId); return null;
    };
    const controller = createWalletDeploymentController({ plan: reviewedPlan, ethereum: mock.ethereum });
    await expect(controller.connect()).rejects.toThrow('chain 4221');
    await controller.switchNetwork();
    const parameters = walletNetworkParameters(reviewedPlan);
    expect(mock.calls.filter(call => call.method.startsWith('wallet_'))).toEqual([
      { method: 'wallet_switchEthereumChain', params: [{ chainId: parameters.chainId }] },
      { method: 'wallet_addEthereumChain', params: [parameters] },
      { method: 'wallet_switchEthereumChain', params: [{ chainId: parameters.chainId }] },
    ]);
    expect(parameters.rpcUrls).toEqual([chainId === 560048 ? 'https://rpc.hoodi.ethpandaops.io' : 'https://ethereum-sepolia-rpc.publicnode.com']);
    expect(controller.state()).toMatchObject({ connected: true, reviewed: false, canSend: false, chainId });
  });

  it('refuses review if the switch is rejected, leaves the wrong network, or changes the account', async () => {
    for (const failure of ['rejected', 'wrong-network', 'wrong-account']) {
      const mock = wallet(); mock.chain('0x107d');
      const original = mock.ethereum.request;
      mock.ethereum.request = async request => {
        if (request.method !== 'wallet_switchEthereumChain') return original(request);
        mock.calls.push(request);
        if (failure === 'rejected') throw { code: 4001, message: 'User rejected' };
        if (failure === 'wrong-account') { mock.chain('0x88bb0'); mock.account('0x' + '22'.repeat(20)); }
        return null;
      };
      const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
      await expect(controller.connect()).rejects.toThrow();
      await expect(controller.switchNetwork()).rejects.toBeDefined();
      controller.setReviewed(true);
      expect(controller.state()).toMatchObject({ connected: false, reviewed: false, canSend: false, busy: false, phase: 'not-deployed' });
      expect(mock.calls.some(call => ['wallet_addEthereumChain', 'eth_sendTransaction'].includes(call.method))).toBe(false);
    }
  });

  it('blocks overlapping requests during a network switch and preserves submission guards', async () => {
    const mock = wallet(); mock.chain('0x107d');
    const original = mock.ethereum.request;
    let release;
    mock.ethereum.request = request => request.method === 'wallet_switchEthereumChain' ? new Promise(resolve => { release = resolve; }) : original(request);
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
    await expect(controller.connect()).rejects.toThrow();
    const switching = controller.switchNetwork();
    await expect(controller.connect()).rejects.toThrow('pending');
    await expect(controller.switchNetwork()).rejects.toThrow('pending');
    await expect(controller.send()).rejects.toThrow('pending');
    expect(controller.state()).toMatchObject({ busy: true, canSend: false, canSwitchNetwork: false });
    mock.chain('0x88bb0'); release(null); await switching;
    expect(controller.state()).toMatchObject({ busy: false, connected: true, reviewed: false });
    for (const initial of [{ submissionUnknown: true }, { submittedTransactionHash: transactionHash }]) {
      const guarded = createWalletDeploymentController({ plan, ethereum: mock.ethereum, ...initial });
      const phase = guarded.state().phase;
      await expect(guarded.switchNetwork()).rejects.toThrow();
      expect(guarded.state()).toMatchObject({ phase, canSend: false, canSwitchNetwork: false });
    }
  });

  it('shows a missing-wallet error and can recover when a provider arrives later', async () => {
    let selected;
    const observed = [];
    const controller = createWalletDeploymentController({ plan, getEthereum: () => selected, onState: state => observed.push(state) });
    await expect(controller.connect()).rejects.toThrow('No wallet detected');
    expect(observed.at(-1)).toMatchObject({ busy: false, connected: false, canSend: false, phase: 'not-deployed' });
    expect(observed.at(-1).message).toContain('MetaMask');
    const mock = wallet(); selected = mock.ethereum;
    await controller.connect();
    expect(controller.state().connected).toBe(true);
    expect(mock.calls.map(call => call.method)).toEqual(['eth_requestAccounts', 'eth_chainId']);
  });

  it('displays plain-object pending errors and invalidates review on disconnect', async () => {
    const mock = wallet();
    const request = mock.ethereum.request;
    mock.ethereum.request = async () => { throw { code: -32002, message: 'Already processing eth_requestAccounts' }; };
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
    await expect(controller.connect()).rejects.toMatchObject({ code: -32002 });
    expect(controller.state().message).toContain('Open the MetaMask extension');
    expect(controller.state().busy).toBe(false);
    mock.ethereum.request = request;
    await controller.connect(); controller.setReviewed(true);
    mock.listeners.get('disconnect')();
    expect(controller.state()).toMatchObject({ connected: false, reviewed: false, canSend: false });
  });

  it('pins the connected provider until an explicit reconnection', async () => {
    const first = wallet(), second = wallet();
    let selected = first.ethereum;
    const controller = createWalletDeploymentController({ plan, getEthereum: () => selected });
    await controller.connect(); controller.setReviewed(true);
    selected = second.ethereum;
    await controller.send();
    expect(first.calls.at(-1).method).toBe('eth_sendTransaction');
    expect(second.calls).toEqual([]);
  });

  it('preserves unknown and submitted state while displaying early errors', async () => {
    for (const initial of [{ submissionUnknown: true }, { submittedTransactionHash: transactionHash }]) {
      const mock = wallet();
      const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum, ...initial });
      const phase = controller.state().phase;
      await expect(controller.connect()).rejects.toThrow();
      await expect(controller.send()).rejects.toThrow();
      expect(controller.state()).toMatchObject({ phase, canSend: false, busy: false });
      expect(controller.state().message).toMatch(/unknown result|already been submitted/);
      expect(mock.calls).toEqual([]);
    }
  });

  it('never contacts a wallet on creation and requires separate connect/review/send actions', async () => {
    const mock = wallet();
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
    expect(mock.calls).toEqual([]);
    await expect(controller.send()).rejects.toThrow('Connect');
    await controller.connect();
    expect(controller.state().canSend).toBe(false);
    controller.setReviewed(true);
    expect(controller.state().canSend).toBe(true);
    const hash = await controller.send();
    expect(hash).toBe(transactionHash);
    expect(mock.calls.map(c => c.method)).toEqual(['eth_requestAccounts', 'eth_chainId', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
    expect(mock.calls.at(-1)).toEqual(plan.walletRequest);
    expect(controller.state()).toMatchObject({ phase: 'submitted-unverified', transactionHash, canSend: false });
    await expect(controller.send()).rejects.toThrow('already been submitted');
    controller.close();
    expect(mock.listeners.size).toBe(0);
  });

  it('rechecks account and chain at send and refuses a changed account/network', async () => {
    for (const wrong of ['account', 'chain']) {
      const mock = wallet();
      const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
      await controller.connect(); controller.setReviewed(true);
      if (wrong === 'account') mock.account('0x' + '22'.repeat(20));
      else mock.chain('0x1');
      await expect(controller.send()).rejects.toThrow();
      expect(mock.calls.some(c => c.method === 'eth_sendTransaction')).toBe(false);
      expect(controller.state().canSend).toBe(false);
    }
  });

  it('invalidates review on wallet events and rejects duplicate requests while a wallet prompt is pending', async () => {
    const mock = wallet();
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
    await controller.connect(); controller.setReviewed(true);
    mock.listeners.get('accountsChanged')();
    expect(controller.state()).toMatchObject({ connected: false, reviewed: false, canSend: false });
    await controller.connect(); controller.setReviewed(true);
    let release;
    const original = mock.ethereum.request;
    mock.ethereum.request = async request => request.method === 'eth_sendTransaction' ? new Promise(resolve => { release = resolve; }) : original(request);
    const pending = controller.send();
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(controller.send()).rejects.toThrow('pending');
    await expect(controller.connect()).rejects.toThrow('pending');
    expect(controller.state()).toMatchObject({ busy: true, phase: 'submission-pending', canSend: false });
    release(transactionHash);
    await pending;
  });

  it('blocks further submissions after an ambiguous wallet error or restored submission hash', async () => {
    const mock = wallet();
    const original = mock.ethereum.request;
    mock.ethereum.request = request => request.method === 'eth_sendTransaction' ? Promise.resolve('invalid hash') : original(request);
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum });
    await controller.connect(); controller.setReviewed(true);
    await expect(controller.send()).rejects.toThrow('valid transaction hash');
    expect(controller.state().phase).toBe('submission-unknown');
    await expect(controller.connect()).rejects.toThrow('unknown result');
    const restored = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submittedTransactionHash: transactionHash });
    await expect(restored.send()).rejects.toThrow('already been submitted');
    const unknown = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submissionUnknown: true });
    await expect(unknown.connect()).rejects.toThrow('unknown result');
  });

  it('persists before the wallet call and blocks a controlled reload while its response is pending', async () => {
    const values = new Map();
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const submissionStore = createDeploymentSubmissionStore({ plan, storage });
    const mock = wallet();
    const original = mock.ethereum.request;
    let release;
    mock.ethereum.request = request => {
      if (request.method !== 'eth_sendTransaction') return original(request);
      expect(submissionStore.read()).toBe('unknown');
      return new Promise(resolve => { release = resolve; });
    };
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submissionStore });
    await controller.connect(); controller.setReviewed(true);
    const pending = controller.send();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.state().phase).toBe('submission-pending');
    const reloaded = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submissionStore });
    expect(reloaded.state().phase).toBe('submission-unknown');
    await expect(reloaded.connect()).rejects.toThrow('unknown result');
    release(transactionHash);
    await pending;
    expect(submissionStore.read()).toBe(transactionHash);
    const completed = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submissionStore });
    expect(completed.state().transactionHash).toBe(transactionHash);
  });

  it('clears persisted submission state only for explicit rejection and refuses sending without persistence', async () => {
    for (const code of [4001, -32603]) {
      const values = new Map();
      const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
      const submissionStore = createDeploymentSubmissionStore({ plan, storage });
      const mock = wallet();
      const original = mock.ethereum.request;
      mock.ethereum.request = request => request.method === 'eth_sendTransaction' ? Promise.reject(Object.assign(new Error('wallet error'), { code })) : original(request);
      const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submissionStore });
      await controller.connect(); controller.setReviewed(true);
      await expect(controller.send()).rejects.toThrow('wallet error');
      expect(submissionStore.read()).toBe(code === 4001 ? undefined : 'unknown');
    }
    const mock = wallet();
    const submissionStore = createDeploymentSubmissionStore({ plan, storage: { getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); } } });
    const controller = createWalletDeploymentController({ plan, ethereum: mock.ethereum, submissionStore });
    await controller.connect(); controller.setReviewed(true);
    await expect(controller.send()).rejects.toThrow('Storage unavailable');
    expect(mock.calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });
});

describe('browser wallet discovery', () => {
  const info = { uuid: '12345678-1234-4234-8234-123456789abc', name: 'MetaMask', rdns: 'io.metamask' };
  const announce = (target, provider, metadata = info) => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: metadata, provider } }));

  it('discovers EIP-6963-only wallets and deduplicates repeated announcements without wallet requests', () => {
    const target = new EventTarget(), mock = wallet();
    target.addEventListener('eip6963:requestProvider', () => announce(target, mock.ethereum));
    const discovery = createWalletDiscovery({ target });
    expect(discovery.list()).toHaveLength(1);
    expect(discovery.list()[0]).toMatchObject({ name: 'MetaMask', rdns: 'io.metamask', provider: mock.ethereum });
    discovery.refresh();
    expect(discovery.list()).toHaveLength(1);
    expect(mock.calls).toEqual([]);
    discovery.close();
  });

  it('handles delayed announcements and legacy initialization without replacing providers', () => {
    const target = new EventTarget(), first = wallet(), second = wallet();
    const discovery = createWalletDiscovery({ target });
    expect(discovery.list()).toEqual([]);
    target.ethereum = first.ethereum;
    target.dispatchEvent(new Event('ethereum#initialized'));
    const id = discovery.list()[0].id;
    announce(target, first.ethereum);
    announce(target, second.ethereum, { ...info, uuid: '22345678-1234-4234-8234-123456789abc', name: 'Second wallet', rdns: 'example.wallet' });
    expect(discovery.list()).toHaveLength(2);
    expect(discovery.list()[0]).toMatchObject({ id, name: 'MetaMask' });
    expect(first.calls).toEqual([]); expect(second.calls).toEqual([]);
    discovery.close();
  });

  it('ignores malformed and conflicting announcements and never includes wallet icons', () => {
    const target = new EventTarget(), first = wallet(), second = wallet();
    const discovery = createWalletDiscovery({ target });
    announce(target, first.ethereum, { ...info, uuid: 'bad' });
    announce(target, {}, info);
    expect(discovery.list()).toEqual([]);
    announce(target, first.ethereum, { ...info, icon: 'data:image/svg+xml,<svg onload="alert(1)">' });
    announce(target, second.ethereum);
    expect(discovery.list()).toHaveLength(1);
    expect(discovery.list()[0].provider).toBe(first.ethereum);
    expect(discovery.list()[0]).not.toHaveProperty('icon');
    discovery.close();
    announce(target, second.ethereum, { ...info, uuid: '22345678-1234-4234-8234-123456789abc' });
    expect(discovery.list()).toHaveLength(1);
  });
});
