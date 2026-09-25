import {
    connectSocket,
    disconnectSocket,
    getSocketStatus,
    autoConnectSocketIfReady,
    pullPendingTasksNow,
    setSocketTaskHandler,
    emitSocketEvent
} from "./socket-client.js";
import { logExtensionEvent } from "./extension-logger.js";
import {
    ensurePageTabReady,
    ETSY_TAB_READY_TIMEOUT_MS,
    waitForTabCompleteWithTimeout
} from "./service-worker-tab-utils.mjs";


const CONFIG = {
    ETSY_SOLD_URL: "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav",
    ETSY_ADS_URL: "https://www.etsy.com/your/shops/me/advertising",
    ETSY_MESSAGES_URL: "https://www.etsy.com/messages",
    DEFAULT_BACKEND_URL: "https://api.lngmerch.co/api/etsy/",
    DEFAULT_ETSY_ADS_BACKEND_URL: "https://api.lngmerch.co/api/etsy-ads"
};

console.log("[LNG][sw] service-worker.js loaded", CONFIG);

const socketTaskLocks = new Set();
const autoUploadTrackingLocks = new Set();
let uploadTrackingQueue = Promise.resolve();
const ETSY_AUTO_ALARM_PREFIX = "ETSY_AUTO_";
const ETSY_AUTO_SYNC_ALARM = "ETSY_AUTO_CFG_SYNC";
const ETSY_MESSAGE_MONITOR_ALARM = "ETSY_MESSAGE_SYNC_MONITOR";
const ETSY_MESSAGE_MONITOR_PERIOD_MINUTES = 10;
const ETSY_MESSAGE_MONITOR_AUTO_ENABLED = false;
const ETSY_MESSAGE_SNAPSHOT_KEY = "etsyMessageSyncSnapshot";
const ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY = "etsyMessageMonitorDebugLogs";
let etsyAutoConfigLastSnapshot = {
    fetchedAt: null,
    records: [],
    alarms: [],
    error: null
};

setSocketTaskHandler(handleSocketTask);
startEtsyMessageMonitorAlarm()
    .then(async (result) => {
        if (result?.disabled) {
            console.log("[LNG][sw][ETSY_MESSAGE_MONITOR][AUTO_DISABLED]", result);
            return;
        }

        return chrome.alarms.get(ETSY_MESSAGE_MONITOR_ALARM).then((alarm) => {
            console.log("[LNG][sw][ETSY_MESSAGE_MONITOR][BOOTSTRAP_ALARM_READY]", {
                name: alarm?.name || ETSY_MESSAGE_MONITOR_ALARM,
                periodInMinutes: alarm?.periodInMinutes || null,
                scheduledTime: alarm?.scheduledTime || null
            });
        });
    })
    .catch((error) => {
        console.error("[LNG][sw][ETSY_MESSAGE_MONITOR][BOOTSTRAP_ALARM_ERROR]", error);
    });

function getServiceLogPrefixFromMessage(message = "") {
    const value = String(message || "").toUpperCase();

    if (value.includes("IMPORT_ORDERS") || value.includes("GET ETSY ORDERS")) {
        return "[IMPORT_ORDER]";
    }

    if (value.includes("ETSY_UPLOAD_TRACKING") || value.includes("UPLOAD TRACKING")) {
        return "[UPLOAD_TRACKING]";
    }

    if (value.includes("SYNC_ETSY_LISTINGS") || value.includes("ETSY_LISTINGS")) {
        return "[SYNC_ETSY_LISTINGS]";
    }

    if (value.includes("ETSY_ADS_FULL_IMPORT")) {
        return "[ETSY_ADS_FULL_IMPORT]";
    }

    if (value.includes("IMPORT_ADS_SPEND") || value.includes("ETSY_ADS")) {
        return "[ETSY_ADS]";
    }

    if (value.includes("ETSY_AUTO_CONFIG") || value.includes("AUTO_CONFIG")) {
        return "[AUTO_CONFIG]";
    }

    if (value.includes("ETSY_MESSAGE") || value.includes("MESSAGE_SYNC")) {
        return "[ETSY_MESSAGE]";
    }

    return "[SOCKET_TASK]";
}

function prefixDebugMessage(message, prefix) {
    const value = String(message || "").trim();
    if (!prefix || value.startsWith(prefix) || /^\[[A-Z0-9_]+\]/.test(value)) {
        return value;
    }

    return `${prefix} ${value}`;
}

function sendSocketTaskLog(message, data = null) {
    const prefix = getServiceLogPrefixFromMessage(message);
    const prefixedMessage = prefixDebugMessage(message, prefix);

    console.log("[LNG][SOCKET_TASK]", prefixedMessage, data || "");

    chrome.runtime.sendMessage({
        type: "SOCKET_LOG",
        payload: {
            message: prefixedMessage,
            data,
            timestamp: new Date().toLocaleTimeString()
        }
    }).catch(() => { });
}

async function logEtsyAutoConfigEvent(args = {}) {
    const {
        level = "info",
        logType,
        message,
        alarmName,
        type,
        result,
        error,
        rawData
    } = args;
    let safeCfg = args.cfg;

    try {
        if (!safeCfg?.mongoShopId) {
            try {
                safeCfg = await getEtsyAutoBaseConfig();
            } catch (_) { }
        }

        if (!safeCfg?.mongoShopId) {
            console.warn("[LNG][sw][ETSY_AUTO_CONFIG][LOG_SKIPPED_MISSING_CFG]", {
                logType,
                alarmName,
                type,
                message
            });
            return;
        }

        await logExtensionEvent({
            machineId: safeCfg?.mongoShopId,
            shopId: safeCfg?.mongoShopId,
            service: "ETSY_AUTO_CONFIG",
            logType,
            level,
            message,
            taskInfo: {
                taskType: type || "AUTO_CONFIG",
                taskId: alarmName || undefined
            },
            rawData: {
                alarmName,
                type,
                result,
                ...rawData
            },
            errorInfo: error ? {
                errorMessage: error.message || String(error),
                stackTrace: error.stack || null
            } : undefined
        });
    } catch (logError) {
        console.warn("[LNG][sw][ETSY_AUTO_CONFIG][LOG_ERROR]", logError?.message || String(logError));
    }
}

async function logServiceEvent({
    service,
    logType = "info",
    level = "info",
    message,
    mongoShopId,
    taskId,
    taskType,
    rawData,
    error,
    performance
}) {
    try {
        await logExtensionEvent({
            machineId: mongoShopId,
            shopId: mongoShopId,
            service,
            logType,
            level,
            message,
            taskInfo: {
                taskId,
                taskType
            },
            rawData,
            errorInfo: error ? {
                errorMessage: error.message || String(error),
                stackTrace: error.stack || null
            } : undefined,
            performance
        });
    } catch (logError) {
        console.warn("[LNG][sw][SERVICE_LOG_ERROR]", {
            service,
            logType,
            message: logError?.message || String(logError)
        });
    }
}

function sampleIds(items, keys, limit = 5) {
    return (Array.isArray(items) ? items : [])
        .slice(0, limit)
        .map((item) => {
            for (const key of keys) {
                const value = item?.[key];
                if (value !== undefined && value !== null && String(value).trim()) {
                    return String(value).trim();
                }
            }
            return "";
        })
        .filter(Boolean);
}

function summarizeListingPush(push) {
    return {
        batches: push?.batches ?? null,
        accepted: push?.accepted ?? null,
        rejected: push?.rejected ?? null,
        upserted: push?.upserted ?? null,
        modified: push?.modified ?? null,
        matched: push?.matched ?? null,
        totalListings: push?.totalListings ?? null
    };
}

function summarizeAdsPush(push) {
    const body = push?.body || {};
    return {
        status: push?.status ?? null,
        rowsCount: body?.rowsCount ?? null,
        rowsAccepted: body?.rowsAccepted ?? null,
        rowsRejected: body?.rowsRejected ?? null,
        totalSpend: body?.totalSpend ?? null,
        docId: body?.docId ?? null,
        totalsSource: body?.totalsSource ?? null
    };
}

function summarizePullTrackingResult(result) {
    return {
        ok: result?.ok ?? null,
        skipped: result?.skipped === true,
        reason: result?.reason || null,
        shopId: result?.shopId || null,
        machineId: result?.machineId || null
    };
}

function getAutoTrackingDateRange(days = 15) {
    const toDate = new Date();
    toDate.setHours(23, 59, 59, 999);

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    fromDate.setHours(0, 0, 0, 0);

    return {
        from: fromDate.toISOString(),
        to: toDate.toISOString()
    };
}

function getArrayFromOrdersResponse(body) {
    const candidates = [
        body?.data,
        body?.orders,
        body?.items,
        body?.result,
        body?.data?.orders,
        body?.data?.items,
        body?.result?.orders,
        body?.result?.items
    ];

    return candidates.find((candidate) => Array.isArray(candidate)) || [];
}

function normalizeEtsyCarrierName(value) {
    const raw = String(value || "").trim();
    const upper = raw.toUpperCase();

    if (!raw) return "";
    if (upper.includes("YUN") || upper.includes("YT")) return "Yun Express";
    if (upper.includes("YANWEN") || upper === "UK" || upper === "UL") return "Yanwen";
    if (upper.includes("USPS")) return "USPS";

    return raw;
}

function inferEtsyTrackingCarrier(trackingNumber, explicitCarrier = "") {
    const explicit = String(explicitCarrier || "").trim();
    if (explicit) return normalizeEtsyCarrierName(explicit);

    const value = String(trackingNumber || "").trim().toUpperCase();

    if (value.startsWith("92") || value.startsWith("42")) return "USPS";
    if (value.startsWith("UK") || value.startsWith("UL")) return "Yanwen";
    if (value.startsWith("YT")) return "Yun Express";

    return "";
}

