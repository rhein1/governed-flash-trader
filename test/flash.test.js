// Flash v1 client tests: header-only auth, fail-closed credentials, v1 quote
// request shapes for every advanced order type, and the live-submit refusal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FLASH_BASE_URL,
  QUOTE_PATH,
  ORDER_PATH,
  orderStatusPath,
  orderCancelPath,
  assertApiKey,
  apiFetch,
  getQuote,
  getOrder,
  cancelOrder,
  submitOrder,
  buildOrderRequest,
} from "../src/flash.js";

describe("v1 endpoint constants", () => {
  it("targets the documented Flash v1 API", () => {
    assert.equal(FLASH_BASE_URL, "https://flash.definitive.fi/v1");
    assert.equal(QUOTE_PATH, "/quote");
    assert.equal(ORDER_PATH, "/order");
    assert.equal(orderStatusPath("abc"), "/orders/abc");
    assert.equal(orderCancelPath("abc"), "/orders/abc/cancel");
  });
});

describe("credential guardrails", () => {
  const refused = (e) => e.code === "FLASH_CREDENTIALS_REFUSED";

  it("refuses missing, placeholder, or dummy keys before any network", async () => {
    for (const bad of ["", "REPLACE_ME", "dpka_REPLACE_ME", "test-key", "example"]) {
      assert.throws(() => assertApiKey(bad), refused, bad);
    }
    let fetched = false;
    await assert.rejects(
      apiFetch({
        apiKey: "",
        method: "GET",
        path: "/quote",
        fetchImpl: async () => {
          fetched = true;
        },
      }),
      refused
    );
    assert.equal(fetched, false);
  });

  it("accepts a real-looking dpka_ key", () => {
    assert.equal(assertApiKey("dpka_abc123"), "dpka_abc123");
  });
});

describe("apiFetch", () => {
  it("sends the api-key header and parses JSON", async () => {
    let seen;
    const json = await apiFetch({
      apiKey: "dpka_test",
      method: "POST",
      path: "/quote",
      body: { orderType: "market" },
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, text: async () => '{"quoteId":"q1"}' };
      },
    });
    assert.equal(seen.url, "https://flash.definitive.fi/v1/quote");
    assert.equal(seen.opts.headers["x-definitive-api-key"], "dpka_test");
    assert.ok(!("x-definitive-signature" in seen.opts.headers), "no HMAC signature header");
    assert.deepEqual(json, { quoteId: "q1" });
  });

  it("maps failures to FLASH_REQUEST_FAILED with status", async () => {
    const err = await getQuote({
      apiKey: "dpka_test",
      orderRequest: { orderType: "market" },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"code":"unauthorized","message":"bad key"}}',
      }),
    }).catch((e) => e);
    assert.equal(err.code, "FLASH_REQUEST_FAILED");
    assert.equal(err.status, 401);
  });

  it("getOrder and cancelOrder hit the order paths", async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await getOrder({ apiKey: "dpka_test", orderId: "o1", fetchImpl });
    await cancelOrder({ apiKey: "dpka_test", orderId: "o1", fetchImpl });
    assert.deepEqual(urls, [
      "https://flash.definitive.fi/v1/orders/o1",
      "https://flash.definitive.fi/v1/orders/o1/cancel",
    ]);
  });
});

describe("submitOrder refusal", () => {
  it("always refuses: live submission needs a funder wallet this build does not hold", async () => {
    const err = await submitOrder().catch((e) => e);
    assert.equal(err.code, "LIVE_SUBMIT_UNAVAILABLE");
  });
});

describe("buildOrderRequest v1 shapes", () => {
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

  it("builds a v1 market quote request", () => {
    const req = buildOrderRequest(sig("market", {}));
    assert.equal(req.orderType, "market");
    assert.equal(req.targetChain, "base");
    assert.equal(req.contraChain, "base");
    assert.equal(req.side, "buy");
    assert.equal(req.qty, "250");
    assert.equal(req.targetAsset, WETH);
    assert.equal(req.contraAsset, USDC);
  });

  it("builds a limit order with limitNotionalPrice", () => {
    const req = buildOrderRequest(sig("limit", { limitPrice: "3800" }));
    assert.equal(req.orderType, "limit");
    assert.equal(req.limitNotionalPrice, "3800");
  });

  it("builds a TWAP order with duration and buckets", () => {
    const req = buildOrderRequest(sig("twap", { durationSeconds: 3600, twapBucketCount: 12 }));
    assert.equal(req.orderType, "twap");
    assert.equal(req.durationSeconds, 3600);
    assert.equal(req.twapBucketCount, 12);
  });

  it("rejects TWAP durations under the 300s minimum", () => {
    assert.throws(() => buildOrderRequest(sig("twap", { durationSeconds: 60 })), /durationSeconds >= 300/);
  });

  it("builds a stop order with an upper trigger", () => {
    const req = buildOrderRequest(sig("stop", { triggerPrice: "3900" }));
    assert.equal(req.orderType, "stop");
    assert.deepEqual(req.triggers, [{ notionalPrice: "3900", triggerType: "upper" }]);
  });

  it("builds a stop-loss with a lower trigger on the sell side", () => {
    const req = buildOrderRequest(
      sig("stop-loss", { triggerPrice: "3650", limitPrice: "3640" }, { orderSide: "sell" })
    );
    assert.equal(req.orderType, "stop-loss");
    assert.deepEqual(req.triggers, [{ notionalPrice: "3650", triggerType: "lower" }]);
    assert.equal(req.limitNotionalPrice, "3640");
  });

  it("builds a take-profit with an upper trigger on the sell side", () => {
    const req = buildOrderRequest(sig("take-profit", { triggerPrice: "4200" }, { orderSide: "sell" }));
    assert.equal(req.orderType, "take-profit");
    assert.deepEqual(req.triggers, [{ notionalPrice: "4200", triggerType: "upper" }]);
  });

  it("builds a bracket as lower+upper triggers", () => {
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
    assert.equal(req.orderType, "bracket");
    assert.deepEqual(req.triggers, [
      { notionalPrice: "3650", triggerType: "lower" },
      { notionalPrice: "4200", triggerType: "upper" },
    ]);
  });

  it("expands DCA into governed limit legs", () => {
    const built = buildOrderRequest(sig("dca", { dcaLegs: 3, limitPrice: "3800" }), {
      referencePriceUsd: 3850,
    });
    assert.equal(built.dcaLegs.length, 3);
    assert.deepEqual(
      built.dcaLegs.map((l) => l.leg),
      [1, 2, 3]
    );
    assert.ok(built.dcaLegs.every((l) => l.orderRequest.orderType === "limit"));
    assert.equal(built.dcaLegs[0].orderRequest.qty, "83.33");
    assert.equal(built.dcaLegs[0].orderRequest.limitNotionalPrice, "3800");
  });

  it("throws coded errors for malformed strategy params", () => {
    assert.throws(() => buildOrderRequest(sig("limit", {})), /limit strategy needs/);
    assert.throws(() => buildOrderRequest(sig("stop-loss", { triggerPrice: "1" })), /sell side/);
    assert.throws(() => buildOrderRequest(sig("bracket", { bracketLegs: [] })), /bracketLegs/);
    assert.throws(() => buildOrderRequest(sig("dca", { dcaLegs: 1 })), /dcaLegs/);
  });
});
