import { io } from "./lib/socket.io.esm.min.js";
import { logExtensionEvent } from "./extension-logger.js";

const SOCKET_PATH = "/ws";

let socket = null;
let connectBusy = false;
let heartbeatTimer = null;
let socketTaskHandler = null;

export function setSocketTaskHandler(handler) {
    socketTaskHandler = typeof handler === "function" ? handler : null;
}



function logSocket(message, data = null) {
    const value = String(message || "").trim();
    const prefixedMessage = value.startsWith("[SOCKET]") ? value : `[SOCKET] ${value}`;

    console.log("[LNG][SOCKET]", prefixedMessage, data || "");

    chrome.runtime.sendMessage({
        type: "SOCKET_LOG",
        payload: {
            message: prefixedMessage,
            data,
            timestamp: new Date().toLocaleTimeString()
        }
    }).catch(() => { });
}

function getTaskInfoForLog(task, taskId, taskType) {
    const payload = task?.payload || {};

    return {
        taskId: taskId || undefined,
        taskType: taskType || undefined,
        batchId: payload.batchGroupId || payload.batchId || undefined,
        ordersCount: Number.isFinite(Number(payload.batchTotal))
            ? Number(payload.batchTotal)
            : undefined,
        filename: payload.filename || undefined
    };
}

function normalizeUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
}

function deriveSocketBaseUrl(backendUrl) {
    const raw = normalizeUrl(backendUrl);
    if (!raw) return "";

    try {
        return new URL(raw).origin;
    } catch {
        return "";
    }
}

async function getSocketConfig() {
    const cfg = await chrome.storage.local.get([
        "mongoShopId",
        "backendUrl",
        "socketBaseUrl",
        "socketLabel",
        "autoConnectSocket"
    ]);

    const mongoShopId = String(cfg.mongoShopId || "").trim();
    const backendUrl = normalizeUrl(
        cfg.backendUrl || "https://api.lngmerch.co"
    );

    const socketBaseUrl = normalizeUrl(
        cfg.socketBaseUrl || deriveSocketBaseUrl(backendUrl)
    );

    return {
        socketBaseUrl,
        backendUrl,
        shopId: mongoShopId,
        machineId: mongoShopId,
        label: String(
            cfg.socketLabel || `Machine-${mongoShopId.slice(-4) || "NEW"}`
        ).trim(),
        autoConnectSocket: cfg.autoConnectSocket === true
    };
}

