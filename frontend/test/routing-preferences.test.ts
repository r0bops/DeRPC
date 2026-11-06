import { describe, expect, it } from "vitest";
import { defaultRouting, eligibleForAutomatic, parseRoutingPreferences, routingOptions } from "../src/routing-preferences.ts";

describe("routing preferences", () => {
  it("requires a valid saved opt-in and keeps an explicit empty allowlist", () => {
    expect(parseRoutingPreferences(null).selection).toBe("manual");
    expect(parseRoutingPreferences('{"selection":"fastest"}').selection).toBe("manual");
    const restricted = { ...defaultRouting(), selection: "fastest" as const, scope: "selected" as const };
    expect(routingOptions(parseRoutingPreferences(JSON.stringify(restricted)))).toEqual({ selection: "fastest", allowedOperators: [] });
    expect(routingOptions({ ...restricted, scope: "all" })).toEqual({ selection: "fastest" });
    expect(routingOptions(defaultRouting())).toEqual({ selection: "manual" });
  });

  it("does not promote unverified, paid, personal, expired or tampered entries", () => {
    expect(eligibleForAutomatic({ source: "bootstrap" })).toBe(true);
    expect(eligibleForAutomatic({ source: "ens", listVerification: "proven", recordVerification: "proven" })).toBe(true);
    expect(eligibleForAutomatic({ source: "ens", listVerification: "proven", recordVerification: "unverified" })).toBe(false);
    for (const extra of [{ payment: {} }, { personalToken: "secret" }, { tamper: () => {} }, { expiry: 1 }, { expiry: NaN }]) {
      expect(eligibleForAutomatic({ source: "bootstrap", ...extra }, 2)).toBe(false);
    }
    expect(eligibleForAutomatic({ source: "personal" })).toBe(false);
  });

  it("preserves the ENS source so reload cannot silently substitute bootstrap names", () => {
    expect(parseRoutingPreferences(JSON.stringify({ ...defaultRouting(), source: "ens", selection: "reliable", scope: "all" })).source).toBe("ens");
  });
});
