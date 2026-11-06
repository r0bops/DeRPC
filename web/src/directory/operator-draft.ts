import { operatorUrl } from "../../../provider/src/operators/endpoint.ts";
import { MAX_OPERATOR_ENDPOINTS, serializeOperatorEndpoints, type OperatorEndpointRecord } from "../../../provider/src/operators/endpoints.ts";
import { getAddress, isAddress } from "viem";

/** A local planning document, deliberately not an ENS deployment configuration. */
export interface OperatorDraftInput {
  name: string;
  owner: string;
  signer: string;
  nodes: { key: string; id?: string; label: string; endpoint: string; beacon: string }[];
}

export interface OperatorDraft {
  kind: "derpc-operator-onboarding-draft";
  version: 1;
  status: "draft-not-registered";
  name: string;
  owner: string;
  signer: string;
  chainId: 1;
  nodes: { id: string; label: string; endpoint: string; beacon: string; health: "unchecked" }[];
  economics: {
    mode: "free";
    planned: { identityStake: "undecided"; perNodeStake: "traffic-dependent"; pricePerQuery: "operator-configurable" };
  };
  checks: { ownership: "unchecked"; nameAvailability: "unchecked"; reachability: "unchecked"; proofs: "unchecked" };
}

export type DraftResult = { draft: OperatorDraft; errors?: never } | { draft?: never; errors: Record<string, string> };
export const MAX_DRAFT_NODES = MAX_OPERATOR_ENDPOINTS;

export interface OperatorDeploymentInput {
  coldOwner: string;
  hotKey: string;
  payee: string;
  /** An explicit UTC date/time chosen by the operator, never regenerated during a review. */
  expiryUtc: string;
}

export interface OperatorConfigFragment {
  schemaVersion: 1;
  kind: "derpc-ens-operator-config-fragment";
  status: "unsigned-unverified-fragment";
  chainId: 1;
  parentName: "derpc.eth";
  operatorConfig: {
    label: string;
    operator: string;
    coldOwner: string;
    hotKey: string;
    signer: string;
    payee: string;
    endpoints: OperatorEndpointRecord[];
    caps: { chainId: 1; methods: ["eth_getProof", "eth_getCode"]; beacon: boolean };
    expiry: number;
  };
  record: { key: "derpc.endpoints"; value: string };
  remainingChecks: string[];
}

export type FragmentResult = { fragment: OperatorConfigFragment; errors?: never } | { fragment?: never; errors: Record<string, string> };

function publicEndpoint(value: string): string {
  const url = operatorUrl(value.trim());
  // Drafts contain public records only. Secrets and local node APIs belong in the wrapper config.
  if (url.search || url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local") || !url.hostname.includes(".") ||
      url.hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    throw new Error("Use a public hostname without a query string, credentials or local node address.");
  }
  return url.href;
}

export function createOperatorDraft(input: OperatorDraftInput): DraftResult {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(name)) {
    errors["operator-name"] = "Use 1–31 lowercase letters, numbers or hyphens; start and end with a letter or number.";
  }
  for (const field of ["owner", "signer"] as const) {
    if (!publicAddress(input[field])) {
      errors[`operator-${field}`] = "Enter a nonzero public Ethereum address; mixed-case addresses must have a valid checksum.";
    }
  }
  if (input.nodes.length < 1 || input.nodes.length > MAX_DRAFT_NODES) {
    errors["operator-nodes"] = `Add between 1 and ${MAX_DRAFT_NODES} nodes to this draft.`;
  }
  const endpointSeen = new Set<string>();
  const keys = new Set<string>();
  const ids = new Set<string>();
  const nodes: OperatorDraft["nodes"] = input.nodes.map(node => {
    const label = node.label.trim();
    const id = (node.id ?? node.key).trim();
    if (!label || label.length > 64) errors[`node-${node.key}-label`] = "Give this node a label of 1–64 characters.";
    if (!/^[a-z0-9-]{1,32}$/.test(node.key) || keys.has(node.key)) errors["operator-nodes"] = "Each node needs a unique draft ID.";
    keys.add(node.key);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(id) || ids.has(id)) {
      errors[`node-${node.key}-id`] = "Use a unique node ID of 1–31 lowercase letters, numbers or hyphens, without an edge hyphen.";
    }
    ids.add(id);
    const endpoints = { endpoint: "", beacon: "" };
    for (const field of ["endpoint", "beacon"] as const) {
      try {
        endpoints[field] = publicEndpoint(node[field]);
      } catch {
        errors[`node-${node.key}-${field}`] = "Use a public HTTPS hostname or a valid v3 onion URL, without credentials, query strings or fragments.";
      }
    }
    if (endpoints.endpoint && endpointSeen.has(endpoints.endpoint)) {
      errors[`node-${node.key}-endpoint`] = "This RPC endpoint is already listed in this draft.";
    }
    endpointSeen.add(endpoints.endpoint);
    return { id, label, ...endpoints, health: "unchecked" };
  });
  if (!Object.keys(errors).length) {
    try { serializeOperatorEndpoints(nodes.map(node => ({ id: node.id, url: node.endpoint, beaconUrl: node.beacon }))); }
    catch { errors["operator-nodes"] = "The complete endpoint list must use 1–8 unique node IDs and fit within 4,096 UTF-8 bytes. Shorten the URLs or remove a node."; }
  }
  if (Object.keys(errors).length) return { errors };
  return {
    draft: {
      kind: "derpc-operator-onboarding-draft", version: 1, status: "draft-not-registered",
      name: `${name}.derpc.eth`, owner: getAddress(input.owner.trim()), signer: getAddress(input.signer.trim()), chainId: 1, nodes,
      economics: { mode: "free", planned: { identityStake: "undecided", perNodeStake: "traffic-dependent", pricePerQuery: "operator-configurable" } },
      checks: { ownership: "unchecked", nameAvailability: "unchecked", reachability: "unchecked", proofs: "unchecked" },
    },
  };
}

