export async function runSerialTrackingBatch({ items, upload, beforeEach }) {
  const results = [];

  for (const row of items) {
    const orderId = String(row?.orderId || "").trim();
    const trackingNumber = String(row?.trackingNumber || "").trim();

    await beforeEach?.(row);

    try {
      const data = await upload(row);
      results.push({ orderId, trackingNumber, ok: true, data });
    } catch (error) {
      results.push({
        orderId,
        trackingNumber,
        ok: false,
        errorMessage: String(error?.message || error).slice(0, 1000)
      });
    }
  }

  const importedCount = results.filter((result) => result.ok).length;
  return { importedCount, failedCount: results.length - importedCount, results };
}
