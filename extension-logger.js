const DEFAULT_API_BASE_URL = "https://api.lngmerch.co";
const MAX_RAW_STRING_LENGTH = 1000;
const MAX_RAW_ARRAY_ITEMS = 20;
const MAX_RAW_OBJECT_KEYS = 40;
const SENSITIVE_KEY_PATTERN = /cookie|csrf|token|auth|authorization|session|secret|password|html/i;
const ALLOWED_LOG_TYPES = new Set([
    "task_received",
    "task_processing",
    "task_completed",
    "task_failed",
    "upload_started",
    "upload_progress",
    "upload_completed",
    "upload_failed",
    "connection_status",
    "error",
    "info",
    "debug"
]);
const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error"]);
const SERVICE_LOG_PREFIXES = {
    AMAZON_ADS: "[AMAZON_ADS]",
    AUTO_CONFIG: "[AUTO_CONFIG]",
    ETSY_AUTO_CONFIG: "[AUTO_CONFIG]",
    ETSY_ADS: "[ETSY_ADS]",
    ETSY_ADS_FULL_IMPORT: "[ETSY_ADS_FULL_IMPORT]",
    IMPORT_ADS_SPEND: "[ETSY_ADS]",
    IMPORT_ETSY_ADS_WITH_LISTINGS: "[ETSY_ADS_FULL_IMPORT]",
    IMPORT_ORDER: "[IMPORT_ORDER]",
    IMPORT_ORDERS: "[IMPORT_ORDER]",
    POPUP: "[POPUP]",
    SOCKET: "[SOCKET]",
    SYNC_ETSY_LISTINGS: "[SYNC_ETSY_LISTINGS]",
    ETSY_SYNC_LISTINGS: "[SYNC_ETSY_LISTINGS]",
    ETSY_UPLOAD_TRACKING: "[UPLOAD_TRACKING]",
    UPLOAD_TRACKING: "[UPLOAD_TRACKING]"
};

let extensionLogSessionId = null;

function getSessionId() {
    if (extensionLogSessionId) return extensionLogSessionId;

    if (globalThis.crypto?.randomUUID) {
        extensionLogSessionId = globalThis.crypto.randomUUID();
    } else {
        extensionLogSessionId = `ext-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    return extensionLogSessionId;
}

function getRequestId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `ext-log-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeApiBaseUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return DEFAULT_API_BASE_URL;

    try {
        return new URL(raw).origin;
    } catch {
        return DEFAULT_API_BASE_URL;
    }
}

async function getStoredLoggerConfig() {
    try {
        const cfg = await chrome.storage.local.get([
            "mongoShopId",
            "backendUrl",
            "socketLabel",
            "shopName"
        ]);

        return {
            machineId: String(cfg.mongoShopId || "").trim(),
            shopId: String(cfg.mongoShopId || "").trim(),
            shopName: String(cfg.shopName || cfg.socketLabel || "").trim(),
            apiBaseUrl: normalizeApiBaseUrl(cfg.backendUrl)
        };
    } catch {
        return {
            machineId: "",
            shopId: "",
            shopName: "",
            apiBaseUrl: DEFAULT_API_BASE_URL
        };
    }
}

function sanitizeValue(value, depth = 0) {
    if (value === null || value === undefined) return value;

    if (depth > 4) return "[Truncated]";

    if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (lower.includes("<html") || lower.includes("<!doctype")) {
            return "[Redacted HTML]";
        }

        return value.length > MAX_RAW_STRING_LENGTH
            ? `${value.slice(0, MAX_RAW_STRING_LENGTH)}...[truncated]`
            : value;
    }

    if (typeof value !== "object") return value;

    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_RAW_ARRAY_ITEMS)
            .map((item) => sanitizeValue(item, depth + 1));
    }

    const output = {};
    for (const key of Object.keys(value).slice(0, MAX_RAW_OBJECT_KEYS)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            output[key] = "[Redacted]";
        } else {
            output[key] = sanitizeValue(value[key], depth + 1);
        }
    }

    return output;
}

