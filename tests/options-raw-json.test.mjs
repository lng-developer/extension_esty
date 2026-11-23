import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('Operations Hub downloads raw JSON for its order ID without importing', async () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  assert.match(html, /id="btnRawOrderJson"/);
  const source = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const start = source.indexOf("  $('#btnRawOrderJson').addEventListener");
  const end = source.indexOf("  $('#btnReimportOrder').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  let click; let filename; let blob; const calls = []; const alerts = [];
  const button = { disabled: false, addEventListener: (_, fn) => { click = fn; } };
  const input = { value: '4241514988' };
  const data = { response: { phone: '2025550123', unknown: true } };
  const ctx = vm.createContext({
    $: selector => selector === '#reimportOrderId' ? input : button,
    chrome: { runtime: { sendMessage: async message => { calls.push(message); return { ok: true, data }; } } },
    Blob, URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    document: { body: { appendChild() {} }, createElement: () => ({ click() { filename = this.download; }, remove() {} }) },
    setTimeout() {}, log() {}, alert: message => alerts.push(message),
  });
  vm.runInContext(source.slice(start, end), ctx);
  await click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'ETSY_MANUAL_RAW_JSON');
  assert.equal(calls[0].payload.targetOrderId, '4241514988');
  assert.equal(filename, 'etsy-raw-4241514988.json');
  assert.deepEqual(JSON.parse(await blob.text()), data);
  assert.equal(button.disabled, false);
  input.value = 'invalid';
  await click();
  assert.equal(calls.length, 1);
  assert.equal(alerts.length, 1);
  input.value = '4241514988';
  ctx.chrome.runtime.sendMessage = async () => ({ ok: false, message: 'Etsy unavailable' });
  await click();
  assert.match(alerts[1], /Etsy unavailable/);
  assert.equal(button.disabled, false);
});
