export function asset(name: string): string {
  return import.meta.env.BASE_URL + name;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

const icons: Record<string, string> = {
  search:
    '<svg class="search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>',
  chevron:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  arrowLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  check:
    '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
};

export function icon(name: keyof typeof icons): string {
  return icons[name] ?? "";
}

export function logo(): string {
  return `<img src="${asset("derpc-lockup.svg")}" alt="DeRPC" width="152" height="36" />`;
}

// The demo sits under /demo/ in the release bundle and on the dev server (see vite.config.ts).
export function demoHref(): string {
  return "./demo/";
}

export function nav(active: "directory" | "operate" | null): string {
  const link = (href: string, label: string, key: "directory" | "operate") => {
    const current = active === key ? ' aria-current="page"' : "";
    return `<a class="nav__link" href="${href}"${current}>${label}</a>`;
  };

  return `
    <header class="nav">
      <div class="container nav__inner">
        <a class="nav__brand" href="#/" aria-label="DeRPC home">${logo()}</a>
        <nav class="nav__links" aria-label="Primary">
          ${link("#/directory", "Directory", "directory")}
          ${link("#/operate", "Run an operator", "operate")}
          <a class="nav__link" href="${escapeHtml(demoHref())}">Dashboard</a>
          <a class="nav__link" href="https://github.com/r0bops/DeRPC" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <span class="nav__spacer"></span>
        <span class="nav__badge"><span class="ok-dot" aria-hidden="true"></span>Hackathon build</span>
        <a class="btn btn--lime btn--small" href="${escapeHtml(demoHref())}">Open dashboard</a>
      </div>
    </header>
  `;
}

export function footer(): string {
  return `
    <footer class="footer">
      <div class="container footer__inner">
        <div class="footer__brand">
          <img src="${asset("derpc-lockup.svg")}" alt="DeRPC" width="152" height="36" />
          <p class="footer__desc">Private, verified RPC for Ethereum. Reads through an anonymity network, answers checked by a light client, no direct fallback.</p>
          <p class="footer__event">ETHGlobal Mumbai 2026 · Free alpha · Experimental</p>
        </div>
        <nav class="footer__links" aria-label="Footer">
          <a href="${escapeHtml(demoHref())}">Live dashboard</a>
          <a href="#/directory">Directory</a>
          <a href="#/operate">Run an operator</a>
          <a href="https://github.com/r0bops/DeRPC" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      </div>
    </footer>
  `;
}

export function avatarTone(name: string): string {
  const sum = [...name].reduce((total, char) => total + char.charCodeAt(0), 0);
  const tones = ["avatar--ink-lime", "avatar--lime-ink", "avatar--soft-ink", "avatar--ink-white"];
  return tones[sum % tones.length] ?? "avatar--ink-lime";
}

export function avatar(label: string, seed = label, large = false): string {
  const initials = label
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return `<span class="avatar ${avatarTone(seed)}${large ? " avatar--lg" : ""}" aria-hidden="true">${escapeHtml(initials)}</span>`;
}

export function networkAvatar(name: string, short: string, large = false): string {
  return `<span class="avatar ${avatarTone(name)}${large ? " avatar--lg" : ""}" aria-hidden="true">${escapeHtml(short)}</span>`;
}

export function verified(verifiedState: boolean, on = "Proofs on", off = "Proofs planned"): string {
  if (!verifiedState) {
    return `<span class="chip chip--planned">${off}</span>`;
  }
  return `<span class="verified"><span class="ok-dot" aria-hidden="true"></span>${on}</span>`;
}

export function chip(label: string, href?: string): string {
  if (href) {
    return `<a class="chip" href="${href}">${escapeHtml(label)}</a>`;
  }
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

export function scoreMarkup(score: number): string {
  const width = Math.max(0, Math.min(100, score));
  return `<span class="score" aria-label="Score ${score.toFixed(1)} out of 100"><span class="score__value">${score.toFixed(1)}</span><span class="score__bar" aria-hidden="true"><span style="width:${width}%"></span></span></span>`;
}

export function demoNote(): string {
  return `<p class="demo-note"><span class="demo-note__square" aria-hidden="true"></span><span>Free demo. Public bootstrap providers and ENS operator enrollment are shown separately. Current health observations appear in the dashboard; staking and pricing come later.</span></p>`;
}

export function copyButton(text: string): string {
  return `<button class="copy-btn" type="button" data-copy="${escapeHtml(text)}">${icon("copy")}<span data-copy-label>Copy</span></button>`;
}

export function snippet(label: string, code: string): string {
  return `
    <div class="snippet">
      <div class="snippet__head">
        <span class="snippet__label">${escapeHtml(label)}</span>
        ${copyButton(code)}
      </div>
      <pre><code>${escapeHtml(code)}</code></pre>
    </div>
  `;
}

export function codeCard(): string {
  return `
    <div class="code-card">
      <div class="code-card__header">
        <span class="code-card__dots" aria-hidden="true"><span class="code-card__dot"></span><span class="code-card__dot"></span><span class="code-card__dot"></span></span>
        <span class="code-card__file">client.ts</span>
        <span class="code-card__tag">API preview</span>
      </div>
      <div class="code-card__body">
        <pre class="code"><code><span class="tok-com">// private, verified reads (finalized only)</span>
<span class="tok-key">import</span> { createDeRPC, MAINNET_OPERATORS } <span class="tok-key">from</span> <span class="tok-str">"@derpc/provider"</span>
<span class="tok-key">import</span> { derpcTransport } <span class="tok-key">from</span> <span class="tok-str">"@derpc/provider/viem"</span>
<span class="tok-key">import</span> { createPublicClient } <span class="tok-key">from</span> <span class="tok-str">"viem"</span>
<span class="tok-key">import</span> { mainnet } <span class="tok-key">from</span> <span class="tok-str">"viem/chains"</span>

<span class="tok-key">const</span> derpc = <span class="tok-fn">createDeRPC</span>({
  operators: MAINNET_OPERATORS.<span class="tok-fn">filter</span>((o) => o.ens === <span class="tok-str">"drpc.derpc.eth"</span>),
})
<span class="tok-key">const</span> client = <span class="tok-fn">createPublicClient</span>({
  chain: mainnet,
  transport: <span class="tok-fn">derpcTransport</span>(derpc),
})

<span class="tok-key">await</span> client.<span class="tok-fn">getBalance</span>({
  address: <span class="tok-str">"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"</span>,
  blockTag: <span class="tok-str">"finalized"</span>,
})
<span class="tok-com">// proven at the verified finalized block, or it fails closed</span></code></pre>
      </div>
      <div class="code-card__diagram">${routeDiagram()}</div>
    </div>
  `;
}

export function routeDiagram(): string {
  return `
    <svg class="route-diagram" viewBox="0 0 600 270" role="img" aria-label="DeRPC architecture: private route to verified answer">
      <defs>
        <filter id="glow-p" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="6" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-l" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      <!-- YOUR APP -->
      <rect x="15" y="85" width="100" height="100" rx="10" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-dasharray="6 4"/>
      <polygon points="65,108 48,131 65,139 82,131" fill="rgba(100,80,255,0.15)" stroke="rgba(140,120,255,0.7)" stroke-width="1.2" stroke-linejoin="round"/>
      <polygon points="65,108 48,131 65,122" fill="rgba(140,120,255,0.3)"/>
      <polygon points="65,139 48,131 65,122 82,131" fill="rgba(100,80,255,0.1)"/>
      <text x="65" y="202" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="8.5" letter-spacing="0.08em">YOUR APP</text>

      <!-- Arrow YOUR APP → PRIVATE ROUTE -->
      <line x1="117" y1="135" x2="144" y2="135" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
      <path d="M140 131 L145 135 L140 139" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- PRIVATE ROUTE pill -->
      <rect x="148" y="100" width="170" height="70" rx="35" fill="rgba(90,50,220,0.35)" stroke="rgba(130,80,255,0.95)" stroke-width="1.5" filter="url(#glow-p)"/>
      <circle cx="208" cy="135" r="9" fill="rgba(100,60,220,0.6)" stroke="rgba(160,100,255,0.9)" stroke-width="1.5"/>
      <circle cx="233" cy="135" r="9" fill="rgba(100,60,220,0.6)" stroke="rgba(160,100,255,0.9)" stroke-width="1.5"/>
      <circle cx="258" cy="135" r="9" fill="rgba(100,60,220,0.6)" stroke="rgba(160,100,255,0.9)" stroke-width="1.5"/>
      <text x="233" y="193" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="8.5" letter-spacing="0.08em">PRIVATE ROUTE</text>

      <!-- Arrow PRIVATE ROUTE → OPERATOR active box (lime) -->
      <line x1="320" y1="135" x2="346" y2="135" stroke="#c8f63c" stroke-width="1.5"/>
      <path d="M342 131 L347 135 L342 139" fill="none" stroke="#c8f63c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- OPERATOR POOL label above -->
      <text x="404" y="78" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="8.5" letter-spacing="0.08em">OPERATOR POOL</text>

      <!-- Box top (inactive) -->
      <rect x="350" y="85" width="108" height="37" rx="6" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" stroke-width="1.2"/>
      <circle cx="367" cy="103" r="4" fill="rgba(140,140,255,0.4)"/>
      <rect x="376" y="99" width="42" height="2.5" rx="1.5" fill="rgba(255,255,255,0.14)"/>
      <rect x="376" y="105" width="28" height="2" rx="1" fill="rgba(255,255,255,0.08)"/>

      <!-- Box middle (active, lime) -->
      <rect x="350" y="117" width="108" height="37" rx="6" fill="rgba(200,246,60,0.07)" stroke="#c8f63c" stroke-width="1.5" filter="url(#glow-l)"/>
      <circle cx="367" cy="135" r="4" fill="#c8f63c"/>
      <rect x="376" y="131" width="42" height="2.5" rx="1.5" fill="rgba(200,246,60,0.6)"/>
      <rect x="376" y="137" width="28" height="2" rx="1" fill="rgba(200,246,60,0.35)"/>

      <!-- Box bottom (failed) -->
      <rect x="350" y="149" width="108" height="37" rx="6" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.08)" stroke-width="1.2"/>
      <circle cx="367" cy="167" r="4" fill="rgba(255,80,80,0.3)"/>
      <rect x="376" y="163" width="42" height="2.5" rx="1.5" fill="rgba(255,255,255,0.1)"/>
      <rect x="376" y="169" width="28" height="2" rx="1" fill="rgba(255,255,255,0.07)"/>
      <!-- Red X badge -->
      <circle cx="450" cy="167" r="11" fill="rgba(220,55,55,0.9)"/>
      <path d="M444 161 L456 173 M456 161 L444 173" stroke="white" stroke-width="2" stroke-linecap="round"/>
      <!-- Invalid response label -->
      <line x1="450" y1="179" x2="450" y2="205" stroke="rgba(220,55,55,0.45)" stroke-width="1" stroke-dasharray="3 2"/>
      <text x="450" y="216" text-anchor="middle" fill="rgba(220,70,70,0.65)" font-size="8">Invalid response</text>
      <text x="450" y="227" text-anchor="middle" fill="rgba(220,70,70,0.65)" font-size="8">(not returned)</text>

      <!-- Arrow from active box → VERIFIED LOCALLY (lime) -->
      <line x1="460" y1="135" x2="483" y2="135" stroke="#c8f63c" stroke-width="1.5"/>
      <path d="M479 131 L484 135 L479 139" fill="none" stroke="#c8f63c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- VERIFIED LOCALLY box -->
      <rect x="486" y="88" width="100" height="110" rx="10" fill="rgba(200,246,60,0.05)" stroke="rgba(200,246,60,0.45)" stroke-width="1.5"/>
      <!-- Shield -->
      <path d="M536 102 L516 112 v14 c0 12 10 20 20 23 10-3 20-11 20-23v-14Z" fill="rgba(200,246,60,0.12)" stroke="#c8f63c" stroke-width="1.5" stroke-linejoin="round"/>
      <!-- Checkmark -->
      <path d="M525 126 l5 5 11-12" stroke="#c8f63c" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- light-client + proof checks label -->
      <line x1="536" y1="62" x2="536" y2="87" stroke="rgba(255,255,255,0.22)" stroke-width="1" stroke-dasharray="3 2"/>
      <text x="536" y="54" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="8">light-client +</text>
      <text x="536" y="64" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="8">proof checks</text>
      <text x="536" y="215" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="8.5" letter-spacing="0.08em">VERIFIED LOCALLY</text>

    </svg>
  `;
}

export function bindCopyButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
        flashCopyLabel(button, "Copied");
      } catch {
        flashCopyLabel(button, "Copy failed");
      }
    });
  });
}

function flashCopyLabel(button: HTMLButtonElement, message: string): void {
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  if (!label) {
    return;
  }
  if (!label.dataset.original) {
    label.dataset.original = label.textContent ?? "Copy";
  }
  label.textContent = message;
  window.setTimeout(() => {
    label.textContent = label.dataset.original ?? "Copy";
  }, 1600);
}

export function bindTableRows(root: HTMLElement): void {
  if (root.dataset.rowsBound === "true") {
    return;
  }
  root.dataset.rowsBound = "true";
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("a, button, input, select, label")) {
      return;
    }
    const row = target.closest<HTMLElement>("tr[data-href]");
    const href = row?.dataset.href;
    if (href) {
      window.location.hash = href;
    }
  });
}
