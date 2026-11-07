// The directory's data model. Pure TypeScript: no DOM, no imports from the UI, so tests can load it.
//
// Rule that the whole directory follows: DeRPC proves reads on Ethereum mainnet only (see
// provider/src/api/derpc.ts: CHAIN_ID = 1). Every other network is *listed* from the operator's own
// documentation, never marked verified. `verification` lives on the network, in one place, so no
// operator row can claim more than the provider can do.

export type NetworkId = "ethereum-mainnet" | "base" | "polygon" | "bnb-smart-chain" | "avalanche-c-chain";

/** "light-client": DeRPC proves reads on this network. "unverified": listed for reference only. */
export type Verification = "light-client" | "unverified";

export interface Network {
  id: NetworkId;
  name: string;
  short: string;
  chainId: number;
  verification: Verification;
  logoUrl?: string;
}

/** One network an operator serves, and where that claim comes from. */
export interface OperatorNetwork {
  network: NetworkId;
  /** True only if the DeRPC team ran proven reads on it through the operator. */
  tested: boolean;
  /** Public page that backs the claim. Required for every entry. */
  source: string;
  note?: string;
}

export interface DirectoryOperator {
  /** MOCK placeholder until the ENS milestone: nothing is registered under derpc.eth yet. */
  ens: string;
  operator: string;
  website: string;
  endpoint: string;
  /** Direct favicon/logo URL from the operator's domain. Used as avatar; falls back to initials. */
  logoUrl?: string;
  /** 1: fast, reliable proofs through Tor in our Nov 5 measurements. 2: slower or proof-window errors. */
  tier: 1 | 2;
  networks: OperatorNetwork[];
  /** Plain facts a user should know before choosing this operator. */
  warnings?: string[];
}

export const TIER_TEXT: Record<1 | 2, string> = {
  1: "Served proofs quickly and reliably through Tor in our Nov 5, 2026 measurements.",
  2: "Slower, or hit proof-window errors through some Tor exits, in our Nov 5, 2026 measurements.",
};

export const isVerified = (nets: Network[], id: NetworkId): boolean => nets.find((n) => n.id === id)?.verification === "light-client";
export const getNetwork = (nets: Network[], id: string): Network | undefined => nets.find((n) => n.id === id);
export const getOperator = (ops: DirectoryOperator[], ens: string): DirectoryOperator | undefined => ops.find((o) => o.ens === ens);
export const operatorsFor = (ops: DirectoryOperator[], id: NetworkId): DirectoryOperator[] => ops.filter((o) => o.networks.some((n) => n.network === id));
export const host = (url: string): string => new URL(url).host;

/**
 * Invariants the directory must keep. Returns the problems found (empty means valid).
 * Run by the test in provider/test/config/directory-sync.test.ts and at build time by the page in development.
 */
export function validateDirectory(nets: Network[], ops: DirectoryOperator[]): string[] {
  const problems: string[] = [];
  const netIds = new Set<string>();
  for (const n of nets) {
    if (netIds.has(n.id)) problems.push(`duplicate network ${n.id}`);
    netIds.add(n.id);
    if (n.verification === "light-client" && n.chainId !== 1) problems.push(`${n.id} is marked verified but DeRPC only proves Ethereum mainnet (chain 1)`);
  }
  if (!nets.some((n) => n.chainId === 1 && n.verification === "light-client")) problems.push("Ethereum mainnet must be the verified network");
  const ensSeen = new Set<string>();
  for (const o of ops) {
    if (ensSeen.has(o.ens)) problems.push(`duplicate operator ${o.ens}`);
    ensSeen.add(o.ens);
    if (o.networks.length === 0) problems.push(`${o.ens} lists no network`);
    const seen = new Set<string>();
    for (const on of o.networks) {
      if (!netIds.has(on.network)) problems.push(`${o.ens}: unknown network ${on.network}`);
      if (seen.has(on.network)) problems.push(`${o.ens}: network ${on.network} listed twice`);
      seen.add(on.network);
      if (!/^https:\/\//.test(on.source)) problems.push(`${o.ens}/${on.network}: source must be an https URL`);
      if (on.tested && !isVerified(nets, on.network)) problems.push(`${o.ens}/${on.network}: tested=true on a network DeRPC cannot verify`);
    }
    if (!/^https:\/\//.test(o.endpoint) || !/^https:\/\//.test(o.website)) problems.push(`${o.ens}: endpoint and website must be https URLs`);
  }
  return problems;
}
