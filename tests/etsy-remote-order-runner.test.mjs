import test from 'node:test';
import assert from 'node:assert/strict';
import { runRemoteEtsyOrders } from '../etsy-remote-order-runner.mjs';

function setup(orders = []) {
  let checkpoint; let captures = 0; const uploads = [];
  const options = {
    command: { id: 'task', type: 'IMPORT_NEW_ORDERS', origin: 'WEB', maxOrders: 1 }, scope: 'https://backend|shop',
    load: async () => checkpoint, save: async value => { checkpoint = structuredClone(value); },
    collect: async count => { assert.equal(count, 1); captures++; return orders; },
    assertLease: async () => {},
    client: {
      uploadCsv: async (...args) => { uploads.push(args); return { id: 'job' }; },
      getImportProgress: async () => ({ job: { status: 'COMPLETED', importedCount: 1 }, isTerminal: true }),
      attachManifest: async () => ({ entries: [] }),
    },
  };
  return { options, uploads, checkpoint: () => checkpoint, captures: () => captures };
}
const orders = [{ orderId: 'order', items: [{ transactionId: 'item', title: 'Test', quantity: 1 }] }];
test('zero orders completes without uploading CSV', async () => {
  const app = setup();
  assert.deepEqual(await runRemoteEtsyOrders(app.options), { success: true, importedCount: 0, failedCount: 0 });
  assert.equal(app.uploads.length, 0);
});
test('automatically imports once, reusing saved job and capture', async () => {
  const app = setup(orders);
  assert.equal((await runRemoteEtsyOrders(app.options)).importJobId, 'job');
  await runRemoteEtsyOrders(app.options);
  assert.equal(app.captures(), 1);
  assert.equal(app.uploads.length, 1);
  assert.equal(app.checkpoint().id, 'task');
});
test('lost upload response retries identical bytes and key without recollecting', async () => {
  const app = setup(orders); const upload = app.options.client.uploadCsv;
  app.options.client.uploadCsv = async (...args) => { await upload(...args); throw new Error('network'); };
  await assert.rejects(runRemoteEtsyOrders(app.options), /network/);
  app.options.client.uploadCsv = upload;
  await runRemoteEtsyOrders(app.options);
  assert.equal(app.captures(), 1);
  assert.deepEqual(app.uploads[0], app.uploads[1]);
});
test('scope change blocks resume and lease loss blocks upload', async () => {
  const app = setup(orders);
  await runRemoteEtsyOrders(app.options);
  await assert.rejects(runRemoteEtsyOrders({ ...app.options, scope: 'other' }), /scope/i);
  const stopped = setup(orders);
  stopped.options.assertLease = async () => { throw new Error('lease lost'); };
  await assert.rejects(runRemoteEtsyOrders(stopped.options), /lease lost/);
  assert.equal(stopped.uploads.length, 0);
});
test('customer files and manifest finish before remote success', async () => {
  const app = setup([{ ...orders[0], items: [{ ...orders[0].items[0], customFiles: [{ downloadUrl: 'https://i.etsystatic.com/file.png' }] }] }]);
  const steps = [];
  app.options.downloadFile = async () => new Blob(['png'], { type: 'image/png' });
  app.options.client.uploadImportAsset = async () => { steps.push('asset'); return { mediaAssetId: 'asset' }; };
  app.options.client.attachManifest = async (job, entries) => { steps.push('manifest'); assert.equal(entries[0].assets[0].mediaAssetId, 'asset'); return { entries: [{ status: 'accepted' }] }; };
  assert.equal((await runRemoteEtsyOrders(app.options)).success, true);
  assert.deepEqual(steps, ['asset', 'manifest']);
});
test('unresolved file manifest returns needs review rather than success', async () => {
  const app = setup([{ ...orders[0], items: [{ ...orders[0].items[0], customFilesNeedsReview: true }] }]);
  app.options.client.attachManifest = async () => ({ entries: [{ status: 'needs_review' }] });
  assert.equal((await runRemoteEtsyOrders(app.options)).errorMessage, 'ETSY_IMPORT_NEEDS_REVIEW');
});
