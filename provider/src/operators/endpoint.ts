import { sha3_256 } from "@noble/hashes/sha3";
import type { AnonTransport } from "../transport/anon-transport.ts";
import { readResponseBody } from "../transport/response-body.ts";

/** HTTPS for exit endpoints; authenticated v3 onion HTTP for services inside Tor. */
export function operatorUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || value.length > 2048) throw new Error("invalid operator URL");
  if (url.hostname.endsWith(".onion")) {
    if (!["http:", "https:"].includes(url.protocol) || !validOnion(url.hostname)) throw new Error("expected a valid v3 onion address");
  } else if (url.protocol !== "https:") throw new Error("operator must use HTTPS or a v3 onion service");
  return url;
}

function validOnion(host: string): boolean {
  if (!/^[a-z2-7]{56}\.onion$/.test(host)) return false;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes: number[] = [];
  let bits = 0, accumulator = 0;
  for (const char of host.slice(0, 56)) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >> bits) & 255); }
  }
  if (bytes[34] !== 3) return false;
  const input = new Uint8Array([...new TextEncoder().encode(".onion checksum"), ...bytes.slice(0, 32), 3]);
  const checksum = sha3_256(input);
  return checksum[0] === bytes[32] && checksum[1] === bytes[33];
}

export interface OperatorIdentity {
  ens: string;
  signer: `0x${string}`;
  chains: number[];
  version: "1";
  service: "node" | "demo-proxy";
}

/** A reciprocal claim, not proof that the ENS lookup was correct. Always through the worker. */
export async function checkOperatorIdentity(transport: AnonTransport, endpoint: string, expected: { ens: string; signer: string }, signal?: AbortSignal): Promise<OperatorIdentity> {
  const url = operatorUrl(endpoint);
  const timeoutMs = 10_000;
  const started = performance.now();
  const response = await transport.fetch(new URL("/.well-known/derpc.json", url).href, {
    isolationKey: "derpc:operator-discovery", timeoutMs, signal, redirect: "error",
  });
  const bytes = await readResponseBody(response, { timeoutMs: timeoutMs - (performance.now() - started), maxBytes: 4096, signal });
  if (!response.ok) throw new Error("operator identity unavailable");
  const identity = JSON.parse(new TextDecoder().decode(bytes)) as OperatorIdentity;
  if (!identity || identity.version !== "1" || identity.ens !== expected.ens || typeof identity.signer !== "string" || identity.signer.toLowerCase() !== expected.signer.toLowerCase() || !Array.isArray(identity.chains) || !identity.chains.includes(1) || !["node", "demo-proxy"].includes(identity.service)) {
    throw new Error("operator identity does not match its ENS records");
  }
  return identity;
}

/** Compare gateway keys, not only textual addresses (one key may have several addresses). */
export function gatewayIdentity(gateway: string): string {
  return gateway.slice(gateway.lastIndexOf(":") + 1);
}

export function assertSeparateGateway(operator: { ens?: string; gateways?: string[] }, gateways: string[], owners: Record<string, string> = {}): void {
  const declared = new Set((operator.gateways ?? []).map(gatewayIdentity));
  for (const gateway of gateways) {
    const key = gatewayIdentity(gateway);
    const knownOwner = Object.entries(owners).find(([address]) => gatewayIdentity(address) === key)?.[1];
    if (declared.has(key) || operator.ens && knownOwner?.toLowerCase() === operator.ens.toLowerCase()) {
      throw new Error("gateway and RPC service share an operator; choose an independent gateway");
    }
  }
}
