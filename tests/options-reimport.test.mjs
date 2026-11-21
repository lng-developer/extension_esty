import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('Operations Hub exposes a one-order re-import action', async () => {
  const [html, options, worker] = await Promise.all([
    readFile(new URL('../options.html', import.meta.url), 'utf8'),
    readFile(new URL('../options.js', import.meta.url), 'utf8'),
    readFile(new URL('../service-worker.js', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="reimportOrderId"/);
  assert.match(html, /id="btnReimportOrder"/);
  assert.match(options, /action: 'ETSY_MANUAL_REIMPORT'/);
  assert.match(worker, /action === 'ETSY_MANUAL_REIMPORT'/);
  assert.match(worker, /targetOrderId: orderId/);
  assert.match(worker, /maxTotalOrders: 1/);
  assert.match(worker, /forceDomCustomFileScan: true/);
});

test('re-import validates its ID and preserves an unfinished preview', async () => {
  const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleManualMessage('), source.indexOf('let etsyAutoConfigLastSnapshot'));
  const local = {};
  const session = {};
  let collected; let resumed = false;
  const ctx = vm.createContext({
    etsyManualRunning: false,
    lngWebBeAgentRunning: false,
    socketTaskLocks: new Set(),
    chrome: { storage: {
      local: { get: async () => local, set: async value => Object.assign(local, value), remove: async key => { delete local[key]; } },
      session: { get: async () => session, set: async value => Object.assign(session, value) }
    } },
    isEtsyManualMode: async () => true,
    manualConfig: async () => ({ apiBaseUrl: 'https://ecomatrix.lngmerch.co', shopId: 'shop' }),
    manualScope: () => 'scope',
    handleGetEtsyOrdersAndPush: async options => {
      collected = options;
      await options.pushOrders([{ orderId: '4213186862', items: [{ transactionId: 'item' }] }]);
    },
    createEtsyCapture: (orders) => ({ status: 'PREVIEW', orderCount: orders.length, entries: [] }),
    saveManualRun: async run => { local.etsyManualRun = run; },
    createLngWebBeCommandClient: () => ({}),
    resumeEtsyImport: () => { resumed = true; return Promise.resolve(); },
    downloadManualFile: async () => {},
    crypto: { randomUUID: () => 'run' }
  });
  vm.runInContext(handler, ctx);

  await assert.rejects(ctx.handleManualMessage('ETSY_MANUAL_REIMPORT', { orderId: 'bad' }), /Order ID/);

  local.etsyManualRun = { status: 'PREVIEW' };
  await assert.rejects(ctx.handleManualMessage('ETSY_MANUAL_REIMPORT', { orderId: '4213186862' }), /checkpoint/i);

  delete local.etsyManualRun;
  await ctx.handleManualMessage('ETSY_MANUAL_REIMPORT', { orderId: '4213186862' });
  assert.equal(collected.targetOrderId, '4213186862');
  assert.equal(collected.maxTotalOrders, 1);
  assert.equal(collected.forceDomCustomFileScan, true);
  assert.equal(resumed, true);
});

test('targeted re-import scans a one-order capture even without an upload signal', async () => {
  const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
  const start = source.indexOf('function findOrdersNeedingDomCustomFileScan(');
  const end = source.indexOf('\n\nasync function runAutoUploadDomDetailScan', start);
  const ctx = vm.createContext({
    getCustomerUploadSignalFieldsInItem: () => [],
    itemAlreadyHasDomCustomFile: () => false,
    console: { log() {} }
  });
  vm.runInContext(`${source.slice(start, end)}; globalThis.findCandidates = findOrdersNeedingDomCustomFileScan;`, ctx);

  const candidates = ctx.findCandidates([{ orderId: '4213186862', items: [{ transactionId: 'item' }] }], {
    forceDomCustomFileScan: true,
    targetOrderId: '4213186862'
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].orderId, '4213186862');
});
