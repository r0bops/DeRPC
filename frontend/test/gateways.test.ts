// @vitest-environment node
// Release builds must refuse non-public tor-js gateways, including disguised forms, and catch any
// that still reach the built files (#36).
import { describe, expect, it } from "vitest";
import { assertPublicGateways, findNonPublicAddresses, gatewayHost, nonPublicReason, releaseGateways } from "../build/gateways.ts";
import viteConfig from "../vite.config.ts";

const CERT = "uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";
const DEMO = `152.236.3.22:12298:${CERT}`;
const PUBLIC = `95.216.10.20:12298:${CERT}`;
const gw = (host: string) => `${host}:12298:${CERT}`;

describe("nonPublicReason", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.1", "loopback"],
    ["0x7f.1", "loopback"],
    ["0177.0.0.1", "loopback"],
    ["2130706433", "loopback"],
    ["0.0.0.0", "unspecified address"],
    ["10.1.2.3", "private network"],
    ["172.16.0.1", "private network"],
    ["172.31.255.254", "private network"],
    ["192.168.1.20", "private network"],
    ["0xc0.0xa8.1.20", "private network"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["100.127.255.254", "carrier-grade NAT"],
    ["169.254.10.1", "link-local"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.1", "benchmarking"],
    ["192.0.2.10", "documentation"],
    ["198.51.100.10", "documentation"],
    ["203.0.113.10", "documentation"],
    ["192.0.0.8", "IETF protocol assignments"],
    ["192.88.99.1", "6to4 relay"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["localhost", "localhost"],
    ["gateway.localhost", "localhost"],
    ["pi.local", "mDNS .local name"],
    ["PI.LOCAL.", "mDNS .local name"],
    ["gateway.example.org", "hostname, not an IP address"],
    ["::1", "loopback"],
    ["::", "unspecified address"],
    ["fe80::1", "link-local"],
    ["fec0::1", "site-local"],
    ["fd12:3456::1", "unique local (private)"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2002:c0a8:114::1", "6to4"],
    ["100::1", "discard-only"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.5", "IPv4-mapped private network"],
    ["::10.0.0.5", "IPv4-compatible private network"],
    ["64:ff9b::a00:1", "NAT64 private network"],
    ["64:ff9b::c0a8:114", "NAT64 private network"],
  ])("refuses %s (%s)", (host, reason) => {
    expect(nonPublicReason(host)).toBe(reason);
  });

  it.each(["152.236.3.22", "95.216.10.20", "172.15.0.1", "172.32.0.1", "100.128.0.1", "198.20.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "accepts public %s",
    (host) => {
      expect(nonPublicReason(host)).toBeNull();
    },
  );
});

describe("gatewayHost", () => {
  it("reads IPv4 and bracketed IPv6 addresses, as tor-js does", () => {
    expect(gatewayHost(DEMO)).toBe("152.236.3.22");
    expect(gatewayHost(`[fe80::1]:12298:${CERT}`)).toBe("fe80::1");
  });

  it.each([
    ["no certhash", "152.236.3.22:12298"],
    ["empty certhash", "152.236.3.22:12298:"],
    ["unbracketed IPv6", `fe80::1:12298:${CERT}`],
    ["unclosed bracket", `[::1:12298:${CERT}`],
    ["hex port", `152.236.3.22:0x1bb:${CERT}`],
    ["port out of range", `152.236.3.22:70000:${CERT}`],
    ["port zero", `152.236.3.22:0:${CERT}`],
    ["resolver scheme instead of a gateway address", `kps:${DEMO}`],
    ["arbitrary certificate text", "152.236.3.22:12298:not-a-certificate"],
    ["wrong multibase", `152.236.3.22:12298:z${CERT.slice(1)}`],
    ["short digest", `152.236.3.22:12298:${CERT.slice(0, -1)}`],
    ["long digest", `152.236.3.22:12298:${CERT}A`],
    ["wrong hash algorithm", `152.236.3.22:12298:u${Buffer.from([0x13, 0x20, ...Array(32).fill(0)]).toString("base64url")}`],
    ["wrong digest length prefix", `152.236.3.22:12298:u${Buffer.from([0x12, 0x1f, ...Array(32).fill(0)]).toString("base64url")}`],
    ["padded base64", `152.236.3.22:12298:${CERT}==`],
    ["non-canonical trailing bits", `152.236.3.22:12298:${CERT.slice(0, -1)}R`],
    ["invalid base64 character", `152.236.3.22:12298:${CERT.slice(0, -1)}!`],
  ])("rejects %s", (_name, address) => {
    expect(() => gatewayHost(address)).toThrow("malformed gateway address");
  });
});

describe("releaseGateways", () => {
  it("fails without an explicit gateway instead of falling back to the demo one", () => {
    expect(() => releaseGateways(undefined, DEMO)).toThrow("VITE_TOR_GATEWAYS");
    expect(() => releaseGateways(" , ", DEMO)).toThrow("VITE_TOR_GATEWAYS");
  });

  it("refuses a non-public gateway, even next to a public one", () => {
    expect(() => releaseGateways(`${PUBLIC},${gw("192.168.1.20")}`, DEMO)).toThrow("192.168.1.20");
    expect(() => assertPublicGateways([gw("0x7f.1")])).toThrow("loopback");
    expect(() => assertPublicGateways([`[64:ff9b::a00:1]:12298:${CERT}`])).toThrow("NAT64 private network");
    expect(() => assertPublicGateways([gw("gateway.example.org")])).toThrow("hostname");
  });

  it("appends the demo gateway as a fallback, once", () => {
    expect(releaseGateways(PUBLIC, DEMO)).toEqual([PUBLIC, DEMO]);
    expect(releaseGateways(DEMO, DEMO)).toEqual([DEMO]);
  });

  it("rejects malformed gateways even when a working fallback exists", () => {
    expect(() => releaseGateways(`kps:${PUBLIC}`, DEMO)).toThrow("malformed gateway address");
    expect(() => releaseGateways("95.216.10.20:12298:not-a-certificate", DEMO)).toThrow("malformed gateway address");
    expect(() => releaseGateways(PUBLIC, `kps:${DEMO}`)).toThrow("malformed gateway address");
  });
});

describe("release build config", () => {
  const config = viteConfig as unknown as (env: { command: "build" | "serve"; mode: string }) => Record<string, unknown>;

  it("fails when VITE_TOR_GATEWAYS is not in the shell, and never reads .env files", () => {
    const saved = process.env.VITE_TOR_GATEWAYS;
    delete process.env.VITE_TOR_GATEWAYS;
    try {
      expect(() => config({ command: "build", mode: "production" })).toThrow("VITE_TOR_GATEWAYS");
      process.env.VITE_TOR_GATEWAYS = PUBLIC;
      expect(config({ command: "build", mode: "production" })).toMatchObject({
        envDir: false,
        define: { "import.meta.env.VITE_TOR_GATEWAYS": JSON.stringify(`${PUBLIC},${DEMO}`) },
      });
    } finally {
      if (saved === undefined) delete process.env.VITE_TOR_GATEWAYS;
      else process.env.VITE_TOR_GATEWAYS = saved;
    }
  });

  it("keeps .env.local for the dev server and the LAN build, which writes to dist-local", () => {
    expect(config({ command: "serve", mode: "development" })).not.toHaveProperty("envDir");
    expect(config({ command: "build", mode: "lan" })).toMatchObject({ build: { outDir: "dist-local" } });
  });
});

describe("findNonPublicAddresses", () => {
  it("finds non-public gateways and private IPv4 literals in built text", () => {
    const text = `const g="${gw("192.168.1.20")}";const h="kps:[fd00::2]:12298:${CERT}";fetch("http://10.0.0.7/x")`;
    expect(findNonPublicAddresses(text)).toEqual([gw("192.168.1.20"), `[fd00::2]:12298:${CERT}`, "192.168.1.20", "10.0.0.7"]);
  });

  it("finds them inside a sourcemap", () => {
    const map = JSON.stringify({ version: 3, sourcesContent: [`const gateways = "${gw("172.20.0.4")}";`] });
    expect(findNonPublicAddresses(map)).toEqual([gw("172.20.0.4"), "172.20.0.4"]);
  });

  it("ignores the public demo gateway, bind addresses, versions and license text", () => {
    const license = "MIT License. Copyright (c) 2015-2026. Version 1.10.0.3.4, see section 2.1.3. 0.0.0.0 255.255.255.255";
    expect(findNonPublicAddresses(`"${DEMO}" listen("0.0.0.0") v1.2.3 ${license}`)).toEqual([]);
  });
});
