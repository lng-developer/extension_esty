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
