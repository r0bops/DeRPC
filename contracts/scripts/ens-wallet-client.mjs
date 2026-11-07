/** Shared ENS review UI. Signing stays in the selected wallet; the journal receives public transaction data only. */
const HASH = /^0x[\da-fA-F]{64}$/;
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const copy = value => structuredClone(value);
const address = value => typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
const equalAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const errorText = error => error?.code === -32002
  ? 'A wallet request is already pending. Open your wallet and finish or reject it. An unknown transaction stays locked here.'
  : typeof error?.message === 'string' ? error.message : 'The wallet or transaction checks failed.';

export function validateENSWalletRequest(request) {
  const tx = request?.params?.[0];
  if (request?.method !== 'eth_sendTransaction' || !Array.isArray(request.params) || request.params.length !== 1 ||
      !tx || typeof tx !== 'object' || Array.isArray(tx) || Object.keys(request).some(key => !['method', 'params'].includes(key)) ||
      Object.keys(tx).some(key => !['from', 'to', 'data', 'value', 'chainId', 'nonce'].includes(key))) throw new Error('Expected one exact ENS eth_sendTransaction request.');
  if (!address(tx.from) || tx.chainId !== '0x1' || tx.value !== '0x0' ||
      typeof tx.data !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(tx.data) || tx.data.length > 1048576 ||
      Object.hasOwn(tx, 'to') && !address(tx.to) || Object.hasOwn(tx, 'nonce') && (typeof tx.nonce !== 'string' || !/^0x(?:0|[1-9a-fA-F][\da-fA-F]*)$/.test(tx.nonce))) {
    throw new Error('Only the reviewed mainnet sender, destination, calldata, optional nonce and zero ETH value are allowed.');
  }
  return copy(request);
}

export function validateENSWalletState(input) {
  const plan = input?.plan;
  if (!input || typeof input.token !== 'string' || !/^[\da-f]{64}$/i.test(input.token) ||
      plan?.schemaVersion !== 1 || plan.kind !== 'derpc-ens-unsigned-plan' || plan.chainId !== 1 ||
      typeof plan.stage !== 'string' || !plan.stage || !HASH.test(plan.sourceHash ?? '') ||
      !Array.isArray(plan.transactions) || plan.transactions.length > 128 || !Array.isArray(plan.roleTable) ||
      plan.resumeConfig?.schemaVersion !== 1 || plan.resumeConfig.chainId !== 1 || plan.resumeConfig.parentName !== 'derpc.eth' ||
      !Array.isArray(plan.resumeConfig.operators) || !Array.isArray(input.entries) || input.entries.length !== plan.transactions.length) {
    throw new Error('The saved journal does not contain a complete mainnet ENS plan and transaction state.');
  }
  const ids = new Set();
  for (const item of plan.transactions) {
    if (typeof item.id !== 'string' || !item.id || item.id.length > 256 || ids.has(item.id) || typeof item.purpose !== 'string') throw new Error('Invalid or duplicated transaction ID.');
    ids.add(item.id);
    validateENSWalletRequest(item.walletRequest);
    if (item.estimatedGas !== undefined && !/^[0-9]+$/.test(String(item.estimatedGas))) throw new Error('Invalid gas estimate in the reviewed plan.');
  }
  const entries = new Set();
  for (const entry of input.entries) {
    if (!ids.has(entry.id) || entries.has(entry.id) || !['ready', 'pending', 'submitted', 'confirmed'].includes(entry.status) ||
        entry.hash !== undefined && !HASH.test(entry.hash) || ['submitted', 'confirmed'].includes(entry.status) && !HASH.test(entry.hash ?? '')) throw new Error('Invalid saved transaction state.');
    entries.add(entry.id);
  }
  for (const operator of plan.resumeConfig.operators) if (!/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(operator?.label ?? '')) throw new Error('Invalid operator name in the reviewed configuration.');
  if (input.readyToVerify === true && (plan.transactions.length || plan.status !== 'state-matches-config')) throw new Error('Final verification requires a complete plan with no remaining transactions.');
  if (input.complete === true && (input.readyToVerify !== true || !input.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest))) throw new Error('Completion requires a verified operation manifest and no remaining stage.');
  const { permit: _permit, ...state } = copy(input);
  return state;
}

