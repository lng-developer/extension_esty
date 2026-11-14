const $ = (id) => document.getElementById(id);
let currentRun = null;
let savedConfig = null;
let busy = false;
async function send(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, payload });
  if (!response?.ok) throw new Error(response?.message || 'Không thể thực hiện. Hãy kiểm tra kết nối và thử lại.');
  return response.data;
}
let statementCsvContent = null;
let statementFilename = null;
function controls() {
  $('pull').disabled = Boolean(busy || !savedConfig || (currentRun && !['PREVIEW', 'COMPLETED'].includes(currentRun.status)));
  $('import').disabled = busy || !savedConfig || !currentRun?.orderCount || currentRun.status === 'COMPLETED';
  $('clear').disabled = busy || !currentRun;
  $('save').disabled = busy;
  $('refresh').disabled = busy;
  if ($('importStatement')) $('importStatement').disabled = Boolean(busy || !savedConfig || !statementCsvContent);
}
function render(run) {
  currentRun = run;
  const files = (run?.entries || []).flatMap(entry => entry.files || []);
  $('orders').textContent = String(run?.orderCount || 0);
  $('items').textContent = String(run?.itemCount || 0);
  $('uploaded').textContent = `${files.filter(file => file.asset).length} / ${files.length}`;
  const messages = {
    PREVIEW: 'Đã kéo dữ liệu. Kiểm tra đúng shop trước khi xác nhận import.',
    IMPORTING: 'Lượt import đang xử lý hoặc đã gián đoạn. Xem tiến độ; bấm tiếp tục nếu cần.',
    PAUSED: 'Lượt import tạm dừng. Kiểm tra kết nối/token rồi bấm tiếp tục.',
    NEEDS_REVIEW: 'Có dữ liệu cần kiểm tra. Xem đơn trong LNG; có thể tiếp tục để thử lại phần lỗi.',
    COMPLETED: 'Đã hoàn tất import. Mở LNG để kiểm tra đơn, listing và ảnh.',
  };
  $('status').textContent = run ? messages[run.status] || 'Trạng thái chưa xác định. Xem thông tin hỗ trợ.' : 'Chưa có dữ liệu. Bắt đầu với 1 đơn để kiểm tra.';
  $('status').dataset.error = String(['PAUSED', 'NEEDS_REVIEW'].includes(run?.status));
  $('result').textContent = run?.result ? `Item đã import: ${run.result.importedCount || 0} · Bỏ qua: ${run.result.skippedCount || 0} · Lỗi: ${run.result.failedCount || 0} · Ảnh lỗi: ${run.failedFiles ?? files.filter(file => file.error).length}` : 'Ảnh được tải lên backend sau khi bạn xác nhận import.';
  $('target').textContent = savedConfig ? `Đích cấu hình: ${savedConfig.apiBaseUrl} · Shop ${savedConfig.shopName || savedConfig.shopId}` : 'Mở Cài đặt kết nối để chọn backend và xác thực token.';
  $('connection').textContent = savedConfig ? 'Đã xác thực khi lưu · bấm kết nối để kiểm tra lại' : 'Cần cấu hình / token';
  $('preview').textContent = run ? `Lượt kéo: ${run.id || '—'}\nJob: ${run.jobId || 'Chưa tạo'}\nShop lượt kéo: ${run.shopId || '—'}\nLỗi: ${run.error || 'Không'}\nManifest: ${(run.manifest || []).map(entry => `${entry.externalItemId}: ${entry.status}`).join(', ') || 'Chưa có'}` : 'Chưa có lượt kéo.';
  $('import').textContent = run && run.status !== 'PREVIEW' ? 'Tiếp tục import' : 'Xác nhận import';
  controls();
}
async function act(fn) {
  if (busy) return;
  busy = true; controls();
  try { await fn(); } catch (error) { $('status').textContent = error.message; $('status').dataset.error = 'true'; }
  finally { busy = false; controls(); }
}
$('config').onsubmit = (event) => {
  event.preventDefault();
  act(async () => {
    const config = { apiBaseUrl: $('base').value, extensionToken: $('token').value.trim() };
    $('status').textContent = 'Đang xác thực token và nhận diện shop…';
    savedConfig = await send('ETSY_MANUAL_CONFIG', config);
    $('shop').value = `${savedConfig.shopName || 'Shop'} · ${savedConfig.shopId}`;
    $('token').value = '';
    $('settings').open = false;
    render(currentRun);
  });
};
$('pull').onclick = () => act(async () => {
  const limit = Number($('limit').value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Số đơn phải từ 1 đến 200.');
  $('status').textContent = 'Đang đọc đơn và thông tin ảnh từ Etsy…';
  render(await send('ETSY_MANUAL_PULL', { limit }));
});
$('import').onclick = () => act(async () => {
  if (!confirm(`Gửi đơn và ảnh khách hàng tới ${savedConfig.apiBaseUrl}, shop ${savedConfig.shopId}? Dữ liệu sẽ được ghi vào backend này.`)) return;
  await send('ETSY_MANUAL_IMPORT');
  $('status').textContent = 'Đã bắt đầu import. Bấm Xem tiến độ để cập nhật; nếu bị gián đoạn, bấm Tiếp tục import.';
  $('import').textContent = 'Tiếp tục import';
});
$('refresh').onclick = () => act(async () => render(await send('ETSY_MANUAL_STATUS')));
$('clear').onclick = () => act(async () => { if (confirm('Xóa preview/checkpoint cục bộ? Dữ liệu backend không bị xóa. Bạn sẽ mất khả năng tiếp tục lượt này.')) render(await send('ETSY_MANUAL_CLEAR')); });
if ($('statement')) {
  $('statement').onchange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    statementFilename = file.name;
    const reader = new FileReader();
    reader.onload = (event) => {
      statementCsvContent = event.target.result;
      const lines = statementCsvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const rowCount = Math.max(0, lines.length - 1);
      const isVnd = statementCsvContent.includes('₫') || statementCsvContent.includes('VND');
      const orderMatches = statementCsvContent.match(/Order\s*#?\d{8,}/gi) || [];
      const uniqueOrders = new Set(orderMatches.map((m) => m.replace(/[^0-9]/g, '')));

      if ($('stmtStats')) $('stmtStats').style.display = 'grid';
      if ($('stmtTotalRows')) $('stmtTotalRows').textContent = String(rowCount);
      if ($('stmtDetectedCurrency')) $('stmtDetectedCurrency').textContent = isVnd ? 'VND (Sẽ đổi USD)' : 'USD';
      if ($('stmtOrderCount')) $('stmtOrderCount').textContent = String(uniqueOrders.size);
      if ($('stmtStatus')) {
        $('stmtStatus').style.display = 'block';
        $('stmtStatus').dataset.error = 'false';
        $('stmtStatus').textContent = `Đã đọc file "${file.name}". Bấm nút bên dưới để gửi lên backend và cập nhật phí thực tế.`;
      }
      controls();
    };
    reader.readAsText(file);
  };
}
if ($('importStatement')) {
  $('importStatement').onclick = () => act(async () => {
    if (!statementCsvContent) throw new Error('Vui lòng chọn file sao kê CSV trước.');
    if (!savedConfig) throw new Error('Vui lòng cấu hình kết nối và token trước.');
    if ($('stmtStatus')) {
      $('stmtStatus').style.display = 'block';
      $('stmtStatus').dataset.error = 'false';
      $('stmtStatus').textContent = 'Đang tải sao kê lên backend và phân bổ phí sàn / hoàn tiền...';
    }
    controls();

    const result = await send('ETSY_MANUAL_IMPORT_STATEMENT', {
      csvText: statementCsvContent,
      filename: statementFilename || 'etsy_statement.csv',
    });

    if ($('stmtStatus')) {
      $('stmtStatus').style.display = 'block';
      $('stmtStatus').dataset.error = 'false';
      $('stmtStatus').textContent = 'Đồng bộ sao kê thành công!';
    }
    if ($('stmtResult')) {
      $('stmtResult').textContent = `Giao dịch đã xử lý: ${result?.validRows ?? result?.summary?.validRows ?? 'Thành công'} · Phí sàn & thuế đã cập nhật sang USD · Snapshot tài chính đã được tính lại.`;
    }
    $('statement').value = '';
    statementCsvContent = null;
    statementFilename = null;
    controls();
  });
}
act(async () => {
  let { etsyManualConfig } = await chrome.storage.session.get('etsyManualConfig');
  if (!etsyManualConfig?.extensionToken && chrome.storage?.local?.get) {
    const local = await chrome.storage.local.get('etsyManualConfig').catch(() => null);
    if (local?.etsyManualConfig?.extensionToken) {
      etsyManualConfig = local.etsyManualConfig;
      if (chrome.storage?.session?.set) {
        await chrome.storage.session.set({ etsyManualConfig }).catch(() => null);
      }
    }
  }
  if (etsyManualConfig?.extensionToken) {
    $('base').value = etsyManualConfig.apiBaseUrl;
    if (etsyManualConfig.shopName) {
      savedConfig = { apiBaseUrl: etsyManualConfig.apiBaseUrl, shopId: etsyManualConfig.shopId, shopName: etsyManualConfig.shopName };
      $('shop').value = `${savedConfig.shopName} · ${savedConfig.shopId}`;
      $('settings').open = false;
    }
  }
  render(await send('ETSY_MANUAL_STATUS'));
});
