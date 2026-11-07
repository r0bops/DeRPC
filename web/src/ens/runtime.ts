import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
// The shared core deliberately remains browser-safe JavaScript for the CLI and website.
// @ts-expect-error Shared JavaScript core has no TypeScript declaration.
import { validateJoinConfig, checkJoinIdentity, joinConfigFromDeployment, expectedJoinTransaction, prepareJoinPlan, verifyJoin, enrollmentPins } from "../../../contracts/lib/ens-join.mjs";
// @ts-expect-error Shared JavaScript core has no TypeScript declaration.
import { directoryPins, checkSubmittedTransaction } from "../../../contracts/lib/ens-wallet.mjs";
// @ts-expect-error Shared JavaScript core has no TypeScript declaration.
import { prepareOperatorLifecycle, checkOperatorLifecyclePlan, verifyOperatorLifecycle, expectedOperatorLifecycleTransaction, operatorLifecycleOperators } from "../../../contracts/lib/ens-lifecycle.mjs";
import { serialise, type Data, type SessionAdapter } from "./session.ts";

export interface OperatorRuntime {
  configured: boolean; origins: string[];
  clients: [Data, Data];
  join(operator: Data): { config: Data; adapter: SessionAdapter };
  manage(action: Data, enrollment?: Data): { config: Data; adapter: SessionAdapter };
  restore(saved: Data): { config: Data; adapter: SessionAdapter };
  operators(enrollment?: Data): Data[];
}

