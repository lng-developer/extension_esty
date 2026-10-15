import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createLngWebBeCommandClient } from '../lng-web-be-command-client.mjs';
import { executeNextLngWebBeCommand } from '../lng-web-be-agent.mjs';
import { runRemoteEtsyOrders } from '../etsy-remote-order-runner.mjs';

const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
function setup({ manual = true, token = 'lng_ext_session', status = 200, acknowledged = false, command = null, loseCompletion = false, collectionError = null } = {}) {
  const local = { etsyManualMode: manual, lngWebBeClientId: 'stable-client', extensionToken: 'lng_ext_old', lngWebBeApiBaseUrl: 'https://old.example', socketLabel: 'Etsy VM' };
  const session = { etsyManualConfig: { apiBaseUrl: 'http://192.168.1.3:3000', extensionToken: token } };
  const requests = []; const alarms = new Map(); let onAlarm;
  let completed = false; let collections = 0;
  const ctx = vm.createContext({ URL, Date, setInterval, clearInterval, runRemoteEtsyOrders, downloadManualFile: async () => {}, handleGetEtsyOrdersAndPush: async options => { collections++; if (collectionError) throw collectionError; assert.equal(options.maxTotalOrders, 1); await options.pushOrders([{ orderId: 'order', items: [{ transactionId: 'item', quantity: 1 }] }]); }, console: { error() {} }, crypto: { randomUUID: () => 'new-client' },
    LNG_WEB_BE_COMMAND_ALARM: 'commands', LNG_WEB_BE_CLIENT_ID_KEY: 'lngWebBeClientId', LNG_WEB_BE_AGENT_STATUS_KEY: 'agentStatus', lngWebBeAgentRunning: false, etsyManualRunning: false, socketTaskLocks: new Set(), manualConfig: async () => session.etsyManualConfig, manualScope: cfg => `${cfg.apiBaseUrl}|shop`,
    isEtsyManualMode: async () => local.etsyManualMode,
    chrome: { runtime: { getManifest: () => ({ version: '1.1.0' }) }, storage: {
      local: { get: async () => local, set: async value => Object.assign(local, value) }, session: { get: async () => session, set: async value => Object.assign(session, structuredClone(value)), remove: async key => { delete session[key]; } },
    }, alarms: { create: async (name, config) => alarms.set(name, config), clear: async name => alarms.delete(name), onAlarm: { addListener: fn => { onAlarm = fn; } } } },
    createLngWebBeCommandClient: options => createLngWebBeCommandClient({ ...options, fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      let data = acknowledged ? { provider: 'ETSY', protocolVersion: 1 } : {};
      if (url.endsWith('/claim')) data = command && !completed ? { command: { ...command, status: 'CLAIMED' }, leaseToken: 'x'.repeat(24) } : null;
      if (url.endsWith('/renew') || url.endsWith('/start')) data = { ...command, status: 'RUNNING' };
      if (url.endsWith('/etsy-sold-order-items')) data = { id: 'job' };
      if (url.endsWith('/progress')) data = { isTerminal: true, job: { status: 'COMPLETED', importedCount: 1 } };
      if (url.endsWith('/complete')) { completed = true; if (loseCompletion) { loseCompletion = false; throw new Error('lost response'); } }
      return { ok: status === 200, status, json: async () => ({ success: status === 200, data }) };
    } }), executeNextLngWebBeCommand,
  });
  vm.runInContext(source.slice(source.indexOf('async function getLngWebBeAgentConfig('), source.indexOf('function getServiceLogPrefixFromMessage(')), ctx);
  const alarmStart = source.indexOf('chrome.alarms.onAlarm.addListener(');
  vm.runInContext(source.slice(alarmStart, source.indexOf('\n});', alarmStart) + 4), ctx);
  return { ctx, local, session, requests, alarms, collections: () => collections, tick: async () => { await onAlarm({ name: 'commands' }); await new Promise(resolve => setImmediate(resolve)); } };
}

