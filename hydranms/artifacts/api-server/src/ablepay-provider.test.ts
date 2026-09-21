import assert from "node:assert/strict";
import test from "node:test";
import {
  ablePayHash,
  buildAblePayPaymentFields,
  renderAblePayPaymentForm,
  verifyAblePayResponse,
} from "./lib/providers";

const envKeys = [
  "ABLEPAY_API_URL",
  "ABLEPAY_API_KEY",
  "ABLEPAY_SALT",
  "ABLEPAY_MODE",
  "ABLEPAY_DEFAULT_CITY",
  "ABLEPAY_DEFAULT_STATE",
  "ABLEPAY_DEFAULT_COUNTRY",
  "ABLEPAY_DEFAULT_ZIP_CODE",
  "ABLEPAY_TIMEOUT_SECONDS",
] as const;

test("builds an AblePay hosted payment form with a sorted SHA-512 hash", () => {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.ABLEPAY_API_URL = "https://uat.example.test";
    process.env.ABLEPAY_API_KEY = "merchant-key";
    process.env.ABLEPAY_SALT = "merchant-salt";
    process.env.ABLEPAY_MODE = "TEST";
    const payment = buildAblePayPaymentFields({
      orderId: "HYDRA-ORDER-123",
      amount: 499,
      currency: "INR",
      planId: "starter",
      companyId: "company-1",
      customerName: "Example Networks",
      customerEmail: "billing@example.test",
      customerPhone: "9876543210",
      address: "1 Test Street",
      returnUrl: "https://portal.example.test/api/billing/ablepay/return",
      failureUrl: "https://portal.example.test/api/billing/ablepay/failure",
      cancelUrl: "https://portal.example.test/api/billing/ablepay/cancel",
    });
    const { hash, ...withoutHash } = payment.fields;
    assert.equal(payment.action, "https://uat.example.test/v2/paymentrequest");
    assert.equal(hash, ablePayHash(withoutHash, "merchant-salt"));
    assert.match(renderAblePayPaymentForm(payment), /name="api_key" value="merchant-key"/);
    assert.match(renderAblePayPaymentForm(payment), /name="hash"/);
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("accepts an authentic AblePay response and rejects tampering", () => {
  const previous = process.env.ABLEPAY_SALT;
  process.env.ABLEPAY_SALT = "merchant-salt";
  try {
    const response: Record<string, unknown> = {
      order_id: "HYDRA-ORDER-123",
      response_code: "0",
      response_message: "Transaction Successful",
      amount: "499.00",
    };
    response.hash = ablePayHash(response, "merchant-salt");
    assert.equal(verifyAblePayResponse(response), true);
    response.amount = "1.00";
    assert.equal(verifyAblePayResponse(response), false);
    delete response.hash;
    assert.equal(verifyAblePayResponse(response), true);
  } finally {
    if (previous === undefined) delete process.env.ABLEPAY_SALT;
    else process.env.ABLEPAY_SALT = previous;
  }
});