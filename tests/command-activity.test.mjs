import test from 'node:test';
import assert from 'node:assert/strict';
import { createLngWebBeCommandClient } from '../lng-web-be-command-client.mjs';
import { createExtensionLogger, buildActivityRuns } from '../extensionLogger.mjs';

function setup(type = 'IMPORT_NEW_ORDERS') {
  const store = {};
  const logger = createExtensionLogger({ storage: { get: async () => store, set: async value => Object.assign(store, value) } });
  let failure = false;
  const command = { id: 'abc', type, origin: 'SCHEDULE', status: 'RUNNING' };
  const client = createLngWebBeCommandClient({ logger,
    getConfig: async () => ({ apiBaseUrl: 'https://example.test', extensionToken: 'lng_ext_private', clientId: 'client', label: 'worker' }),
    fetchImpl: async url => {
      if (failure) throw Object.assign(new Error('private customer@example.test https://secret.test?token=abc'), { status: 409 });
      let data = command;
      if (url.endsWith('/claim')) data = { command, leaseToken: 'private-lease-token' };
      if (url.endsWith('/complete')) data = { ...command, status: 'SUCCEEDED' };
      if (url.endsWith('/progress')) data = { job: { status: 'PROCESSING', importedCount: 2, failedCount: 0 } };
      return { ok: true, json: async () => ({ success: true, data }) };
    } });
  return { client, logger, fail: () => { failure = true; } };
}
for (const type of ['IMPORT_NEW_ORDERS', 'IMPORT_ADS_SPEND', 'IMPORT_SETTLEMENTS', 'UPLOAD_TRACKING']) {
  test(`${type} records receipt, execution and confirmed completion`, async () => {
    const { client, logger } = setup(type);
    await client.claimNext(); await client.start('abc', 'private-lease-token');
    await client.complete('abc', { leaseToken: 'private-lease-token', success: true, importedCount: 2 });
    const events = await logger.getEvents();
    assert.ok(events.some(e => e.context.stage === 'CLAIMED'));
    const runs = buildActivityRuns(events);
    assert.equal(runs.length, 1); assert.equal(runs[0].type, type); assert.equal(runs[0].status, 'SUCCEEDED');
    assert.doesNotMatch(JSON.stringify(events), /private-lease-token|lng_ext_private/);
  });
}
test('lost lease and poll errors are visible without exposing response/customer data', async () => {
  const { client, logger, fail } = setup(); await client.claimNext(); fail();
  await assert.rejects(client.renew('abc', 'secret'));
  await assert.rejects(client.heartbeat());
  const events = await logger.getEvents();
  assert.ok(events.some(e => e.context.activityStatus === 'LEASE_LOST'));
  assert.ok(buildActivityRuns(events).some(run => run.type === 'CONNECTION'));
  assert.doesNotMatch(JSON.stringify(events), /customer@|secret.test|private-lease|lng_ext/);
});
test('repeated progress does not flood logs and renewal is not progress', async () => {
  const { client, logger } = setup(); await client.claimNext();
  await client.getImportProgress('job'); await client.getImportProgress('job');
  await client.renew('abc', 'secret'); await client.renew('abc', 'secret');
  const events = await logger.getEvents();
  assert.equal(events.filter(e => e.context.stage === 'IMPORT_PROGRESS').length, 1);
  assert.ok(events.filter(e => e.context.stage === 'LEASE_RENEWED').length <= 1);
});
test('failed storage does not break command processing and subsequent logs recover', async () => {
  let fail = true; const store = {};
  const logger = createExtensionLogger({storage:{get: async()=>store, set:async value=>{if(fail)throw new Error('quota');Object.assign(store,value);}}});
  await logger.logInfo('first'); fail = false; await logger.logInfo('second');
  assert.equal((await logger.getEvents()).at(-1).message, 'second');
});

test('lease renewal cannot hide a stalled command', () => {
  const old = Date.now() - 10 * 60_000;
  const events = [
    {timestamp:new Date(old).toISOString(),level:'info',message:'Collecting orders',context:{commandId:'x',taskType:'IMPORT_NEW_ORDERS',stage:'COLLECTING_ORDERS',activityStatus:'RUNNING'}},
    {timestamp:new Date().toISOString(),level:'info',message:'Lease renewed',context:{commandId:'x',taskType:'IMPORT_NEW_ORDERS',stage:'LEASE_RENEWED'}}
  ];
  assert.equal(buildActivityRuns(events)[0].status, 'UNKNOWN');
});
