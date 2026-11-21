import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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

test("retries only verification after Etsy accepts a tracking upload", async () => {
  const { verifyTrackingWithRetry } = await import("../etsy-tracking-verification.mjs").catch(() => ({}));
  assert.equal(typeof verifyTrackingWithRetry, "function");
  let attempts = 0;
  const delays = [];
  const result = await verifyTrackingWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("Etsy tracking is not visible on the order yet");
    return { etsyStatus: "VERIFIED" };
  }, { delay: async (attempt) => delays.push(attempt) });

  assert.deepEqual(result, { etsyStatus: "VERIFIED" });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);
});

test("command-agent waits 15 seconds between delayed Etsy verification checks", () => {
  const worker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /delay:\s*\(\)\s*=>\s*sleep\(15_000\)/);
});