function publicAddress(value: string): boolean {
  return isAddress(value.trim()) && !/^0x0{40}$/.test(value.trim());
}

/** Build one public operator entry for review, not a complete config or a transaction. */
export function createOperatorConfigFragment(draft: OperatorDraft, input: OperatorDeploymentInput, nowSeconds = Math.floor(Date.now() / 1000)): FragmentResult {
  const reviewed = createOperatorDraft({
    name: draft.name.replace(/\.derpc\.eth$/, ""), owner: draft.owner, signer: draft.signer,
    nodes: draft.nodes.map((node, i) => ({ key: String(i + 1), id: node.id, label: node.label, endpoint: node.endpoint, beacon: node.beacon })),
  });
  if (reviewed.errors) return { errors: reviewed.errors };
  const errors: Record<string, string> = {};
  for (const [key, field] of [["coldOwner", "operator-cold-owner"], ["hotKey", "operator-hot-key"], ["payee", "operator-payee"]] as const) {
    if (!publicAddress(input[key])) errors[field] = "Enter a nonzero public Ethereum address; mixed-case addresses must have a valid checksum.";
  }
  if (publicAddress(input.hotKey) && [draft.owner, input.coldOwner].some(address => address.trim().toLowerCase() === input.hotKey.trim().toLowerCase())) {
    errors["operator-hot-key"] = "Use a hot key distinct from this operator owner and resolver cold owner. It must also differ from the curator and other operators' owners and hot keys.";
  }
  const expiryText = input.expiryUtc.trim();
  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(expiryText) ? (expiryText.length === 16 ? `${expiryText}:00` : expiryText) : "";
  const expiry = canonical ? Date.parse(`${canonical}Z`) / 1000 : NaN;
  if (!Number.isSafeInteger(expiry) || new Date(expiry * 1000).toISOString().slice(0, 19) !== canonical ||
      !Number.isSafeInteger(nowSeconds) || nowSeconds <= 0 || expiry <= nowSeconds || expiry > nowSeconds + 30 * 86400) {
    errors["operator-expiry"] = "Choose a fixed UTC expiry in the future and within 30 days. The full deployment preflight must also check the parent name's expiry.";
  }
  if (Object.keys(errors).length) return { errors };
  const endpoints = reviewed.draft.nodes.map(node => ({ id: node.id, url: node.endpoint, beaconUrl: node.beacon }));
  const value = serializeOperatorEndpoints(endpoints);
  return {
    fragment: {
      schemaVersion: 1, kind: "derpc-ens-operator-config-fragment", status: "unsigned-unverified-fragment", chainId: 1, parentName: "derpc.eth",
      operatorConfig: {
        label: reviewed.draft.name.slice(0, -".derpc.eth".length), operator: reviewed.draft.owner,
        coldOwner: getAddress(input.coldOwner.trim()), hotKey: getAddress(input.hotKey.trim()), signer: reviewed.draft.signer,
        payee: getAddress(input.payee.trim()), endpoints,
        caps: { chainId: 1, methods: ["eth_getProof", "eth_getCode"], beacon: endpoints.every(node => !!node.beaconUrl) }, expiry,
      },
      record: { key: "derpc.endpoints", value },
      remainingChecks: [
        "Insert operatorConfig into a complete ENS config: schemaVersion 1, chainId 1, parentName derpc.eth, public curator/deployer, stable deploymentId and 2–3 independent operators.",
        "Run full config validation: labels and hot keys must be unique; each hot key must differ from the curator, every operator owner and every resolver cold owner.",
        "Refresh mainnet preflight: confirm parent ownership/permissions, exact contract code, name availability, future expiry within 30 days of chain time and no later than the parent lease.",
        "Verify each wrapper identity (including endpointId), public onion reachability and authenticated proof fixture; local field validation does not establish these checks.",
        "Prepare unsigned deployment plans, review exact permissions and transactions, obtain authorized wallet signatures, then verify receipts/runtime and a finalized client discovery refresh.",
      ],
    },
  };
}
