import { buildActivityRuns, createExtensionLogger, formatVietnamTime } from './extensionLogger.mjs';

const $ = (selector) => document.querySelector(selector);
const log = (message) => {
  const el = $('#log');
  if (el) el.textContent = message;
};
const today = () => new Date().toISOString().slice(0, 10);
const tabs = [...document.querySelectorAll('[data-tab]')];
const panels = [...document.querySelectorAll('[data-panel]')];
const extensionLogger = createExtensionLogger({ storage: chrome.storage.local });
const connectionStatusKey = 'extensionConnectionStatus';
const MESSAGE_TIMEOUT_MS = 30000;

let currentRun = null;
let statementCsvContent = null;
let statementFilename = null;

function sendMessageWithTimeout(message) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Extension service worker không phản hồi trong 30 giây')), MESSAGE_TIMEOUT_MS)
    ),
  ]);
}

function relativeTime(target) {
  const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  return seconds ? `in ${seconds}s` : 'now';
}

async function renderConnectionStatus() {
  const stored = await chrome.storage.local.get([
    connectionStatusKey,
    'lngWebBeClientId',
    'shopId',
    'shopName',
    'etsyManualConfig'
  ]);
  const state = stored[connectionStatusKey];
  const clientId = stored.lngWebBeClientId;
  const agent = clientId ? `Ext …${clientId.slice(-6)} · ` : '';
  const beEl = $('#beConnection');
  const pollEl = $('#bePoll');
  const statusDot = document.querySelector('.status-dot');

  if (state?.state === 'CONNECTED') {
    const timeStr = state.lastHeartbeatAt ? new Date(state.lastHeartbeatAt).toLocaleTimeString() : 'vừa xong';
    beEl.textContent = `${agent}BE: Connected · Heartbeat ${timeStr}`;
    pollEl.textContent = `Next poll: ${state?.nextPollAt ? relativeTime(state.nextPollAt) : '-'}`;
    if (statusDot) statusDot.classList.remove('is-offline');
  } else if (state?.state === 'NOT_CONFIGURED') {
    beEl.textContent = 'BE: Not configured · Cần nhập Extension Token';
    pollEl.textContent = 'Next poll: -';
    if (statusDot) statusDot.classList.add('is-offline');
  } else {
    beEl.textContent = `${agent}BE: Last poll failed / Đang kết nối lại`;
    pollEl.textContent = `Next poll: ${state?.nextPollAt ? relativeTime(state.nextPollAt) : '-'}`;
    if (statusDot) statusDot.classList.add('is-offline');
  }

  // Populate shopInfo if available
  const shopName = state?.shopName || stored.shopName || stored.etsyManualConfig?.shopName;
  const shopId = state?.shopId || stored.shopId || stored.etsyManualConfig?.shopId;
  if (shopId && $('#shopInfo')) {
    $('#shopInfo').value = `${shopName || 'Shop'} · ${shopId}`;
  }
}

