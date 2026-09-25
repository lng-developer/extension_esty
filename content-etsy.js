if (!window.__LNG_ETSY_WORKER_INJECTED__) {
    window.__LNG_ETSY_WORKER_INJECTED__ = true;

    console.log("[LNG][content] content-etsy.js injected", { url: location.href });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("[LNG][content] onMessage", { action: message?.action });

        if (message.action === "CONTENT_ETSY_GET_ORDERS") {
            getEtsyOrders(message.payload)
                .then((data) => {
                    console.log("[LNG][content] CONTENT_ETSY_GET_ORDERS done", {
                        totalOrders: data?.orders?.length,
                        shopId: data?.shopId,
                        dataKeys: Object.keys(data || {})
                    });
                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    console.error("[LNG][content][CONTENT_ETSY_GET_ORDERS_ERROR]", error);

                    sendResponse({
                        ok: false,
                        message: error.message || "Failed to get Etsy orders"
                    });
                });

            return true;
        }
        if (message.action === "CONTENT_ETSY_SCAN_ORDER_DETAIL_DOM_CUSTOM_FILES") {
            scanOrderDetailDomForCustomFiles(message.payload || {})
                .then((data) => {
                    console.log("[LNG][content] CONTENT_ETSY_SCAN_ORDER_DETAIL_DOM_CUSTOM_FILES done", {
                        targetOrderId: data?.targetOrderId,
                        acceptedFiles: data?.customFiles?.length || 0
                    });
                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    console.error("[LNG][content][CONTENT_ETSY_SCAN_ORDER_DETAIL_DOM_CUSTOM_FILES_ERROR]", error);

                    sendResponse({
                        ok: false,
                        message: error.message || "Failed to scan Etsy order detail DOM custom files"
                    });
                });

            return true;
        }
        if (message.action === "CONTENT_ETSY_SYNC_LISTINGS") {
            syncEtsyListings(message.payload)
                .then((data) => {
                    console.log("[LNG][content] CONTENT_ETSY_SYNC_LISTINGS done", {
                        etsyShopId: data?.etsyShopId,
                        shopName: data?.shopName,
                        totalListings: data?.listings?.length,
                        summary: data?.summary
                    });

                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    console.error("[LNG][content][CONTENT_ETSY_SYNC_LISTINGS_ERROR]", error);

                    sendResponse({
                        ok: false,
                        message: error.message || "Failed to sync Etsy listings"
                    });
                });

            return true;
        }
        if (message.action === "CONTENT_ETSY_UPLOAD_TRACKING") {
            uploadTrackingToEtsy(message.payload)
                .then((data) => {
                    console.log("[LNG][content] CONTENT_ETSY_UPLOAD_TRACKING done", data);

                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    console.error("[LNG][content][CONTENT_ETSY_UPLOAD_TRACKING_ERROR]", error);

                    sendResponse({
                        ok: false,
                        message: error.message || "Failed to upload Etsy tracking"
                    });
                });

            return true;
        }
        if (message.action === "CONTENT_ETSY_MESSAGE_SYNC_DEBUG") {
            syncEtsyMessagesDebug(message.payload || {})
                .then((data) => {
                    console.log("[LNG][content][ETSY_MESSAGE_SYNC_DEBUG] done", data);

                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    console.error("[LNG][content][ETSY_MESSAGE_SYNC_DEBUG_ERROR]", error);

                    sendResponse({
                        ok: false,
                        message: error.message || "Failed to debug sync Etsy messages"
                    });
                });

            return true;
        }
        if (message.action === "CONTENT_ETSY_ADS_EXPORT") {
            exportEtsyAdsSpend(message.payload)
                .then((data) => {
                    console.log("[LNG][content] CONTENT_ETSY_ADS_EXPORT done", data);

                    sendResponse({
                        ok: true,
                        data
                    });
                })
                .catch((error) => {
                    console.error("[LNG][content][CONTENT_ETSY_ADS_EXPORT_ERROR]", error);

                    sendResponse({
                        ok: false,
                        message: error.message || "Failed to export Etsy Ads spend"
                    });
                });

            return true;
        }
    });
} else {
    console.log("[LNG][content] already injected, skip");
}

function logSkuDebugStage(stage, payload = {}) {
    try {
        console.log(`[LNG][content][SKU_DEBUG][${stage}]`, payload);
    } catch (error) {
        console.warn("[LNG][content][SKU_DEBUG][LOG_ERROR]", {
            stage,
            message: error?.message || String(error)
        });
    }
}

async function getEtsyOrders(payload = {}) {
    const pageSize = Math.max(1, Math.min(Number(payload.pageSize || payload.limit || 50) || 50, 100));
    const maxTotalOrders = Math.max(1, Math.min(Number(payload.maxTotalOrders || payload.limit || 50) || 50, 200));
    const includeCustomizations = payload.includeCustomizations !== false;
    const includeCustomFiles = payload.includeCustomFiles !== false;
    const customFileDetailMode = payload.customFileDetailMode || "auto_upload_detail";
    const targetOrderId = String(payload.targetOrderId || payload.orderId || "").trim();

    console.log("[LNG][content] getEtsyOrders start", {
        pageSize,
        maxTotalOrders,
        includeCustomizations,
        includeCustomFiles,
        customFileDetailMode,
        targetOrderId
    });

    const soldPageUrl = "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav";
    console.log("[LNG][content] fetch sold page", soldPageUrl);

    const soldPageHtml = await fetchText(soldPageUrl);
    console.log("[LNG][content] sold page html length", soldPageHtml.length);

    const bootstrap = parseEtsyBootstrap(soldPageHtml);
    console.log("[LNG][content] bootstrap parsed", {
        shopId: bootstrap.shopId,
        shopName: bootstrap.shopName,
        orderStatesCount: bootstrap.orderStates.length,
        orderStates: bootstrap.orderStates
    });

    if (!bootstrap.shopId) {
        throw new Error("Không tìm thấy shopId. Hãy kiểm tra đã login Etsy seller chưa.");
    }

    if (!bootstrap.orderStates.length) {
        throw new Error("Không tìm thấy orderStates từ Etsy sold page.");
    }

    const stateResults = [];

    for (const state of bootstrap.orderStates) {
        console.log("[LNG][content] collect state ->", state);
        const result = await collectOrdersByState({
            shopId: bootstrap.shopId,
            orderStateId: state.order_state_id,
            orderStateName: state.name,
            limit: pageSize,
            maxTotalOrders,
            targetOrderId
        });
        console.log("[LNG][content] collect state <-", {
            state: state.name,
            orderIds: result.order_ids.length,
            totalCount: result.__state?.totalCount,
            targetFound: targetOrderId ? result.order_ids.some((id) => String(id) === targetOrderId) : false
        });

        stateResults.push(result);

        if (targetOrderId && result.order_ids.some((id) => String(id) === targetOrderId)) {
            console.log("[LNG][content] target order found, stop state scan", {
                targetOrderId,
                state: state.name
            });
            break;
        }
    }

    const raw = mergeRawOrderData(stateResults);
    if (targetOrderId) {
        raw.order_ids = raw.order_ids.filter((id) => String(id) === targetOrderId);
    }
    console.log("[LNG][content] merged raw", {
        orderIds: raw.order_ids.length,
        buyers: Object.keys(raw.buyers).length,
        orders: Object.keys(raw.orders).length,
        total_count: raw.total_count,
        targetOrderId
    });

    let orders = mapOrders({
        raw,
        shopName: bootstrap.shopName,
        orderStates: bootstrap.orderStates
    }).filter((o) => !targetOrderId || String(o.orderId) === targetOrderId);

    if (targetOrderId && !orders.length) {
        throw new Error(`Target Etsy order not found: ${targetOrderId}`);
    }

    if (!targetOrderId) {
        const beforeSlice = orders.length;
        orders = orders
            .slice()
            .sort((a, b) => getOrderSortTime(b) - getOrderSortTime(a))
            .slice(0, maxTotalOrders);

        console.log("[LNG][content][IMPORT_LIMIT][FINAL_SLICE]", {
            beforeSlice,
            afterSlice: orders.length,
            maxTotalOrders,
            sampleOrderIds: orders.slice(0, 10).map((o) => o.orderId)
        });
    }

    await enrichOrdersWithCustomData({
        orders,
        shopId: bootstrap.shopId,
        includeCustomizations,
        includeCustomFiles,
        customFileDetailMode,
        targetOrderId
    });

    console.log("[LNG][content] mapped orders", { count: orders.length });

    logOrdersDetail(orders);

    const backendOrders = orders.map((o) =>
        toBackendOrder(o, {
            etsyShopId: String(bootstrap.shopId),
            shopName: bootstrap.shopName
        })
    );

    logBackendOrders(backendOrders);
    logFakeFields();

    const skuAudit = backendOrders.flatMap((order) =>
        (order.items || []).map((item) => ({
            orderId: order.orderId,
            transactionId: item.transactionId,
            listingId: item.listingId,
            itemName: String(item.itemName || "").slice(0, 80),
            sku: item.sku || "",
            hasSku: !!item.sku,
            sellerCode: order.seller?.sellerCode || ""
        }))
    );

    console.log("[LNG][content][SKU_DEBUG][FINAL_SKU_AUDIT_TABLE]");
    console.table(skuAudit);

    console.log("[LNG][content][SKU_DEBUG][FINAL_SKU_AUDIT_SUMMARY]", {
        totalItems: skuAudit.length,
        itemsWithSku: skuAudit.filter((x) => x.hasSku).length,
        itemsMissingSku: skuAudit.filter((x) => !x.hasSku).length,
        missingSkuItems: skuAudit.filter((x) => !x.hasSku)
    });

    return {
        platform: "etsy",
        shopId: bootstrap.shopId,
        shopName: bootstrap.shopName,
        orders: backendOrders,
        debugOrders: orders,
        meta: {
            states: bootstrap.orderStates,
            rawOrderIds: raw.order_ids,
            totalOrders: backendOrders.length,
            pageSize,
            maxTotalOrders,
            totalOrdersReturned: backendOrders.length,
            importLimitMode: targetOrderId ? "target_order" : "latest_orders",
            syncedAt: new Date().toISOString()
        }
    };
}

function getOrderSortTime(order = {}) {
    const candidates = [
        order.orderDate,
        order.purchaseDate,
        order.saleDate,
        order.createdAt,
        order.paidAt
    ];

    for (const value of candidates) {
        const time = new Date(value).getTime();
        if (Number.isFinite(time)) return time;
    }

    return 0;
}

function logFakeFields() {
    // Cac field BE schema yeu cau nhung Etsy AJAX khong tra ve
    // -> extension dang fake / default. Note de team biet.
    const FAKE_NOTES = [
        {
            path: "shopId",
            reason: "Mongo ObjectId - extension lay tu input popup, KHONG phai tu Etsy"
        },
        {
            path: "orderType",
            reason: "Etsy AJAX khong co -> null"
        },
        {
            path: "listingsType",
            reason: "Etsy AJAX khong co -> null"
        },
        {
            path: "paymentType",
            reason: "Etsy AJAX khong co -> null"
        },
        {
            path: "paymentMethod",
            reason: "Etsy AJAX it khi co -> '' (empty) neu khong tra"
        },
        {
            path: "shippedAt",
            reason: "Tu fulfillment.actual_ship_date - thuong null voi don chua ship"
        },
        {
            path: "coupon.code / coupon.details",
            reason: "Etsy AJAX khong tra discount detail -> '' (empty)"
        },
        {
            path: "seller.sellerId",
            reason: "ObjectId User - BE phai tu resolve. Extension gui null"
        },
        {
            path: "seller.sellerCode",
            reason: "DERIVED tu prefix SKU (regex /^[A-Z]\\d{3,5}/), khong phai field goc Etsy"
        },
        {
            path: "shipping_type",
            reason: "Etsy khong co field nay -> default 'Standard'"
        },
        {
            path: "totals.cardProcessingFees",
            reason: "Etsy AJAX khong tra -> 0 (FAKE)"
        },
        {
            path: "totals.orderNet",
            reason: "Etsy AJAX khong tra -> 0 (FAKE)"
        },
        {
            path: "totals.fee",
            reason: "Etsy AJAX khong tra -> 0 (FAKE)"
        },
        {
            path: "totals.adjustedOrderTotal / adjustedCardProcessingFees / adjustedNet / adjustedOrderValue / adjustedShipping / adjustedSalesTax",
            reason: "Etsy AJAX khong tra cac field 'adjusted' (la field cua Etsy CSV SoldOrders) -> 0 (FAKE)"
        },
        {
            path: "totals.inPersonDiscount",
            reason: "Khong co -> 0 (FAKE)"
        },
        {
            path: "totals.vatPaidByBuyer",
            reason: "Khong co -> 0 (FAKE)"
        },
        {
            path: "base_cost / base_cost_computed_at / base_cost_shipping_groups",
            reason: "BE tu compute qua POST /api/etsy/compute-base-cost -> default 0/null/[]"
        },
        {
            path: "address_validation",
            reason: "Smarty validation chay o BE importOrders, khong chay trong endpoint nay -> { isValid: null, smartyResponse: null }"
        },
        {
            path: "items[].cost_breakdown",
            reason: "Etsy AJAX co the tra hoac khong - neu khong -> null"
        },
        {
            path: "items[].baseImage.width / height",
            reason: "FAKE 75x75 (theo image_url_75x75) - Etsy khong tra dim that"
        }
    ];

    console.log("[LNG][content][FAKE_FIELDS] Cac field default/fake (KHONG phai data goc tu Etsy):");
    console.table(FAKE_NOTES);
}

function logBackendItems(backendOrders) {
    // Flatten tat ca items theo dung EtsyOrderItemEmbeddedSchema
    const flatItems = [];

    for (const o of backendOrders) {
        for (const it of o.items || []) {
            flatItems.push({
                orderId: o.orderId, // ngoai schema, them de dinh danh thuoc don nao
                transactionId: it.transactionId,
                listingId: it.listingId,
                sku: it.sku,
                itemName: (it.itemName || "").slice(0, 60),
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                itemTotal: it.itemTotal,
                variationsRaw: (it.variationsRaw || "").slice(0, 80),
                variationsKeys: Object.keys(it.variations || {}).join(","),
                customTextCount: Array.isArray(it.customizations?.textFields)
                    ? it.customizations.textFields.length
                    : 0,
                customFileCount: Array.isArray(it.customFiles) ? it.customFiles.length : 0,
                cost_breakdown: it.cost_breakdown ? "obj" : "null",
                imageUrl: it.baseImage?.imageUrl || "",
                imgW: it.baseImage?.width,
                imgH: it.baseImage?.height
            });
        }
    }

    console.log(
        `[LNG][content][ITEMS] EtsyOrderItemEmbeddedSchema x${flatItems.length} (across ${backendOrders.length} orders)`
    );
    console.table(flatItems);

    // Group collapsed: dump tung item full schema-shape
    console.groupCollapsed(
        `[LNG][content][ITEMS] full payload x${flatItems.length} (click expand)`
    );
    for (const o of backendOrders) {
        for (const it of o.items || []) {
            console.groupCollapsed(`[item] ${it.sku || it.transactionId} | order #${o.orderId}`);

            console.log("transactionId:", it.transactionId);
            console.log("listingId:", it.listingId);
            console.log("sku:", it.sku);
            console.log("itemName:", it.itemName);
            console.log("quantity:", it.quantity);
            console.log("unitPrice:", it.unitPrice);
            console.log("itemTotal:", it.itemTotal);
            console.log("variationsRaw:", it.variationsRaw);
            console.log("variations:", it.variations);
            console.log("customizations:", it.customizations);
            console.log("customFiles:", (it.customFiles || []).map(maskCustomFileForLog));
            console.log("cost_breakdown:", it.cost_breakdown);
            console.log("baseImage:", it.baseImage);

            // JSON full theo schema de copy
            console.log("JSON ↓");
            console.log(JSON.stringify({
                ...it,
                customFiles: (it.customFiles || []).map(maskCustomFileForLog)
            }, null, 2));

            console.groupEnd();
        }
    }
    console.groupEnd();

    // 1 item dau tien dump JSON full de copy nhanh
    if (flatItems.length > 0 && backendOrders[0]?.items?.[0]) {
        console.log("[LNG][content][ITEMS] first item JSON ↓");
        console.log(JSON.stringify({
            ...backendOrders[0].items[0],
            customFiles: (backendOrders[0].items[0].customFiles || []).map(maskCustomFileForLog)
        }, null, 2));
    }
}

function logBackendOrders(backendOrders) {
    if (!backendOrders || !backendOrders.length) {
        console.warn("[LNG][content][BACKEND] empty list");
        return;
    }

    // Bang tom tat theo schema
    const summary = backendOrders.map((o, idx) => ({
        "#": idx + 1,
        orderId: o.orderId,
        status: o.status,
        saleDate: o.saleDate,
        buyer: o.buyer.fullName,
        sellerCode: o.seller.sellerCode,
        items: o.items.length,
        qty: o.numberOfItems,
        orderTotal: o.totals.orderTotal,
        shipping: o.totals.shipping,
        salesTax: o.totals.salesTax,
        currency: o.currency,
        city: o.shipping.city,
        state: o.shipping.state,
        country: o.shipping.country,
        customTextCount: (o.items || []).reduce(
            (sum, item) => sum + (Array.isArray(item.customizations?.textFields) ? item.customizations.textFields.length : 0),
            0
        ),
        customFileCount: (o.items || []).reduce(
            (sum, item) => sum + (Array.isArray(item.customFiles) ? item.customFiles.length : 0),
            0
        )
    }));

    console.log(`[LNG][content][BACKEND] schema-shape orders x${backendOrders.length}`);
    console.table(summary);
    console.log("[LNG][content][BACKEND][CUSTOM_SUMMARY]", {
        totalCustomText: summary.reduce((sum, row) => sum + row.customTextCount, 0),
        totalCustomFiles: summary.reduce((sum, row) => sum + row.customFileCount, 0)
    });

    // === Items theo dung EtsyOrderItemEmbeddedSchema ===
    logBackendItems(backendOrders);

    console.groupCollapsed(
        `[LNG][content][BACKEND] full payload x${backendOrders.length} (click expand)`
    );
    for (const o of backendOrders) {
        console.groupCollapsed(
            `#${o.orderId} | ${o.status} | ${o.buyer.fullName} | $${o.totals.orderTotal} | items=${o.items.length}`
        );

        console.log("orderId:", o.orderId);
        console.log("etsyShopId:", o.etsyShopId, "| shopName:", o.shopName);
        console.log("dates:", {
            saleDate: o.saleDate,
            paidAt: o.paidAt,
            shippedAt: o.shippedAt
        });
        console.log("status:", o.status);
        console.log("classification:", {
            orderType: o.orderType,
            listingsType: o.listingsType,
            paymentType: o.paymentType,
            paymentMethod: o.paymentMethod,
            currency: o.currency
        });
        console.log("buyer:", o.buyer);
        console.log("seller:", o.seller);
        console.log("coupon:", o.coupon);
        console.log("shipping:", o.shipping);
        console.log("shipping_type:", o.shipping_type);
        console.log("totals:", o.totals);
        console.log("base_cost:", o.base_cost, "| base_cost_computed_at:", o.base_cost_computed_at);
        console.log("numberOfItems:", o.numberOfItems);

        console.log(`items (${o.items.length}):`);
        console.table(
            o.items.map((it) => ({
                transactionId: it.transactionId,
                listingId: it.listingId,
                sku: it.sku,
                itemName: (it.itemName || "").slice(0, 60),
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                itemTotal: it.itemTotal,
                variationsRaw: it.variationsRaw,
                customTextCount: Array.isArray(it.customizations?.textFields)
                    ? it.customizations.textFields.length
                    : 0,
                customFileCount: Array.isArray(it.customFiles) ? it.customFiles.length : 0,
                imageUrl: it.baseImage?.imageUrl || ""
            }))
        );

        for (const it of o.items) {
            console.groupCollapsed(`  item: ${it.sku || it.transactionId}`);
            console.log("variations (object):", it.variations);
            console.log("customizations:", it.customizations);
            console.log("customFiles:", (it.customFiles || []).map(maskCustomFileForLog));
            console.log("cost_breakdown:", it.cost_breakdown);
            console.log("baseImage:", it.baseImage);
            console.groupEnd();
        }

        console.log("address_validation:", o.address_validation);
        console.groupEnd();
    }
    console.groupEnd();

    // 1 don dau tien dump JSON full de copy
    console.log("[LNG][content][BACKEND] first order JSON ↓");
    console.log(JSON.stringify(sanitizeOrderForLog(backendOrders[0]), null, 2));
}

