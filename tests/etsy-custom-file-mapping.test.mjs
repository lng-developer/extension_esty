import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { distributeCustomFilesByItem } from "../etsy-custom-file-mapping.mjs";

test("does not guess file ownership from equal item and image counts", () => {
    const assignments = distributeCustomFilesByItem(
        [
            { transactionId: "tx-1", listingId: "listing-1" },
            { transactionId: "tx-2", listingId: "listing-2" },
            { transactionId: "tx-3", listingId: "listing-3" },
            { transactionId: "tx-4", listingId: "listing-4" },
            { transactionId: "tx-5", listingId: "listing-5" }
        ],
        [
            { fileName: "IMG_3374.jpeg", previewUrl: "https://example.test/ipf/1" },
            { fileName: "IMG_3373.jpeg", previewUrl: "https://example.test/ipf/2" },
            { fileName: "IMG_3372.jpeg", previewUrl: "https://example.test/ipf/3" },
            { fileName: "IMG_3371.jpeg", previewUrl: "https://example.test/ipf/4" },
            { fileName: "IMG_3370.jpeg", previewUrl: "https://example.test/ipf/5" }
        ]
    );

    assert.deepEqual(assignments.map(({ transactionId, files }) => ({
        transactionId,
        fileNames: files.map((file) => file.fileName)
    })), []);
});

test('maps reordered files using explicit transaction evidence', () => {
    const result = distributeCustomFilesByItem([{ transactionId: 'a' }, { transactionId: 'b' }], [{ transactionId: 'b', fileName: 'b.png' }, { transactionId: 'a', fileName: 'a.png' }]);
    assert.deepEqual(result.map((item) => item.files[0].fileName), ['a.png', 'b.png']);
});

test("does not guess a per-item mapping when Etsy returns a different number of images", () => {
    const assignments = distributeCustomFilesByItem(
        [
            { transactionId: "tx-1", listingId: "listing-1" },
            { transactionId: "tx-2", listingId: "listing-2" }
        ],
        [{ fileName: "IMG_3372.jpeg", previewUrl: "https://example.test/ipf/1" }]
    );

    assert.deepEqual(assignments, []);
});

test("keeps every image on the only upload-bearing order item", () => {
    const assignments = distributeCustomFilesByItem(
        [{ transactionId: "tx-1", listingId: "listing-1" }],
        [
            { fileName: "front.jpeg", previewUrl: "https://example.test/ipf/front" },
            { fileName: "back.jpeg", previewUrl: "https://example.test/ipf/back" }
        ]
    );

    assert.deepEqual(assignments.map(({ transactionId, files }) => ({
        transactionId,
        fileNames: files.map((file) => file.fileName)
    })), [{ transactionId: "tx-1", fileNames: ["front.jpeg", "back.jpeg"] }]);
});

test("imports an order detail only once then maps exact one-to-one upload files to every item", async () => {
    const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

    assert.match(source, /import \{ distributeCustomFilesByItem \} from "\.\/etsy-custom-file-mapping\.mjs"/);
    assert.match(source, /candidate\.items/);
    assert.match(source, /distributeCustomFilesByItem\(candidate\.items, files\)/);
    assert.match(source, /mergeDomCustomFilesIntoBackendOrders\(backendOrders, \{ \.\.\.candidate, \.\.\.assignment \}, assignment\.files\)/);
});

test("scrolls Etsy order detail containers before collecting lazy-loaded upload images", async () => {
    const source = await readFile(new URL("../content-etsy.js", import.meta.url), "utf8");
    const start = source.indexOf("async function scanOrderDetailDomForCustomFiles(");
    const end = source.indexOf("function extractEtsyCustomTextFields", start);
    const scanner = source.slice(start, end);

    assert.ok(start >= 0 && end > start, "order detail scanner should exist");
    assert.match(scanner, /scrollOrderDetailForCustomFiles\(\)/);
});
