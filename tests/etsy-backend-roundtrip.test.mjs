import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { toEtsySoldOrderItemsCsv } from '../lng-web-be-import-csv.mjs';
const require = createRequire(import.meta.url);
const backend = '../../lng-web-be/src/modules/integration/externalOrderImport/sources/manualExcel/';

test('collector CSV round-trips through paired BE parser and mapper', { skip: !existsSync(new URL(`${backend}manualExcel.parser.js`, import.meta.url)) }, () => {
  const { parseUploadedOrderReport } = require(`${backend}manualExcel.parser.js`);
  const { mapEtsySoldOrderItemRowsToExternalOrderDtos } = require(`${backend}etsySoldOrderItems.mapper.js`);
  const csv = toEtsySoldOrderItemsCsv([{ orderId: 'order', shipping: { name: 'A, "B"', address1: 'Street', country: 'United States' }, totals: { shipping: 4, salesTax: 2 }, items: [
    { transactionId: 'tx', listingId: 'listing', quantity: 2, unitPrice: 10.25, itemTotal: 20.5, variations: { Size: 'L' }, customizations: { textFields: [{ name: 'Name', value: 'A\nB' }] }, customFiles: [{ downloadUrl: 'https://example.invalid/file.png' }] },
    { transactionId: 'tx2', listingId: 'listing2', quantity: 1, unitPrice: 0 },
  ] }]);
  const rows = parseUploadedOrderReport(Buffer.from(csv), { originalFilename: 'etsy.csv' }).rows;
  const [order] = mapEtsySoldOrderItemRowsToExternalOrderDtos(rows, { shopId: 'shop', marketplaceCode: 'ETSY_US' });
  assert.equal(order.shippingAddress.name, 'A, "B"');
  assert.equal(order.shippingAddress.countryCode, 'US');
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.items[0].price.itemPriceAmount, 1025);
  assert.equal(order.items[0].externalListingId, 'listing');
  assert.equal(order.items[0].customizationRawSummary.personalization, 'Name: A\nB');
  assert.equal(order.items[0].customizationRawSummary.expectedFileCount, 1);
  assert.equal(order.items[1].price.shippingPriceAmount, 0);
  assert.equal(order.items[1].price.itemTaxAmount, 0);
});

test('listing thumbnail survives CSV without becoming customer artwork', { skip: !existsSync(new URL(`${backend}manualExcel.parser.js`, import.meta.url)) }, () => {
  const { parseUploadedOrderReport } = require(`${backend}manualExcel.parser.js`);
  const { mapEtsySoldOrderItemRowsToExternalOrderDtos } = require(`${backend}etsySoldOrderItems.mapper.js`);
  const csv = toEtsySoldOrderItemsCsv([{ orderId: '1', items: [{ transactionId: '2', baseImage: { imageUrl: 'https://i.etsystatic.com/123/r/il_75x75.jpg' } }] }]);
  const [order] = mapEtsySoldOrderItemRowsToExternalOrderDtos(parseUploadedOrderReport(Buffer.from(csv), { originalFilename: 'etsy.csv' }).rows);
  assert.equal(order.items[0].externalData.etsy.listingImageUrl, 'https://i.etsystatic.com/123/r/il_75x75.jpg');
  assert.equal(order.items[0].externalData.etsy.listingImageThumbnailUrl, 'https://i.etsystatic.com/123/r/il_75x75.jpg');
  assert.equal(order.items[0].customizationRawSummary.expectedFileCount, 0);
});
