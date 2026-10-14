import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function handleManualMessage('), source.indexOf('let etsyAutoConfigLastSnapshot'));
function setup({ identity, run, failure } = {}) {
  const session = {}; const local = { etsyManualRun: run };
  const ctx = vm.createContext({ URL, etsyManualRunning: false, lngWebBeAgentRunning: false, socketTaskLocks: new Set(), LNG_WEB_BE_COMMAND_ALARM: 'test',
    chrome: { storage: { session: { set: async value => Object.assign(session, value) }, local: { get: async () => local, set: async value => Object.assign(local, value) } }, alarms: { clear: async () => {} } },
    disconnectSocket: async () => {}, createLngWebBeCommandClient: () => ({ getIdentity: async () => { if (failure) throw failure; return identity; } }),
  });
  vm.runInContext(handler, ctx);
  return { session, save: payload => ctx.handleManualMessage('ETSY_MANUAL_CONFIG', payload) };
}
const payload = { apiBaseUrl: 'http://192.168.1.3:3000', extensionToken: 'lng_ext_test' };
const shop = { id: '507f1f77bcf86cd799439011', name: 'Etsy test', code: 'ET01' };
test('resolves shop from verified identity and ignores a client supplied shop', async () => {
  const app = setup({ identity: { tokenType: 'EXTENSION', shop } });
  const result = await app.save({ ...payload, shopId: '507f1f77bcf86cd799439099' });
  assert.equal(app.session.etsyManualConfig.shopId, shop.id);
  assert.equal(result.shopName, 'Etsy test');
  assert.equal(result.extensionToken, undefined);
});
test('failed authentication does not save config', async () => {
  const app = setup({ failure: new Error('Token expired') });
  await assert.rejects(app.save(payload), /Token expired/);
  assert.equal(app.session.etsyManualConfig, undefined);
});
test('cannot change shop while an unfinished capture exists', async () => {
  const app = setup({ identity: { tokenType: 'EXTENSION', shop }, run: { status: 'PAUSED', scope: 'http://192.168.1.3:3000|another-shop' } });
  await assert.rejects(app.save(payload), /shop|backend/i);
  assert.equal(app.session.etsyManualConfig, undefined);
});