function startHeartbeat() {
    stopHeartbeat();

    heartbeatTimer = setInterval(async () => {
        if (!socket || !socket.connected) return;

        const cfg = await getSocketConfig();

        socket.emit("ext:heartbeat", {
            shopId: cfg.shopId,
            machineId: cfg.machineId,
            label: cfg.label,
            version: "ext-" + chrome.runtime.getManifest().version,
            ua: navigator.userAgent,
            ts: new Date().toISOString()
        });

        logSocket("💓 Heartbeat sent", {
            socketId: socket.id,
            machineId: cfg.machineId
        });
    }, 15000);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function pullPendingTasks(cfg) {
    if (!socket || !socket.connected) return;

    socket.emit("client:pull_pending_tasks", {
        shopId: cfg.shopId,
        machineId: cfg.machineId
    }, (ack) => {
        logSocket("🔁 Pull pending tasks response", ack);
    });
}

export async function pullPendingTasksNow() {
    const cfg = await getSocketConfig();

    if (!socket || !socket.connected) {
        logSocket("🔁 Pull pending tasks skipped: socket not connected", {
            shopId: cfg.shopId,
            machineId: cfg.machineId
        });

        return {
            ok: false,
            skipped: true,
            reason: "socket_not_connected",
            shopId: cfg.shopId,
            machineId: cfg.machineId
        };
    }

    pullPendingTasks(cfg);

    return {
        ok: true,
        shopId: cfg.shopId,
        machineId: cfg.machineId
    };
}

export async function connectSocket(force = false) {
    console.log("[LNG][SOCKET] connectSocket called", { force });
    if (connectBusy) {
        return {
            ok: false,
            message: "Socket connect skipped: busy"
        };
    }

    connectBusy = true;

    try {
        const cfg = await getSocketConfig();

        logSocket("🔌 Connecting socket...", {
            force,
            socketBaseUrl: cfg.socketBaseUrl,
            shopId: cfg.shopId,
            machineId: cfg.machineId,
            label: cfg.label
        });

        if (!cfg.socketBaseUrl) {
            return {
                ok: false,
                message: "Missing socketBaseUrl. Kiểm tra Backend URL."
            };
        }

        if (!cfg.shopId || !/^[a-f0-9]{24}$/i.test(cfg.shopId)) {
            return {
                ok: false,
                message: "Missing or invalid Mongo Shop ID. Cần ObjectId 24-hex."
            };
        }

        if (!force && socket?.connected) {
            return {
                ok: true,
                message: "already connected",
                socketId: socket.id
            };
        }

        if (socket) {
            try {
                socket.disconnect();
            } catch { }

            socket = null;
            stopHeartbeat();
        }

        socket = io(cfg.socketBaseUrl, {
            path: SOCKET_PATH,
            transports: ["websocket"],
            auth: {
                shopId: cfg.shopId,
                machineId: cfg.machineId,
                label: cfg.label,
                version: "ext-" + chrome.runtime.getManifest().version,
                ua: navigator.userAgent
            },
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 2000,
            reconnectionDelayMax: 10000,
            timeout: 30000
        });

        socket.on("connect", () => {
            logSocket("✅ Socket connected", {
                socketId: socket.id,
                machineId: cfg.machineId
            });

            logExtensionEvent({
                machineId: cfg.machineId,
                shopId: cfg.shopId,
                shopName: cfg.label,
                service: "SOCKET",
                logType: "connection_status",
                level: "info",
                message: "Extension socket connected",
                rawData: {
                    socketId: socket.id
                }
            });

            startHeartbeat();
            pullPendingTasks(cfg);
        });

        socket.on("disconnect", (reason) => {
            logSocket("❌ Socket disconnected", { reason });
            stopHeartbeat();

            logExtensionEvent({
                machineId: cfg.machineId,
                shopId: cfg.shopId,
                shopName: cfg.label,
                service: "SOCKET",
                logType: "connection_status",
                level: "warn",
                message: `Extension socket disconnected: ${reason}`,
                rawData: {
                    reason
                }
            });

            if (reason === "io server disconnect") {
                connectSocket(true);
            }
        });

        socket.on("connect_error", (error) => {
            logSocket("❌ Socket connect_error", {
                message: error?.message,
                type: error?.type,
                description: error?.description
            });
        });

        socket.on("reconnect_attempt", (attempt) => {
            logSocket("🔄 Socket reconnect attempt", { attempt });
        });

        socket.on("reconnect", (attempt) => {
            logSocket("✅ Socket reconnected", {
                attempt,
                socketId: socket.id
            });

            logExtensionEvent({
                machineId: cfg.machineId,
                shopId: cfg.shopId,
                shopName: cfg.label,
                service: "SOCKET",
                logType: "connection_status",
                level: "info",
                message: "Extension socket reconnected",
                rawData: {
                    attempt,
                    socketId: socket.id
                }
            });

            startHeartbeat();
            pullPendingTasks(cfg);
        });

        socket.on("server:task", async (task) => {
            const taskId = task?.taskId || task?.payload?.taskId || null;
            const taskType = task?.type || null;
            const taskInfo = getTaskInfoForLog(task, taskId, taskType);

            logSocket("📨 server:task received", task);

            logExtensionEvent({
                machineId: cfg.machineId,
                shopId: cfg.shopId,
                shopName: cfg.label,
                logType: "task_received",
                level: "info",
                message: `Received task ${taskType}`,
                taskInfo
            });

            socket.emit("client:ack", {
                ok: true,
                phase: "received",
                taskId,
                taskType,
                receivedAt: new Date().toISOString(),
                machineId: cfg.machineId,
                socketId: socket.id
            });

            socket.emit("client:task", {
                eventId: `${taskId}:received`,
                taskId,
                type: taskType,
                status: "received",
                shopId: cfg.shopId,
                machineId: cfg.machineId,
                source: "chrome_extension",
                reportedAt: new Date().toISOString(),
                result: {
                    socketId: socket.id
                }
            });

            try {
                if (!socketTaskHandler) {
                    logSocket("⚠️ No socket task handler registered", {
                        taskId,
                        taskType
                    });

                    socket.emit("client:ack", {
                        ok: false,
                        phase: "no_handler",
                        taskId,
                        taskType,
                        machineId: cfg.machineId,
                        socketId: socket.id,
                        at: new Date().toISOString()
                    });

                    return;
                }

                logSocket("⚙️ Handling server task...", {
                    taskId,
                    taskType
                });

                logExtensionEvent({
                    machineId: cfg.machineId,
                    shopId: cfg.shopId,
                    shopName: cfg.label,
                    logType: "task_processing",
                    level: "info",
                    message: `Processing task ${taskType}`,
                    taskInfo
                });

                const result = await socketTaskHandler(task, {
                    socket,
                    cfg
                });

                logSocket("✅ server:task handled", {
                    taskId,
                    taskType,
                    result
                });

                socket.emit("client:ack", {
                    ok: true,
                    phase: "completed",
                    taskId,
                    taskType,
                    result,
                    completedAt: new Date().toISOString(),
                    machineId: cfg.machineId,
                    socketId: socket.id
                });

                socket.emit("client:task", {
                    eventId: `${taskId}:completed`,
                    taskId,
                    type: taskType,
                    status: "completed",
                    shopId: cfg.shopId,
                    machineId: cfg.machineId,
                    source: "chrome_extension",
                    reportedAt: new Date().toISOString(),
                    result
                });

                logExtensionEvent({
                    machineId: cfg.machineId,
                    shopId: cfg.shopId,
                    shopName: cfg.label,
                    logType: "task_completed",
                    level: "info",
                    message: `Completed task ${taskType}`,
                    taskInfo,
                    rawData: {
                        ok: result?.ok,
                        skipped: result?.skipped,
                        reason: result?.reason
                    }
                });
            } catch (error) {
                logSocket("❌ server:task failed", {
                    taskId,
                    taskType,
                    message: error?.message || String(error)
                });

                socket.emit("client:ack", {
                    ok: false,
                    phase: "failed",
                    taskId,
                    taskType,
                    message: error?.message || String(error),
                    failedAt: new Date().toISOString(),
                    machineId: cfg.machineId,
                    socketId: socket.id
                });

                socket.emit("client:task", {
                    eventId: `${taskId}:failed`,
                    taskId,
                    type: taskType,
                    status: "failed",
                    shopId: cfg.shopId,
                    machineId: cfg.machineId,
                    source: "chrome_extension",
                    reportedAt: new Date().toISOString(),
                    error: {
                        message: error?.message || String(error),
                        stack: error?.stack || null
                    }
                });

                logExtensionEvent({
                    machineId: cfg.machineId,
                    shopId: cfg.shopId,
                    shopName: cfg.label,
                    logType: "task_failed",
                    level: "error",
                    message: `Failed task ${taskType}: ${error?.message || String(error)}`,
                    taskInfo,
                    errorInfo: {
                        errorMessage: error?.message || String(error),
                        stackTrace: error?.stack || null,
                        context: {
                            taskId,
                            taskType
                        }
                    }
                });
            }
        });

        return {
            ok: true,
            message: "connecting",
            socketBaseUrl: cfg.socketBaseUrl,
            machineId: cfg.machineId
        };
    } catch (error) {
        logSocket("❌ connectSocket exception", {
            message: error?.message || String(error)
        });
        console.error("[LNG][SOCKET][CONNECT_ERROR]", error);
        return {
            ok: false,
            message: error?.message || String(error)
        };
    } finally {
        connectBusy = false;
    }
}

export async function disconnectSocket() {
    if (socket) {
        socket.disconnect();
        socket = null;
    }

    stopHeartbeat();

    return {
        ok: true,
        message: "Socket disconnected"
    };
}

export async function getSocketStatus() {
    const cfg = await getSocketConfig();

    return {
        ok: true,
        connected: !!socket?.connected,
        socketId: socket?.id || null,
        socketBaseUrl: cfg.socketBaseUrl,
        shopId: cfg.shopId,
        machineId: cfg.machineId,
        label: cfg.label
    };
}

export async function emitSocketEvent(eventName, payload = {}, ackTimeoutMs = 8000) {
    const cfg = await getSocketConfig();

    if (!socket || !socket.connected) {
        logSocket("⚠️ emitSocketEvent skipped: socket not connected", {
            eventName,
            shopId: cfg.shopId,
            machineId: cfg.machineId
        });

        return {
            ok: false,
            skipped: true,
            reason: "socket_not_connected",
            eventName,
            shopId: cfg.shopId,
            machineId: cfg.machineId
        };
    }

    return await new Promise((resolve) => {
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;

            logSocket("⚠️ emitSocketEvent ack timeout", {
                eventName,
                ackTimeoutMs
            });

            resolve({
                ok: false,
                timeout: true,
                reason: "ack_timeout",
                eventName
            });
        }, ackTimeoutMs);

        socket.emit(eventName, {
            ...payload,
            shopId: payload.shopId || cfg.shopId,
            machineId: payload.machineId || cfg.machineId,
            source: "chrome_extension",
            reportedAt: new Date().toISOString()
        }, (ack) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            logSocket("📤 emitSocketEvent ack", {
                eventName,
                ack
            });

            resolve({
                ok: true,
                eventName,
                ack
            });
        });
    });
}

