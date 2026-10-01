import assert from "node:assert/strict";
import test from "node:test";

import { toEtsyAdsCsv, toEtsySoldOrderItemsCsv } from "../lng-web-be-import-csv.mjs";

test("serializes Etsy order items with provider headers and CSV escaping", () => {
  const csv = toEtsySoldOrderItemsCsv([{
    orderId: "123",
    buyerName: 'A, "B"',
    paidAt: "2026-10-01T00:00:00.000Z",
    items: [{ transactionId: "tx-1", listingId: "listing-1", sku: "SKU-1", itemName: "Name", quantity: 1, price: "12.50", currency: "USD" }],
  }]);

  assert.match(csv.split("\r\n")[0], /Order ID,Transaction ID,Listing ID/);
  assert.match(csv, /"A, ""B"""/);
  assert.match(csv, /123,tx-1,listing-1,SKU-1,Name,1/);
});

test("keeps zero-spend Etsy Ads rows", () => {
  const csv = toEtsyAdsCsv([{ date: "2026-10-01", listingId: "listing-1", spend: 0, currency: "USD", impressions: 4, clicks: 0 }]);

  assert.match(csv.split("\r\n")[0], /date,total cost,currency/);
  assert.match(csv, /2026-10-01,0,USD/);
});
