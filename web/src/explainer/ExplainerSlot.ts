// The landing mounts this into #explainer-mount.
// A Remotion player replaces the static diagram when web/src/explainer/ExplainerPlayer.tsx
// exports mountExplainerPlayer(root). That module should lazy-import React so the landing stays vanilla.

const playerModules = import.meta.glob("./ExplainerPlayer.tsx");

type PlayerModule = {
  mountExplainerPlayer?: (root: HTMLElement) => void | Promise<void>;
};

export function mountExplainerSlot(root: HTMLElement): void {
  const stage = document.createElement("div");
  stage.className = "explainer-stage";
  stage.dataset.explainerIsland = "static";
  root.append(stage);
  renderStaticFlow(stage);

  const load = playerModules["./ExplainerPlayer.tsx"];
  if (!load) return;

  void load()
    .then(async (mod) => {
      const mount = (mod as PlayerModule).mountExplainerPlayer;
      if (!mount) return;
      stage.dataset.explainerIsland = "player";
      stage.replaceChildren();
      await mount(stage);
    })
    .catch(() => {
      stage.dataset.explainerIsland = "static";
      renderStaticFlow(stage);
    });
}

function renderStaticFlow(stage: HTMLElement): void {
  stage.replaceChildren();
  stage.insertAdjacentHTML(
    "beforeend",
    `
      <svg class="route-diagram" viewBox="0 0 320 128" role="img" aria-labelledby="explainer-title explainer-desc">
        <title id="explainer-title">How a DeRPC read moves</title>
        <desc id="explainer-desc">The app sends the read through Anon-RPC to an operator in the pool. The host checks an EIP-1186 proof against the Lodestar light client before returning it.</desc>
        <path class="route-line route-line--dash" d="M50 46h48" />
        <path class="route-line" d="M134 46h48" />
        <path class="route-line" d="M218 46h46" />
        <circle class="route-node route-node--app" cx="32" cy="46" r="18" />
        <path d="M26 40h7l5 6-5 6h-7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" style="color:rgba(255,255,255,.65)" />
        <circle class="route-node" cx="116" cy="46" r="18" />
        <path d="M109 46h14M116 39v14" stroke="rgba(140,140,255,.9)" stroke-width="1.6" stroke-linecap="round" />
        <circle class="route-node" cx="200" cy="46" r="18" />
        <circle cx="194" cy="42" r="2.4" fill="rgba(140,140,255,.9)" />
        <circle cx="202" cy="42" r="2.4" fill="rgba(140,140,255,.9)" />
        <circle cx="198" cy="50" r="2.4" fill="rgba(140,140,255,.9)" />
        <circle class="route-node" cx="282" cy="46" r="18" />
        <rect class="route-check" x="272" y="36" width="20" height="20" rx="5" />
        <path class="route-check-mark" d="m277 46 3 3 6-7" />
        <text x="32" y="88" text-anchor="middle">Your app</text>
        <text x="116" y="88" text-anchor="middle">Anon-RPC</text>
        <text x="200" y="88" text-anchor="middle">Pool</text>
        <text x="282" y="88" text-anchor="middle">Proof</text>
      </svg>
      <ol class="explainer-steps">
        <li><span>01</span> The app calls createDeRPC. derpc.provider is the EIP-1193 provider, and derpcTransport wraps it for viem.</li>
        <li><span>02</span> The read leaves through the tor-js 0.4.4 worker in @anon-rpc/browser-harness 0.4.0. The endpoint sees a Tor exit, not the caller's IP.</li>
        <li><span>03</span> The pool tries the chosen priority 0 operators first, then priority 1. A bad proof excludes that endpoint for this session.</li>
        <li><span>04</span> The host checks the EIP-1186 eth_getProof answer against a Lodestar 1.43.0 light client. A missing route or proof fails the read. There is no direct RPC.</li>
      </ol>
    `,
  );
}
