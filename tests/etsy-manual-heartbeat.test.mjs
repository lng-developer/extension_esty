import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createLngWebBeCommandClient } from '../lng-web-be-command-client.mjs';
import { executeNextLngWebBeCommand } from '../lng-web-be-agent.mjs';

const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
function setup({ manual = true, token = 'lng_ext_session', status = 200 } = {}) {
  const local = { etsyManualMode: manual, lngWebBeClientId: 'stable-client', extensionToken: 'lng_ext_old', lngWebBeApiBaseUrl: 'https://old.example', socketLabel: 'Etsy VM' };
  const session = { etsyManualConfig: { apiBaseUrl: 'http://192.168.1.3:3000', extensionToken: token } };
  const requests = []; const alarms = new Map(); let onAlarm;
  const ctx = vm.createContext({ URL, console: { error() {} }, crypto: { randomUUID: () => 'new-client' },
    LNG_WEB_BE_COMMAND_ALARM: 'commands', LNG_WEB_BE_CLIENT_ID_KEY: 'lngWebBeClientId', LNG_WEB_BE_AGENT_STATUS_KEY: 'agentStatus', lngWebBeAgentRunning: false,
    isEtsyManualMode: async () => local.etsyManualMode,
    chrome: { runtime: { getManifest: () => ({ version: '1.1.0' }) }, storage: {
      local: { get: async () => local, set: async value => Object.assign(local, value) }, session: { get: async () => session },
    }, alarms: { create: async (name, config) => alarms.set(name, config), clear: async name => alarms.delete(name), onAlarm: { addListener: fn => { onAlarm = fn; } } } },
    createLngWebBeCommandClient: options => createLngWebBeCommandClient({ ...options, fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: status === 200, status, json: async () => ({ success: status === 200, data: {} }) };
    } }), executeNextLngWebBeCommand,
  });
  vm.runInContext(source.slice(source.indexOf('async function getLngWebBeAgentConfig('), source.indexOf('function getServiceLogPrefixFromMessage(')), ctx);
  const alarmStart = source.indexOf('chrome.alarms.onAlarm.addListener(');
  vm.runInContext(source.slice(alarmStart, source.indexOf('\n});', alarmStart) + 4), ctx);
  return { ctx, local, session, requests, alarms, tick: async () => { await onAlarm({ name: 'commands' }); await new Promise(resolve => setImmediate(resolve)); } };
}

test('manual start and alarm send heartbeat with session identity without claiming work', async () => {
  const app = setup();
  await app.ctx.startLngWebBeAgent();
  await app.tick();
  assert.equal(app.requests.length, 2);
  for (const req of app.requests) {
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
