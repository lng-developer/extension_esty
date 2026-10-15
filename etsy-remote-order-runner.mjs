import { toEtsySoldOrderItemsCsv } from './lng-web-be-import-csv.mjs';
import { resumeEtsyImport } from './etsy-import-runner.mjs';

export function createEtsyCapture(orders, { id, scope, shopId, limit }) {
  return {
    id, scope, shopId, marketplaceCode: 'ETSY_US', limit, status: 'PREVIEW', orderCount: orders.length,
    itemCount: orders.reduce((count, order) => count + order.items.length, 0),
    csv: toEtsySoldOrderItemsCsv(orders),
    entries: orders.flatMap(order => order.items.filter(item => item.customFiles?.length || item.customFilesNeedsReview)
      .map(item => ({ externalOrderId: String(order.orderId), externalItemId: String(item.transactionId),
        files: (item.customFiles || []).map(file => ({ downloadUrl: file.downloadUrl, previewUrl: file.previewUrl })) }))),
  };
}

export async function runRemoteEtsyOrders({ command, client, scope, load, save, collect, downloadFile, assertLease }) {
  if (command.type !== 'IMPORT_NEW_ORDERS' || command.origin !== 'WEB' || !Number.isInteger(command.maxOrders) || command.maxOrders < 1 || command.maxOrders > 200) throw new Error('UNSUPPORTED_ETSY_COMMAND');
  await assertLease();
  let run = await load();
  if (run && (run.id !== command.id || run.scope !== scope)) throw new Error('Remote checkpoint scope or command changed');
  if (!run) {
    const orders = await collect(command.maxOrders);
    run = createEtsyCapture(orders, { id: command.id, scope, shopId: scope.split('|')[1], limit: command.maxOrders });
    await save(run);
  }
  if (!run.orderCount) return { success: true, importedCount: 0, failedCount: 0 };
  if (run.status !== 'COMPLETED') await resumeEtsyImport({ run, client, scope, save, downloadFile, assertLease });
  await assertLease(run.jobId);
  return { success: run.status === 'COMPLETED', importJobId: run.jobId, importedCount: run.result?.importedCount || 0, failedCount: run.result?.failedCount || 0,
    ...(run.status !== 'COMPLETED' ? { errorMessage: 'ETSY_IMPORT_NEEDS_REVIEW' } : {}) };
}