function logOrdersDetail(orders) {
    if (!orders || !orders.length) {
        console.warn("[LNG][content][ORDERS] empty list");
        return;
    }

    // Bang tom tat tat ca don
    const summary = orders.map((o, idx) => ({
        "#": idx + 1,
        orderId: o.orderId,
        buyer: o.buyerName,
        items: o.orderItems?.length || 0,
        qty: (o.orderItems || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0),
        total: o.financial?.total ?? 0,
        shipping: o.financial?.shippingCost ?? 0,
        state: `${o.city}, ${o.state}`,
        country: o.country,
        orderDate: o.orderDate,
        paid: o.isFullyPaid ? "yes" : "no"
    }));

    console.log("[LNG][content][ORDERS] summary table");
    console.table(summary);

    // Chi tiet tung don, group collapsed cho khoi rac console
    console.groupCollapsed(`[LNG][content][ORDERS] detail x${orders.length} (click to expand)`);
    for (const order of orders) {
        console.groupCollapsed(`#${order.orderId} | ${order.buyerName} | $${order.financial?.total ?? 0}`);

        console.log("buyer:", {
            name: order.buyerName,
            email: order.buyerEmail,
            phone: order.phoneNumber,
            note: order.buyerNote
        });

        console.log("ship to:", {
            address: order.address,
            address2: order.address2,
            city: order.city,
            state: order.state,
            zip: order.zipCode,
            country: order.country,
            uspsVerified: order.isUSPSVerified
        });

        console.log("dates:", {
            orderDate: order.orderDate,
            purchaseDate: order.purchaseDate,
            estimatedDelivery: order.estimatedDeliveryDate
        });

        console.log("financial:", order.financial);

        console.log("shipping:", {
            service: order.shippingService,
            url: order.orderUrl
        });

        console.log(`items (${order.orderItems?.length || 0}):`);
        console.table(
            (order.orderItems || []).map((it) => ({
                sku: it.sku,
                title: it.productTitle?.slice(0, 60),
                qty: it.quantity,
                cost: it.cost,
                properties: it.properties,
                tracking: it.trackingStatus || "(none)"
            }))
        );

        console.groupEnd();
    }
    console.groupEnd();
}

async function fetchText(url) {
    const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
    });

    console.log("[LNG][content] fetchText", {
        urlMasked: maskUrlForLog(url),
        status: response.status
    });

    if (!response.ok) {
        throw new Error(`Fetch HTML failed ${response.status}: ${maskUrlForLog(url)}`);
    }

    return await response.text();
}

async function fetchJson(url) {
    const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
            "Accept": "application/json, text/plain, */*"
        }
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";

    console.log("[LNG][content] fetchJson", {
        urlMasked: maskUrlForLog(url),
        status: response.status,
        ok: response.ok,
        contentType,
        preview: safeJsonPreview(text, 500)
    });

    if (!response.ok) {
        throw new Error(`Fetch JSON failed ${response.status}: ${maskUrlForLog(url)} :: ${safeJsonPreview(text, 300)}`);
    }

    try {
        return JSON.parse(text || "{}");
    } catch (error) {
        throw new Error(`Fetch JSON parse failed: ${maskUrlForLog(url)} :: ${safeJsonPreview(text, 500)}`);
    }
}

function safeJsonPreview(value, maxLength = 5000) {
    try {
        const maskUrlsInText = (text) =>
            String(text || "").replace(/https:\/\/[^"'<>\\\s]+/gi, (url) => maskUrlForLog(url));

        if (typeof value === "string") {
            const trimmed = value.trim();
            if (/^https?:\/\//i.test(trimmed)) return maskUrlForLog(trimmed);
            if (/^\s*</.test(trimmed)) return `[html length=${trimmed.length}]`;
            if (/base64,/i.test(trimmed)) return "[base64 omitted]";
            return maskUrlsInText(trimmed).slice(0, maxLength);
        }

        return JSON.stringify(value, (_key, nestedValue) => {
            if (typeof nestedValue === "string") {
                if (/^https?:\/\//i.test(nestedValue.trim())) return maskUrlForLog(nestedValue);
                if (/^\s*</.test(nestedValue)) return `[html length=${nestedValue.length}]`;
                if (/base64,/i.test(nestedValue)) return "[base64 omitted]";
                const masked = maskUrlsInText(nestedValue);
                return masked.length > 300 ? `${masked.slice(0, 300)}...` : masked;
            }
            return nestedValue;
        }).slice(0, maxLength);
    } catch (_) {
        return String(value || "").slice(0, maxLength);
    }
}

async function syncEtsyListings(payload = {}) {
    const debugFetchDetailSku = payload.debugFetchDetailSku === true;
    const soldPageUrl = "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav";
    const soldPageHtml = await fetchText(soldPageUrl);
    const bootstrap = parseEtsyBootstrap(soldPageHtml);

    if (!bootstrap.shopId) {
        throw new Error("Khong tim thay Etsy shopId de sync listings.");
    }

    const limit = 40;
    let offset = 0;
    let totalCount = null;
    const listings = [];
    const seenListingIds = new Set();

    while (true) {
        const pageUrl = buildEtsyListingsSearchUrl({
            shopId: bootstrap.shopId,
            limit,
            offset
        });
        const page = await fetchJson(pageUrl);
        console.log("[LNG][content][ETSY_LISTINGS][SEARCH_RAW_RESPONSE]", {
            pageUrl,
            offset,
            limit,
            dataType: Array.isArray(page) ? "array" : typeof page,
            topKeys: page && typeof page === "object" ? Object.keys(page) : [],
            dataKeys: page?.data && typeof page.data === "object" ? Object.keys(page.data) : [],
            outputKeys: page?.output && typeof page.output === "object" ? Object.keys(page.output) : [],
            payloadKeys: page?.payload && typeof page.payload === "object" ? Object.keys(page.payload) : [],
            listingsIsArray: Array.isArray(page?.listings),
            resultsIsArray: Array.isArray(page?.results),
            dataIsArray: Array.isArray(page?.data),
            dataListingsIsArray: Array.isArray(page?.data?.listings),
            dataResultsIsArray: Array.isArray(page?.data?.results),
            listingCardsIsArray: Array.isArray(page?.listing_cards),
            dataListingCardsIsArray: Array.isArray(page?.data?.listing_cards),
            outputListingsIsArray: Array.isArray(page?.output?.listings),
            outputResultsIsArray: Array.isArray(page?.output?.results),
            outputListingCardsIsArray: Array.isArray(page?.output?.listing_cards),
            preview: safeJsonPreview(page, 5000)
        });

        const pageRows = extractEtsyListingSearchRows(page);

        if (totalCount === null) {
            totalCount = extractEtsyListingSearchTotalCount(page);
        }

        if (offset === 0 && pageRows.length === 0) {
            console.warn("[LNG][content][ETSY_LISTINGS][SEARCH_EMPTY_FIRST_PAGE]", {
                pageUrl,
                topKeys: page && typeof page === "object" ? Object.keys(page) : [],
                preview: safeJsonPreview(page, 5000),
                message: "No listing rows extracted. Check response shape or endpoint."
            });
        }

        console.log("[LNG][content][ETSY_LISTINGS][SEARCH_PAGE]", {
            offset,
            pageRows: pageRows.length,
            totalCount,
            firstListingKeys: pageRows[0] ? Object.keys(pageRows[0]) : [],
            firstListing: pageRows[0] || null
        });

        const mappedPageRows = [];

        for (const rawListing of pageRows) {
            const mapped = mapEtsyListingMasterRow(rawListing);
            mappedPageRows.push(mapped);

            if (!mapped.listingId || seenListingIds.has(mapped.listingId)) {
                continue;
            }

            seenListingIds.add(mapped.listingId);
            listings.push(mapped);
        }

        console.log("[LNG][content][ETSY_LISTINGS][MAPPED_PAGE_SAMPLE]", {
            offset,
            mappedCount: mappedPageRows.length,
            sample: mappedPageRows.slice(0, 10).map((listing) => ({
                listingId: listing.listingId,
                title: listing.title,
                sku: listing.sku,
                skus: listing.skus,
                imageUrl: listing.imageUrl,
                rawSkuFields: {
                    product_identifiers: listing.raw?.product_identifiers,
                    productIdentifiers: listing.raw?.productIdentifiers,
                    product_identifier: listing.raw?.product_identifier,
                    productIdentifier: listing.raw?.productIdentifier,
                    sku: listing.raw?.sku,
                    SKU: listing.raw?.SKU
                }
            }))
        });

        if (!pageRows.length) break;

        offset += limit;

        if (Number.isFinite(totalCount) && offset >= totalCount) {
            break;
        }
    }

    const listingsWithSku = listings.filter((listing) => listing.skus.length > 0);
    const listingsMissingSku = listings.filter((listing) => listing.skus.length === 0);

    if (listingsMissingSku.length) {
        console.warn("[LNG][content][ETSY_LISTINGS][SKU_MISSING_FROM_SEARCH]", {
            totalMissing: listingsMissingSku.length,
            sampleMissingSku: listingsMissingSku.slice(0, 20).map((listing) => ({
                listingId: listing.listingId,
                title: listing.title,
                state: listing.state
            }))
        });
    }

    console.log("[LNG][content][ETSY_LISTINGS][SKU_AUDIT]", {
        totalListings: listings.length,
        listingsWithSku: listingsWithSku.length,
        listingsMissingSku: listingsMissingSku.length,
        sampleWithSku: listingsWithSku.slice(0, 20).map((listing) => ({
            listingId: listing.listingId,
            title: listing.title,
            sku: listing.sku,
            skus: listing.skus
        })),
        sampleMissingSku: listingsMissingSku.slice(0, 20).map((listing) => ({
            listingId: listing.listingId,
            title: listing.title,
            state: listing.state
        })),
        uniqueListingIds: seenListingIds.size
    });

    let detailSkuDebug = [];

    if (debugFetchDetailSku) {
        detailSkuDebug = [];

        for (const listing of listings.slice(0, 3)) {
            detailSkuDebug.push(await fetchListingDetailForSku(listing.listingId, bootstrap.shopId));
            await sleep(300);
        }

        console.log("[LNG][content][ETSY_LISTINGS][DETAIL_SKU_DEBUG]", {
            tested: detailSkuDebug.length,
            detailSkuDebug
        });
    }

    return {
        etsyShopId: bootstrap.shopId,
        shopName: bootstrap.shopName,
        listings,
        summary: {
            totalListings: listings.length,
            listingsWithSku: listingsWithSku.length,
            listingsMissingSku: listingsMissingSku.length,
            uniqueListingIds: seenListingIds.size,
            source: "etsy_listing_search",
            detailSkuDebug
        }
    };
}

function buildEtsyListingsSearchUrl({ shopId, limit, offset }) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    params.set("sort_field", "ending_date");
    params.set("sort_order", "descending");
    params.set("state", "active");
    params.set("query", "");

    return `https://www.etsy.com/api/v3/ajax/shop/${shopId}/listings/search?${params.toString()}`;
}

function extractEtsyListingSearchRows(body) {
    const candidates = [
        body,
        body?.listings,
        body?.results,
        body?.data,
        body?.data?.listings,
        body?.data?.results,
        body?.listing_cards,
        body?.data?.listing_cards,
        body?.output?.listings,
        body?.output?.results,
        body?.output?.listing_cards,
        body?.payload?.listings,
        body?.payload?.results,
        body?.payload?.listing_cards,
        body?.response?.listings,
        body?.response?.results,
        body?.response?.listing_cards
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            return candidate;
        }
    }

    return [];
}

function extractEtsyListingSearchTotalCount(body) {
    const candidates = [
        body?.total,
        body?.totalCount,
        body?.total_count,
        body?.count,
        body?.filtered_count,
        body?.pagination?.total,
        body?.pagination?.total_count,
        body?.pagination?.totalCount,
        body?.filteredListingCount,
        body?.filtered_listing_count,
        body?.data?.total,
        body?.data?.totalCount,
        body?.data?.total_count,
        body?.data?.count,
        body?.output?.total,
        body?.output?.total_count,
        body?.payload?.total,
        body?.payload?.total_count,
        body?.response?.total,
        body?.response?.total_count
    ];

    for (const candidate of candidates) {
        const value = Number(candidate);

        if (Number.isFinite(value)) {
            return value;
        }
    }

    return null;
}

function mapEtsyListingMasterRow(rawListing) {
    const listingId = String(
        rawListing?.listingId ??
        rawListing?.listing_id ??
        rawListing?.id ??
        ""
    );
    const images = extractEtsyListingImages(rawListing);
    const skus = extractEtsyListingSkus(rawListing);
    const price = normalizeEtsyListingPrice(
        rawListing?.price ??
        rawListing?.price_money ??
        rawListing?.money ??
        rawListing?.display_price
    );
    const rawLite = {
        listing_id: rawListing?.listing_id,
        shop_id: rawListing?.shop_id,
        title: rawListing?.title,
        state: rawListing?.state,
        legacy_state: rawListing?.legacy_state,
        quantity: rawListing?.quantity,
        price: rawListing?.price,
        price_int: rawListing?.price_int,
        currency_code: rawListing?.currency_code,
        product_identifiers: rawListing?.product_identifiers,
        has_variations: rawListing?.has_variations,
        has_variation_sku: rawListing?.has_variation_sku,
        inventory_product_count: rawListing?.inventory_product_count,
        update_date: rawListing?.update_date,
        create_date: rawListing?.create_date,
        ending_date: rawListing?.ending_date
    };

    return {
        listingId,
        title: String(rawListing?.title || rawListing?.name || ""),
        url: String(rawListing?.url || rawListing?.listingUrl || rawListing?.listing_url || ""),
        imageUrl: images[0]?.imageUrl || "",
        images,
        sku: skus[0] || "",
        skus,
        state: String(rawListing?.state || rawListing?.status || ""),
        quantity: Number(rawListing?.quantity ?? rawListing?.available_quantity ?? 0) || 0,
        price,
        raw: rawLite
    };
}

function extractEtsyListingImages(rawListing) {
    const rawImages =
        rawListing?.listing_images ||
        rawListing?.listingImages ||
        rawListing?.images ||
        rawListing?.Images ||
        [];
    const images = Array.isArray(rawImages) ? rawImages : [];
    const mapped = images.map((image) => {
        if (typeof image === "string") {
            return {
                imageUrl: image,
                width: null,
                height: null
            };
        }

        return {
            imageUrl: String(
                image?.url_fullxfull ||
                image?.url_570xN ||
                image?.url_170x135 ||
                image?.url ||
                image?.imageUrl ||
                image?.image_url ||
                ""
            ),
            width: Number(image?.full_width || image?.width || 0) || null,
            height: Number(image?.full_height || image?.height || 0) || null
        };
    }).filter((image) => image.imageUrl);

    const fallbackUrl = String(
        rawListing?.imageUrl ||
        rawListing?.image_url ||
        rawListing?.url_570xN ||
        rawListing?.url_fullxfull ||
        ""
    );

    if (!mapped.length && fallbackUrl) {
        mapped.push({
            imageUrl: fallbackUrl,
            width: null,
            height: null
        });
    }

    return mapped;
}

function extractEtsyListingSkus(rawListing) {
    const found = new Set();

    collectEtsyListingSkuValue(rawListing?.product_identifiers, found);
    collectEtsyListingSkuValue(rawListing?.productIdentifiers, found);
    collectEtsyListingSkuValue(rawListing?.product_identifier, found);
    collectEtsyListingSkuValue(rawListing?.productIdentifier, found);
    collectEtsyListingSkuValue(rawListing?.sku, found);
    collectEtsyListingSkuValue(rawListing?.SKU, found);
    collectEtsyListingSkuValue(rawListing?.skus, found);
    collectEtsyListingSkuValue(rawListing?.product_sku, found);
    collectEtsyListingSkuValue(rawListing?.productSku, found);
    collectEtsyListingSkuValue(rawListing?.inventory?.sku, found);
    collectEtsyListingSkuValue(rawListing?.inventory?.skus, found);

    const products = rawListing?.inventory?.products || rawListing?.products || [];

    if (Array.isArray(products)) {
        for (const product of products) {
            collectEtsyListingSkuValue(product?.sku, found);
            collectEtsyListingSkuValue(product?.product_sku, found);
            collectEtsyListingSkuValue(product?.productSku, found);

            if (Array.isArray(product?.offerings)) {
                for (const offering of product.offerings) {
                    collectEtsyListingSkuValue(offering?.sku, found);
                    collectEtsyListingSkuValue(offering?.product_sku, found);
                }
            }
        }
    }

    return Array.from(found);
}

function collectEtsyListingSkuValue(value, found) {
    if (Array.isArray(value)) {
        for (const item of value) {
            collectEtsyListingSkuValue(item, found);
        }
        return;
    }

    if (value && typeof value === "object") {
        collectEtsyListingSkuValue(value.sku, found);
        collectEtsyListingSkuValue(value.product_sku, found);
        collectEtsyListingSkuValue(value.productSku, found);
        return;
    }

    const sku = String(value || "").trim();

    if (sku) {
        found.add(sku);
    }
}

function normalizeEtsyListingPrice(value) {
    if (value == null || value === "") {
        return 0;
    }

    if (typeof value === "number") {
        return value;
    }

    if (typeof value === "string") {
        const parsed = Number(value.replace(/[^0-9.-]/g, ""));
        return Number.isFinite(parsed) ? parsed : 0;
    }

    if (typeof value === "object") {
        if (typeof value.value === "number") {
            return value.value / 100;
        }

        if (typeof value.amount === "number" && typeof value.divisor === "number" && value.divisor !== 0) {
            return value.amount / value.divisor;
        }

        if (typeof value.formatted_value === "string") {
            return normalizeEtsyListingPrice(value.formatted_value);
        }
    }

    return 0;
}

async function fetchListingDetailForSku(listingId, shopId = "") {
    const id = String(listingId || "").trim();
    const shop = String(shopId || "").trim();

    if (!id) {
        return {
            listingId: id,
            ok: false,
            message: "Missing listingId"
        };
    }

    const urls = shop
        ? [
            `https://www.etsy.com/api/v3/ajax/shop/${shop}/listings/${id}`,
            `https://www.etsy.com/api/v3/ajax/shop/${shop}/listings/${id}/inventory`
        ]
        : [
            `https://www.etsy.com/api/v3/ajax/listings/${id}`,
            `https://www.etsy.com/api/v3/ajax/listings/${id}/inventory`
        ];

    const attempts = [];

    for (const url of urls) {
        try {
            const data = await fetchJson(url);
            const mapped = mapEtsyListingMasterRow(data?.listing || data?.data || data);

            attempts.push({
                url,
                ok: true,
                keys: Object.keys(data || {}),
                sku: mapped.sku,
                skus: mapped.skus
            });
        } catch (error) {
            attempts.push({
                url,
                ok: false,
                message: error?.message || String(error)
            });
        }
    }

    return {
        listingId: id,
        attempts
    };
}

function parseEtsyBootstrap(html) {
    const text = decodeHtmlEntities(html);

    const shopId =
        matchFirst(text, /"shopId"\s*:\s*"?(\d+)"?/) ||
        matchFirst(text, /"shop_id"\s*:\s*"?(\d+)"?/) ||
        matchFirst(text, /"shop_id"\s*:\s*(\d+)/);

    const shopName =
        matchFirst(text, /"shopName"\s*:\s*"([^"]+)"/) ||
        matchFirst(text, /"shop_name"\s*:\s*"([^"]+)"/) ||
        "";

    const orderStates = parseOrderStates(text);

    console.log("[LNG][content] parseEtsyBootstrap", {
        shopId,
        shopName,
        orderStatesCount: orderStates.length
    });

    // === DEBUG DUMP (xoa sau khi viet xong parser moi) ===
    dumpContextAround(text, "order_states", 2);
    dumpContextAround(text, "orderStates", 2);
    dumpContextAround(text, "shop_id", 1);
    dumpContextAround(text, "shopId", 1);
    dumpContextAround(text, "mission-control", 2);
    dumpContextAround(text, "/your/orders/sold/", 2);

    return {
        shopId,
        shopName,
        orderStates
    };
}

