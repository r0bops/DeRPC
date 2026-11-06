import { operatorUrl } from "../../../provider/src/operators/endpoint.ts";

/** A local planning document, deliberately not an ENS deployment configuration. */
export interface OperatorDraftInput {
  name: string;
  owner: string;
  signer: string;
  nodes: { key: string; label: string; endpoint: string; beacon: string }[];
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
export const MAX_DRAFT_NODES = 8;

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
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    errors["operator-name"] = "Use 1–63 lowercase letters, numbers or hyphens; start and end with a letter or number.";
  }
  for (const field of ["owner", "signer"] as const) {
    if (!/^0x[\da-fA-F]{40}$/.test(input[field].trim()) || /^0x0{40}$/.test(input[field].trim())) {
      errors[`operator-${field}`] = "Enter a nonzero public Ethereum address: 0x followed by 40 hexadecimal characters.";
    }
  }
  if (input.nodes.length < 1 || input.nodes.length > MAX_DRAFT_NODES) {
    errors["operator-nodes"] = `Add between 1 and ${MAX_DRAFT_NODES} nodes to this draft.`;
  }
  const endpointSeen = new Set<string>();
  const keys = new Set<string>();
  const nodes: OperatorDraft["nodes"] = input.nodes.map(node => {
    const label = node.label.trim();
    if (!label || label.length > 64) errors[`node-${node.key}-label`] = "Give this node a label of 1–64 characters.";
    if (!/^[a-z0-9-]{1,32}$/.test(node.key) || keys.has(node.key)) errors["operator-nodes"] = "Each node needs a unique draft ID.";
    keys.add(node.key);
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
    return { id: node.key, label, ...endpoints, health: "unchecked" };
  });
  if (Object.keys(errors).length) return { errors };
  return {
    draft: {
      kind: "derpc-operator-onboarding-draft", version: 1, status: "draft-not-registered",
      name: `${name}.derpc.eth`, owner: input.owner.trim(), signer: input.signer.trim(), chainId: 1, nodes,
      economics: { mode: "free", planned: { identityStake: "undecided", perNodeStake: "traffic-dependent", pricePerQuery: "operator-configurable" } },
      checks: { ownership: "unchecked", nameAvailability: "unchecked", reachability: "unchecked", proofs: "unchecked" },
    },
  };
}
