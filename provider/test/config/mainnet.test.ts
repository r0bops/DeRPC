import { describe, expect, it } from "vitest";
import { TOR_JS_PIN, withGateways } from "../../src/config/mainnet.ts";

describe("tor-js worker config", () => {
  it("logs at warn by default", () => {
    expect(TOR_JS_PIN.config.logLevel).toBe("warn");
  });

  it("keeps the log level when gateways are overridden", () => {
    expect(withGateways(TOR_JS_PIN, ["gateway.test:1:hash"]).config.logLevel).toBe("warn");
  });
});
