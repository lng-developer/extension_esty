const btnGetOrders = document.getElementById("btnGetOrders");
const btnSyncEtsyListings = document.getElementById("btnSyncEtsyListings");
const btnSaveCfg = document.getElementById("btnSaveCfg");
const inputShopId = document.getElementById("mongoShopId");
const inputBackend = document.getElementById("backendUrl");
const btnUploadTracking = document.getElementById("btnUploadTracking");
const inputTrackingOrderId = document.getElementById("trackingOrderId");
const inputTrackingNumber = document.getElementById("trackingNumber");
const btnImportEtsyAds = document.getElementById("btnImportEtsyAds");
const btnImportEtsyAdsFull = document.getElementById("btnImportEtsyAdsFull");
const inputEtsyAdsDate = document.getElementById("etsyAdsDate");
const inputEtsyAdsBackendUrl = document.getElementById("etsyAdsBackendUrl");
const btnOpenTriggerModal = document.getElementById("btnOpenTriggerModal");
const btnCloseTriggerModal = document.getElementById("btnCloseTriggerModal");
const triggerModalOverlay = document.getElementById("triggerModalOverlay");
const btnOpenAutoConfig = document.getElementById("btnOpenAutoConfig");
const btnCloseAutoConfigModal = document.getElementById("btnCloseAutoConfigModal");
const autoConfigModalOverlay = document.getElementById("autoConfigModalOverlay");
const btnAutoConfigStatus = document.getElementById("btnAutoConfigStatus");
const btnReloadAutoConfig = document.getElementById("btnReloadAutoConfig");
const btnEtsyMessageSyncDebug = document.getElementById("btnEtsyMessageSyncDebug");
const btnEtsyMessageMonitorTick = document.getElementById("btnEtsyMessageMonitorTick");
const autoConfigSummary = document.getElementById("autoConfigSummary");
const autoConfigList = document.getElementById("autoConfigList");
const autoConfigAlarmList = document.getElementById("autoConfigAlarmList");
const logEl = document.getElementById("log");


const DEFAULT_ETSY_ADS_BACKEND_URL = "https://api.lngmerch.co/api/etsy-ads";
const DEFAULT_BACKEND_URL = "https://api.lngmerch.co/api/etsy/";
const ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY = "etsyMessageMonitorDebugLogs";
let autoConfigRefreshTimer = null;
console.log("[LNG][popup] popup.js loaded");

function renderLog(message, data) {
  if (data !== undefined) {
    logEl.textContent = `${message}\n${JSON.stringify(data, null, 2)}`;
  } else {
    logEl.textContent = message;
  }
}

function summarizeEtsyMessageSyncDebugResult(data = {}) {
  const threads = Array.isArray(data?.threads) ? data.threads : [];
  const summary = data?.summary || {};

  return {
    ok: data?.ok === true,
    source: data?.source || "",
    syncedAt: data?.syncedAt || summary?.syncedAt || "",
    totalThreads: Number(summary?.totalThreads ?? threads.length) || 0,
    unreadThreads: Number(
      summary?.unreadThreads ??
      threads.filter((thread) => thread?.unread === true).length
    ) || 0,
    threadsWithOrderId: Number(
      summary?.threadsWithOrderId ??
      threads.filter((thread) => Boolean(thread?.orderId)).length
    ) || 0,
    sampleThreads: threads.slice(0, 8).map((thread) => ({
      threadId: thread?.threadId || "",
      buyerName: thread?.buyerName || "",
      orderId: thread?.orderId || "",
      unread: thread?.unread === true,
      lastMessageAt: thread?.lastMessageAt || "",
      latestMessagePreview: thread?.latestMessagePreview || ""
    }))
  };
}

async function getLatestEtsyMessageMonitorDebugLogs(limit = 10) {
  const cfg = await chrome.storage.local.get([ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY]);
  const logs = Array.isArray(cfg[ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY])
    ? cfg[ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY]
    : [];

  return logs.slice(-limit).reverse();
}

