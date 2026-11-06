import { operatorUrl } from "./endpoint.ts";

export const MAX_OPERATOR_ENDPOINTS = 8;
export const MAX_ENDPOINT_RECORD_BYTES = 4096;
const ENDPOINT_ID = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;

/** One stable node under an operator; the enclosing ENS text record carries version 1. */
export interface OperatorEndpointRecord {
  id: string;
  url: string;
  beaconUrl?: string;
}

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function canonicalUrl(value: unknown): string {
  if (typeof value !== "string" || value.includes("?") || value.includes("#")) throw new Error("public endpoint URLs cannot contain queries or fragments");
  return operatorUrl(value).href;
}

function validate(value: unknown): OperatorEndpointRecord[] {
  if (!object(value, ["version", "endpoints"]) || value.version !== 1 || !Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > MAX_OPERATOR_ENDPOINTS) throw new Error("expected endpoint record version 1 with 1–8 endpoints");
  const ids = new Set<string>(), urls = new Set<string>();
  return Array.from(value.endpoints, entry => {
    if (!object(entry, ["id", "url", "beaconUrl"]) || typeof entry.id !== "string" || !ENDPOINT_ID.test(entry.id)) throw new Error("invalid endpoint entry or ID");
    const url = canonicalUrl(entry.url);
    if (ids.has(entry.id) || urls.has(url)) throw new Error("endpoint IDs and canonical RPC URLs must be unique");
    ids.add(entry.id); urls.add(url);
    const result: OperatorEndpointRecord = { id: entry.id, url };
    if (Object.hasOwn(entry, "beaconUrl")) result.beaconUrl = canonicalUrl(entry.beaconUrl);
    return result;
  });
}

function bounded(value: string): string {
  if (new TextEncoder().encode(value).length > MAX_ENDPOINT_RECORD_BYTES) throw new Error("endpoint record exceeds 4096 UTF-8 bytes");
  return value;
}

/** Parse the complete plural record. Absence/legacy fallback is the discovery caller's decision. */
export function parseOperatorEndpoints(value: string): OperatorEndpointRecord[] {
  if (typeof value !== "string") throw new Error("endpoint record must be a JSON string");
  return validate(JSON.parse(bounded(value)));
}

/** Validate and publish a canonical versioned record, without mutating the supplied entries. */
export function serializeOperatorEndpoints(endpoints: readonly OperatorEndpointRecord[]): string {
  const entries = validate({ version: 1, endpoints });
  return bounded(JSON.stringify({ version: 1, endpoints: entries }));
}
