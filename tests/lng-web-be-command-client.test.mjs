import assert from "node:assert/strict";
import test from "node:test";

import { createLngWebBeCommandClient } from "../lng-web-be-command-client.mjs";

test("sends the Extension Token as bearer authentication for heartbeat", async () => {
  const calls = [];
  const client = createLngWebBeCommandClient({
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: "agent-1" } }) };
    },
    getConfig: async () => ({
      apiBaseUrl: "https://api.example.test/",
      extensionToken: "lng_ext_valid",
      clientId: "device-1",
      label: "Etsy worker",
      version: "1.1.0",
    }),
  });

  await client.heartbeat();

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.example.test/api/integration/extension-commands/agent/heartbeat");
  assert.equal(calls[0][1].headers.Authorization, "Bearer lng_ext_valid");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    clientId: "device-1",
    label: "Etsy worker",
    version: "1.1.0",
    apiBaseUrl: "https://api.example.test",
  });
});

test("does not call the API when the Extension Token is missing", async () => {
  const client = createLngWebBeCommandClient({
    fetchImpl: async () => assert.fail("fetch must not be called"),
    getConfig: async () => ({ apiBaseUrl: "https://api.example.test", extensionToken: "", clientId: "device-1", label: "Etsy worker" }),
  });

  await assert.rejects(client.heartbeat(), { code: "EXTENSION_TOKEN_REQUIRED" });
});

test("returns null when claim has no queued command", async () => {
  const client = createLngWebBeCommandClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: null }) }),
    getConfig: async () => ({ apiBaseUrl: "https://api.example.test", extensionToken: "lng_ext_valid", clientId: "device-1", label: "Etsy worker" }),
  });

  assert.equal(await client.claimNext(), null);
});
