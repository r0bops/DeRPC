/** Browser-only controller. No key/signature reaches the local review server. */
export function validateWalletReview(plan) {
  const chains = new Map([[560048, 'Hoodi'], [11155111, 'Sepolia']]);
  const tx = plan?.walletRequest?.params?.[0];
  const hash = value => typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value);
  if (plan?.schemaVersion !== 1 || plan.kind !== 'derpc-query-escrow-deployment-plan' || plan.testPayments !== true || plan.localOnly !== false || !chains.has(plan.chainId) || plan.name !== chains.get(plan.chainId)) throw new Error('Expected a checked Hoodi or Sepolia deployment plan.');
  if (!hash(plan.sourceHash) || !hash(plan.codeHash) || !hash(plan.creationCodeHash)) throw new Error('Deployment hashes are missing.');
  if (plan.walletRequest?.method !== 'eth_sendTransaction' || plan.walletRequest.params.length !== 1 || !tx || Object.keys(tx).sort().join(',') !== 'chainId,data,from,value') throw new Error('Only this contract-creation request is allowed.');
  if (typeof tx.from !== 'string' || !/^0x[\da-fA-F]{40}$/.test(tx.from) || /^0x0{40}$/i.test(tx.from) || tx.value !== '0x0' || tx.chainId !== `0x${plan.chainId.toString(16)}` || typeof tx.data !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(tx.data) || tx.data.length > 100000) throw new Error('Invalid sender, network, value or creation bytecode.');
  return Object.freeze({ from: tx.from, chainId: tx.chainId, value: '0x0', data: tx.data });
}

export function createDeploymentSubmissionStore({ plan, storage }) {
  const transaction = validateWalletReview(plan);
  const key = `derpc:deployment:${plan.chainId}:${transaction.from.toLowerCase()}:${plan.creationCodeHash}`;
  return {
    read: () => storage.getItem(key),
    markPending: () => storage.setItem(key, 'unknown'),
    markSubmitted: hash => storage.setItem(key, hash),
    clearRejected: () => storage.removeItem(key),
  };
}

// EIP-6963 discovery makes no account, network or signing request. Wallet metadata
// is only a display hint; never render its HTML/icons or treat it as authentication.
export function createWalletDiscovery({ target, onChange = () => {} }) {
  const entries = [];
  const list = () => entries.map(entry => ({ ...entry }));
  const add = (provider, info) => {
    if (!provider || typeof provider.request !== 'function') return;
    const existing = entries.find(entry => entry.provider === provider);
    if (existing) {
      if (info && !existing.announced) Object.assign(existing, info, { announced: true });
      return;
    }
    if (entries.length >= 16 || info && entries.some(entry => entry.uuid === info.uuid)) return;
    entries.push({ id: `wallet-${entries.length + 1}`, provider, name: provider.isMetaMask ? 'MetaMask (browser provider)' : 'Browser wallet', rdns: '', ...info, announced: !!info });
  };
  const announce = event => {
    try {
      const { info, provider } = event.detail ?? {};
      if (!info || typeof info.uuid !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(info.uuid) || typeof info.name !== 'string' || !info.name.trim() || typeof info.rdns !== 'string') return;
      add(provider, { uuid: info.uuid, name: info.name.trim().slice(0, 80), rdns: info.rdns.slice(0, 255) });
      onChange(list());
    } catch { /* Ignore malformed announcements from another extension. */ }
  };
  const refresh = () => {
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    const legacy = target.ethereum;
    for (const provider of Array.isArray(legacy?.providers) ? legacy.providers.slice(0, 16) : [legacy]) add(provider);
    onChange(list());
  };
  target.addEventListener('eip6963:announceProvider', announce);
  target.addEventListener('ethereum#initialized', refresh);
  refresh();
  return {
    list, refresh,
    close() {
      target.removeEventListener('eip6963:announceProvider', announce);
      target.removeEventListener('ethereum#initialized', refresh);
    },
  };
}

export function walletErrorMessage(error) {
  if (error?.code === -32002) return 'A wallet request is already pending. Open the MetaMask extension and finish or cancel that request, then reconnect here.';
  if (error?.code === 4001) return 'You declined the wallet request. Connect again when you are ready.';
  return typeof error?.message === 'string' ? error.message : 'The wallet request failed. Open your wallet to check its status.';
}

export function walletNetworkParameters(plan) {
  const transaction = validateWalletReview(plan);
  // Fixed testnet metadata, never an RPC URL supplied by the plan or an extension.
  return {
    chainId: transaction.chainId, chainName: plan.name,
    nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [plan.chainId === 560048 ? 'https://rpc.hoodi.ethpandaops.io' : 'https://ethereum-sepolia-rpc.publicnode.com'],
    blockExplorerUrls: [plan.chainId === 560048 ? 'https://hoodi.etherscan.io' : 'https://sepolia.etherscan.io'],
  };
}

