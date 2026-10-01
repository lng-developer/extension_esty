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

test("keeps Socket tasks to tracking when API-agent mode is configured", () => {
  assert.match(worker, /const isTrackingTask = taskType === "ETSY_UPLOAD_TRACKING" \|\| taskType === "UPLOAD_TRACKING"/);
  assert.match(worker, /reason: "LNG_WEB_BE_AGENT_MODE"/);
});
