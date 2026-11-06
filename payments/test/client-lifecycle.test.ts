import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { PaymentClient, type PaymentSessionOptions } from "../src/client.ts";

const signer = privateKeyToAccount(`0x${"63".repeat(32)}`);
const options: PaymentSessionOptions = {
  chainId: 31337, escrow: `0x${"64".repeat(20)}`, operatorId: "operator",
  payer: `0x${"65".repeat(20)}`, payee: `0x${"66".repeat(20)}`,
  sessionId: 1n, signer, price: 10n, deposit: 100n, refundAfter: 5000,
};

describe("payment session finalization", () => {
  it.each([false, true])("returns the original final voucher after detachment (replacement: %s)", async replace => {
    const client = new PaymentClient({ now: () => 1_000_000 });
    client.addSession(options);
    const voucher = await (await client.begin("operator", "proof")).verified();
    const finished = client.finish("operator");
    client.removeSession("operator");
    if (replace) client.addSession({ ...options, sessionId: 2n });
    expect(await finished).toEqual(voucher);
    expect(await finished).not.toBe(voucher);
    if (replace) {
      expect(client.snapshot()[0]).toMatchObject({ sessionId: 2n, total: 0n, status: "ready" });
      expect(client.latestVoucher("operator")).toBeUndefined();
    }
  });
});
