// Build-time checks that keep non-public tor-js gateways out of release builds (#36).
// A gateway is a KPS address, "host:port:certhash" ("[v6]:port:certhash" for IPv6).

const KPS_IN_TEXT = /(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):\d{1,5}:u[A-Za-z0-9_-]{30,}/g;
const IPV4_IN_TEXT = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;

/** The host of a KPS address, parsed as tor-js does (`src/kpsAddress.ts`): IPv6 must be bracketed. */
export function gatewayHost(address: string): string {
  const value = address.trim().replace(/^kps:/, "");
  const malformed = () => new Error(`malformed gateway address (expected ip:port:certhash or [ipv6]:port:certhash): ${address}`);
  let host: string;
  let rest: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") throw malformed();
    host = value.slice(1, end);
    rest = value.slice(end + 2);
  } else {
    const i = value.indexOf(":");
    if (i < 0) throw malformed();
    host = value.slice(0, i);
    rest = value.slice(i + 1);
  }
  const j = rest.indexOf(":");
  const port = rest.slice(0, j);
  if (j < 0 || !host || !rest.slice(j + 1) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw malformed();
  return host;
}

/** Why a host is not publicly reachable, or null if it looks public. Disguised forms are normalized first. */
export function nonPublicReason(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return "empty host";
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (h.endsWith(".local")) return "mDNS .local name";
  let hostname: string;
  try {
    // The WHATWG URL parser turns 0x7f.1, 0177.0.0.1, 2130706433 and 127.1 into 127.0.0.1.
    hostname = new URL(`http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}/`).hostname;
  } catch {
    return "unparseable host";
  }
  if (hostname.startsWith("[")) return ipv6Reason(hostname.slice(1, -1));
  const v4 = parseIpv4(hostname);
  // tor-js dials an IP; a name can't be checked for a public address at build time.
  return v4 ? ipv4Reason(v4) : "hostname, not an IP address";
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number);
}

function ipv4Reason([a, b, c]: number[]): string | null {
  if (a === 0) return "unspecified address";
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "private network";
  if (a === 100 && b! >= 64 && b! <= 127) return "carrier-grade NAT";
  if (a === 169 && b === 254) return "link-local";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "documentation";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignments";
  if (a === 192 && b === 88 && c === 99) return "6to4 relay";
  if (a! >= 224 && a! <= 239) return "multicast";
  if (a! >= 240) return "reserved";
  return null;
}

function ipv6Reason(compressed: string): string | null {
  const words = expandIpv6(compressed);
  if (!words) return "unparseable IPv6 address";
  const zeroUpTo = (n: number) => words.slice(0, n).every((w) => w === 0);
  const embedded = () => [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255];
  if (zeroUpTo(8)) return "unspecified address";
  if (zeroUpTo(7) && words[7] === 1) return "loopback";
  if (zeroUpTo(5) && words[5] === 0xffff) return ipv4Reason(embedded()) && `IPv4-mapped ${ipv4Reason(embedded())}`;
  if (zeroUpTo(6)) return ipv4Reason(embedded()) && `IPv4-compatible ${ipv4Reason(embedded())}`;
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    return ipv4Reason(embedded()) && `NAT64 ${ipv4Reason(embedded())}`;
  }
  if (words[0] === 0x2001 && words[1] === 0x0db8) return "documentation";
  if (words[0] === 0x2002) return "6to4";
  if (words[0] === 0x0100 && words.slice(1, 4).every((w) => w === 0)) return "discard-only";
  if ((words[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((words[0]! & 0xffc0) === 0xfec0) return "site-local";
  if ((words[0]! & 0xfe00) === 0xfc00) return "unique local (private)";
  if ((words[0]! & 0xff00) === 0xff00) return "multicast";
  return null;
}

function expandIpv6(value: string): number[] | null {
  const [head, tail, extra] = value.split("::");
  if (extra !== undefined) return null;
  const toWords = (s: string | undefined) => (s ? s.split(":").map((w) => parseInt(w, 16)) : []);
  const left = toWords(head);
  const right = toWords(tail);
  const words = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** Throws unless every gateway is well formed and public. */
export function assertPublicGateways(gateways: readonly string[]): void {
  const problems = gateways.flatMap((g) => {
    try {
      const reason = nonPublicReason(gatewayHost(g));
      return reason ? [`${g} (${reason})`] : [];
    } catch (error) {
      return [(error as Error).message];
    }
  });
  if (problems.length) throw new Error(`release builds need public tor-js gateways; refusing: ${problems.join(", ")}`);
}

/**
 * The gateway list baked into a release: the explicitly configured public gateways, then the demo
 * gateway as a fallback. Fails when none is configured rather than silently using only the demo one.
 */
export function releaseGateways(configured: string | undefined, demoGateway: string): string[] {
  const gateways = (configured ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (gateways.length === 0) {
    throw new Error("release builds need VITE_TOR_GATEWAYS set in the shell to at least one public tor-js gateway (use `build:local` for a LAN gateway)");
  }
  assertPublicGateways(gateways);
  return gateways.includes(demoGateway) ? gateways : [...gateways, demoGateway];
}

/** Non-public gateway addresses and private, loopback or link-local IPv4 literals found in built text. */
export function findNonPublicAddresses(text: string): string[] {
  const found = new Set<string>();
  for (const [match] of text.matchAll(KPS_IN_TEXT)) {
    try {
      if (nonPublicReason(gatewayHost(match))) found.add(match);
    } catch {
      // Not a gateway address after all.
    }
  }
  for (const [match] of text.matchAll(IPV4_IN_TEXT)) {
    const v4 = parseIpv4(match);
    const reason = v4 && ipv4Reason(v4);
    // 0.0.0.0 shows up in library code as a bind address; it is still refused as a gateway above.
    if (reason && reason !== "unspecified address" && reason !== "multicast" && reason !== "reserved") found.add(match);
  }
  return [...found];
}