function renderOrders(run) {
  currentRun = run;
  const files = (run?.entries || []).flatMap((entry) => entry.files || []);
  $('#ordersCount').textContent = String(run?.orderCount || 0);
  $('#itemsCount').textContent = String(run?.itemCount || 0);
  $('#uploadedCount').textContent = `${files.filter((f) => f.asset).length} / ${files.length}`;

  const messages = {
    PREVIEW: 'Đã kéo dữ liệu từ Etsy. Kiểm tra số đơn và bấm "Xác nhận import".',
    IMPORTING: 'Đang xử lý import đơn và tải ảnh lên LNG backend…',
    PAUSED: 'Lượt import tạm dừng. Kiểm tra kết nối mạng rồi bấm "Tiếp tục import".',
    NEEDS_REVIEW: 'Có đơn hoặc ảnh cần kiểm tra lại trên hệ thống.',
    COMPLETED: 'Đã hoàn tất import đơn và ảnh lên LNG backend thành công!',
  };

  const progressEl = $('#orderProgress');
  progressEl.textContent = run
    ? messages[run.status] || 'Đang xử lý…'
    : 'Chưa có dữ liệu. Bấm "Kéo đơn từ Etsy" để bắt đầu.';
  progressEl.dataset.state = run?.status || 'IDLE';

  $('#btnConfirmImport').disabled = !run || !run.orderCount || run.status === 'COMPLETED';
  $('#btnConfirmImport').textContent = run && run.status !== 'PREVIEW' ? 'Tiếp tục import' : 'Xác nhận import';
  $('#btnClearPreview').disabled = !run;

  const preview = $('#previewDetails');
  if (preview) {
    preview.textContent = run
      ? `Run ID: ${run.id || '—'}\nImport Job: ${run.jobId || 'Chưa tạo'}\nShop ID: ${run.shopId || '—'}\nTrạng thái: ${run.status || '—'}\nLỗi: ${run.error || 'Không'}\nManifest:\n${(run.manifest || []).map((m) => ` - Item ${m.externalItemId}: ${m.status}`).join('\n') || ' (Trống)'}`
      : 'Chưa có lượt kéo.';
  }
}

async function renderLogs() {
  const events = await extensionLogger.getEvents();
  const container = $('#logEntries');
  const runs = buildActivityRuns(events);
  container.replaceChildren();

  if (!runs.length) {
    container.textContent = 'Chưa có hoạt động nào.';
    return;
  }

  [...runs].reverse().forEach((run) => {
    const card = document.createElement('article');
    card.className = `activity-run is-${run.status.toLowerCase()}`;

    const header = document.createElement('div');
    header.className = 'activity-run-header';

    const title = document.createElement('strong');
    title.textContent = run.label;

    const status = document.createElement('span');
    status.className = 'activity-status';
    status.textContent = run.status;

    header.append(title, status);

    const meta = document.createElement('p');
    meta.textContent = `${formatVietnamTime(run.startedAt)}${run.commandId ? ` · ${run.commandId}` : ''}`;
    card.append(header, meta);

    if (run.error) {
      const error = document.createElement('p');
      error.className = 'activity-error';
      error.textContent = run.error;
      card.append(error);
    }

    const details = document.createElement('details');
    details.className = 'activity-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Chi tiết sự kiện';
    const raw = document.createElement('pre');
    raw.textContent = run.events
      .map((ev) => `${ev.timestamp} [${ev.level.toUpperCase()}] ${ev.message}${ev.context ? ` ${JSON.stringify(ev.context)}` : ''}`)
      .join('\n');
    details.append(summary, raw);
    card.append(details);

    container.append(card);
  });
}

function activateTab(name) {
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  panels.forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (name === 'logs') void renderLogs();
}

