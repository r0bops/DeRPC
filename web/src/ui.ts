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

export function demoHref(): string {
  if (!import.meta.env.DEV) return "./demo/";
  const url = new URL(window.location.href);
  url.port = "5173";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href;
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
          <p class="footer__event">ETHGlobal Mumbai 2026 · Interface preview</p>
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
  return `<p class="demo-note"><span class="demo-note__square" aria-hidden="true"></span><span>Free demo. ENS names are placeholders; staking and operator pricing are planned. Current health observations appear in the live dashboard.</span></p>`;
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
        <pre class="code"><code><span class="tok-com">// private, verified reads</span>
<span class="tok-key">import</span> { createDeRPC, MAINNET_OPERATORS } <span class="tok-key">from</span> <span class="tok-str">"@derpc/provider"</span>
<span class="tok-key">import</span> { derpcTransport } <span class="tok-key">from</span> <span class="tok-str">"@derpc/provider/viem"</span>
<span class="tok-key">import</span> { createPublicClient } <span class="tok-key">from</span> <span class="tok-str">"viem"</span>
<span class="tok-key">import</span> { mainnet } <span class="tok-key">from</span> <span class="tok-str">"viem/chains"</span>

<span class="tok-key">const</span> derpc = <span class="tok-fn">createDeRPC</span>({ operators: MAINNET_OPERATORS })
<span class="tok-key">const</span> client = <span class="tok-fn">createPublicClient</span>({
  chain: mainnet,
  transport: <span class="tok-fn">derpcTransport</span>(derpc),
})

<span class="tok-key">await</span> client.<span class="tok-fn">getBalance</span>({
  address: <span class="tok-str">"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"</span>,
  blockTag: <span class="tok-str">"finalized"</span>,
})
<span class="tok-com">// verified by the light client, or it fails closed</span></code></pre>
      </div>
      <div class="code-card__diagram">${routeDiagram()}</div>
    </div>
  `;
}

export function routeDiagram(): string {
  return `
    <svg class="route-diagram" viewBox="0 0 320 128" role="img" aria-labelledby="route-title route-desc">
      <title id="route-title">Private route to a verified answer</title>
      <desc id="route-desc">Your app connects through a private route to an operator. A light client verifies the answer before it is returned.</desc>
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
      <text x="116" y="88" text-anchor="middle">Private route</text>
      <text x="200" y="88" text-anchor="middle">Operators</text>
      <text x="282" y="88" text-anchor="middle">Verified</text>
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
