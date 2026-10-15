import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { toEtsySoldOrderItemsCsv } from '../lng-web-be-import-csv.mjs';

function collector() {
  const ctx = vm.createContext({ URL, console: { log() {}, warn() {} }, window: { __LNG_ETSY_WORKER_INJECTED__: true } });
  vm.runInContext(readFileSync(new URL('../content-etsy.js', import.meta.url), 'utf8'), ctx);
  return ctx;
}

test('collector preserves explicit fulfillment/payment fields and does not invent New or unpaid', () => {
  const ctx = collector();
  const collect = order => {
    const [mapped] = ctx.mapOrders({ raw: { order_ids: ['1'], orders_by_id: { '1': { order_id: '1', ...order } } }, orderStates: [{ order_state_id: 2, name: 'Completed' }] });
    return ctx.toBackendOrder(mapped, {});
  };
  const explicit = collect({ order_state_id: 2, fulfillment: { ship_by_date: 1792454400, shipping_method: 'Express' }, payment: { is_fully_paid: true } });
  assert.equal(explicit.status, 'Completed');
  assert.equal(explicit.isFullyPaid, true);
  assert.equal(explicit.shipByDate, '2026-10-20T00:00:00.000Z');
  assert.equal(explicit.shippingService, 'Express');
  const unknown = collect({});
  assert.equal(unknown.status, '');
  assert.equal(unknown.isFullyPaid, null);
  assert.equal(unknown.shipByDate, null);
  assert.equal(unknown.totals.orderTotal, null);
  assert.equal(unknown.totals.discountAmount, null);
  assert.equal(unknown.totals.shippingDiscount, null);
});

test('ship-by normalization ignores zero/invalid values and accepts explicit ISO dates', () => {
  const ctx = collector();
  assert.equal(ctx.normalizeEtsyShipByDate(0), null);
  assert.equal(ctx.normalizeEtsyShipByDate('not a date'), null);
  assert.equal(ctx.normalizeEtsyShipByDate('2026-10-20'), '2026-10-20T00:00:00.000Z');
});

test('explicit cancellation overrides Completed and full refund overrides paid', () => {
  const ctx = collector();
  for (const [flags, expected] of [
    [{ is_fully_cancelled: true }, 'CANCELLED'],
    [{ is_partially_cancelled: true }, 'PARTIALLY_CANCELLED'],
    [{ has_pending_cancellation: true }, 'CANCELLATION_PENDING'],
  ]) {
    const [mapped] = ctx.mapOrders({ raw: { order_ids: ['1'], orders_by_id: { '1': {
      order_id: '1', order_state_id: 2,
      fulfillment: { status: { cancellation_status: flags } },
      payment: { is_fully_paid: true, is_fully_refunded: true },
    } } }, orderStates: [{ order_state_id: 2, name: 'Completed' }] });
    const order = ctx.toBackendOrder(mapped, {});
    assert.equal(order.status, expected);
    assert.equal(order.paymentStatus, 'REFUNDED');
    assert.match(toEtsySoldOrderItemsCsv([{ ...order, items: [{ transactionId: '2' }] }]), /REFUNDED/);
  }
});

test('CSV does not repeat variations as a second personalization block', () => {
  const csv = toEtsySoldOrderItemsCsv([{ orderId: '1', items: [{ transactionId: '2', variations: { Size: 'L', Personalization: 'Alice' }, customizations: { textFields: [{ name: 'Size', value: 'L' }, { name: 'Personalization', value: 'Alice' }] } }] }]);
  assert.equal((csv.match(/Alice/g) || []).length, 1);
});

test('partial refund does not become full refund or full cancellation', () => {
  const ctx = collector();
  const [mapped] = ctx.mapOrders({ raw: { order_ids: ['1'], orders_by_id: { '1': {
    order_id: '1', payment: { is_fully_paid: true, is_partially_refunded: true },
  } } }, orderStates: [] });
  const order = ctx.toBackendOrder(mapped, {});
  assert.equal(order.status, 'PARTIALLY_REFUNDED');
  assert.equal(order.paymentStatus, 'PAID');
});
