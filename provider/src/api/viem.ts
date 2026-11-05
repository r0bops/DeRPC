// viem integration, imported from "@derpc/provider/viem" so other users don't pull in viem.
import { custom, type CustomTransport } from "viem";
import type { Eip1193Provider } from "./eip1193.ts";

/**
 * A viem transport over the DeRPC provider. Use it with a public client and pass `blockTag: "finalized"`
 * (viem defaults to "latest", which DeRPC can't prove and refuses).
 *
 * Retries are off: the pool already retries each read on other chosen operators, within bounds, and a
 * second layer of retries would only send the same query to more operators.
 */
export function derpcTransport(provider: Pick<Eip1193Provider, "request"> | { provider: Pick<Eip1193Provider, "request"> }): CustomTransport {
  const target = "provider" in provider ? provider.provider : provider;
  return custom({ request: (args) => target.request(args) }, { key: "derpc", name: "DeRPC", retryCount: 0 });
}
