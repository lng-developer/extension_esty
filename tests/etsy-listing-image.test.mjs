import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../content-etsy.js', import.meta.url), 'utf8');
const thumb = 'https://i.etsystatic.com/123/r/il/abc/8589617620/il_75x75.8589617620_x.jpg';
const large = 'https://i.etsystatic.com/123/r/il/abc/8589617620/il_680x540.8589617620_x.jpg';
function context(fetchJson) {
  const ctx = vm.createContext({ URL, AbortSignal, console, window: { __LNG_ETSY_WORKER_INJECTED__: true } });
  vm.runInContext(source, ctx);
  ctx.fetchJson = fetchJson;
  return ctx;
}

test('exhausted total enrichment budget retains thumbnails without more requests', async () => {
  let requests = 0;
  let now = 0;
  const ctx = context(async () => { requests++; now = 16000; throw new Error('timeout'); });
  ctx.Date = { now: () => now };
  const items = [{ listingId: '123', productImage: thumb }, { listingId: '789', productImage: thumb }];
  await ctx.enrichOrdersWithListingImages({ orders: [{ orderItems: items }], shopId: '456' });
  assert.equal(requests, 1);
  assert.equal(items[1].productImage, thumb);
});

test('upgrades same image only and looks up each listing once per capture', async () => {
  let requests = 0;
  const ctx = context(async () => { requests++; return { images: [{ url_570xN: large }] }; });
  const items = [{ listingId: '123', productImage: thumb }, { listingId: '123', productImage: thumb }];
  await ctx.enrichOrdersWithListingImages({ orders: [{ orderItems: items }], shopId: '456' });
  assert.equal(requests, 1);
  assert.equal(items[0].productImage, large);
  assert.equal(items[0].productThumbnail, thumb);
  assert.equal(items[1].productImage, large);
});

test('does not replace historical thumbnail with a different featured image', async () => {
  const ctx = context(async () => ({ images: [{ url_570xN: large.replaceAll('8589617620', '999999') }] }));
  const item = { listingId: '123', productImage: thumb };
  await ctx.enrichOrdersWithListingImages({ orders: [{ orderItems: [item] }], shopId: '456' });
  assert.equal(item.productImage, thumb);
});

test('listing failure preserves order thumbnail and does not repeat failed lookup', async () => {
  let requests = 0;
  const ctx = context(async () => { requests++; throw new Error('unavailable'); });
  const items = [{ listingId: '123', productImage: thumb }, { listingId: '123', productImage: thumb }];
  await ctx.enrichOrdersWithListingImages({ orders: [{ orderItems: items }], shopId: '456' });
  assert.equal(requests, 1);
  assert.equal(items[0].productImage, thumb);
});
