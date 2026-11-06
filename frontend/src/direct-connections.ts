import { tableRow, textCell } from "./render.ts";

const MAX_RESOURCE_OBSERVATIONS = 512;

/** Local ResourceTiming observations only; never probes a host or changes browser timing buffers. */
export function mountDirectConnections(options: {
  body: HTMLElement;
  status: HTMLElement;
  rpcUrls: readonly string[];
  bundleUrls: readonly string[];
}) {
  const httpUrl = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
    } catch { return undefined; }
  };
  const hosts = (urls: readonly string[]) => new Set(urls.flatMap(value => {
    const url = httpUrl(value);
    return url ? [url.host] : [];
  }));
  const rpcHosts = hosts(options.rpcUrls);
  const bundleHosts = hosts(options.bundleUrls);
  const resourceHosts = new Map<string, string>();
  let observer: PerformanceObserver | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let limitReached = false;
  let snapshotUnavailable = false;
  let paused = false;
  let disposed = false;

  function stop() {
    observer?.disconnect();
    observer = undefined;
    clearInterval(timer);
    timer = undefined;
  }
  function retain(entries: PerformanceEntry[]) {
    if (limitReached) return;
    for (const entry of entries) {
      if (entry.entryType !== "resource") continue;
      const url = httpUrl(entry.name);
      if (!url) continue;
      // A buffered callback and a snapshot can expose the same cached or completed load.
      const key = JSON.stringify([entry.name, entry.startTime, entry.duration, (entry as PerformanceResourceTiming).initiatorType]);
      resourceHosts.set(key, url.host);
      if (resourceHosts.size >= MAX_RESOURCE_OBSERVATIONS) {
        limitReached = true;
        stop();
        break;
      }
    }
  }
  function refresh() {
    if (disposed) return;
    if (!paused && !limitReached) {
      try {
        retain(performance.getEntriesByType("resource"));
        snapshotUnavailable = false;
      } catch { snapshotUnavailable = true; }
    }
    const counts = new Map<string, number>();
    for (const host of resourceHosts.values()) counts.set(host, (counts.get(host) ?? 0) + 1);
    const status = [resourceHosts.size
      ? `${resourceHosts.size} HTTP(S) resource timing observations retained for this page.`
      : "No HTTP(S) resource timings are exposed in this page. This does not establish that no network connections occurred."];
    if (snapshotUnavailable) status.push("The browser's resource timing snapshot is unavailable.");
    if (!observer && !limitReached && !paused) status.push("Live resource observation is unavailable; only exposed periodic snapshots can be shown.");
    if (limitReached) status.push(`Collection stopped at the ${MAX_RESOURCE_OBSERVATIONS}-observation limit; later loads are not shown. Reload to start a new observation window.`);
    options.status.textContent = status.join(" ");
    options.status.className = !resourceHosts.size || snapshotUnavailable || limitReached ? "warn" : "muted";
    options.body.replaceChildren();
    if (!counts.size) {
      const row = document.createElement("tr");
      const cell = textCell("No resource observations available. Open the browser Network panel before reloading to inspect page traffic.", "warn");
      cell.colSpan = 3; row.append(cell); options.body.append(row);
    }
    for (const [host, count] of counts) {
      const kind = rpcHosts.has(host) ? ["RPC/beacon resource outside the worker — inspect", "bad"]
        : host === location.host ? ["page assets", "ok"]
        : bundleHosts.has(host) ? ["worker bundle host (direct downloads expected)", "warn"]
        : ["unexpected", "bad"];
      options.body.append(tableRow([{ text: host }, { text: kind[0]!, className: kind[1] }, { text: String(count) }]));
    }
  }
  function start() {
    if (disposed || limitReached) return;
    paused = false;
    try {
      observer = new PerformanceObserver(entries => {
        if (disposed || paused || limitReached) return;
        retain(entries.getEntries());
        refresh();
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer?.disconnect();
      observer = undefined;
    }
    refresh();
    if (!limitReached) timer = setInterval(refresh, 3000);
  }
  const pause = () => { paused = true; stop(); };
  const resume = (event: PageTransitionEvent) => { if (event.persisted && paused) start(); };
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  start();
  return {
    refresh,
    dispose() {
      disposed = true;
      stop();
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", resume);
    },
  };
}
