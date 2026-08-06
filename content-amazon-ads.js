if (!window.__LNG_AMAZON_ADS_WORKER_INJECTED__) {
  window.__LNG_AMAZON_ADS_WORKER_INJECTED__ = true;

  console.log("[LNG][ads-content] content-amazon-ads.js injected", {
    url: location.href
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("[LNG][ads-content] onMessage", {
      action: message?.action
    });

    if (message.action === "CONTENT_AMAZON_ADS_EXPORT") {
      exportAmazonAdsSpend(message.payload || {})
        .then((data) => {
          sendResponse({
            ok: true,
            data
          });
        })
        .catch((error) => {
          console.error("[LNG][ads-content][EXPORT_ERROR]", error);

          sendResponse({
            ok: false,
            message: error.message || "Failed to export Amazon Ads spend"
          });
        });

      return true;
    }
  });
} else {
  console.log("[LNG][ads-content] already injected, skip");
}

const ADS_BASE = "https://advertising.amazon.com";
const RETRIEVE_REPORT_URL =
  "https://advertising.amazon.com/a9g-api-gateway/cm/dds/retrieveReport";

async function exportAmazonAdsSpend(payload = {}) {
  const date = String(payload.date || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Missing or invalid Ads date YYYY-MM-DD");
  }

  console.log("[LNG][ads-content] exportAmazonAdsSpend start", { date });

  const rows = await fetchAllCampaignSpend({
    startDate: date,
    endDate: date,
    pageSize: 300
  });

  const txt = campaignRowsToTxt(rows);

  return {
    ok: true,
    date,
    rows,
    txt,
    summary: {
      rowCount: rows.length,
      totalSpend: rows.reduce((sum, r) => sum + Number(r.spend || 0), 0)
    }
  };
}

function buildCampaignSpendPayload({
  startDate,
  endDate,
  size,
  offset,
  timeUnit = "DAILY"
}) {
  return {
    reportConfig: {
      reportId: "CrossProgramCampaignReport",
      currencyOfView: "USD",
      endDate,
      fields: ["campaignName", "spend", "state"],
      filter: {
        and: [
          {
            comparisonOperator: "IN",
            field: "state",
            not: false,
            values: ["ENABLED", "PAUSED"]
          }
        ]
      },
      offsetPagination: {
        size,
        offset
      },
      startDate,
      timeUnits: [timeUnit]
    }
  };
}

async function fetchAllCampaignSpend({ startDate, endDate, pageSize = 300 }) {
  const size = Math.max(1, Math.min(Number(pageSize) || 300, 300));

  const first = await fetchAdsReportPage({
    startDate,
    endDate,
    size,
    offset: 0
  });

  const totalRecords = Number(first.count || 0);
  const totalPages = Math.ceil(totalRecords / size);

  console.log("[LNG][ads-content] pagination", {
    totalRecords,
    totalPages,
    pageSize: size
  });

  let allRows = [...first.rows];

  for (let pageIndex = 1; pageIndex < totalPages; pageIndex++) {
    const page = await fetchAdsReportPage({
      startDate,
      endDate,
      size,
      offset: pageIndex * size
    });

    console.log("[LNG][ads-content] Amazon Ads page response", {
      page: pageIndex + 1,
      totalPages,
      rows: page.rows.length
    });

    if (!page.rows.length) break;

    allRows = allRows.concat(page.rows);

    await sleep(300);
  }

  const processed = allRows
    .map((r) => ({
      campaignName: String(r.campaignName || "").trim(),
      date: startDate,
      spend: Number(r.spend || 0),
      state: String(r.state || "")
    }))
    .filter((r) => r.campaignName && r.spend > 0);

  console.log("[LNG][ads-content] processed", {
    rawRows: allRows.length,
    keptRows: processed.length,
    totalSpend: processed.reduce((sum, r) => sum + r.spend, 0)
  });

  return processed;
}

async function fetchAdsReportPage({ startDate, endDate, size, offset }) {
  const payload = buildCampaignSpendPayload({
    startDate,
    endDate,
    size,
    offset
  });

  const json = await fetchAdsJson(payload);

  const report = json?.report || json?.data?.report || {};

  return {
    count: Number(report?.numberOfRecords || 0),
    rows: Array.isArray(report?.data) ? report.data : []
  };
}

async function fetchAdsJson(payload) {
  const headers = await buildAdsHeaders();

  const response = await fetch(RETRIEVE_REPORT_URL, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  console.log("[LNG][ads-content] retrieveReport response", {
    status: response.status,
    ok: response.ok,
    preview: text.slice(0, 300)
  });

  if (!response.ok) {
    throw new Error(`retrieveReport ${response.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`retrieveReport non-JSON: ${text.slice(0, 300)}`);
  }
}

async function buildAdsHeaders() {
  const cfg = await chrome.storage.local.get([
    "adsAccountId",
    "adsAdvertiserId",
    "adsClientId",
    "adsMarketplaceId",
    "adsCsrfData",
    "adsCsrfToken"
  ]);

  const missing = [];

  if (!cfg.adsAccountId) missing.push("adsAccountId");
  if (!cfg.adsAdvertiserId) missing.push("adsAdvertiserId");
  if (!cfg.adsClientId) missing.push("adsClientId");
  if (!cfg.adsMarketplaceId) missing.push("adsMarketplaceId");
  if (!cfg.adsCsrfData) missing.push("adsCsrfData");
  if (!cfg.adsCsrfToken) missing.push("adsCsrfToken");

  if (missing.length) {
    throw new Error(`Missing Amazon Ads headers: ${missing.join(", ")}`);
  }

  return {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/json;charset=UTF-8",
    "Amazon-Ads-Account-Id": cfg.adsAccountId,
    "Amazon-Advertising-Api-Advertiserid": cfg.adsAdvertiserId,
    "Amazon-Advertising-Api-Clientid": cfg.adsClientId,
    "Amazon-Advertising-Api-Marketplaceid": cfg.adsMarketplaceId,
    "Amazon-Advertising-Api-Csrf-Data": cfg.adsCsrfData,
    "Amazon-Advertising-Api-Csrf-Token": cfg.adsCsrfToken,
    "Advertisertype": "SELLER"
  };
}

function campaignRowsToTxt(rows) {
  const header = "Campaigns\tDate\tSpend";

  const lines = rows.map((r) =>
    [
      String(r.campaignName || "").replace(/\t/g, " ").replace(/\r?\n/g, " "),
      r.date,
      Number(r.spend || 0)
    ].join("\t")
  );

  return [header, ...lines].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}