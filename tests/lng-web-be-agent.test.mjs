import assert from "node:assert/strict";
import test from "node:test";

import { executeNextLngWebBeCommand } from "../lng-web-be-agent.mjs";

test("starts, executes and completes an Orders command once", async () => {
  const calls = [];
  const client = {
    heartbeat: async () => calls.push("heartbeat"),
    claimNext: async () => ({ command: { id: "507f1f77bcf86cd799439012", type: "IMPORT_NEW_ORDERS", numDays: 1 }, leaseToken: "lease-token-1234567890" }),
    start: async (id, lease) => calls.push(["start", id, lease]),
    complete: async (id, payload) => calls.push(["complete", id, payload]),
  };

  const result = await executeNextLngWebBeCommand({
    client,
    executeOrders: async ({ commandId, numDays }) => ({ importJobId: "507f1f77bcf86cd799439013", importedCount: numDays, failedCount: 0 }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "heartbeat",
    ["start", "507f1f77bcf86cd799439012", "lease-token-1234567890"],
    ["complete", "507f1f77bcf86cd799439012", { leaseToken: "lease-token-1234567890", success: true, importJobId: "507f1f77bcf86cd799439013", importedCount: 1, failedCount: 0 }],
  ]);
});

test("leaves unknown commands uncompleted", async () => {
  let completed = false;
  const result = await executeNextLngWebBeCommand({
    client: { heartbeat: async () => {}, claimNext: async () => ({ command: { id: "command-1", type: "UNKNOWN" }, leaseToken: "lease" }), start: async () => assert.fail("must not start"), complete: async () => { completed = true; } },
  });
  assert.equal(result.skipped, true);
  assert.equal(completed, false);
});

test("reports execution failures using the active lease", async () => {
  const completions = [];
  const result = await executeNextLngWebBeCommand({
    client: {
      heartbeat: async () => {},
      claimNext: async () => ({ command: { id: "507f1f77bcf86cd799439012", type: "IMPORT_ADS_SPEND" }, leaseToken: "lease-token-1234567890" }),
      start: async () => {},
      complete: async (_id, payload) => completions.push(payload),
    },
    executeAds: async () => { throw new Error("Etsy page unavailable"); },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(completions, [{
    leaseToken: "lease-token-1234567890",
    success: false,
    importedCount: 0,
    failedCount: 0,
    errorMessage: "Etsy page unavailable",
  }]);
});

test("does not start a recognized command that fails validation", async () => {
  const start = async () => assert.fail("must not start");
  const result = await executeNextLngWebBeCommand({
    client: {
      heartbeat: async () => {},
      claimNext: async () => ({ command: { id: "507f1f77bcf86cd799439012", type: "IMPORT_ADS_SPEND" }, leaseToken: "lease-token-1234567890" }),
      start,
      complete: async () => assert.fail("must not complete"),
    },
    executeAds: async () => assert.fail("must not execute"),
    validateCommand: () => "Ads commands must contain exactly one date",
  });

  assert.deepEqual(result, { ok: false, skipped: true, reason: "Ads commands must contain exactly one date" });
});

test("leaves a retryable upload failure uncompleted for lease recovery", async () => {
  let completed = false;
  await assert.rejects(
    executeNextLngWebBeCommand({
      client: {
        heartbeat: async () => {},
        claimNext: async () => ({ command: { id: "507f1f77bcf86cd799439012", type: "IMPORT_NEW_ORDERS" }, leaseToken: "lease-token-1234567890" }),
        start: async () => {},
        complete: async () => { completed = true; },
      },
      executeOrders: async () => { throw Object.assign(new Error("Gateway unavailable"), { status: 503 }); },
      isRetryableError: (error) => error.status >= 500,
    }),
    /Gateway unavailable/,
  );
  assert.equal(completed, false);
});
