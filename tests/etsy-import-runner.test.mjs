import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForEtsyImport, resumeEtsyImport, originalEtsyFileUrl } from '../etsy-import-runner.mjs';

test('waits for terminal backend counts instead of accepting queued upload', async () => {
  const responses = [
    { isTerminal: false, job: { status: 'PENDING', importedCount: 0 } },
    { isTerminal: true, job: { status: 'PARTIALLY_COMPLETED', importedCount: 2, skippedCount: 1, failedCount: 1 } },
  ];
  const result = await waitForEtsyImport({ getImportProgress: async () => responses.shift() }, 'job', { sleep: async () => {} });
  assert.equal(responses.length, 0);
  assert.deepEqual(result, { importJobId: 'job', importedCount: 2, skippedCount: 1, failedCount: 1, status: 'PARTIALLY_COMPLETED', success: false });
});

test('failed backend job is not successful even with zero row failures', async () => {
  const result = await waitForEtsyImport({ getImportProgress: async () => ({ isTerminal: true, job: { status: 'FAILED' } }) }, 'job');
  assert.equal(result.success, false);
});

test('bounded polling leaves a retryable pending job rather than claiming success', async () => {
  await assert.rejects(waitForEtsyImport({ getImportProgress: async () => ({ isTerminal: false }) }, 'job', { maxAttempts: 2, sleep: async () => {} }), { code: 'IMPORT_PENDING' });
});

test('resume reuses the same CSV and key after losing an upload response', async () => {
  const run = { id: 'run', csv: 'immutable', scope: 'scope', marketplaceCode: 'ETSY_US', entries: [] };
  let calls = 0;
  const client = {
    uploadCsv: async (path, filename, csv, key) => {
      assert.equal(csv, 'immutable'); assert.equal(key, 'run'); calls += 1;
      if (calls === 1) throw new Error('network');
      return { jobId: 'job' };
    },
    getImportProgress: async () => ({ isTerminal: true, job: { status: 'COMPLETED', importedCount: 1 } }),
  };
  await assert.rejects(resumeEtsyImport({ run, client, scope: 'scope', save: async () => {} }), /network/);
  const result = await resumeEtsyImport({ run, client, scope: 'scope', save: async () => {} });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.jobId, 'job');
  assert.equal(calls, 2);
});

test('resume refuses a changed backend/shop scope before calling backend', async () => {
  await assert.rejects(resumeEtsyImport({ run: { scope: 'old' }, scope: 'new', client: {}, save: async () => {} }), /scope/);
});

test('order import completion unblocks image upload while post-import mapping waits for images', async () => {
  const result = await waitForEtsyImport({ getImportProgress: async () => ({ isTerminal: false, job: { status: 'COMPLETED', importedCount: 1 } }) }, 'job', { maxAttempts: 1 });
  assert.equal(result.success, true);
});

test('downloads original Etsy IPF images rather than captured thumbnails', () => {
  assert.equal(originalEtsyFileUrl({ downloadUrl: 'https://i.etsystatic.com/ipf/abc/ipf_75x75.jpg' }), 'https://i.etsystatic.com/ipf/abc/ipf_fullxfull.jpg');
  assert.throws(() => originalEtsyFileUrl({ downloadUrl: 'https://evil.test/photo.png' }), /host/);
});

test('restart after asset upload retries the manifest without downloading or uploading again', async () => {
  const run = { id: 'run', jobId: 'job', scope: 'scope', entries: [{ externalOrderId: '1', externalItemId: '2', files: [{ asset: { mediaAssetId: 'asset' } }] }] };
  let calls = 0;
  const client = {
    getImportProgress: async () => ({ job: { status: 'COMPLETED', importedCount: 1 } }),
    attachManifest: async (job, entries) => {
      assert.equal(job, 'job'); assert.equal(entries[0].assets[0].mediaAssetId, 'asset');
      calls += 1;
      if (calls === 1) throw new Error('lost manifest response');
      return { entries: [{ status: 'accepted', mappingQueued: true }] };
    },
  };
  const args = { run, client, scope: 'scope', save: async () => {}, downloadFile: async () => assert.fail('must reuse checkpoint') };
  await assert.rejects(resumeEtsyImport(args), /lost manifest/);
  assert.equal((await resumeEtsyImport(args)).status, 'COMPLETED');
});

test('failed image transfers retry at most three times and cannot complete import', async () => {
  const run = { id: 'run', jobId: 'job', scope: 'scope', entries: [{ externalOrderId: '1', externalItemId: '2', files: [{}] }] };
  let downloads = 0;
  const result = await resumeEtsyImport({ run, scope: 'scope', save: async () => {}, sleep: async () => {}, downloadFile: async () => { downloads += 1; throw new Error('network'); }, client: {
    getImportProgress: async () => ({ job: { status: 'COMPLETED' } }),
    attachManifest: async () => ({ entries: [{ status: 'needsReview' }] }),
  } });
  assert.equal(downloads, 3);
  assert.equal(result.failedFiles, 1);
  assert.equal(result.status, 'NEEDS_REVIEW');
});
