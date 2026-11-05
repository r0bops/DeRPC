export interface Network {
  id: string;
  name: string;
  chainId: number;
  short: string;
  verified: boolean;
}

export interface ScoreBreakdown {
  uptime: number;
  correctness: number;
  latency: number;
  stake: number;
}

export interface Operator {
  ens: string;
  name: string;
  label: string;
  initials: string;
  region: string;
  stakeEth: number;
  score: number;
  uptime: number;
  latencyMs: number;
  pricePer1k: number;
  networks: string[];
  since: string;
  watchers: number;
  endpoint: string;
  about: string;
  breakdown: ScoreBreakdown;
}

export const networks: Network[] = [
  { id: "ethereum", name: "Ethereum", chainId: 1, short: "ETH", verified: true },
];

// The five shipped MAINNET_OPERATORS (provider/src/config/mainnet.ts). Their ENS names are mock labels
// (ENS_NAMES_ARE_MOCK). Stake, price, score and watchers are roadmap fields, so they stay at zero.
export const operators: Operator[] = [
  {
    ens: "drpc.derpc.eth",
    name: "drpc",
    label: "dRPC",
    initials: "DR",
    region: "Public endpoint",
    stakeEth: 0,
    score: 0,
    uptime: 0,
    latencyMs: 0,
    pricePer1k: 0,
    networks: ["ethereum"],
    since: "2026-11",
    watchers: 0,
    endpoint: "https://eth.drpc.org",
    about: "Public Ethereum mainnet RPC. DeRPC reaches it only through Tor and checks every answer against the light client.",
    breakdown: { uptime: 0, correctness: 0, latency: 0, stake: 0 },
  },
  {
    ens: "mevblocker.derpc.eth",
    name: "mevblocker",
    label: "MEV Blocker",
    initials: "MB",
    region: "Public endpoint",
    stakeEth: 0,
    score: 0,
    uptime: 0,
    latencyMs: 0,
    pricePer1k: 0,
    networks: ["ethereum"],
    since: "2026-11",
    watchers: 0,
    endpoint: "https://rpc.mevblocker.io",
    about: "Public Ethereum mainnet RPC. DeRPC reaches it only through Tor and checks every answer against the light client.",
    breakdown: { uptime: 0, correctness: 0, latency: 0, stake: 0 },
  },
  {
    ens: "blockrazor.derpc.eth",
    name: "blockrazor",
    label: "BlockRazor",
    initials: "BR",
    region: "Public endpoint",
    stakeEth: 0,
    score: 0,
    uptime: 0,
    latencyMs: 0,
    pricePer1k: 0,
    networks: ["ethereum"],
    since: "2026-11",
    watchers: 0,
    endpoint: "https://eth.blockrazor.xyz",
    about: "Public Ethereum mainnet RPC. DeRPC reaches it only through Tor and checks every answer against the light client.",
    breakdown: { uptime: 0, correctness: 0, latency: 0, stake: 0 },
  },
  {
    ens: "blast.derpc.eth",
    name: "blast",
    label: "Blast API",
    initials: "BA",
    region: "Public endpoint",
    stakeEth: 0,
    score: 0,
    uptime: 0,
    latencyMs: 0,
    pricePer1k: 0,
    networks: ["ethereum"],
    since: "2026-11",
    watchers: 0,
    endpoint: "https://eth-mainnet.public.blastapi.io",
    about: "Public Ethereum mainnet RPC. DeRPC reaches it only through Tor and checks every answer against the light client.",
    breakdown: { uptime: 0, correctness: 0, latency: 0, stake: 0 },
  },
  {
    ens: "publicnode.derpc.eth",
    name: "publicnode",
    label: "PublicNode",
    initials: "PN",
    region: "Public endpoint",
    stakeEth: 0,
    score: 0,
    uptime: 0,
    latencyMs: 0,
    pricePer1k: 0,
    networks: ["ethereum"],
    since: "2026-11",
    watchers: 0,
    endpoint: "https://ethereum-rpc.publicnode.com",
    about: "Public Ethereum mainnet RPC. DeRPC reaches it only through Tor and checks every answer against the light client.",
    breakdown: { uptime: 0, correctness: 0, latency: 0, stake: 0 },
  },
];

const networkIndex = new Map(networks.map((network) => [network.id, network]));

export function getNetwork(id: string): Network | undefined {
  return networkIndex.get(id);
}

export function getOperator(value: string): Operator | undefined {
  const normalized = decodeURIComponent(value).toLowerCase();
  return operators.find(
    (operator) =>
      operator.ens === normalized ||
      operator.name === normalized ||
      operator.label.toLowerCase() === normalized,
  );
}

export function operatorsForNetwork(id: string): Operator[] {
  return operators.filter((operator) => operator.networks.includes(id));
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

export interface NetworkStats {
  operatorCount: number;
  medianPrice: number;
  bestLatency: number;
  topScore: number;
}

export function networkStats(id: string): NetworkStats {
  const serving = operatorsForNetwork(id);
  return {
    operatorCount: serving.length,
    medianPrice: median(serving.map((operator) => operator.pricePer1k)),
    bestLatency: Math.min(...serving.map((operator) => operator.latencyMs)),
    topScore: Math.max(...serving.map((operator) => operator.score)),
  };
}

export function totalStakeEth(): number {
  return operators.reduce((sum, operator) => sum + operator.stakeEth, 0);
}

export function uptimeSeries(operator: Operator): number[] {
  const seed = [...operator.ens].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const series = Array.from({ length: 30 }, (_, index) => {
    const wave =
      Math.sin((index + 1) * 1.7 + seed) * 0.09 +
      Math.cos((index + 1) * 0.61 + seed * 0.3) * 0.06;
    return Math.min(100, Math.max(97, operator.uptime + wave - 0.03));
  });
  series[series.length - 1] = operator.uptime;
  return series.map((value) => Math.round(value * 100) / 100);
}

export function formatEth(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatPrice(value: number): string {
  return "$" + value.toFixed(2);
}

export function formatLatency(value: number): string {
  return value + " ms";
}

export function formatUptime(value: number): string {
  return value.toFixed(2) + "%";
}

export function formatMonth(value: string): string {
  const parts = value.split("-");
  const year = Number(parts[0] ?? 0);
  const month = Number(parts[1] ?? 1);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
