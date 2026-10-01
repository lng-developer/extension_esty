import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const worker = fs.readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("runs the authenticated command loop and uploads both supported CSV imports", () => {
  assert.match(worker, /executeNextLngWebBeCommand\(/);
  assert.match(worker, /LNG_WEB_BE_COMMAND_ALARM/);
  assert.match(worker, /etsy-sold-order-items/);
  assert.match(worker, /\/api\/finance\/imports\/ads/);
  assert.match(worker, /toEtsySoldOrderItemsCsv/);
  assert.match(worker, /toEtsyAdsCsv/);
});

test("keeps Socket tasks to tracking without falling back when token setup is invalid", () => {
  assert.match(worker, /const isTrackingTask = taskType === "ETSY_UPLOAD_TRACKING" \|\| taskType === "UPLOAD_TRACKING"/);
  assert.match(worker, /if \(!isTrackingTask\) \{/);
  assert.match(worker, /reason: "SOCKET_TRANSPORT_DISABLED"/);
});

test("rejects legacy popup messages for Orders and Ads", () => {
  assert.match(worker, /Orders are managed by the authenticated LNG Web BE agent/);
  assert.match(worker, /Ads are managed by the authenticated LNG Web BE agent/);
  assert.doesNotMatch(worker, /handleGetEtsyOrdersAndPush\(message\.payload/);
  assert.doesNotMatch(worker, /handleEtsyAdsImportDay\(message\.payload/);
});
