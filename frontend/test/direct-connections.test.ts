import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountDirectConnections } from "../src/direct-connections.ts";

const observe = vi.fn(), disconnect = vi.fn();
let emit: (entries: PerformanceEntry[]) => void;
let body: HTMLTableSectionElement, status: HTMLParagraphElement;
let panel: ReturnType<typeof mountDirectConnections> | undefined;
const entry = (name: string, startTime = 1): PerformanceEntry => ({
  name, entryType: "resource", startTime, duration: 2, initiatorType: "fetch", transferSize: 0,
}) as PerformanceResourceTiming;
const rows = () => [...body.querySelectorAll<HTMLTableRowElement>("tr")];
const mount = () => panel = mountDirectConnections({
  body, status, rpcUrls: ["https://rpc.example/", "https://beacon.example/"],
  bundleUrls: ["https://worker.example/bundle.js", "kps:ignored", "not a URL"],
});
function transition(type: string, persisted = false) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  observe.mockReset(); disconnect.mockReset();
  vi.stubGlobal("PerformanceObserver", class {
    constructor(callback: PerformanceObserverCallback) {
      emit = entries => callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
    }
    observe = observe;
    disconnect = disconnect;
  });
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
  body = document.createElement("tbody"); status = document.createElement("p");
  const table = document.createElement("table"); table.append(body); document.body.append(status, table);
});
afterEach(() => {
  panel?.dispose(); panel = undefined;
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("browser resource observations", () => {
  it("shows an honest empty state instead of suggesting zero connections", () => {
    mount();
    expect(observe).toHaveBeenCalledWith({ type: "resource", buffered: true });
    expect(status.textContent).toContain("No HTTP(S) resource timings are exposed");
    expect(status.textContent).toContain("does not establish that no network connections occurred");
    expect(status.className).toBe("warn");
    expect(body.textContent).toContain("Open the browser Network panel before reloading");
    expect(rows()[0]!.cells[0]!.colSpan).toBe(3);
    expect(body.querySelector(".ok")).toBeNull();
  });

  it("retains buffered and cached loads once when snapshots repeat or are cleared", async () => {
    const cached = entry("https://worker.example/bundle.js", 0);
    vi.mocked(performance.getEntriesByType).mockReturnValue([cached]);
    mount(); emit([cached]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.cells[0]!.textContent).toBe("worker.example");
    expect(rows()[0]!.cells[1]!.textContent).toContain("direct downloads expected");
    expect(rows()[0]!.cells[2]!.textContent).toBe("1");
    vi.mocked(performance.getEntriesByType).mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(rows()[0]!.cells[2]!.textContent).toBe("1");
    expect(status.textContent).toContain("1 HTTP(S) resource timing observations retained");
  });

  it("captures later observer entries without snapshots and displays hosts without URL secrets", () => {
    mount();
    emit([entry("https://rpc.example/private-path?token=secret"), entry("https://rpc.example/rpc", 5)]);
    expect(rows()[0]!.cells[0]!.textContent).toBe("rpc.example");
    expect(rows()[0]!.cells[1]!.className).toBe("bad");
    expect(rows()[0]!.cells[1]!.textContent).toContain("outside the worker");
    expect(rows()[0]!.cells[2]!.textContent).toBe("2");
    expect(body.textContent).not.toContain("token");
    expect(body.textContent).not.toContain("private-path");
  });

  it("skips malformed and non-HTTP entries without breaking subsequent observations", () => {
    mount();
    emit([
      entry("not a URL"), entry("data:text/plain,hello"), entry("blob:https://example.test/id"),
      { ...entry("https://ignored.example/"), entryType: "navigation" },
      entry(`${location.origin}/asset.js`),
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.cells[0]!.textContent).toBe(location.host);
    expect(rows()[0]!.cells[1]!.textContent).toBe("page assets");
  });

  it.each(["missing", "blocked"])("uses snapshots when live observation is %s", mode => {
    if (mode === "missing") vi.stubGlobal("PerformanceObserver", undefined);
    else observe.mockImplementation(() => { throw new Error("Observation unavailable"); });
    vi.mocked(performance.getEntriesByType).mockReturnValue([entry("https://worker.example/bundle.js")]);
    mount();
    expect(status.textContent).toContain("Live resource observation is unavailable");
    expect(rows()[0]!.cells[0]!.textContent).toBe("worker.example");
    if (mode === "blocked") expect(disconnect).toHaveBeenCalled();
  });

  it.each(["missing", "blocked"])("renders safely when both live observation and timing snapshots are %s", mode => {
    vi.stubGlobal("PerformanceObserver", undefined);
    if (mode === "missing") vi.stubGlobal("performance", { now: () => 0 });
    else vi.mocked(performance.getEntriesByType).mockImplementation(() => { throw new Error("Timing restricted"); });
    mount();
    expect(status.textContent).toContain("snapshot is unavailable");
    expect(body.textContent).toContain("No resource observations available");
  });

  it("bounds retained observations, stops collection, and discloses that later loads are not shown", async () => {
    mount();
    emit(Array.from({ length: 600 }, (_, i) => entry(`https://worker.example/bundle.js?attempt=${i}`, i)));
    expect(rows()[0]!.cells[2]!.textContent).toBe("512");
    expect(status.textContent).toContain("Collection stopped at the 512-observation limit; later loads are not shown");
    expect(status.className).toBe("warn");
    expect(disconnect).toHaveBeenCalledTimes(1);
    vi.mocked(performance.getEntriesByType).mockClear().mockReturnValue([entry("https://later.example/")]);
    await vi.advanceTimersByTimeAsync(3000);
    emit([entry("https://later.example/")]);
    expect(performance.getEntriesByType).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.cells[2]!.textContent).toBe("512");
  });

  it("pauses collection on pagehide, resumes a cached page, and disposes observers and timers", async () => {
    mount(); emit([entry("https://worker.example/bundle.js")]);
    transition("pagehide", true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    vi.mocked(performance.getEntriesByType).mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    emit([entry("https://ignored.example/")]);
    expect(performance.getEntriesByType).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    vi.mocked(performance.getEntriesByType).mockReturnValue([entry("https://worker.example/bundle.js", 5)]);
    transition("pageshow", true);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(rows()[0]!.cells[2]!.textContent).toBe("2");
    panel!.dispose();
    expect(disconnect).toHaveBeenCalledTimes(2);
    vi.mocked(performance.getEntriesByType).mockClear();
    transition("pagehide", true); transition("pageshow", true);
    emit([entry("https://ignored.example/")]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(performance.getEntriesByType).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });
});
