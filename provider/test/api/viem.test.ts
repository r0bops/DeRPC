// viem on top of the DeRPC provider: proven reads work, refusals surface as viem errors, and viem
// never multiplies the pool's own bounded retries.
import { describe, expect, it } from "vitest";
import { createPublicClient, erc20Abi } from "viem";
import { mainnet } from "viem/chains";
import { createEip1193Provider, type Eip1193Provider } from "../../src/api/eip1193.ts";
import { derpcTransport } from "../../src/api/viem.ts";
import { createPool } from "../../src/pool/pool.ts";
import { createPooledReader } from "../../src/pool/pooled-reader.ts";
import { RECORDED_HEADER, recordedEndpoint } from "../helpers/recorded-endpoint.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };

type Hex = `0x${string}`;
const { HOLDER, WETH } = fixture.inputs as { HOLDER: Hex; WETH: Hex };

function setup(opts: { failWith?: Error } = {}) {
  const endpoint = recordedEndpoint();
  const pool = createPool({ endpoints: [{ url: "https://operator.example", priority: 0 }], sendFor: () => endpoint.send });
  const headers = { finalized: () => RECORDED_HEADER };
  const reader = createPooledReader({ headers, pool });
  const { provider } = createEip1193Provider({
    chainId: 1,
    headers: async () => headers,
    reader: async () => {
      if (opts.failWith) throw opts.failWith;
      return reader;
    },
  });
  const requests: string[] = [];
  const counted: Eip1193Provider = { ...provider, request: (args) => (requests.push(args.method), provider.request(args)) };
  return { client: createPublicClient({ chain: mainnet, transport: derpcTransport(counted) }), requests };
}

describe("derpcTransport (viem)", () => {
  it("reads a proven balance through viem at the finalized block", async () => {
    const { client } = setup();

    expect(await client.getBalance({ address: WETH, blockTag: "finalized" })).toBe(BigInt(fixture.responses.wethWithSlots.balance));
    expect(await client.getTransactionCount({ address: HOLDER, blockTag: "finalized" })).toBe(Number(fixture.reference.holderNonce));
  });

  it("surfaces a refused eth_call as viem's unsupported-method error, asked once", async () => {
    const { client, requests } = setup();

    const error = await client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [HOLDER] }).catch((e) => e);

    expect(error.walk((e: any) => e.code === 4200)).toBeTruthy();
    expect(requests.filter((m) => m === "eth_call")).toHaveLength(1);
  });

  it("does not retry a failed read on top of the pool's own retries", async () => {
    const { client, requests } = setup({ failWith: new Error("unexpected") }); // -32603, which viem retries by default

    await client.getBalance({ address: WETH, blockTag: "finalized" }).catch(() => {});

    expect(requests).toEqual(["eth_getBalance"]);
  });
});