async function fetchEtsyOrdersForAutoTracking({
    apiBase,
    mongoShopId,
    page = 1,
    limit = 1000
}) {
    const { from, to } = getAutoTrackingDateRange(15);
    const safeApiBase = String(apiBase || "").replace(/\/+$/, "");
    const url = `${safeApiBase}/api/etsy?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Accept": "application/json, text/plain, */*"
        }
    });
    const text = await response.text();
    let body = null;

    try {
        body = JSON.parse(text || "{}");
    } catch (_) {
        body = { raw: text };
    }

    if (!response.ok) {
        throw new Error(`AUTO_UPLOAD_TRACKING orders fetch failed ${response.status}: ${text.slice(0, 300)}`);
    }

    const orders = getArrayFromOrdersResponse(body);

    return {
        orders,
        totalCount: Number(body?.totalCount ?? body?.total ?? body?.count ?? body?.data?.totalCount ?? orders.length) || orders.length,
        totalPages: Number(body?.totalPages ?? body?.pages ?? body?.data?.totalPages ?? 1) || 1,
        currentPage: Number(body?.currentPage ?? body?.page ?? body?.data?.currentPage ?? page) || page,
        from,
        to,
        mongoShopId
    };
}

function getOrderTrackingNumber(order) {
    const directCandidates = [
        order?.tracking_info?.tracking,
        order?.trackingInfo?.tracking,
        order?.trackingNumber
    ];
    const orderCarrier = normalizeEtsyCarrierName(
        order?.tracking_info?.carrier ||
        order?.tracking_info?.carrierCode ||
        order?.tracking_info?.shippingCarrier ||
        order?.trackingInfo?.carrier ||
        order?.trackingInfo?.carrierCode ||
        order?.carrier ||
        order?.carrierCode ||
        order?.shippingCarrier
    );

    for (const value of directCandidates) {
        const tracking = String(value || "").trim();
        if (tracking) {
            return {
                trackingNumber: tracking,
                carrier: orderCarrier || inferEtsyTrackingCarrier(tracking),
                itemOrderItemId: undefined,
                trackingStatus: order?.tracking_info?.status || order?.trackingInfo?.status || undefined,
                trackingUpdatedAt:
                    order?.tracking_info?.updated_at ||
                    order?.tracking_info?.updatedAt ||
                    order?.trackingInfo?.updated_at ||
                    order?.trackingInfo?.updatedAt ||
                    undefined
            };
        }
    }

    const items = Array.isArray(order?.items)
        ? order.items
        : Array.isArray(order?.lineItems)
            ? order.lineItems
            : [];

    for (const item of items) {
        const itemCandidates = [
            item?.tracking_info?.tracking,
            item?.trackingInfo?.tracking,
            item?.trackingNumber
        ];
        const itemCarrier = normalizeEtsyCarrierName(
            item?.tracking_info?.carrier ||
            item?.tracking_info?.carrierCode ||
            item?.tracking_info?.shippingCarrier ||
            item?.trackingInfo?.carrier ||
            item?.trackingInfo?.carrierCode ||
            item?.carrier ||
            item?.carrierCode ||
            item?.shippingCarrier
        );

        for (const value of itemCandidates) {
            const tracking = String(value || "").trim();
            if (tracking) {
                return {
                    trackingNumber: tracking,
                    carrier: itemCarrier || inferEtsyTrackingCarrier(tracking),
                    itemOrderItemId: item?.orderItemId || item?.order_item_id || item?.id || item?._id || undefined,
                    trackingStatus: item?.tracking_info?.status || item?.trackingInfo?.status || undefined,
                    trackingUpdatedAt:
                        item?.tracking_info?.updated_at ||
                        item?.tracking_info?.updatedAt ||
                        item?.trackingInfo?.updated_at ||
                        item?.trackingInfo?.updatedAt ||
                        undefined
                };
            }
        }
    }

    return null;
}

function extractAutoTrackingCandidates(orders, mongoShopId) {
    return (Array.isArray(orders) ? orders : [])
        .filter((order) => String(order?.shopId || "").trim() === mongoShopId)
        .filter((order) => order?.sumbittedoetsy !== true)
        .map((order) => {
            const orderId = normalizeEtsyOrderId(order?.orderId || order?.receiptId || order?.id || "");
            const tracking = getOrderTrackingNumber(order);

            if (!orderId || !tracking?.trackingNumber) return null;

            return {
                orderId,
                trackingNumber: tracking.trackingNumber,
                carrier: tracking.carrier || inferEtsyTrackingCarrier(tracking.trackingNumber),
                shopId: String(order.shopId || "").trim(),
                orderStatus: order?.orderStatus || order?.status || undefined,
                sumbittedoetsy: order?.sumbittedoetsy === true,
                itemOrderItemId: tracking.itemOrderItemId,
                trackingStatus: tracking.trackingStatus,
                trackingUpdatedAt: tracking.trackingUpdatedAt
            };
        })
        .filter(Boolean);
}

async function markEtsyOrderSubmittedToEtsy({
    apiBase,
    mongoShopId,
    orderId
}) {
    const safeApiBase = String(apiBase || "").replace(/\/+$/, "");
    const url = `${safeApiBase}/api/etsy/sumbittedoetsy`;
    const response = await fetch(url, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            orderId,
            shopId: mongoShopId,
            submittedToEtsy: true
        })
    });
    const text = await response.text();
    let body = null;

    try {
        body = JSON.parse(text || "{}");
    } catch (_) {
        body = { raw: text.slice(0, 300) };
    }

    if (!response.ok) {
        throw new Error(`AUTO_UPLOAD_TRACKING mark submitted failed ${response.status}: ${text.slice(0, 300)}`);
    }

    return {
        status: response.status,
        ok: response.ok,
        body
    };
}

function isEtsyTrackingAlreadyExistsError(error) {
    const message = String(error?.message || error || "").toLowerCase();

    return (
        message.includes("tracking number is already in use") ||
        message.includes("already in use for this order") ||
        message.includes('"error_code":"127"') ||
        message.includes("error_code=127")
    );
}

function isTemporaryUploadTrackingError(error) {
    const msg = String(error?.message || error || "").toLowerCase();

    return (
        msg.includes("timeout") ||
        msg.includes("receiving end does not exist") ||
        msg.includes("could not establish connection") ||
        msg.includes("csrf") ||
        msg.includes("login") ||
        msg.includes("network") ||
        msg.includes("failed to fetch") ||
        msg.includes("etsy response looks like login/csrf")
    );
}

async function uploadTrackingToEtsyWithRetry(payload, options = {}) {
    const maxAttempts = Number(options.maxAttempts || 2);
    const mongoShopId = String(options.mongoShopId || payload.mongoShopId || payload.shopId || payload.machineId || "").trim();
    const taskId = String(options.taskId || payload.taskId || "").trim();
    const taskType = String(options.taskType || "ETSY_UPLOAD_TRACKING").trim();
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await handleUploadTrackingToEtsy(payload);
        } catch (error) {
            lastError = error;

            if (!isTemporaryUploadTrackingError(error) || attempt >= maxAttempts) {
                throw error;
            }

            await logServiceEvent({
                service: "ETSY_UPLOAD_TRACKING",
                logType: "upload_failed",
                level: "warn",
                message: "ETSY_UPLOAD_TRACKING retry temporary error",
                mongoShopId,
                taskId,
                taskType,
                rawData: {
                    orderId: payload.orderId,
                    trackingNumberLast4: String(payload.trackingNumber || "").slice(-4),
                    carrier: payload.carrier || "",
                    attempt,
                    maxAttempts,
                    message: error?.message || String(error)
                },
                error
            });

            await sleep(1500);
        }
    }

    throw lastError;
}

async function runAutoUploadTrackingFromOrdersApi(cfg) {
    const mongoShopId = String(cfg?.mongoShopId || "").trim();
    const apiBase = String(cfg?.apiBase || deriveAutoConfigApiBase(cfg?.backendUrl)).replace(/\/+$/, "");
    const batchTaskId = `auto_upload_tracking:${mongoShopId}:${Date.now()}`;
    const lockKey = `auto_upload_tracking:${mongoShopId}`;

    if (autoUploadTrackingLocks.has(lockKey)) {
        await logServiceEvent({
            service: "ETSY_UPLOAD_TRACKING",
            logType: "task_completed",
            level: "warn",
            message: "AUTO_UPLOAD_TRACKING skipped: already running",
            mongoShopId,
            taskId: batchTaskId,
            taskType: "AUTO_UPLOAD_TRACKING",
            rawData: {
                reason: "AUTO_UPLOAD_TRACKING_RUNNING"
            }
        });

        return {
            ok: false,
            skipped: true,
            reason: "AUTO_UPLOAD_TRACKING_RUNNING",
            source: "orders_api"
        };
    }

    autoUploadTrackingLocks.add(lockKey);

    try {
    await logServiceEvent({
        service: "ETSY_UPLOAD_TRACKING",
        logType: "task_processing",
        message: "AUTO_UPLOAD_TRACKING orders fetch started",
        mongoShopId,
        taskId: batchTaskId,
        taskType: "AUTO_UPLOAD_TRACKING",
        rawData: {
            apiBase,
            page: 1,
            limit: 1000,
            trackingWindowDays: 15
        }
    });

    const fetchResult = await fetchEtsyOrdersForAutoTracking({
        apiBase,
        mongoShopId,
        page: 1,
        limit: 1000
    }).catch(async (error) => {
        await logServiceEvent({
            service: "ETSY_UPLOAD_TRACKING",
            logType: "task_failed",
            level: "error",
            message: `AUTO_UPLOAD_TRACKING orders fetch failed: ${error?.message || String(error)}`,
            mongoShopId,
            taskId: batchTaskId,
            taskType: "AUTO_UPLOAD_TRACKING",
            error
        });

        throw error;
    });
    const orders = fetchResult.orders || [];
    const matchedShopOrders = orders.filter((order) => String(order?.shopId || "").trim() === mongoShopId);
    const candidates = extractAutoTrackingCandidates(orders, mongoShopId);

    await logServiceEvent({
        service: "ETSY_UPLOAD_TRACKING",
        logType: "task_completed",
        message: "AUTO_UPLOAD_TRACKING orders fetch completed",
        mongoShopId,
        taskId: batchTaskId,
        taskType: "AUTO_UPLOAD_TRACKING",
        rawData: {
            totalOrders: orders.length,
            matchedShopOrders: matchedShopOrders.length,
            candidatesCount: candidates.length,
            from: fetchResult.from,
            to: fetchResult.to,
            trackingWindowDays: 15,
            sampleOrderIds: sampleIds(candidates, ["orderId"])
        }
    });

    if (!candidates.length) {
        const emptyResult = {
            ok: true,
            source: "orders_api",
            totalOrders: orders.length,
            candidates: 0,
            uploaded: 0,
            markedSubmitted: 0,
            failed: 0,
            skipped: true,
            reason: "NO_AUTO_TRACKING_CANDIDATES",
            samples: {
                uploaded: [],
                alreadyExists: [],
                failed: [],
                skipped: []
            }
        };

        await logServiceEvent({
            service: "ETSY_UPLOAD_TRACKING",
            logType: "task_completed",
            message: "AUTO_UPLOAD_TRACKING final summary",
            mongoShopId,
            taskId: batchTaskId,
            taskType: "AUTO_UPLOAD_TRACKING",
            rawData: emptyResult
        });

        return emptyResult;
    }

    let uploaded = 0;
    let alreadyExists = 0;
    let markedSubmitted = 0;
    let failed = 0;
    const uploadedSamples = [];
    const alreadyExistsSamples = [];
    const failedSamples = [];
    const skippedSamples = [];

    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        const batchIndex = index + 1;
        const batchTotal = candidates.length;
        const carrier = candidate.carrier || inferEtsyTrackingCarrier(candidate.trackingNumber);
        const rowTaskId = `auto_upload_tracking:${mongoShopId}:${candidate.orderId}`;
        const rowRawData = {
            orderId: candidate.orderId,
            trackingNumberLast4: candidate.trackingNumber.slice(-4),
            carrier,
            carrierSource: candidate.carrier ? "be_or_inferred" : "inferred_or_empty",
            orderStatus: candidate.orderStatus || null,
            sumbittedoetsy: candidate.sumbittedoetsy === true,
            itemOrderItemId: candidate.itemOrderItemId || null,
            trackingStatus: candidate.trackingStatus || null,
            trackingUpdatedAt: candidate.trackingUpdatedAt || null,
            batchIndex,
            batchTotal
        };

        await logServiceEvent({
            service: "ETSY_UPLOAD_TRACKING",
            logType: "upload_started",
            message: "AUTO_UPLOAD_TRACKING candidate queued/started",
            mongoShopId,
            taskId: rowTaskId,
            taskType: "ETSY_UPLOAD_TRACKING",
            rawData: rowRawData
        });

        try {
            const uploadResult = await uploadTrackingToEtsyWithRetry({
                orderId: candidate.orderId,
                trackingNumber: candidate.trackingNumber,
                carrier
            }, {
                maxAttempts: 2,
                mongoShopId,
                taskId: rowTaskId,
                taskType: "AUTO_UPLOAD_TRACKING"
            });
            uploaded++;

            await logServiceEvent({
                service: "ETSY_UPLOAD_TRACKING",
                logType: "upload_completed",
                message: "AUTO_UPLOAD_TRACKING uploaded to Etsy",
                mongoShopId,
                taskId: rowTaskId,
                taskType: "ETSY_UPLOAD_TRACKING",
                rawData: {
                    ...rowRawData,
                    etsyShopId: uploadResult?.shopId || null,
                    shopName: uploadResult?.shopName || null,
                    uploadedAt: uploadResult?.uploadedAt || null
                }
            });

            await logServiceEvent({
                service: "ETSY_UPLOAD_TRACKING",
                logType: "task_processing",
                message: "AUTO_UPLOAD_TRACKING mark submitted started",
                mongoShopId,
                taskId: rowTaskId,
                taskType: "AUTO_UPLOAD_TRACKING",
                rawData: {
                    orderId: candidate.orderId,
                    trackingNumberLast4: candidate.trackingNumber.slice(-4)
                }
            });

            const markResult = await markEtsyOrderSubmittedToEtsy({
                apiBase,
                mongoShopId,
                orderId: candidate.orderId
            });
            markedSubmitted++;

            await logServiceEvent({
                service: "ETSY_UPLOAD_TRACKING",
                logType: "task_completed",
                message: "AUTO_UPLOAD_TRACKING mark submitted completed",
                mongoShopId,
                taskId: rowTaskId,
                taskType: "AUTO_UPLOAD_TRACKING",
                rawData: {
                    orderId: candidate.orderId,
                    trackingNumberLast4: candidate.trackingNumber.slice(-4),
                    markSubmittedStatus: markResult.status
                }
            });

            await logServiceEvent({
                service: "ETSY_UPLOAD_TRACKING",
                logType: "task_completed",
                message: "AUTO_UPLOAD_TRACKING row completed",
                mongoShopId,
                taskId: rowTaskId,
                taskType: "AUTO_UPLOAD_TRACKING",
                rawData: {
                    orderId: candidate.orderId,
                    trackingNumberLast4: candidate.trackingNumber.slice(-4),
                    markSubmittedStatus: markResult.status
                }
            });

            if (uploadedSamples.length < 5) {
                uploadedSamples.push({
                    orderId: candidate.orderId,
                    trackingNumberLast4: candidate.trackingNumber.slice(-4)
                });
            }
        } catch (error) {
            if (isEtsyTrackingAlreadyExistsError(error)) {
                alreadyExists++;

                await logServiceEvent({
                    service: "ETSY_UPLOAD_TRACKING",
                    logType: "upload_completed",
                    level: "warn",
                    message: "AUTO_UPLOAD_TRACKING tracking already exists on Etsy, marking submitted",
                    mongoShopId,
                    taskId: rowTaskId,
                    taskType: "AUTO_UPLOAD_TRACKING",
                    rawData: {
                        ...rowRawData,
                        reason: "ETSY_TRACKING_ALREADY_EXISTS"
                    }
                });

                try {
                    await logServiceEvent({
                        service: "ETSY_UPLOAD_TRACKING",
                        logType: "task_processing",
                        level: "warn",
                        message: "AUTO_UPLOAD_TRACKING mark submitted started",
                        mongoShopId,
                        taskId: rowTaskId,
                        taskType: "AUTO_UPLOAD_TRACKING",
                        rawData: {
                            orderId: candidate.orderId,
                            trackingNumberLast4: candidate.trackingNumber.slice(-4),
                            reason: "ETSY_TRACKING_ALREADY_EXISTS"
                        }
                    });

                    const markResult = await markEtsyOrderSubmittedToEtsy({
                        apiBase,
                        mongoShopId,
                        orderId: candidate.orderId
                    });
                    markedSubmitted++;

                    await logServiceEvent({
                        service: "ETSY_UPLOAD_TRACKING",
                        logType: "task_completed",
                        level: "warn",
                        message: "AUTO_UPLOAD_TRACKING row completed",
                        mongoShopId,
                        taskId: rowTaskId,
                        taskType: "AUTO_UPLOAD_TRACKING",
                        rawData: {
                            orderId: candidate.orderId,
                            trackingNumberLast4: candidate.trackingNumber.slice(-4),
                            markSubmittedStatus: markResult.status,
                            reason: "ETSY_TRACKING_ALREADY_EXISTS"
                        }
                    });

                    if (alreadyExistsSamples.length < 5) {
                        alreadyExistsSamples.push({
                            orderId: candidate.orderId,
                            trackingNumberLast4: candidate.trackingNumber.slice(-4)
                        });
                    }
                    if (skippedSamples.length < 5) {
                        skippedSamples.push({
                            orderId: candidate.orderId,
                            trackingNumberLast4: candidate.trackingNumber.slice(-4),
                            reason: "ETSY_TRACKING_ALREADY_EXISTS"
                        });
                    }
                } catch (markError) {
                    failed++;

                    await logServiceEvent({
                        service: "ETSY_UPLOAD_TRACKING",
                        logType: "task_failed",
                        level: "error",
                        message: `AUTO_UPLOAD_TRACKING row failed: ${markError?.message || String(markError)}`,
                        mongoShopId,
                        taskId: rowTaskId,
                        taskType: "AUTO_UPLOAD_TRACKING",
                        rawData: {
                            ...rowRawData,
                            reason: "MARK_SUBMITTED_FAILED_AFTER_ALREADY_EXISTS"
                        },
                        error: markError
                    });

                    if (failedSamples.length < 5) {
                        failedSamples.push({
                            orderId: candidate.orderId,
                            trackingNumberLast4: candidate.trackingNumber.slice(-4),
                            reason: "MARK_SUBMITTED_FAILED_AFTER_ALREADY_EXISTS",
                            message: markError?.message || String(markError)
                        });
                    }
                }

                continue;
            }

            failed++;
            await logServiceEvent({
                service: "ETSY_UPLOAD_TRACKING",
                logType: "upload_failed",
                level: "error",
                message: `AUTO_UPLOAD_TRACKING row failed: ${error?.message || String(error)}`,
                mongoShopId,
                taskId: rowTaskId,
                taskType: "AUTO_UPLOAD_TRACKING",
                rawData: rowRawData,
                error
            });

            if (failedSamples.length < 5) {
                failedSamples.push({
                    orderId: candidate.orderId,
                    trackingNumberLast4: candidate.trackingNumber.slice(-4),
                    message: error?.message || String(error)
                });
            }
        }
    }

    const summary = {
        ok: true,
        source: "orders_api",
        totalOrders: orders.length,
        candidates: candidates.length,
        uploaded,
        alreadyExists,
        markedSubmitted,
        failed,
        skipped: alreadyExists,
        samples: {
            uploaded: uploadedSamples,
            alreadyExists: alreadyExistsSamples,
            failed: failedSamples,
            skipped: skippedSamples
        }
    };

    await logServiceEvent({
        service: "ETSY_UPLOAD_TRACKING",
        logType: "task_completed",
        message: "AUTO_UPLOAD_TRACKING final summary",
        mongoShopId,
        taskId: batchTaskId,
        taskType: "AUTO_UPLOAD_TRACKING",
        rawData: summary
    });

    return summary;
    } finally {
        autoUploadTrackingLocks.delete(lockKey);
    }
}

async function getEtsyAutoBaseConfig() {
    const cfg = await chrome.storage.local.get([
        "mongoShopId",
        "backendUrl",
        "etsyAdsBackendUrl"
    ]);
    const mongoShopId = String(cfg.mongoShopId || "").trim();
    const backendUrl = String(cfg.backendUrl || CONFIG.DEFAULT_BACKEND_URL).trim();
    const etsyAdsBackendUrl = String(cfg.etsyAdsBackendUrl || CONFIG.DEFAULT_ETSY_ADS_BACKEND_URL).trim();

    return {
        mongoShopId,
        backendUrl,
        etsyAdsBackendUrl,
        apiBase: deriveAutoConfigApiBase(backendUrl)
    };
}

function deriveAutoConfigApiBase(backendUrl) {
    try {
        return new URL(String(backendUrl || CONFIG.DEFAULT_BACKEND_URL).trim()).origin;
    } catch (error) {
        console.warn("[LNG][sw][ETSY_AUTO_CONFIG] invalid backendUrl", {
            backendUrl,
            message: error?.message || String(error)
        });
        return "";
    }
}

async function fetchEtsyAutoConfigRecords() {
    const cfg = await getEtsyAutoBaseConfig();

    if (!cfg.mongoShopId || !/^[a-f0-9]{24}$/i.test(cfg.mongoShopId)) {
        throw new Error("ETSY_AUTO_CONFIG missing valid mongoShopId");
    }

    if (!cfg.apiBase) {
        throw new Error("ETSY_AUTO_CONFIG missing apiBase");
    }

    const url = `${cfg.apiBase}/api/auto-config?shopId=${encodeURIComponent(cfg.mongoShopId)}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Accept": "application/json, text/plain, */*"
        }
    });
    const text = await response.text();
    let body = null;

    try {
        body = JSON.parse(text || "{}");
    } catch (_) {
        body = { raw: text };
    }

    if (!response.ok) {
        throw new Error(`ETSY_AUTO_CONFIG fetch failed ${response.status}: ${text.slice(0, 300)}`);
    }

    const candidates = [
        body?.records,
        body?.data,
        body?.data?.records,
        body?.items,
        body?.configs,
        body
    ];
    const rawRecords = candidates.find((candidate) => Array.isArray(candidate)) || [];
    const records = rawRecords.filter((record) => String(record?.shopId || record?.shop || "").trim() === cfg.mongoShopId);

    etsyAutoConfigLastSnapshot = {
        ...etsyAutoConfigLastSnapshot,
        fetchedAt: new Date().toISOString(),
        records,
        error: null
    };

    console.log("[LNG][sw][ETSY_AUTO_CONFIG] config fetched", {
        url,
        status: response.status,
        rawCount: rawRecords.length,
        matchedCount: records.length,
        types: records.map((record) => record.type)
    });

    return {
        cfg,
        records
    };
}

function getEtsyAutoAlarmName(type) {
    return `${ETSY_AUTO_ALARM_PREFIX}${String(type || "").trim().toUpperCase()}`;
}

async function reconcileEtsyAutoConfigAlarms(records) {
    const enabledRecords = (records || []).filter((record) => record?.status === true);
    const wantedNames = new Set([
        ETSY_AUTO_SYNC_ALARM,
        ...enabledRecords.map((record) => getEtsyAutoAlarmName(record.type))
    ]);
    const alarms = await chrome.alarms.getAll();

    for (const alarm of alarms) {
        if (!String(alarm.name || "").startsWith(ETSY_AUTO_ALARM_PREFIX)) continue;
        if (wantedNames.has(alarm.name)) continue;

        await chrome.alarms.clear(alarm.name);
        console.log("[LNG][sw][ETSY_AUTO_CONFIG] alarm cleared", {
            name: alarm.name
        });
    }

    for (const record of enabledRecords) {
        const type = String(record.type || "").trim().toUpperCase();
        if (!type) continue;

        const minutes = Math.max(1, Number(record.time || 1) || 1);
        const name = getEtsyAutoAlarmName(type);
        const existing = await chrome.alarms.get(name);

        if (existing && Number(existing.periodInMinutes) === minutes) {
            console.log("[LNG][sw][ETSY_AUTO_CONFIG] alarm unchanged, keep existing", {
                name,
                type,
                minutes,
                scheduledTime: existing.scheduledTime,
                periodInMinutes: existing.periodInMinutes || null
            });

            continue;
        }

        await chrome.alarms.create(name, {
            delayInMinutes: minutes,
            periodInMinutes: minutes
        });

        console.log("[LNG][sw][ETSY_AUTO_CONFIG] alarm created/updated", {
            name,
            type,
            minutes,
            reason: existing ? "period_changed" : "missing",
            previousPeriodInMinutes: existing?.periodInMinutes || null
        });
    }

    const currentAlarms = (await chrome.alarms.getAll())
        .filter((alarm) => String(alarm.name || "").startsWith(ETSY_AUTO_ALARM_PREFIX))
        .map((alarm) => ({
            name: alarm.name,
            scheduledTime: alarm.scheduledTime,
            periodInMinutes: alarm.periodInMinutes || null
        }));

    etsyAutoConfigLastSnapshot = {
        ...etsyAutoConfigLastSnapshot,
        alarms: currentAlarms
    };

    return currentAlarms;
}

async function startEtsyAutoConfigScheduler(options = {}) {
    try {
        const { records } = await fetchEtsyAutoConfigRecords();
        const alarms = await reconcileEtsyAutoConfigAlarms(records);

        console.log("[LNG][sw][ETSY_AUTO_CONFIG] scheduler started", {
            reason: options.reason || "",
            force: options.force === true,
            records: records.length,
            alarms: alarms.length
        });

        return {
            ok: true,
            records,
            alarms
        };
    } catch (error) {
        etsyAutoConfigLastSnapshot = {
            ...etsyAutoConfigLastSnapshot,
            error: error?.message || String(error)
        };
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][SCHEDULER_ERROR]", error);
        sendSocketTaskLog("ETSY_AUTO_CONFIG scheduler error", {
            reason: options.reason || "",
            message: error?.message || String(error)
        });
        throw error;
    }
}

async function startEtsyAutoConfigSync() {
    const existing = await chrome.alarms.get(ETSY_AUTO_SYNC_ALARM);

    if (existing && Number(existing.periodInMinutes) === 10) {
        console.log("[LNG][sw][ETSY_AUTO_CONFIG] sync alarm unchanged, keep existing", {
            name: ETSY_AUTO_SYNC_ALARM,
            minutes: 10,
            scheduledTime: existing.scheduledTime,
            periodInMinutes: existing.periodInMinutes || null
        });

        return;
    }

    await chrome.alarms.create(ETSY_AUTO_SYNC_ALARM, {
        delayInMinutes: 10,
        periodInMinutes: 10
    });

    console.log("[LNG][sw][ETSY_AUTO_CONFIG] sync alarm created/updated", {
        name: ETSY_AUTO_SYNC_ALARM,
        minutes: 10,
        reason: existing ? "period_changed" : "missing",
        previousPeriodInMinutes: existing?.periodInMinutes || null
    });
}

function yesterdayLocalYMD() {
    const date = new Date();
    date.setDate(date.getDate() - 1);

    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
}

async function handleEtsyAutoConfigAlarm(alarm) {
    const name = String(alarm?.name || "");
    if (!name.startsWith(ETSY_AUTO_ALARM_PREFIX)) return;

    let cfg = null;
    let type = name === ETSY_AUTO_SYNC_ALARM
        ? "CONFIG_SYNC"
        : name.slice(ETSY_AUTO_ALARM_PREFIX.length);

    try {
        cfg = await getEtsyAutoBaseConfig();
    } catch (cfgError) {
        console.warn("[LNG][sw][ETSY_AUTO_CONFIG] cannot load cfg for alarm log", {
            alarmName: name,
            message: cfgError?.message || String(cfgError)
        });
    }

    console.log("[LNG][sw][ETSY_AUTO_CONFIG] alarm tick", {
        name,
        scheduledTime: alarm?.scheduledTime || null
    });

    await logEtsyAutoConfigEvent({
        logType: "auto_alarm_tick",
        message: `ETSY_AUTO_CONFIG alarm tick: ${name}`,
        cfg,
        alarmName: name,
        type,
        rawData: {
            scheduledTime: alarm?.scheduledTime || null
        }
    });

    try {
        if (name === ETSY_AUTO_SYNC_ALARM) {
            await logEtsyAutoConfigEvent({
                logType: "auto_task_started",
                message: "ETSY_AUTO_CONFIG sync started",
                cfg,
                alarmName: name,
                type
            });

            const result = await startEtsyAutoConfigScheduler({ reason: "alarm_sync" });

            console.log("[LNG][sw][ETSY_AUTO_CONFIG] task result", {
                name,
                result
            });

            await logEtsyAutoConfigEvent({
                logType: "auto_task_completed",
                message: "ETSY_AUTO_CONFIG sync completed",
                cfg,
                alarmName: name,
                type,
                result
            });

            return result;
        }

        if (!cfg) {
            cfg = await getEtsyAutoBaseConfig();
        }

        if (!cfg.mongoShopId || !/^[a-f0-9]{24}$/i.test(cfg.mongoShopId)) {
            throw new Error(`ETSY_AUTO_CONFIG ${type} missing valid mongoShopId`);
        }

        await logEtsyAutoConfigEvent({
            logType: "auto_task_started",
            message: `ETSY_AUTO_CONFIG ${type} started`,
            cfg,
            alarmName: name,
            type
        });

        let result;
        let rawData;

        if (type === "IMPORT_ORDER") {
            result = await handleSocketTask({
                taskId: `auto:${type}:${cfg.mongoShopId}:${Date.now()}`,
                type: "IMPORT_ORDERS",
                payload: {
                    mongoShopId: cfg.mongoShopId,
                    backendUrl: cfg.backendUrl,
                    limit: 50
                }
            });
        } else if (type === "IMPORT_ADS") {
            const date = yesterdayLocalYMD();
            rawData = { date };

            result = await handleSocketTask({
                taskId: `auto:${type}:${cfg.mongoShopId}:${date}`,
                type: "ETSY_ADS_FULL_IMPORT",
                payload: {
                    date,
                    mongoShopId: cfg.mongoShopId,
                    backendUrl: cfg.backendUrl,
                    etsyAdsBackendUrl: cfg.etsyAdsBackendUrl,
                    listingSyncMode: "always",
                    etsyListingBatchSize: 100,
                    filterMode: "spend_only"
                }
            });
        } else if (type === "IMPORT_FBM") {
            result = await handleSocketTask({
                taskId: `auto:${type}:${cfg.mongoShopId}:${Date.now()}`,
                type: "SYNC_ETSY_LISTINGS",
                payload: {
                    mongoShopId: cfg.mongoShopId,
                    backendUrl: cfg.backendUrl,
                    etsyListingBatchSize: 100
                }
            });
        } else if (type === "PULL_TRACKING") {
            await logServiceEvent({
                service: "PULL_TRACKING",
                logType: "task_processing",
                message: "PULL_TRACKING started",
                mongoShopId: cfg.mongoShopId,
                taskId: name,
                taskType: "PULL_TRACKING",
                rawData: {
                    alarmName: name,
                    type
                }
            });

            result = await pullPendingTasksNow().catch(async (error) => {
                await logServiceEvent({
                    service: "PULL_TRACKING",
                    logType: "task_failed",
                    level: "error",
                    message: `PULL_TRACKING failed: ${error?.message || String(error)}`,
                    mongoShopId: cfg.mongoShopId,
                    taskId: name,
                    taskType: "PULL_TRACKING",
                    error
                });

                throw error;
            });

            if (result?.reason === "socket_not_connected") {
                await logServiceEvent({
                    service: "PULL_TRACKING",
                    logType: "task_failed",
                    level: "warn",
                    message: "PULL_TRACKING skipped: socket not connected",
                    mongoShopId: cfg.mongoShopId,
                    taskId: name,
                    taskType: "PULL_TRACKING",
                    rawData: summarizePullTrackingResult(result)
                });

                await logEtsyAutoConfigEvent({
                    level: "warn",
                    logType: "auto_pull_tracking_skipped",
                    message: `ETSY_AUTO_CONFIG ${type} skipped: socket not connected`,
                    cfg,
                    alarmName: name,
                    type,
                    result
                });

                console.log("[LNG][sw][ETSY_AUTO_CONFIG] task result", {
                    name,
                    type,
                    result
                });

                return result;
            }

            await logServiceEvent({
                service: "PULL_TRACKING",
                logType: "task_completed",
                message: "PULL_TRACKING completed",
                mongoShopId: cfg.mongoShopId,
                taskId: name,
                taskType: "PULL_TRACKING",
                rawData: summarizePullTrackingResult(result)
            });
        } else if (type === "UPLOAD_TRACKING") {
            result = await runAutoUploadTrackingFromOrdersApi(cfg);
        } else {
            result = {
                ok: false,
                skipped: true,
                reason: "unsupported_auto_config_type",
                type
            };

            console.warn("[LNG][sw][ETSY_AUTO_CONFIG] unsupported alarm type", {
                name,
                type
            });

            await logEtsyAutoConfigEvent({
                level: "warn",
                logType: "auto_task_skipped",
                message: `ETSY_AUTO_CONFIG unsupported alarm type: ${type}`,
                cfg,
                alarmName: name,
                type,
                result
            });

            return result;
        }

        console.log("[LNG][sw][ETSY_AUTO_CONFIG] task result", {
            name,
            type,
            result
        });

        await logEtsyAutoConfigEvent({
            logType: "auto_task_completed",
            message: `ETSY_AUTO_CONFIG ${type} completed`,
            cfg,
            alarmName: name,
            type,
            result,
            rawData
        });

        return result;
    } catch (error) {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][ALARM_ERROR]", {
            alarmName: name,
            type,
            message: error?.message || String(error),
            error
        });
        sendSocketTaskLog("ETSY_AUTO_CONFIG alarm error", {
            alarmName: name,
            type,
            message: error?.message || String(error)
        });

        await logEtsyAutoConfigEvent({
            level: "error",
            logType: "auto_task_failed",
            message: `ETSY_AUTO_CONFIG ${type || "AUTO_CONFIG"} failed: ${error?.message || String(error)}`,
            cfg,
            alarmName: name,
            type,
            error
        });

        return {
            ok: false,
            failed: true,
            reason: "auto_config_alarm_error",
            type,
            error: error?.message || String(error)
        };
    }
}

async function handleSocketTask(task, context = {}) {
    const taskTypeRaw = String(task?.type || "").trim();
    const taskType = taskTypeRaw.toUpperCase();
    const taskId = String(
        task?.taskId ||
        task?.payload?.taskId ||
        `${taskType}:${Date.now()}`
    ).trim();

    if (socketTaskLocks.has(taskId)) {
        sendSocketTaskLog("⏭️ Task đang chạy, bỏ qua duplicate", {
            taskId,
            taskTypeRaw,
            taskType
        });

        return {
            ok: false,
            skipped: true,
            reason: "TASK_ALREADY_RUNNING",
            taskId,
            taskTypeRaw,
            taskType
        };
    }

    socketTaskLocks.add(taskId);

    try {
        sendSocketTaskLog("🧩 Bắt đầu xử lý socket task", {
            taskId,
            taskTypeRaw,
            taskType
        });

        if (taskType === "IMPORT_ORDERS") {
            return await handleImportOrdersSocketTask(task);
        }

        if (taskType === "SYNC_ETSY_LISTINGS" || taskType === "ETSY_SYNC_LISTINGS") {
            return await handleSyncEtsyListingsSocketTask(task);
        }

        if (taskType === "IMPORT_ADS_SPEND") {
            return await handleImportAdsSpendSocketTask(task);
        }

        if (
            taskType === "IMPORT_ETSY_ADS_WITH_LISTINGS" ||
            taskType === "ETSY_ADS_FULL_IMPORT" ||
            taskType === "IMPORT_ADS_SPEND_WITH_LISTINGS"
        ) {
            return await handleImportEtsyAdsWithListingsSocketTask(task);
        }

        if (taskType === "ETSY_UPLOAD_TRACKING" || taskType === "UPLOAD_TRACKING") {
            return await enqueueUploadTrackingTask(task);
        }

        sendSocketTaskLog("⚠️ Unknown socket task type", {
            taskId,
            taskTypeRaw,
            taskType
        });

        return {
            ok: false,
            skipped: true,
            reason: "UNKNOWN_TASK_TYPE",
            taskId,
            taskTypeRaw,
            taskType
        };
    } finally {
        socketTaskLocks.delete(taskId);
    }
}

function enqueueUploadTrackingTask(task) {
    const payload = task?.payload || {};
    const taskId = String(
        task?.taskId ||
        payload.taskId ||
        `etsy_upload_tracking:${Date.now()}`
    ).trim();
    const mongoShopId = String(
        payload.mongoShopId ||
        payload.machineId ||
        payload.shopId ||
        ""
    ).trim();
    const batchIndex = Number.isFinite(Number(payload.batchIndex))
        ? Number(payload.batchIndex)
        : null;
    const batchTotal = Number.isFinite(Number(payload.batchTotal))
        ? Number(payload.batchTotal)
        : null;

    sendSocketTaskLog("ETSY_UPLOAD_TRACKING: queued", {
        taskId,
        orderId: payload.orderId || "",
        trackingNumber: payload.trackingNumber || ""
    });

    logServiceEvent({
        service: "ETSY_UPLOAD_TRACKING",
        logType: "upload_progress",
        level: "info",
        message: "ETSY_UPLOAD_TRACKING queued",
        mongoShopId,
        taskId,
        taskType: "ETSY_UPLOAD_TRACKING",
        rawData: {
            taskId,
            orderId: payload.orderId || "",
            hasTrackingNumber: Boolean(payload.trackingNumber),
            batchIndex,
            batchTotal
        }
    });

    const run = () => handleUploadTrackingSocketTask(task);
    const resultPromise = uploadTrackingQueue.then(run, run);

    uploadTrackingQueue = resultPromise.catch((error) => {
        console.warn("[LNG][sw][ETSY_UPLOAD_TRACKING_QUEUE] task failed, continue queue", {
            taskId,
            message: error?.message || String(error)
        });
    });

    return resultPromise;
}

function buildUploadTrackingTaskInfo(taskId, batchGroupId) {
    return {
        taskId,
        taskType: "ETSY_UPLOAD_TRACKING",
        batchId: batchGroupId || undefined
    };
}

function getUploadTrackingProgress(batchIndex, batchTotal) {
    const index = Number(batchIndex);
    const total = Number(batchTotal);

    if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 0) {
        return undefined;
    }

    const previousPercent = Math.floor((index / total) * 100);
    const currentPercent = Math.floor(((index + 1) / total) * 100);
    const milestones = [25, 50, 75, 100];

    return milestones.find((milestone) => (
        previousPercent < milestone && currentPercent >= milestone
    ));
}

async function handleUploadTrackingSocketTask(task) {
    const payload = task?.payload || {};
    const taskId = String(
        task?.taskId ||
        payload.taskId ||
        `etsy_upload_tracking:${Date.now()}`
    ).trim();
    const machineId = String(
        payload.machineId ||
        payload.mongoShopId ||
        payload.shopId ||
        ""
    ).trim();
    const mongoShopId = String(
        payload.mongoShopId ||
        payload.machineId ||
        payload.shopId ||
        ""
    ).trim();
    const shopId = String(
        payload.shopId ||
        payload.machineId ||
        payload.mongoShopId ||
        ""
    ).trim();
    const orderId = String(payload.orderId || "").trim();
    const trackingNumber = String(payload.trackingNumber || "").trim();
    const carrier = normalizeEtsyCarrierName(payload.carrier || payload.carrierCode || payload.shippingCarrier) ||
        inferEtsyTrackingCarrier(trackingNumber);
    const batchGroupId = String(payload.batchGroupId || payload.batchId || "").trim();
    const batchIndex = Number.isFinite(Number(payload.batchIndex))
        ? Number(payload.batchIndex)
        : null;
    const batchTotal = Number.isFinite(Number(payload.batchTotal))
        ? Number(payload.batchTotal)
        : null;
    const taskInfo = buildUploadTrackingTaskInfo(taskId, batchGroupId);
    const progress = getUploadTrackingProgress(batchIndex, batchTotal);

    if (!orderId) {
        throw new Error("ETSY_UPLOAD_TRACKING thiếu orderId");
    }

    if (!trackingNumber) {
        throw new Error("ETSY_UPLOAD_TRACKING thiếu trackingNumber");
    }

    sendSocketTaskLog("ETSY_UPLOAD_TRACKING: start", {
        taskId,
        machineId,
        mongoShopId,
        shopId,
        orderId,
        trackingNumber,
        carrier
    });

    const startedAt = performance.now();
    logExtensionEvent({
        machineId: machineId || mongoShopId || shopId,
        shopId: shopId || mongoShopId || machineId,
        service: "ETSY_UPLOAD_TRACKING",
        logType: "upload_started",
        level: "info",
        message: `Starting Etsy tracking upload for order ${orderId}`,
        taskInfo,
        uploadInfo: {
            ordersUploaded: 0
        },
        rawData: {
            orderId,
            batchIndex,
            batchTotal,
            hasTrackingNumber: Boolean(trackingNumber),
            carrier
        }
    });

    if (progress !== undefined) {
        logExtensionEvent({
            machineId: machineId || mongoShopId || shopId,
            shopId: shopId || mongoShopId || machineId,
            service: "ETSY_UPLOAD_TRACKING",
            logType: "upload_progress",
            level: "info",
            message: `Uploading Etsy tracking ${(batchIndex ?? 0) + 1}/${batchTotal}`,
            taskInfo,
            uploadInfo: {
                progress,
                ordersUploaded: batchIndex === null ? undefined : batchIndex + 1
            },
            rawData: {
                orderId,
                batchIndex,
                batchTotal,
                carrier
            }
        });
    }

    try {
        const data = await handleUploadTrackingToEtsy({
            orderId,
            trackingNumber,
            carrier
        });
        const durationMs = Math.round(performance.now() - startedAt);

        const result = {
            ok: true,
            taskId,
            type: "ETSY_UPLOAD_TRACKING",
            machineId,
            mongoShopId,
            shopId,
            orderId,
            trackingNumber,
            durationMs,
            data
        };

        logExtensionEvent({
            machineId: machineId || mongoShopId || shopId,
            shopId: shopId || mongoShopId || machineId,
            shopName: data?.shopName || undefined,
            service: "ETSY_UPLOAD_TRACKING",
            logType: "upload_completed",
            level: "info",
            message: `Uploaded Etsy tracking for order ${orderId}`,
            taskInfo,
            uploadInfo: {
                ordersUploaded: 1,
                carrier: data?.carrier || data?.trackingCarrier || undefined,
                shipMethod: data?.shipMethod || data?.shippingMethod || undefined
            },
            performance: {
                duration: durationMs
            },
            rawData: {
                orderId,
                trackingNumberLast4: trackingNumber.slice(-4),
                carrier: data?.carrier || carrier || undefined,
                carrierId: data?.carrierId || undefined,
                carrierSource: data?.carrierSource || undefined,
                batchIndex,
                batchTotal
            }
        });

        sendSocketTaskLog("ETSY_UPLOAD_TRACKING: done", {
            taskId,
            orderId,
            trackingNumber,
            durationMs,
            etsyShopId: data?.shopId || null,
            shopName: data?.shopName || null,
            uploadedAt: data?.uploadedAt || null,
            carrier: data?.carrier || carrier || null
        });

        return result;
    } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt);

        logExtensionEvent({
            machineId: machineId || mongoShopId || shopId,
            shopId: shopId || mongoShopId || machineId,
            service: "ETSY_UPLOAD_TRACKING",
            logType: "upload_failed",
            level: "error",
            message: `Failed Etsy tracking upload for order ${orderId}: ${error?.message || String(error)}`,
            taskInfo,
            errorInfo: {
                errorCode: error?.code || undefined,
                errorMessage: error?.message || String(error),
                stackTrace: error?.stack || null,
                context: {
                    orderId,
                    carrier,
                    batchIndex,
                    batchTotal,
                    taskId
                }
            },
            performance: {
                duration: durationMs
            }
        });

        throw error;
    }
}

async function handleImportOrdersSocketTask(task) {
    const cfg = await chrome.storage.local.get([
        "mongoShopId",
        "backendUrl"
    ]);

    const taskId = String(
        task?.taskId ||
        task?.payload?.taskId ||
        `import_orders:${cfg.mongoShopId || "unknown"}:${Date.now()}`
    );

    const mongoShopId = String(
        task?.payload?.mongoShopId ||
        cfg.mongoShopId ||
        ""
    ).trim();

    const backendUrl = String(
        task?.payload?.backendUrl ||
        cfg.backendUrl ||
        CONFIG.DEFAULT_BACKEND_URL
    ).trim();

    const limit = Number(task?.payload?.limit || 50);
    const pageSize = Math.max(1, Math.min(Number(task?.payload?.pageSize || task?.payload?.limit || 50) || 50, 100));
    const maxTotalOrders = Math.max(1, Math.min(Number(task?.payload?.maxTotalOrders || task?.payload?.limit || 50) || 50, 200));
    const includeCustomizations = task?.payload?.includeCustomizations !== false;
    const includeCustomFiles = task?.payload?.includeCustomFiles !== false;
    const customFileDetailMode = task?.payload?.customFileDetailMode || "auto_upload_detail";
    const targetOrderId = String(task?.payload?.targetOrderId || task?.payload?.orderId || "").trim();
    const maxAutoDomDetailOrders = Number(task?.payload?.maxAutoDomDetailOrders || 10);
    const forceDomCustomFileScan = task?.payload?.forceDomCustomFileScan === true;

    sendSocketTaskLog("📦 IMPORT_ORDERS: Get Etsy Orders & Push start", {
        taskId,
        mongoShopId,
        backendUrl,
        limit,
        pageSize,
        maxTotalOrders,
        includeCustomizations,
        includeCustomFiles,
        customFileDetailMode,
        targetOrderId,
        maxAutoDomDetailOrders,
        forceDomCustomFileScan
    });

    const startedAt = performance.now();
    await logServiceEvent({
        service: "IMPORT_ORDERS",
        logType: "task_processing",
        message: "IMPORT_ORDERS started",
        mongoShopId,
        taskId,
        taskType: "IMPORT_ORDERS",
        rawData: {
            backendUrl,
            limit,
            pageSize,
            maxTotalOrders,
            includeCustomizations,
            includeCustomFiles,
            customFileDetailMode,
            targetOrderId,
            maxAutoDomDetailOrders,
            forceDomCustomFileScan
        }
    });

    const data = await handleGetEtsyOrdersAndPush({
        limit,
        pageSize,
        maxTotalOrders,
        mongoShopId,
        backendUrl,
        taskId,
        taskType: "IMPORT_ORDERS",
        includeCustomizations,
        includeCustomFiles,
        customFileDetailMode,
        targetOrderId,
        maxAutoDomDetailOrders,
        forceDomCustomFileScan
    }).catch(async (error) => {
        await logServiceEvent({
            service: "IMPORT_ORDERS",
            logType: "task_failed",
            level: "error",
            message: `IMPORT_ORDERS failed: ${error?.message || String(error)}`,
            mongoShopId,
            taskId,
            taskType: "IMPORT_ORDERS",
            error,
            performance: {
                duration: Math.round(performance.now() - startedAt)
            }
        });

        throw error;
    });

    const result = {
        ok: true,
        taskId,
        type: "IMPORT_ORDERS",
        totalOrders: data.totalOrders,
        push: data.push
    };

    sendSocketTaskLog("✅ IMPORT_ORDERS hoàn tất", result);

    await logServiceEvent({
        service: "IMPORT_ORDERS",
        logType: "task_completed",
        message: "IMPORT_ORDERS completed",
        mongoShopId,
        taskId,
        taskType: "IMPORT_ORDERS",
        rawData: {
            totalOrders: result.totalOrders,
            push: result.push
        },
        performance: {
            duration: Math.round(performance.now() - startedAt)
        }
    });

    return result;
}

async function handleSyncEtsyListingsSocketTask(task) {
    const cfg = await chrome.storage.local.get([
        "mongoShopId",
        "backendUrl"
    ]);

    const taskId = String(
        task?.taskId ||
        task?.payload?.taskId ||
        `sync_etsy_listings:${cfg.mongoShopId || "unknown"}:${Date.now()}`
    );

    const mongoShopId = String(
        task?.payload?.mongoShopId ||
        task?.payload?.shopId ||
        cfg.mongoShopId ||
        ""
    ).trim();

    const backendUrl = String(
        task?.payload?.backendUrl ||
        cfg.backendUrl ||
        CONFIG.DEFAULT_BACKEND_URL
    ).trim();

    const etsyListingSyncUrl = String(
        task?.payload?.etsyListingSyncUrl ||
        ""
    ).trim();

    const debugFetchDetailSku = task?.payload?.debugFetchDetailSku === true;

    sendSocketTaskLog("SYNC_ETSY_LISTINGS: start", {
        taskId,
        mongoShopId,
        backendUrl,
        etsyListingSyncUrl,
        debugFetchDetailSku
    });

    const startedAt = performance.now();
    await logServiceEvent({
        service: "SYNC_ETSY_LISTINGS",
        logType: "task_processing",
        message: "SYNC_ETSY_LISTINGS started",
        mongoShopId,
        taskId,
        taskType: "SYNC_ETSY_LISTINGS",
        rawData: {
            backendUrl,
            etsyListingSyncUrl,
            debugFetchDetailSku
        }
    });

    const data = await handleSyncEtsyListings({
        mongoShopId,
        backendUrl,
        etsyListingSyncUrl,
        debugFetchDetailSku,
        taskId,
        taskType: "SYNC_ETSY_LISTINGS"
    }).catch(async (error) => {
        await logServiceEvent({
            service: "SYNC_ETSY_LISTINGS",
            logType: "task_failed",
            level: "error",
            message: `SYNC_ETSY_LISTINGS failed: ${error?.message || String(error)}`,
            mongoShopId,
            taskId,
            taskType: "SYNC_ETSY_LISTINGS",
            error,
            performance: {
                duration: Math.round(performance.now() - startedAt)
            }
        });

        throw error;
    });

    const result = {
        ok: true,
        taskId,
        type: "SYNC_ETSY_LISTINGS",
        totalListings: data.totalListings,
        endpoint: data.endpoint,
        push: data.push
    };

    sendSocketTaskLog("SYNC_ETSY_LISTINGS: done", result);

    await logServiceEvent({
        service: "SYNC_ETSY_LISTINGS",
        logType: "task_completed",
        message: "SYNC_ETSY_LISTINGS completed",
        mongoShopId,
        taskId,
        taskType: "SYNC_ETSY_LISTINGS",
        rawData: {
            totalListings: result.totalListings,
            endpoint: result.endpoint,
            push: summarizeListingPush(result.push)
        },
        performance: {
            duration: Math.round(performance.now() - startedAt)
        }
    });

    return result;
}

function extractDateFromSocketTask(task) {
    const directDate = String(
        task?.payload?.date ||
        task?.payload?.day ||
        task?.date ||
        task?.day ||
        ""
    ).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(directDate)) {
        return directDate;
    }

    const taskId = String(task?.taskId || task?.payload?.taskId || "").trim();
    const matched = taskId.match(/\d{4}-\d{2}-\d{2}/);

    if (matched) {
        return matched[0];
    }

    return "";
}

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

async function handleImportAdsSpendSocketTask(task) {
    const cfg = await chrome.storage.local.get([
        "mongoShopId",
        "etsyAdsBackendUrl"
    ]);

    const taskId = String(
        task?.taskId ||
        task?.payload?.taskId ||
        `import_ads_spend:${cfg.mongoShopId || "unknown"}:${Date.now()}`
    );

    const mongoShopId = String(
        task?.payload?.mongoShopId ||
        task?.payload?.shopId ||
        cfg.mongoShopId ||
        ""
    ).trim();

    const date = toLocalYMD(extractDateFromSocketTask(task));

    const etsyAdsBackendUrl = String(
        task?.payload?.etsyAdsBackendUrl ||
        task?.payload?.adsBackendUrl ||
        cfg.etsyAdsBackendUrl ||
        CONFIG.DEFAULT_ETSY_ADS_BACKEND_URL
    ).trim();
    const queryDateOffsetDays = 0;
    const autoResolveOverviewDate = false;
    const filterMode = task?.payload?.filterMode || "spend_only";
    const dryRun = task?.payload?.dryRun === true;
    const debugComparePromotedParam = task?.payload?.debugComparePromotedParam === true;
    const debugCompareDateOffset = task?.payload?.debugCompareDateOffset === true;
    const requestedDebugCompareMaxPages = Number(task?.payload?.debugCompareMaxPages || 2);
    const debugCompareMaxPages = Number.isFinite(requestedDebugCompareMaxPages)
        ? requestedDebugCompareMaxPages
        : 2;

    if (!date) {
        throw new Error(`IMPORT_ADS_SPEND thiếu ngày hợp lệ. taskId=${taskId}`);
    }

    sendSocketTaskLog("📊 IMPORT_ADS_SPEND: Kéo Etsy Ads Spend start", {
        taskId,
        mongoShopId,
        date,
        etsyAdsBackendUrl,
        queryDateOffsetDays,
        autoResolveOverviewDate: false,
        filterMode,
        dryRun,
        debugComparePromotedParam,
        debugCompareDateOffset,
        debugCompareMaxPages,
        taskId,
        taskType: "ETSY_ADS"
    });

    const data = await handleEtsyAdsImportDay({
        date,
        mongoShopId,
        etsyAdsBackendUrl,
        queryDateOffsetDays,
        autoResolveOverviewDate: false,
        filterMode,
        dryRun,
        debugComparePromotedParam,
        debugCompareDateOffset,
        debugCompareMaxPages
    });

    const result = {
        ok: true,
        taskId,
        type: "IMPORT_ADS_SPEND",
        date,
        mongoShopId,
        rows: data.rows,
        totalSpend: data.totalSpend,
        push: data.push
    };

    sendSocketTaskLog("✅ IMPORT_ADS_SPEND hoàn tất", result);

    return result;
}

async function handleImportEtsyAdsWithListingsSocketTask(task) {
    const cfg = await chrome.storage.local.get([
        "mongoShopId",
        "backendUrl",
        "etsyAdsBackendUrl"
    ]);

    const taskId = String(
        task?.taskId ||
        task?.payload?.taskId ||
        `etsy_ads_full:${cfg.mongoShopId || "unknown"}:${Date.now()}`
    );
    const date = toLocalYMD(extractDateFromSocketTask(task));
    const mongoShopId = String(
        task?.payload?.mongoShopId ||
        task?.payload?.shopId ||
        cfg.mongoShopId ||
        ""
    ).trim();
    const backendUrl = String(
        task?.payload?.backendUrl ||
        cfg.backendUrl ||
        CONFIG.DEFAULT_BACKEND_URL
    ).trim();
    const etsyListingSyncUrl = String(task?.payload?.etsyListingSyncUrl || "").trim();
    const etsyAdsBackendUrl = String(
        task?.payload?.etsyAdsBackendUrl ||
        task?.payload?.adsBackendUrl ||
        cfg.etsyAdsBackendUrl ||
        CONFIG.DEFAULT_ETSY_ADS_BACKEND_URL
    ).trim();
    const listingSyncMode = String(task?.payload?.listingSyncMode || "always").trim() || "always";
    const etsyListingBatchSize = Number(task?.payload?.etsyListingBatchSize || 100);
    const debugFetchDetailSku = task?.payload?.debugFetchDetailSku === true;
    const filterMode = task?.payload?.filterMode || "spend_only";
    const dryRun = task?.payload?.dryRun === true;
    const debugComparePromotedParam = task?.payload?.debugComparePromotedParam === true;
    const debugCompareDateOffset = task?.payload?.debugCompareDateOffset === true;
    const requestedDebugCompareMaxPages = Number(task?.payload?.debugCompareMaxPages || 2);
    const debugCompareMaxPages = Number.isFinite(requestedDebugCompareMaxPages)
        ? requestedDebugCompareMaxPages
        : 2;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`ETSY_ADS_FULL_IMPORT thieu ngay hop le. taskId=${taskId}`);
    }

    if (!mongoShopId || !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
        throw new Error("ETSY_ADS_FULL_IMPORT thieu mongoShopId hop le");
    }

    const startedAt = performance.now();
    await logServiceEvent({
        service: "ETSY_ADS_FULL_IMPORT",
        logType: "task_processing",
        message: "ETSY_ADS_FULL_IMPORT started",
        mongoShopId,
        taskId,
        taskType: "ETSY_ADS_FULL_IMPORT",
        rawData: {
            date,
            listingSyncMode,
            filterMode
        }
    });

    const result = await handleImportEtsyAdsWithListings({
        date,
        mongoShopId,
        backendUrl,
        etsyListingSyncUrl,
        etsyAdsBackendUrl,
        listingSyncMode,
        etsyListingBatchSize,
        debugFetchDetailSku,
        filterMode,
        dryRun,
        debugComparePromotedParam,
        debugCompareDateOffset,
        debugCompareMaxPages,
        taskId,
        taskType: "ETSY_ADS_FULL_IMPORT"
    }).catch(async (error) => {
        await logServiceEvent({
            service: "ETSY_ADS_FULL_IMPORT",
            logType: "task_failed",
            level: "error",
            message: `ETSY_ADS_FULL_IMPORT failed: ${error?.message || String(error)}`,
            mongoShopId,
            taskId,
            taskType: "ETSY_ADS_FULL_IMPORT",
            rawData: {
                date,
                listingSyncMode,
                filterMode
            },
            error,
            performance: {
                duration: Math.round(performance.now() - startedAt)
            }
        });

        throw error;
    });

    const finalResult = {
        ...result,
        taskId
    };

    await logServiceEvent({
        service: "ETSY_ADS_FULL_IMPORT",
        logType: "task_completed",
        message: "ETSY_ADS_FULL_IMPORT completed",
        mongoShopId,
        taskId,
        taskType: "ETSY_ADS_FULL_IMPORT",
        rawData: {
            date,
            listingSyncMode,
            filterMode,
            listingSync: finalResult.listingSync,
            ads: {
                rows: finalResult.ads?.rows ?? null,
                totalSpend: finalResult.ads?.totalSpend ?? null,
                skuEnrich: finalResult.ads?.skuEnrich ?? null
            }
        },
        performance: {
            duration: Math.round(performance.now() - startedAt)
        }
    });

    return finalResult;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[LNG][sw] onMessage", {
        action: message?.action,
        type: message?.type,
        message,
        sender: sender?.id
    });

    if (
        message?.type === "SOCKET_CONNECT" ||
        message?.type === "SOCKET_DISCONNECT" ||
        message?.type === "SOCKET_STATUS"
    ) {
        console.log("[LNG][sw][SOCKET_ROUTER] received", {
            type: message.type
        });

        (async () => {
            try {
                let response;

                if (message.type === "SOCKET_CONNECT") {
                    console.log("[LNG][sw][SOCKET_ROUTER] before connectSocket");

                    response = await connectSocket(true);

                    console.log("[LNG][sw][SOCKET_ROUTER] SOCKET_CONNECT response", response);
                }

                if (message.type === "SOCKET_DISCONNECT") {
                    response = await disconnectSocket();

                    console.log("[LNG][sw][SOCKET_ROUTER] SOCKET_DISCONNECT response", response);
                }

                if (message.type === "SOCKET_STATUS") {
                    response = await getSocketStatus();

                    console.log("[LNG][sw][SOCKET_ROUTER] SOCKET_STATUS response", response);
                }

                sendResponse(response || {
                    ok: false,
                    message: "Unknown socket message type"
                });
            } catch (error) {
                console.error("[LNG][sw][SOCKET_ROUTER][ERROR]", error);

                sendResponse({
                    ok: false,
                    message: error?.message || String(error)
                });
            }
        })();

        return true;
    }

    if (message.action === "ETSY_GET_ORDERS_AND_PUSH" || message.action === "ETSY_GET_ORDERS") {
        handleGetEtsyOrdersAndPush(message.payload || {})
            .then((data) => {
                console.log("[LNG][sw] ETSY_GET_ORDERS_AND_PUSH done", data);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ERROR]", error);
                sendResponse({ ok: false, message: error.message || "Failed" });
            });

        return true;
    }

    if (message.action === "ETSY_SYNC_LISTINGS") {
        handleSyncEtsyListings(message.payload || {})
            .then((data) => {
                console.log("[LNG][sw] ETSY_SYNC_LISTINGS done", data);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_SYNC_LISTINGS_ERROR]", error);
                sendResponse({ ok: false, message: error.message || "Etsy listings sync failed" });
            });

        return true;
    }

    if (message.action === "ETSY_RELOAD_AUTO_CONFIG") {
        (async () => {
            await startEtsyAutoConfigSync();
            return await startEtsyAutoConfigScheduler({
                reason: "runtime_reload",
                force: true
            });
        })()
            .then((data) => {
                console.log("[LNG][sw] ETSY_RELOAD_AUTO_CONFIG done", data);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_RELOAD_AUTO_CONFIG_ERROR]", error);
                sendResponse({ ok: false, message: error?.message || String(error) });
            });

        return true;
    }

    if (message.action === "ETSY_AUTO_CONFIG_STATUS") {
        chrome.alarms.getAll()
            .then((alarms) => {
                const autoAlarms = alarms
                    .filter((alarm) => String(alarm.name || "").startsWith(ETSY_AUTO_ALARM_PREFIX))
                    .map((alarm) => ({
                        name: alarm.name,
                        scheduledTime: alarm.scheduledTime,
                        periodInMinutes: alarm.periodInMinutes || null
                    }));

                sendResponse({
                    ok: true,
                    data: {
                        alarms: autoAlarms,
                        snapshot: etsyAutoConfigLastSnapshot
                    }
                });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_AUTO_CONFIG_STATUS_ERROR]", error);
                sendResponse({ ok: false, message: error?.message || String(error) });
            });

        return true;
    }

    if (message.action === "ETSY_ADS_FULL_IMPORT") {
        handleImportEtsyAdsWithListings(message.payload || {})
            .then((data) => {
                console.log("[LNG][sw] ETSY_ADS_FULL_IMPORT done", data);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_ADS_FULL_IMPORT_ERROR]", error);
                sendResponse({ ok: false, message: error.message || "Etsy Ads full import failed" });
            });

        return true;
    }

    if (message.action === "ETSY_UPLOAD_TRACKING") {
        handleUploadTrackingToEtsy(message.payload || {})
            .then((data) => {
                console.log("[LNG][sw] ETSY_UPLOAD_TRACKING done", data);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_UPLOAD_TRACKING_ERROR]", error);

                sendResponse({
                    ok: false,
                    message: error.message || "Upload tracking failed"
                });
            });

        return true;
    }

    if (message.action === "ETSY_MESSAGE_SYNC_DEBUG") {
        handleEtsyMessageSyncDebug(message.payload || {})
            .then((data) => {
                const threads = Array.isArray(data?.threads) ? data.threads : [];
                const safeSummary = {
                    totalThreads: threads.length,
                    unreadThreads: threads.filter((thread) => thread?.unread === true).length,
                    threadsWithOrderId: threads.filter((thread) => Boolean(thread?.orderId)).length,
                    source: data?.source || "",
                    syncedAt: data?.syncedAt || "",
                    sampleThreads: threads.slice(0, 5).map((thread) => ({
                        threadId: thread.threadId || "",
                        buyerName: thread.buyerName || "",
                        orderId: thread.orderId || "",
                        unread: thread.unread === true,
                        lastMessageAt: thread.lastMessageAt || "",
                        latestMessagePreview: thread.latestMessagePreview || ""
                    }))
                };

                console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] done", data);
                sendSocketTaskLog("ETSY_MESSAGE_SYNC_DEBUG done", safeSummary);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG_ERROR]", error);
                sendSocketTaskLog("ETSY_MESSAGE_SYNC_DEBUG error", {
                    message: error?.message || String(error)
                });
                sendResponse({
                    ok: false,
                    message: error?.message || "Etsy message sync debug failed"
                });
            });

        return true;
    }

    if (message.action === "ETSY_MESSAGE_MONITOR_TICK") {
        runEtsyMessageMonitorTick()
            .then((data) => {
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                sendResponse({
                    ok: false,
                    message: error?.message || String(error)
                });
            });

        return true;
    }

    if (message.action === "ETSY_MESSAGE_MONITOR_STATUS") {
        getEtsyMessageMonitorStatus()
            .then((data) => {
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                sendResponse({
                    ok: false,
                    message: error?.message || String(error)
                });
            });

        return true;
    }

    if (message.action === "ETSY_ADS_RECON_LOG") {
        const tag = message.payload?.tag || "UNKNOWN";
        const data = message.payload?.data || {};

        console.log(`[LNG][sw][ETSY_ADS][RECON_BRIDGE][${tag}]`, data);
        sendSocketTaskLog(`ETSY_ADS RECON ${tag}`, data);
        sendResponse({ ok: true });
        return true;
    }

    if (message.action === "ETSY_ADS_IMPORT_DAY") {
        handleEtsyAdsImportDay(message.payload || {})
            .then((data) => {
                console.log("[LNG][sw] ETSY_ADS_IMPORT_DAY done", data);
                sendResponse({ ok: true, data });
            })
            .catch((error) => {
                console.error("[LNG][sw][ETSY_ADS_IMPORT_DAY_ERROR]", error);

                sendResponse({
                    ok: false,
                    message: error.message || "Etsy Ads import failed"
                });
            });

        return true;
    }

    return false;
});

chrome.runtime.onStartup.addListener(() => {
    autoConnectSocketIfReady();
    startEtsyMessageMonitorAlarm().catch((error) => {
        console.error("[LNG][sw][ETSY_MESSAGE_MONITOR][STARTUP_ERROR]", error);
    });
    startEtsyAutoConfigScheduler({ reason: "startup" }).catch((error) => {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][STARTUP_ERROR]", error);
    });
    startEtsyAutoConfigSync().catch((error) => {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][STARTUP_SYNC_ERROR]", error);
    });
});

chrome.runtime.onInstalled.addListener(() => {
    autoConnectSocketIfReady();
    startEtsyMessageMonitorAlarm().catch((error) => {
        console.error("[LNG][sw][ETSY_MESSAGE_MONITOR][INSTALLED_ERROR]", error);
    });
    startEtsyAutoConfigScheduler({ reason: "installed" }).catch((error) => {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][INSTALLED_ERROR]", error);
    });
    startEtsyAutoConfigSync().catch((error) => {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][INSTALLED_SYNC_ERROR]", error);
    });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    const relevantKeys = ["mongoShopId", "backendUrl", "etsyAdsBackendUrl"];
    const changedKeys = Object.keys(changes || {}).filter((key) => relevantKeys.includes(key));

    if (!changedKeys.length) return;

    console.log("[LNG][sw][ETSY_AUTO_CONFIG] storage changed, reload scheduler", {
        changedKeys
    });

    startEtsyAutoConfigScheduler({ reason: "storage_changed", force: true }).catch((error) => {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][STORAGE_RELOAD_ERROR]", error);
        sendSocketTaskLog("ETSY_AUTO_CONFIG storage reload error", {
            message: error?.message || String(error)
        });
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === ETSY_MESSAGE_MONITOR_ALARM) {
        if (ETSY_MESSAGE_MONITOR_AUTO_ENABLED !== true) {
            chrome.alarms.clear(ETSY_MESSAGE_MONITOR_ALARM).catch(() => {});
            console.log("[LNG][sw][ETSY_MESSAGE_MONITOR] ignored alarm because auto disabled", {
                name: alarm.name
            });
            return;
        }

        runEtsyMessageMonitorTick().catch((error) => {
            console.error("[LNG][sw][ETSY_MESSAGE_MONITOR][ERROR]", error);
            sendSocketTaskLog("ETSY_MESSAGE_MONITOR error", {
                message: error?.message || String(error)
            });
        });
        return;
    }

    handleEtsyAutoConfigAlarm(alarm).catch((error) => {
        console.error("[LNG][sw][ETSY_AUTO_CONFIG][ALARM_ERROR]", {
            alarmName: alarm?.name || "",
            message: error?.message || String(error),
            error
        });
        sendSocketTaskLog("ETSY_AUTO_CONFIG alarm error", {
            alarmName: alarm?.name || "",
            message: error?.message || String(error)
        });
    });
});

async function handleGetEtsyOrdersAndPush(payload = {}) {
    const mongoShopId = String(payload.mongoShopId || "").trim();
    const backendUrl = String(payload.backendUrl || CONFIG.DEFAULT_BACKEND_URL).trim();
    const taskId = String(payload.taskId || `import_orders:${mongoShopId}:${Date.now()}`).trim();
    const taskType = String(payload.taskType || "IMPORT_ORDERS").trim();
    const targetOrderId = String(payload.targetOrderId || payload.orderId || "").trim();
    const pageSize = Math.max(1, Math.min(Number(payload.pageSize || payload.limit || 50) || 50, 100));
    const maxTotalOrders = Math.max(1, Math.min(Number(payload.maxTotalOrders || payload.limit || 50) || 50, 200));
    const maxAutoDomDetailOrders = Number(payload.maxAutoDomDetailOrders || 10);
    const forceDomCustomFileScan = payload.forceDomCustomFileScan === true;

    if (!mongoShopId || !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
        throw new Error("Thieu mongoShopId hop le (ObjectId 24-hex)");
    }

    console.log("[LNG][sw] handleGetEtsyOrdersAndPush start", {
        mongoShopId,
        backendUrl,
        targetOrderId,
        pageSize,
        maxTotalOrders,
        customFileDetailMode: payload.customFileDetailMode || "auto_upload_detail",
        maxAutoDomDetailOrders,
        forceDomCustomFileScan
    });

    const tab = await ensureEtsySoldOrdersTab();
    console.log("[LNG][sw] tab ready", { tabId: tab.id, url: tab.url });
    await logServiceEvent({
        service: "IMPORT_ORDERS",
        logType: "debug",
        message: "IMPORT_ORDERS etsy tab ready",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            tabId: tab.id,
            status: tab.status || null,
            targetOrderId,
            pageSize,
            maxTotalOrders
        }
    });

    await injectContentScript(tab.id);

    const customImportOptions = {
        limit: pageSize,
        pageSize,
        maxTotalOrders,
        includeCustomizations: payload.includeCustomizations !== false,
        includeCustomFiles: payload.includeCustomFiles !== false,
        customFileDetailMode: payload.customFileDetailMode || "auto_upload_detail",
        targetOrderId: targetOrderId || ""
    };
    const contentResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "CONTENT_ETSY_GET_ORDERS",
        payload: customImportOptions
    });

    if (!contentResponse?.ok) {
        throw new Error(contentResponse?.message || "Content script failed");
    }

    const etsyData = contentResponse.data;
    const backendOrders = etsyData.orders || [];
    let domCustomFileSummary = null;

    if (customImportOptions.customFileDetailMode === "dom_detail" && targetOrderId) {
        const domScanResult = await scanTargetOrderDomCustomFiles({
            targetOrderId,
            waitMs: Number(payload.domDetailWaitMs || payload.waitMs || 3000)
        });
        const targetOrder = backendOrders.find((order) => String(order?.orderId || "") === targetOrderId);
        const targetItem = Array.isArray(targetOrder?.items) ? targetOrder.items[0] : null;
        mergeDomCustomFilesIntoBackendOrders(backendOrders, {
            orderId: targetOrderId,
            itemIndex: 0,
            transactionId: String(payload.transactionId || targetItem?.transactionId || ""),
            listingId: String(payload.listingId || targetItem?.listingId || ""),
            reason: "target_dom_detail"
        }, domScanResult?.customFiles || []);
        domCustomFileSummary = buildCustomFileSummary(backendOrders);
        console.log("[LNG][sw][CUSTOM_FILE_DOM_DETAIL][ORDER_CUSTOM_SUMMARY]", {
            targetOrderId,
            ...domCustomFileSummary
        });
    }

    if (customImportOptions.customFileDetailMode === "auto_upload_detail") {
        const autoDetailSummary = await runAutoUploadDomDetailScan({
            backendOrders,
            maxAutoDomDetailOrders,
            forceDomCustomFileScan,
            waitMs: Number(payload.domDetailWaitMs || payload.waitMs || 3000)
        });
        domCustomFileSummary = {
            ...buildCustomFileSummary(backendOrders),
            autoDetail: autoDetailSummary
        };
    }

    console.log("[LNG][sw][ETSY_DATA]", {
        shopId: etsyData.shopId,
        shopName: etsyData.shopName,
        totalOrders: backendOrders.length,
        targetOrderId,
        pageSize,
        maxTotalOrders,
        contentMeta: etsyData.meta || null
    });
    await logServiceEvent({
        service: "IMPORT_ORDERS",
        logType: "info",
        message: "IMPORT_ORDERS content orders parsed",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            etsyShopId: etsyData.shopId || null,
            shopName: etsyData.shopName || null,
            totalOrders: backendOrders.length,
            sampleOrderIds: sampleIds(backendOrders, ["orderId", "receiptId", "id"]),
            targetOrderId,
            pageSize,
            maxTotalOrders,
            contentMeta: etsyData.meta || null
        }
    });

    // Stamp shopId (Mongo ObjectId) vao moi don truoc khi POST
    for (const o of backendOrders) {
        o.shopId = mongoShopId;
    }

    await logServiceEvent({
        service: "IMPORT_ORDERS",
        logType: "task_processing",
        message: "IMPORT_ORDERS backend push started",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            backendUrl,
            count: backendOrders.length,
            targetOrderId,
            pageSize,
            maxTotalOrders
        }
    });

    const pushResult = await pushOrdersToBackend(backendOrders, backendUrl);

    await logServiceEvent({
        service: "IMPORT_ORDERS",
        logType: "task_completed",
        message: "IMPORT_ORDERS backend push completed",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            push: pushResult
        }
    });

    return {
        etsyShopId: etsyData.shopId,
        shopName: etsyData.shopName,
        mongoShopId,
        backendUrl,
        targetOrderId,
        totalOrders: backendOrders.length,
        meta: etsyData.meta || null,
        domCustomFileSummary,
        push: pushResult
    };
}

async function handleSyncEtsyListings(payload = {}) {
    const mongoShopId = String(payload.mongoShopId || payload.shopId || "").trim();
    const backendUrl = String(payload.backendUrl || CONFIG.DEFAULT_BACKEND_URL).trim();
    const endpoint = String(payload.etsyListingSyncUrl || deriveEtsyListingSyncUrl(backendUrl)).trim();
    const taskId = String(payload.taskId || `sync_etsy_listings:${mongoShopId}:${Date.now()}`).trim();
    const taskType = String(payload.taskType || "SYNC_ETSY_LISTINGS").trim();
    const debugFetchDetailSku = payload.debugFetchDetailSku === true;
    const requestedBatchSize = Number(payload.etsyListingBatchSize || 100);
    const batchSize = Math.max(
        20,
        Math.min(Number.isFinite(requestedBatchSize) ? requestedBatchSize : 100, 200)
    );

    if (!mongoShopId || !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
        throw new Error("Thieu mongoShopId hop le (ObjectId 24-hex)");
    }

    console.log("[LNG][sw][ETSY_LISTINGS] handleSyncEtsyListings start", {
        mongoShopId,
        backendUrl,
        endpoint,
        debugFetchDetailSku,
        batchSize
    });

    const tab = await ensureEtsySoldOrdersTab();
    console.log("[LNG][sw][ETSY_LISTINGS] tab ready", { tabId: tab.id, url: tab.url });
    await logServiceEvent({
        service: "SYNC_ETSY_LISTINGS",
        logType: "debug",
        message: "SYNC_ETSY_LISTINGS tab ready",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            tabId: tab.id,
            status: tab.status || null
        }
    });

    await injectContentScript(tab.id);

    const contentResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "CONTENT_ETSY_SYNC_LISTINGS",
        payload: {
            debugFetchDetailSku
        }
    });

    if (!contentResponse?.ok) {
        throw new Error(contentResponse?.message || "Content Etsy listings sync failed");
    }

    const etsyData = contentResponse.data || {};
    const payloadToBackend = {
        shopId: mongoShopId,
        etsyShopId: etsyData.etsyShopId || "",
        shopName: etsyData.shopName || "",
        listings: Array.isArray(etsyData.listings) ? etsyData.listings : [],
        syncedAt: new Date().toISOString(),
        source: "etsy_listing_search"
    };
    await logServiceEvent({
        service: "SYNC_ETSY_LISTINGS",
        logType: "info",
        message: "SYNC_ETSY_LISTINGS listings parsed",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            totalListings: payloadToBackend.listings.length,
            etsyShopId: payloadToBackend.etsyShopId || null,
            shopName: payloadToBackend.shopName || null,
            sampleListingIds: sampleIds(payloadToBackend.listings, ["listingId", "listing_id", "id"])
        }
    });

    console.log("[LNG][sw][ETSY_LISTINGS][POST_PAYLOAD]", {
        endpoint,
        shopId: payloadToBackend.shopId,
        etsyShopId: payloadToBackend.etsyShopId,
        shopName: payloadToBackend.shopName,
        listingsCount: payloadToBackend.listings.length,
        firstListing: payloadToBackend.listings[0] || null,
        summary: etsyData.summary || null
    });

    await logServiceEvent({
        service: "SYNC_ETSY_LISTINGS",
        logType: "task_processing",
        message: "SYNC_ETSY_LISTINGS backend batch push started",
        mongoShopId,
        taskId,
        taskType,
        rawData: {
            endpoint,
            batchSize,
            totalListings: payloadToBackend.listings.length
        }
    });

    const push = await pushEtsyListingsToBackendInBatches(endpoint, payloadToBackend, batchSize, {
        taskId,
        taskType
    });

    await logServiceEvent({
        service: "SYNC_ETSY_LISTINGS",
        logType: "task_completed",
        message: "SYNC_ETSY_LISTINGS backend batch push completed",
        mongoShopId,
        taskId,
        taskType,
        rawData: summarizeListingPush(push)
    });

    return {
        ok: true,
        endpoint,
        mongoShopId,
        etsyShopId: payloadToBackend.etsyShopId,
        shopName: payloadToBackend.shopName,
        totalListings: payloadToBackend.listings.length,
        summary: etsyData.summary || null,
        push
    };
}

const etsyAdsFullImportLocks = new Map();

async function handleImportEtsyAdsWithListings(payload = {}) {
    const date = toLocalYMD(payload.date || payload.day || "");
    const mongoShopId = String(payload.mongoShopId || payload.shopId || "").trim();
    const taskId = String(payload.taskId || `etsy_ads_full:${mongoShopId}:${date || Date.now()}`).trim();
    const taskType = String(payload.taskType || "ETSY_ADS_FULL_IMPORT").trim();
    const backendUrl = String(payload.backendUrl || CONFIG.DEFAULT_BACKEND_URL).trim();
    const etsyListingSyncUrl = String(payload.etsyListingSyncUrl || "").trim();
    const etsyAdsBackendUrl = String(
        payload.etsyAdsBackendUrl ||
        payload.adsBackendUrl ||
        CONFIG.DEFAULT_ETSY_ADS_BACKEND_URL
    ).trim();
    const listingSyncMode = String(payload.listingSyncMode || "always").trim() || "always";
    const requestedBatchSize = Number(payload.etsyListingBatchSize || 100);
    const etsyListingBatchSize = Math.max(
        20,
        Math.min(Number.isFinite(requestedBatchSize) ? requestedBatchSize : 100, 200)
    );
    const debugFetchDetailSku = payload.debugFetchDetailSku === true;
    const filterMode = payload.filterMode || "spend_only";
    const allowListingFallback = payload.allowListingFallback === true;
    const dryRun = payload.dryRun === true;
    const debugComparePromotedParam = payload.debugComparePromotedParam === true;
    const debugCompareDateOffset = payload.debugCompareDateOffset === true;
    const requestedDebugCompareMaxPages = Number(payload.debugCompareMaxPages || 2);
    const debugCompareMaxPages = Number.isFinite(requestedDebugCompareMaxPages)
        ? requestedDebugCompareMaxPages
        : 2;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("ETSY_ADS_FULL_IMPORT date phai dung dinh dang YYYY-MM-DD");
    }

    if (!mongoShopId || !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
        throw new Error("ETSY_ADS_FULL_IMPORT thieu mongoShopId hop le");
    }

    const lockKey = `etsy_ads_full:${mongoShopId}:${date}`;

    if (etsyAdsFullImportLocks.has(lockKey)) {
        return {
            ok: false,
            skipped: true,
            reason: "ETSY_ADS_FULL_IMPORT_RUNNING",
            date,
            mongoShopId
        };
    }

    const job = (async () => {
        let listingSyncResult = null;
        let adsResult = null;

        console.log("[LNG][sw][ETSY_ADS_FULL_IMPORT][START]", {
            date,
            mongoShopId,
            listingSyncMode,
            etsyListingBatchSize,
            filterMode
        });

        if (listingSyncMode !== "skip") {
            sendSocketTaskLog("ETSY_ADS_FULL_IMPORT: Sync listings start", {
                date,
                mongoShopId,
                etsyListingBatchSize
            });
            await logServiceEvent({
                service: "ETSY_ADS_FULL_IMPORT",
                logType: "task_processing",
                message: "ETSY_ADS_FULL_IMPORT listings sync phase started",
                mongoShopId,
                taskId,
                taskType,
                rawData: {
                    date,
                    etsyListingBatchSize
                }
            });

            listingSyncResult = await handleSyncEtsyListings({
                mongoShopId,
                backendUrl,
                etsyListingSyncUrl,
                debugFetchDetailSku,
                etsyListingBatchSize,
                taskId,
                taskType: "SYNC_ETSY_LISTINGS"
            });

            console.log("[LNG][sw][ETSY_ADS_FULL_IMPORT][LISTINGS_DONE]", {
                totalListings: listingSyncResult?.totalListings ?? null,
                accepted: listingSyncResult?.push?.accepted ?? null,
                rejected: listingSyncResult?.push?.rejected ?? null,
                batches: listingSyncResult?.push?.batches ?? null
            });

            sendSocketTaskLog("ETSY_ADS_FULL_IMPORT: Sync listings done", {
                totalListings: listingSyncResult?.totalListings ?? null,
                accepted: listingSyncResult?.push?.accepted ?? null,
                rejected: listingSyncResult?.push?.rejected ?? null,
                batches: listingSyncResult?.push?.batches ?? null
            });
            await logServiceEvent({
                service: "ETSY_ADS_FULL_IMPORT",
                logType: "task_completed",
                message: "ETSY_ADS_FULL_IMPORT listings sync phase completed",
                mongoShopId,
                taskId,
                taskType,
                rawData: {
                    totalListings: listingSyncResult?.totalListings ?? null,
                    ...summarizeListingPush(listingSyncResult?.push)
                }
            });
        }

        sendSocketTaskLog("ETSY_ADS_FULL_IMPORT: Import ads start", {
            date,
            mongoShopId,
            filterMode,
            dryRun
        });
        await logServiceEvent({
            service: "ETSY_ADS_FULL_IMPORT",
            logType: "task_processing",
            message: "ETSY_ADS_FULL_IMPORT ads import phase started",
            mongoShopId,
            taskId,
            taskType,
            rawData: {
                date,
                filterMode,
                dryRun
            }
        });

        adsResult = await handleEtsyAdsImportDay({
            date,
            mongoShopId,
            etsyAdsBackendUrl,
            queryDateOffsetDays: 0,
            autoResolveOverviewDate: false,
            allowListingFallback,
            filterMode,
            dryRun,
            debugComparePromotedParam,
            debugCompareDateOffset,
            debugCompareMaxPages,
            taskId,
            taskType: "ETSY_ADS"
        });

        const adsPushBody = adsResult?.push?.body || {};

        console.log("[LNG][sw][ETSY_ADS_FULL_IMPORT][ADS_DONE]", {
            rows: adsResult?.rows ?? null,
            totalSpend: adsResult?.totalSpend ?? null,
            fromOrdersFallback: adsPushBody?.fromOrdersFallback ?? null,
            fromListingMaster: adsPushBody?.fromListingMaster ?? null,
            missing: adsPushBody?.missing ?? null,
            docId: adsPushBody?.docId ?? null
        });

        sendSocketTaskLog("ETSY_ADS_FULL_IMPORT: Import ads done", {
            rows: adsResult?.rows ?? null,
            totalSpend: adsResult?.totalSpend ?? null,
            fromOrdersFallback: adsPushBody?.fromOrdersFallback ?? null,
            fromListingMaster: adsPushBody?.fromListingMaster ?? null,
            missing: adsPushBody?.missing ?? null,
            docId: adsPushBody?.docId ?? null
        });
        await logServiceEvent({
            service: "ETSY_ADS_FULL_IMPORT",
            logType: "task_completed",
            message: "ETSY_ADS_FULL_IMPORT ads import phase completed",
            mongoShopId,
            taskId,
            taskType,
            rawData: {
                rows: adsResult?.rows ?? null,
                totalSpend: adsResult?.totalSpend ?? null,
                push: summarizeAdsPush(adsResult?.push)
            }
        });

        const summary = {
            ok: true,
            type: "ETSY_ADS_FULL_IMPORT",
            date,
            mongoShopId,
            listingSyncMode,
            listingSync: {
                skipped: listingSyncMode === "skip",
                totalListings: listingSyncResult?.totalListings ?? null,
                accepted: listingSyncResult?.push?.accepted ?? null,
                rejected: listingSyncResult?.push?.rejected ?? null,
                upserted: listingSyncResult?.push?.upserted ?? null,
                modified: listingSyncResult?.push?.modified ?? null,
                matched: listingSyncResult?.push?.matched ?? null,
                batches: listingSyncResult?.push?.batches ?? null
            },
            ads: {
                rows: adsResult?.rows ?? null,
                totalSpend: adsResult?.totalSpend ?? null,
                push: adsResult?.push ?? null,
                skuEnrich: {
                    rowsCount: adsPushBody?.rowsCount ?? null,
                    rowsAccepted: adsPushBody?.rowsAccepted ?? null,
                    rowsRejected: adsPushBody?.rowsRejected ?? null,
                    fromAdsRow: adsPushBody?.fromAdsRow ?? null,
                    fromOrdersFallback: adsPushBody?.fromOrdersFallback ?? null,
                    fromListingMaster: adsPushBody?.fromListingMaster ?? null,
                    missing: adsPushBody?.missing ?? null,
                    totalsSource: adsPushBody?.totalsSource ?? null,
                    docId: adsPushBody?.docId ?? null
                }
            }
        };

        console.log("[LNG][sw][ETSY_ADS_FULL_IMPORT][DONE]", summary);
        await logServiceEvent({
            service: "ETSY_ADS_FULL_IMPORT",
            logType: "task_completed",
            message: "ETSY_ADS_FULL_IMPORT final summary",
            mongoShopId,
            taskId,
            taskType,
            rawData: {
                date,
                listingSync: summary.listingSync,
                ads: {
                    rows: summary.ads.rows,
                    totalSpend: summary.ads.totalSpend,
                    skuEnrich: summary.ads.skuEnrich
                }
            }
        });

        return summary;
    })();

    etsyAdsFullImportLocks.set(lockKey, job);

    try {
        return await job;
    } finally {
        etsyAdsFullImportLocks.delete(lockKey);
    }
}

function deriveEtsyListingSyncUrl(backendUrl) {
    const fallback = "https://api.lngmerch.co/api/etsy-listing/sync";

    try {
        const url = new URL(backendUrl || CONFIG.DEFAULT_BACKEND_URL);
        return `${url.origin}/api/etsy-listing/sync`;
    } catch (error) {
        console.warn("[LNG][sw][ETSY_LISTINGS] cannot derive sync endpoint", {
            backendUrl,
            message: error?.message || String(error)
        });
        return fallback;
    }
}

function chunkArray(array, size) {
    const chunks = [];
    const safeSize = Math.max(1, Number(size) || 1);

    for (let i = 0; i < (array || []).length; i += safeSize) {
        chunks.push(array.slice(i, i + safeSize));
    }

    return chunks;
}

async function pushEtsyListingsToBackendInBatches(endpoint, payload, batchSize, context = {}) {
    const listings = Array.isArray(payload.listings) ? payload.listings : [];
    const batches = chunkArray(listings, batchSize);
    const results = [];
    const mongoShopId = String(payload.shopId || "").trim();
    const taskId = String(context.taskId || `sync_etsy_listings:${mongoShopId}:${Date.now()}`).trim();
    const taskType = String(context.taskType || "SYNC_ETSY_LISTINGS").trim();

    let received = 0;
    let accepted = 0;
    let rejected = 0;
    let upserted = 0;
    let modified = 0;
    let matched = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const batchPayload = {
            shopId: payload.shopId,
            etsyShopId: payload.etsyShopId,
            shopName: payload.shopName,
            listings: batch,
            syncedAt: new Date().toISOString(),
            source: "etsy_listing_search",
            batch: {
                index: batchIndex + 1,
                total: batches.length,
                size: batch.length,
                totalListings: listings.length
            }
        };

        console.log("[LNG][sw][ETSY_LISTINGS][POST_BATCH]", {
            endpoint,
            batchIndex: batchIndex + 1,
            batchTotal: batches.length,
            batchSize,
            listingsCount: batch.length,
            firstListing: batch[0] ? {
                listingId: batch[0].listingId,
                sku: batch[0].sku,
                title: String(batch[0].title || "").slice(0, 120)
            } : null
        });
        await logServiceEvent({
            service: "SYNC_ETSY_LISTINGS",
            logType: "task_processing",
            message: `SYNC_ETSY_LISTINGS batch ${batchIndex + 1}/${batches.length} started`,
            mongoShopId,
            taskId,
            taskType,
            rawData: {
                batchIndex: batchIndex + 1,
                batchTotal: batches.length,
                batchSize,
                listingsCount: batch.length
            }
        });

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(batchPayload)
        }).catch(async (error) => {
            await logServiceEvent({
                service: "SYNC_ETSY_LISTINGS",
                logType: "task_failed",
                level: "error",
                message: `SYNC_ETSY_LISTINGS batch ${batchIndex + 1}/${batches.length} failed`,
                mongoShopId,
                taskId,
                taskType,
                rawData: {
                    batchIndex: batchIndex + 1,
                    batchTotal: batches.length,
                    batchSize,
                    listingsCount: batch.length
                },
                error
            });

            throw error;
        });

        const text = await response.text();
        let body = null;

        try {
            body = JSON.parse(text);
        } catch (_) {
            body = { raw: text };
        }

        console.log("[LNG][sw][ETSY_LISTINGS][POST_BATCH_RESPONSE]", {
            batchIndex: batchIndex + 1,
            status: response.status,
            ok: response.ok,
            body
        });

        if (!response.ok) {
            await logServiceEvent({
                service: "SYNC_ETSY_LISTINGS",
                logType: "task_failed",
                level: "error",
                message: `SYNC_ETSY_LISTINGS batch ${batchIndex + 1}/${batches.length} failed`,
                mongoShopId,
                taskId,
                taskType,
                rawData: {
                    batchIndex: batchIndex + 1,
                    status: response.status,
                    ok: response.ok,
                    accepted: getNumericResponseField(body, "accepted", 0),
                    rejected: getNumericResponseField(body, "rejected", 0),
                    upserted: getNumericResponseField(body, "upserted", 0),
                    modified: getNumericResponseField(body, "modified", 0),
                    matched: getNumericResponseField(body, "matched", 0)
                }
            });
            throw new Error(`Backend Etsy listings sync batch ${batchIndex + 1}/${batches.length} failed ${response.status}: ${text.slice(0, 500)}`);
        }

        const result = {
            batchIndex: batchIndex + 1,
            status: response.status,
            body
        };

        results.push(result);
        received += getNumericResponseField(body, "received", batch.length);
        accepted += getNumericResponseField(body, "accepted", batch.length);
        rejected += getNumericResponseField(body, "rejected", 0);
        upserted += getNumericResponseField(body, "upserted", 0);
        modified += getNumericResponseField(body, "modified", 0);
        matched += getNumericResponseField(body, "matched", 0);

        await logServiceEvent({
            service: "SYNC_ETSY_LISTINGS",
            logType: "task_completed",
            message: `SYNC_ETSY_LISTINGS batch ${batchIndex + 1}/${batches.length} completed`,
            mongoShopId,
            taskId,
            taskType,
            rawData: {
                batchIndex: batchIndex + 1,
                status: response.status,
                ok: response.ok,
                accepted: getNumericResponseField(body, "accepted", batch.length),
                rejected: getNumericResponseField(body, "rejected", 0),
                upserted: getNumericResponseField(body, "upserted", 0),
                modified: getNumericResponseField(body, "modified", 0),
                matched: getNumericResponseField(body, "matched", 0)
            }
        });
    }

    const summary = {
        batches: batches.length,
        totalListings: listings.length,
        received,
        accepted,
        rejected,
        upserted,
        modified,
        matched,
        results
    };

    console.log("[LNG][sw][ETSY_LISTINGS][POST_BATCH_SUMMARY]", {
        totalListings: summary.totalListings,
        batchSize,
        batches: summary.batches,
        accepted: summary.accepted,
        rejected: summary.rejected,
        upserted: summary.upserted,
        modified: summary.modified,
        matched: summary.matched
    });

    return summary;
}

function getNumericResponseField(body, key, fallback = 0) {
    const value = Number(
        body?.[key] ??
        body?.summary?.[key] ??
        body?.data?.[key] ??
        body?.result?.[key] ??
        fallback
    );

    return Number.isFinite(value) ? value : fallback;
}

async function handleUploadTrackingToEtsy(payload) {
    const orderId = normalizeEtsyOrderId(payload.orderId);
    const trackingNumber = String(payload.trackingNumber || "").trim();
    const carrier = normalizeEtsyCarrierName(payload.carrier || payload.carrierCode || payload.shippingCarrier) ||
        inferEtsyTrackingCarrier(trackingNumber);

    if (!orderId) {
        throw new Error("Thiếu Etsy Order ID");
    }

    if (!trackingNumber) {
        throw new Error("Thiếu Tracking Number");
    }

    console.log("[LNG][sw] handleUploadTrackingToEtsy start", {
        orderId,
        trackingNumber,
        carrier
    });
    sendSocketTaskLog("ETSY_UPLOAD_TRACKING carrier inferred", {
        orderId,
        trackingNumberLast4: trackingNumber.slice(-4),
        carrier
    });

    const tab = await ensureEtsySoldOrdersTab();

    console.log("[LNG][sw] Etsy tab ready for upload tracking", {
        tabId: tab.id,
        url: tab.url
    });

    await injectContentScript(tab.id);

    const contentResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "CONTENT_ETSY_UPLOAD_TRACKING",
        payload: {
            orderId,
            trackingNumber,
            carrier
        }
    });

    if (!contentResponse?.ok) {
        throw new Error(contentResponse?.message || "Content upload tracking failed");
    }

    return contentResponse.data;
}

function normalizeEtsyOrderId(value) {
    const raw = String(value || "").trim();

    if (!raw) return "";

    // Nếu BE có dạng replacement/reship kiểu 1234567890_RE hoặc 1234567890_RE_1
    // thì Etsy vẫn cần order id gốc.
    if (raw.includes("_")) {
        return raw.split("_")[0].trim();
    }

    return raw;
}

async function pushOrdersToBackend(orders, backendUrl) {
    console.log("[LNG][sw] pushOrdersToBackend ->", { url: backendUrl, count: orders.length });

    console.log("[ETSY_ORDER_IMPORT][SKU_INCOMING]", {
        ordersCount: Array.isArray(orders) ? orders.length : 0,
        skuAudit: (orders || []).flatMap((order) =>
            (order.items || []).map((item) => ({
                orderId: order.orderId,
                transactionId: item.transactionId,
                listingId: item.listingId,
                itemName: String(item.itemName || "").slice(0, 80),
                sku: item.sku || "",
                hasSku: !!item.sku
            }))
        )
    });

    const created = [];
    const duplicated = [];
    const backfilled = [];
    const failed = [];
    let skuBackfilled = 0;
    let listingIdBackfilled = 0;

    let i = 0;
    for (const order of orders) {
        i++;
        const tag = `[${i}/${orders.length}] ${order.orderId}`;

        try {
            const postItemsAudit = (order.items || []).map((item) => ({
                transactionId: item.transactionId,
                listingId: item.listingId,
                sku: item.sku || "",
                hasListingId: !!item.listingId,
                hasSku: !!item.sku,
                itemName: String(item.itemName || "").slice(0, 80)
            }));
            const missingSkuItems = postItemsAudit.filter((item) => !item.hasSku);
            const missingListingIdItems = postItemsAudit.filter((item) => !item.hasListingId);

            console.log("[ETSY_ORDER_IMPORT][SKU_BEFORE_SAVE]", {
                orderId: order.orderId,
                items: postItemsAudit
            });

            console.log("[ETSY_ORDER_IMPORT][BEFORE_POST_SKU_LISTING_AUDIT]", {
                orderId: order.orderId,
                items: postItemsAudit,
                missingSkuCount: missingSkuItems.length,
                missingListingIdCount: missingListingIdItems.length,
                missingSkuItems: missingSkuItems.slice(0, 20),
                missingListingIdItems: missingListingIdItems.slice(0, 20)
            });

            const response = await fetch(backendUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(order)
            });

            const body = await response.json().catch(() => null);
            const savedOrder = body?.order || body?.data || body;

            if (savedOrder && typeof savedOrder === "object") {
                console.log("[ETSY_ORDER_IMPORT][SKU_SAVED_DOC]", {
                    orderId: savedOrder.orderId || order.orderId,
                    items: (savedOrder.items || []).map((item) => ({
                        transactionId: item.transactionId,
                        listingId: item.listingId,
                        itemName: String(item.itemName || "").slice(0, 80),
                        sku: item.sku || "",
                        hasSku: !!item.sku
                    }))
                });
            }

            if (response.status === 201) {
                created.push({ orderId: order.orderId, _id: body?._id });
                console.log(`[LNG][sw][PUSH] ${tag} 201 created`, body?._id);
            } else if (response.status === 200 && body?.duplicated === true) {
                const duplicateResult = {
                    orderId: body?.orderId || order.orderId,
                    _id: body?._id,
                    duplicated: true,
                    backfilled: body?.backfilled === true,
                    updatedItems: Number(body?.updatedItems || 0),
                    addedItems: Number(body?.addedItems || 0),
                    skuBackfilled: Number(body?.skuBackfilled || 0),
                    listingIdBackfilled: Number(body?.listingIdBackfilled || 0)
                };

                duplicated.push(duplicateResult);

                if (duplicateResult.backfilled) {
                    backfilled.push(duplicateResult);
                }

                skuBackfilled += duplicateResult.skuBackfilled;
                listingIdBackfilled += duplicateResult.listingIdBackfilled;

                console.log("[ETSY_ORDER_IMPORT][BACKFILL_RESPONSE]", {
                    orderId: duplicateResult.orderId,
                    backfilled: duplicateResult.backfilled,
                    updatedItems: duplicateResult.updatedItems,
                    addedItems: duplicateResult.addedItems,
                    skuBackfilled: duplicateResult.skuBackfilled,
                    listingIdBackfilled: duplicateResult.listingIdBackfilled
                });
                console.log(`[LNG][sw][PUSH] ${tag} 200 duplicated`, duplicateResult);
            } else if (response.status === 409) {
                duplicated.push({ orderId: order.orderId, _id: body?._id });
                console.warn(`[LNG][sw][PUSH] ${tag} 409 duplicated`, body?.message);
            } else if (response.status === 400) {
                failed.push({
                    orderId: order.orderId,
                    status: 400,
                    message: body?.message,
                    errors: body?.errors
                });
                console.error(`[LNG][sw][PUSH] ${tag} 400 bad request`, body);
            } else {
                failed.push({
                    orderId: order.orderId,
                    status: response.status,
                    message: body?.message || `HTTP ${response.status}`
                });
                console.error(`[LNG][sw][PUSH] ${tag} ${response.status}`, body);
            }
        } catch (error) {
            failed.push({ orderId: order.orderId, message: error.message });
            console.error(`[LNG][sw][PUSH] ${tag} network error`, error);
        }
    }

    const summary = {
        total: orders.length,
        created: created.length,
        duplicated: duplicated.length,
        backfilled: backfilled.length,
        skuBackfilled,
        listingIdBackfilled,
        failed: failed.length,
        samples: {
            created: created.slice(0, 3),
            duplicated: duplicated.slice(0, 3),
            backfilled: backfilled.slice(0, 3),
            failed: failed.slice(0, 3)
        }
    };

    console.log("[LNG][sw][PUSH] summary", summary);
    return summary;
}

async function ensureEtsySoldOrdersTab() {
    const tabs = await chrome.tabs.query({ url: "https://www.etsy.com/*" });
    console.log("[LNG][sw] etsy tabs found", tabs.length);

    return ensurePageTabReady({
        tabsApi: chrome.tabs,
        queryUrl: "https://www.etsy.com/*",
        targetUrl: CONFIG.ETSY_SOLD_URL,
        isTargetTab: (tab) => Boolean(tab?.url && tab.url.includes("/your/orders/sold")),
        timeoutMs: ETSY_TAB_READY_TIMEOUT_MS,
        label: "Etsy tab",
        logger: console,
        initialTabs: tabs
    });
}

async function ensureEtsyTargetOrderDetailTab(targetOrderId) {
    const safeTargetOrderId = String(targetOrderId || "").trim();
    if (!safeTargetOrderId) {
        throw new Error("Missing targetOrderId for Etsy order detail tab");
    }

    const primaryUrl = `https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav&order_id=${encodeURIComponent(safeTargetOrderId)}`;
    const fallbackUrl = `https://www.etsy.com/your/orders/${encodeURIComponent(safeTargetOrderId)}`;
    const tabs = await chrome.tabs.query({ url: "https://www.etsy.com/*" });
    const existing = tabs.find((tab) => {
        const url = String(tab.url || "");
        return url.includes(`/your/orders/sold`) &&
            url.includes(`order_id=${safeTargetOrderId}`);
    }) || tabs.find((tab) => String(tab.url || "").includes(`/your/orders/${safeTargetOrderId}`));

    const tab = existing
        ? await chrome.tabs.update(existing.id, { active: true, url: primaryUrl })
        : await chrome.tabs.create({ active: true, url: primaryUrl });

    try {
        await waitForTabComplete(tab.id);
        return await chrome.tabs.get(tab.id);
    } catch (error) {
        console.warn("[LNG][sw][CUSTOM_FILE_DOM_DETAIL] primary detail tab failed, fallback", {
            targetOrderId: safeTargetOrderId,
            message: error?.message || String(error)
        });
        const fallbackTab = await chrome.tabs.update(tab.id, {
            active: true,
            url: fallbackUrl
        });
        await waitForTabComplete(fallbackTab.id);
        return await chrome.tabs.get(fallbackTab.id);
    }
}

async function scanTargetOrderDomCustomFiles({ targetOrderId, waitMs = 3000 }) {
    const tab = await ensureEtsyTargetOrderDetailTab(targetOrderId);
    await injectContentScript(tab.id);

    const response = await sendMessageToTabWithRetry(tab.id, {
        action: "CONTENT_ETSY_SCAN_ORDER_DETAIL_DOM_CUSTOM_FILES",
        payload: {
            targetOrderId,
            waitMs
        }
    }, {
        attempts: 3,
        delayMs: 800
    });

    if (!response?.ok) {
        throw new Error(response?.message || "Etsy DOM detail custom file scan failed");
    }

    console.log("[LNG][sw][CUSTOM_FILE_DOM_DETAIL][SCAN_RESULT]", {
        targetOrderId,
        files: (response.data?.customFiles || []).map(maskCustomFileForServiceLog)
    });

    return response.data || {};
}

function maskUrlForServiceLog(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";

    try {
        const parsed = new URL(raw);
        parsed.search = parsed.search ? "?..." : "";
        parsed.hash = parsed.hash ? "#..." : "";
        return parsed.toString();
    } catch (_) {
        return raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
    }
}

function maskCustomFileForServiceLog(file = {}) {
    return {
        ...file,
        downloadUrl: file.downloadUrl ? "[masked]" : "",
        previewUrl: file.previewUrl ? "[masked]" : "",
        storageUrl: file.storageUrl ? "[masked]" : "",
        downloadUrlMasked: maskUrlForServiceLog(file.downloadUrl),
        previewUrlMasked: maskUrlForServiceLog(file.previewUrl),
        storageUrlMasked: maskUrlForServiceLog(file.storageUrl)
    };
}

function getCustomerUploadSignalFieldsInItem(item = {}) {
    const fields = [];
    const uploadNamePattern = /(upload|uploaded|photo|image|picture|file|attachment|personalization file|logo|logos|artwork|art|design|graphic|school logo|college logo|team logo|brand logo)/i;
    const strongUploadValuePattern = /(^|\b)\d+\s*files?\b|(^|\b)files?\b|uploaded|attached/i;
    const shortUploadLabelPattern = /(logo|logos|artwork|design|graphic|photo|image|picture)/i;
    const ordinaryVariantNamePattern = /^(size|color|colour|quantity|quanity|qty|pack|select size|select pack|style|product type|shape)$/i;

    const addField = (name, value, source) => {
        const safeName = String(name || "").trim();
        const safeValue = String(value || "").trim();
        if (!safeName && !safeValue) return;

        const nameLooksLikeUpload = uploadNamePattern.test(safeName);
        const valueLooksLikeUpload = strongUploadValuePattern.test(safeValue);
        const isOrdinaryVariant = ordinaryVariantNamePattern.test(safeName);

        if (valueLooksLikeUpload && nameLooksLikeUpload && !isOrdinaryVariant) {
            fields.push({
                name: safeName,
                value: safeValue,
                source
            });
            return;
        }

        if (valueLooksLikeUpload && !isOrdinaryVariant && shortUploadLabelPattern.test(safeName)) {
            fields.push({
                name: safeName,
                value: safeValue,
                source
            });
        }
    };

    for (const [name, value] of Object.entries(item.variations || {})) {
        addField(name, value, "variations");
    }

    for (const field of item.customizations?.textFields || []) {
        addField(field?.name, field?.value, field?.source || "customizations.textFields");
    }

    const variationsRaw = String(item.variationsRaw || "").trim();
    if (variationsRaw) {
        try {
            const parsed = JSON.parse(variationsRaw);
            for (const field of Array.isArray(parsed) ? parsed : []) {
                addField(
                    field?.formatted_name || field?.property || field?.name,
                    field?.formatted_value || field?.value,
                    "variationsRaw"
                );
            }
        } catch (_) {
            const uploadRawMatch = /(upload|uploaded|photo|image|picture|file|attachment|personalization file|logo|logos|artwork|art|design|graphic)[^,\n\r:]*[:=]\s*([^,\n\r]+)/i.exec(variationsRaw);
            if (uploadRawMatch) {
                addField(uploadRawMatch[1], uploadRawMatch[2], "variationsRaw");
            }
        }
    }

    const seen = new Set();
    return fields.filter((field) => {
        const key = `${field.name}|${field.value}|${field.source}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function hasCustomerUploadSignalInItem(item = {}) {
    return getCustomerUploadSignalFieldsInItem(item).length > 0;
}

function itemAlreadyHasDomCustomFile(item = {}) {
    return (Array.isArray(item.customFiles) ? item.customFiles : []).some((file) =>
        String(file?.source || "") === "etsy_order_detail_dom" ||
        String(file?.downloadUrl || "").includes("/ipf/") ||
        String(file?.previewUrl || "").includes("/ipf/")
    );
}

function findOrdersNeedingDomCustomFileScan(backendOrders = [], options = {}) {
    const forceDomCustomFileScan = options.forceDomCustomFileScan === true;
    const candidates = [];
    const seenOrders = new Set();

    for (const order of Array.isArray(backendOrders) ? backendOrders : []) {
        const orderId = String(order?.orderId || "").trim();
        if (!orderId || seenOrders.has(orderId)) continue;

        const items = Array.isArray(order?.items) ? order.items : [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            const item = items[itemIndex] || {};
            const uploadFields = getCustomerUploadSignalFieldsInItem(item);
            if (!uploadFields.length) continue;
            if (!forceDomCustomFileScan && itemAlreadyHasDomCustomFile(item)) continue;

            console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][UPLOAD_SIGNAL_FIELD]", {
                orderId,
                transactionId: item.transactionId,
                listingId: item.listingId,
                sku: item.sku,
                uploadFields
            });

            seenOrders.add(orderId);
            candidates.push({
                orderId,
                itemIndex,
                transactionId: String(item.transactionId || ""),
                listingId: String(item.listingId || ""),
                sku: String(item.sku || ""),
                reason: "customization_upload_signal",
                uploadFields
            });
            break;
        }
    }

    return candidates;
}

async function runAutoUploadDomDetailScan({
    backendOrders,
    maxAutoDomDetailOrders = 10,
    forceDomCustomFileScan = false,
    waitMs = 3000
} = {}) {
    const candidates = findOrdersNeedingDomCustomFileScan(backendOrders, {
        forceDomCustomFileScan
    });
    const safeLimit = Math.max(0, Number.isFinite(Number(maxAutoDomDetailOrders)) ? Number(maxAutoDomDetailOrders) : 10);
    const limitedCandidates = candidates.slice(0, safeLimit);
    const summary = {
        scannedOrders: 0,
        filesMerged: 0,
        skippedOrders: Math.max(0, candidates.length - limitedCandidates.length),
        failedScans: 0
    };

    console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][DETECTED]", {
        totalOrders: Array.isArray(backendOrders) ? backendOrders.length : 0,
        detectedOrders: candidates.length,
        detectedItems: candidates.length,
        maxAutoDomDetailOrders: safeLimit,
        candidatesSample: candidates.slice(0, 10).map((candidate) => ({
            ...candidate,
            uploadFields: candidate.uploadFields?.slice(0, 3)
        }))
    });

    for (const candidate of limitedCandidates) {
        console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][SCAN_START]", {
            orderId: candidate.orderId,
            transactionId: candidate.transactionId,
            listingId: candidate.listingId,
            reason: candidate.reason
        });

        try {
            const scanResult = await scanTargetOrderDomCustomFiles({
                targetOrderId: candidate.orderId,
                waitMs
            });
            const files = Array.isArray(scanResult?.customFiles) ? scanResult.customFiles : [];

            console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][SCAN_RESULT]", {
                orderId: candidate.orderId,
                filesFound: files.length
            });

            const mergeResult = mergeDomCustomFilesIntoBackendOrders(backendOrders, candidate, files);
            summary.scannedOrders += 1;
            summary.filesMerged += mergeResult.addedFiles || 0;
        } catch (error) {
            summary.failedScans += 1;
            console.warn("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][SCAN_ERROR]", {
                orderId: candidate.orderId,
                transactionId: candidate.transactionId,
                listingId: candidate.listingId,
                message: error?.message || String(error)
            });
        }
    }

    console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][FINAL_SUMMARY]", summary);
    return summary;
}

function mergeDomCustomFilesIntoBackendOrders(backendOrders, scanCandidate = {}, scanFiles = []) {
    const orderId = String(scanCandidate.orderId || "").trim();
    const order = (Array.isArray(backendOrders) ? backendOrders : []).find((candidate) =>
        String(candidate?.orderId || "") === orderId
    );
    const files = Array.isArray(scanFiles) ? scanFiles : [];

    if (!order || !files.length) {
        console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][MERGED]", {
            orderId,
            transactionId: scanCandidate.transactionId || "",
            listingId: scanCandidate.listingId || "",
            addedFiles: 0,
            totalItemCustomFiles: 0
        });
        return {
            addedFiles: 0,
            totalItemCustomFiles: 0
        };
    }

    const items = Array.isArray(order.items) ? order.items : [];
    let targetItem = items.find((item) =>
        scanCandidate.transactionId && String(item.transactionId || "") === String(scanCandidate.transactionId)
    );
    if (!targetItem) {
        targetItem = items.find((item) =>
            scanCandidate.listingId && String(item.listingId || "") === String(scanCandidate.listingId)
        );
    }
    if (!targetItem && Number.isInteger(Number(scanCandidate.itemIndex))) {
        targetItem = items[Number(scanCandidate.itemIndex)];
    }
    if (!targetItem) {
        targetItem = items[0];
    }
    if (!targetItem) {
        return {
            addedFiles: 0,
            totalItemCustomFiles: 0
        };
    }

    const existingFiles = Array.isArray(targetItem.customFiles) ? targetItem.customFiles : [];
    const merged = [...existingFiles];
    const seen = new Set(existingFiles.map((file) =>
        file.downloadUrl || file.previewUrl || `${file.fileName || ""}:${file.transactionId || ""}`
    ));
    let addedFiles = 0;

    for (const file of files) {
        const nextFile = {
            ...file,
            source: "etsy_order_detail_dom",
            transactionId: file.transactionId || String(targetItem.transactionId || ""),
            listingId: file.listingId || String(targetItem.listingId || ""),
            status: file.status || "pending_download"
        };
        const key = nextFile.downloadUrl || nextFile.previewUrl || `${nextFile.fileName || ""}:${nextFile.transactionId || ""}`;
        if (!key || seen.has(key)) continue;

        const existingWithStorage = existingFiles.find((existing) =>
            existing?.storageUrl &&
            (
                existing.downloadUrl === nextFile.downloadUrl ||
                existing.previewUrl === nextFile.previewUrl ||
                `${existing.fileName || ""}:${existing.transactionId || ""}` === `${nextFile.fileName || ""}:${nextFile.transactionId || ""}`
            )
        );
        if (existingWithStorage) continue;

        seen.add(key);
        merged.push(nextFile);
        addedFiles += 1;
    }

    targetItem.customFiles = merged;

    console.log("[LNG][sw][CUSTOM_FILE_AUTO_DETAIL][MERGED]", {
        orderId,
        transactionId: targetItem.transactionId,
        listingId: targetItem.listingId,
        addedFiles,
        totalItemCustomFiles: targetItem.customFiles.length,
        files: targetItem.customFiles.map(maskCustomFileForServiceLog)
    });

    return {
        addedFiles,
        totalItemCustomFiles: targetItem.customFiles.length
    };
}

function mergeDomCustomFilesIntoTargetOrder(backendOrders, customFiles, ctx = {}) {
    const targetOrderId = String(ctx.targetOrderId || "").trim();
    const files = Array.isArray(customFiles) ? customFiles : [];
    const order = (Array.isArray(backendOrders) ? backendOrders : []).find((candidate) =>
        !targetOrderId || String(candidate?.orderId || "") === targetOrderId
    );

    if (!order || !files.length) {
        console.log("[LNG][sw][CUSTOM_FILE_DOM_DETAIL][MERGE_SKIPPED]", {
            targetOrderId,
            hasOrder: Boolean(order),
            files: files.length
        });
        return;
    }

    const items = Array.isArray(order.items) ? order.items : [];
    let targetItem = items.find((item) =>
        ctx.transactionId && String(item.transactionId || "") === String(ctx.transactionId)
    );
    if (!targetItem) {
        targetItem = items.find((item) =>
            ctx.listingId && String(item.listingId || "") === String(ctx.listingId)
        );
    }
    if (!targetItem) {
        targetItem = items[0];
    }
    if (!targetItem) return;

    const existing = Array.isArray(targetItem.customFiles) ? targetItem.customFiles : [];
    const merged = [...existing];
    const seen = new Set(existing.map((file) =>
        file.etsyFileId || file.downloadUrl || file.previewUrl || `${file.transactionId || ""}:${file.fileName || ""}`
    ));

    for (const file of files) {
        const nextFile = {
            ...file,
            transactionId: file.transactionId || String(targetItem.transactionId || ""),
            listingId: file.listingId || String(targetItem.listingId || ""),
            matchConfidence: file.matchConfidence || "high",
            status: file.status || "pending_download"
        };
        const key = nextFile.etsyFileId || nextFile.downloadUrl || nextFile.previewUrl || `${nextFile.transactionId || ""}:${nextFile.fileName || ""}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(nextFile);
    }

    targetItem.customFiles = merged;

    console.log("[LNG][sw][CUSTOM_FILE_DOM_DETAIL][MERGED]", {
        targetOrderId,
        transactionId: targetItem.transactionId,
        listingId: targetItem.listingId,
        addedFiles: files.length,
        totalItemCustomFiles: targetItem.customFiles.length,
        files: targetItem.customFiles.map(maskCustomFileForServiceLog)
    });
}

function buildCustomFileSummary(backendOrders) {
    const items = (Array.isArray(backendOrders) ? backendOrders : [])
        .flatMap((order) => Array.isArray(order.items) ? order.items : []);

    return {
        totalItems: items.length,
        itemsWithCustomText: items.filter((item) =>
            Array.isArray(item.customizations?.textFields) && item.customizations.textFields.length > 0
        ).length,
        itemsWithCustomFiles: items.filter((item) =>
            Array.isArray(item.customFiles) && item.customFiles.length > 0
        ).length,
        totalCustomFiles: items.reduce((sum, item) =>
            sum + (Array.isArray(item.customFiles) ? item.customFiles.length : 0),
            0
        )
    };
}

async function ensureEtsyMessagesTab() {
    const tabs = await chrome.tabs.query({ url: "https://www.etsy.com/*" });
    console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] etsy tabs found", tabs.length);

    const messagesTab = tabs.find((tab) => String(tab.url || "").includes("/messages"));
    if (messagesTab) {
        const currentUrl = String(messagesTab.url || "");

        console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] reuse messages tab", {
            tabId: messagesTab.id,
            url: currentUrl,
            status: messagesTab.status
        });

        if (messagesTab.status !== "complete") {
            await waitForTabComplete(messagesTab.id);
        }

        const normalizedMessagesUrl = CONFIG.ETSY_MESSAGES_URL.replace(/\/+$/, "");
        const isInboxRoot =
            currentUrl === normalizedMessagesUrl ||
            currentUrl === `${normalizedMessagesUrl}/` ||
            currentUrl.includes("/messages?");

        if (!isInboxRoot) {
            console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] navigate messages tab to inbox root", {
                tabId: messagesTab.id,
                from: currentUrl,
                to: CONFIG.ETSY_MESSAGES_URL
            });

            await chrome.tabs.update(messagesTab.id, {
                active: true,
                url: CONFIG.ETSY_MESSAGES_URL
            });

            await waitForTabComplete(messagesTab.id);
        }

        return await chrome.tabs.get(messagesTab.id);
    }

    console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] open new messages tab");
    const newTab = await chrome.tabs.create({
        active: true,
        url: CONFIG.ETSY_MESSAGES_URL
    });
    await waitForTabComplete(newTab.id);
    return await chrome.tabs.get(newTab.id);
}

async function startEtsyMessageMonitorAlarm() {
    if (ETSY_MESSAGE_MONITOR_AUTO_ENABLED !== true) {
        await chrome.alarms.clear(ETSY_MESSAGE_MONITOR_ALARM);

        console.log("[LNG][sw][ETSY_MESSAGE_MONITOR] auto disabled, alarm cleared", {
            name: ETSY_MESSAGE_MONITOR_ALARM
        });

        return {
            ok: true,
            disabled: true,
            alarmCleared: true,
            name: ETSY_MESSAGE_MONITOR_ALARM
        };
    }

    const existing = await chrome.alarms.get(ETSY_MESSAGE_MONITOR_ALARM);

    if (existing && Number(existing.periodInMinutes) === ETSY_MESSAGE_MONITOR_PERIOD_MINUTES) {
        console.log("[LNG][sw][ETSY_MESSAGE_MONITOR] alarm unchanged", existing);
        return {
            ok: true,
            unchanged: true,
            name: ETSY_MESSAGE_MONITOR_ALARM
        };
    }

    await chrome.alarms.create(ETSY_MESSAGE_MONITOR_ALARM, {
        delayInMinutes: ETSY_MESSAGE_MONITOR_PERIOD_MINUTES,
        periodInMinutes: ETSY_MESSAGE_MONITOR_PERIOD_MINUTES
    });

    console.log("[LNG][sw][ETSY_MESSAGE_MONITOR] alarm created", {
        name: ETSY_MESSAGE_MONITOR_ALARM,
        minutes: ETSY_MESSAGE_MONITOR_PERIOD_MINUTES
    });

    return {
        ok: true,
        created: true,
        name: ETSY_MESSAGE_MONITOR_ALARM
    };
}

function buildEtsyMessageFingerprint(thread) {
    return [
        String(thread?.threadId || ""),
        String(thread?.latestMessagePreview || thread?.latestMessageBody || "")
    ].join("|");
}

function detectNewEtsyMessages(previousSnapshot = {}, threads = []) {
    const previousByThreadId = previousSnapshot?.byThreadId || {};
    const newMessages = [];

    for (const thread of Array.isArray(threads) ? threads : []) {
        const threadId = String(thread?.threadId || "").trim();
        if (!threadId) continue;

        const currentFingerprint = buildEtsyMessageFingerprint(thread);
        const previous = previousByThreadId[threadId];

        if (!previous) {
            newMessages.push({
                reason: "new_thread",
                thread
            });
            continue;
        }

        if (previous.fingerprint !== currentFingerprint) {
            newMessages.push({
                reason: "new_or_changed_latest_message",
                thread,
                previous: {
                    latestMessagePreview: previous.latestMessagePreview || "",
                    lastMessageAt: previous.lastMessageAt || ""
                }
            });
        }
    }

    return newMessages;
}

function buildEtsyMessageSnapshot(threads = []) {
    const byThreadId = {};

    for (const thread of Array.isArray(threads) ? threads : []) {
        const threadId = String(thread?.threadId || "").trim();
        if (!threadId) continue;

        byThreadId[threadId] = {
            threadId,
            fingerprint: buildEtsyMessageFingerprint(thread),
            buyerName: thread?.buyerName || "",
            orderId: thread?.orderId || "",
            unread: thread?.unread === true,
            lastMessageAt: thread?.lastMessageAt || "",
            latestMessagePreview: thread?.latestMessagePreview || "",
            sourceUrl: thread?.sourceUrl || ""
        };
    }

    return {
        byThreadId,
        updatedAt: new Date().toISOString()
    };
}

async function appendEtsyMessageMonitorDebugLog(entry = {}) {
    const safeEntry = {
        type: String(entry.type || "debug"),
        at: entry.at || new Date().toISOString(),
        data: entry.data || {}
    };

    try {
        const cfg = await chrome.storage.local.get([ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY]);
        const existingLogs = Array.isArray(cfg[ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY])
            ? cfg[ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY]
            : [];
        const nextLogs = [...existingLogs, safeEntry].slice(-50);

        await chrome.storage.local.set({
            [ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY]: nextLogs
        });
    } catch (error) {
        console.warn("[LNG][sw][ETSY_MESSAGE_MONITOR][DEBUG_LOG_ERROR]", {
            message: error?.message || String(error),
            entry: safeEntry
        });
    }
}

async function getEtsyMessageMonitorStatus() {
    const [alarm, cfg] = await Promise.all([
        chrome.alarms.get(ETSY_MESSAGE_MONITOR_ALARM),
        chrome.storage.local.get([
            ETSY_MESSAGE_SNAPSHOT_KEY,
            ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY
        ])
    ]);
    const snapshot = cfg[ETSY_MESSAGE_SNAPSHOT_KEY] || null;
    const debugLogs = Array.isArray(cfg[ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY])
        ? cfg[ETSY_MESSAGE_MONITOR_DEBUG_LOGS_KEY]
        : [];

    return {
        alarm: alarm ? {
            name: alarm.name,
            periodInMinutes: alarm.periodInMinutes || null,
            scheduledTime: alarm.scheduledTime || null
        } : null,
        autoEnabled: ETSY_MESSAGE_MONITOR_AUTO_ENABLED === true,
        snapshotExists: Boolean(snapshot?.byThreadId && Object.keys(snapshot.byThreadId).length),
        snapshotUpdatedAt: snapshot?.updatedAt || null,
        latestLogs: debugLogs.slice(-10).reverse()
    };
}

async function runEtsyMessageMonitorTick() {
    try {
        const cfg = await chrome.storage.local.get([
            "mongoShopId",
            "backendUrl",
            ETSY_MESSAGE_SNAPSHOT_KEY
        ]);
        const mongoShopId = String(cfg.mongoShopId || "").trim();

        if (!mongoShopId || !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
            console.warn("[LNG][sw][ETSY_MESSAGE_MONITOR] skipped: missing mongoShopId");
            await appendEtsyMessageMonitorDebugLog({
                type: "error",
                data: {
                    reason: "missing_mongoShopId"
                }
            });
            return {
                ok: false,
                skipped: true,
                reason: "missing_mongoShopId"
            };
        }

        await appendEtsyMessageMonitorDebugLog({
            type: "tick_started",
            data: {
                mongoShopId,
                periodMinutes: ETSY_MESSAGE_MONITOR_PERIOD_MINUTES,
                forceReload: true
            }
        });

        sendSocketTaskLog("ETSY_MESSAGE_MONITOR tick started", {
            mongoShopId,
            periodMinutes: ETSY_MESSAGE_MONITOR_PERIOD_MINUTES,
            forceReload: true
        });

        const socketStatus = await getSocketStatus();
        if (socketStatus?.connected !== true) {
            await autoConnectSocketIfReady();
        }

        const data = await handleEtsyMessageSyncDebug({
            limit: 30,
            silent: true,
            forceReload: true
        });
        const threads = Array.isArray(data?.threads) ? data.threads : [];
        const previousSnapshot = cfg[ETSY_MESSAGE_SNAPSHOT_KEY] || {};
        const nextSnapshot = buildEtsyMessageSnapshot(threads);
        const isFirstSnapshot = !previousSnapshot?.byThreadId ||
            !Object.keys(previousSnapshot.byThreadId).length;

        if (isFirstSnapshot) {
            await chrome.storage.local.set({
                [ETSY_MESSAGE_SNAPSHOT_KEY]: nextSnapshot
            });

            await appendEtsyMessageMonitorDebugLog({
                type: "first_snapshot_saved",
                data: {
                    totalThreads: threads.length,
                    emitted: false
                }
            });

            sendSocketTaskLog("ETSY_MESSAGE_MONITOR first snapshot saved", {
                totalThreads: threads.length,
                emitted: false
            });

            return {
                ok: true,
                firstSnapshot: true,
                emitted: false,
                totalThreads: threads.length
            };
        }

        const newMessages = detectNewEtsyMessages(previousSnapshot, threads);
        const tickResultLog = {
            totalThreads: threads.length,
            newMessages: newMessages.length,
            sampleNewMessages: newMessages.slice(0, 5).map((item) => ({
                reason: item.reason,
                threadId: item.thread.threadId,
                buyerName: item.thread.buyerName,
                orderId: item.thread.orderId,
                unread: item.thread.unread,
                lastMessageAt: item.thread.lastMessageAt,
                latestMessagePreview: item.thread.latestMessagePreview
            }))
        };

        console.log("[LNG][sw][ETSY_MESSAGE_MONITOR] tick result", {
            totalThreads: threads.length,
            newMessages: newMessages.length
        });

        await appendEtsyMessageMonitorDebugLog({
            type: "tick_result",
            data: tickResultLog
        });

        sendSocketTaskLog("ETSY_MESSAGE_MONITOR tick result", tickResultLog);

        if (!newMessages.length) {
            await chrome.storage.local.set({
                [ETSY_MESSAGE_SNAPSHOT_KEY]: nextSnapshot
            });

            return {
                ok: true,
                newMessages: 0,
                totalThreads: threads.length,
                snapshotSaved: true
            };
        }

        const payload = {
            eventId: `etsy_message_sync:${mongoShopId}:${Date.now()}`,
            type: "ETSY_MESSAGE_NEW",
            status: "detected",
            shopId: mongoShopId,
            machineId: mongoShopId,
            source: "chrome_extension",
            result: {
                totalThreads: threads.length,
                newMessagesCount: newMessages.length,
                messages: newMessages.map((item) => ({
                    reason: item.reason,
                    threadId: item.thread.threadId,
                    buyerName: item.thread.buyerName,
                    buyerUsername: item.thread.buyerUsername || "",
                    orderId: item.thread.orderId || "",
                    unread: item.thread.unread === true,
                    lastMessageAt: item.thread.lastMessageAt || "",
                    latestMessageBody: item.thread.latestMessageBody || "",
                    latestMessagePreview: item.thread.latestMessagePreview || "",
                    sourceUrl: item.thread.sourceUrl || ""
                })),
                syncedAt: data?.syncedAt || new Date().toISOString()
            }
        };

        const emitResult = await emitSocketEvent("client:etsy_message", payload);
        const snapshotSaved = emitResult?.ok === true && emitResult?.ack?.ok === true;

        console.log("[LNG][sw][ETSY_MESSAGE_MONITOR] socket emit result", emitResult);

        await appendEtsyMessageMonitorDebugLog({
            type: "socket_emit_result",
            data: {
                ok: emitResult?.ok,
                eventName: "client:etsy_message",
                newMessagesCount: newMessages.length,
                reason: emitResult?.reason || null,
                timeout: emitResult?.timeout === true,
                ackOk: emitResult?.ack?.ok === true
            }
        });

        if (snapshotSaved) {
            await chrome.storage.local.set({
                [ETSY_MESSAGE_SNAPSHOT_KEY]: nextSnapshot
            });

            await appendEtsyMessageMonitorDebugLog({
                type: "snapshot_saved_after_emit",
                data: {
                    newMessages: newMessages.length,
                    totalThreads: threads.length
                }
            });
        } else {
            await appendEtsyMessageMonitorDebugLog({
                type: "snapshot_not_saved_emit_failed",
                data: {
                    newMessages: newMessages.length,
                    totalThreads: threads.length,
                    emitOk: emitResult?.ok === true,
                    ackOk: emitResult?.ack?.ok === true,
                    reason: emitResult?.reason || null,
                    timeout: emitResult?.timeout === true
                }
            });
        }

        sendSocketTaskLog("ETSY_MESSAGE_MONITOR socket emitted", {
            ok: emitResult?.ok,
            eventName: "client:etsy_message",
            newMessagesCount: newMessages.length,
            reason: emitResult?.reason || null,
            snapshotSaved
        });

        return {
            ok: true,
            totalThreads: threads.length,
            newMessages: newMessages.length,
            emitResult,
            snapshotSaved
        };
    } catch (error) {
        await appendEtsyMessageMonitorDebugLog({
            type: "error",
            data: {
                message: error?.message || String(error)
            }
        });

        throw error;
    }
}

async function handleEtsyMessageSyncDebug(payload = {}) {
    const limit = Math.max(1, Math.min(100, Number.parseInt(payload.limit, 10) || 20));
    const silent = payload.silent === true;
    const forceReload = payload.forceReload === true;

    if (!silent) {
        sendSocketTaskLog("ETSY_MESSAGE_SYNC_DEBUG started", { limit });
    }

    const tab = await ensureEtsyMessagesTab();
    if (forceReload) {
        console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] force reload messages tab", {
            tabId: tab.id,
            url: tab.url
        });

        await chrome.tabs.reload(tab.id, {
            bypassCache: true
        });

        await waitForTabComplete(tab.id);
        await sleep(800);
    }

    const readyTab = await chrome.tabs.get(tab.id);
    console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG] tab ready", {
        tabId: readyTab.id,
        url: readyTab.url,
        status: readyTab.status,
        forceReload
    });

    await injectContentScript(readyTab.id);

    const contentResponse = await sendMessageToTabWithRetry(readyTab.id, {
        action: "CONTENT_ETSY_MESSAGE_SYNC_DEBUG",
        payload: { limit }
    });

    if (!contentResponse?.ok) {
        throw new Error(contentResponse?.message || "Content script failed to debug sync Etsy messages");
    }

    const data = contentResponse.data;
    const threads = Array.isArray(data?.threads) ? data.threads : [];
    const summary = {
        totalThreads: threads.length,
        unreadThreads: threads.filter((thread) => thread?.unread === true).length,
        threadsWithOrderId: threads.filter((thread) => Boolean(thread?.orderId)).length,
        source: data?.source || "",
        syncedAt: data?.syncedAt || "",
        sampleThreads: threads.slice(0, 5).map((thread) => ({
            threadId: thread.threadId || "",
            buyerName: thread.buyerName || "",
            orderId: thread.orderId || "",
            unread: thread.unread === true,
            lastMessageAt: thread.lastMessageAt || "",
            latestMessagePreview: thread.latestMessagePreview || ""
        }))
    };

    console.log("[LNG][sw][ETSY_MESSAGE_SYNC_DEBUG][RESULT]", data);
    if (!silent) {
        sendSocketTaskLog("ETSY_MESSAGE_SYNC_DEBUG result", summary);
    }

    return data;
}

function waitForTabComplete(tabId) {
    return waitForTabCompleteWithTimeout(chrome.tabs, tabId, {
        timeoutMs: ETSY_TAB_READY_TIMEOUT_MS,
        label: "Etsy tab"
    });
}

async function injectContentScript(tabId) {
    console.log("[LNG][sw] injectContentScript", tabId);
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-etsy.js"]
    });
}

async function sendMessageToTabWithRetry(tabId, message, options = {}) {
    const attempts = Number.parseInt(options.attempts, 10) || 3;
    const delayMs = Number.parseInt(options.delayMs, 10) || 800;
    const action = message?.action || "";

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (error) {
            const errorMessage = error?.message || String(error);
            const shouldRetry =
                /receiving end does not exist/i.test(errorMessage) ||
                /message channel closed/i.test(errorMessage);

            if (!shouldRetry || attempt >= attempts) {
                throw error;
            }

            console.log("[LNG][sw][TAB_MESSAGE_RETRY]", {
                attempt,
                tabId,
                action,
                message: errorMessage
            });

            await injectContentScript(tabId);
            await sleep(delayMs);
        }
    }

    throw new Error(`Failed to send message to tab ${tabId}`);
}

const etsyAdsJobLocks = new Map();

async function handleEtsyAdsImportDay(payload) {
    const date = toLocalYMD(String(payload.date || "").trim());
    const mongoShopId = String(payload.mongoShopId || "").trim();
    const taskId = String(payload.taskId || `etsy_ads:${mongoShopId}:${date || Date.now()}`).trim();
    const taskType = String(payload.taskType || "ETSY_ADS").trim();
    const etsyAdsBackendUrl = String(
        payload.etsyAdsBackendUrl || CONFIG.DEFAULT_ETSY_ADS_BACKEND_URL
    ).trim();
    const queryDateOffsetDays = 0;
    const autoResolveOverviewDate = false;
    const allowListingFallback = payload.allowListingFallback === true;
    const filterMode = payload.filterMode || "spend_only";
    const dryRun = payload.dryRun === true;
    const debugComparePromotedParam = payload.debugComparePromotedParam === true;
    const debugCompareDateOffset = payload.debugCompareDateOffset === true;
    const requestedDebugCompareMaxPages = Number(payload.debugCompareMaxPages || 2);
    const debugCompareMaxPages = Number.isFinite(requestedDebugCompareMaxPages)
        ? requestedDebugCompareMaxPages
        : 2;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Etsy Ads date phải đúng định dạng YYYY-MM-DD");
    }

    if (!mongoShopId || !/^[a-f0-9]{24}$/i.test(mongoShopId)) {
        throw new Error("Thiếu mongoShopId hợp lệ");
    }

    if (!Number.isFinite(Number(queryDateOffsetDays))) {
        throw new Error("queryDateOffsetDays phai la so");
    }

    if (!["spend_only", "full_stats"].includes(filterMode)) {
        throw new Error("filterMode phai la spend_only hoac full_stats");
    }

    const lockKey = `etsy_ads:${mongoShopId}:${date}`;

    if (etsyAdsJobLocks.has(lockKey)) {
        return {
            ok: false,
            skipped: true,
            reason: "ETSY_ADS_JOB_RUNNING",
            date
        };
    }

    const job = (async () => {
        try {
            return await runEtsyAdsImportDay({
                date,
                mongoShopId,
                etsyAdsBackendUrl,
                queryDateOffsetDays: Number(queryDateOffsetDays),
                autoResolveOverviewDate,
                allowListingFallback,
                filterMode,
                dryRun,
                debugComparePromotedParam,
                debugCompareDateOffset,
                debugCompareMaxPages,
                taskId,
                taskType
            }).catch(async (error) => {
                await logServiceEvent({
                    service: "ETSY_ADS",
                    logType: "task_failed",
                    level: "error",
                    message: `ETSY_ADS failed: ${error?.message || String(error)}`,
                    mongoShopId,
                    taskId,
                    taskType,
                    rawData: {
                        date,
                        filterMode,
                        dryRun
                    },
                    error
                });

                throw error;
            });
        } finally {
            etsyAdsJobLocks.delete(lockKey);
        }
    })();

    etsyAdsJobLocks.set(lockKey, job);

    return job;
}

async function runEtsyAdsImportDay({
    date,
    mongoShopId,
    etsyAdsBackendUrl,
    queryDateOffsetDays = 0,
    autoResolveOverviewDate = false,
    allowListingFallback = false,
    filterMode = "spend_only",
    dryRun = false,
    debugComparePromotedParam = false,
    debugCompareDateOffset = false,
    debugCompareMaxPages = 2,
    taskId = "",
    taskType = "ETSY_ADS"
}) {
    const runId = [
        "etsy_ads",
        mongoShopId,
        date,
        Date.now()
    ].join(":");

    console.log("[LNG][sw][ETSY_ADS] runEtsyAdsImportDay start", {
        runId,
        date,
        mongoShopId,
        etsyAdsBackendUrl,
        queryDateOffsetDays,
        autoResolveOverviewDate,
        allowListingFallback,
        filterMode,
        dryRun,
        debugComparePromotedParam,
        debugCompareDateOffset,
        debugCompareMaxPages
    });
    await logServiceEvent({
        service: "ETSY_ADS",
        logType: "task_processing",
        message: "ETSY_ADS export started",
        mongoShopId,
        taskId: taskId || runId,
        taskType,
        rawData: {
            runId,
            date,
            filterMode,
            dryRun
        }
    });

    const tab = await ensureEtsyAdsTab();
    await logServiceEvent({
        service: "ETSY_ADS",
        logType: "debug",
        message: "ETSY_ADS tab ready",
        mongoShopId,
        taskId: taskId || runId,
        taskType,
        rawData: {
            tabId: tab.id,
            status: tab.status || null
        }
    });

    await injectContentScript(tab.id);

    console.log("[ETSY_ADS_DATE][SW_PAYLOAD]", {
        selectedDate: date,
        payloadDate: date,
        queryDateOffsetDays: 0,
        autoResolveOverviewDate: false
    });

    const contentResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "CONTENT_ETSY_ADS_EXPORT",
        payload: {
            runId,
            date,
            queryDateOffsetDays: 0,
            autoResolveOverviewDate: false,
            allowListingFallback,
            filterMode,
            dryRun,
            debugComparePromotedParam,
            debugCompareDateOffset,
            debugCompareMaxPages
        }
    });

    if (!contentResponse?.ok) {
        throw new Error(contentResponse?.message || "Content Etsy Ads export failed");
    }

    const etsyAdsData = contentResponse.data;
    await logServiceEvent({
        service: "ETSY_ADS",
        logType: "info",
        message: "ETSY_ADS content export response received",
        mongoShopId,
        taskId: taskId || runId,
        taskType,
        rawData: {
            rows: etsyAdsData.summary?.rowCount ?? 0,
            totalSpend: etsyAdsData.summary?.totalSpend ?? 0,
            etsyShopId: etsyAdsData.etsyShopId || null,
            shopName: etsyAdsData.shopName || null
        }
    });

    console.log("[LNG][sw][ETSY_ADS][BEFORE_POST_VERIFY]", {
        requestedDate: date,
        etsyDataDate: etsyAdsData.date,
        totalSpend: etsyAdsData.summary?.totalSpend,
        rows: etsyAdsData.summary?.rowCount,
        raw: etsyAdsData.raw
    });
    await logServiceEvent({
        service: "ETSY_ADS",
        logType: "debug",
        message: "ETSY_ADS date verify",
        mongoShopId,
        taskId: taskId || runId,
        taskType,
        rawData: {
            requestedDate: date,
            etsyDataDate: etsyAdsData.date || null,
            overviewApiDate: etsyAdsData.sourceMeta?.overviewApiDate || etsyAdsData.raw?.overviewApiDate || etsyAdsData.raw?.etsyApiDate || null,
            etsyApiDate: etsyAdsData.raw?.etsyApiDate || null
        }
    });

    const sourceMeta = {
        runId,
        overviewSource: etsyAdsData.sourceMeta?.overviewSource || "etsy_ads_overview_api",
        overviewFallbackUsed: etsyAdsData.sourceMeta?.overviewFallbackUsed === true,
        totalsSource: etsyAdsData.sourceMeta?.totalsSource || etsyAdsData.summary?.totalsSource || null,
        listingSource: "prolist.stats.listings",
        selectedDate: date,
        targetDate: etsyAdsData.raw?.targetDate || date,
        listingApiDate: etsyAdsData.sourceMeta?.listingApiDate || etsyAdsData.raw?.listingApiDate || etsyAdsData.raw?.etsyApiDate || null,
        etsyApiDate: etsyAdsData.raw?.etsyApiDate || null,
        overviewApiDate: etsyAdsData.sourceMeta?.overviewApiDate || etsyAdsData.raw?.overviewApiDate || etsyAdsData.raw?.etsyApiDate || null,
        dateOffsetRule: etsyAdsData.raw?.dateOffsetRule || null,
        queryDateOffsetDays: 0,
        autoResolveOverviewDate: false,
        allowListingFallback: etsyAdsData.sourceMeta?.allowListingFallback === true || etsyAdsData.raw?.allowListingFallback === true,
        isPromotedParam: "",
        sortType: "spent_total",
        filterMode,
        keptRule: filterMode === "full_stats" ? "any_stats_gt_0" : "spend_gt_0",
        listingRowsKeptRule: etsyAdsData.sourceMeta?.listingRowsKeptRule || (filterMode === "full_stats" ? "any_stats_gt_0" : "spend_gt_0"),
        listingTotalsAudit: etsyAdsData.sourceMeta?.listingTotalsAudit || etsyAdsData.raw?.listingTotals || null,
        overviewTotals: etsyAdsData.sourceMeta?.overviewTotals || null,
        totalsRule: etsyAdsData.sourceMeta?.totalsRule || "final_totals_from_overview_api_only",
        mapperVersion: "etsy_ads_listing_mapper.v2.camel_snake_reconcile",
        rawSummaryMode: "direct_raw_not_mapper",
        listingReconcileVersion: "listing_reconcile.v1",
        notes: "Listing rows are kept for detail. Overview totals may differ from Etsy UI if Etsy uses another attribution source.",
        contentSummary: etsyAdsData.summary || null,
        raw: etsyAdsData.raw || null,
        contentSourceMeta: etsyAdsData.sourceMeta || null
    };

    let push = null;

    if (dryRun) {
        console.warn("[LNG][sw][ETSY_ADS][DRY_RUN] skip backend POST", {
            runId,
            date,
            mongoShopId,
            rows: etsyAdsData.summary?.rowCount,
            totalSpend: etsyAdsData.summary?.totalSpend
        });
    } else {
        await logServiceEvent({
            service: "ETSY_ADS",
            logType: "task_processing",
            message: "ETSY_ADS backend ads post started",
            mongoShopId,
            taskId: taskId || runId,
            taskType,
            rawData: {
                runId,
                date,
                rowsCount: etsyAdsData.summary?.rowCount ?? 0,
                totalSpend: etsyAdsData.summary?.totalSpend ?? 0
            }
        });

        push = await pushEtsyAdsToBackend({
            etsyAdsBackendUrl,
            mongoShopId,
            date,
            data: etsyAdsData,
            sourceMeta
        });
        await logServiceEvent({
            service: "ETSY_ADS",
            logType: "task_completed",
            message: "ETSY_ADS backend ads post completed",
            mongoShopId,
            taskId: taskId || runId,
            taskType,
            rawData: summarizeAdsPush(push)
        });
    }

    const result = {
        ok: true,
        runId,
        dryRun,
        date,
        mongoShopId,
        etsyShopId: etsyAdsData.etsyShopId,
        shopName: etsyAdsData.shopName,
        rows: etsyAdsData.summary?.rowCount || 0,
        sampleRows: (etsyAdsData.rows || []).slice(0, 3),
        totalSpend: etsyAdsData.summary?.totalSpend || 0,
        summary: etsyAdsData.summary || null,
        raw: etsyAdsData.raw || null,
        push
    };

    await logServiceEvent({
        service: "ETSY_ADS",
        logType: "task_completed",
        message: "ETSY_ADS export completed",
        mongoShopId,
        taskId: taskId || runId,
        taskType,
        rawData: {
            runId,
            date,
            dryRun,
            rows: result.rows,
            totalSpend: result.totalSpend,
            push: summarizeAdsPush(push)
        }
    });

    return result;
}

async function ensureEtsyAdsTab() {
    const tabs = await chrome.tabs.query({
        url: "https://www.etsy.com/*"
    });

    console.log("[LNG][sw][ETSY_ADS] etsy tabs found", tabs.length);

    return ensurePageTabReady({
        tabsApi: chrome.tabs,
        queryUrl: "https://www.etsy.com/*",
        targetUrl: CONFIG.ETSY_ADS_URL,
        isTargetTab: (tab) => Boolean(
            tab?.url &&
            tab.url.includes("/your/shops/") &&
            tab.url.includes("/advertising")
        ),
        timeoutMs: ETSY_TAB_READY_TIMEOUT_MS,
        label: "Etsy Ads tab",
        logger: console,
        initialTabs: tabs
    });
}

async function pushEtsyAdsToBackend({
    etsyAdsBackendUrl,
    mongoShopId,
    date,
    data,
    sourceMeta = null
}) {
    const payload = {
        shopId: mongoShopId,
        platform: "etsy",
        day: date,
        etsyShopId: data.etsyShopId,
        shopName: data.shopName,
        sourceMeta: sourceMeta || data.sourceMeta || null,
        rows: data.rows || [],
        summary: data.summary || {},
        raw: data.raw || null
    };

    const overviewApiDate = payload.sourceMeta?.overviewApiDate || payload.sourceMeta?.etsyApiDate || null;
    const totalsSource = payload.sourceMeta?.totalsSource || payload.summary?.totalsSource || null;
    const allowListingFallback = payload.sourceMeta?.allowListingFallback === true || payload.raw?.allowListingFallback === true;
    console.log("[LNG][sw][ETSY_ADS][FINAL_TOTALS_SOURCE]", {
        day: payload.day,
        overviewApiDate,
        totalsSource,
        totalSpend: payload.summary?.totalSpend ?? null,
        totalRevenue: payload.summary?.totalRevenue ?? null,
        totalViews: payload.summary?.totalViews ?? null,
        totalClicks: payload.summary?.totalClicks ?? null,
        totalOrders: payload.summary?.totalOrders ?? null,
        rowsCount: payload.rows.length
    });

    if (totalsSource !== "etsy_ads_overview_api" && allowListingFallback !== true) {
        throw new Error("Etsy Ads final totals source is not overview API and listing fallback is disabled");
    }

    if (overviewApiDate && payload.day !== overviewApiDate) {
        console.warn("[ETSY_ADS_IMPORT][DATE_MISMATCH]", {
            day: payload.day,
            overviewApiDate,
            selectedDate: payload.sourceMeta?.selectedDate || null,
            targetDate: payload.sourceMeta?.targetDate || null,
            etsyApiDate: payload.sourceMeta?.etsyApiDate || null,
            message: "Backend day differs from Etsy Ads overview API date."
        });
    }

    const debugPayload = {
        url: etsyAdsBackendUrl,
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: payload,
        meta: {
            rowsCount: payload.rows.length,
            hasRaw: Boolean(payload.raw),
            rawType: payload.raw ? typeof payload.raw : null,
            rawSize:
                payload.raw == null
                    ? 0
                    : typeof payload.raw === "string"
                        ? payload.raw.length
                        : JSON.stringify(payload.raw).length,
            firstRow: payload.rows[0] || null,
            summary: payload.summary
        }
    };

    console.log("[LNG][sw][ETSY_ADS][POST_PAYLOAD]", debugPayload);

    sendSocketTaskLog("📤 ETSY_ADS POST payload preview", {
        url: debugPayload.url,
        method: debugPayload.method,
        rowsCount: debugPayload.meta.rowsCount,
        firstRow: debugPayload.meta.firstRow,
        summary: debugPayload.meta.summary,
        hasRaw: debugPayload.meta.hasRaw,
        rawSize: debugPayload.meta.rawSize,
        body: payload
    });

    const response = await fetch(etsyAdsBackendUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    const text = await response.text();

    console.log("[LNG][sw][ETSY_ADS][POST_RESPONSE]", {
        url: etsyAdsBackendUrl,
        status: response.status,
        ok: response.ok,
        text: text.slice(0, 1000)
    });

    sendSocketTaskLog("📥 ETSY_ADS POST response", {
        url: etsyAdsBackendUrl,
        status: response.status,
        ok: response.ok,
        text: text.slice(0, 1000)
    });

    let body = null;

    try {
        body = JSON.parse(text);
    } catch (_) {
        body = { raw: text };
    }

    try {
        console.log("[LNG][sw][ETSY_ADS][SKU_ENRICH_RESPONSE]", {
            url: etsyAdsBackendUrl,
            status: response.status,
            ok: response.ok,
            rowsCount: body?.rowsCount ?? null,
            rowsAccepted: body?.rowsAccepted ?? null,
            rowsRejected: body?.rowsRejected ?? null,
            fromAdsRow: body?.fromAdsRow ?? null,
            fromOrdersFallback: body?.fromOrdersFallback ?? null,
            fromListingMaster: body?.fromListingMaster ?? null,
            missing: body?.missing ?? null,
            totalSpend: body?.totalSpend ?? null,
            totalRevenue: body?.totalRevenue ?? null,
            totalOrders: body?.totalOrders ?? null,
            totalsSource: body?.totalsSource ?? null,
            overviewApiDate: body?.overviewApiDate ?? null,
            docId: body?.docId ?? null,
            message: body?.message || null
        });

        sendSocketTaskLog("ETSY_ADS SKU enrich response", {
            status: response.status,
            ok: response.ok,
            rowsCount: body?.rowsCount ?? null,
            rowsAccepted: body?.rowsAccepted ?? null,
            fromAdsRow: body?.fromAdsRow ?? null,
            fromOrdersFallback: body?.fromOrdersFallback ?? null,
            fromListingMaster: body?.fromListingMaster ?? null,
            missing: body?.missing ?? null,
            totalsSource: body?.totalsSource ?? null,
            docId: body?.docId ?? null
        });
    } catch (logError) {
        console.warn("[LNG][sw][ETSY_ADS][SKU_ENRICH_RESPONSE_LOG_ERROR]", {
            message: logError?.message || String(logError)
        });
    }

    if (!response.ok) {
        throw new Error(`Backend Etsy Ads ${response.status}: ${text.slice(0, 300)}`);
    }

    return {
        status: response.status,
        body
    };
}
