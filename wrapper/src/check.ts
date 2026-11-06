import { checkRunningWrapper } from "./setup.ts";

try {
  const onion = process.env.DERPC_ONION_HOSTNAME;
  if (!onion) throw new Error("DERPC_ONION_HOSTNAME is required");
  await checkRunningWrapper(onion);
} catch (error) {
  console.error(`Check failed: ${error instanceof Error ? error.message : "unknown error"}. ENS records were not published.`);
  process.exitCode = 1;
}
