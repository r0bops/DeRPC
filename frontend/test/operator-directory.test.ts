import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATORS } from "../../web/src/directory/operators.ts";
import { PENDING_OPERATORS, TEAM_REGISTRATION_CONFIG, TEAM_REGISTRATION_PLAN } from "../../web/src/directory/pending-operators.ts";
import { directoryPage } from "../../web/src/pages/directory.ts";
import { operatorPage } from "../../web/src/pages/operator.ts";
import { networkPage } from "../../web/src/pages/network.ts";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("public directory enrollment boundary", () => {
  it("binds pending names to the actual proxy observations and unsigned enrollment configuration", () => {
    const config = JSON.parse(readFileSync(resolve("../contracts/deployments/ens-two-demo-operators-config-2026-11-07.json"), "utf8"));
    const readiness = JSON.parse(readFileSync(resolve("../wrapper/test/deployed-proxy-readiness-2026-11-06.json"), "utf8"));
    expect(PENDING_OPERATORS.map(({ name, endpoint }) => ({ name, endpoint }))).toEqual(
      config.operators.map((operator: { label: string; endpoint: string }) => ({ name: `${operator.label}.derpc.eth`, endpoint: operator.endpoint })),
    );
    expect(config.operators).toHaveLength(2);
    expect(TEAM_REGISTRATION_CONFIG).toEqual(config);
    expect(TEAM_REGISTRATION_PLAN.resumeConfig).toEqual(config);
    expect(new Set(config.operators.map((operator: { hotKey: string }) => operator.hotKey)).size).toBe(2);
    expect(new Set(config.operators.map((operator: { operator: string }) => operator.operator)).size).toBe(1);
    expect(config.operators.every((operator: object) => !("endpoints" in operator) && !("endpointId" in operator))).toBe(true);
    for (const operator of PENDING_OPERATORS) {
      expect(operator.enrollment).toBe("pending");
      expect(readiness.proxies.find((proxy: { name: string }) => proxy.name === operator.name)).toMatchObject({
        name: operator.name, endpoint: operator.endpoint, registeredInEns: false,
        identity: { service: "demo-proxy" }, administrativeChecks: { publicIdentityReadOverSSH: true, poolOnionHostnameReadOverSSH: true },
      });
    }
  });

  it("keeps pending demo entries outside selectable bootstrap candidates and labels their ownership and unknown health", () => {
    const page = directoryPage(new URLSearchParams());
    document.body.innerHTML = page.html;
    const pending = document.querySelector('[aria-labelledby="enrollment-title"]')!;
    expect(pending.textContent).toContain("Both are run by the DeRPC team");
    expect(pending.textContent).toContain("not independent operators");
    expect(pending.querySelectorAll("tbody tr")).toHaveLength(2);
    for (const row of pending.querySelectorAll("tbody tr")) {
      expect(row.textContent).toContain("ENS pending");
      expect(row.textContent).toContain("Not checked on this device");
      expect(row.querySelector("input, button")).toBeNull();
    }
    expect([...pending.querySelectorAll("tbody a")].map(link => link.getAttribute("href"))).toEqual(["#/operate?prepare=demo-1", "#/operate?prepare=demo-2"]);
    expect(pending.querySelector('a[href="./demo/#directory-form"]')).not.toBeNull();
    expect(pending.textContent).not.toContain("demo-3.derpc.eth");
    for (const operator of PENDING_OPERATORS) expect(pending.textContent).toContain(operator.endpoint);
    expect(OPERATORS.some(operator => PENDING_OPERATORS.some(pending => pending.name === operator.ens))).toBe(false);
  });

  it("never presents legacy bootstrap keys as ENS identities in directory, detail or network text", () => {
    const pages = [directoryPage(new URLSearchParams()), networkPage("ethereum-mainnet"), ...OPERATORS.map(operator => operatorPage(operator.ens))];
    for (const page of pages) {
      document.body.innerHTML = page.html;
      for (const operator of OPERATORS) expect(document.body.textContent).not.toContain(operator.ens);
      expect(document.body.textContent).toContain("Public bootstrap");
    }
  });

  it("retains bootstrap search and legacy links without enrolling or probing a pending operator", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    try {
      const page = directoryPage(new URLSearchParams());
      document.body.innerHTML = page.html;
      page.bind?.(document.body);
      const search = document.querySelector<HTMLInputElement>("#directory-search")!;
      search.value = "MEV Blocker";
      search.dispatchEvent(new Event("input"));
      expect(document.querySelectorAll("#directory-results tbody tr")).toHaveLength(1);
      expect(document.querySelector("#directory-results a")?.getAttribute("href")).toBe("#/operator/mevblocker.derpc.eth");
      expect(document.querySelector('[aria-labelledby="enrollment-title"] tbody')?.children).toHaveLength(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
