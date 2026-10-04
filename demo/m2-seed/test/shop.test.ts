import { test } from "node:test";
import assert from "node:assert/strict";
import { calcTotal, shippingFee } from "../src/pricing.ts";
import { PRICES, priceOf } from "../src/catalog.ts";

test("calcTotal sums price x qty", () => {
  assert.equal(calcTotal([{ sku: "a", price: 3, qty: 4 }, { sku: "b", price: 5, qty: 2 }]), 22);
});

test("shippingFee is flat for a non-empty cart", () => {
  assert.equal(shippingFee([{ sku: "a", price: 3, qty: 1 }]), 5);
  assert.equal(shippingFee([]), 0);
});

test("every catalog price is positive", () => {
  for (const sku of Object.keys(PRICES)) assert.ok(priceOf(sku) > 0, sku);
});
