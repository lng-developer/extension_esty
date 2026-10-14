export function originalEtsyFileUrl(file) {
  const url = new URL(file.downloadUrl || file.previewUrl);
  if (url.protocol !== 'https:' || !(url.hostname === 'www.etsy.com' || url.hostname.endsWith('.etsystatic.com'))) throw new Error('Unsupported Etsy file host');
  if (url.hostname === 'i.etsystatic.com' && url.pathname.includes('/ipf/')) url.pathname = url.pathname.replace(/ipf_\d+x(?:\d+|N)/, 'ipf_fullxfull');
  return url.href;
}

export async function waitForEtsyImport(client, jobId, { maxAttempts = 30, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!jobId) throw new Error('Import job ID is required');
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const progress = await client.getImportProgress(jobId);
    if (progress?.isTerminal || ['COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(progress?.job?.status)) {
      const job = progress.job;
      return {
        importJobId: jobId,
        importedCount: Number(job.importedCount || 0),
        skippedCount: Number(job.skippedCount || 0),
        failedCount: Number(job.failedCount || 0),
        status: job.status,
        success: job.status === 'COMPLETED' && !job.failedCount,
      };
    }
    if (attempt + 1 < maxAttempts) await sleep(Math.min(1000 * (attempt + 1), 5000));
  }
  throw Object.assign(new Error('Import still pending; resume this job to check again'), { code: 'IMPORT_PENDING', importJobId: jobId });
}

export async function resumeEtsyImport({ run, client, scope, save, downloadFile, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (run.scope !== scope) throw new Error('Import scope changed; restore the original backend/shop');
  run.status = 'IMPORTING';
  await save(run);
  if (!run.jobId) {
    const uploaded = await client.uploadCsv('/api/integration/external-order-imports/etsy-sold-order-items', `etsy-${run.id}.csv`, run.csv, run.id, { marketplaceCode: run.marketplaceCode, ...(run.shopId ? { shopId: run.shopId } : {}) });
    run.jobId = uploaded.jobId || uploaded.id;
    await save(run);
  }
  run.result = await waitForEtsyImport(client, run.jobId, { sleep });
  await save(run);
  let failedFiles = 0;
  for (const entry of run.entries) {
    for (const file of entry.files) {
      if (file.asset) continue;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const blob = await downloadFile(file);
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > 10 * 1024 * 1024) throw Object.assign(new Error('Unsupported image type or size'), { status: 400 });
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((n) => n.toString(16).padStart(2, '0')).join('');
          const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
          file.asset = await client.uploadImportAsset(run.jobId, blob, `customer-${hash}.${extension}`, hash);
          delete file.error;
          await save(run);
          break;
        } catch (error) {
          if ([401, 403].includes(error.status)) throw error;
          file.error = error.code || 'FILE_TRANSFER_FAILED';
          if (attempt === 2 || (error.status >= 400 && error.status < 500 && error.status !== 429)) break;
          await sleep(1000 * (attempt + 1));
        }
      }
      if (!file.asset) failedFiles += 1;
    }
  }
  const results = [];
  for (let offset = 0; offset < run.entries.length; offset += 100) {
    const entries = run.entries.slice(offset, offset + 100).map((entry) => ({ externalOrderId: entry.externalOrderId, externalItemId: entry.externalItemId, assets: entry.files.filter((file) => file.asset).map((file) => ({ mediaAssetId: file.asset.mediaAssetId })) }));
    results.push(...(await client.attachManifest(run.jobId, entries)).entries);
  }
  run.manifest = results;
  run.failedFiles = failedFiles;
  run.status = run.result.success && !failedFiles && results.every((entry) => entry.status === 'accepted') ? 'COMPLETED' : 'NEEDS_REVIEW';
  await save(run);
  return run;
}
