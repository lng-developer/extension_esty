function completionPayload(leaseToken, commandType, result) {
  return {
    leaseToken,
    success: result.success !== false,
    importJobId: result.importJobId || null,
    importedCount: Number(result.importedCount || 0),
    failedCount: Number(result.failedCount || 0),
    ...(commandType === "UPLOAD_TRACKING" && Array.isArray(result.results) ? { trackingResults: result.results } : {}),
  };
}

export async function executeNextLngWebBeCommand({ client, executeOrders, executeAds, executeTracking, validateCommand, isRetryableError }) {
  await client.heartbeat();
  const claim = await client.claimNext();
  if (!claim?.command || !claim.leaseToken) return { ok: true, idle: true };

  const executor = claim.command.type === "IMPORT_NEW_ORDERS"
    ? executeOrders
    : claim.command.type === "IMPORT_ADS_SPEND"
      ? executeAds
      : claim.command.type === "UPLOAD_TRACKING"
        ? executeTracking
      : null;
  if (!executor) {
    await client.logProgress?.('UNSUPPORTED_COMMAND', 'This extension cannot execute the received command', { activityStatus: 'UNKNOWN' });
    return { ok: false, skipped: true, reason: "UNSUPPORTED_COMMAND" };
  }
  if (!/^[a-f0-9]{24}$/i.test(String(claim.command.id || ""))) {
    await client.logProgress?.('INVALID_COMMAND_ID', 'Command identity is invalid', { activityStatus: 'UNKNOWN' });
    return { ok: false, skipped: true, reason: "INVALID_COMMAND_ID" };
  }
  if (String(claim.leaseToken).length < 20) {
    await client.logProgress?.('INVALID_LEASE_TOKEN', 'Command lease is invalid', { activityStatus: 'UNKNOWN' });
    return { ok: false, skipped: true, reason: "INVALID_LEASE_TOKEN" };
  }
  const validationError = validateCommand?.(claim.command);
  if (validationError) {
    await client.logProgress?.('VALIDATION_FAILED', 'Command validation failed; execution not started', { activityStatus: 'UNKNOWN' });
    return { ok: false, skipped: true, reason: validationError };
  }
  if (claim.command.type === "UPLOAD_TRACKING" && (!Array.isArray(claim.command.items) || !claim.command.items.length)) {
    await client.logProgress?.('VALIDATION_FAILED', 'Tracking command has no items', { activityStatus: 'UNKNOWN' });
    return { ok: false, skipped: true, reason: "Tracking commands must contain at least one item" };
  }

  await client.start(claim.command.id, claim.leaseToken);
  try {
    const result = await executor({
      commandId: claim.command.id,
      numDays: claim.command.numDays,
      dateFrom: claim.command.dateFrom,
      dateTo: claim.command.dateTo,
      items: claim.command.items,
      renewLease: typeof client.renew === "function"
        ? () => client.renew(claim.command.id, claim.leaseToken)
        : null,
    });
    await client.complete(claim.command.id, completionPayload(claim.leaseToken, claim.command.type, result));
    return { ok: true, command: claim.command, result };
  } catch (error) {
    const retryable = isRetryableError?.(error);
    await client.logProgress?.('EXECUTION_ERROR', 'Command execution interrupted', { activityStatus: retryable ? 'RETRYING' : 'FAILED', httpStatus: error.status || null });
    if (retryable) throw error;
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