async function getEtsyMessageMonitorStatusForPopup() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_MESSAGE_MONITOR_STATUS"
    });

    if (!response?.ok) {
      throw new Error(response?.message || "ETSY_MESSAGE_MONITOR_STATUS failed");
    }

    return response.data || null;
  } catch (error) {
    return {
      error: error?.message || String(error)
    };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value) {
  if (!value) return "N/A";

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);

  return date.toLocaleString();
}

function formatAlarmNextRun(scheduledTime) {
  if (!scheduledTime) return "N/A";

  const date = new Date(Number(scheduledTime));
  if (!Number.isFinite(date.getTime())) return "N/A";

  return date.toLocaleString();
}

function getAutoConfigTypeLabel(type) {
  const normalizedType = String(type || "").toUpperCase();
  const labels = {
    ETSY_AUTO_CFG_SYNC: "⚙️ Auto Config Sync",
    IMPORT_ORDER: "📦 Import Orders",
    IMPORT_ADS: "📈 Import Etsy Ads",
    IMPORT_FBM: "🧾 Sync Etsy Listings",
    UPLOAD_TRACKING: "📤 Upload Tracking",
    PULL_TRACKING: "🔁 Pull Pending Tracking"
  };

  return labels[normalizedType] || normalizedType || "Unknown";
}

function getAlarmNameForType(type) {
  return "ETSY_AUTO_" + String(type || "").trim().toUpperCase();
}

function getAutoConfigStatusBadge(status) {
  return status === true
    ? '<span class="badge badge-on">Bật</span>'
    : '<span class="badge badge-off">Tắt</span>';
}

function renderAutoConfigError(error) {
  if (autoConfigSummary) {
    autoConfigSummary.innerHTML = `<span class="error-text">${escapeHtml(error?.message || String(error))}</span>`;
  }

  if (autoConfigList) {
    autoConfigList.textContent = "Không tải được Auto Config records.";
  }

  if (autoConfigAlarmList) {
    autoConfigAlarmList.textContent = "Không tải được alarm status.";
  }
}

function renderAutoConfigStatus(data) {
  const snapshot = data?.snapshot || {};
  const records = Array.isArray(snapshot.records) ? snapshot.records : [];
  const alarms = Array.isArray(data?.alarms)
    ? data.alarms
    : Array.isArray(snapshot.alarms)
      ? snapshot.alarms
      : [];
  const enabledRecords = records.filter((record) => record?.status === true);
  const alarmMap = new Map(
    alarms.map((alarm) => [String(alarm?.name || ""), alarm])
  );

  if (autoConfigSummary) {
    const errorHtml = snapshot.error
      ? `<div class="error-text">Error: ${escapeHtml(snapshot.error)}</div>`
      : "";

    autoConfigSummary.innerHTML = [
      `<div><strong>Fetched At:</strong> ${escapeHtml(formatDateTime(snapshot.fetchedAt))}</div>`,
      `<div><strong>Records:</strong> ${records.length}</div>`,
      `<div><strong>Enabled:</strong> ${enabledRecords.length}</div>`,
      `<div><strong>Alarms:</strong> ${alarms.length}</div>`,
      errorHtml
    ].join("");
  }

  if (autoConfigList) {
    if (!records.length) {
      autoConfigList.innerHTML = '<div class="muted">No Auto Config records.</div>';
    } else {
      autoConfigList.innerHTML = records.map((record) => {
        const type = String(record?.type || "").toUpperCase();
        const alarmName = getAlarmNameForType(type);
        const matchedAlarm = alarmMap.get(alarmName);
        const warnings = [];

        if (record?.status === true && !matchedAlarm) {
          warnings.push("Enabled but alarm missing");
        }

        if (record?.status !== true && matchedAlarm) {
          warnings.push("Disabled but alarm still exists");
        }

        const warningHtml = warnings.length
          ? `<div class="warn">${escapeHtml(warnings.join("; "))}</div>`
          : `<div class="muted">Alarm: ${escapeHtml(matchedAlarm?.name || "none")}</div>`;

        return [
          '<div class="auto-config-card">',
          `<div><strong>${escapeHtml(getAutoConfigTypeLabel(type))}</strong> ${getAutoConfigStatusBadge(record?.status)}</div>`,
          `<div>Interval: ${escapeHtml(record?.time ?? "N/A")} phút</div>`,
          `<div>Shop: ${escapeHtml(record?.shopName || record?.shopId || "N/A")}</div>`,
          `<div class="auto-config-meta">${escapeHtml(record?.describe || "")}</div>`,
          `<div class="auto-config-meta">Updated: ${escapeHtml(formatDateTime(record?.updated_at || record?.updatedAt))}</div>`,
          warningHtml,
          '</div>'
        ].join("");
      }).join("");
    }
  }

  if (autoConfigAlarmList) {
    if (!alarms.length) {
      autoConfigAlarmList.innerHTML = '<div class="muted">No Etsy Auto Config alarms.</div>';
    } else {
      autoConfigAlarmList.innerHTML = alarms.map((alarm) => {
        const name = String(alarm?.name || "");
        const label = name === "ETSY_AUTO_CFG_SYNC" ? getAutoConfigTypeLabel(name) : name;

        return [
          '<div class="auto-config-card">',
          `<div><strong>${escapeHtml(label)}</strong></div>`,
          `<div>Name: ${escapeHtml(name)}</div>`,
          `<div>Period: ${escapeHtml(alarm?.periodInMinutes ?? "N/A")} phút</div>`,
          `<div class="auto-config-meta">Next Run: ${escapeHtml(formatAlarmNextRun(alarm?.scheduledTime))}</div>`,
          '</div>'
        ].join("");
      }).join("");
    }
  }
}

