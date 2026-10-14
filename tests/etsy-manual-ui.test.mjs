import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../etsy-manual.js', import.meta.url), 'utf8');
async function page(run, config) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, dataset: {}, open: true });
    return elements.get(id);
  } };
  vm.runInNewContext(source, { document, confirm: () => false, chrome: {
    runtime: { sendMessage: async () => ({ ok: true, data: run }) },
    storage: { session: { get: async () => ({ etsyManualConfig: config }) } },
  } });
  await new Promise(resolve => setImmediate(resolve));
  return document.getElementById;
}
const config = { apiBaseUrl: 'http://192.168.1.3:3000', shopId: '660000000000000000000201', shopName: 'Test shop', extensionToken: 'lng_ext_test' };
test('preview without a session token cannot start import', async () => {
  const get = await page({ status: 'PREVIEW', orderCount: 1, entries: [] });
  assert.equal(get('import').disabled, true);
  assert.equal(get('pull').disabled, true);
});
test('completed capture shows counts without exposing raw customer references', async () => {
  const get = await page({ status: 'COMPLETED', orderCount: 1, itemCount: 2, entries: [{ files: [{ asset: { mediaAssetId: 'a' }, downloadUrl: 'private-url' }] }], result: { importedCount: 2, failedCount: 0 } }, config);
  assert.equal(get('orders').textContent, '1');
  assert.equal(get('uploaded').textContent, '1 / 1');
  assert.equal(get('import').disabled, true);
  assert.doesNotMatch(get('status').textContent, /COMPLETED|undefined/);
});
test('an interrupted capture keeps resume available but prevents replacing it', async () => {
  const get = await page({ status: 'PAUSED', orderCount: 1, entries: [], error: 'IMPORT_PENDING' }, config);
  assert.equal(get('pull').disabled, true);
  assert.equal(get('import').disabled, false);
  assert.match(get('status').textContent, /tiếp tục/i);
});