async function checkHeartbeatNow() {
  log('Đang kiểm tra kết nối Heartbeat…');
  try {
    const result = await sendMessageWithTimeout({ type: 'HEARTBEAT_NOW' });
    if (result?.ok) {
      log('Kết nối thành công. Heartbeat đã được ghi nhận.');
      await extensionLogger.logInfo('Heartbeat check completed', { result });
    } else {
      log(`Heartbeat thất bại: ${result?.error || result?.message || 'Lỗi không xác định'}`);
      await extensionLogger.logError(null, { result }, 'Heartbeat check failed');
    }
  } catch (error) {
    log(`Heartbeat thất bại: ${error.message}`);
    await extensionLogger.logError(error, null, 'Heartbeat exception');
  }
  await renderConnectionStatus();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Date pickers default
  if ($('#adsDateFrom')) $('#adsDateFrom').value = today();
  if ($('#adsDateTo')) $('#adsDateTo').value = today();

  // Load saved settings
  const saved = await chrome.storage.local.get([
    'lngWebBeApiBaseUrl',
    'extensionToken',
    'shopId',
    'shopName',
    'etsyManualConfig'
  ]);
  const baseUrl = saved.lngWebBeApiBaseUrl || saved.etsyManualConfig?.apiBaseUrl || 'https://ecomatrix.lngmerch.co';
  if ($('#apiBaseUrl')) $('#apiBaseUrl').value = baseUrl;
  const token = saved.extensionToken || saved.etsyManualConfig?.extensionToken || '';
  if (token && $('#extensionToken')) $('#extensionToken').value = token;

  // Tabs listener
  tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

  // Check now button
  $('#btnCheckNow').addEventListener('click', () => void checkHeartbeatNow());

  // Save Settings button
  $('#btnSaveSettings').addEventListener('click', async () => {
    const apiBaseUrl = $('#apiBaseUrl').value.trim();
    const extensionToken = $('#extensionToken').value.trim();
    if (!extensionToken.startsWith('lng_ext_')) {
      alert('Extension Token phải bắt đầu bằng lng_ext_');
      return;
    }
    log('Đang xác thực cấu hình và nhận diện shop…');
    $('#btnSaveSettings').disabled = true;
    try {
      const response = await sendMessageWithTimeout({
        action: 'ETSY_MANUAL_CONFIG',
        payload: { apiBaseUrl, extensionToken }
      });
      if (response?.ok && response?.data) {
        const verified = response.data;
        $('#shopInfo').value = `${verified.shopName || 'Shop'} · ${verified.shopId}`;
        log(`Đã kết nối thành công: ${verified.shopName}`);
        await extensionLogger.logInfo('Settings saved & verified', verified);
        await checkHeartbeatNow();
      } else {
        throw new Error(response?.message || 'Xác thực thất bại');
      }
    } catch (error) {
      log(`Lỗi lưu cấu hình: ${error.message}`);
      alert(`Lỗi cấu hình: ${error.message}`);
    } finally {
      $('#btnSaveSettings').disabled = false;
    }
  });

  // Orders Actions
  $('#btnPullOrders').addEventListener('click', async () => {
    const limit = Math.min(Math.max(Number($('#maxOrders').value) || 50, 1), 200);
    log(`Đang kéo tối đa ${limit} đơn từ Etsy…`);
    $('#btnPullOrders').disabled = true;
    try {
      const response = await sendMessageWithTimeout({
        action: 'ETSY_MANUAL_PULL',
        payload: { maxOrders: limit }
      });
      if (response?.ok) {
        renderOrders(response.data);
        log(`Đã kéo xong ${response.data?.orderCount || 0} đơn.`);
        await extensionLogger.logInfo('Pulled orders preview', { orderCount: response.data?.orderCount });
      } else {
        throw new Error(response?.message || 'Không thể kéo đơn');
      }
    } catch (error) {
      log(`Lỗi kéo đơn: ${error.message}`);
      alert(`Lỗi kéo đơn: ${error.message}`);
    } finally {
      $('#btnPullOrders').disabled = false;
    }
  });

  $('#btnReimportOrder').addEventListener('click', async () => {
    const orderId = $('#reimportOrderId').value.trim();
    if (!/^\d+$/.test(orderId)) {
      alert('Etsy Order ID phải là chuỗi số hợp lệ');
      return;
    }

    log(`Đang re-import order ${orderId}…`);
    $('#btnReimportOrder').disabled = true;
    try {
      const response = await sendMessageWithTimeout({
        action: 'ETSY_MANUAL_REIMPORT',
        payload: { orderId }
      });
      if (!response?.ok) throw new Error(response?.message || 'Không thể re-import đơn');
      renderOrders(response.data);
      log(`Đã bắt đầu re-import order ${orderId}.`);
    } catch (error) {
      log(`Lỗi re-import order ${orderId}: ${error.message}`);
      alert(`Lỗi re-import: ${error.message}`);
    } finally {
      $('#btnReimportOrder').disabled = false;
    }
  });

  $('#btnUploadTracking').addEventListener('click', async () => {
    const orderId = $('#trackingOrderId').value.trim();
    const trackingNumber = $('#trackingNumber').value.trim();
    const carrier = $('#trackingCarrier').value.trim();
    if (!/^\d+$/.test(orderId)) return alert('Etsy Order ID phải là chuỗi số hợp lệ');
    if (!trackingNumber) return alert('Cần nhập Tracking Number');

    $('#btnUploadTracking').disabled = true;
    log(`Đang push tracking cho order ${orderId}…`);
    try {
      const response = await sendMessageWithTimeout({
        action: 'ETSY_MANUAL_UPLOAD_TRACKING',
        payload: { orderId, trackingNumber, carrier }
      });
      if (!response?.ok) throw new Error(response?.message || 'Không thể push tracking');
      log(`Đã push tracking cho order ${orderId}.`);
      alert(`Đã push tracking cho order ${orderId}.`);
    } catch (error) {
      log(`Lỗi push tracking order ${orderId}: ${error.message}`);
      alert(`Lỗi push tracking: ${error.message}`);
    } finally {
      $('#btnUploadTracking').disabled = false;
    }
  });

  $('#btnConfirmImport').addEventListener('click', async () => {
    log('Đang bắt đầu import đơn và upload ảnh…');
    $('#btnConfirmImport').disabled = true;
    try {
      const response = await sendMessageWithTimeout({ action: 'ETSY_MANUAL_IMPORT' });
      if (response?.ok) {
        log('Đã bắt đầu import. Kiểm tra tiến độ bên dưới.');
        await extensionLogger.logInfo('Import confirmed and running');
        const statusRes = await sendMessageWithTimeout({ action: 'ETSY_MANUAL_STATUS' });
        if (statusRes?.ok) renderOrders(statusRes.data);
      } else {
        throw new Error(response?.message || 'Không thể import');
      }
    } catch (error) {
      log(`Lỗi import: ${error.message}`);
      alert(`Lỗi: ${error.message}`);
      $('#btnConfirmImport').disabled = false;
    }
  });

  $('#btnRefreshStatus').addEventListener('click', async () => {
    try {
      const response = await sendMessageWithTimeout({ action: 'ETSY_MANUAL_STATUS' });
      if (response?.ok) {
        renderOrders(response.data);
        log('Đã cập nhật tiến độ import.');
      }
    } catch (error) {
      log(`Lỗi lấy tiến độ: ${error.message}`);
    }
  });

  $('#btnClearPreview').addEventListener('click', async () => {
    if (!confirm('Bạn có chắc muốn xóa dữ liệu preview này?')) return;
    try {
      await sendMessageWithTimeout({ action: 'ETSY_MANUAL_CLEAR' });
      renderOrders(null);
      log('Đã xóa preview.');
    } catch (error) {
      log(`Lỗi xóa preview: ${error.message}`);
    }
  });

  // Ads Spend
  $('#btnExportAds').addEventListener('click', async () => {
    const dateFrom = $('#adsDateFrom').value;
    const dateTo = $('#adsDateTo').value;
    if (!dateFrom || !dateTo) {
      alert('Vui lòng chọn ngày hợp lệ');
      return;
    }
    log(`Đang chạy import Etsy Ads spend từ ${dateFrom} đến ${dateTo}…`);
    $('#btnExportAds').disabled = true;
    $('#adsProgress').textContent = 'Đang đồng bộ chi phí Etsy Ads…';
    try {
      const response = await sendMessageWithTimeout({
        type: 'RUN_ADS_SPEND',
        payload: { dateFrom, dateTo }
      });
      if (response?.ok) {
        $('#adsProgress').textContent = `Import Ads hoàn thành: ${response.importedCount || 0} dòng.`;
        log('Import Etsy Ads thành công.');
        await extensionLogger.logInfo('Etsy Ads import succeeded', response);
      } else {
        throw new Error(response?.error || response?.message || 'Lỗi import Ads');
      }
    } catch (error) {
      $('#adsProgress').textContent = `Lỗi: ${error.message}`;
      log(`Lỗi import Ads: ${error.message}`);
    } finally {
      $('#btnExportAds').disabled = false;
    }
  });

  // Settlements
  $('#statementFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      statementCsvContent = await file.text();
      statementFilename = file.name;

      const lines = statementCsvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const totalRows = Math.max(0, lines.length - 1);
      $('#stmtTotalRows').textContent = String(totalRows);

      const hasVND = statementCsvContent.includes('₫') || /VND/i.test(statementCsvContent);
      const detectedCurrency = hasVND ? 'VND' : 'USD';
      $('#stmtDetectedCurrency').textContent = detectedCurrency;

      // Extract unique orders from CSV
      const orderMatches = statementCsvContent.match(/\b\d{9,12}\b/g) || [];
      const uniqueOrders = new Set(orderMatches);
      $('#stmtOrderCount').textContent = String(uniqueOrders.size);

      $('#btnImportStatement').disabled = false;
      $('#stmtStatus').textContent = `Đã phân tích: ${totalRows} dòng · Tiền tệ: ${detectedCurrency}. Sẵn sàng gửi lên LNG.`;
      log(`File ${file.name} đã được phân tích.`);
    } catch (error) {
      $('#stmtStatus').textContent = `Lỗi đọc file: ${error.message}`;
      $('#btnImportStatement').disabled = true;
    }
  });

  $('#btnImportStatement').addEventListener('click', async () => {
    if (!statementCsvContent) return;
    log('Đang gửi sao kê lên backend LNG…');
    $('#btnImportStatement').disabled = true;
    $('#stmtStatus').textContent = 'Đang gửi sao kê lên LNG Finance…';
    try {
      const response = await sendMessageWithTimeout({
        action: 'ETSY_MANUAL_IMPORT_STATEMENT',
        payload: {
          csvText: statementCsvContent,
          filename: statementFilename
        }
      });
      if (response?.ok) {
        $('#stmtStatus').textContent = 'Đã import sao kê thành công lên hệ thống!';
        log('Import sao kê thành công.');
        await extensionLogger.logInfo('Statement import completed', { filename: statementFilename });
      } else {
        throw new Error(response?.message || 'Không thể upload sao kê');
      }
    } catch (error) {
      $('#stmtStatus').textContent = `Lỗi upload sao kê: ${error.message}`;
      log(`Lỗi upload sao kê: ${error.message}`);
    } finally {
      $('#btnImportStatement').disabled = false;
    }
  });

  // Logs Actions
  $('#btnCopyLogs').addEventListener('click', async () => {
    const events = await extensionLogger.getEvents();
    await navigator.clipboard.writeText(
      [...events]
        .reverse()
        .map((ev) => `${ev.timestamp} [${ev.level.toUpperCase()}] ${ev.message}${ev.context ? ` ${JSON.stringify(ev.context)}` : ''}`)
        .join('\n')
    );
    log('Đã copy logs vào clipboard.');
  });

  $('#btnClearLogs').addEventListener('click', async () => {
    await extensionLogger.clear();
    await renderLogs();
    log('Đã xóa logs.');
  });

  // Initial load
  await renderConnectionStatus();
  try {
    const statusRes = await sendMessageWithTimeout({ action: 'ETSY_MANUAL_STATUS' });
    if (statusRes?.ok) renderOrders(statusRes.data);
  } catch {
    // service worker will report status on next tick
  }

  // Periodic renders
  window.setInterval(() => {
    void renderConnectionStatus();
  }, 1000);

  window.setInterval(async () => {
    if (!$('#panel-orders').hidden && currentRun && currentRun.status === 'IMPORTING') {
      try {
        const res = await sendMessageWithTimeout({ action: 'ETSY_MANUAL_STATUS' });
        if (res?.ok) renderOrders(res.data);
      } catch {
        // ignore
      }
    }
    if (!$('#panel-logs').hidden) {
      void renderLogs();
    }
  }, 3000);
});