function sanitizeErrorInfo(errorInfo) {
    if (!errorInfo || typeof errorInfo !== "object") return undefined;

    return sanitizeValue({
        errorCode: errorInfo.errorCode,
        errorMessage: errorInfo.errorMessage,
        stackTrace: errorInfo.stackTrace,
        context: errorInfo.context
    });
}

function normalizeServiceName(value) {
    return String(value || "").trim().toUpperCase();
}

function mapLogTypeForBackend(logType) {
    const value = String(logType || "").trim();
    const map = {
        auto_alarm_tick: "debug",
        auto_task_started: "task_processing",
        auto_task_completed: "task_completed",
        auto_task_failed: "task_failed",
        auto_task_skipped: "info",
        auto_pull_tracking_skipped: "info"
    };

    if (ALLOWED_LOG_TYPES.has(value)) return value;
    return map[value] || "info";
}

function inferServiceName(event) {
    const directService = normalizeServiceName(event.service || event.metadata?.service);
    if (directService) return directService;

    const taskType = normalizeServiceName(event.taskInfo?.taskType);
    if (taskType) return taskType;

    if (String(event.logType || "").startsWith("upload_")) {
        return "ETSY_UPLOAD_TRACKING";
    }

    if (event.logType === "connection_status") {
        return "SOCKET";
    }

    return "";
}

function getServiceLogPrefix(serviceName) {
    const normalized = normalizeServiceName(serviceName);
    return SERVICE_LOG_PREFIXES[normalized] || (normalized ? `[${normalized}]` : "");
}

function prefixLogMessage(message, prefix) {
    const value = String(message || "").trim();
    if (!prefix || value.startsWith(prefix) || /^\[[A-Z0-9_]+\]/.test(value)) {
        return value;
    }

    return `${prefix} ${value}`;
}

export async function logExtensionEvent(event = {}) {
    try {
        const stored = await getStoredLoggerConfig();
        const machineId = String(event.machineId || stored.machineId || "").trim();
        const shopId = String(event.shopId || stored.shopId || machineId || "").trim();
        const originalLogType = String(event.logType || "").trim();
        const logType = mapLogTypeForBackend(originalLogType);
        const level = ALLOWED_LEVELS.has(event.level) ? event.level : "info";
        const service = inferServiceName(event);
        const logPrefix = getServiceLogPrefix(service);
        const message = prefixLogMessage(event.message, logPrefix);

        if (!machineId || !shopId || !message) {
            console.warn("[EXT_LOG] skipped missing required fields", {
                hasMachineId: Boolean(machineId),
                hasShopId: Boolean(shopId),
                hasMessage: Boolean(message),
                logType,
                service
            });
            return;
        }

        const metadata = {
            ...sanitizeValue(event.metadata || {}),
            extensionVersion: chrome.runtime.getManifest()?.version || "",
            browserInfo: navigator.userAgent,
            service: service || undefined,
            logPrefix: logPrefix || undefined,
            sessionId: getSessionId(),
            requestId: getRequestId(),
            originalLogType: originalLogType || undefined
        };

        const body = {
            machineId,
            shopId,
            shopName: event.shopName || stored.shopName || undefined,
            logType,
            level,
            message,
            taskInfo: sanitizeValue(event.taskInfo),
            uploadInfo: sanitizeValue(event.uploadInfo),
            errorInfo: sanitizeErrorInfo(event.errorInfo),
            metadata,
            performance: sanitizeValue(event.performance),
            rawData: sanitizeValue({
                originalLogType: originalLogType || undefined,
                ...(event.rawData || {})
            })
        };

        const url = `${stored.apiBaseUrl}/api/ext/logs`;

        console.log("[EXT_LOG] submit request", {
            url,
            logType,
            level,
            service,
            machineId,
            shopId,
            message,
            taskInfo: body.taskInfo
        });

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        const text = await response.text().catch(() => "");

        console.log("[EXT_LOG] submit response", {
            url,
            status: response.status,
            ok: response.ok,
            logType,
            service,
            machineId,
            shopId,
            preview: text.slice(0, 300)
        });

        if (!response.ok) {
            throw new Error(`EXT_LOG submit failed ${response.status}: ${text.slice(0, 300)}`);
        }
    } catch (error) {
        console.warn("[EXT_LOG] submit failed", error?.message || String(error));
    }
}