// export function initSocketMessages() {
//   chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
//     console.log("[LNG][SOCKET_MESSAGES] incoming message", {
//       msg,
//       senderId: sender?.id
//     });

//     if (!msg || typeof msg !== "object") {
//       console.warn("[LNG][SOCKET_MESSAGES] ignored: invalid message", msg);
//       return false;
//     }

//     const socketTypes = new Set([
//       "SOCKET_CONNECT",
//       "SOCKET_DISCONNECT",
//       "SOCKET_STATUS"
//     ]);

//     if (!socketTypes.has(msg.type)) {
//       console.log("[LNG][SOCKET_MESSAGES] ignored: not socket type", {
//         type: msg.type,
//         action: msg.action
//       });
//       return false;
//     }

//     console.log("[LNG][SOCKET_MESSAGES] matched socket type", {
//       type: msg.type
//     });

//     (async () => {
//       try {
//         if (msg.type === "SOCKET_CONNECT") {
//           console.log("[LNG][SOCKET_MESSAGES] before connectSocket");

//           const response = await connectSocket(true);

//           console.log("[LNG][SOCKET_MESSAGES] SOCKET_CONNECT response", response);

//           sendResponse(response);
//           return;
//         }

//         if (msg.type === "SOCKET_DISCONNECT") {
//           const response = await disconnectSocket();

