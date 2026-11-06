import { operatorKey } from "@derpc/provider";

export interface OperatorIdentity {
  operatorId?: string;
  endpointId?: string;
  id?: string;
  ens?: string;
  url: string;
}

/** Keep the operator's identity distinct from the IDs used for individual endpoint observations. */
export function groupOperators<T extends OperatorIdentity>(endpoints: readonly T[]): { key: string; endpoints: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const endpoint of endpoints) {
    const key = operatorKey(endpoint);
    const group = groups.get(key);
    if (group) group.push(endpoint);
    else groups.set(key, [endpoint]);
  }
  return [...groups].map(([key, endpoints]) => ({ key, endpoints }));
}

export function operatorKeys(endpoints: readonly OperatorIdentity[]): string[] {
  return [...new Set(endpoints.map(endpoint => operatorKey(endpoint)))];
}
