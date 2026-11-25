const COMMAND_ROOT = "/api/integration/extension-commands";

function error(message, code, status = null) {
  return Object.assign(new Error(message), { code, status });
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw error("Invalid API base URL", "API_BASE_URL_INVALID");
  return url.origin;
}

function assertToken(value) {
  const token = String(value || "").trim();
  if (!token.startsWith("lng_ext_")) throw error("Extension Token is required", "EXTENSION_TOKEN_REQUIRED");
  return token;
}

export function createLngWebBeCommandClient({ fetchImpl = fetch, getConfig, logger }) {
  async function request(path, body, method = 'POST', root = COMMAND_ROOT, timeoutMs) {
    const cfg = await getConfig();
    const apiBaseUrl = normalizeBaseUrl(cfg.apiBaseUrl);
    const extensionToken = assertToken(cfg.extensionToken);
    const response = await fetchImpl(`${apiBaseUrl}${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${extensionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw error(payload?.message || `LNG Web BE request failed (${response.status})`, "LNG_WEB_BE_REQUEST_FAILED", response.status);
    }
    return payload.data;
  }

  async function agentBody(extra = {}) {
    const cfg = await getConfig();
    return {
      clientId: String(cfg.clientId || "").trim(),
      label: String(cfg.label || "").trim(),
      version: cfg.version || null,
      apiBaseUrl: normalizeBaseUrl(cfg.apiBaseUrl),
      ...(cfg.provider === 'ETSY' ? { provider: 'ETSY', protocolVersion: 1 } : {}),
      ...extra,
    };
  }

  async function uploadCsv(path, filename, csv, idempotencyKey, fields = {}) {
    const cfg = await getConfig();
    const apiBaseUrl = normalizeBaseUrl(cfg.apiBaseUrl);
    const extensionToken = assertToken(cfg.extensionToken);
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
    form.set("file", csv instanceof Blob ? csv : new Blob([csv], { type: "text/csv" }), filename);
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${extensionToken}`,
        ...(idempotencyKey ? { "Idempotency-Key": String(idempotencyKey) } : {}),
      },
      body: form,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      throw error(payload?.message || `LNG Web BE upload failed (${response.status})`, "LNG_WEB_BE_UPLOAD_FAILED", response.status);
    }
    return payload.data;
  }

  const client = {
    async isConfigured() {
      const cfg = await getConfig();
      try {
        normalizeBaseUrl(cfg.apiBaseUrl);
        assertToken(cfg.extensionToken);
        return Boolean(String(cfg.clientId || "").trim() && String(cfg.label || "").trim());
      } catch {
        return false;
      }
    },
    async heartbeat() {
      return request("/agent/heartbeat", await agentBody());
    },
    async claimNext() {
      return request("/agent/claim", await agentBody());
    },
    async start(commandId, leaseToken) {
      return request(`/agent/commands/${encodeURIComponent(commandId)}/start`, await agentBody({ leaseToken }));
    },
    async renew(commandId, leaseToken, { importJobId } = {}) {
      return request(`/agent/commands/${encodeURIComponent(commandId)}/renew`, await agentBody({ leaseToken, ...(importJobId ? { importJobId } : {}) }), 'POST', COMMAND_ROOT, 5000);
    },
    async complete(commandId, payload) {
      return request(`/agent/commands/${encodeURIComponent(commandId)}/complete`, await agentBody(payload), 'POST', COMMAND_ROOT, 10000);
    },
    uploadCsv,
    getIdentity() {
      return request('/me', undefined, 'GET', '/api/auth');
    },
    getImportProgress(jobId) {
      return request(`/${encodeURIComponent(jobId)}/progress`, undefined, 'GET', '/api/integration/external-order-imports');
    },
    uploadImportAsset(jobId, blob, filename, sha256) {
      return uploadCsv(`/api/integration/external-order-imports/${encodeURIComponent(jobId)}/etsy-assets`, filename, blob, sha256, { sha256 });
    },
    attachManifest(jobId, entries) {
      return request(`/${encodeURIComponent(jobId)}/etsy-customization-manifest`, { entries }, 'POST', '/api/integration/external-order-imports');
    },
  };
  let command = {};
  let lastProgress;
  let lastRenewal = 0;
  client.setCommandContext = (value) => { command = { id: value.id, type: value.type, origin: value.origin }; };
  const emit = async (stage, message, extra = {}, failed = false) => {
    if (!logger) return;
    const context = { commandId: command.id, taskType: command.type || 'COMMAND', origin: command.origin, stage, ...extra };
    try {
      if (failed) await logger.logError(null, context, message);
      else await logger.logInfo(message, context);
    } catch { /* Diagnostics must not interrupt a command. */ }
  };
  client.logProgress = (stage, message, extra = {}) => emit(stage, message, extra);
  for (const method of ['heartbeat', 'claimNext', 'start', 'renew', 'complete', 'uploadCsv', 'getImportProgress', 'uploadImportAsset', 'attachManifest']) {
    const original = client[method];
    client[method] = async (...args) => {
      if (['start', 'renew', 'complete'].includes(method)) command = { ...command, id: args[0] };
      if (method === 'uploadCsv') await emit('UPLOAD_STARTED', 'Uploading import data');
      if (method === 'uploadImportAsset') await emit('ASSET_UPLOAD', 'Uploading customization asset', { importJobId: args[0] });
      if (method === 'attachManifest') await emit('MANIFEST_ATTACH', 'Attaching customization assets', { importJobId: args[0], itemCount: args[1].length });
      try {
        const result = await original(...args);
        if (method === 'claimNext' && result?.command) {
          command = result.command; lastProgress = undefined; lastRenewal = 0;
          await emit('CLAIMED', 'Command received', { activityStatus: 'CLAIMED' });
        }
        if (['start', 'renew'].includes(method)) {
          if (result?.type) command = { ...command, type: result.type, origin: result.origin };
          if (method === 'start') await emit('STARTED', 'Command started', { activityStatus: 'RUNNING' });
          else if (Date.now() - lastRenewal >= 300000) {
            lastRenewal = Date.now();
            await emit('LEASE_RENEWED', 'Lease renewed; this does not indicate processing progress');
          }
        }
        if (method === 'complete') {
          const status = result?.status || (args[1].success ? 'SUCCEEDED' : 'FAILED');
          await emit('COMPLETED', 'Backend acknowledged command result', { activityStatus: status, importedCount: args[1].importedCount, failedCount: args[1].failedCount }, status !== 'SUCCEEDED');
        }
        if (method === 'uploadCsv') await emit('IMPORT_CREATED', 'Backend accepted import', { importJobId: result?.jobId || result?.importBatchId || result?.id });
        if (method === 'getImportProgress') {
          const progress = { importJobId: args[0], importStatus: result?.job?.status, importedCount: result?.job?.importedCount, failedCount: result?.job?.failedCount };
          const signature = JSON.stringify(progress);
          if (signature !== lastProgress) { lastProgress = signature; await emit('IMPORT_PROGRESS', 'Import progress updated', progress); }
        }
        return result;
      } catch (error) {
        const connection = ['heartbeat', 'claimNext'].includes(method);
        const leaseLost = method === 'renew' && [401, 403, 404, 409].includes(error?.status);
        await emit('REQUEST_FAILED', `Command request failed: ${method}`, {
          ...(connection ? { commandId: undefined, taskType: 'CONNECTION' } : {}),
          operation: method, httpStatus: error?.status || null,
          errorCode: /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : null,
          activityStatus: leaseLost ? 'LEASE_LOST' : 'RETRYING',
        }, true);
        throw error;
      }
    };
  }
  return client;
}
