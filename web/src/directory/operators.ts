// Public bootstrap providers, not enrolled DeRPC operators. The `ens` values are retained only
// as legacy routing keys for saved choices and links, never displayed as registered identities.
//
// Where the facts come from:
// - ens, operator, website, endpoint, tier: provider/src/config/mainnet.ts (MAINNET_OPERATORS). A test in
//   provider/test/config/directory-sync.test.ts fails if this file drifts from it.
// - networks: the operator's own public documentation, linked on every entry (checked Nov 6, 2026).
//   DeRPC proved reads only on Ethereum mainnet (`tested: true`). The others are listed, not verified.
import type { DirectoryOperator, Network } from "./model.ts";

export const NETWORKS: Network[] = [
  { id: "ethereum-mainnet", name: "Ethereum", short: "ETH", chainId: 1, verification: "light-client" },
  { id: "base", name: "Base", short: "BASE", chainId: 8453, verification: "unverified" },
  { id: "polygon", name: "Polygon", short: "POL", chainId: 137, verification: "unverified" },
  { id: "bnb-smart-chain", name: "BNB Smart Chain", short: "BNB", chainId: 56, verification: "unverified" },
  { id: "avalanche-c-chain", name: "Avalanche C-Chain", short: "AVAX", chainId: 43114, verification: "unverified" },
];

const DRPC_BLOG = "https://blog.drpc.org/what-is-mev-blocker/";
const BLOCKRAZOR_CHAINS = "https://docs.blockrazor.io/get-started/supported-chains";

export const OPERATORS: DirectoryOperator[] = [
  {
    ens: "drpc.derpc.eth", operator: "dRPC", website: "https://drpc.org", endpoint: "https://eth.drpc.org", tier: 1,
    networks: [
      { network: "ethereum-mainnet", tested: true, source: "https://drpc.org/chainlist" },
      { network: "base", tested: false, source: DRPC_BLOG },
      { network: "polygon", tested: false, source: DRPC_BLOG },
      { network: "bnb-smart-chain", tested: false, source: DRPC_BLOG },
    ],
    warnings: ["dRPC lists 200+ networks. Only the ones with a source link here were checked against its pages."],
  },
  {
    ens: "mevblocker.derpc.eth", operator: "MEV Blocker", website: "https://mevblocker.io", endpoint: "https://rpc.mevblocker.io", tier: 1,
    networks: [{ network: "ethereum-mainnet", tested: true, source: "https://docs.mevblocker.io/", note: "Vendor docs: all features are supported on Ethereum." }],
  },
  {
    ens: "blockrazor.derpc.eth", operator: "BlockRazor", website: "https://blockrazor.io", endpoint: "https://eth.blockrazor.xyz", tier: 1,
    networks: [
      { network: "ethereum-mainnet", tested: true, source: "https://ethereum.org/developers/tools/blockrazor/" },
      { network: "bnb-smart-chain", tested: false, source: BLOCKRAZOR_CHAINS, note: "Service-specific: the docs list a BSC RPC." },
      { network: "base", tested: false, source: BLOCKRAZOR_CHAINS, note: "Service-specific: listed for transaction submission." },
    ],
  },
  {
    ens: "blast.derpc.eth", operator: "Blast API", website: "https://blastapi.io", endpoint: "https://eth-mainnet.public.blastapi.io", tier: 2,
    networks: [{ network: "ethereum-mainnet", tested: true, source: "https://blastapi.io/blog/important-blastapi-sunsetting-keep-your-apps-running-on-alchemy" }],
    warnings: [
      "The vendor announced that Blast API would be discontinued on Oct 31, 2025. This public endpoint still answered our proof reads on Nov 5, 2026, but it can disappear without notice.",
    ],
  },
  {
    ens: "publicnode.derpc.eth", operator: "PublicNode", website: "https://publicnode.com", endpoint: "https://ethereum-rpc.publicnode.com", tier: 2,
    networks: [
      { network: "ethereum-mainnet", tested: true, source: "https://publicnode.com", note: "Unreliable for proof requests through Tor in our tests." },
      { network: "avalanche-c-chain", tested: false, source: "https://docs.avax.network/tooling/rpc-providers" },
    ],
    warnings: ["PublicNode lists dozens of chains. Only the ones with a source link here were checked against its pages."],
  },
];