async function loadAutoConfigStatus(options = {}) {
  if (!autoConfigSummary || !autoConfigList || !autoConfigAlarmList) {
    return null;
  }

  if (!options.quiet) {
    autoConfigSummary.textContent = "Đang tải Auto Config...";
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_AUTO_CONFIG_STATUS"
    });

    if (!response?.ok) {
      throw new Error(response?.message || "ETSY_AUTO_CONFIG_STATUS failed");
    }

    renderAutoConfigStatus(response.data || {});
    return response.data || null;
  } catch (error) {
    renderAutoConfigError(error);
    return null;
  }
}

function openAutoConfigModal() {
  if (!autoConfigModalOverlay) return;

  autoConfigModalOverlay.style.display = "flex";
  loadAutoConfigStatus();

  if (autoConfigRefreshTimer) {
    clearInterval(autoConfigRefreshTimer);
  }

  autoConfigRefreshTimer = setInterval(() => {
    loadAutoConfigStatus({ quiet: true });
  }, 30000);
}

function closeAutoConfigModal() {
  if (autoConfigModalOverlay) {
    autoConfigModalOverlay.style.display = "none";
  }

  if (autoConfigRefreshTimer) {
    clearInterval(autoConfigRefreshTimer);
    autoConfigRefreshTimer = null;
  }
}

function openTriggerModal() {
  if (!triggerModalOverlay) return;

  triggerModalOverlay.style.display = "flex";
}

function closeTriggerModal() {
  if (!triggerModalOverlay) return;

  triggerModalOverlay.style.display = "none";
}

async function reloadAutoConfig() {
  if (btnReloadAutoConfig) {
    btnReloadAutoConfig.disabled = true;
  }

  if (autoConfigSummary) {
    autoConfigSummary.textContent = "Đang reload Auto Config...";
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_RELOAD_AUTO_CONFIG"
    });

    if (!response?.ok) {
      throw new Error(response?.message || "ETSY_RELOAD_AUTO_CONFIG failed");
    }

    await loadAutoConfigStatus({ quiet: true });
  } catch (error) {
    renderAutoConfigError(error);
  } finally {
    if (btnReloadAutoConfig) {
      btnReloadAutoConfig.disabled = false;
    }
  }
}

// Load config tu storage
chrome.storage.local.get(
  ["mongoShopId", "backendUrl", "etsyAdsBackendUrl"],
  (cfg) => {
    inputShopId.value = cfg.mongoShopId || "";
    inputBackend.value = cfg.backendUrl || DEFAULT_BACKEND_URL;

    if (inputEtsyAdsBackendUrl) {
      inputEtsyAdsBackendUrl.value =
        cfg.etsyAdsBackendUrl || DEFAULT_ETSY_ADS_BACKEND_URL;
    }

    if (inputEtsyAdsDate && !inputEtsyAdsDate.value) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      inputEtsyAdsDate.value = toLocalYMD(d);
    }

    console.log("[LNG][popup] loaded config", cfg);
  }
);

