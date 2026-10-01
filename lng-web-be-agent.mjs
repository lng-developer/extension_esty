function completionPayload(leaseToken, result) {
  return {
    leaseToken,
    success: true,
    importJobId: result.importJobId || null,
    importedCount: Number(result.importedCount || 0),
    failedCount: Number(result.failedCount || 0),
  };
}

export async function executeNextLngWebBeCommand({ client, executeOrders, executeAds, validateCommand, isRetryableError }) {
  await client.heartbeat();
  const claim = await client.claimNext();
  if (!claim?.command || !claim.leaseToken) return { ok: true, idle: true };

  const executor = claim.command.type === "IMPORT_NEW_ORDERS"
    ? executeOrders
    : claim.command.type === "IMPORT_ADS_SPEND"
      ? executeAds
      : null;
  if (!executor) return { ok: false, skipped: true, reason: "UNSUPPORTED_COMMAND" };
  if (!/^[a-f0-9]{24}$/i.test(String(claim.command.id || ""))) {
    return { ok: false, skipped: true, reason: "INVALID_COMMAND_ID" };
  }
  if (String(claim.leaseToken).length < 20) {
    return { ok: false, skipped: true, reason: "INVALID_LEASE_TOKEN" };
  }
  const validationError = validateCommand?.(claim.command);
  if (validationError) return { ok: false, skipped: true, reason: validationError };

  await client.start(claim.command.id, claim.leaseToken);
  try {
    const result = await executor({
      commandId: claim.command.id,
      numDays: claim.command.numDays,
      dateFrom: claim.command.dateFrom,
      dateTo: claim.command.dateTo,
    });
    await client.complete(claim.command.id, completionPayload(claim.leaseToken, result));
    return { ok: true, command: claim.command, result };
  } catch (error) {
    if (isRetryableError?.(error)) throw error;
    await client.complete(claim.command.id, {
      leaseToken: claim.leaseToken,
      success: false,
      importedCount: 0,
      failedCount: 0,
      errorMessage: String(error?.message || error).slice(0, 1000),
    });
    return { ok: false, command: claim.command, error };
  }
}
