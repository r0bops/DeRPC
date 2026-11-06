export type RoutingMode = "manual" | "balanced" | "fastest" | "reliable";
export interface RoutingPreferences {
  version: 1;
  selection: RoutingMode;
  scope: "all" | "selected";
  allowedOperators: string[];
  source: "bootstrap" | "ens";
}

export const defaultRouting = (): RoutingPreferences => ({ version: 1, selection: "manual", scope: "selected", allowedOperators: [], source: "bootstrap" });

/** Only public operator identities and an explicit opt-in are persisted, never endpoints or credentials. */
export function parseRoutingPreferences(raw: string | null): RoutingPreferences {
  if (!raw) return defaultRouting();
  try {
    const value = JSON.parse(raw) as Partial<RoutingPreferences>;
    if (value?.version !== 1 || !["manual", "balanced", "fastest", "reliable"].includes(value.selection ?? "") ||
      !["all", "selected"].includes(value.scope ?? "") || !["bootstrap", "ens"].includes(value.source ?? "") ||
      !Array.isArray(value.allowedOperators) || value.allowedOperators.length > 128 ||
      value.allowedOperators.some(id => typeof id !== "string" || !id.length || id.length > 256)) return defaultRouting();
    return { version: 1, selection: value.selection!, scope: value.selection === "manual" ? "selected" : value.scope!, allowedOperators: [...new Set(value.allowedOperators)], source: value.source! };
  } catch { return defaultRouting(); }
}

export function routingOptions(preferences: RoutingPreferences): { selection: RoutingMode; allowedOperators?: string[] } {
  return {
    selection: preferences.selection,
    ...(preferences.selection !== "manual" && preferences.scope === "selected" ? { allowedOperators: [...preferences.allowedOperators] } : {}),
  };
}

export function eligibleForAutomatic(operator: {
  source: "bootstrap" | "ens" | "personal";
  listVerification?: string;
  recordVerification?: string;
  payment?: unknown;
  paymentOperatorId?: string;
  personalToken?: string;
  tamper?: unknown;
  expiry?: number;
}, nowSeconds = Date.now() / 1000): boolean {
  if (operator.source === "personal" || operator.payment || operator.paymentOperatorId || operator.personalToken || operator.tamper) return false;
  if (operator.expiry !== undefined && (!Number.isFinite(operator.expiry) || operator.expiry <= nowSeconds)) return false;
  return operator.source === "bootstrap" || operator.listVerification === "proven" && operator.recordVerification === "proven";
}