function dumpContextAround(text, keyword, maxHits = 2) {
    const indices = [];
    let from = 0;

    while (indices.length < maxHits) {
        const idx = text.indexOf(keyword, from);
        if (idx === -1) break;
        indices.push(idx);
        from = idx + keyword.length;
    }

    if (indices.length === 0) {
        console.warn("[LNG][content][DUMP] keyword NOT FOUND:", keyword);
        return;
    }

    for (const idx of indices) {
        const before = text.slice(Math.max(0, idx - 80), idx);
        const after = text.slice(idx, Math.min(text.length, idx + 600));
        console.log(
            "[LNG][content][DUMP] keyword:",
            keyword,
            "@",
            idx,
            "\n--- before ---\n",
            before,
            "\n--- match+after ---\n",
            after
        );
    }
}

function parseOrderStates(text) {
    const candidates = extractAllJsonArraysAfter(text, "order_states");

    console.log("[LNG][content] parseOrderStates candidates", {
        count: candidates.length,
        lengths: candidates.map((c) => c.length)
    });

    let best = [];

    for (const raw of candidates) {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) continue;

            const mapped = parsed
                .filter((item) => item && item.order_state_id)
                .map((item) => ({
                    order_state_id: item.order_state_id,
                    name: item.name || item.display_name || String(item.order_state_id)
                }));

            if (mapped.length > best.length) {
                best = mapped;
            }
        } catch (error) {
            console.warn("[LNG][content][PARSE_ORDER_STATES_FAILED]", error.message);
        }
    }

    console.log("[LNG][content] parseOrderStates picked", best);
    return best;
}

function extractAllJsonArraysAfter(text, key) {
    const results = [];
    const opener = new RegExp(`"${key}"\\s*:\\s*\\[`, "g");

    let m;
    while ((m = opener.exec(text)) !== null) {
        const startBracket = m.index + m[0].length - 1;
        const arrayText = readBalancedArray(text, startBracket);
        if (arrayText) {
            results.push(arrayText);
        }
    }

    return results;
}

function readBalancedArray(text, startIndex) {
    if (text[startIndex] !== "[") return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (inString) {
            if (ch === "\\") {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === "[") {
            depth++;
        } else if (ch === "]") {
            depth--;
            if (depth === 0) {
                return text.slice(startIndex, i + 1);
            }
        }
    }

    return null;
}

function decodeHtmlEntities(value) {
    return String(value || "")
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
}

function matchFirst(text, regex) {
    const match = text.match(regex);
    return match?.[1] || null;
}

async function collectOrdersByState({ shopId, orderStateId, orderStateName, limit, maxTotalOrders = 50, targetOrderId = "" }) {
    let offset = 0;
    let totalCount = null;

    const pages = [];

    console.log("[LNG][content] collectOrdersByState start", {
        shopId,
        orderStateId,
        orderStateName,
        limit,
        maxTotalOrders,
        targetOrderId
    });

    while (true) {
        const pageData = await fetchOrdersPage({
            shopId,
            orderStateId,
            limit,
            offset,
            targetOrderId
        });

        console.log("[LNG][content] page fetched", {
            state: orderStateName,
            offset,
            pageOrderIds: pageData.order_ids?.length || 0,
            total_count: pageData.total_count,
            targetFound: targetOrderId ? (pageData.order_ids || []).some((id) => String(id) === String(targetOrderId)) : false
        });

        pages.push(pageData);

        const pageTotal = Number(pageData.total_count || 0);

        if (totalCount === null) {
            totalCount = pageTotal;
        }

        if (!targetOrderId) {
            console.log("[LNG][content][IMPORT_LIMIT] normal import: fetched first page only", {
                state: orderStateName,
                limit,
                maxTotalOrders,
                pageOrderIds: pageData.order_ids?.length || 0
            });
            break;
        }

        if (targetOrderId && (pageData.order_ids || []).some((id) => String(id) === String(targetOrderId))) {
            console.log("[LNG][content] target order found in state page", {
                state: orderStateName,
                targetOrderId,
                offset
            });
            break;
        }

        if (targetOrderId && offset === 0 && pageTotal === 0) {
            console.log("[LNG][content] target order search empty in state, stop paging", {
                state: orderStateName,
                targetOrderId
            });
            break;
        }

        if (targetOrderId) {
            console.log("[LNG][content] target order search checked first page, stop paging state", {
                state: orderStateName,
                targetOrderId,
                pageTotal
            });
            break;
        }

        offset += limit;

        if (offset >= totalCount) {
            console.log("[LNG][content] paging done", { state: orderStateName, totalCount, pages: pages.length });
            break;
        }
    }

    const merged = mergeRawOrderData(pages);

    merged.__state = {
        id: orderStateId,
        name: orderStateName,
        totalCount
    };

    return merged;
}

async function fetchOrdersPage({ shopId, orderStateId, limit, offset, targetOrderId = "" }) {
    const url = new URL(
        `https://www.etsy.com/api/v3/ajax/bespoke/shop/${shopId}/mission-control/orders`
    );

    const params = {
        "filters[buyer_id]": "all",
        "filters[channel]": "all",
        "filters[completed_status]": "all",
        "filters[destination]": "all",
        "filters[ship_date]": "all",
        "filters[shipping_label_eligibility]": "false",
        "filters[shipping_label_status]": "all",
        "filters[shipping_status]": "all",
        "filters[order_state_id]": String(orderStateId),

        limit: String(limit),
        offset: String(offset),

        search_terms: targetOrderId ? String(targetOrderId) : "",
        sort_by: "order_date",
        sort_order: "desc",

        "objects_enabled_for_normalization[order_state]": "true"
    };

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    console.log("[LNG][content] fetchOrdersPage", {
        shopId,
        orderStateId,
        limit,
        offset,
        targetOrderId
    });
    const data = await fetchJson(url.toString());
    logApiShapeOnce(data);
    return data;
}

function logApiShapeOnce(data) {
    if (window.__LNG_LOGGED_API_SHAPE__) return;
    window.__LNG_LOGGED_API_SHAPE__ = true;

    console.log("[LNG][content][API_SHAPE] top-level keys:", Object.keys(data || {}));
    console.log("[LNG][content][API_SHAPE] order_ids sample:", (data?.order_ids || []).slice(0, 3));
    console.log("[LNG][content][API_SHAPE] orders is array?", Array.isArray(data?.orders));
    console.log("[LNG][content][API_SHAPE] orders keys sample:", Object.keys(data?.orders || {}).slice(0, 5));

    const firstOrderKey = Object.keys(data?.orders || {})[0];
    if (firstOrderKey) {
        const firstOrder = data.orders[firstOrderKey];
        console.log("[LNG][content][API_SHAPE] first order key:", firstOrderKey);
        console.log("[LNG][content][API_SHAPE] first order top keys:", Object.keys(firstOrder || {}));
        console.log("[LNG][content][API_SHAPE] first order.order_id:", firstOrder?.order_id);
        console.log("[LNG][content][API_SHAPE] first order FULL:", firstOrder);
    }

    if (data?.order_groups) {
        console.log("[LNG][content][API_SHAPE] order_groups keys:", Object.keys(data.order_groups).slice(0, 5));
        const firstGroupKey = Object.keys(data.order_groups)[0];
        if (firstGroupKey) {
            console.log("[LNG][content][API_SHAPE] first order_group:", data.order_groups[firstGroupKey]);
        }
    }
}

function mergeRawOrderData(results) {
    const merged = {
        buyers: [],
        order_errors: [],
        order_groups: [],
        order_ids: [],
        order_states: [],
        orders: [],
        packages: [],
        shipment_ids: [],
        shipping_labels: [],
        transactions: [],
        total_count: 0
    };

    for (const result of results) {
        if (!result) continue;

        pushAll(merged.buyers, toArray(result.buyers));
        pushAll(merged.order_errors, toArray(result.order_errors));
        pushAll(merged.order_groups, toArray(result.order_groups));
        pushAll(merged.order_states, toArray(result.order_states));
        pushAll(merged.orders, toArray(result.orders));
        pushAll(merged.packages, toArray(result.packages));
        pushAll(merged.shipping_labels, toArray(result.shipping_labels));
        pushAll(merged.transactions, toArray(result.transactions));

        if (Array.isArray(result.order_ids)) {
            merged.order_ids.push(...result.order_ids.map(String));
        }

        if (Array.isArray(result.shipment_ids)) {
            merged.shipment_ids.push(...result.shipment_ids.map(String));
        }

        merged.total_count = Math.max(merged.total_count, Number(result.total_count || 0));
    }

    merged.order_ids = [...new Set(merged.order_ids)];
    merged.shipment_ids = [...new Set(merged.shipment_ids)];

    // Build lookup maps theo id (orders/buyers/packages là array các object có id field).
    merged.orders_by_id = indexBy(merged.orders, "order_id");
    merged.buyers_by_id = indexBy(merged.buyers, "user_id", "buyer_id");
    merged.packages_by_id = indexBy(merged.packages, "package_id");

    console.log("[LNG][content] mergeRawOrderData index", {
        ordersCount: merged.orders.length,
        ordersIndexed: Object.keys(merged.orders_by_id).length,
        buyersCount: merged.buyers.length,
        buyersIndexed: Object.keys(merged.buyers_by_id).length,
        sampleOrderIds: merged.order_ids.slice(0, 3),
        sampleIndexedOrderKeys: Object.keys(merged.orders_by_id).slice(0, 3)
    });

    return merged;
}

function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value);
    return [];
}

function pushAll(target, items) {
    for (const item of items) {
        target.push(item);
    }
}

function indexBy(items, ...idKeys) {
    const map = {};
    for (const item of items) {
        if (!item) continue;

        for (const key of idKeys) {
            const id = item[key];
            if (id !== undefined && id !== null) {
                map[String(id)] = item;
                break;
            }
        }
    }
    return map;
}

function maskUrlForLog(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";

    try {
        const parsed = new URL(raw);
        const queryKeys = [...parsed.searchParams.keys()];
        parsed.search = queryKeys.length ? "?..." : "";
        parsed.hash = parsed.hash ? "#..." : "";
        return parsed.toString();
    } catch (_) {
        return raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
    }
}

function looksLikeUrl(value) {
    return /^https?:\/\//i.test(String(value || "").trim());
}

function isAllowedCustomFileUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return false;
    if (/base64,/i.test(raw)) return false;
    return /^https:\/\//i.test(raw);
}

function isBlockedEtsySystemUrl(url) {
    const raw = String(url || "").trim().toLowerCase();
    if (!raw) return true;

    return [
        "/legal/",
        "/help.",
        "help.etsy.com",
        "/cookies",
        "/privacy",
        "/ac/evergreenvendor/",
        "/assets/",
        ".js",
        ".css",
        "polyfill",
        "vendor",
        "tracking",
        "analytics"
    ].some((blocked) => raw.includes(blocked));
}

function hasRealCustomerFileExtension(url) {
    try {
        const parsed = new URL(String(url || "").trim());
        return /\.(jpe?g|png|webp|gif|pdf|heic)$/i.test(parsed.pathname || "");
    } catch (_) {
        return /\.(jpe?g|png|webp|gif|pdf|heic)(?:[?#]|$)/i.test(String(url || ""));
    }
}

function deriveFileNameFromUrl(url) {
    try {
        const parsed = new URL(String(url || "").trim());
        const name = decodeURIComponent((parsed.pathname || "").split("/").filter(Boolean).pop() || "");
        return hasRealCustomerFileExtension(name) ? name : "";
    } catch (_) {
        const clean = String(url || "").split(/[?#]/)[0];
        const name = decodeURIComponent(clean.split("/").filter(Boolean).pop() || "");
        return hasRealCustomerFileExtension(name) ? name : "";
    }
}

function looksLikeRealCustomerFileUrl(url, context = "") {
    const raw = String(url || "").trim();
    if (!isAllowedCustomFileUrl(raw)) return false;
    if (isBlockedEtsySystemUrl(raw)) return false;

    const lowerContext = String(context || "").toLowerCase();
    const hasFileExt = hasRealCustomerFileExtension(raw);
    const hasStrongContext = [
        "download",
        "attachment",
        "uploaded",
        "upload",
        "custom",
        "personalization",
        "file-name",
        "filename",
        "data-file",
        "image"
    ].some((hint) => lowerContext.includes(hint));

    if (hasFileExt) return true;

    try {
        const parsed = new URL(raw);
        const isEtsyImageHost = parsed.hostname.toLowerCase() === "i.etsystatic.com";
        const hasUploadContext = /(upload|uploaded|file|photo|custom|personalization)/i.test(lowerContext);
        if (isEtsyImageHost && hasUploadContext) return true;
    } catch (_) { }

    return hasStrongContext;
}

function isEtsyIpfImageUrl(url) {
    try {
        const parsed = new URL(String(url || "").trim(), location.href);
        return parsed.protocol === "https:" &&
            parsed.hostname.toLowerCase() === "i.etsystatic.com" &&
            parsed.pathname.includes("/ipf/") &&
            /ipf_/i.test(parsed.pathname);
    } catch (_) {
        return false;
    }
}

function normalizeAbsoluteUrl(url) {
    try {
        return new URL(String(url || "").trim(), location.href).toString();
    } catch (_) {
        return String(url || "").trim();
    }
}

function buildIpfFullSizeCandidates(previewUrl) {
    const raw = normalizeAbsoluteUrl(previewUrl);
    const candidates = [
        raw.replace("ipf_75x75", "ipf_fullxfull"),
        raw.replace("ipf_75x75", "ipf_570xN"),
        raw.replace("ipf_75x75", "ipf_300x300"),
        raw
    ];
    return [...new Set(candidates)].filter((url) => isAllowedCustomFileUrl(url));
}

function probeImageSize(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const img = new Image();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            resolve(result);
        };
        const timer = setTimeout(() => {
            finish({
                ok: false,
                url,
                width: 0,
                height: 0,
                reason: "timeout"
            });
        }, timeoutMs);

        img.onload = () => {
            clearTimeout(timer);
            finish({
                ok: true,
                url,
                width: Number(img.naturalWidth || img.width || 0),
                height: Number(img.naturalHeight || img.height || 0)
            });
        };
        img.onerror = () => {
            clearTimeout(timer);
            finish({
                ok: false,
                url,
                width: 0,
                height: 0,
                reason: "load_error"
            });
        };
        img.src = url;
    });
}

function pickBestIpfImageProbe(probes = []) {
    const loaded = probes.filter((probe) => probe?.ok);
    const full = loaded.find((probe) =>
        String(probe.url || "").includes("ipf_fullxfull") &&
        (Number(probe.width) > 75 || Number(probe.height) > 75)
    );
    if (full) return full;

    return loaded
        .slice()
        .sort((a, b) => (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height)))[0] || null;
}

async function scanOrderDetailDomForCustomFiles({ targetOrderId, waitMs = 3000 } = {}) {
    const safeTargetOrderId = String(targetOrderId || "").trim();
    const safeWaitMs = Number.isFinite(Number(waitMs)) ? Number(waitMs) : 3000;

    if (!safeTargetOrderId) {
        throw new Error("Missing targetOrderId for DOM custom file scan");
    }

    await sleep(safeWaitMs);

    const elements = Array.from(document.querySelectorAll('img[src*="/ipf/"], img[src*="ipf_"]'));
    const files = [];
    const seenPreviewUrls = new Set();
    const filesMasked = [];

    for (const img of elements) {
        const rawSrc = normalizeAbsoluteUrl(img.getAttribute("src") || img.currentSrc || "");
        if (!rawSrc) continue;
        if (rawSrc.includes("/r/il/") || /\/il_\d+x\d+/i.test(rawSrc)) continue;
        if (!isEtsyIpfImageUrl(rawSrc)) continue;
        if (seenPreviewUrls.has(rawSrc)) continue;
        seenPreviewUrls.add(rawSrc);

        const probeUrls = buildIpfFullSizeCandidates(rawSrc);
        const probes = [];
        for (const url of probeUrls) {
            probes.push(await probeImageSize(url));
        }

        const bestProbe = pickBestIpfImageProbe(probes);
        const downloadUrl = bestProbe?.url || rawSrc;
        const previewUrl = rawSrc;
        const fileName = deriveFileNameFromUrl(downloadUrl || previewUrl) || `etsy-upload-${safeTargetOrderId}.png`;

        const file = {
            source: "etsy_order_detail_dom",
            fileName,
            mimeType: "image/png",
            size: null,
            downloadUrl,
            previewUrl,
            storageUrl: "",
            etsyFileId: "",
            transactionId: "",
            listingId: "",
            matchConfidence: "high",
            status: "pending_download"
        };

        files.push(file);
        filesMasked.push({
            ...maskCustomFileForLog(file),
            bestWidth: bestProbe?.width || null,
            bestHeight: bestProbe?.height || null,
            probes: probes.map((probe) => ({
                ok: probe.ok,
                urlMasked: maskUrlForLog(probe.url),
                width: probe.width,
                height: probe.height,
                reason: probe.reason || ""
            }))
        });
    }

    const customFiles = dedupeCustomFiles(files);
    console.log("[LNG][content][CUSTOM_FILE_DOM_SCAN_SUMMARY]", {
        currentUrl: maskUrlForLog(location.href),
        targetOrderId: safeTargetOrderId,
        scannedElements: elements.length,
        ipfImagesFound: seenPreviewUrls.size,
        acceptedFiles: customFiles.length,
        filesMasked
    });

    return {
        targetOrderId: safeTargetOrderId,
        currentUrl: location.href,
        customFiles
    };
}

