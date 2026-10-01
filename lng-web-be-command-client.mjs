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

export function createLngWebBeCommandClient({ fetchImpl = fetch, getConfig }) {
  async function request(path, body) {
    const cfg = await getConfig();
    const apiBaseUrl = normalizeBaseUrl(cfg.apiBaseUrl);
    const extensionToken = assertToken(cfg.extensionToken);
    const response = await fetchImpl(`${apiBaseUrl}${COMMAND_ROOT}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${extensionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
      ...extra,
    };
  }

  return {
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
    async complete(commandId, payload) {
      return request(`/agent/commands/${encodeURIComponent(commandId)}/complete`, await agentBody(payload));
    },
  };
}
