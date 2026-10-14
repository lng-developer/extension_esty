export function distributeCustomFilesByItem(items = [], files = []) {
    const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];

    if (!safeItems.length || !safeFiles.length) {
        return [];
    }

    if (safeItems.length === 1) {
        return [{ ...safeItems[0], files: safeFiles }];
    }

    if (safeFiles.some((file) => !file.transactionId || !safeItems.some((item) => String(item.transactionId) === String(file.transactionId)))) return [];
    return safeItems.map((item) => ({
        ...item,
        files: safeFiles.filter((file) => String(file.transactionId) === String(item.transactionId))
    })).filter((item) => item.files.length);
}