export function createWalletDeploymentController({ plan, ethereum, getEthereum, onState = () => {}, submittedTransactionHash, submissionUnknown = false, submissionStore }) {
  const transaction = validateWalletReview(plan);
  const stored = submissionStore?.read();
  if (stored) {
    submittedTransactionHash = stored;
    submissionUnknown = true;
  }
  const initialHash = typeof submittedTransactionHash === 'string' && /^0x[\da-fA-F]{64}$/.test(submittedTransactionHash) ? submittedTransactionHash : undefined;
  let revision = 0;
  let state = {
    phase: initialHash ? 'submitted-unverified' : submissionUnknown ? 'submission-unknown' : 'not-deployed',
    message: initialHash ? 'A transaction was already submitted in this tab. Run the receipt verifier before using its address.' : submissionUnknown ? 'An earlier wallet submission has an unknown result. Check wallet history before making a new deployment plan.' : 'Plan checked locally. Connect the intended wallet and review before deploying.',
    busy: false, connected: false, reviewed: false, account: undefined, chainId: undefined,
    transactionHash: initialHash,
  };
  const snapshot = () => ({
    ...state,
    canSend: !!ethereum && state.phase === 'not-deployed' && state.connected && state.reviewed && !state.busy && !state.transactionHash,
    canSwitchNetwork: !!ethereum && state.phase === 'not-deployed' && !state.busy && !state.transactionHash &&
      typeof state.account === 'string' && state.account.toLowerCase() === transaction.from.toLowerCase() &&
      state.chainId !== undefined && state.chainId !== plan.chainId,
  });
  const publish = patch => { state = { ...state, ...patch }; onState(snapshot()); };
  const available = (requireProvider = true) => {
    if (state.busy) throw new Error('A wallet request is already pending.');
    if (state.transactionHash) throw new Error('This plan has already been submitted in this tab. Verify its receipt first.');
    if (state.phase === 'submission-unknown') throw new Error('The previous wallet submission has an unknown result. Check wallet history before making a new deployment plan.');
    if (requireProvider && (!ethereum || typeof ethereum.request !== 'function')) throw new Error('No wallet detected in this browser. Open this URL in the browser profile where MetaMask is installed, enable its access to this site, then click Detect wallets and Connect. An embedded preview may not have wallet extensions.');
  };
  const observedWallet = async requestAccounts => {
    const accounts = await ethereum.request({ method: requestAccounts ? 'eth_requestAccounts' : 'eth_accounts' });
    const chain = await ethereum.request({ method: 'eth_chainId' });
    const account = Array.isArray(accounts) ? accounts[0] : undefined;
    const validChain = typeof chain === 'string' && /^0x[\da-fA-F]+$/.test(chain);
    publish({ account, chainId: validChain ? Number(BigInt(chain)) : undefined });
    if (typeof account !== 'string' || account.toLowerCase() !== transaction.from.toLowerCase()) throw new Error('The selected wallet account does not match the reviewed sender.');
    if (!validChain || BigInt(chain) !== BigInt(transaction.chainId)) throw new Error(`The wallet is on chain ${state.chainId ?? 'unknown'}. Switch to ${plan.name} (chain ${plan.chainId}) to enable the review checkbox.`);
  };
  const changed = () => {
    revision++;
    publish({ connected: false, reviewed: false, account: undefined, chainId: undefined, message: state.transactionHash ? 'Submitted transaction remains unverified. Check its receipt.' : 'Wallet account or network changed. Reconnect and review again.' });
  };
  ethereum?.on?.('accountsChanged', changed);
  ethereum?.on?.('chainChanged', changed);
  ethereum?.on?.('disconnect', changed);
  const detach = () => {
    ethereum?.removeListener?.('accountsChanged', changed);
    ethereum?.removeListener?.('chainChanged', changed);
    ethereum?.removeListener?.('disconnect', changed);
  };
  const report = error => publish({ message: walletErrorMessage(error) });
  onState(snapshot());

  return {
    state: snapshot,
    resetConnection() {
      if (state.busy) throw new Error('A wallet request is already pending.');
      changed();
    },
    async connect() {
      // Early errors must be visible without clearing a pending/unknown submission.
      try {
        available(false);
        if (getEthereum) {
          const selected = getEthereum();
          if (selected !== ethereum) {
            detach();
            ethereum = selected;
            ethereum?.on?.('accountsChanged', changed);
            ethereum?.on?.('chainChanged', changed);
            ethereum?.on?.('disconnect', changed);
          }
        }
        available();
      } catch (error) { report(error); throw error; }
      publish({ busy: true, connected: false, reviewed: false, message: 'Waiting for wallet connection… Open the selected wallet extension to unlock it and approve the connection.' });
      try {
        await observedWallet(true);
        publish({ connected: true, message: 'Wallet account and testnet match. Review the transaction details before deploying.' });
      } catch (error) {
        publish({ connected: false, message: walletErrorMessage(error) });
        throw error;
      } finally { publish({ busy: false }); }
    },
    setReviewed(reviewed) {
      publish({ reviewed: reviewed === true && state.connected && !state.busy && !state.transactionHash });
    },
    async switchNetwork() {
      try {
        available();
        if (!snapshot().canSwitchNetwork) throw new Error('Connect the reviewed account first. The switch button is available when its network needs changing.');
      } catch (error) { report(error); throw error; }
      publish({ busy: true, connected: false, reviewed: false, message: `Approve the switch to ${plan.name} in your wallet. This does not deploy the contract.` });
      try {
        const request = { method: 'wallet_switchEthereumChain', params: [{ chainId: transaction.chainId }] };
        try {
          await ethereum.request(request);
        } catch (error) {
          if (error?.code !== 4902) throw error;
          publish({ message: `${plan.name} is not added to this wallet. Review its testnet details in the wallet, then approve adding and switching networks.` });
          await ethereum.request({ method: 'wallet_addEthereumChain', params: [walletNetworkParameters(plan)] });
          await ethereum.request(request);
        }
        // A resolved switch request is not evidence of the active chain or account.
        // Read both again; signing still needs a separate review and Send action.
        await observedWallet(false);
        publish({ connected: true, message: `Connected to ${plan.name} (chain ${plan.chainId}) with the reviewed account. You can now tick the review checkbox.` });
      } catch (error) {
        publish({ connected: false, reviewed: false, message: walletErrorMessage(error) });
        throw error;
      } finally { publish({ busy: false }); }
    },
    async send() {
      try {
        available();
        if (!state.connected || !state.reviewed) throw new Error('Connect the reviewed account and confirm your review first.');
      } catch (error) { report(error); throw error; }
      const before = revision;
      let submissionRequested = false;
      publish({ busy: true, message: 'Rechecking wallet account and testnet…' });
      try {
        await observedWallet(false);
        if (revision !== before) throw new Error('Wallet account or network changed during the check. Reconnect before sending.');
        // Persist before asking the wallet: a reload or lost response must not permit
        // a second deployment. If storage is unavailable, no request is sent.
        submissionStore?.markPending();
        publish({ phase: 'submission-pending', message: 'Review the deployment in your wallet. It uses test ETH for gas and transfers zero ETH.' });
        // Explicit UI action only. Pin sender and chain in addition to the checks above.
        submissionRequested = true;
        const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{ ...transaction }] });
        if (typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash)) throw new Error('The wallet returned no valid transaction hash. Check wallet history before retrying.');
        try { submissionStore?.markSubmitted(hash); } catch { /* The pending marker still blocks a reload. Display/export the returned hash. */ }
        publish({ phase: 'submitted-unverified', transactionHash: hash, reviewed: false, connected: false, message: 'Transaction submitted. Its receipt and deployed runtime have NOT been verified. Export the hash and run payment-deploy.mjs verify.' });
        return hash;
      } catch (error) {
        let rejected = submissionRequested && error?.code === 4001;
        if (rejected) {
          try { submissionStore?.clearRejected(); } catch { rejected = false; }
        }
        publish({ phase: submissionRequested && !rejected ? 'submission-unknown' : 'not-deployed', connected: false, reviewed: false, message: walletErrorMessage(error) });
        throw error;
      } finally { publish({ busy: false }); }
    },
    close: detach,
  };
}

