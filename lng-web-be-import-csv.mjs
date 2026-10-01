function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(headers, rows) {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

const ORDER_HEADERS = [
  "Order ID", "Transaction ID", "Listing ID", "SKU", "Item Name", "Quantity", "Variations", "Personalization",
  "Price", "Item Total", "Order Sales Tax", "Order Shipping", "Currency", "Date Paid", "Sale Date",
  "Ship Name", "Ship Address1", "Ship Address2", "Ship City", "Ship State", "Ship Zipcode", "Ship Country",
];

export function toEtsySoldOrderItemsCsv(orders = []) {
  const rows = orders.flatMap((order) => (order?.items || []).map((item) => [
    order.orderId || order.id,
    item.transactionId || item.externalItemId,
    item.listingId || item.externalListingId,
    item.sku,
    item.itemName || item.title,
    item.quantity || 1,
    item.variations || item.variantRaw,
    item.personalization,
    item.price,
    item.itemTotal || item.price,
    item.orderSalesTax,
    item.orderShipping,
    item.currency || order.currency || "USD",
    order.paidAt || order.orderedAt,
    order.saleDate || order.orderedAt,
    order.shipName || order.buyerName,
    order.shipAddress1,
    order.shipAddress2,
    order.shipCity,
    order.shipState,
    order.shipZipcode,
    order.shipCountry,
  ]));
  return csv(ORDER_HEADERS, rows);
}

const ADS_HEADERS = ["date", "total cost", "currency", "campaign id", "campaign name", "retailer", "impressions", "clicks"];

export function toEtsyAdsCsv(rows = []) {
  return csv(ADS_HEADERS, rows.map((row) => [
    row.date,
    row.spend ?? row.totalCost ?? 0,
    row.currency || "USD",
    row.campaignId || row.listingId,
    row.campaignName || row.listingTitle,
    row.retailer || "ETSY",
    row.impressions ?? 0,
    row.clicks ?? 0,
  ]));
}
