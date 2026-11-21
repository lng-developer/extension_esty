import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("imports orders with targeted custom-file detail scanning by default", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const match = source.match(/async function handleGetEtsyOrdersAndPush\(payload = \{\}\) \{[\s\S]*?\n\}/);

  assert.ok(match, "order import handler should exist");
  assert.match(match[0], /customFileDetailMode: payload\.customFileDetailMode \|\| "auto_upload_detail"/);
  assert.match(match[0], /runAutoUploadDomDetailScan\(/);
});

test("opens Etsy order detail from the working sold-orders route", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const match = source.match(/async function ensureEtsyTargetOrderDetailTab\(targetOrderId\) \{[\s\S]*?\n\}/);

  assert.ok(match, "target order detail helper should exist");
  assert.match(match[0], /your\/orders\/sold\?ref=seller-platform-mcnav&order_id=/);
  assert.doesNotMatch(match[0], /your\/orders\/sold\/new/);
});

test("reports custom-file scan outcomes to the existing portal log API", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  const match = source.match(/async function runAutoUploadDomDetailScan\([\s\S]*?(?=\r?\n\r?\nfunction mergeDomCustomFilesIntoBackendOrders)/);

  assert.ok(match, "custom-file scanner should exist");
  assert.match(match[0], /IMPORT_ORDERS custom-file scan started/);
  assert.match(match[0], /IMPORT_ORDERS custom-file scan completed/);
  assert.match(match[0], /IMPORT_ORDERS custom-file scan failed/);
  assert.doesNotMatch(match[0], /downloadUrl|previewUrl|buyerName/);
});

test("closes only Etsy tabs created by successful tasks", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

  assert.match(source, /async function closeTaskCreatedEtsyTab\(/);
  assert.match(source, /if \(!createdByTask \|\| !tab\?\.id\) return false;/);
  assert.match(source, /await chrome\.tabs\.remove\(tab\.id\)/);
  assert.match(source, /createdByTask: !existing/);
});

test("skips orders already processed for the same shop but keeps targeted reimports", async () => {
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

  assert.match(source, /async function getProcessedEtsyOrderIds\(mongoShopId\)/);
  assert.match(source, /const backendOrders = targetOrderId[\s\S]*?\.filter\(\(order\) => !processedOrderIds\.has/);
  assert.match(source, /await rememberProcessedEtsyOrderIds\(mongoShopId, pushResult\.processedOrderIds\)/);
});

test("offers a one-order reimport control that forces the customer-file scan", async () => {
  const [html, popup] = await Promise.all([
    readFile(new URL("../popup.html", import.meta.url), "utf8"),
    readFile(new URL("../popup.js", import.meta.url), "utf8")
  ]);

  const reimportCardAt = html.indexOf('class="reimport-card"');
  const batchImportAt = html.indexOf('id="btnGetOrders"');
  const triggerStart = html.indexOf('id="triggerModalOverlay"');
  const triggerEnd = html.indexOf('<pre id="log">');
  const reimportCard = html.slice(reimportCardAt, html.indexOf('</section>', reimportCardAt));

  assert.ok(reimportCardAt >= 0, "re-import should be a visible Orders card");
  assert.ok(reimportCardAt < batchImportAt, "re-import should appear before batch import");
  assert.doesNotMatch(reimportCard, /id="reimportOrderId"[^>]*\sdisabled/);
  assert.doesNotMatch(reimportCard, /id="btnReimportOrder"[^>]*\sdisabled/);
  assert.doesNotMatch(html.slice(triggerStart, triggerEnd), /id="reimportOrderId"/);
  assert.doesNotMatch(html.slice(triggerStart, triggerEnd), /id="btnReimportOrder"/);
  assert.match(html, /id="reimportOrderId"/);
  assert.match(html, /id="btnReimportOrder"/);
  assert.match(popup, /targetOrderId: orderId/);
  assert.match(popup, /forceDomCustomFileScan: true/);
  assert.match(popup, /maxTotalOrders: 1/);
});