async function mount() {
  const element = id => document.getElementById(id);
  const show = (id, value) => { element(id).textContent = String(value); };
  let controller, plan, discovery, selectedWallet = '', selectionLocked = false;
  try {
    const response = await fetch('/plan.json', { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 131072) throw new Error('The local checked plan is unavailable.');
    plan = await response.json();
    const tx = validateWalletReview(plan);
    show('network', `${plan.name} · chain ${plan.chainId}`);
    show('switch-network', `Switch to ${plan.name}`);
    show('network-details', `Required network: ${plan.name} · chain ${plan.chainId}. If it needs adding, the wallet will show RPC ${walletNetworkParameters(plan).rpcUrls[0]} and test ETH as its currency.`);
    show('sender', tx.from);
    show('source', plan.sourceHash);
    show('runtime', plan.codeHash);
    show('creation', plan.creationCodeHash);
    show('compiler', `${plan.compiler.version}; ${plan.compiler.evmVersion}; optimizer runs ${plan.compiler.optimizerRuns}`);
    show('created', plan.createdAt);
    show('bytecode', tx.data);
    show('preflight', plan.preflight ? JSON.stringify(plan.preflight, null, 2) : 'No RPC preflight was saved. The wallet must estimate gas and confirm sufficient test ETH.');
    controller = createWalletDeploymentController({
      plan, getEthereum: () => discovery.list().find(entry => entry.id === selectedWallet)?.provider,
      submissionStore: createDeploymentSubmissionStore({ plan, storage: sessionStorage }),
      onState: state => {
        show('status', state.phase === 'not-deployed' ? 'Not deployed by this helper' : state.phase === 'submission-pending' ? 'Wallet submission pending — do not retry' : state.phase === 'submission-unknown' ? 'Submission outcome unknown — check wallet history' : 'Submitted — receipt unverified');
        show('message', state.message);
        show('connection-message', state.message);
        show('wallet', state.account ? `${state.account} · chain ${state.chainId ?? 'unknown'}` : 'Not connected');
        element('connect').disabled = state.busy || !!state.transactionHash || state.phase === 'submission-unknown';
        element('wallet-select').disabled = state.busy || !!state.transactionHash || state.phase === 'submission-unknown';
        element('detect').disabled = state.busy || !!state.transactionHash || state.phase === 'submission-unknown';
        element('switch-network').disabled = !state.canSwitchNetwork;
        element('review').disabled = !state.connected || state.busy || !!state.transactionHash;
        element('review').checked = state.reviewed;
        element('send').disabled = !state.canSend;
        element('export').disabled = !state.transactionHash;
        show('transaction-hash', state.transactionHash ?? (state.phase === 'submission-unknown' || state.phase === 'submission-pending' ? 'No transaction hash received. Check the wallet before retrying.' : 'No transaction submitted.'));
        if (state.transactionHash) {
          show('verify-command', `node contracts/scripts/payment-deploy.mjs verify --plan <reviewed-plan.json> --tx ${state.transactionHash} --rpc <testnet-rpc-url> --out <deployment-manifest.json>`);
        }
      },
    });
    discovery = createWalletDiscovery({ target: window, onChange: entries => {
      if (!selectionLocked) selectedWallet = (entries.find(entry => entry.rdns === 'io.metamask') ?? entries[0])?.id ?? '';
      const select = element('wallet-select');
      select.replaceChildren();
      if (!entries.length) {
        const option = document.createElement('option'); option.value = ''; option.textContent = 'No wallet detected'; select.append(option);
      }
      for (const entry of entries) {
        const option = document.createElement('option');
        option.value = entry.id; option.textContent = entry.rdns ? `${entry.name} (${entry.rdns})` : entry.name;
        select.append(option);
      }
      select.value = selectedWallet;
      show('wallet-detection', entries.length ? 'Choose your wallet, then click Connect. Wallet names are supplied by the extensions.' : 'No wallet extension detected. Open this page in your normal browser with MetaMask enabled for this site, then click Detect wallets.');
    } });
    element('wallet-select').addEventListener('change', () => {
      selectionLocked = true; selectedWallet = element('wallet-select').value; controller.resetConnection();
    });
    element('detect').addEventListener('click', () => discovery.refresh());
    element('connect').addEventListener('click', () => {
      discovery.refresh(); selectionLocked = !!selectedWallet;
      void controller.connect().catch(error => show('message', walletErrorMessage(error)));
    });
    element('review').addEventListener('change', event => controller.setReviewed(event.currentTarget.checked));
    element('switch-network').addEventListener('click', () => { void controller.switchNetwork().catch(() => {}); });
    element('send').addEventListener('click', () => { void controller.send().catch(error => show('message', walletErrorMessage(error))); });
    element('export').addEventListener('click', () => {
      const transactionHash = controller.state().transactionHash;
      if (!transactionHash) return;
      const record = { schemaVersion: 1, kind: 'derpc-query-escrow-submission', status: 'submitted-unverified', testPayments: true, chainId: plan.chainId, from: tx.from, sourceHash: plan.sourceHash, codeHash: plan.codeHash, transactionHash };
      const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2) + '\n'], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `derpc-${plan.name.toLowerCase()}-deployment-submission.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    window.addEventListener('pagehide', () => { controller.close(); discovery.close(); }, { once: true });
  } catch (error) {
    show('status', 'Deployment unavailable');
    show('message', error instanceof Error ? error.message : 'The checked plan could not be loaded.');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') void mount();
