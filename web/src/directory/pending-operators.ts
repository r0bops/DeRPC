import configuration from "../../../contracts/deployments/ens-two-demo-operators-config-2026-11-07.json?raw";
import unsignedPlan from "../../../contracts/deployments/ens-open-registration-plan-1-2026-11-07.json?raw";

export interface TeamOperatorConfig {
  label: string;
  operator: string;
  coldOwner: string;
  hotKey: string;
  signer: string;
  payee: string;
  endpoint: string;
  beacon: string;
  caps: { chainId: 1; methods: string[]; beacon: boolean };
  expiry: number;
  gateways: string[];
}

/** Trusted build input only: unsigned preparation, never a source of read-pool authority. */
export const TEAM_REGISTRATION_CONFIG = JSON.parse(configuration) as {
  schemaVersion: 1; chainId: 1; parentName: "derpc.eth"; deploymentId: string;
  curator: string; deployer: string; operators: TeamOperatorConfig[];
};
if (TEAM_REGISTRATION_CONFIG.chainId !== 1 || TEAM_REGISTRATION_CONFIG.parentName !== "derpc.eth" ||
    TEAM_REGISTRATION_CONFIG.operators.length !== 2 || TEAM_REGISTRATION_CONFIG.operators.some(operator =>
      !operator.endpoint || !operator.beacon || "endpoints" in operator)) {
  throw new Error("Team preparation requires the two reviewed singular operator entries.");
}

/** Both proxies share team ownership. A proven ENS refresh remains the membership authority. */
export const PENDING_OPERATORS = TEAM_REGISTRATION_CONFIG.operators.map(operator => ({
  name: `${operator.label}.derpc.eth`, label: operator.label, enrollment: "pending" as const,
  endpoint: operator.endpoint, beacon: operator.beacon,
}));

export const TEAM_REGISTRATION_PLAN = JSON.parse(unsignedPlan) as {
  kind: "derpc-ens-unsigned-plan"; chainId: 1; stage: string; status: string;
  resumeConfig: typeof TEAM_REGISTRATION_CONFIG;
  transactions: { id: string; purpose: string; estimatedGas: string }[];
};
if (TEAM_REGISTRATION_PLAN.kind !== "derpc-ens-unsigned-plan" || TEAM_REGISTRATION_PLAN.chainId !== 1 ||
    JSON.stringify(TEAM_REGISTRATION_PLAN.resumeConfig) !== JSON.stringify(TEAM_REGISTRATION_CONFIG)) {
  throw new Error("Team registration plan must match the reviewed two-operator configuration.");
}

export function teamRegistrationFragment(label: string | null) {
  const operator = TEAM_REGISTRATION_CONFIG.operators.find(entry => entry.label === label);
  return operator ? {
    schemaVersion: 1, kind: "derpc-ens-operator-config-fragment", status: "unsigned-unverified-fragment",
    chainId: 1, parentName: "derpc.eth", operatorConfig: structuredClone(operator),
  } : undefined;
}