//           console.log("[LNG][SOCKET_MESSAGES] SOCKET_DISCONNECT response", response);

//           sendResponse(response);
//           return;
//         }

//         if (msg.type === "SOCKET_STATUS") {
//           const response = await getSocketStatus();

//           console.log("[LNG][SOCKET_MESSAGES] SOCKET_STATUS response", response);

//           sendResponse(response);
//           return;
//         }
//       } catch (error) {
//         console.error("[LNG][SOCKET_MESSAGES][ERROR]", error);

//         sendResponse({
//           ok: false,
//           message: error?.message || String(error)
//         });
//       }
//     })();

//     return true;
//   });
// }

export async function autoConnectSocketIfReady() {
    const cfg = await getSocketConfig();

    if (!cfg.autoConnectSocket) {
        logSocket("⏸️ Auto socket connect disabled");
        return {
            ok: false,
            skipped: true,
            reason: "autoConnectSocket disabled"
        };
    }

    if (!cfg.socketBaseUrl || !cfg.shopId) {
        logSocket("⏸️ Auto socket skipped: missing config", {
            socketBaseUrl: cfg.socketBaseUrl,
            shopId: cfg.shopId
        });

        return {
            ok: false,
            skipped: true,
            reason: "missing config"
        };
    }

    return connectSocket(true);
}
