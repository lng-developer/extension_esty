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
  "LNG Expected Files", "LNG Needs Review",
  "LNG Listing Image", "LNG Listing Thumbnail",
];

export function toEtsySoldOrderItemsCsv(orders = []) {
  const rows = orders.flatMap((order) => (order?.items || []).map((item, index) => {
    if (!String(order.orderId || order.id || '').trim()) throw new Error('Order ID is required');
    if (!String(item.transactionId || item.externalItemId || '').trim()) throw new Error('Transaction ID is required');
    const shipping = order.shipping || {};
    const variations = (typeof item.variations === 'object'
      ? Object.entries(item.variations || {}).map(([key, value]) => `${key}: ${value}`).join(', ')
      : item.variations) || item.variantRaw || item.variationsRaw;
    const personalization = item.personalization ?? (item.customizations?.textFields || [])
      .map(({ name, value }) => `${name || 'Personalization'}: ${value ?? ''}`).join('\n');
    const quantity = item.quantity ?? 1;
    const price = item.unitPrice ?? item.price ?? (item.itemTotal == null ? undefined : item.itemTotal / quantity);
    return [
    order.orderId || order.id,
    item.transactionId || item.externalItemId,
    item.listingId || item.externalListingId,
    item.sku,
    item.itemName || item.title,
    quantity,
    variations,
    personalization,
    price,
    item.itemTotal ?? (price == null ? undefined : price * quantity),
    index === 0 ? order.totals?.orderSalesTax ?? order.totals?.salesTax ?? item.orderSalesTax ?? 0 : 0,
    index === 0 ? order.totals?.orderShipping ?? order.totals?.shipping ?? item.orderShipping ?? 0 : 0,
    item.currency || order.currency || "USD",
    order.paidAt || order.orderedAt,
    order.saleDate || order.orderedAt,
    shipping.name || order.shipName || order.buyerName,
    shipping.address1 ?? order.shipAddress1,
    shipping.address2 ?? order.shipAddress2,
    shipping.city ?? order.shipCity,
    shipping.state ?? order.shipState,
    shipping.zipcode ?? order.shipZipcode,
    shipping.country ?? order.shipCountry,
    (item.customFiles || []).length,
    Boolean(item.customFilesNeedsReview),
    item.baseImage?.imageUrl || '',
    item.baseImage?.thumbnailUrl || item.baseImage?.imageUrl || '',
  ]; }));
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
