import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function collector() {
  const ctx = vm.createContext({ URL, AbortSignal, console: { log() {}, warn() {} }, window: { __LNG_ETSY_WORKER_INJECTED__: true } });
  vm.runInContext(readFileSync(new URL('../content-etsy.js', import.meta.url), 'utf8'), ctx);
  ctx.fetchText = async () => 'bootstrap';
  ctx.parseEtsyBootstrap = () => ({ shopId: 'shop', shopName: 'Test', orderStates: [{ order_state_id: 1 }, { order_state_id: 2 }] });
  ctx.mapOrders = () => { throw new Error('Must not map'); };
  ctx.toBackendOrder = () => { throw new Error('Must not map'); };
  return ctx;
}

test('raw export preserves unknown fields and phone without mapping', async () => {
  const ctx = collector();
  const response = { order_ids: ['4241514988'], orders: { '4241514988': { fulfillment: { to_address: { phone: '2025550123' } }, unknownField: { keep: true } } } };
  const calls = [];
  ctx.fetchOrdersPage = async input => { calls.push(input); return input.orderStateId === 1 ? { order_ids: [] } : response; };
  const result = await ctx.getEtsyRawOrderJson({ targetOrderId: '4241514988' });
  assert.deepEqual(result.response, response);
  assert.equal(result.targetOrderId, '4241514988');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.rawOnly === true && call.targetOrderId === '4241514988'));
});

test('raw export rejects invalid IDs and missing orders', async () => {
  const ctx = collector();
  ctx.fetchText = async () => { throw new Error('Should not fetch'); };
  await assert.rejects(() => ctx.getEtsyRawOrderJson({ targetOrderId: '../other' }), /mã đơn/i);
  ctx.fetchText = async () => 'bootstrap';
  ctx.fetchOrdersPage = async () => ({ order_ids: ['other'] });
  await assert.rejects(() => ctx.getEtsyRawOrderJson({ targetOrderId: '4241514988' }), /không tìm thấy/i);
});

test('raw API request does not log response bodies on success or failure', async () => {
  const ctx = collector();
  const logs = [];
  ctx.console.log = (...args) => logs.push(args);
  for (const ok of [true, false]) {
    ctx.fetch = async () => ({ ok, status: ok ? 200 : 403, headers: { get: () => 'application/json' }, text: async () => '{"privatePhone":"2025550123"}' });
    try { await ctx.fetchJson('https://www.etsy.com/api/test', { logPreview: false }); }
    catch (error) { assert.doesNotMatch(error.message, /privatePhone|2025550123/); }
  }
  assert.doesNotMatch(JSON.stringify(logs), /privatePhone|2025550123/);
});

test('worker raw export needs no backend token and does not write checkpoints', async () => {
  const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleManualMessage('), source.indexOf('let etsyAutoConfigLastSnapshot'));
  const sent = []; const closed = [];
  const data = { targetOrderId: '4241514988', response: { untouched: true } };
  const ctx = vm.createContext({ etsyManualRunning: false, lngWebBeAgentRunning: false,
    chrome: { storage: { local: { get: async () => ({ etsyManualRun: { status: 'PAUSED' } }) }, session: { get: async () => ({}) } },
      tabs: { sendMessage: async (...args) => { sent.push(args); return { ok: true, data }; } } },
    ensureEtsySoldOrdersTab: async () => ({ tab: { id: 7 }, createdByTask: true }),
    injectContentScript: async () => {},
    closeTaskCreatedEtsyTab: async (...args) => closed.push(args),
    manualConfig: () => { throw new Error('Must not need backend token'); },
    saveManualRun: () => { throw new Error('Must not overwrite checkpoint'); },
  });
  vm.runInContext(handler, ctx);
  assert.equal(await ctx.handleManualMessage('ETSY_MANUAL_RAW_JSON', { targetOrderId: '4241514988' }), data);
  assert.equal(sent[0][1].action, 'CONTENT_ETSY_GET_RAW_ORDER');
  assert.equal(closed.length, 1);
  assert.equal(ctx.etsyManualRunning, false);
  ctx.chrome.tabs.sendMessage = async () => ({ ok: false, message: 'Etsy unavailable' });
  await assert.rejects(() => ctx.handleManualMessage('ETSY_MANUAL_RAW_JSON', { targetOrderId: '4241514988' }), /Etsy unavailable/);
  assert.equal(closed.length, 2);
  assert.equal(ctx.etsyManualRunning, false);
});

test('UI downloads raw JSON without submitting an import', async () => {
  const elements = new Map(); const messages = []; const blobs = []; let download;
  const get = id => { if (!elements.has(id)) elements.set(id, { value: '', dataset: {} }); return elements.get(id); };
  const data = { response: { phone: '2025550123', arbitraryField: true } };
  const ctx = vm.createContext({ Blob, URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} }, setTimeout() {},
    document: { getElementById: get, body: { appendChild() {} }, createElement: () => ({ click() { download = this.download; }, remove() {} }) },
    chrome: { storage: { session: { get: async () => ({}) } }, runtime: { sendMessage: async message => { messages.push(message); return { ok: true, data: message.action === 'ETSY_MANUAL_STATUS' ? null : data }; } } },
  });
  vm.runInContext(readFileSync(new URL('../etsy-manual.js', import.meta.url), 'utf8'), ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('rawJson').disabled, false);
  get('rawOrderId').value = '4241514988';
  await get('rawJson').onclick();
  assert.equal(download, 'etsy-raw-4241514988.json');
  assert.deepEqual(JSON.parse(await blobs[0].text()), data);
  assert.deepEqual(messages.map(message => message.action), ['ETSY_MANUAL_STATUS', 'ETSY_MANUAL_RAW_JSON']);
});
