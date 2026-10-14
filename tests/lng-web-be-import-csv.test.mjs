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

test("serializes real collector fields and charges order tax/shipping only once", () => {
  const result = toEtsySoldOrderItemsCsv([{
    orderId: "123", currency: "USD",
    shipping: { name: "Buyer", address1: "Street", address2: "Apt", city: "City", state: "CA", zipcode: "90001", country: "US" },
    totals: { orderShipping: 4.25, orderSalesTax: 1.5 },
    items: [
      { transactionId: "t1", listingId: "l1", quantity: 2, unitPrice: 10, itemTotal: 20, variationsRaw: '[{"formatted_name":"Size","formatted_value":"L"}]', variations: { Size: "L", Color: "Blue" }, customizations: { textFields: [{ name: "Name", value: "Jane" }] } },
      { transactionId: "t2", listingId: "l2", quantity: 1, unitPrice: 0, itemTotal: 0 },
    ],
  }]);
  assert.match(result, /2,"Size: L, Color: Blue",Name: Jane,10,20,1.5,4.25,USD/);
  assert.match(result, /Buyer,Street,Apt,City,CA,90001,US/);
  assert.match(result, /t2,l2,,,1,,,0,0,0,0,USD/);
});

test("rejects missing transaction identity before upload", () => {
  assert.throws(() => toEtsySoldOrderItemsCsv([{ orderId: "123", items: [{}] }]), /Transaction ID/);
});