/** Injectable controller; importing this module never connects a wallet or fetches a plan. */
export function createENSWalletController({ initialState, action, onChange = () => {}, now = Date.now }) {
  let server = validateENSWalletState(initialState), provider, walletName = '', selectedId = '';
  let busy = false, connected = false, reviewed = false, account, chainId, revision = 0, closed = false;
  const operation = () => server.plan.flow === 'operator-join' ? 'operator registration' : server.plan.flow === 'operator-management' ? 'operator management' : 'deployment';
  let message = server.plan.flow === 'operator-join'
    ? 'Choose an operator registration transaction, connect the operator\'s own wallet on Ethereum mainnet, and review it before sending.'
    : 'Choose a transaction, connect its sender on Ethereum mainnet, and review it before sending.';
  const locks = new Set(), rejected = new Map(), returnedHashes = new Map(), detach = [];
  const item = () => server.plan.transactions.find(tx => tx.id === selectedId);
  const entry = id => server.entries.find(saved => saved.id === id);
  const blocked = () => server.entries.some(saved => ['pending', 'submitted'].includes(saved.status) || locks.has(saved.id));
  const walletMatches = () => !!provider && connected && chainId === 1 && equalAddress(account, item()?.walletRequest.params[0].from);
  const canReview = () => !closed && !busy && !server.complete && entry(selectedId)?.status === 'ready' && !blocked() && walletMatches();
  const snapshot = () => ({
    plan: copy(server.plan), entries: copy(server.entries).map(saved => locks.has(saved.id) && saved.status === 'ready' ? { ...saved, status: 'pending', localUnknown: true } : saved),
    selectedId, walletName, account, chainId, connected, reviewed, busy, message,
    canReview: canReview(), canSend: reviewed && canReview(),
    canSwitchNetwork: !closed && !busy && !server.complete && !!provider && address(account) && chainId !== 1,
    canVerify: !closed && !busy && !server.complete && server.readyToVerify === true,
    complete: server.complete === true, readyToVerify: server.readyToVerify === true,
    manifest: copy(server.manifest ?? null), directoryPins: copy(server.directoryPins ?? null),
    evidenceDirectory: server.evidenceDirectory, stageNumber: server.stageNumber,
    hashes: [...returnedHashes].map(([id, hash]) => ({ id, hash })),
  });
  const publish = text => { if (text !== undefined) message = text; try { onChange(snapshot()); } catch { /* UI observers cannot alter the send gate. */ } };
  const idle = () => { if (closed) throw new Error('The wallet review has been closed.'); if (busy) throw new Error('Another wallet or journal operation is pending.'); };
  const apply = next => {
    const previousPlan = stable(server.plan);
    server = validateENSWalletState(next);
    for (const saved of server.entries) {
      if (saved.hash) returnedHashes.set(saved.id, saved.hash);
      if (saved.status === 'confirmed' || saved.status === 'ready' && rejected.has(saved.id)) { locks.delete(saved.id); rejected.delete(saved.id); }
    }
    if (stable(server.plan) !== previousPlan) { reviewed = false; selectedId = ''; revision++; }
  };
  const applyError = error => { if (error?.state) { try { apply(error.state); } catch { /* Preserve the last checked state and local locks. */ } } };
  const changed = () => { revision++; connected = false; reviewed = false; account = undefined; chainId = undefined; publish('Wallet account, chain or connection changed. Reconnect and review again. Existing submissions remain locked.'); };
  const call = async (name, extra = {}) => {
    const result = await action({ token: server.token, action: name, ...extra });
    if (result?.error) { const error = new Error(String(result.error)); error.state = result; throw error; }
    return result;
  };
  const observe = async (wallet, requestAccounts = false) => {
    const observedRevision = revision;
    const accounts = await wallet.request({ method: requestAccounts ? 'eth_requestAccounts' : 'eth_accounts' });
    if (closed || provider !== wallet || revision !== observedRevision) throw new Error('Wallet changed during the account/network check. Reconnect.');
    const chain = await wallet.request({ method: 'eth_chainId' });
    if (closed || provider !== wallet || revision !== observedRevision) throw new Error('Wallet changed during the account/network check. Reconnect.');
    account = Array.isArray(accounts) ? accounts[0] : undefined;
    chainId = typeof chain === 'string' && /^0x[\da-fA-F]+$/.test(chain) && BigInt(chain) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(BigInt(chain)) : undefined;
    publish();
    if (!address(account)) throw new Error('No public wallet account is connected.');
    if (chainId !== 1) throw new Error(`Wallet is on chain ${chainId ?? 'unknown'}. Use Switch to Ethereum mainnet, then review again.`);
    if (item() && !equalAddress(account, item().walletRequest.params[0].from)) throw new Error(`Select the reviewed sender ${item().walletRequest.params[0].from} in your wallet, then reconnect.`);
  };
  const recheck = async (wallet, expectedRevision, expectedRequest) => {
    await observe(wallet);
    if (closed || provider !== wallet || revision !== expectedRevision || !equalAddress(account, expectedRequest.params[0].from)) throw new Error('Wallet or review changed before submission. The pending entry stays locked.');
  };
  apply(server);
  return {
    state: snapshot,
    selectTransaction(id) { idle(); if (!server.plan.transactions.some(tx => tx.id === id)) throw new Error('Choose a transaction in the current stage.'); selectedId = id; reviewed = false; revision++; publish(); },
    selectWallet(wallet, name = 'Selected wallet') {
      idle();
      if (!wallet || typeof wallet.request !== 'function') throw new Error('No supported browser wallet is selected.');
      for (const remove of detach.splice(0)) remove();
      provider = wallet; walletName = String(name).slice(0, 120); changed();
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
        try { wallet.on?.(event, changed); detach.push(() => { try { wallet.removeListener?.(event, changed); } catch {} }); } catch { /* Every send independently checks account and chain. */ }
      }
    },
    setReviewed(value) { revision++; reviewed = value === true && canReview(); publish(); },
    async connect() {
      idle(); if (!provider) throw new Error('Choose a wallet extension, then click Connect.');
      const wallet = provider; busy = true; reviewed = false; publish('Open the selected wallet to connect its public account…');
      try { await observe(wallet, true); connected = true; publish('Wallet connected on Ethereum mainnet. Review the selected transaction before sending.'); }
      catch (error) { connected = false; publish(errorText(error)); throw error; }
      finally { busy = false; publish(); }
    },
    async switchNetwork() {
      idle(); if (!provider) throw new Error('Choose and connect a wallet first.');
      const wallet = provider; busy = true; reviewed = false; publish('Confirm switching to Ethereum mainnet in your wallet. No transaction is sent by this action.');
      try {
        await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
        await observe(wallet); connected = true; publish('Ethereum mainnet confirmed. Review the transaction again before sending.');
      } catch (error) { connected = false; publish(errorText(error)); throw error; }
      finally { busy = false; publish(); }
    },
    async send() {
      idle(); if (!reviewed || !canReview()) throw new Error('Select a ready transaction, connect its mainnet sender, and tick the review checkbox first.');
      const tx = copy(item()), id = tx.id, wallet = provider, expectedRevision = revision, expectedPlan = stable(server.plan);
      const expectedRequest = validateENSWalletRequest(tx.walletRequest);
      let began = false;
      busy = true; publish('Rechecking the sender and Ethereum mainnet before reserving this transaction…');
      try {
        await recheck(wallet, expectedRevision, expectedRequest);
        locks.add(id); rejected.delete(id); began = true;
        publish('Reserving this transaction in the saved journal before opening your wallet…');
        const response = await call('begin', { id });
        apply(response);
        const permit = response.permit;
        if (stable(server.plan) !== expectedPlan || entry(id)?.status !== 'pending' || permit?.id !== id ||
            typeof permit.reservationId !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(permit.reservationId) || entry(id).reservation !== permit.reservationId ||
            stable(validateENSWalletRequest(permit?.walletRequest)) !== stable(expectedRequest) ||
            !Number.isSafeInteger(permit.expiresAt) || permit.expiresAt <= now()) throw new Error('The send permit is stale or differs from the reviewed transaction. No wallet send was requested; the reservation stays locked.');
        await recheck(wallet, expectedRevision, expectedRequest);
        if (permit.expiresAt <= now()) throw new Error('The send permit expired during the wallet checks. No wallet send was requested; the reservation stays locked.');
        publish('Review this one transaction in your wallet. It transfers zero ETH; Ethereum mainnet gas costs real ETH.');
        let hash;
        try { hash = await wallet.request(copy(expectedRequest)); }
        catch (error) {
          if (error?.code === 4001) {
            rejected.set(id, permit.reservationId);
            try { apply(await call('rejected', { id, reservationId: permit.reservationId })); } catch (releaseError) { applyError(releaseError); }
            throw new Error(locks.has(id) ? 'The wallet explicitly rejected the request, but the saved journal has not confirmed releasing it. Refresh saved status before continuing.' : 'You rejected the wallet transaction. Reconnect/review before trying again.');
          }
          throw error;
        }
        if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('The wallet returned no valid transaction hash. Check wallet history and paste the hash below; this entry remains locked.');
        returnedHashes.set(id, hash); reviewed = false;
        publish(`Wallet returned ${hash}. Saving this hash; a hash alone is not a ${operation()} receipt.`);
        try { apply(await call('record', { id, hash })); }
        catch (error) { applyError(error); throw new Error(`Wallet returned ${hash}, but saving/checking it failed: ${errorText(error)} Copy this hash and use Reconcile hash. Do not send again.`); }
        publish(`Recorded ${hash}. Use Refresh receipts / next stage to check confirmations. No next transaction will be sent automatically.`);
        return hash;
      } catch (error) {
        applyError(error); reviewed = false; connected = false;
        publish(`${errorText(error)}${began && locks.has(id) && !returnedHashes.has(id) && !rejected.has(id) ? ' The reserved transaction remains locked; inspect wallet history and reconcile its hash.' : ''}`);
        throw error;
      } finally { busy = false; reviewed = false; publish(); }
    },
    async reconcile(id, hash) {
      idle();
      if (!HASH.test(hash ?? '') || !entry(id) || !(['pending', 'submitted'].includes(entry(id).status) || locks.has(id))) throw new Error('Choose a pending/submitted transaction and paste its 0x-prefixed 32-byte hash.');
      if (returnedHashes.has(id) && returnedHashes.get(id).toLowerCase() !== hash.toLowerCase()) throw new Error('A hash is already retained for this transaction. Reconcile that original hash first.');
      busy = true; reviewed = false; locks.add(id); returnedHashes.set(id, hash); publish(`Reconciling ${hash} against the saved transaction. No wallet request is made.`);
      try { apply(await call('record', { id, hash })); publish('Hash recorded. Refresh receipts to check confirmations and advance the stage.'); }
      catch (error) { applyError(error); publish(`Hash ${hash} remains visible, but reconciliation failed: ${errorText(error)}`); throw error; }
      finally { busy = false; publish(); }
    },
    async refresh() {
      idle(); busy = true; reviewed = false; revision++; publish('Checking saved receipts and preparing the next stage only if this stage is confirmed…');
      try {
        // Retry only an observed, explicit wallet rejection when the user asks to
        // refresh. A generic error/unknown result can never enter this set.
        for (const [id, reservationId] of [...rejected]) if (entry(id)?.status === 'pending' && !entry(id).hash) apply(await call('rejected', { id, reservationId }));
        apply(await call('refresh'));
        publish(server.complete ? `Saved ${operation()} verification rechecked. Finalized browser discovery remains separate.` : server.readyToVerify ? `All planned stages match the chain. Run final verification to create the ${operation()} manifest.` : 'Saved state refreshed. Select and review any next transaction yourself.');
      }
      catch (error) { applyError(error); publish(errorText(error)); throw error; }
      finally { busy = false; publish(); }
    },
    async verify() {
      idle(); if (server.readyToVerify !== true || server.complete) throw new Error('Wait until all stages are ready for final verification.');
      busy = true; reviewed = false; publish('Verifying receipts, runtime and permissions with the administrative RPC sources…');
      try {
        apply(await call('verify'));
        if (!server.complete || !server.manifest) throw new Error(`The transaction checks have not completed ${operation()} verification.`);
        const label = operation();
        publish(`${label[0].toUpperCase()}${label.slice(1)} evidence verified and saved. Finalized discovery through the browser verifier remains a separate check.`);
      } catch (error) { applyError(error); publish(errorText(error)); throw error; }
      finally { busy = false; publish(); }
    },
    close() { closed = true; revision++; reviewed = false; connected = false; for (const remove of detach.splice(0)) remove(); },
  };
}

