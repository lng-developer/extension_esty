import assert from "node:assert/strict";
import test from "node:test";

import { runSerialTrackingBatch } from "../etsy-tracking-command.mjs";

test("uploads tracking rows serially and continues after a row failure", async () => {
  const calls = [];
  const result = await runSerialTrackingBatch({
    items: [
      { orderId: "one", trackingNumber: "first" },
      { orderId: "two", trackingNumber: "second" },
      { orderId: "three", trackingNumber: "third" }
    ],
    upload: async (row) => {
      calls.push(row.orderId);
      if (row.orderId === "two") throw new Error("Etsy rejected row");
      return { uploadedAt: row.orderId };
    }
  });

  assert.deepEqual(calls, ["one", "two", "three"]);
  assert.deepEqual(result, {
    importedCount: 2,
    failedCount: 1,
    results: [
      { orderId: "one", trackingNumber: "first", ok: true, data: { uploadedAt: "one" } },
      { orderId: "two", trackingNumber: "second", ok: false, errorMessage: "Etsy rejected row" },
      { orderId: "three", trackingNumber: "third", ok: true, data: { uploadedAt: "three" } }
    ]
  });
});

test("renews the command lease before every tracking row", async () => {
  const calls = [];
  await runSerialTrackingBatch({
    items: [{ orderId: "one", trackingNumber: "first" }, { orderId: "two", trackingNumber: "second" }],
    beforeEach: async (row) => calls.push(`renew:${row.orderId}`),
    upload: async (row) => calls.push(`upload:${row.orderId}`)
  });

  assert.deepEqual(calls, ["renew:one", "upload:one", "renew:two", "upload:two"]);
});
