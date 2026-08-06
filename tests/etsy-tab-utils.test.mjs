import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  ensurePageTabReady,
  waitForTabCompleteWithTimeout
} from "../service-worker-tab-utils.mjs";

test("waits 60 seconds by default before treating an Etsy tab as stuck", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeouts = [];
  const listenerSet = new Set();
  const tabsApi = {
    onUpdated: {
      addListener(listener) {
        listenerSet.add(listener);
      },
      removeListener(listener) {
        listenerSet.delete(listener);
      }
    },
    async get() {
      return { id: 7, status: "loading" };
    }
  };

  globalThis.setTimeout = (fn, ms) => {
    timeouts.push(ms);
    queueMicrotask(fn);
    return 1;
  };
  globalThis.clearTimeout = () => {};

  try {
    await assert.rejects(
      waitForTabCompleteWithTimeout(tabsApi, 7, { label: "Etsy tab" }),
      /Timeout waiting for Etsy tab/
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  assert.deepEqual(timeouts, [60000]);
  assert.equal(listenerSet.size, 0);
});

test("reloads a stuck Etsy sold-orders tab before returning it", async () => {
  const targetUrl = "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav";
  const existingTab = {
    id: 42,
    url: "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav",
    status: "loading"
  };
  const updates = [];
  const listeners = new Set();
  const tabsApi = {
    onUpdated: {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      }
    },
    async query() {
      return [existingTab];
    },
    async get() {
      return existingTab;
    },
    async update(tabId, updateInfo) {
      updates.push({ tabId, updateInfo });
      Object.assign(existingTab, updateInfo, { status: "complete" });
      return existingTab;
    },
    async create() {
      throw new Error("should not create a new tab when a stuck sold-orders tab exists");
    }
  };

  const readyTab = await ensurePageTabReady({
    tabsApi,
    queryUrl: "https://www.etsy.com/*",
    targetUrl,
    isTargetTab: (tab) => String(tab.url || "").includes("/your/orders/sold"),
    timeoutMs: 1,
    label: "Etsy tab",
    logger: { warn() {}, log() {} }
  });

  assert.equal(readyTab.id, existingTab.id);
  assert.deepEqual(updates, [
    {
      tabId: existingTab.id,
      updateInfo: { active: true, url: targetUrl }
    }
  ]);
  assert.equal(listeners.size, 0);
});

test("Etsy Ads tab readiness uses the reload-capable tab helper", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const match = source.match(/async function ensureEtsyAdsTab\(\) \{[\s\S]*?\n\}/);

  assert.ok(match, "ensureEtsyAdsTab should exist");
  assert.match(match[0], /ensurePageTabReady\(/);
  assert.match(match[0], /targetUrl:\s*CONFIG\.ETSY_ADS_URL/);
  assert.match(match[0], /label:\s*"Etsy Ads tab"/);
});