/** Extension names are display-only; discovery does not call any wallet RPC. */
export function createENSWalletDiscovery(target, onChange = () => {}) {
  const wallets = [];
  const add = (provider, info) => {
    if (!provider || typeof provider.request !== 'function' || wallets.length >= 16) return;
    const existing = wallets.find(wallet => wallet.provider === provider);
    if (existing) { if (info) Object.assign(existing, info); return; }
    if (info && wallets.some(wallet => wallet.uuid === info.uuid)) return;
    wallets.push({ id: `wallet-${wallets.length + 1}`, provider, name: provider.isMetaMask ? 'MetaMask (browser provider)' : 'Browser wallet', rdns: '', ...info });
  };
  const announce = event => {
    try {
      const { info, provider } = event.detail ?? {};
      if (!info || typeof info.uuid !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(info.uuid) || typeof info.name !== 'string' || !info.name.trim() || typeof info.rdns !== 'string') return;
      add(provider, { uuid: info.uuid, name: info.name.trim().slice(0, 80), rdns: info.rdns.slice(0, 255) }); onChange(wallets.map(wallet => ({ ...wallet })));
    } catch { /* Ignore malformed extension announcements. */ }
  };
  const refresh = () => {
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    try { const legacy = target.ethereum; for (const provider of Array.isArray(legacy?.providers) ? legacy.providers.slice(0, 16) : [legacy]) add(provider); } catch {}
    onChange(wallets.map(wallet => ({ ...wallet })));
  };
  target.addEventListener('eip6963:announceProvider', announce); target.addEventListener('ethereum#initialized', refresh); refresh();
  return { refresh, list: () => wallets.map(wallet => ({ ...wallet })), close() { target.removeEventListener('eip6963:announceProvider', announce); target.removeEventListener('ethereum#initialized', refresh); } };
}