function extractEtsyCustomTextFields({ transaction, order, variationsArr }) {
    const textFields = [];
    const seen = new Set();
    const sources = [
        { source: "variationsArray", items: variationsArr },
        { source: "transaction.variations", items: transaction?.variations },
        { source: "transaction.properties", items: transaction?.properties }
    ];

    for (const source of sources) {
        for (const item of toArray(source.items)) {
            const name = String(
                item?.formatted_name ||
                item?.property ||
                item?.name ||
                "Personalization"
            ).trim() || "Personalization";
            const rawValue =
                item?.formatted_value ??
                item?.value ??
                (typeof item === "string" ? item : "");
            const value = String(rawValue || "").trim();
            if (!value) continue;

            const key = `${name}|${value}`;
            if (seen.has(key)) continue;
            seen.add(key);

            textFields.push({
                name,
                value,
                source: source.source
            });
        }
    }

    const buyerNote = String(order?.notes?.note_from_buyer || "").trim();

    return {
        textFields,
        buyerNote,
        raw: {
            variations: Array.isArray(variationsArr) ? variationsArr.slice(0, 20) : [],
            note_from_buyer: buyerNote
        }
    };
}

function findDeepCustomFileCandidates(source, path = "", results = [], options = {}) {
    const maxDepth = Number(options.maxDepth || 5);
    const maxResults = Number(options.maxResults || 100);
    const depth = Number(options.depth || 0);
    const visited = options.visited || new WeakSet();
    const keywords = [
        "custom",
        "personal",
        "personalization",
        "upload",
        "uploaded",
        "file",
        "attachment",
        "image",
        "photo",
        "download",
        "url"
    ];

    if (results.length >= maxResults || source == null || depth > maxDepth) return results;

    if (typeof source !== "object") {
        const text = String(source || "");
        const lowerPath = String(path || "").toLowerCase();
        const lowerText = text.toLowerCase();
        const matched = keywords.some((keyword) => lowerPath.includes(keyword) || lowerText.includes(keyword));
        if (matched && text.trim()) {
            results.push({
                path,
                type: typeof source,
                preview: looksLikeUrl(text) ? maskUrlForLog(text) : safeJsonPreview(text, 1000),
                isUrl: looksLikeUrl(text)
            });
        }
        return results;
    }

    if (visited.has(source)) return results;
    visited.add(source);

    for (const [key, value] of Object.entries(source)) {
        if (results.length >= maxResults) break;

        const nextPath = path ? `${path}.${key}` : key;
        const lowerKey = String(key || "").toLowerCase();
        const keyMatched = keywords.some((keyword) => lowerKey.includes(keyword));

        if (keyMatched) {
            results.push({
                path: nextPath,
                type: Array.isArray(value) ? "array" : typeof value,
                preview: safeJsonPreview(value, 1000),
                isUrl: typeof value === "string" && looksLikeUrl(value)
            });
        }

        if (value && typeof value === "object") {
            findDeepCustomFileCandidates(value, nextPath, results, {
                ...options,
                depth: depth + 1,
                visited
            });
        } else if (!keyMatched) {
            findDeepCustomFileCandidates(value, nextPath, results, {
                ...options,
                depth: depth + 1,
                visited
            });
        }
    }

    return results;
}

function normalizeCustomFileCandidate(candidate, ctx = {}) {
    if (!candidate || typeof candidate !== "object") return null;
    const candidateKeys = Object.keys(candidate || {}).join(" ").toLowerCase();
    const candidatePath = String(ctx.path || "").toLowerCase();
    const strongFileSignal = /(custom|personal|personalization|upload|uploaded|file|attachment|download)/i.test(
        `${candidateKeys} ${candidatePath}`
    );
    if (!strongFileSignal) return null;

    let downloadUrl = [
        candidate.downloadUrl,
        candidate.download_url,
        candidate.url,
        candidate.file_url,
        candidate.fileUrl,
        candidate.href
    ].find(isAllowedCustomFileUrl) || "";
    let previewUrl = [
        candidate.previewUrl,
        candidate.preview_url,
        candidate.thumbnail_url,
        candidate.thumbnailUrl,
        candidate.image_url,
        candidate.imageUrl
    ].find(isAllowedCustomFileUrl) || "";
    const storageUrl = [
        candidate.storageUrl,
        candidate.storage_url
    ].find(isAllowedCustomFileUrl) || "";
    let fileName = String(
        candidate.fileName ||
        candidate.file_name ||
        candidate.filename ||
        candidate.name ||
        candidate.title ||
        ""
    ).trim();
    const etsyFileId = String(
        candidate.etsyFileId ||
        candidate.file_id ||
        candidate.fileId ||
        candidate.id ||
        ""
    ).trim();

    if (!downloadUrl && !previewUrl && !etsyFileId && !fileName) return null;

    if (ctx.source === "etsy_order_detail_html") {
        const htmlContext = String(ctx.context || candidate.context || "");
        const downloadLooksReal = downloadUrl && looksLikeRealCustomerFileUrl(downloadUrl, htmlContext);
        const previewLooksReal = previewUrl && looksLikeRealCustomerFileUrl(previewUrl, htmlContext);

        if (downloadUrl && !downloadLooksReal) downloadUrl = "";
        if (previewUrl && !previewLooksReal) previewUrl = "";
        if (!downloadUrl && !previewUrl) return null;

        const bestUrl = downloadUrl || previewUrl;
        if (!fileName) {
            fileName = deriveFileNameFromUrl(bestUrl);
        }
        if (!fileName && !hasRealCustomerFileExtension(bestUrl)) return null;
    }

    return {
        source: ctx.source || "etsy_order_list",
        fileName,
        mimeType: String(candidate.mimeType || candidate.mime_type || candidate.content_type || "").trim(),
        size: Number.isFinite(Number(candidate.size || candidate.file_size))
            ? Number(candidate.size || candidate.file_size)
            : null,
        downloadUrl,
        previewUrl,
        storageUrl,
        etsyFileId,
        transactionId: String(ctx.transactionId || candidate.transactionId || candidate.transaction_id || "").trim(),
        listingId: String(ctx.listingId || candidate.listingId || candidate.listing_id || "").trim(),
        matchConfidence: ctx.matchConfidence || "medium",
        status: "pending_download"
    };
}

function extractCustomFilesFromObject(source, ctx = {}) {
    const files = [];
    const visited = new WeakSet();

    function walk(value, path = "") {
        if (!value || typeof value !== "object") return;
        if (visited.has(value)) return;
        visited.add(value);

        const normalized = normalizeCustomFileCandidate(value, {
            ...ctx,
            path
        });
        if (normalized) files.push(normalized);

        for (const [key, child] of Object.entries(value)) {
            if (child && typeof child === "object") {
                walk(child, path ? `${path}.${key}` : key);
            }
        }
    }

    walk(source);
    return dedupeCustomFiles(files);
}

function extractCustomFilesFromHtml(html, ctx = {}) {
    const text = String(html || "");
    if (!text) return [];

    const files = [];
    const linkRegex = /https:\/\/[^"'<>\\\s]+/gi;
    const fileNameRegex = /(?:download|filename|file-name|data-file-name)=["']([^"']+)["']/i;
    const rejectedUrlsSampleMasked = [];
    let scannedUrls = 0;
    let blockedSystemUrls = 0;
    let match;

    while ((match = linkRegex.exec(text)) && files.length < 100) {
        const url = match[0];
        scannedUrls++;

        const start = Math.max(0, match.index - 500);
        const end = Math.min(text.length, match.index + url.length + 500);
        const context = text.slice(start, end);
        const fileNameMatch = context.match(fileNameRegex);
        let fileName = fileNameMatch ? fileNameMatch[1] : "";

        if (isBlockedEtsySystemUrl(url)) {
            blockedSystemUrls++;
            if (rejectedUrlsSampleMasked.length < 10) rejectedUrlsSampleMasked.push(maskUrlForLog(url));
            continue;
        }

        if (!looksLikeRealCustomerFileUrl(url, context)) {
            if (rejectedUrlsSampleMasked.length < 10) rejectedUrlsSampleMasked.push(maskUrlForLog(url));
            continue;
        }

        if (!fileName && hasRealCustomerFileExtension(url)) {
            fileName = deriveFileNameFromUrl(url);
        }

        if (!fileName && !hasRealCustomerFileExtension(url)) {
            if (rejectedUrlsSampleMasked.length < 10) rejectedUrlsSampleMasked.push(maskUrlForLog(url));
            continue;
        }

        const normalized = normalizeCustomFileCandidate({
            downloadUrl: url,
            fileName,
            context
        }, {
            ...ctx,
            source: ctx.source || "etsy_order_detail_html",
            matchConfidence: ctx.matchConfidence || "low",
            context
        });

        if (normalized) {
            files.push(normalized);
        } else if (rejectedUrlsSampleMasked.length < 10) {
            rejectedUrlsSampleMasked.push(maskUrlForLog(url));
        }
    }

    const dedupedFiles = dedupeCustomFiles(files.filter(Boolean));
    console.log("[LNG][content][CUSTOM_FILE_HTML_EXTRACT_SUMMARY]", {
        scannedUrls,
        blockedSystemUrls,
        acceptedFiles: dedupedFiles.length,
        rejectedUrlsSampleMasked
    });

    return dedupedFiles;
}

function dedupeCustomFiles(files = []) {
    const seen = new Set();
    const result = [];

    for (const file of Array.isArray(files) ? files : []) {
        if (!file) continue;
        const key =
            file.etsyFileId ||
            file.downloadUrl ||
            file.previewUrl ||
            `${file.transactionId || ""}:${file.fileName || ""}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(file);
    }

    return result;
}

function maskCustomFileForLog(file = {}) {
    return {
        ...file,
        downloadUrl: file.downloadUrl ? "[masked]" : "",
        previewUrl: file.previewUrl ? "[masked]" : "",
        storageUrl: file.storageUrl ? "[masked]" : "",
        downloadUrlMasked: file.downloadUrl ? maskUrlForLog(file.downloadUrl) : "",
        previewUrlMasked: file.previewUrl ? maskUrlForLog(file.previewUrl) : "",
        storageUrlMasked: file.storageUrl ? maskUrlForLog(file.storageUrl) : ""
    };
}

function sanitizeOrderForLog(order) {
    return {
        ...order,
        items: (order.items || []).map((item) => ({
            ...item,
            customFiles: (item.customFiles || []).map(maskCustomFileForLog)
        }))
    };
}

async function fetchEtsyOrderDetailForCustomFiles({ shopId, orderId }) {
    const urls = [
        {
            type: "html",
            url: `https://www.etsy.com/your/orders/sold/${encodeURIComponent(orderId)}`
        },
        {
            type: "json",
            url: `https://www.etsy.com/api/v3/ajax/bespoke/shop/${encodeURIComponent(shopId)}/mission-control/orders/${encodeURIComponent(orderId)}`
        }
    ];
    const attempts = [];

    for (const candidate of urls) {
        try {
            const data = candidate.type === "json"
                ? await fetchJson(candidate.url)
                : await fetchText(candidate.url);
            attempts.push({
                urlMasked: maskUrlForLog(candidate.url),
                ok: true,
                type: candidate.type,
                data
            });
        } catch (error) {
            attempts.push({
                urlMasked: maskUrlForLog(candidate.url),
                ok: false,
                type: candidate.type,
                error: error?.message || String(error)
            });
        }

        await sleep(350);
    }

    return attempts;
}

async function enrichOrdersWithCustomData({
    orders,
    shopId,
    includeCustomizations = true,
    includeCustomFiles = true,
    customFileDetailMode = "auto_upload_detail",
    targetOrderId = ""
}) {
    let detailFetchFailedCount = 0;

    for (const order of Array.isArray(orders) ? orders : []) {
        const rawOrder = order.rawSnapshot?.order || {};
        const items = Array.isArray(order.orderItems) ? order.orderItems : [];

        if (includeCustomizations) {
            for (const item of items) {
                if (!item.customizations) {
                    item.customizations = {
                        textFields: [],
                        buyerNote: String(rawOrder?.notes?.note_from_buyer || ""),
                        raw: null
                    };
                }
            }
        }

        if (!includeCustomFiles) {
            for (const item of items) item.customFiles = [];
            continue;
        }

        for (const item of items) {
            item.customFiles = Array.isArray(item.customFiles) ? item.customFiles : [];
            const rawTransaction = item.rawTransaction || {};
            const candidates = findDeepCustomFileCandidates(rawTransaction, "transaction");
            const orderCandidates = findDeepCustomFileCandidates(rawOrder, "order");
            const combinedCandidates = [...candidates, ...orderCandidates].slice(0, 100);

            if (combinedCandidates.length) {
                console.log("[LNG][content][CUSTOM_FILE_DEBUG][TRANSACTION_CANDIDATES]", {
                    orderId: order.orderId,
                    transactionId: item.transactionId,
                    listingId: item.listingId,
                    candidates: combinedCandidates
                });
            }

            const objectFiles = dedupeCustomFiles([
                ...extractCustomFilesFromObject(rawTransaction, {
                    source: "etsy_order_list",
                    transactionId: item.transactionId,
                    listingId: item.listingId,
                    matchConfidence: "high"
                })
            ]);

            item.customFiles = dedupeCustomFiles([...item.customFiles, ...objectFiles]);
        }

        assignCustomFilesToItems(items, extractCustomFilesFromObject(rawOrder, {
            source: "etsy_order_list",
            matchConfidence: "medium"
        }));

        if (customFileDetailMode === "detail") {
            try {
                const attempts = await fetchEtsyOrderDetailForCustomFiles({
                    shopId,
                    orderId: order.orderId
                });
                const detailFiles = [];

                for (const attempt of attempts) {
                    if (!attempt.ok) {
                        detailFetchFailedCount++;
                        console.warn("[LNG][content][CUSTOM_FILE_DETAIL_FETCH_WARN]", {
                            orderId: order.orderId,
                            urlMasked: attempt.urlMasked,
                            type: attempt.type,
                            error: attempt.error
                        });
                        continue;
                    }

                    const source = attempt.type === "json"
                        ? "etsy_order_detail_json"
                        : "etsy_order_detail_html";
                    if (attempt.type === "json") {
                        detailFiles.push(...extractCustomFilesFromObject(attempt.data, {
                            source,
                            matchConfidence: "medium"
                        }));
                    } else {
                        detailFiles.push(...extractCustomFilesFromHtml(attempt.data, {
                            source,
                            matchConfidence: "low"
                        }));
                    }
                }

                assignCustomFilesToItems(items, detailFiles);
            } catch (error) {
                detailFetchFailedCount++;
                console.warn("[LNG][content][CUSTOM_FILE_DETAIL_ERROR]", {
                    orderId: order.orderId,
                    message: error?.message || String(error)
                });
            }
        }
    }

    const allItems = (orders || []).flatMap((order) => order.orderItems || []);
    console.log("[LNG][content][CUSTOMIZATION_SUMMARY]", {
        totalOrders: Array.isArray(orders) ? orders.length : 0,
        totalItems: allItems.length,
        itemsWithCustomText: allItems.filter((item) => (item.customizations?.textFields || []).length > 0).length,
        itemsWithCustomFiles: allItems.filter((item) => (item.customFiles || []).length > 0).length,
        totalCustomFiles: allItems.reduce((sum, item) => sum + ((item.customFiles || []).length), 0),
        detailFetchFailedCount
    });

    if (targetOrderId) {
        console.log("[LNG][content][CUSTOM_FILE_TARGET_ORDER]", {
            targetOrderId,
            foundOrders: Array.isArray(orders) ? orders.length : 0,
            customFileDetailMode,
            itemsWithCustomFiles: allItems.filter((item) => (item.customFiles || []).length > 0).length,
            totalCustomFiles: allItems.reduce((sum, item) => sum + ((item.customFiles || []).length), 0)
        });
    }
}

function assignCustomFilesToItems(items, files) {
    const safeItems = Array.isArray(items) ? items : [];
    for (const file of dedupeCustomFiles(files)) {
        let target = safeItems.find((item) =>
            file.transactionId && String(item.transactionId) === String(file.transactionId)
        );
        if (!target) {
            target = safeItems.find((item) =>
                file.listingId && String(item.listingId) === String(file.listingId)
            );
        }
        if (!target) {
            target = safeItems[0];
            file.matchConfidence = "low";
        }
        if (!target) continue;

        file.transactionId = file.transactionId || String(target.transactionId || "");
        file.listingId = file.listingId || String(target.listingId || "");
        target.customFiles = dedupeCustomFiles([...(target.customFiles || []), file]);
    }
}

function mapOrders({ raw, shopName, orderStates }) {
    const orders = [];
    let skipped = 0;

    const stateNameById = {};
    for (const s of orderStates || []) {
        stateNameById[String(s.order_state_id)] = s.name;
    }

    for (const orderId of raw.order_ids) {
        const order = raw.orders_by_id?.[String(orderId)];

        if (!order) {
            skipped++;
            continue;
        }

        const buyerId = order.buyer_id || order.buyer?.user_id;
        const buyer = raw.buyers_by_id?.[String(buyerId)] || {};

        const fulfillment = order.fulfillment || {};
        const toAddress = fulfillment.to_address || {};

        const payment = order.payment || {};
        const costBreakdown = payment.cost_breakdown || {};

        const transactions = Array.isArray(order.transactions)
            ? order.transactions
            : [];

        const buyerName = toAddress.name || buyer.name || "";
        const { firstName, lastName } = splitName(buyer.first_name, buyer.last_name, buyerName);

        const sellerCode = extractSellerCode(transactions);
        const orderItems = transactions.map((transaction) => {
            return mapTransaction({
                transaction,
                order,
                costBreakdown
            });
        });

        logSkuDebugStage("ORDER_ITEMS_SKU_SUMMARY", {
            orderId: String(order.order_id || orderId),
            buyerName,
            items: orderItems.map((it) => ({
                transactionId: it.transactionId,
                listingId: it.listingId,
                title: String(it.productTitle || "").slice(0, 80),
                quantity: it.quantity,
                sku: it.sku,
                hasSku: !!it.sku
            })),
            missingSkuCount: orderItems.filter((it) => !it.sku).length
        });

        orders.push({
            platform: "etsy",
            shop: shopName || "",

            orderId: String(order.order_id || orderId),
            orderUrl: order.order_url || "",

            statusName: stateNameById[String(order.order_state_id)] || "",
            orderStateId: order.order_state_id || null,

            buyerName,
            buyerFirstName: firstName,
            buyerLastName: lastName,
            buyerUserId: buyer.user_id ? String(buyer.user_id) : (buyerId ? String(buyerId) : ""),
            buyerEmail: buyer.email || "",
            buyerNote: order.notes?.note_from_buyer || "",

            address: toAddress.first_line || "",
            address2: toAddress.second_line || "",
            city: toAddress.city || "",
            state: toAddress.state || "",
            zipCode: toAddress.zip || "",
            country: toAddress.country || "",
            phoneNumber: toAddress.phone || "",

            shippingService: fulfillment.shipping_method || "",
            isUSPSVerified: Boolean(toAddress.is_usps_verified),

            orderDate: unixToIso(order.order_date),
            purchaseDate: unixToIso(payment.payment_date),
            shippedAt: unixToIso(fulfillment.actual_ship_date) || null,

            estimatedDeliveryDate: fulfillment.estimated_delivery_date || null,

            currency:
                costBreakdown.total_cost?.currency_code ||
                costBreakdown.currency_code ||
                payment.currency_code ||
                "USD",

            paymentMethod: payment.payment_method || payment.method || "",

            sellerCode,

            isFullyPaid: Boolean(payment.is_fully_paid),

            financial: {
                total: moneyValue(costBreakdown.total_cost),
                itemsCost: moneyValue(costBreakdown.items_cost),
                adjustedItemsCost: moneyFormatted(costBreakdown.items_cost),

                adjustedShippingCost: moneyFormatted(costBreakdown.adjusted_shipping_cost),
                adjustedTotalCost: moneyFormatted(costBreakdown.adjusted_total_cost),

                discount: moneyValue(costBreakdown.discount),
                adjustedDiscount: moneyFormatted(costBreakdown.discount),

                discounted: moneyValue(costBreakdown.discounted_items_cost),
                adjustedDiscounted: moneyFormatted(costBreakdown.discounted_items_cost),

                tax: moneyValue(costBreakdown.tax_cost),
                shippingCost: moneyValue(costBreakdown.shipping_cost),
                shippingDiscount: moneyValue(costBreakdown.shipping_discount),
                refund: moneyValue(costBreakdown.refund)
            },

            orderItems,

            rawSnapshot: {
                order,
                buyer
            }
        });
    }

    console.log("[LNG][content] mapOrders done", {
        inputIds: raw.order_ids.length,
        output: orders.length,
        skipped
    });

    return orders;
}