export function createOperatorRuntime(configuration: { deployment: Data | null; build: Data; adminRpcUrls: readonly [string, string] }): OperatorRuntime {
  const { deployment, build, adminRpcUrls } = configuration;
  const origins = adminRpcUrls.map((url: string) => new URL(url).origin);
  if (new Set(origins).size !== 2) throw new Error("Two distinct administrative RPC sources are required.");
  const clients = adminRpcUrls.map((url: string) => createPublicClient({ chain: mainnet, ccipRead: false, transport: http(url, { retryCount: 0, timeout: 20_000 }) })) as unknown as [Data, Data];
  const requireDeployment = () => { if (!deployment) throw new Error("Registration and management are disabled until a verified public registrar deployment is configured."); return deployment; };
  const pins = () => directoryPins(requireDeployment());
  const validate = (input: Data) => {
    const checked = validateJoinConfig(input);
    if (serialise(checked.directory).toLowerCase() !== serialise(pins()).toLowerCase() || checked.curator.toLowerCase() !== requireDeployment().curator.toLowerCase()) throw new Error("Operator input cannot replace the website's reviewed deployment pins or namespace owner.");
    return checked;
  };
  const joinAdapter: SessionAdapter = {
    id: "operator-join", build, validateInput: validate,
    checkIdentity: (a, b) => { validate(a); validate(b); checkJoinIdentity(a, b); },
    reconstruct: (item, config, plan) => expectedJoinTransaction(item, validate(config), plan, build),
    prepare: (config, client) => prepareJoinPlan({ config: validate(config), client, build }),
    verify: (config, stages, client) => verifyJoin({ config: validate(config), stages, client, build, confirmations: 12 }),
    pins: enrollmentPins, checkTransaction: checkSubmittedTransaction,
  };
  const operators = (enrollment?: Data) => operatorLifecycleOperators({ deployment: requireDeployment(), enrollment, build });
  const managementAdapter: SessionAdapter = {
    id: "operator-management", build,
    validateInput(input) {
      if (input.kind !== "derpc-browser-operator-management" || input.schemaVersion !== 1 || input.chainId !== 1 || input.parentName !== "derpc.eth" ||
          Object.keys(input).some(key => !["kind", "schemaVersion", "chainId", "parentName", "operators", "action", "enrollment"].includes(key)) ||
          !["renew", "rotate-endpoint", "rotate-endpoints"].includes(input.action?.type)) throw new Error("Choose operator renewal or an endpoint-key update.");
      const op = operators(input.enrollment).find((entry: Data) => entry.name === `${input.action.label}.derpc.eth`);
      if (!op || input.operators?.length !== 1 || input.operators[0].label !== input.action.label || input.operators[0].operator !== op.operator) throw new Error("Management input does not match the configured operator identity.");
      return input;
    },
    checkIdentity(a, b) { managementAdapter.validateInput(a); managementAdapter.validateInput(b); if (serialise(a) !== serialise(b)) throw new Error("Management intent changed."); },
    reconstruct(_item, input, plan) {
      managementAdapter.validateInput(input);
      if (serialise(plan.lifecycle?.action) !== serialise(input.action)) throw new Error("Saved management action changed.");
      return expectedOperatorLifecycleTransaction({ deployment: requireDeployment(), enrollment: input.enrollment, plan: plan.lifecycle, build });
    },
    async prepare(input, client, stages) {
      managementAdapter.validateInput(input);
      if (stages[0]?.transactionHashes[0]) {
        await managementAdapter.verify(input, stages, client);
        const plan = structuredClone(stages[0]!.plan), block = await client.getBlock({ blockTag: "latest" });
        return { ...plan, stage: "complete", status: "state-matches-config", transactions: [], preflight: { ...plan.preflight, blockNumber: block.number.toString(), blockHash: block.hash } };
      }
      const plan = await prepareOperatorLifecycle({ deployment: requireDeployment(), enrollment: input.enrollment, action: input.action, client, build });
      return { schemaVersion: 1, kind: "derpc-ens-unsigned-plan", flow: "operator-management", chainId: 1, sourceHash: build.sourceHash, compiler: build.compiler,
        stage: input.action.type, resumeConfig: input, lifecycle: plan, roleTable: [],
        preflight: { localOnly: plan.localOnly, blockNumber: plan.before.block.number, blockHash: plan.before.block.hash },
        transactions: [{ id: `${input.action.type}-${input.action.label}`, purpose: `${input.action.type === "renew" ? "Renew the operator lease" : "Update the endpoint record with its scoped key"}: ${input.action.label}.derpc.eth`, estimatedGas: plan.estimatedGas, walletRequest: plan.walletRequest }] };
    },
    async verify(input, stages, client) {
      if (stages.length !== 1 || stages[0]!.transactionHashes.length !== 1) throw new Error("Retain the exact management stage and transaction hash.");
      return verifyOperatorLifecycle({ deployment: requireDeployment(), enrollment: input.enrollment, plan: stages[0]!.plan.lifecycle, transactionHash: stages[0]!.transactionHashes[0], client, confirmations: 12, build });
    },
    pins(manifest) {
      if (manifest.kind !== "derpc-ens-lifecycle-evidence" || manifest.localOnly !== false || manifest.verification?.exactRequest !== true || manifest.verification?.rolesAndRuntime !== true) throw new Error("Management receipt is not verified.");
      return pins();
    },
    checkTransaction: checkSubmittedTransaction,
    recheck: (input, plan, client) => checkOperatorLifecyclePlan({ deployment: requireDeployment(), enrollment: input.enrollment, plan: plan.lifecycle, client, build }),
  };
  return { configured: !!deployment, origins, clients, operators,
    join: operator => ({ config: joinConfigFromDeployment({ manifest: requireDeployment(), operator }), adapter: joinAdapter }),
    manage(action, enrollment) {
      const op = operators(enrollment).find((entry: Data) => entry.name === `${action.label}.derpc.eth`);
      if (!op) throw new Error("Choose an operator from the configured deployment or reverified enrollment evidence.");
      const config = { schemaVersion: 1, kind: "derpc-browser-operator-management", chainId: 1, parentName: "derpc.eth", operators: [{ label: action.label, operator: op.operator }], action, ...(enrollment ? { enrollment } : {}) };
      return { config: managementAdapter.validateInput(config), adapter: managementAdapter };
    },
    restore(saved) {
      const adapter = saved.adapter === joinAdapter.id ? joinAdapter : saved.adapter === managementAdapter.id ? managementAdapter : null;
      if (!adapter) throw new Error("Unknown saved ENS operation. Evidence has not been replaced.");
      return { config: adapter.validateInput(saved.input), adapter };
    },
  };
}