function toLocalYMD(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}
btnSaveCfg.addEventListener("click", () => {
  const etsyAdsBackendUrl =
    inputEtsyAdsBackendUrl?.value?.trim() || DEFAULT_ETSY_ADS_BACKEND_URL;
  const mongoShopId = inputShopId.value.trim();
  const backendUrl = inputBackend.value.trim() || DEFAULT_BACKEND_URL;

  if (mongoShopId && !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
    renderLog("Sai dinh dang Mongo Shop ID. Phai la 24 ky tu hex.");
    return;
  }

  chrome.storage.local.set(
    {
      mongoShopId,
      backendUrl,
      etsyAdsBackendUrl
    },
    () => {
      renderLog("Da luu config:", {
        mongoShopId,
        backendUrl,
        etsyAdsBackendUrl
      });

      console.log("[LNG][popup] saved config", {
        mongoShopId,
        backendUrl,
        etsyAdsBackendUrl
      });
    }
  );
});

btnGetOrders.addEventListener("click", async () => {
  const mongoShopId = inputShopId.value.trim();
  const backendUrl = DEFAULT_BACKEND_URL;

  if (!mongoShopId) {
    renderLog("Vui long nhap Mongo Shop ID truoc.");
    return;
  }
  if (!/^[a-f0-9]{24}$/i.test(mongoShopId)) {
    renderLog("Mongo Shop ID phai la ObjectId 24-hex hop le.");
    return;
  }

  // Auto-save config khi bam nut
  chrome.storage.local.set({ mongoShopId, backendUrl });

  console.log("[LNG][popup] click Get Etsy Orders");
  btnGetOrders.disabled = true;
  renderLog("Dang lay Etsy orders va push BE...");

  const startedAt = performance.now();

  try {
    console.log("[LNG][popup] sendMessage ETSY_GET_ORDERS_AND_PUSH");

    const response = await chrome.runtime.sendMessage({
      action: "ETSY_GET_ORDERS_AND_PUSH",
      payload: {
        limit: 50,
        pageSize: 50,
        maxTotalOrders: 50,
        mongoShopId,
        backendUrl,
        includeCustomizations: true,
        includeCustomFiles: true,
        customFileDetailMode: "auto_upload_detail",
        maxAutoDomDetailOrders: 10,
        domDetailWaitMs: 3000
      }
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log("[LNG][popup] received response", { elapsedMs, response });

    if (!response?.ok) {
      throw new Error(response?.message || "Unknown error");
    }

    renderLog("Hoan tat ✅", response.data);
    console.log("[LNG][popup] success", response.data);
  } catch (error) {
    console.error("[LNG][popup] error", error);
    renderLog("Loi ❌", { message: error.message });
  } finally {
    btnGetOrders.disabled = false;
  }
});

btnSyncEtsyListings?.addEventListener("click", async () => {
  const mongoShopId = inputShopId.value.trim();
  const backendUrl = inputBackend.value.trim() || DEFAULT_BACKEND_URL;

  if (!mongoShopId) {
    renderLog("Vui long nhap Mongo Shop ID truoc.");
    return;
  }

  if (!/^[a-f0-9]{24}$/i.test(mongoShopId)) {
    renderLog("Mongo Shop ID phai la ObjectId 24-hex hop le.");
    return;
  }

  chrome.storage.local.set({ mongoShopId, backendUrl });

  console.log("[LNG][popup] click Sync Etsy Listings", {
    mongoShopId,
    backendUrl
  });

  btnSyncEtsyListings.disabled = true;
  renderLog("Dang sync Etsy listings...");

  const startedAt = performance.now();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_SYNC_LISTINGS",
      payload: {
        mongoShopId,
        backendUrl
      }
    });

    const elapsedMs = Math.round(performance.now() - startedAt);

    console.log("[LNG][popup] Etsy listings sync response", {
      elapsedMs,
      response
    });

    if (!response?.ok) {
      throw new Error(response?.message || "Etsy listings sync failed");
    }

    renderLog("Sync Etsy listings thanh cong", {
      elapsedMs,
      ...response.data
    });
  } catch (error) {
    console.error("[LNG][popup][ETSY_LISTINGS_SYNC_ERROR]", error);
    renderLog("Sync Etsy listings loi", {
      message: error.message
    });
  } finally {
    btnSyncEtsyListings.disabled = false;
  }
});