/** Render into a supplied root. No inline handlers, external images, extension icons or HTML interpolation. */
export async function boot(root, { fetch: fetcher = globalThis.fetch.bind(globalThis), target = globalThis.window } = {}) {
  if (!root?.ownerDocument || !target) throw new Error('A browser root element is required.');
  const document = root.ownerDocument;
  const el = (tag, text, parent = root) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  const button = (id, text, parent = root) => { const node = el('button', text, parent); node.type = 'button'; node.id = id; return node; };
  const details = (title, parent = root) => { const section = el('details', undefined, parent); el('summary', title, section); return el('pre', '', section); };
  const labelled = (id, title, tag, parent = root) => { const label = el('label', title, parent); label.htmlFor = id; const node = el(tag, undefined, parent); node.id = id; return node; };
  root.replaceChildren();
  const heading = el('h1', 'ENS deployment · Ethereum mainnet');
  const flowDescription = el('p', ''); flowDescription.hidden = true;
  el('p', 'Each transaction transfers zero ETH. Mainnet gas fees use real ETH. Review every sender, destination, role and calldata in your wallet. This page never asks for a private key.');
  const stage = el('p', 'Loading the saved deployment…');
  const names = el('p', '');
  const status = el('p', ''); status.id = 'ens-message'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const refresh = button('ens-refresh', 'Refresh receipts / next stage');
  const verify = button('ens-verify', 'Verify final deployment'); verify.disabled = true;
  const verificationDescription = el('p', 'Final deployment verification requires 12 confirmations. Refresh manually to check mined receipts and prepare the next stage. A finalized browser discovery check is separate from these administrative receipt checks.');
  const evidence = el('p', '');
  const config = details('Exact public configuration and operator names');
  const roles = details('Exact role grants');
  const fullPlan = details('Complete reviewed stage, including gas estimates and source hash');
  const walletSection = el('section'); el('h2', 'Choose the signing wallet', walletSection);
  el('p', 'Wallet names are supplied by extensions. Choose the intended wallet and account.', walletSection);
  const walletSelect = labelled('ens-wallet-select', 'Wallet extension', 'select', walletSection);
  const detect = button('ens-detect', 'Detect wallets', walletSection);
  const connect = button('ens-connect', 'Connect selected wallet', walletSection);
  const switchNetwork = button('ens-switch', 'Switch to Ethereum mainnet', walletSection);
  connect.disabled = switchNetwork.disabled = true;
  const walletStatus = el('p', 'Not connected.', walletSection);
  const txSection = el('section'); el('h2', 'Transactions in this stage', txSection); const transactions = el('div', '', txSection);
  const reviewSection = el('section'); const chosen = el('h2', 'Select one transaction', reviewSection); chosen.tabIndex = -1;
  const summary = el('dl', '', reviewSection);
  const request = details('Exact wallet request and calldata', reviewSection);
  const reviewLabel = el('label', undefined, reviewSection);
  const review = el('input', undefined, reviewLabel); review.id = 'ens-review'; review.type = 'checkbox'; review.disabled = true;
  reviewLabel.append(document.createTextNode(' I reviewed this transaction, its exact sender, Ethereum mainnet, destination, calldata, role grants, zero transferred ETH and real ETH gas fees.'));
  const send = button('ens-send', 'Send this transaction in wallet', reviewSection); send.disabled = true;
  const recovery = el('section'); el('h2', 'Transaction hashes and recovery', recovery);
  el('p', 'A returned hash is not a verified receipt. Pending or unknown results stay locked. Check your wallet history and reconcile its original hash; do not submit the transaction again.', recovery);
  const hashes = el('pre', '', recovery); hashes.id = 'ens-hashes';
  const hashInput = labelled('ens-reconcile-hash', 'Hash for the selected pending transaction', 'input', recovery); hashInput.type = 'text'; hashInput.autocomplete = 'off'; hashInput.spellcheck = false;
  const reconcile = button('ens-reconcile', 'Reconcile hash', recovery);
  reconcile.disabled = true; hashInput.disabled = true;
  const completed = el('section'); const completeStatus = el('p', '', completed);
  const manifest = details('Verified deployment manifest', completed), pins = details('Directory pins from verified deployment', completed);
  let controller, discovery, wallets = [], selectedWalletId = '', boundProvider, loading = false;
  const showError = error => { status.textContent = errorText(error); };
  const perform = fn => void Promise.resolve().then(fn).catch(showError);
  const readJson = async (path, options = {}) => {
    const response = await fetcher(path, { cache: 'no-store', credentials: 'omit', redirect: 'error', ...options });
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Local deployment response is too large.');
    let value; try { value = JSON.parse(text); } catch { throw new Error('The local deployment server returned no readable state.'); }
    if (!response.ok) { const error = new Error(typeof value.error === 'string' ? value.error : `Local server refused the request (${response.status}).`); error.state = value; throw error; }
    return value;
  };
  const render = state => {
    const joining = state.plan.flow === 'operator-join';
    const operation = joining ? 'operator registration' : 'deployment';
    heading.textContent = joining ? 'ENS operator registration · Ethereum mainnet' : 'ENS deployment · Ethereum mainnet';
    flowDescription.hidden = !joining;
    flowDescription.textContent = joining ? 'Open registration: this operator signs its own transactions after the namespace owner completes the one-time setup. No per-name owner approval or approval bot is used. This page reviews the supplied plan; it does not establish that the public website uses this registrar.' : '';
    verify.textContent = joining ? 'Verify operator registration' : 'Verify final deployment';
    verificationDescription.textContent = `Final ${operation} verification requires 12 confirmations. Refresh manually to check mined receipts and prepare the next stage. A finalized browser discovery check is separate from these administrative receipt checks.`;
    stage.textContent = `${state.complete ? `Verified ${operation}` : state.readyToVerify ? 'Ready for final verification' : 'Review stage'} ${state.stageNumber ?? ''}: ${state.plan.stage}`;
    names.textContent = `Operator names: ${state.plan.resumeConfig.operators.map(op => `${op.label}.derpc.eth`).join(', ')}`;
    status.textContent = state.message; evidence.textContent = state.evidenceDirectory ? `Saved local evidence: ${state.evidenceDirectory}` : '';
    config.textContent = JSON.stringify(state.plan.resumeConfig, null, 2); roles.textContent = JSON.stringify(state.plan.roleTable, null, 2); fullPlan.textContent = JSON.stringify(state.plan, null, 2);
    walletSelect.disabled = detect.disabled = connect.disabled = state.busy || state.complete;
    connect.disabled ||= !wallets.length; switchNetwork.disabled = !state.canSwitchNetwork;
    refresh.disabled = state.busy; verify.disabled = !state.canVerify;
    walletStatus.textContent = `${state.walletName || 'No wallet selected'} · account ${state.account ?? 'not connected'} · chain ${state.chainId ?? 'unknown'}`;
    transactions.replaceChildren();
    if (!state.plan.transactions.length) el('p', 'No further transaction is planned. Use final verification when available.', transactions);
    for (const tx of state.plan.transactions) {
      const saved = state.entries.find(entry => entry.id === tx.id);
      const row = el('section', undefined, transactions);
      el('h3', `${tx.id} · ${saved?.status ?? 'unknown'}`, row); el('p', tx.purpose, row);
      el('p', `Sender: ${tx.walletRequest.params[0].from} · estimated gas: ${tx.estimatedGas ?? 'not supplied'}`, row);
      if (saved?.hash) el('p', `Hash: ${saved.hash}`, row);
      const choose = button('', state.selectedId === tx.id ? 'Selected transaction' : 'Review this transaction', row); choose.dataset.transactionId = tx.id; choose.disabled = state.busy || state.complete;
      choose.addEventListener('click', () => { try { controller.selectTransaction(tx.id); chosen.focus(); } catch (error) { showError(error); } });
    }
    const tx = state.plan.transactions.find(tx => tx.id === state.selectedId);
    chosen.textContent = tx ? `${tx.id}: ${tx.purpose}` : 'Select one transaction'; summary.replaceChildren(); request.textContent = tx ? JSON.stringify(tx.walletRequest, null, 2) : 'No transaction selected.';
    if (tx) for (const [label, value] of [['Sender', tx.walletRequest.params[0].from], ['Destination', tx.walletRequest.params[0].to ?? 'Contract creation'], ['Network', 'Ethereum mainnet · chain 1'], ['Transferred ETH', '0 ETH; gas costs real ETH'], ['Estimated gas units', tx.estimatedGas ?? 'Not supplied'], ['Nonce', tx.walletRequest.params[0].nonce ?? 'Assigned by the wallet']]) { el('dt', label, summary); el('dd', value, summary); }
    review.checked = state.reviewed; review.disabled = !state.canReview; send.disabled = !state.canSend;
    hashes.textContent = state.hashes.length ? state.hashes.map(item => `${item.id}\n${item.hash}`).join('\n\n') : 'No transaction hash returned or reconciled in this view.';
    const saved = state.entries.find(entry => entry.id === state.selectedId);
    reconcile.disabled = state.busy || !saved || !['pending', 'submitted'].includes(saved.status); hashInput.disabled = reconcile.disabled;
    completeStatus.textContent = state.complete ? `Final ${operation} manifest verified and saved. This administrative check does not replace finalized discovery in the DeRPC browser.` : `${joining ? 'Operator registration' : 'Deployment'} is not yet fully verified.`;
    manifest.parentElement.querySelector('summary').textContent = `Verified ${operation} manifest`;
    pins.parentElement.querySelector('summary').textContent = joining ? 'Directory pins checked with this registration' : 'Directory pins from verified deployment';
    manifest.textContent = state.manifest ? JSON.stringify(state.manifest, null, 2) : 'No verified manifest yet.'; pins.textContent = state.directoryPins ? JSON.stringify(state.directoryPins, null, 2) : 'No verified directory pins yet.';
  };
  const load = async () => {
    if (loading) throw new Error('The saved deployment state is still loading.');
    loading = true;
    try {
      const initialState = await readJson('/state');
      controller?.close();
      controller = createENSWalletController({ initialState, action: body => readJson('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }), onChange: render });
      boundProvider = undefined;
      if (wallets.length) bindWallet(); else render(controller.state());
    } finally { loading = false; }
  };
  const bindWallet = () => {
    if (!controller || controller.state().busy) return;
    const wallet = wallets.find(entry => entry.id === selectedWalletId);
    if (wallet && wallet.provider !== boundProvider) { controller.selectWallet(wallet.provider, wallet.name); boundProvider = wallet.provider; }
    else render(controller.state());
  };
  const walletList = list => {
    wallets = list;
    if (!wallets.some(wallet => wallet.id === selectedWalletId)) selectedWalletId = wallets[0]?.id ?? '';
    walletSelect.replaceChildren();
    if (!wallets.length) { const option = el('option', 'No wallet detected — open this page in your wallet-enabled browser profile', walletSelect); option.value = ''; }
    for (const wallet of wallets) { const option = el('option', `${wallet.name}${wallet.rdns ? ` (${wallet.rdns})` : ''}`, walletSelect); option.value = wallet.id; }
    walletSelect.value = selectedWalletId; bindWallet();
  };
  walletSelect.addEventListener('change', () => { selectedWalletId = walletSelect.value; try { bindWallet(); } catch (error) { showError(error); } });
  detect.addEventListener('click', () => discovery.refresh()); connect.addEventListener('click', () => perform(() => controller.connect()));
  switchNetwork.addEventListener('click', () => perform(() => controller.switchNetwork())); review.addEventListener('change', () => controller?.setReviewed(review.checked));
  send.addEventListener('click', () => perform(() => controller.send()));
  refresh.addEventListener('click', () => perform(() => controller ? controller.refresh() : load())); verify.addEventListener('click', () => perform(() => controller.verify()));
  reconcile.addEventListener('click', () => perform(() => controller.reconcile(controller.state().selectedId, hashInput.value.trim())));
  discovery = createENSWalletDiscovery(target, walletList);
  try { await load(); } catch (error) { showError(error); connect.disabled = switchNetwork.disabled = send.disabled = reconcile.disabled = true; }
  const close = () => { controller?.close(); discovery.close(); };
  target.addEventListener('pagehide', close, { once: true });
  return { controller: () => controller, close() { target.removeEventListener('pagehide', close); close(); } };
}