function mapTransaction({ transaction, order }) {
    const product = transaction.product || {};
    const skuCandidates = {
        product_product_identifier: product.product_identifier || "",
        transaction_sku: transaction.sku || "",
        product_sku: product.sku || "",
        transaction_productIdentifier: transaction.productIdentifier || "",
        transaction_product_identifier: transaction.product_identifier || "",
        transaction_listing_id: transaction.listing_id || "",
        transaction_id: transaction.transaction_id || ""
    };

    const pickedSku =
        product.product_identifier ||
        transaction.sku ||
        product.sku ||
        transaction.productIdentifier ||
        transaction.product_identifier ||
        "";

    const quantity = Number(transaction.quantity || 0);
    const unitPrice = moneyValue(transaction.cost);
    const itemTotal = round2(unitPrice * quantity);

    const variationsArr = normalizeVariations(transaction.variations || transaction.properties || []);
    const customizations = extractEtsyCustomTextFields({
        transaction,
        order,
        variationsArr
    });

    logSkuDebugStage("RAW_TRANSACTION_SKU", {
        orderId: String(order.order_id || ""),
        transactionId: String(transaction.transaction_id || ""),
        listingId: String(transaction.listing_id || ""),
        title: product.title || transaction.title || "",
        quantity,
        skuCandidates,
        pickedSku,
        rawProductKeys: Object.keys(product || {}),
        rawTransactionKeys: Object.keys(transaction || {})
    });

    return {
        orderIdEtsy: String(order.order_id || ""),

        listingId: String(transaction.listing_id || ""),
        transactionId: String(transaction.transaction_id || ""),

        sku: pickedSku,
        productTitle: product.title || transaction.title || "",
        productImage: product.image_url_75x75 || product.image_url || "",

        quantity,
        unitPrice,
        itemTotal,

        cost: unitPrice,

        note: order.notes?.note_from_buyer || "",

        properties: JSON.stringify(variationsArr),
        variationsArray: variationsArr,
        variationsObject: variationsArrayToObject(variationsArr),
        customizations,
        customFiles: [],
        rawTransaction: transaction,

        cost_breakdown: transaction.cost_breakdown || null,

        trackingStatus:
            order.fulfillment?.status?.physical_status?.shipping_status?.tracking_status?.summary ||
            ""
    };
}

function variationsArrayToObject(variationsArr) {
    const obj = {};
    for (const v of variationsArr || []) {
        if (v && v.formatted_name) {
            obj[v.formatted_name] = v.formatted_value || "";
        }
    }
    return obj;
}

function splitName(firstName, lastName, fallbackFullName) {
    if (firstName || lastName) {
        return {
            firstName: firstName || "",
            lastName: lastName || ""
        };
    }
    const parts = String(fallbackFullName || "").trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) {
        return { firstName: "", lastName: "" };
    }
    if (parts.length === 1) {
        return { firstName: parts[0], lastName: "" };
    }
    return {
        firstName: parts[0],
        lastName: parts.slice(1).join(" ")
    };
}

function extractSellerCode(transactions) {
    for (const tx of transactions || []) {
        const sku =
            (tx?.product?.product_identifier) ||
            tx?.sku ||
            "";
        const m = String(sku).match(/^([A-Z]\d{3,5})/i);
        if (m) return m[1].toUpperCase();
    }
    return "";
}

function round2(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

function centsToUsd(value) {
    return round2(getSafeNumber(value) / 100);
}

function isoToDate(value) {
    // Schema dùng kiểu Date; trả về ISO string (Mongoose tự cast)
    return value || null;
}

function toBackendOrder(o, ctx) {
    const items = (o.orderItems || []).map(toBackendItem);

    logSkuDebugStage("BACKEND_ORDER_SKU_SUMMARY", {
        orderId: o.orderId,
        sellerCode: o.sellerCode || "",
        items: items.map((it) => ({
            transactionId: it.transactionId,
            listingId: it.listingId,
            itemName: String(it.itemName || "").slice(0, 80),
            sku: it.sku,
            hasSku: !!it.sku
        })),
        missingSkuCount: items.filter((it) => !it.sku).length
    });

    const numberOfItems = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);

    const orderTotal = o.financial?.total ?? 0;
    const orderShipping = o.financial?.shippingCost ?? 0;
    const orderTax = o.financial?.tax ?? 0;
    const itemsCost = o.financial?.itemsCost ?? 0;
    const discount = o.financial?.discount ?? 0;
    const shippingDiscount = o.financial?.shippingDiscount ?? 0;

    return {
        orderId: o.orderId,

        // shopId (ObjectId 24-hex) se duoc service-worker stamp tu config truoc khi POST.
        // etsyShopId / shopName chi de informational, BE Mongoose strict se drop neu khong co trong schema.
        shopId: null,
        etsyShopId: ctx.etsyShopId,
        shopName: ctx.shopName,

        saleDate: isoToDate(o.orderDate),
        paidAt: isoToDate(o.purchaseDate),
        shippedAt: isoToDate(o.shippedAt),

        status: o.statusName || "New",

        orderType: null,
        listingsType: null,
        paymentType: null,
        paymentMethod: o.paymentMethod || "",
        currency: (o.currency || "USD").slice(0, 3),

        buyer: {
            userId: o.buyerUserId || "",
            fullName: o.buyerName || "",
            firstName: o.buyerFirstName || "",
            lastName: o.buyerLastName || "",
            display: o.buyerName || ""
        },

        seller: {
            sellerId: null,
            sellerCode: o.sellerCode || ""
        },

        coupon: {
            code: "",
            details: ""
        },

        shipping: {
            name: o.buyerName || "",
            address1: o.address || "",
            address2: o.address2 || "",
            city: o.city || "",
            state: o.state || "",
            zipcode: o.zipCode || "",
            country: o.country || ""
        },

        shipping_type: "Standard",

        totals: {
            orderValue: round2(itemsCost),
            shipping: round2(orderShipping),
            salesTax: round2(orderTax),
            orderTotal: round2(orderTotal),
            cardProcessingFees: 0,
            orderNet: 0,

            fee: 0,

            adjustedOrderTotal: 0,
            adjustedCardProcessingFees: 0,
            adjustedNet: 0,
            adjustedOrderValue: 0,
            adjustedShipping: 0,
            adjustedSalesTax: 0,

            orderShipping: round2(orderShipping),
            orderSalesTax: round2(orderTax),
            discountAmount: round2(discount),
            shippingDiscount: round2(shippingDiscount),
            inPersonDiscount: 0,
            vatPaidByBuyer: 0
        },

        base_cost: 0,
        base_cost_computed_at: null,
        base_cost_shipping_groups: [],

        numberOfItems,

        items,

        address_validation: {
            isValid: null,
            smartyResponse: null
        }
    };
}

function toBackendItem(it) {
    logSkuDebugStage("TO_BACKEND_ITEM_SKU", {
        orderIdEtsy: it.orderIdEtsy || "",
        transactionId: String(it.transactionId || ""),
        listingId: String(it.listingId || ""),
        title: String(it.productTitle || "").slice(0, 80),
        skuBeforeBackend: it.sku || "",
        hasSku: !!it.sku
    });

    return {
        transactionId: String(it.transactionId || ""),
        listingId: String(it.listingId || ""),
        sku: it.sku || "",

        itemName: it.productTitle || "",
        quantity: Number(it.quantity) || 1,
        unitPrice: round2(it.unitPrice ?? it.cost ?? 0),
        itemTotal: round2(it.itemTotal ?? ((it.unitPrice ?? it.cost ?? 0) * (it.quantity || 0))),

        variationsRaw: it.properties || "",
        variations: it.variationsObject || {},
        cost_breakdown: it.cost_breakdown || null,
        customizations: it.customizations || {
            textFields: [],
            buyerNote: "",
            raw: null
        },
        customFiles: Array.isArray(it.customFiles) ? it.customFiles : [],

        baseImage: {
            imageUrl: it.productImage || "",
            width: 75,
            height: 75
        }
    };
}

function normalizeVariations(variations) {
    if (!Array.isArray(variations)) {
        return [];
    }

    return variations.map((variation) => ({
        formatted_name:
            variation.property ||
            variation.formatted_name ||
            variation.name ||
            "",

        formatted_value:
            variation.value ||
            variation.formatted_value ||
            ""
    }));
}

function moneyValue(money) {
    if (!money) {
        return 0;
    }

    if (typeof money.value === "number") {
        return money.value / 100;
    }

    if (typeof money.amount === "number" && typeof money.divisor === "number") {
        return money.amount / money.divisor;
    }

    return 0;
}

function moneyFormatted(money) {
    return money?.formatted_value || "";
}

function unixToIso(value) {
    if (!value) {
        return null;
    }

    const timestamp = Number(value);

    if (!Number.isFinite(timestamp)) {
        return null;
    }

    return new Date(timestamp * 1000).toISOString();
}

function normalizeCarrierInput(value) {
    const raw = String(value || "").trim();
    const upper = raw.toUpperCase();

    if (!raw) return "";
    if (upper.includes("YUN") || upper.includes("YT")) return "Yun Express";
    if (upper.includes("YANWEN") || upper === "UK" || upper === "UL") return "Yanwen";
    if (upper.includes("USPS")) return "USPS";

    return raw;
}

function inferCarrierFromTrackingNumber(trackingNumber) {
    const value = String(trackingNumber || "").trim().toUpperCase();

    if (value.startsWith("92") || value.startsWith("42")) return "USPS";
    if (value.startsWith("UK") || value.startsWith("UL")) return "Yanwen";
    if (value.startsWith("YT")) return "Yun Express";

    return "";
}

function resolveEtsyCarrierPayload({ carrier, trackingNumber }) {
    const normalizedCarrier =
        normalizeCarrierInput(carrier) ||
        inferCarrierFromTrackingNumber(trackingNumber);

    if (normalizedCarrier === "USPS") {
        return {
            carrier: "USPS",
            carrierId: "1",
            carrierName: "",
            source: carrier ? "payload" : "tracking_prefix",
            useOtherCarrierName: false
        };
    }

    if (normalizedCarrier) {
        return {
            carrier: normalizedCarrier,
            carrierId: "-1",
            carrierName: normalizedCarrier,
            source: carrier ? "payload" : "tracking_prefix",
            useOtherCarrierName: true
        };
    }

    return {
        carrier: "Other",
        carrierId: "-1",
        carrierName: "",
        source: "fallback_other",
        useOtherCarrierName: true
    };
}

async function uploadTrackingToEtsy(payload = {}) {
    const orderId = String(payload.orderId || "").trim();
    const trackingNumber = String(payload.trackingNumber || "").trim();
    const requestedCarrier = normalizeCarrierInput(payload.carrier);

    if (!orderId) {
        throw new Error("Missing Etsy orderId");
    }

    if (!trackingNumber) {
        throw new Error("Missing trackingNumber");
    }

    console.log("[LNG][content][UPLOAD_TRACKING] start", {
        orderId,
        trackingNumber,
        requestedCarrier
    });

    const auth = await getEtsyUploadAuth();
    const carrierInfo = resolveEtsyCarrierPayload({
        carrier: payload.carrier,
        trackingNumber
    });

    console.log("[LNG][content][UPLOAD_TRACKING] carrier resolved", {
        orderId,
        trackingNumberPrefix: trackingNumber.slice(0, 4),
        requestedCarrier,
        resolvedCarrier: carrierInfo.carrier,
        carrierId: carrierInfo.carrierId,
        carrierName: carrierInfo.carrierName,
        carrierSource: carrierInfo.source,
        useOtherCarrierName: carrierInfo.useOtherCarrierName
    });

    const url =
        `https://www.etsy.com/api/v3/ajax/bespoke/shop/${auth.shopId}` +
        `/mission-control/order-state/batch-complete`;

    const body = new URLSearchParams();

    body.set("orders[0][order_id]", orderId);
    body.set("orders[0][note]", "");
    body.set("orders[0][carrier]", carrierInfo.carrierId);
    if (carrierInfo.useOtherCarrierName) {
        body.set("orders[0][other_carrier]", carrierInfo.carrierName);
    }
    body.set("orders[0][tracking_number]", trackingNumber);
    body.set("orders[0][has_selected_tracking_exclusion]", "false");
    body.set("orders[0][selected_tracking_exclusion_reason]", "");
    body.set("orders[0][other_tracking_exclusion_reason_desc]", "");
    body.set("orders[0][ship_date]", "0");

    console.log("[LNG][content][UPLOAD_TRACKING] POST Etsy", {
        url,
        shopId: auth.shopId,
        orderId,
        trackingNumber,
        carrier: carrierInfo.carrier,
        carrierId: carrierInfo.carrierId,
        carrierName: carrierInfo.carrierName,
        carrierSource: carrierInfo.source
    });

    const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-CSRF-Token": auth.csrfNonce,
            "X-Requested-With": "XMLHttpRequest"
        },
        body: body.toString()
    });

    const responseText = await response.text();
    let responseBody = null;

    try {
        responseBody = JSON.parse(responseText || "{}");
    } catch (_) {
        responseBody = null;
    }

    console.log("[LNG][content][UPLOAD_TRACKING] Etsy response", {
        status: response.status,
        ok: response.ok,
        preview: responseText.slice(0, 500)
    });

    if (!response.ok) {
        throw new Error(
            `Etsy upload tracking failed ${response.status}: ${responseText.slice(0, 300)}`
        );
    }

    console.log("[LNG][content][UPLOAD_TRACKING] parsed response", {
        status: response.status,
        ok: response.ok,
        success: responseBody?.success || null,
        errors: responseBody?.errors || null
    });

    const errors = responseBody?.errors;
    const success = responseBody?.success;
    const hasErrors =
        errors &&
        typeof errors === "object" &&
        Object.keys(errors).length > 0;

    if (hasErrors) {
        throw new Error(
            `Etsy upload tracking returned errors: ${JSON.stringify(errors).slice(0, 700)}`
        );
    }

    const hasSuccess =
        Array.isArray(success) ? success.length > 0 : Boolean(success);

    if (!hasSuccess) {
        throw new Error(
            `Etsy upload tracking returned no success: ${responseText.slice(0, 700)}`
        );
    }

    if (looksLikeLoginOrCsrfError(responseText)) {
        throw new Error(
            `Etsy response looks like login/csrf error: ${responseText.slice(0, 300)}`
        );
    }

    return {
        ok: true,
        platform: "etsy",
        shopId: auth.shopId,
        shopName: auth.shopName,
        orderId,
        trackingNumber,
        carrier: carrierInfo.carrier,
        carrierId: carrierInfo.carrierId,
        carrierName: carrierInfo.carrierName,
        carrierSource: carrierInfo.source,
        status: response.status,
        responseBody,
        responsePreview: responseText.slice(0, 500),
        uploadedAt: new Date().toISOString()
    };
}

async function getEtsyUploadAuth() {
    const soldPageUrl = "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav";

    console.log("[LNG][content][UPLOAD_TRACKING] fetch auth page", soldPageUrl);

    const response = await fetch(soldPageUrl, {
        method: "GET",
        credentials: "include",
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
    });

    const html = await response.text();

    console.log("[LNG][content][UPLOAD_TRACKING] auth page response", {
        status: response.status,
        htmlLength: html.length
    });

    if (!response.ok) {
        throw new Error(`Cannot load Etsy sold page ${response.status}`);
    }

    //   if (looksLikeLoginOrCsrfError(html)) {
    //     throw new Error("Etsy đang yêu cầu đăng nhập lại hoặc session đã hết hạn.");
    //   }

    const text = decodeHtmlEntities(html);
    console.log("[LNG][content][UPLOAD_TRACKING][CARRIER_DISCOVERY]", {
        hasYunExpress: text.includes("YunExpress") || text.includes("Yun Express"),
        has4PX: text.includes("4PX"),
        hasYanwen: text.includes("Yanwen"),
        hasUSPS: text.includes("USPS")
    });

    const shopId =
        matchFirst(text, /"shopId"\s*:\s*"?(\d+)"?/) ||
        matchFirst(text, /"shop_id"\s*:\s*"?(\d+)"?/) ||
        matchFirst(text, /"shop_id"\s*:\s*(\d+)/);

    const shopName =
        matchFirst(text, /"shopName"\s*:\s*"([^"]+)"/) ||
        matchFirst(text, /"shop_name"\s*:\s*"([^"]+)"/) ||
        "";

    const csrfNonce =
        matchFirst(
            text,
            /<meta[^>]+name=["']csrf_nonce["'][^>]+content=["']([^"']+)["']/i
        ) ||
        matchFirst(text, /"csrf_nonce"\s*:\s*"([^"]+)"/i) ||
        matchFirst(text, /csrf_nonce['"]?\s*[:=]\s*['"]([^'"]+)/i);

    if (!shopId) {
        throw new Error("Không lấy được Etsy shopId. Hãy kiểm tra đã login đúng Etsy seller chưa.");
    }

    if (!csrfNonce) {
        throw new Error("Không lấy được csrf_nonce từ Etsy sold page.");
    }

    return {
        shopId,
        shopName,
        csrfNonce
    };
}

function looksLikeLoginOrCsrfError(text) {
    const value = String(text || "").toLowerCase();

    return (
        value.includes("forbidden") ||
        value.includes("unauthorized") ||
        value.includes("authentication") ||
        value.includes("invalid csrf") ||
        value.includes("csrf token") ||
        value.includes("sign in to continue") ||
        value.includes("please sign in") ||
        value.includes("you need to sign in")
    );
}

var ETSY_ADS_DEBUG_COMPARE_PROMOTED_PARAM = false;
var ETSY_ADS_DEBUG_COMPARE_DATE_OFFSET = false;