btnUploadTracking.addEventListener("click", async () => {
  const orderId = inputTrackingOrderId.value.trim();
  const trackingNumber = inputTrackingNumber.value.trim();

  if (!orderId) {
    renderLog("Vui lòng nhập Etsy Order ID.");
    return;
  }

  if (!trackingNumber) {
    renderLog("Vui lòng nhập Tracking Number.");
    return;
  }

  console.log("[LNG][popup] click Upload Tracking", { orderId, trackingNumber });

  btnUploadTracking.disabled = true;
  renderLog("Đang upload tracking Etsy...");

  const startedAt = performance.now();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_UPLOAD_TRACKING",
      payload: {
        orderId,
        trackingNumber
      }
    });

    const elapsedMs = Math.round(performance.now() - startedAt);

    console.log("[LNG][popup] upload tracking response", {
      elapsedMs,
      response
    });

    if (!response?.ok) {
      throw new Error(response?.message || "Upload tracking failed");
    }

    renderLog("Upload tracking Etsy thành công ✅", {
      elapsedMs,
      ...response.data
    });
  } catch (error) {
    console.error("[LNG][popup][UPLOAD_TRACKING_ERROR]", error);
    renderLog("Upload tracking Etsy lỗi ❌", {
      message: error.message
    });
  } finally {
    btnUploadTracking.disabled = false;
  }
});

btnImportEtsyAds.addEventListener("click", async () => {
  const mongoShopId = inputShopId.value.trim();
  const selectedDate = toLocalYMD(inputEtsyAdsDate.value.trim());
  const date = selectedDate;
  const etsyAdsBackendUrl =
    inputEtsyAdsBackendUrl.value.trim() || DEFAULT_ETSY_ADS_BACKEND_URL;

  if (!mongoShopId) {
    renderLog("Vui lòng nhập Mongo Shop ID trước.");
    return;
  }

  if (!/^[a-f0-9]{24}$/i.test(mongoShopId)) {
    renderLog("Mongo Shop ID phải là ObjectId 24-hex hợp lệ.");
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    renderLog("Etsy Ads Date phải đúng định dạng YYYY-MM-DD.");
    return;
  }

  chrome.storage.local.set({
    mongoShopId,
    etsyAdsBackendUrl
  });

  console.log("[ETSY_ADS_DATE][UI_SELECTED]", {
    selectedDate,
    inputValue: inputEtsyAdsDate.value,
    payloadDate: date,
    queryDateOffsetDays: 0,
    autoResolveOverviewDate: false
  });

  console.log("[LNG][popup] click Import Etsy Ads", {
    mongoShopId,
    date,
    etsyAdsBackendUrl,
    queryDateOffsetDays: 0,
    autoResolveOverviewDate: false
  });

  btnImportEtsyAds.disabled = true;
  renderLog("Đang kéo Etsy Ads Spend...");

  const startedAt = performance.now();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_ADS_IMPORT_DAY",
      payload: {
        date,
        mongoShopId,
        etsyAdsBackendUrl,
        queryDateOffsetDays: 0,
        autoResolveOverviewDate: false
      }
    });

    const elapsedMs = Math.round(performance.now() - startedAt);

    console.log("[LNG][popup] Etsy Ads response", {
      elapsedMs,
      response
    });

    if (!response?.ok) {
      throw new Error(response?.message || "Etsy Ads import failed");
    }

    renderLog("Kéo Etsy Ads thành công ✅", {
      elapsedMs,
      ...response.data
    });
  } catch (error) {
    console.error("[LNG][popup][ETSY_ADS_ERROR]", error);

    renderLog("Kéo Etsy Ads lỗi ❌", {
      message: error.message
    });
  } finally {
    btnImportEtsyAds.disabled = false;
  }
});

