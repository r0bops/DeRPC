// The smallest DeRPC integration: a viem public client whose reads are private (Anon-RPC) and proven
// (light client + eth_getProof). It imports only the public package, nothing from the demo.
import { createDeRPC, MAINNET_OPERATORS } from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient, erc20Abi } from "viem";
import { mainnet } from "viem/chains";

// 1. The operators your user picked (for example in a settings screen). DeRPC never picks for them.
const userChoice = ["mevblocker.derpc.eth", "blockrazor.derpc.eth"];
const operators = MAINNET_OPERATORS.filter((o) => userChoice.includes(o.ens));

// 2. One DeRPC per app. It boots the pinned tor-js worker and syncs the light client through it.
const gateways = String(import.meta.env.VITE_TOR_GATEWAYS ?? "").split(",").filter(Boolean); // your tor-js gateway(s)
const derpc = createDeRPC({ operators, gateways });

// 3. A normal viem client. Pass blockTag "finalized": DeRPC proves state at the verified finalized block only.
const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });

const out = document.getElementById("out")!;
const print = (line: string) => (out.textContent += `${line}\n`);
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

print("starting DeRPC (worker, then light client)…");
derpc.ready.then(
  async () => {
    print(`ready: verified finalized block ${await client.getBlockNumber()}`);

    const balance = await client.getBalance({ address: WETH, blockTag: "finalized" });
    print(`proven: the WETH contract holds ${balance} wei`);

    try {
      await client.readContract({ address: WETH, abi: erc20Abi, functionName: "totalSupply" });
    } catch (error) {
      const root = (error as { walk: () => { code?: number; message: string } }).walk();
      print(`refused (${root.code}): ${root.message}`);
    }
  },
  (error: Error) => print(`DeRPC could not start, and nothing was sent directly: ${error.message}`),
);
