import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ships only Etsy runtime code", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const serviceWorker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const etsyContent = await readFile(new URL("../content-etsy.js", import.meta.url), "utf8");
  const logger = await readFile(new URL("../extension-logger.js", import.meta.url), "utf8");

  assert.doesNotMatch(manifest.description, /Amazon Ads/i);
  assert.ok(!manifest.host_permissions.includes("https://advertising.amazon.com/*"));
  assert.doesNotMatch(serviceWorker, /AMAZON_ADS_IMPORT_DAY|content-amazon-ads\.js|advertising\.amazon\.com|ADS_HEADER_KEYS|handleAmazonAdsImportDay/);
  assert.doesNotMatch(serviceWorker, /amazon/i);
  assert.doesNotMatch(etsyContent, /amazon/i);
  assert.doesNotMatch(logger, /AMAZON_ADS/);
});