btnImportEtsyAdsFull?.addEventListener("click", async () => {
  const mongoShopId = inputShopId.value.trim();
  const backendUrl = inputBackend.value.trim() || DEFAULT_BACKEND_URL;
  const selectedDate = toLocalYMD(inputEtsyAdsDate.value.trim());
  const date = selectedDate;
  const etsyAdsBackendUrl =
    inputEtsyAdsBackendUrl.value.trim() || DEFAULT_ETSY_ADS_BACKEND_URL;

  if (!mongoShopId) {
    renderLog("Vui lòng nhập Mongo Shop ID trước.");
    return;
  }

  if (!/^[a-f0-9]{24}$/i.test(mongoShopId)) {
    renderLog("Mongo Shop ID phải là ObjectId 24-hex hợp lệ.");
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    renderLog("Etsy Ads Date phải đúng định dạng YYYY-MM-DD.");
    return;
  }

  chrome.storage.local.set({
    mongoShopId,
    backendUrl,
    etsyAdsBackendUrl
  });

  console.log("[LNG][popup] click Etsy Ads Full Import", {
    mongoShopId,
    date,
    backendUrl,
    etsyAdsBackendUrl,
    listingSyncMode: "always",
    etsyListingBatchSize: 100,
    filterMode: "spend_only"
  });

  btnImportEtsyAdsFull.disabled = true;
  renderLog("Đang sync listings rồi kéo Etsy Ads...");

  const startedAt = performance.now();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_ADS_FULL_IMPORT",
      payload: {
        date,
        mongoShopId,
        backendUrl,
        etsyAdsBackendUrl,
        listingSyncMode: "always",
        etsyListingBatchSize: 100,
        filterMode: "spend_only"
      }
    });

    const elapsedMs = Math.round(performance.now() - startedAt);

    console.log("[LNG][popup] Etsy Ads full import response", {
      elapsedMs,
      response
    });

    if (!response?.ok) {
      throw new Error(response?.message || "Etsy Ads full import failed");
    }

    renderLog("Sync listings + kéo Etsy Ads thành công", {
      elapsedMs,
      ...response.data
    });
  } catch (error) {
    console.error("[LNG][popup][ETSY_ADS_FULL_IMPORT_ERROR]", error);
    renderLog("Sync listings + kéo Etsy Ads lỗi", {
      message: error.message
    });
  } finally {
    btnImportEtsyAdsFull.disabled = false;
  }
});

const btnSocketConnect = document.getElementById("btnSocketConnect");
const btnSocketStatus = document.getElementById("btnSocketStatus");
const btnSocketDisconnect = document.getElementById("btnSocketDisconnect");

function appendLog(message, data) {
  const line = data !== undefined
    ? `${message}\n${JSON.stringify(data, null, 2)}`
    : message;

  logEl.textContent += `\n\n[${new Date().toLocaleTimeString()}] ${line}`;
  logEl.scrollTop = logEl.scrollHeight;
}

btnSocketConnect?.addEventListener("click", async () => {
  const mongoShopId = inputShopId.value.trim();
  const backendUrl = inputBackend.value.trim() || DEFAULT_BACKEND_URL;

  if (!mongoShopId) {
    renderLog("Vui lòng nhập Mongo Shop ID trước.");
    return;
  }

  if (!/^[a-f0-9]{24}$/i.test(mongoShopId)) {
    renderLog("Mongo Shop ID phải là ObjectId 24-hex hợp lệ.");
    return;
  }

  console.log("[LNG][popup] click Connect Socket", {
    mongoShopId,
    backendUrl
  });

  btnSocketConnect.disabled = true;

  try {
    await chrome.storage.local.set({
      mongoShopId,
      backendUrl,
      autoConnectSocket: true
    });

    appendLog("🔌 Đang connect socket...");

    console.log("[LNG][popup] sending SOCKET_CONNECT message");

    const response = await sendRuntimeMessageWithTimeout({
      type: "SOCKET_CONNECT"
    }, 8000);

    console.log("[LNG][popup] SOCKET_CONNECT response", response);
    appendLog("SOCKET_CONNECT response:", response);
  } catch (error) {
    console.error("[LNG][popup][SOCKET_CONNECT_ERROR]", error);

    appendLog("SOCKET_CONNECT lỗi ❌", {
      message: error?.message || String(error)
    });
  } finally {
    btnSocketConnect.disabled = false;
  }
});

