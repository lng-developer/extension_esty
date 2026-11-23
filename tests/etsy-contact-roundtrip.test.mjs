import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { toEtsySoldOrderItemsCsv } from '../lng-web-be-import-csv.mjs';

const require = createRequire(import.meta.url);
const base = '../../lng-web-be/src/modules/integration/externalOrderImport/sources/manualExcel/';
const { parseUploadedOrderReport } = require(`${base}manualExcel.parser.js`);
const { mapEtsySoldOrderItemRowsToExternalOrderDtos } = require(`${base}etsySoldOrderItems.mapper.js`);
const { normalizeEtsyCustomization } = require('../../lng-web-be/src/modules/customization/parsers/etsyCustomization.parser.js');

// Synthetic contacts; structure matches the captured mission-control response.
function collect(phone = '(202) 555-0123', email = 'buyer@example.invalid', variations = []) {
  const ctx = vm.createContext({ URL, window: { __LNG_ETSY_WORKER_INJECTED__: true }, console: { log() {}, warn() {} } });
  vm.runInContext(readFileSync(new URL('../content-etsy.js', import.meta.url), 'utf8'), ctx);
  const response = { order_ids: ['123'], buyers: [{ buyer_id: 7, name: 'Test Buyer', email }], orders: [{
    order_id: 123, buyer_id: 7, order_state_id: 1,
    fulfillment: { to_address: { name: 'Test Recipient', first_line: '123 Test St', country: 'United States', phone }, verified_address: { suggested_address: { phone: '' } } },
    transactions: [{ transaction_id: 456, quantity: 1, variations, cost: { value: 5050, currency_code: 'USD' }, product: { title: 'Shirt', product_identifier: 'TEST-SKU' } }],
  }] };
  const [mapped] = ctx.mapOrders({ raw: ctx.mergeRawOrderData([response]), orderStates: [{ order_state_id: 1, name: 'New' }] });
  return ctx.toBackendOrder(mapped, {});
}

test('Etsy recipient phone and buyer email survive collector, CSV and backend mapping', () => {
  const order = collect();
  assert.equal(order.shipping.phone, '(202) 555-0123');
  assert.equal(order.buyer.email, 'buyer@example.invalid');
  const rows = parseUploadedOrderReport(Buffer.from(toEtsySoldOrderItemsCsv([order])), { originalFilename: 'etsy.csv' }).rows;
  const [dto] = mapEtsySoldOrderItemRowsToExternalOrderDtos(rows);
  assert.equal(dto.shippingAddress.phoneMasked, '(202) 555-0123');
  assert.equal(dto.buyer.emailMasked, 'buyer@example.invalid');
  assert.equal(dto.buyer.externalBuyerId, '7');
  assert.equal(dto.shippingAddress.countryCode, 'US');
  assert.equal(dto.items[0].price.itemPriceAmount, 5050);
});

test('missing contacts stay absent instead of using fabricated values', () => {
  const rows = parseUploadedOrderReport(Buffer.from(toEtsySoldOrderItemsCsv([collect('', '')])), { originalFilename: 'etsy.csv' }).rows;
  const [dto] = mapEtsySoldOrderItemRowsToExternalOrderDtos(rows);
  assert.equal(dto.shippingAddress.phoneMasked, undefined);
  assert.equal(dto.buyer.emailMasked, undefined);
});

test('Etsy typed personalization reaches the customization gate while size and color remain variants', () => {
  const variants = [
    { type: 'Etsy_Order_Transaction_Variation_Standard', property: 'Select Size', value: 'Sweatshirt - XL' },
    { type: 'Etsy_Order_Transaction_Variation_Standard', property: 'Select Color', value: 'Black' },
  ];
  const custom = [
    ['Main text (Mascot or School Name)', 'TEST SCHOOL'], ['Main Text Color', 'Gold'],
    ['Secondary Text (Your Name or Text)', 'TEST TEAM'], ['Secondary Text Color', 'White'],
  ].map(([property, value]) => ({ type: 'Etsy_Order_Transaction_Variation_Personalization', property, value }));
  for (const personalized of [true, false]) {
    const order = collect('', '', personalized ? [...variants, ...custom] : variants);
    const rows = parseUploadedOrderReport(Buffer.from(toEtsySoldOrderItemsCsv([order])), { originalFilename: 'etsy.csv' }).rows;
    const [dto] = mapEtsySoldOrderItemRowsToExternalOrderDtos(rows);
    assert.equal(dto.items[0].customizationRawSummary.hasCustomization, personalized);
    if (personalized) {
      for (const { property, value } of custom) assert.ok(rows[0].Personalization.includes(`${property}: ${value}`));
      assert.doesNotMatch(rows[0].Personalization, /Select Size|Select Color/);
      assert.equal(Object.keys(order.items[0].variations).length, 6);
      const inputs = normalizeEtsyCustomization(dto.items[0].customizationRawSummary).parsedData.amazonCustomization.customerInputs;
      assert.equal(inputs.texts.length, 4);
      assert.equal(inputs.options.length, 2);
    }
  }
});
