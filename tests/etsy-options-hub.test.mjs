import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { formatVietnamTime, createExtensionLogger, buildActivityRuns } from '../extensionLogger.mjs';

const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

test('formatVietnamTime formats timestamp in Asia/Ho_Chi_Minh timezone with ICT suffix', () => {
  const ts = '2026-11-16T04:14:14.000Z'; // 11:14:14 ICT
  const formatted = formatVietnamTime(ts);
  assert.match(formatted, /11:14:14.*ICT/);
});

test('createExtensionLogger writes and retrieves redactable events', async () => {
  const store = {};
  const storage = {
    get: async () => store,
    set: async (val) => Object.assign(store, val),
  };
  const logger = createExtensionLogger({ storage });
  await logger.logInfo('Test event', { token: 'secret-token-1234', safeField: 'abc' });
  const events = await logger.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'Test event');
  assert.equal(events[0].level, 'info');
  // Token should be redacted/filtered
  assert.equal(events[0].context.safeField, 'abc');
  assert.equal(events[0].context.token, undefined);

  await logger.clear();
  const cleared = await logger.getEvents();
  assert.equal(cleared.length, 0);
});

test('buildActivityRuns aggregates events by task run', () => {
  const events = [
    { timestamp: '2026-11-16T04:10:00.000Z', level: 'info', message: 'Pulling orders started', context: { commandId: 'cmd-1', taskType: 'IMPORT_NEW_ORDERS' } },
    { timestamp: '2026-11-16T04:10:05.000Z', level: 'info', message: 'Task completed successfully', context: { commandId: 'cmd-1', taskType: 'IMPORT_NEW_ORDERS' } },
  ];
  const runs = buildActivityRuns(events);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].commandId, 'cmd-1');
  assert.equal(runs[0].status, 'SUCCEEDED');
  assert.equal(runs[0].events.length, 2);
});

test('HEARTBEAT_NOW handler executes heartbeatOnly and returns agent info', async () => {
  const local = {
    lngWebBeClientId: 'client-123',
    lngWebBeApiBaseUrl: 'https://ecomatrix.lngmerch.co',
    extensionToken: 'lng_ext_valid_token',
    socketLabel: 'LNG Etsy Worker',
  };
  let messageHandler;
  const heartbeatCalls = [];

  const ctx = vm.createContext({
    URL,
    Date,
    crypto: { randomUUID: () => 'uuid' },
    console: { log() {}, error() {}, warn() {} },
    LNG_WEB_BE_COMMAND_ALARM: 'alarm',
    LNG_WEB_BE_CLIENT_ID_KEY: 'lngWebBeClientId',
    LNG_WEB_BE_AGENT_STATUS_KEY: 'agentStatus',
    isEtsyManualMode: async () => false,
    chrome: {
      runtime: {
        id: 'ext-id',
        getURL: (p) => `chrome-extension://ext-id/${p}`,
        getManifest: () => ({ version: '1.1.0' }),
        onMessage: {
          addListener: (fn) => { messageHandler = fn; },
        },
      },
      storage: {
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map(k => [k, local[k]]));
            }
            return local;
          },
          set: async (val) => Object.assign(local, val),
        },
        session: { get: async () => ({}) },
      },
    },
    createLngWebBeCommandClient: () => ({
      isConfigured: async () => Boolean(local.extensionToken),
      heartbeat: async () => {
        heartbeatCalls.push(Date.now());
        return { shopId: 'shop-abc', shopName: 'LilNamStore-Etsy', provider: 'ETSY', protocolVersion: 1 };
      },
    }),
  });

  // Extract getLngWebBeAgentConfig and heartbeatOnly definitions from service-worker
  const configFn = source.slice(source.indexOf('async function getLngWebBeAgentConfig('), source.indexOf('async function runLngWebBeAgentOnce('));
  const hbFn = source.slice(source.indexOf('async function heartbeatOnly('), source.indexOf('async function startLngWebBeAgent('));
  const listenerStart = source.indexOf('chrome.runtime.onMessage.addListener(');
  const hbBlockEnd = source.indexOf('return true;', listenerStart) + 'return true;'.length;
  const listenerChunk = source.slice(listenerStart, hbBlockEnd) + '\n    }\n});';

  vm.runInContext(configFn, ctx);
  vm.runInContext(hbFn, ctx);
  vm.runInContext(listenerChunk, ctx);

  let responseData;
  const sendResponse = (res) => { responseData = res; };

  const handled = messageHandler({ type: 'HEARTBEAT_NOW' }, { id: 'ext-id' }, sendResponse);
  assert.equal(handled, true);

  // Wait for promise resolution
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(heartbeatCalls.length, 1);
  assert.equal(responseData?.ok, true);
  assert.equal(responseData?.agent?.shopName, 'LilNamStore-Etsy');
  assert.equal(local.extensionConnectionStatus?.state, 'CONNECTED');
  assert.equal(local.extensionConnectionStatus?.shopId, 'shop-abc');
});
