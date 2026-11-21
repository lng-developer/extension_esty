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

test("runs tracking through the authenticated command agent without Socket.IO", () => {
  assert.match(worker, /executeTracking: async \(\{ commandId, items, renewLease \}\)/);
  assert.match(worker, /lease\.command\.type === "UPLOAD_TRACKING"/);
  assert.doesNotMatch(worker, /from "\.\/socket-client\.js"/);
  assert.doesNotMatch(worker, /server:task/);
  assert.doesNotMatch(worker, /client:ack/);
  assert.match(worker, /Legacy Socket automation is disabled; use LNG commands/);
});

test("rejects legacy popup messages for Orders and Ads", () => {
  assert.match(worker, /Orders are managed by the authenticated LNG Web BE agent/);
  assert.match(worker, /Ads are managed by the authenticated LNG Web BE agent/);
  assert.doesNotMatch(worker, /handleGetEtsyOrdersAndPush\(message\.payload/);
  assert.doesNotMatch(worker, /handleEtsyAdsImportDay\(message\.payload/);
});