test('manual start and alarm send heartbeat with session identity without claiming work', async () => {
  const app = setup();
  await app.ctx.startLngWebBeAgent();
  await app.tick();
  assert.equal(app.requests.length, 2);
  for (const req of app.requests) {
    assert.equal(JSON.parse(req.body).provider, 'ETSY');
    assert.equal(JSON.parse(req.body).protocolVersion, 1);
    assert.equal(req.url, 'http://192.168.1.3:3000/api/integration/extension-commands/agent/heartbeat');
    assert.equal(req.headers.Authorization, 'Bearer lng_ext_session');
    assert.equal(JSON.parse(req.body).clientId, 'stable-client');
  }
  assert.equal(app.alarms.get('commands').periodInMinutes, 1);
  assert.equal(app.local.agentStatus, 'CONNECTED');
});

test('lost session token stops heartbeat and never uses the old persistent token', async () => {
  const app = setup();
  await app.ctx.startLngWebBeAgent();
  delete app.session.etsyManualConfig;
  await app.tick();
  assert.equal(app.requests.length, 1);
  assert.equal(app.alarms.size, 0);
  assert.equal(app.local.agentStatus, 'CONFIGURATION_REQUIRED');
});

for (const status of [401, 403, 500]) {
  test(`heartbeat HTTP ${status} does not claim work and handles retry correctly`, async () => {
    const app = setup({ status });
    await app.ctx.startLngWebBeAgent();
    assert.equal(app.requests.length, 1);
    assert.equal(app.alarms.has('commands'), status === 500);
    assert.equal(app.local.agentStatus, status === 500 ? 'RETRYING' : 'TOKEN_REJECTED');
  });
}

test('automatic mode retains heartbeat and command claim', async () => {
  const app = setup({ manual: false });
  await app.ctx.startLngWebBeAgent();
  assert.deepEqual(app.requests.map(req => new URL(req.url).pathname.split('/').at(-1)), ['heartbeat', 'claim']);
});
test('acknowledged Etsy protocol permits claim but unfinished manual preview blocks it', async () => {
  const app = setup({ acknowledged: true });
  await app.ctx.startLngWebBeAgent();
  assert.deepEqual(app.requests.map(req => new URL(req.url).pathname.split('/').at(-1)), ['heartbeat', 'claim']);
  app.local.etsyManualRun = { status: 'PREVIEW' };
  await app.tick();
  assert.equal(app.requests.length, 3);
  assert.ok(app.requests[2].url.endsWith('/heartbeat'));
});
test('worker imports one web order and retries lost completion without collecting again', async () => {
  const app = setup({ acknowledged: true, loseCompletion: true, command: { id: 'task', provider: 'ETSY', type: 'IMPORT_NEW_ORDERS', origin: 'WEB', maxOrders: 1 } });
  await app.ctx.startLngWebBeAgent();
  assert.equal(app.collections(), 1);
  assert.equal(app.session.etsyRemoteOrderLease.completion.importedCount, 1);
  await app.tick();
  assert.equal(app.collections(), 1);
  assert.equal(app.local.etsyRemoteOrderRun.acknowledged, true);
  assert.equal(app.session.etsyRemoteOrderLease, undefined);
  assert.equal(app.requests.filter(req => req.url.endsWith('/complete')).length, 2);
});
test('fatal collection errors fail task with a fixed message, not customer data', async () => {
  const app = setup({ acknowledged: true, collectionError: new Error('private customer URL'), command: { id: 'task', provider: 'ETSY', type: 'IMPORT_NEW_ORDERS', origin: 'WEB', maxOrders: 1 } });
  await app.ctx.startLngWebBeAgent();
  const complete = app.requests.find(req => req.url.endsWith('/complete'));
  assert.ok(complete);
  assert.equal(JSON.parse(complete.body).success, false);
  assert.equal(JSON.parse(complete.body).errorMessage, 'ETSY_REMOTE_IMPORT_FAILED');
});