function emitEtsyAdsReconLog(tag, data = {}) {
    console.log(`[LNG][content][ETSY_ADS][RECON][${tag}]`, data);

    try {
        chrome.runtime.sendMessage({
            action: "ETSY_ADS_RECON_LOG",
            payload: {
                tag,
                data,
                at: new Date().toISOString()
            }
        }).catch(() => { });
    } catch (_) { }
}

function safeEmitEtsyAdsReconLog(tag, data = {}) {
    try {
        emitEtsyAdsReconLog(tag, data);
    } catch (error) {
        console.warn("[LNG][content][ETSY_ADS][RECON_LOG_ERROR]", {
            tag,
            message: error?.message || String(error)
        });
    }
}

function getEtsyAdsStatsObject(row = {}) {
    return (
        row.totalStats ||
        row.total_stats ||
        row.stats ||
        row.ad_stats ||
        row.listing?.totalStats ||
        row.listing?.total_stats ||
        {}
    );
}

function getEtsyAdsListingObject(row = {}) {
    return row.listing || row || {};
}

function getSafeNumber(value) {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function summarizeEtsyAdsRows(rows = []) {
    const summary = {
        rows: rows.length,
        spend: 0,
        spendUsd: 0,
        revenue: 0,
        revenueUsd: 0,
        views: 0,
        clicks: 0,
        orders: 0,
        missingListingIdRows: 0,
        promotedTrueRows: 0,
        promotedFalseRows: 0,
        promotedMissingRows: 0,
        normalRows: 0,
        extraCandidateRows: 0,
        unknownPromotedStatusRows: 0
    };

    for (const row of rows) {
        summary.spend += getSafeNumber(row.spend);
        summary.revenue += getSafeNumber(row.revenue);
        summary.views += getSafeNumber(row.views);
        summary.clicks += getSafeNumber(row.clicks);
        summary.orders += getSafeNumber(row.orders);

        if (!row.listingId) summary.missingListingIdRows++;
        if (row.sourceFlags?.isPromotedKnown === false) summary.promotedMissingRows++;
        if (row.sourceFlags?.isPromotedFromApi === true) summary.promotedTrueRows++;
        if (row.sourceFlags?.isPromotedKnown === true && row.sourceFlags?.isPromotedFromApi === false) {
            summary.promotedFalseRows++;
        }
        if (row.reconcileStatus === "normal") summary.normalRows++;
        if (row.reconcileStatus === "extra_candidate") summary.extraCandidateRows++;
        if (row.reconcileStatus === "unknown_promoted_status") summary.unknownPromotedStatusRows++;
    }

    summary.spendUsd = Math.round((summary.spend / 100) * 100) / 100;
    summary.revenueUsd = Math.round((summary.revenue / 100) * 100) / 100;

    return summary;
}

function summarizeRawEtsyAdsListings(listings = []) {
    const summary = {
        rows: listings.length,
        spend: 0,
        spendUsd: 0,
        revenue: 0,
        revenueUsd: 0,
        views: 0,
        clicks: 0,
        orders: 0,
        zeroSpendRows: 0,
        nonZeroSpendRows: 0,
        missingListingIdRows: 0,
        missingStatsRows: 0,
        promotedTrueRows: 0,
        promotedFalseRows: 0,
        promotedMissingRows: 0
    };

    for (const row of listings) {
        const rawListing = getEtsyAdsListingObject(row);
        const stats = getEtsyAdsStatsObject(row);

        const listingId =
            rawListing.listingId ??
            rawListing.listing_id ??
            rawListing.id ??
            row.listingId ??
            row.listing_id ??
            row.id ??
            "";

        if (!listingId) summary.missingListingIdRows++;
        if (!stats || Object.keys(stats).length === 0) summary.missingStatsRows++;

        const promotedRaw =
            rawListing.isPromoted ??
            rawListing.is_promoted ??
            row.isPromoted ??
            row.is_promoted;

        if (promotedRaw === true) summary.promotedTrueRows++;
        else if (promotedRaw === false) summary.promotedFalseRows++;
        else summary.promotedMissingRows++;

        const spend = getSafeNumber(
            stats.spentTotal ??
            stats.spent_total ??
            stats.spendTotal ??
            stats.spend_total ??
            stats.spend
        );
        const revenue = getSafeNumber(
            stats.revenue ??
            stats.revenueTotal ??
            stats.revenue_total
        );
        const views = getSafeNumber(
            stats.impressionCount ??
            stats.impression_count ??
            stats.views ??
            stats.impressions ??
            stats.ad_views
        );
        const clicks = getSafeNumber(
            stats.clickCount ??
            stats.click_count ??
            stats.clicks ??
            stats.click_total
        );
        const orders = getSafeNumber(
            stats.conversions ??
            stats.orders ??
            stats.orders_total
        );

        summary.spend += spend;
        summary.revenue += revenue;
        summary.views += views;
        summary.clicks += clicks;
        summary.orders += orders;

        if (spend > 0) summary.nonZeroSpendRows++;
        else summary.zeroSpendRows++;
    }

    summary.spendUsd = Math.round((summary.spend / 100) * 100) / 100;
    summary.revenueUsd = Math.round((summary.revenue / 100) * 100) / 100;

    return summary;
}

function findDuplicateValues(values = []) {
    const seen = new Set();
    const duplicates = new Set();

    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    }

    return Array.from(duplicates);
}

function shouldKeepEtsyAdsRow(row, filterMode = "spend_only") {
    if (filterMode === "full_stats") {
        return (
            Number(row.spend || 0) > 0 ||
            Number(row.views || 0) > 0 ||
            Number(row.clicks || 0) > 0 ||
            Number(row.orders || 0) > 0 ||
            Number(row.revenue || 0) > 0
        );
    }

    return Number(row.spend || 0) > 0;
}

function describeDateOffset(days) {
    const n = Number(days);

    if (n === 0) return "targetDate_same_day";
    if (n === -1) return "targetDate_minus_1_day";
    if (n < 0) return `targetDate_minus_${Math.abs(n)}_days`;

    return `targetDate_plus_${n}_days`;
}

function getFirstDeepValue(source, keys = []) {
    const wanted = new Set(keys);
    const seen = new Set();

    function walk(value) {
        if (!value || typeof value !== "object" || seen.has(value)) return undefined;
        if (Array.isArray(value)) return undefined;
        seen.add(value);

        for (const key of Object.keys(value)) {
            if (wanted.has(key) && value[key] !== undefined && value[key] !== null) {
                return value[key];
            }
        }

        for (const key of Object.keys(value)) {
            const found = walk(value[key]);
            if (found !== undefined && found !== null) return found;
        }

        return undefined;
    }

    return walk(source);
}

function moneyToCents(value) {
    if (value && typeof value === "object") {
        if (typeof value.value === "number") return value.value;
        if (typeof value.amount === "number" && typeof value.divisor === "number") {
            return round2((value.amount / value.divisor) * 100);
        }
        if (typeof value.amount === "number") return value.amount;
    }

    return getSafeNumber(value);
}

function parseEtsyAdsOverviewStats(raw, date) {
    if (Array.isArray(raw?.graph_stats)) {
        const totals = raw.graph_stats.reduce((sum, row) => {
            sum.spend += getSafeNumber(row.spent_total ?? row.spentTotal ?? row.spend ?? 0);
            sum.revenue += getSafeNumber(row.revenue ?? row.revenue_total ?? row.revenueTotal ?? 0);
            sum.views += getSafeNumber(row.impression_count ?? row.impressionCount ?? row.views ?? 0);
            sum.clicks += getSafeNumber(row.click_count ?? row.clickCount ?? row.clicks ?? 0);
            sum.orders += getSafeNumber(row.conversions ?? row.orders ?? row.order_count ?? 0);
            return sum;
        }, {
            spend: 0,
            revenue: 0,
            views: 0,
            clicks: 0,
            orders: 0
        });

        return {
            date,
            spend: round2(totals.spend),
            spendUsd: centsToUsd(totals.spend),
            revenue: round2(totals.revenue),
            revenueUsd: centsToUsd(totals.revenue),
            views: totals.views,
            clicks: totals.clicks,
            orders: totals.orders,
            roas: totals.spend > 0 ? round2(totals.revenue / totals.spend) : 0,
            raw
        };
    }

    // fallback cũ của bạn giữ lại phía dưới nếu cần
}

function normalizeEtsyAdsOverviewMoneyUnits(overview, listingSpend) {
    const spend = getSafeNumber(overview?.spend);
    const referenceSpend = getSafeNumber(listingSpend);

    if (!overview || spend <= 0 || referenceSpend <= 0) return overview;

    const directDiff = Math.abs(spend - referenceSpend);
    const centsDiff = Math.abs(round2(spend * 100) - referenceSpend);

    if (centsDiff >= directDiff) return overview;

    const normalizedSpend = round2(spend * 100);
    const normalizedRevenue = round2(getSafeNumber(overview.revenue) * 100);

    console.warn("[LNG][content][ETSY_ADS][OVERVIEW_MONEY_UNIT_NORMALIZED]", {
        date: overview.date,
        originalSpend: spend,
        originalRevenue: overview.revenue,
        normalizedSpend,
        normalizedRevenue,
        referenceListingSpend: referenceSpend,
        message: "Overview money looked like USD while dashboard expects cents; normalized to cents."
    });

    return {
        ...overview,
        spend: normalizedSpend,
        spendUsd: centsToUsd(normalizedSpend),
        revenue: normalizedRevenue,
        revenueUsd: centsToUsd(normalizedRevenue),
        roas: overview.roas || (normalizedSpend > 0 ? round2(normalizedRevenue / normalizedSpend) : 0)
    };
}

async function fetchEtsyAdsOverviewStats({ etsyShopId, date }) {
    const urls = [
        `https://www.etsy.com/api/v3/ajax/shop/${etsyShopId}/prolist/stats/overview` +
        `?start_date=${encodeURIComponent(date)}` +
        `&end_date=${encodeURIComponent(date)}`,
        `https://www.etsy.com/api/v3/ajax/shop/${etsyShopId}/prolist/stats/summary` +
        `?start_date=${encodeURIComponent(date)}` +
        `&end_date=${encodeURIComponent(date)}`,
        `https://www.etsy.com/api/v3/ajax/shop/${etsyShopId}/prolist/stats` +
        `?start_date=${encodeURIComponent(date)}` +
        `&end_date=${encodeURIComponent(date)}`
    ];
    let lastError = null;

    for (const url of urls) {
        console.log("[LNG][content][ETSY_ADS][OVERVIEW_REQUEST]", {
            etsyShopId,
            date,
            url
        });

        try {
            const response = await fetch(url, {
                method: "GET",
                credentials: "include",
                headers: {
                    "Accept": "application/json, text/plain, */*"
                }
            });
            const text = await response.text();

            console.log("[LNG][content][ETSY_ADS][OVERVIEW_RESPONSE]", {
                date,
                status: response.status,
                ok: response.ok,
                url,
                preview: text.slice(0, 800)
            });

            if (!response.ok) {
                lastError = new Error(`Etsy Ads overview failed ${response.status}: ${text.slice(0, 300)}`);
                continue;
            }

            const raw = JSON.parse(text || "{}");
            console.log("[LNG][content][ETSY_ADS][OVERVIEW_RAW]", {
                date,
                url,
                topKeys: Object.keys(raw || {}),
                raw
            });

            const parsedStats = parseEtsyAdsOverviewStats(raw, date);

            if (!parsedStats) {
                throw new Error("Etsy Ads overview response did not contain supported totals shape");
            }

            const parsed = {
                ...parsedStats,
                sourceUrl: url
            };

            console.log("[LNG][content][ETSY_ADS][OVERVIEW_PARSED_TOTALS]", {
                date,
                sourceUrl: url,
                spend: parsed.spend,
                spendUsd: parsed.spendUsd,
                revenue: parsed.revenue,
                revenueUsd: parsed.revenueUsd,
                views: parsed.views,
                clicks: parsed.clicks,
                orders: parsed.orders,
                roas: parsed.roas
            });

            return parsed;
        } catch (error) {
            lastError = error;
            console.warn("[LNG][content][ETSY_ADS][OVERVIEW_ENDPOINT_FAILED]", {
                date,
                url,
                message: error?.message || String(error)
            });
        }
    }

    throw lastError || new Error("Etsy Ads overview failed: no endpoint returned usable data");
}

async function resolveBestEtsyAdsDate({ etsyShopId, selectedDate, listingSpend }) {
    const candidates = [
        shiftYMD(selectedDate, -1),
        selectedDate,
        shiftYMD(selectedDate, 1)
    ];
    const results = [];

    for (const candidateDate of candidates) {
        try {
            const rawOverview = await fetchEtsyAdsOverviewStats({
                etsyShopId,
                date: candidateDate
            });
            const overview = normalizeEtsyAdsOverviewMoneyUnits(rawOverview, listingSpend);
            results.push({
                date: candidateDate,
                ok: true,
                spend: overview.spend,
                spendUsd: overview.spendUsd,
                revenue: overview.revenue,
                revenueUsd: overview.revenueUsd,
                views: overview.views,
                clicks: overview.clicks,
                orders: overview.orders,
                roas: overview.roas,
                spendDiff: Math.abs(getSafeNumber(overview.spend) - getSafeNumber(listingSpend)),
                overview
            });
        } catch (error) {
            results.push({
                date: candidateDate,
                ok: false,
                spend: null,
                spendUsd: null,
                revenue: null,
                revenueUsd: null,
                views: null,
                clicks: null,
                orders: null,
                roas: null,
                spendDiff: Number.POSITIVE_INFINITY,
                error: error?.message || String(error)
            });
        }
    }

    console.log("[LNG][content][ETSY_ADS][OVERVIEW_DATE_COMPARE]");
    console.table(results.map(({ overview, ...row }) => row));

    const successful = results.filter((row) => row.ok);
    const best = successful.sort((a, b) => a.spendDiff - b.spendDiff)[0] || null;

    if (!best) {
        throw new Error("Etsy Ads overview failed for selected date, date - 1, and date + 1");
    }

    console.log("[LNG][content][ETSY_ADS][OVERVIEW_BEST_DATE]", {
        selectedDate,
        bestDate: best.date,
        listingSpend,
        overviewSpend: best.spend,
        spendDiff: best.spendDiff
    });

    return {
        bestDate: best.date,
        overview: best.overview,
        candidates: results.map(({ overview, ...row }) => row)
    };
}

