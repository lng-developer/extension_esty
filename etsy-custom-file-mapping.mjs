export function distributeCustomFilesByItem(items = [], files = []) {
    const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];

    if (!safeItems.length || !safeFiles.length) {
        return [];
    }

    if (safeItems.length === 1) {
        return [{ ...safeItems[0], files: safeFiles }];
    }

    if (safeItems.length !== safeFiles.length) return [];

    return safeItems.map((item, index) => ({
        ...item,
        files: [safeFiles[index]]
    }));
}
