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
      { orderId: "one", trackingNumber: "first", carrier: null, ok: true, etsyStatus: "ETSY_ACCEPTED" },
      { orderId: "two", trackingNumber: "second", carrier: null, etsyStatus: "FAILED", ok: false, errorMessage: "Etsy rejected row" },
      { orderId: "three", trackingNumber: "third", carrier: null, ok: true, etsyStatus: "ETSY_ACCEPTED" }
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

test("marks an accepted upload verified only after Etsy confirms its tracking number", async () => {
  const result = await runSerialTrackingBatch({
    items: [{ orderId: "one", trackingNumber: "9214490374008505076389", carrier: "USPS" }],
    upload: async () => ({ etsyStatus: "ETSY_ACCEPTED" }),
    verify: async () => ({ etsyStatus: "VERIFIED", verifiedAt: "2026-11-21T00:00:00.000Z" }),
  });

  assert.deepEqual(result.results, [{
    orderId: "one",
    trackingNumber: "9214490374008505076389",
    carrier: "USPS",
    ok: true,
    etsyStatus: "VERIFIED",
    verifiedAt: "2026-11-21T00:00:00.000Z",
  }]);
});

test("keeps Etsy acceptance when the follow-up verification is not visible yet", async () => {
  const result = await runSerialTrackingBatch({
    items: [{ orderId: "one", trackingNumber: "9214490374008505076389", carrier: "USPS" }],
    upload: async () => ({ etsyStatus: "ETSY_ACCEPTED", acceptedAt: "2026-11-21T00:00:00.000Z" }),
    verify: async () => { throw new Error("Etsy tracking is not visible on the order yet"); },
  });

  assert.deepEqual(result.results, [{
    orderId: "one",
    trackingNumber: "9214490374008505076389",
    carrier: "USPS",
    etsyStatus: "ETSY_ACCEPTED",
    acceptedAt: "2026-11-21T00:00:00.000Z",
    ok: false,
    errorMessage: "Etsy tracking is not visible on the order yet",
  }]);
});