async function exportEtsyAdsSpend(payload = {}) {
    const date = String(payload.date || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Missing or invalid Etsy Ads date YYYY-MM-DD");
    }

    const startedAt = performance.now();
    const runId = String(payload.runId || `etsy_ads:${date}:${Date.now()}`);
    const requestedQueryDateOffsetDays = Number.isFinite(Number(payload.queryDateOffsetDays))
        ? Number(payload.queryDateOffsetDays)
        : 0;
    const queryDateOffsetDays = 0;
    const filterMode = payload.filterMode === "full_stats" ? "full_stats" : "spend_only";
    const isPromotedParam = "";
    const allowListingFallback = payload.allowListingFallback === true;
    const autoResolveOverviewDate = false;
    const dryRun = payload.dryRun === true;
    const debugComparePromotedParam =
        payload.debugComparePromotedParam === true || ETSY_ADS_DEBUG_COMPARE_PROMOTED_PARAM === true;
    const debugCompareDateOffset =
        payload.debugCompareDateOffset === true || ETSY_ADS_DEBUG_COMPARE_DATE_OFFSET === true;
    const requestedDebugCompareMaxPages = Number(payload.debugCompareMaxPages || 2);
    const debugCompareMaxPages = Math.max(
        1,
        Math.min(Number.isFinite(requestedDebugCompareMaxPages) ? requestedDebugCompareMaxPages : 2, 50)
    );

    console.log("[LNG][content][ETSY_ADS] exportEtsyAdsSpend start", {
        runId,
        date,
        requestedQueryDateOffsetDays,
        queryDateOffsetDays,
        allowListingFallback,
        autoResolveOverviewDate,
        filterMode,
        dryRun,
        debugComparePromotedParam,
        debugCompareDateOffset,
        debugCompareMaxPages
    });

    const bootstrap = await getEtsyAdsBootstrap();

    console.log("[LNG][content][ETSY_ADS] bootstrap", {
        etsyShopId: bootstrap.shopId,
        shopName: bootstrap.shopName
    });

    const targetDate = date;
    const etsyApiDate = shiftYMD(targetDate, queryDateOffsetDays);

    console.log("[LNG][content][ETSY_ADS] date mapping", {
        runId,
        targetDate,
        etsyApiDate,
        requestedQueryDateOffsetDays,
        queryDateOffsetDays,
        note: "Production Etsy Ads API query date is locked to selected date."
    });

    if (targetDate !== etsyApiDate) {
        safeEmitEtsyAdsReconLog("DATE_OFFSET_WARNING", {
            runId,
            selectedDate: date,
            targetDate,
            apiDate: etsyApiDate,
            requestedQueryDateOffsetDays,
            queryDateOffsetDays,
            message: "Selected date and API query date are different. This may cause Etsy UI mismatch."
        });
    }

    const result = await fetchAllEtsyAdsListingStats({
        runId,
        etsyShopId: bootstrap.shopId,
        date: targetDate,
        queryDate: etsyApiDate,
        queryDateOffsetDays,
        filterMode,
        selectedDate: date,
        isPromotedParam
    });

    if (dryRun && debugComparePromotedParam) {
        await compareEtsyAdsPromotedParam({
            runId,
            etsyShopId: bootstrap.shopId,
            selectedDate: date,
            targetDate,
            queryDate: etsyApiDate,
            queryDateOffsetDays,
            filterMode,
            maxPages: debugCompareMaxPages
        });
    }

    if (dryRun && debugCompareDateOffset) {
        await compareEtsyAdsDateOffset({
            runId,
            etsyShopId: bootstrap.shopId,
            selectedDate: date,
            targetDate,
            filterMode
        });
    }

    const rows = result.rows;
    const durationMs = Math.round(performance.now() - startedAt);
    const listingTotals = summarizeEtsyAdsRows(rows);
    let overview = null;
    let overviewApiDate = targetDate;
    let overviewDateCandidates = [];
    let overviewError = null;
    let overviewFallbackUsed = false;
    let totalsSource = "etsy_ads_overview_api";

    try {
        const rawOverview = await fetchEtsyAdsOverviewStats({
            etsyShopId: bootstrap.shopId,
            date: targetDate
        });

        overview = normalizeEtsyAdsOverviewMoneyUnits(rawOverview, listingTotals.spend);
        overviewApiDate = targetDate;
        overviewDateCandidates = [{
            date: targetDate,
            ok: true,
            spend: overview.spend,
            spendUsd: overview.spendUsd,
            revenue: overview.revenue,
            revenueUsd: overview.revenueUsd,
            views: overview.views,
            clicks: overview.clicks,
            orders: overview.orders,
            roas: overview.roas,
            spendDiff: Math.abs(getSafeNumber(overview.spend) - getSafeNumber(listingTotals.spend)),
            autoResolveOverviewDate: false
        }];

        console.log("[LNG][content][ETSY_ADS][OVERVIEW_VS_LISTING_TOTALS]");
        console.table([{
            selectedDate: date,
            listingApiDate: etsyApiDate,
            overviewApiDate,
            listingSpend: listingTotals.spend,
            listingSpendUsd: listingTotals.spendUsd,
            overviewSpend: overview.spend,
            overviewSpendUsd: overview.spendUsd,
            spendDiff: round2(getSafeNumber(overview.spend) - getSafeNumber(listingTotals.spend)),
            listingRevenue: listingTotals.revenue,
            listingRevenueUsd: listingTotals.revenueUsd,
            overviewRevenue: overview.revenue,
            overviewRevenueUsd: overview.revenueUsd,
            revenueDiff: round2(getSafeNumber(overview.revenue) - getSafeNumber(listingTotals.revenue)),
            listingOrders: listingTotals.orders,
            overviewOrders: overview.orders,
            ordersDiff: round2(getSafeNumber(overview.orders) - getSafeNumber(listingTotals.orders)),
            listingViews: listingTotals.views,
            overviewViews: overview.views,
            viewsDiff: round2(getSafeNumber(overview.views) - getSafeNumber(listingTotals.views)),
            listingClicks: listingTotals.clicks,
            overviewClicks: overview.clicks,
            clicksDiff: round2(getSafeNumber(overview.clicks) - getSafeNumber(listingTotals.clicks))
        }]);

        if (Math.abs(getSafeNumber(overview.spend) - getSafeNumber(listingTotals.spend)) > 1) {
            console.warn("[LNG][content][ETSY_ADS][OVERVIEW_SPEND_MISMATCH]", {
                selectedDate: date,
                listingApiDate: etsyApiDate,
                overviewApiDate,
                listingSpend: listingTotals.spend,
                listingSpendUsd: listingTotals.spendUsd,
                overviewSpend: overview.spend,
                overviewSpendUsd: overview.spendUsd,
                message: "Dashboard totals will still prefer overview.spend."
            });
        }
    } catch (error) {
        overviewError = error?.message || String(error);
        console.warn("[LNG][content][ETSY_ADS][OVERVIEW_FAILED]", {
            selectedDate: date,
            listingApiDate: etsyApiDate,
            listingSpend: listingTotals.spend,
            listingSpendUsd: listingTotals.spendUsd,
            allowListingFallback,
            message: overviewError
        });

        if (!allowListingFallback) {
            throw new Error("Etsy Ads overview API failed; listing fallback disabled to avoid inaccurate totals");
        }

        overviewFallbackUsed = true;
        totalsSource = "listing_rows_sum_fallback";
        overviewDateCandidates = [{
            date: targetDate,
            ok: false,
            error: overviewError,
            autoResolveOverviewDate: false
        }];
    }

    const overviewTotals = overview ? {
        spend: overview.spend,
        spendUsd: overview.spendUsd,
        revenue: overview.revenue,
        revenueUsd: overview.revenueUsd,
        views: overview.views,
        clicks: overview.clicks,
        orders: overview.orders,
        roas: overview.roas,
        date: overview.date,
        sourceUrl: overview.sourceUrl
    } : null;
    const finalTotals = overview ? {
        totalSpend: overview.spend,
        totalRevenue: overview.revenue,
        totalViews: overview.views,
        totalClicks: overview.clicks,
        totalOrders: overview.orders,
        roas: overview.roas
    } : {
        totalSpend: listingTotals.spend,
        totalRevenue: listingTotals.revenue,
        totalViews: listingTotals.views,
        totalClicks: listingTotals.clicks,
        totalOrders: listingTotals.orders,
        roas: listingTotals.spend > 0 ? round2(listingTotals.revenue / listingTotals.spend) : 0
    };

    const summary = {
        rowCount: rows.length,
        rawRows: result.rawRows.length,
        totalPages: result.pageLogs.length,
        totalSpend: finalTotals.totalSpend,
        totalRevenue: finalTotals.totalRevenue,
        totalViews: finalTotals.totalViews,
        totalClicks: finalTotals.totalClicks,
        totalOrders: finalTotals.totalOrders,
        roas: finalTotals.roas,
        filterMode,
        requestedQueryDateOffsetDays,
        queryDateOffsetDays,
        autoResolveOverviewDate,
        allowListingFallback,
        overviewSource: totalsSource,
        totalsSource,
        overviewFallbackUsed,
        overviewApiDate,
        durationMs
    };

    console.log("[LNG][content][ETSY_ADS] FINAL SUMMARY");
    console.table([{
        date,
        runId,
        etsyShopId: bootstrap.shopId,
        shopName: bootstrap.shopName,
        targetDate,
        etsyApiDate,
        listingApiDate: etsyApiDate,
        overviewApiDate,
        requestedQueryDateOffsetDays,
        queryDateOffsetDays,
        autoResolveOverviewDate,
        filterMode,
        totalPages: summary.totalPages,
        rawRows: summary.rawRows,
        keptRows: summary.rowCount,
        totalSpend: summary.totalSpend,
        totalRevenue: summary.totalRevenue,
        totalViews: summary.totalViews,
        totalClicks: summary.totalClicks,
        totalOrders: summary.totalOrders,
        roas: summary.roas,
        overviewSource: summary.overviewSource,
        totalsSource: summary.totalsSource,
        overviewFallbackUsed: summary.overviewFallbackUsed,
        durationMs
    }]);

    safeEmitEtsyAdsReconLog("FINAL_TOTALS", {
        runId,
        selectedDate: date,
        targetDate,
        etsyApiDate,
        listingApiDate: etsyApiDate,
        overviewApiDate,
        requestedQueryDateOffsetDays,
        queryDateOffsetDays,
        autoResolveOverviewDate,
        allowListingFallback,
        filterMode,
        etsyShopId: bootstrap.shopId,
        shopName: bootstrap.shopName,
        allTotals: result.allTotals,
        keptTotals: result.keptTotals,
        droppedTotals: result.droppedTotals,
        overviewTotals,
        totalsSource,
        overviewFallbackUsed,
        overviewDateCandidates,
        overviewError,
        totalPages: summary.totalPages,
        durationMs,
        note: totalsSource === "etsy_ads_overview_api"
            ? "Dashboard totals use Etsy Ads overview API; listing rows remain for per-listing detail."
            : "Overview API failed; dashboard totals fell back to prolist.stats.listings rows."
    });

    console.log("[LNG][content][ETSY_ADS] PAGE SUMMARY TABLE");
    console.table(result.pageLogs);

    console.log("[LNG][content][ETSY_ADS] SPEND ROWS TABLE");
    console.table(
        rows.map((r, idx) => ({
            "#": idx + 1,
            date: r.date,
            listingId: r.listingId,
            title: String(r.title || "").slice(0, 60),
            state: r.state,
            spend: r.spend,
            views: r.views,
            clicks: r.clicks,
            orders: r.orders,
            revenue: r.revenue
        }))
    );

    console.groupCollapsed("[LNG][content][ETSY_ADS] FULL ROWS JSON");
    console.log(JSON.stringify(rows, null, 2));
    console.groupEnd();

    return {
        ok: true,
        platform: "etsy",
        etsyShopId: bootstrap.shopId,
        shopName: bootstrap.shopName,
        date,
        rows,
        summary,
        raw: {
            pageLogs: result.pageLogs,
            rawRowCount: result.rawRows.length,
            targetDate,
            etsyApiDate,
            listingApiDate: etsyApiDate,
            overviewApiDate,
            requestedQueryDateOffsetDays,
            queryDateOffsetDays,
            autoResolveOverviewDate,
            allowListingFallback,
            dateOffsetRule: describeDateOffset(queryDateOffsetDays),
            listingSource: "prolist.stats.listings",
            overview: overview ? overview.raw : null,
            listingTotals,
            finalTotalsSource: totalsSource,
            overviewDateCandidates,
            overviewError,
            isPromotedParam,
            sortType: "spent_total",
            filterMode,
            mapperVersion: "etsy_ads_listing_mapper.v2.camel_snake_reconcile",
            rawSummaryMode: "direct_raw_not_mapper",
            listingReconcileVersion: "listing_reconcile.v1",
            allTotals: result.allTotals,
            keptTotals: result.keptTotals,
            droppedTotals: result.droppedTotals
        },
        sourceMeta: {
            runId,
            overviewSource: totalsSource,
            overviewFallbackUsed,
            totalsSource,
            listingSource: "prolist.stats.listings",
            selectedDate: date,
            targetDate,
            etsyApiDate,
            listingApiDate: etsyApiDate,
            overviewApiDate,
            allowListingFallback,
            requestedQueryDateOffsetDays,
            queryDateOffsetDays,
            autoResolveOverviewDate,
            dateOffsetRule: describeDateOffset(queryDateOffsetDays),
            isPromotedParam,
            sortType: "spent_total",
            filterMode,
            keptRule: filterMode === "full_stats" ? "any_stats_gt_0" : "spend_gt_0",
            listingRowsKeptRule: filterMode === "full_stats" ? "any_stats_gt_0" : "spend_gt_0",
            listingTotalsAudit: listingTotals,
            overviewTotals,
            totalsRule: "final_totals_from_overview_api_only",
            mapperVersion: "etsy_ads_listing_mapper.v2.camel_snake_reconcile",
            rawSummaryMode: "direct_raw_not_mapper",
            listingReconcileVersion: "listing_reconcile.v1",
            notes: totalsSource === "etsy_ads_overview_api"
                ? "Listing rows are preserved for detail; dashboard totals come from Etsy Ads overview API."
                : "Overview API failed; fallback dashboard totals come from listing rows.",
            overviewDateCandidates,
            overviewError,
            allTotals: result.allTotals,
            keptTotals: result.keptTotals,
            droppedTotals: result.droppedTotals
        },
        syncedAt: new Date().toISOString()
    };
}

async function getEtsyAdsBootstrap() {
    const soldPageUrl = "https://www.etsy.com/your/orders/sold?ref=seller-platform-mcnav";

    const html = await fetchText(soldPageUrl);
    const bootstrap = parseEtsyBootstrap(html);

    if (!bootstrap.shopId) {
        throw new Error("Không lấy được Etsy shopId để kéo Etsy Ads.");
    }

    return bootstrap;
}

async function fetchAllEtsyAdsListingStats({
    runId = "",
    etsyShopId,
    date,
    queryDate,
    queryDateOffsetDays = 0,
    filterMode = "spend_only",
    selectedDate = date,
    isPromotedParam = ""
}) {
    let offset = 0;
    const limit = 50;

    const all = [];
    const pageLogs = [];

    let totalCount = null;
    let pageIndex = 0;

    while (true) {
        pageIndex++;

        const page = await fetchEtsyAdsListingStatsPage({
            runId,
            etsyShopId,
            date: queryDate,
            selectedDate,
            targetDate: date,
            queryDateOffsetDays,
            offset,
            limit,
            isPromotedParam
        });

        const listings = Array.isArray(page.listings) ? page.listings : [];

        if (pageIndex === 1 && listings[0]) {
            console.log("[LNG][content][ETSY_ADS][FIRST_RAW_LISTING_KEYS]", {
                keys: Object.keys(listings[0]),
                totalStatsKeys: Object.keys(listings[0].total_stats || listings[0].totalStats || {}),
                firstListing: listings[0]
            });
        }
        if (totalCount === null) {
            totalCount = Number(
                page.filteredListingCount ||
                page.filtered_listing_count ||
                page.totalCount ||
                page.total_count ||
                page.count ||
                listings.length ||
                0
            );
        }

        const mapped = listings.map((listing) =>
            mapEtsyAdsListingRow({
                listing,
                date
            })
        );

        const rawSummary = summarizeRawEtsyAdsListings(listings);
        const mappedSummary = summarizeEtsyAdsRows(mapped);

        safeEmitEtsyAdsReconLog("RAW_PAGE_SUMMARY", {
            runId,
            page: pageIndex,
            offset,
            limit,
            apiDate: queryDate,
            detectedTotalCount: totalCount,
            rawSummary
        });

        safeEmitEtsyAdsReconLog("RAW_VS_MAPPED_DIFF", {
            runId,
            page: pageIndex,
            offset,
            rawRows: rawSummary.rows,
            mappedRows: mappedSummary.rows,
            rawSpend: rawSummary.spend,
            mappedSpend: mappedSummary.spend,
            diffSpend: mappedSummary.spend - rawSummary.spend,
            rawRevenue: rawSummary.revenue,
            mappedRevenue: mappedSummary.revenue,
            diffRevenue: mappedSummary.revenue - rawSummary.revenue,
            rawViews: rawSummary.views,
            mappedViews: mappedSummary.views,
            diffViews: mappedSummary.views - rawSummary.views,
            rawClicks: rawSummary.clicks,
            mappedClicks: mappedSummary.clicks,
            diffClicks: mappedSummary.clicks - rawSummary.clicks,
            rawOrders: rawSummary.orders,
            mappedOrders: mappedSummary.orders,
            diffOrders: mappedSummary.orders - rawSummary.orders,
            rawMissingListingIdRows: rawSummary.missingListingIdRows,
            mappedMissingListingIdRows: mappedSummary.missingListingIdRows,
            rawMissingStatsRows: rawSummary.missingStatsRows,
            rawPromotedTrueRows: rawSummary.promotedTrueRows,
            mappedPromotedTrueRows: mappedSummary.promotedTrueRows,
            rawPromotedMissingRows: rawSummary.promotedMissingRows,
            mappedPromotedMissingRows: mappedSummary.promotedMissingRows
        });

        all.push(...mapped);

        const pageSpend = mapped.reduce(
            (sum, row) => sum + Number(row.spend || 0),
            0
        );

        const pageSpendRows = mapped.filter(
            (row) => Number(row.spend || 0) > 0
        ).length;

        const pageLog = {
            page: pageIndex,
            offset,
            limit,
            pageRows: listings.length,
            pageSpendRows,
            pageSpend,
            accumulatedRows: all.length,
            totalCount
        };

        pageLogs.push(pageLog);

        console.log("[LNG][content][ETSY_ADS] PAGE FETCHED");
        console.table([pageLog]);

        if (mapped.length) {
            console.log(`[LNG][content][ETSY_ADS] PAGE ${pageIndex} SAMPLE TABLE`);
            console.table(
                mapped.slice(0, 10).map((r, idx) => ({
                    "#": idx + 1,
                    listingId: r.listingId,
                    title: String(r.title || "").slice(0, 50),
                    spend: r.spend,
                    views: r.views,
                    clicks: r.clicks,
                    orders: r.orders,
                    revenue: r.revenue
                }))
            );
        }

        offset += limit;

        if (!listings.length) {
            console.warn("[LNG][content][ETSY_ADS] Stop paging: empty page", {
                page: pageIndex,
                offset,
                totalCount
            });
            break;
        }

        if (totalCount && offset >= totalCount) {
            console.log("[LNG][content][ETSY_ADS] Stop paging: reached totalCount", {
                offset,
                totalCount
            });
            break;
        }

        await sleep(300);
    }

    const kept = all.filter((row) => shouldKeepEtsyAdsRow(row, filterMode));
    const dropped = all.filter((row) => !shouldKeepEtsyAdsRow(row, filterMode));
    const allListingIds = all.map((r) => r.listingId).filter(Boolean);
    const keptListingIds = kept.map((r) => r.listingId).filter(Boolean);
    const duplicateListingIds = findDuplicateValues(allListingIds);
    const allTotals = summarizeEtsyAdsRows(all);
    const keptTotals = summarizeEtsyAdsRows(kept);
    const droppedTotals = summarizeEtsyAdsRows(dropped);

    console.log("[LNG][content][ETSY_ADS] ALL PAGES SUMMARY");
    console.table(pageLogs);

    console.log("[LNG][content][ETSY_ADS] PROCESSED SUMMARY");
    console.table([{
        rawRows: all.length,
        keptRows: kept.length,
        totalSpend: kept.reduce((sum, r) => sum + Number(r.spend || 0), 0)
    }]);

    console.log("[LNG][content][ETSY_ADS][RECON][LISTING_ID_SUMMARY]");
    console.table([{
        runId,
        allRows: all.length,
        allUniqueListingIds: new Set(allListingIds).size,
        keptRows: kept.length,
        keptUniqueListingIds: new Set(keptListingIds).size,
        duplicateListingIds: allListingIds.length - new Set(allListingIds).size
    }]);

    safeEmitEtsyAdsReconLog("LISTING_ID_SUMMARY", {
        runId,
        allRows: all.length,
        allUniqueListingIds: new Set(allListingIds).size,
        keptRows: kept.length,
        keptUniqueListingIds: new Set(keptListingIds).size,
        duplicateListingIds: allListingIds.length - new Set(allListingIds).size
    });

    if (duplicateListingIds.length) {
        console.warn("[LNG][content][ETSY_ADS][RECON][DUPLICATE_LISTING_IDS]", duplicateListingIds);
        safeEmitEtsyAdsReconLog("DUPLICATE_LISTING_IDS", {
            runId,
            listingIds: duplicateListingIds.slice(0, 100)
        });
    }

    const toReconRow = (row, idx) => ({
        "#": idx + 1,
        listingId: row.listingId,
        title: String(row.title || "").slice(0, 60),
        spend: row.spend,
        views: row.views,
        clicks: row.clicks,
        orders: row.orders,
        revenue: row.revenue,
        isPromotedKnown: row.sourceFlags?.isPromotedKnown,
        isPromotedFromApi: row.sourceFlags?.isPromotedFromApi,
        rawPromotedValue: row.sourceFlags?.rawPromotedValue,
        sectionName: row.sourceFlags?.sectionName,
        apiState: row.sourceFlags?.apiState,
        reconcileStatus: row.reconcileStatus,
        reconcileReason: row.reconcileReason
    });
    const extraCandidateRows = kept
        .filter((row) => row.reconcileStatus === "extra_candidate")
        .slice(0, 30)
        .map(toReconRow);
    const unknownPromotedStatusRows = kept
        .filter((row) => row.reconcileStatus === "unknown_promoted_status")
        .slice(0, 30)
        .map(toReconRow);
    const conversionRows = kept
        .filter((row) => Number(row.orders || 0) > 0 || Number(row.revenue || 0) > 0)
        .slice(0, 30)
        .map(toReconRow);

    console.log("[LNG][content][ETSY_ADS][RECON][EXTRA_CANDIDATE_ROWS]");
    console.table(extraCandidateRows);
    console.log("[LNG][content][ETSY_ADS][RECON][UNKNOWN_PROMOTED_STATUS_ROWS]");
    console.table(unknownPromotedStatusRows);
    console.log("[LNG][content][ETSY_ADS][RECON][CONVERSION_ROWS]");
    console.table(conversionRows);

    safeEmitEtsyAdsReconLog("EXTRA_CANDIDATE_ROWS", { runId, rows: extraCandidateRows });
    safeEmitEtsyAdsReconLog("UNKNOWN_PROMOTED_STATUS_ROWS", { runId, rows: unknownPromotedStatusRows });
    safeEmitEtsyAdsReconLog("CONVERSION_ROWS", { runId, rows: conversionRows });

    safeEmitEtsyAdsReconLog("FILTER_DIFF", {
        runId,
        filterMode,
        allTotals,
        keptTotals,
        droppedTotals,
        droppedRowsSample: dropped.slice(0, 20).map((row) => ({
            listingId: row.listingId,
            title: String(row.title || "").slice(0, 60),
            spend: row.spend,
            views: row.views,
            clicks: row.clicks,
            orders: row.orders,
            revenue: row.revenue,
            sectionName: row.sectionName,
            isPromotedFromApi: row.sourceFlags?.isPromotedFromApi
        }))
    });

    return {
        rawRows: all,
        rows: kept,
        pageLogs,
        allTotals,
        keptTotals,
        droppedTotals
    };
}