btnSocketStatus?.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "SOCKET_STATUS"
  });

  appendLog("SOCKET_STATUS:", response);
});

btnSocketDisconnect?.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "SOCKET_DISCONNECT"
  });

  appendLog("SOCKET_DISCONNECT:", response);
});

btnEtsyMessageSyncDebug?.addEventListener("click", async () => {
  const limit = 20;

  console.log("[LNG][popup] click Etsy Message Sync Debug", { limit });

  btnEtsyMessageSyncDebug.disabled = true;
  renderLog("Đang test kéo Etsy Messages...");

  const startedAt = performance.now();

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_MESSAGE_SYNC_DEBUG",
      payload: {
        limit
      }
    });

    const elapsedMs = Math.round(performance.now() - startedAt);

    console.log("[LNG][popup] Etsy Message Sync Debug response", {
      elapsedMs,
      response
    });

    if (!response?.ok) {
      throw new Error(response?.message || "ETSY_MESSAGE_SYNC_DEBUG failed");
    }

    const summary = summarizeEtsyMessageSyncDebugResult(response.data || {});

    renderLog("Test Etsy Messages thành công ✅", {
      elapsedMs,
      ...summary
    });
  } catch (error) {
    console.error("[LNG][popup][ETSY_MESSAGE_SYNC_DEBUG_ERROR]", error);

    renderLog("Test Etsy Messages lỗi ❌", {
      message: error?.message || String(error)
    });
  } finally {
    btnEtsyMessageSyncDebug.disabled = false;
  }
});

btnEtsyMessageMonitorTick?.addEventListener("click", async () => {
  btnEtsyMessageMonitorTick.disabled = true;
  renderLog("Đang test Etsy Message Monitor...");
  let result = null;
  let errorPayload = null;

  try {
    const response = await chrome.runtime.sendMessage({
      action: "ETSY_MESSAGE_MONITOR_TICK"
    });

    if (!response?.ok) {
      throw new Error(response?.message || "ETSY_MESSAGE_MONITOR_TICK failed");
    }

    result = response.data;
  } catch (error) {
    errorPayload = {
      message: error?.message || String(error)
    };
  } finally {
    const [latestLogs, monitorStatus] = await Promise.all([
      getLatestEtsyMessageMonitorDebugLogs(10),
      getEtsyMessageMonitorStatusForPopup()
    ]);

    if (errorPayload) {
      renderLog("Test Etsy Message Monitor lỗi ❌", {
        ...errorPayload,
        monitorStatus,
        latestLogs
      });
    } else {
      renderLog("Test Etsy Message Monitor thành công ✅", {
        result,
        monitorStatus,
        latestLogs
      });
    }

    btnEtsyMessageMonitorTick.disabled = false;
  }
});

btnOpenTriggerModal?.addEventListener("click", () => {
  openTriggerModal();
});

btnCloseTriggerModal?.addEventListener("click", () => {
  closeTriggerModal();
});

triggerModalOverlay?.addEventListener("click", (event) => {
  if (event.target === triggerModalOverlay) {
    closeTriggerModal();
  }
});

btnOpenAutoConfig?.addEventListener("click", () => {
  openAutoConfigModal();
});

btnCloseAutoConfigModal?.addEventListener("click", () => {
  closeAutoConfigModal();
});

autoConfigModalOverlay?.addEventListener("click", (event) => {
  if (event.target === autoConfigModalOverlay) {
    closeAutoConfigModal();
  }
});

btnAutoConfigStatus?.addEventListener("click", async () => {
  await loadAutoConfigStatus();
});

btnReloadAutoConfig?.addEventListener("click", async () => {
  await reloadAutoConfig();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SOCKET_LOG") {
    appendLog(
      msg.payload?.message || "Socket log",
      msg.payload?.data || undefined
    );
  }
});

function sendRuntimeMessageWithTimeout(message, timeoutMs = 8000) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout waiting runtime response after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}
