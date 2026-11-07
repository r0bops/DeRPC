import configuration from "virtual:derpc-ens-operator";
import { createOperatorRuntime } from "./runtime.ts";

/** Only the build's reviewed deployment and administrative sources enter the live UI. */
export const operatorRuntime = () => createOperatorRuntime(configuration);