async function fetchEtsyAdsDebugRows({
    runId,
    etsyShopId,
    selectedDate,
    targetDate,
    queryDate,
    queryDateOffsetDays,
    filterMode,
    isPromotedParam,
    maxPages = 2
}) {
    const limit = 50;
    let offset = 0;
    const rows = [];

    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
        const page = await fetchEtsyAdsListingStatsPage({
            runId,
            etsyShopId,
            date: queryDate,
            selectedDate,
            targetDate,
            queryDateOffsetDays,
            offset,
            limit,
            isPromotedParam
        });

        const listings = Array.isArray(page.listings) ? page.listings : [];
        rows.push(...listings.map((listing) => mapEtsyAdsListingRow({ listing, date: targetDate })));

        if (!listings.length) break;
        offset += limit;
        await sleep(300);
    }

    const kept = rows.filter((row) => shouldKeepEtsyAdsRow(row, filterMode));

    return {
        rows,
        kept,
        totals: summarizeEtsyAdsRows(kept),
        listingIds: kept.map((row) => row.listingId).filter(Boolean)
    };
}

async function compareEtsyAdsPromotedParam({
    runId,
    etsyShopId,
    selectedDate,
    targetDate,
    queryDate,
    queryDateOffsetDays,
    filterMode,
    maxPages = 2
}) {
    const blank = await fetchEtsyAdsDebugRows({
        runId: `${runId}:promoted_blank`,
        etsyShopId,
        selectedDate,
        targetDate,
        queryDate,
        queryDateOffsetDays,
        filterMode,
        isPromotedParam: "",
        maxPages
    });

    const promotedTrue = await fetchEtsyAdsDebugRows({
        runId: `${runId}:promoted_true`,
        etsyShopId,
        selectedDate,
        targetDate,
        queryDate,
        queryDateOffsetDays,
        filterMode,
        isPromotedParam: "true",
        maxPages
    });

    const blankIds = new Set(blank.listingIds);
    const trueIds = new Set(promotedTrue.listingIds);
    const extraInBlank = Array.from(blankIds).filter((id) => !trueIds.has(id));
    const missingInBlank = Array.from(trueIds).filter((id) => !blankIds.has(id));

    safeEmitEtsyAdsReconLog("PROMOTED_PARAM_COMPARE", {
        runId,
        apiDate: queryDate,
        filterMode,
        pagesCompared: maxPages,
        blank: {
            ...blank.totals,
            listingIdsSample: blank.listingIds.slice(0, 30)
        },
        true: {
            ...promotedTrue.totals,
            listingIdsSample: promotedTrue.listingIds.slice(0, 30)
        },
        extraInBlank: extraInBlank.slice(0, 100),
        missingInBlank: missingInBlank.slice(0, 100)
    });
}

async function compareEtsyAdsDateOffset({
    runId,
    etsyShopId,
    selectedDate,
    targetDate,
    filterMode
}) {
    const minusOneDate = shiftYMD(targetDate, -1);
    const zeroDate = shiftYMD(targetDate, 0);

    const offsetMinus1 = await fetchAllEtsyAdsListingStats({
        runId: `${runId}:offset_minus_1`,
        etsyShopId,
        date: targetDate,
        queryDate: minusOneDate,
        queryDateOffsetDays: -1,
        filterMode,
        selectedDate
    });

    const offset0 = await fetchAllEtsyAdsListingStats({
        runId: `${runId}:offset_0`,
        etsyShopId,
        date: targetDate,
        queryDate: zeroDate,
        queryDateOffsetDays: 0,
        filterMode,
        selectedDate
    });

    safeEmitEtsyAdsReconLog("DATE_OFFSET_COMPARE", {
        runId,
        selectedDate,
        offsetMinus1: {
            apiDate: minusOneDate,
            rows: offsetMinus1.keptTotals.rows,
            spendUsd: offsetMinus1.keptTotals.spendUsd,
            revenueUsd: offsetMinus1.keptTotals.revenueUsd,
            views: offsetMinus1.keptTotals.views,
            clicks: offsetMinus1.keptTotals.clicks,
            orders: offsetMinus1.keptTotals.orders
        },
        offset0: {
            apiDate: zeroDate,
            rows: offset0.keptTotals.rows,
            spendUsd: offset0.keptTotals.spendUsd,
            revenueUsd: offset0.keptTotals.revenueUsd,
            views: offset0.keptTotals.views,
            clicks: offset0.keptTotals.clicks,
            orders: offset0.keptTotals.orders
        },
        note: "Compare these totals with Etsy UI manually. This debug path does not POST backend."
    });
}

async function fetchEtsyAdsListingStatsPage({
    runId = "",
    etsyShopId,
    date,
    selectedDate = date,
    targetDate = date,
    queryDateOffsetDays = 0,
    offset,
    limit,
    isPromotedParam = ""
}) {
    const promotedParam =
        isPromotedParam === undefined || isPromotedParam === null
            ? ""
            : String(isPromotedParam);

    const url =
        `https://www.etsy.com/api/v3/ajax/shop/${etsyShopId}/prolist/stats/listings` +
        `?start_date=${encodeURIComponent(date)}` +
        `&end_date=${encodeURIComponent(date)}` +
        `&sort_type=spent_total` +
        `&sort_order=desc` +
        `&offset=${offset}` +
        `&limit=${limit}` +
        `&scopes%5B%5D=available_public` +
        `&is_promoted=${encodeURIComponent(promotedParam)}`;

    console.log("[LNG][content][ETSY_ADS][LISTING_REQUEST_PROFILE]", {
        runId,
        selectedDate,
        targetDate,
        apiDate: date,
        offset,
        limit,
        isPromotedParam,
        finalIsPromotedQueryValue: promotedParam,
        url
    });

    safeEmitEtsyAdsReconLog("REQUEST_PROFILE", {
        runId,
        etsyShopId,
        selectedDate,
        targetDate,
        apiDate: date,
        queryDateOffsetDays,
        offset,
        limit,
        endpoint: "/api/v3/ajax/shop/{etsyShopId}/prolist/stats/listings",
        sortType: "spent_total",
        sortOrder: "desc",
        scope: "available_public",
        isPromotedParam,
        finalIsPromotedQueryValue: promotedParam,
        url
    });

    console.log("[LNG][content][ETSY_ADS][REQUEST]", {
        runId,
        requestedDate: date,
        offset,
        limit,
        url
    });

    const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
            "Accept": "application/json, text/plain, */*"
        }
    });

    const text = await response.text();

    console.log("[LNG][content][ETSY_ADS] stats response", {
        requestedDate: date,
        status: response.status,
        ok: response.ok,
        offset,
        url,
        preview: text.slice(0, 500)
    });

    if (!response.ok) {
        throw new Error(`Etsy Ads stats failed ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
        const json = JSON.parse(text || "{}");

        if (offset === 0) {
            console.log("[LNG][content][ETSY_ADS][RESPONSE_SHAPE]", {
                requestedDate: date,
                topKeys: Object.keys(json || {}),
                listingCount: Array.isArray(json?.listings) ? json.listings.length : null,
                firstListingKeys: Object.keys(json?.listings?.[0] || {}),
                firstListing: json?.listings?.[0] || null
            });
        }

        return json;
    } catch (error) {
        throw new Error(`Etsy Ads stats non-JSON: ${text.slice(0, 300)}`);
    }
}

function shiftYMD(date, days) {
    const [yyyy, mm, dd] = String(date).split("-").map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    d.setUTCDate(d.getUTCDate() + days);

    return [
        d.getUTCFullYear(),
        String(d.getUTCMonth() + 1).padStart(2, "0"),
        String(d.getUTCDate()).padStart(2, "0")
    ].join("-");
}

function mapEtsyAdsListingRow({ listing, date }) {
    const row = listing || {};
    const rawListing = getEtsyAdsListingObject(row);
    const stats = getEtsyAdsStatsObject(row);

    const listingId = String(
        rawListing.listingId ??
        rawListing.listing_id ??
        rawListing.id ??
        row.listingId ??
        row.listing_id ??
        row.id ??
        ""
    );

    const title =
        rawListing.title ||
        rawListing.listingTitle ||
        rawListing.listing_title ||
        rawListing.name ||
        row.title ||
        row.listing_title ||
        row.name ||
        "";

    const state = String(
        rawListing.state ??
        row.state ??
        ""
    );

    const sectionName =
        rawListing.sectionName ||
        rawListing.section_name ||
        row.sectionName ||
        row.section_name ||
        "";

    const spend = getSafeNumber(
        stats.spentTotal ??
        stats.spent_total ??
        stats.spendTotal ??
        stats.spend_total ??
        stats.spend
    );

    const views = getSafeNumber(
        stats.impressionCount ??
        stats.impression_count ??
        stats.views ??
        stats.impressions ??
        stats.ad_views
    );

    const clicks = getSafeNumber(
        stats.clickCount ??
        stats.click_count ??
        stats.clicks ??
        stats.click_total
    );

    const orders = getSafeNumber(
        stats.conversions ??
        stats.orders ??
        stats.orders_total
    );

    const revenue = getSafeNumber(
        stats.revenue ??
        stats.revenueTotal ??
        stats.revenue_total
    );

    const roas = getSafeNumber(stats.roas);
    const clickRate = getSafeNumber(
        stats.clickRate ??
        stats.click_rate
    );

    const promotedRaw =
        rawListing.isPromoted ??
        rawListing.is_promoted ??
        row.isPromoted ??
        row.is_promoted;

    const isPromotedKnown = promotedRaw !== undefined && promotedRaw !== null;
    const isPromotedFromApi = promotedRaw === true;

    let reconcileStatus = "normal";
    let reconcileReason = "";

    if (!listingId) {
        reconcileStatus = "extra_candidate";
        reconcileReason = "missing_listing_id";
    } else if (isPromotedKnown && !isPromotedFromApi) {
        reconcileStatus = "extra_candidate";
        reconcileReason = "is_promoted_false_from_api";
    } else if (!isPromotedKnown) {
        reconcileStatus = "unknown_promoted_status";
        reconcileReason = "is_promoted_missing_from_api";
    }

    return {
        date,
        listingId,
        title,
        state,
        sectionName,
        spend,
        views,
        clicks,
        orders,
        revenue,
        roas,
        clickRate,
        rawStats: stats,
        rawListing: row,
        sourceFlags: {
            fromListingApi: true,
            isPromotedKnown,
            isPromotedFromApi,
            rawPromotedValue: promotedRaw,
            sectionName,
            apiState: state,
            hasSpend: spend > 0,
            hasViews: views > 0,
            hasClicks: clicks > 0,
            hasOrders: orders > 0,
            hasRevenue: revenue > 0
        },
        reconcileStatus,
        reconcileReason
    };
}

async function syncEtsyMessagesDebug(payload = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(payload.limit, 10) || 20, 100));

    if (isEtsyMessageLoginRequiredPage()) {
        throw new Error("ETSY_MESSAGE_SYNC_DEBUG login required");
    }

    if (isEtsyMessageCaptchaPage()) {
        throw new Error("ETSY_MESSAGE_SYNC_DEBUG captcha/security check detected");
    }

    await sleep(1200);

    const threads = extractEtsyMessageThreadsDebug({ limit });
    const summary = {
        totalThreads: threads.length,
        unreadThreads: threads.filter((thread) => thread.unread === true).length,
        threadsWithOrderId: threads.filter((thread) => Boolean(thread.orderId)).length,
        url: location.href,
        syncedAt: new Date().toISOString()
    };

    console.log("[LNG][content][ETSY_MESSAGE_SYNC_DEBUG][SUMMARY]", summary);
    console.log("[LNG][content][ETSY_MESSAGE_SYNC_DEBUG][RAW_THREAD_SAMPLE]", threads.slice(0, 5).map((thread) => ({
        threadId: thread.threadId,
        buyerName: thread.buyerName,
        rawTextPreview: thread.__rawTextPreview || ""
    })));
    console.table(threads.map((thread) => ({
        threadId: thread.threadId,
        buyerName: thread.buyerName,
        orderId: thread.orderId,
        unread: thread.unread,
        lastMessageAt: thread.lastMessageAt,
        latestMessagePreview: thread.latestMessagePreview
    })));

    for (const thread of threads) {
        delete thread.__rawTextPreview;
    }

    return {
        ok: true,
        source: "etsy_messages_page_debug",
        threads,
        summary,
        syncedAt: new Date().toISOString()
    };
}

function extractEtsyMessageThreadsDebug({ limit = 20 } = {}) {
    const anchors = Array.from(document.querySelectorAll('a[href*="/messages"]'));
    const seen = new Set();
    const threads = [];

    for (const anchor of anchors) {
        if (threads.length >= limit) break;

        const href = anchor.href || anchor.getAttribute("href") || "";
        const threadId = extractEtsyMessageThreadId(href);

        if (!threadId || seen.has(threadId)) continue;

        seen.add(threadId);

        const root = findEtsyMessageThreadRoot(anchor);
        const text = cleanEtsyMessageText(root?.innerText || anchor.innerText || "");
        const buyerName = extractEtsyMessageBuyerName(text, anchor);
        const orderId = extractEtsyMessageOrderId(text);
        const unread = detectEtsyMessageUnread(root, anchor);
        const latestMessageBody = extractEtsyLatestMessageBody(text);
        const lastMessageAt = extractEtsyMessageDate(text);

        threads.push({
            threadId,
            buyerName,
            buyerUsername: "",
            orderId,
            unread,
            lastMessageAt,
            latestMessageBody,
            latestMessagePreview: latestMessageBody.slice(0, 180),
            sourceUrl: href.startsWith("http")
                ? href
                : new URL(href, location.origin).href,
            __rawTextPreview: text.slice(0, 500)
        });
    }

    return threads;
}

function extractEtsyMessageThreadId(url) {
    const value = String(url || "");
    const patterns = [
        /\/messages\/(\d+)/i,
        /conversation_id=(\d+)/i,
        /thread_id=(\d+)/i,
        /message_thread_id=(\d+)/i
    ];

    for (const pattern of patterns) {
        const matched = value.match(pattern);
        if (matched?.[1]) return matched[1];
    }

    return "";
}

function findEtsyMessageThreadRoot(anchor) {
    let node = anchor;

    for (let i = 0; i < 7 && node; i += 1) {
        const text = cleanEtsyMessageText(node.innerText || "");
        const linkCount = node.querySelectorAll?.('a[href*="/messages"]')?.length || 0;

        if (text.length > 20 && text.length < 3000 && linkCount <= 5) {
            return node;
        }

        node = node.parentElement;
    }

    return anchor;
}

function detectEtsyMessageUnread(root, anchor) {
    const el = root || anchor;
    const aria = String(el.getAttribute?.("aria-label") || "").toLowerCase();
    const cls = String(el.className || "").toLowerCase();
    const text = cleanEtsyMessageText(el.innerText || "").toLowerCase();

    return (
        aria.includes("unread") ||
        cls.includes("unread") ||
        text.includes("unread") ||
        Boolean(el.querySelector?.('[aria-label*="Unread"], [class*="unread"], [data-unread="true"]'))
    );
}

function extractEtsyMessageBuyerName(text, anchor) {
    const direct = cleanEtsyMessageText(anchor?.innerText || "");
    const latestMessageBody = extractEtsyLatestMessageBody(text);

    if (
        direct &&
        !direct.includes("\n") &&
        direct.length <= 80 &&
        !direct.toLowerCase().includes("message") &&
        !direct.toLowerCase().includes("order") &&
        !isEtsyMessageMetaLine(direct) &&
        direct !== latestMessageBody
    ) {
        return direct;
    }

    const lines = cleanEtsyMessageText(text || "")
        .split("\n")
        .map((line) => cleanEtsyMessageText(line))
        .filter(Boolean);

    for (const line of lines) {
        const lower = line.toLowerCase();

        if (isEtsyMessageMetaLine(line)) continue;
        if (line.length > 80) continue;
        if (lower.includes("order")) continue;
        if (lower.includes("message")) continue;
        if (line === latestMessageBody) continue;
        if (line.match(/\d{4}/)) continue;

        return line;
    }

    return "";
}

function extractEtsyLatestMessageBody(text) {
    const lines = cleanEtsyMessageText(text || "")
        .split("\n")
        .map((line) => cleanEtsyMessageText(line))
        .filter((line) => !isEtsyMessageMetaLine(line));
    const candidates = lines.filter((line) => {
        if (line.length < 3) return false;
        if (/^order\s*#?\s*\d+/i.test(line)) return false;
        if (/^receipt\s*#?\s*\d+/i.test(line)) return false;
        if (/^\d{6,}$/.test(line)) return false;
        return true;
    });

    return candidates.slice(-1)[0] || candidates[0] || "";
}

function isEtsyMessageMetaLine(line) {
    const value = cleanEtsyMessageText(line || "").toLowerCase();

    if (!value) return true;

    if (
        value === "read message" ||
        value === "unread message" ||
        value === "you have replied to this message" ||
        value === "you replied" ||
        value === "replied" ||
        value === "help request" ||
        value === "view order" ||
        value === "order" ||
        value === "messages" ||
        value === "message" ||
        value === "read" ||
        value === "unread" ||
        value === "yesterday"
    ) {
        return true;
    }

    if (/^\d+\s*(min|mins|minute|minutes|hour|hours|day|days)\s*ago$/i.test(value)) {
        return true;
    }

    if (/^order\s*#?\s*\d{6,}$/i.test(value) || /^receipt\s*#?\s*\d{6,}$/i.test(value)) {
        return true;
    }

    return false;
}

function extractEtsyMessageOrderId(text) {
    const value = String(text || "");
    const patterns = [
        /order\s*#?\s*(\d{6,})/i,
        /receipt\s*#?\s*(\d{6,})/i,
        /\b(\d{10,})\b/
    ];

    for (const pattern of patterns) {
        const matched = value.match(pattern);
        if (matched?.[1]) return matched[1];
    }

    return "";
}

function extractEtsyMessageDate(text) {
    const value = cleanEtsyMessageText(text || "");
    const relativeMatched = value.match(/\b(\d+)\s*(min|mins|minute|minutes|hour|hours|day|days)\s*ago\b/i);

    if (relativeMatched) {
        const amount = Number(relativeMatched[1]);
        const unit = relativeMatched[2].toLowerCase();
        const date = new Date();

        if (unit.startsWith("min")) {
            date.setMinutes(date.getMinutes() - amount);
        } else if (unit.startsWith("hour")) {
            date.setHours(date.getHours() - amount);
        } else if (unit.startsWith("day")) {
            date.setDate(date.getDate() - amount);
        }

        return date.toISOString();
    }

    return "";
}

function isEtsyMessageLoginRequiredPage() {
    const url = String(location.href || "").toLowerCase();
    const text = cleanEtsyMessageText(document.body?.innerText || "").toLowerCase();

    return (
        url.includes("/signin") ||
        url.includes("/login") ||
        text.includes("sign in to continue") ||
        text.includes("sign in to your account") ||
        text.includes("log in to your account") ||
        text.includes("please sign in")
    );
}

function isEtsyMessageCaptchaPage() {
    const text = cleanEtsyMessageText(document.body?.innerText || "").toLowerCase();

    return (
        text.includes("captcha") ||
        text.includes("security check") ||
        text.includes("verify you are human") ||
        text.includes("are you a robot")
    );
}

function cleanEtsyMessageText(value) {
    return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
