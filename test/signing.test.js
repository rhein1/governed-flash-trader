// HMAC signing tests, including a known-answer vector verified against
// openssl (independent implementation) so the canonicalization is pinned.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  preparePrehash,
  signRequest,
  signedFetch,
  buildOrderRequest,
} from "../src/flash.js";

describe("preparePrehash canonicalization", () => {
  it("joins method, path, query, timestamp, and sorted header pairs", () => {
    const p = preparePrehash({
      method: "POST",
      path: "/v2/portfolio/trade/quote",
      timestamp: "1699999999999",
      headers: {
        "x-definitive-timestamp": "1699999999999",
        "x-definitive-api-key": "dpka_test",
        "content-type": "application/json", // non x-definitive headers are excluded
      },
      queryParams: {},
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(
      p,
      'POST:/v2/portfolio/trade/quote?:1699999999999:x-definitive-api-key:"dpka_test",x-definitive-timestamp:"1699999999999"{"a":1}'
    );
  });
});

describe("signRequest known-answer vector", () => {
  it("matches the openssl-computed HMAC-SHA256 of the documented prehash", () => {
    // Verified independently with:
    //   printf 'POST:/v2/portfolio/trade/quote?:1699999999999:x-definitive-api-key:"dpka_test",x-definitive-timestamp:"1699999999999"{"a":1}' \
    //     | openssl dgst -sha256 -hmac "test-secret-123" -hex
    const { signature, prehash } = signRequest({
      apiKey: "dpka_test",
      apiSecret: "test-secret-123",
      method: "POST",
      path: "/v2/portfolio/trade/quote",
      queryParams: {},
      body: { a: 1 },
      timestamp: "1699999999999",
    });
    assert.equal(
      prehash,
      'POST:/v2/portfolio/trade/quote?:1699999999999:x-definitive-api-key:"dpka_test",x-definitive-timestamp:"1699999999999"{"a":1}'
    );
    assert.equal(signature, "65d73ef6725707d487c9a505573ea1ed5ab35363750151e71aa06ae9fa3c1c74");
  });

  it("strips the dpks_ secret prefix before signing", () => {
    const a = signRequest({
      apiKey: "dpka_test",
      apiSecret: "test-secret-123",
      method: "POST",
      path: "/v2/portfolio/trade/quote",
      body: { a: 1 },
      timestamp: "1699999999999",
    });
    const b = signRequest({
      apiKey: "dpka_test",
      apiSecret: "dpks_test-secret-123",
      method: "POST",
      path: "/v2/portfolio/trade/quote",
      body: { a: 1 },
      timestamp: "1699999999999",
    });
    assert.equal(a.signature, b.signature);
  });
});

describe("buildOrderRequest", () => {
  const WETH = "0x4200000000000000000000000000000000000006";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  const sig = (strategy, params, over = {}) => ({
    chain: "base",
    targetAsset: WETH,
    contraAsset: USDC,
    orderSide: "buy",
    strategy,
    notionalUsd: "250",
    params,
    ...over,
  });

  it("builds a limit order from a limit signal", () => {
    const req = buildOrderRequest(sig("limit", { limitPrice: "3800" }), { referencePriceUsd: 3850 });
    assert.equal(req.type, "limit");
    assert.deepEqual(req.limit, { price: "3800", isNotional: true });
    assert.equal(req.qty, "250");
    assert.equal(req.chain, "base");
  });

  it("builds a TWAP order with params", () => {
    const req = buildOrderRequest(sig("twap", { durationSeconds: 3600, targetTWAPBuckets: 12 }));
    assert.equal(req.type, "twap");
    assert.equal(req.durationSeconds, 3600);
    assert.equal(req.targetTWAPBuckets, 12);
  });

  it("builds a stop-loss order on the sell side", () => {
    const req = buildOrderRequest(
      sig("stop-loss", { triggerPrice: "3650", limitPrice: "3640" }, { orderSide: "sell" })
    );
    assert.equal(req.type, "stop-loss");
    assert.deepEqual(req.trigger, { price: "3650", isNotional: true });
    assert.deepEqual(req.limit, { price: "3640", isNotional: true });
  });

  it("builds a bracket with stop-loss and take-profit legs", () => {
    const req = buildOrderRequest(
      sig(
        "bracket",
        {
          bracketLegs: [
            { price: "3650", kind: "stop-loss" },
            { price: "4200", kind: "take-profit" },
          ],
        },
        { orderSide: "sell" }
      )
    );
    assert.equal(req.type, "bracket");
    assert.equal(req.orderTrigger.type, "Trigger_StopBracket");
    assert.equal(req.orderTrigger.limits.length, 2);
    assert.equal(req.orderTrigger.limits[0].isLower, true);
    assert.equal(req.orderTrigger.limits[1].isLower, false);
  });

  it("expands DCA into multiple governed limit legs", () => {
    const built = buildOrderRequest(sig("dca", { dcaLegs: 3, limitPrice: "3800" }), {
      referencePriceUsd: 3850,
    });
    assert.equal(built.dcaLegs.length, 3);
    assert.deepEqual(
      built.dcaLegs.map((l) => l.leg),
      [1, 2, 3]
    );
    assert.ok(built.dcaLegs.every((l) => l.orderRequest.type === "limit"));
    assert.equal(built.dcaLegs[0].orderRequest.qty, "83.33");
    assert.deepEqual(built.dcaLegs[0].orderRequest.limit, { price: "3800", isNotional: true });
  });

  it("defaults a market order for the market strategy", () => {
    const req = buildOrderRequest(sig("market", {}));
    assert.equal(req.type, "market");
  });

  it("throws a coded error for malformed strategy params", () => {
    assert.throws(() => buildOrderRequest(sig("limit", {})), /limit strategy needs/);
    assert.throws(() => buildOrderRequest(sig("stop-loss", { triggerPrice: "1" })), /sell side/);
  });
});

describe("credential guardrails", () => {
  const refused = (e) => e.code === "FLASH_CREDENTIALS_REFUSED";

  it("refuses to sign without credentials or with placeholders", () => {
    assert.throws(
      () => signRequest({ apiKey: "", apiSecret: "x", method: "GET", path: "/p", body: null }),
      refused
    );
    assert.throws(
      () =>
        signRequest({
          apiKey: "REPLACE_ME",
          apiSecret: "x",
          method: "GET",
          path: "/p",
          body: null,
        }),
      refused
    );
  });

  it("signedFetch refuses before any network without credentials", async () => {
    let fetched = false;
    await assert.rejects(
      signedFetch({
        apiKey: "",
        apiSecret: "",
        method: "GET",
        path: "/p",
        fetchImpl: async () => {
          fetched = true;
        },
      }),
      refused
    );
    assert.equal(fetched, false);
  });
});
