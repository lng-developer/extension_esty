import assert from "node:assert/strict";
import test from "node:test";

import { executeNextLngWebBeCommand } from "../lng-web-be-agent.mjs";

test("starts, executes and completes an Orders command once", async () => {
  const calls = [];
  const client = {
    heartbeat: async () => calls.push("heartbeat"),
    claimNext: async () => ({ command: { id: "command-1", type: "IMPORT_NEW_ORDERS", numDays: 1 }, leaseToken: "lease-token-1234567890" }),
    start: async (id, lease) => calls.push(["start", id, lease]),
    complete: async (id, payload) => calls.push(["complete", id, payload]),
  };

  const result = await executeNextLngWebBeCommand({
    client,
    executeOrders: async ({ commandId, numDays }) => ({ importJobId: "job-1", importedCount: numDays, failedCount: 0 }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "heartbeat",
    ["start", "command-1", "lease-token-1234567890"],
    ["complete", "command-1", { leaseToken: "lease-token-1234567890", success: true, importJobId: "job-1", importedCount: 1, failedCount: 0 }],
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
      claimNext: async () => ({ command: { id: "command-1", type: "IMPORT_ADS_SPEND" }, leaseToken: "lease" }),
      start: async () => {},
      complete: async (_id, payload) => completions.push(payload),
    },
    executeAds: async () => { throw new Error("Etsy page unavailable"); },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(completions, [{
    leaseToken: "lease",
    success: false,
    importedCount: 0,
    failedCount: 0,
    errorMessage: "Etsy page unavailable",
  }]);
});
