export const ETSY_TAB_READY_TIMEOUT_MS = 60000;

export function isTabComplete(tab) {
  return Boolean(tab && tab.status === "complete");
}

export function waitForTabCompleteWithTimeout(tabsApi, tabId, options = {}) {
  const timeoutMs = Number.parseInt(options.timeoutMs, 10) || ETSY_TAB_READY_TIMEOUT_MS;
  const label = options.label || "tab";

  return new Promise((resolve, reject) => {
    let timer = null;
    let listener = null;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (listener) {
        tabsApi.onUpdated.removeListener(listener);
        listener = null;
      }
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    tabsApi.get(tabId)
      .then((tab) => {
        if (isTabComplete(tab)) {
          finish(resolve);
          return;
        }

        listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tabId && changeInfo?.status === "complete") {
            finish(resolve);
          }
        };

        tabsApi.onUpdated.addListener(listener);
        timer = setTimeout(() => {
          finish(reject, new Error(`Timeout waiting for ${label}`));
        }, timeoutMs);
      })
      .catch((error) => finish(reject, error));
  });
}

export async function ensurePageTabReady(options = {}) {
  const {
    tabsApi,
    queryUrl,
    targetUrl,
    isTargetTab,
    timeoutMs = ETSY_TAB_READY_TIMEOUT_MS,
    label = "tab",
    logger = console,
    initialTabs = null
  } = options;

  if (!tabsApi) throw new Error("tabsApi is required");
  if (!queryUrl) throw new Error("queryUrl is required");
  if (!targetUrl) throw new Error("targetUrl is required");
  if (typeof isTargetTab !== "function") throw new Error("isTargetTab is required");

  const tabs = Array.isArray(initialTabs)
    ? initialTabs
    : await tabsApi.query({ url: queryUrl });
  const existingTab = tabs.find(isTargetTab);

  if (existingTab) {
    try {
      await waitForTabCompleteWithTimeout(tabsApi, existingTab.id, { timeoutMs, label });
      return await tabsApi.get(existingTab.id);
    } catch (error) {
      logger.warn?.("[LNG][sw] existing target tab did not finish loading; reloading", {
        tabId: existingTab.id,
        url: existingTab.url || "",
        status: existingTab.status || "",
        message: error?.message || String(error)
      });

      const reloadedTab = await tabsApi.update(existingTab.id, {
        active: true,
        url: targetUrl
      });
      await waitForTabCompleteWithTimeout(tabsApi, reloadedTab.id, { timeoutMs, label });
      return await tabsApi.get(reloadedTab.id);
    }
  }

  const newTab = await tabsApi.create({ active: true, url: targetUrl });
  await waitForTabCompleteWithTimeout(tabsApi, newTab.id, { timeoutMs, label });
  return await tabsApi.get(newTab.id);
}
