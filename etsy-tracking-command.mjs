export async function runSerialTrackingBatch({ items, upload, verify, beforeEach }) {
  const results = [];

  for (const row of items) {
    const orderId = String(row?.orderId || "").trim();
    const trackingNumber = String(row?.trackingNumber || "").trim();

    await beforeEach?.(row);

    try {
      const accepted = await upload(row);
      let verification;
      try {
        verification = verify ? await verify(row) : { etsyStatus: "ETSY_ACCEPTED" };
      } catch (error) {
        results.push({
          orderId,
          trackingNumber,
          carrier: row?.carrier || null,
          etsyStatus: "ETSY_ACCEPTED",
          acceptedAt: accepted?.acceptedAt || null,
          ok: false,
          errorMessage: String(error?.message || error).slice(0, 1000)
        });
        continue;
      }
      results.push({
        orderId,
        trackingNumber,
        carrier: row?.carrier || null,
        ok: true,
        ...(accepted?.acceptedAt ? { acceptedAt: accepted.acceptedAt } : {}),
        ...verification,
      });
    } catch (error) {
      results.push({
        orderId,
        trackingNumber,
        carrier: row?.carrier || null,
        etsyStatus: "FAILED",
        ok: false,
        errorMessage: String(error?.message || error).slice(0, 1000)
      });
    }
  }

  const importedCount = results.filter((result) => result.ok).length;
  return { importedCount, failedCount: results.length - importedCount, results };
}
