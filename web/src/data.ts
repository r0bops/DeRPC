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
  { id: "base", name: "Base", chainId: 8453, short: "BASE", verified: true },
  { id: "arbitrum", name: "Arbitrum", chainId: 42161, short: "ARB", verified: true },
  { id: "optimism", name: "Optimism", chainId: 10, short: "OP", verified: true },
  { id: "polygon", name: "Polygon", chainId: 137, short: "POL", verified: false },
  { id: "gnosis", name: "Gnosis", chainId: 100, short: "GNO", verified: false },
];

export const operators: Operator[] = [
  {
    ens: "mor.ops.derpc.eth",
    name: "mor",
    label: "MEV Blocker",
    initials: "MB",
    region: "Amsterdam, NL",
    stakeEth: 2400,
    score: 96.8,
    uptime: 99.94,
    latencyMs: 38,
    pricePer1k: 0.42,
    networks: ["ethereum", "base", "arbitrum", "optimism"],
    since: "2024-03",
    watchers: 3,
    endpoint: "https://rpc.mor.derpc.eth",
    about: "Low-latency routing from Amsterdam with MEV-protected reads.",
    breakdown: { uptime: 98, correctness: 97, latency: 95, stake: 100 },
  },
  {
    ens: "river.ops.derpc.eth",
    name: "river",
    label: "River Relay",
    initials: "RR",
    region: "Frankfurt, DE",
    stakeEth: 1850,
    score: 94.2,
    uptime: 99.88,
    latencyMs: 47,
    pricePer1k: 0.39,
    networks: ["ethereum", "base", "arbitrum"],
    since: "2024-05",
    watchers: 3,
    endpoint: "https://rpc.river.derpc.eth",
    about: "A relay focused on predictable pricing and long-lived connections.",
    breakdown: { uptime: 96, correctness: 96, latency: 92, stake: 92 },
  },
  {
    ens: "northstar.ops.derpc.eth",
    name: "northstar",
    label: "Northstar",
    initials: "NO",
    region: "London, UK",
    stakeEth: 1600,
    score: 92.7,
    uptime: 99.82,
    latencyMs: 42,
    pricePer1k: 0.45,
    networks: ["ethereum", "base", "optimism"],
    since: "2024-02",
    watchers: 3,
    endpoint: "https://rpc.northstar.derpc.eth",
    about: "Independent infrastructure with a focus on archive reads.",
    breakdown: { uptime: 94, correctness: 97, latency: 94, stake: 88 },
  },
  {
    ens: "kite.ops.derpc.eth",
    name: "kite",
    label: "Kite",
    initials: "KI",
    region: "Singapore, SG",
    stakeEth: 1450,
    score: 91.4,
    uptime: 99.76,
    latencyMs: 55,
    pricePer1k: 0.48,
    networks: ["base", "arbitrum", "optimism"],
    since: "2024-08",
    watchers: 2,
    endpoint: "https://rpc.kite.derpc.eth",
    about: "Asia-Pacific routing for L2 reads, with daily proof refresh.",
    breakdown: { uptime: 92, correctness: 95, latency: 88, stake: 84 },
  },
  {
    ens: "harbor.ops.derpc.eth",
    name: "harbor",
    label: "Harbor",
    initials: "HA",
    region: "New York, US",
    stakeEth: 1250,
    score: 89.8,
    uptime: 99.61,
    latencyMs: 61,
    pricePer1k: 0.52,
    networks: ["ethereum", "gnosis"],
    since: "2023-11",
    watchers: 3,
    endpoint: "https://rpc.harbor.derpc.eth",
    about: "Long-running Ethereum infrastructure with a conservative upgrade path.",
    breakdown: { uptime: 90, correctness: 94, latency: 84, stake: 80 },
  },
  {
    ens: "atlas.ops.derpc.eth",
    name: "atlas",
    label: "Atlas",
    initials: "AT",
    region: "Warsaw, PL",
    stakeEth: 1100,
    score: 88.5,
    uptime: 99.55,
    latencyMs: 44,
    pricePer1k: 0.41,
    networks: ["ethereum", "base", "arbitrum", "optimism", "polygon", "gnosis"],
    since: "2024-01",
    watchers: 3,
    endpoint: "https://rpc.atlas.derpc.eth",
    about: "Broad chain coverage from a single endpoint and a single ENS name.",
    breakdown: { uptime: 89, correctness: 93, latency: 90, stake: 76 },
  },
  {
    ens: "sable.ops.derpc.eth",
    name: "sable",
    label: "Sable",
    initials: "SA",
    region: "Zurich, CH",
    stakeEth: 950,
    score: 84.1,
    uptime: 99.12,
    latencyMs: 72,
    pricePer1k: 0.56,
    networks: ["ethereum", "polygon"],
    since: "2024-09",
    watchers: 2,
    endpoint: "https://rpc.sable.derpc.eth",
    about: "A smaller operator with direct support and pinned endpoints.",
    breakdown: { uptime: 82, correctness: 91, latency: 74, stake: 70 },
  },
  {
    ens: "tempo.ops.derpc.eth",
    name: "tempo",
    label: "Tempo",
    initials: "TE",
    region: "Tokyo, JP",
    stakeEth: 850,
    score: 86.9,
    uptime: 99.44,
    latencyMs: 58,
    pricePer1k: 0.47,
    networks: ["base", "arbitrum", "optimism"],
    since: "2024-06",
    watchers: 2,
    endpoint: "https://rpc.tempo.derpc.eth",
    about: "Low-latency L2 access from Tokyo, with per-network health checks.",
    breakdown: { uptime: 86, correctness: 92, latency: 86, stake: 68 },
  },
  {
    ens: "quartz.ops.derpc.eth",
    name: "quartz",
    label: "Quartz",
    initials: "QU",
    region: "Sao Paulo, BR",
    stakeEth: 1300,
    score: 82.3,
    uptime: 98.87,
    latencyMs: 81,
    pricePer1k: 0.59,
    networks: ["ethereum", "gnosis"],
    since: "2025-01",
    watchers: 2,
    endpoint: "https://rpc.quartz.derpc.eth",
    about: "Newer infrastructure serving South America and archive workloads.",
    breakdown: { uptime: 78, correctness: 89, latency: 70, stake: 82 },
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
