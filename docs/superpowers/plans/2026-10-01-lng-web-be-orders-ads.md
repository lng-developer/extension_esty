# Etsy Extension to LNG Web BE Orders and Ads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Etsy Chrome extension an authenticated `lng-web-be` agent that imports Orders and Ads through the existing HTTP command/lease and file-import APIs.

**Architecture:** The provider owns a JSON contract and authenticates an Extension Token to its single shop scope. The extension replaces only Orders/Ads Socket execution with a small authenticated HTTP agent: it heartbeats, claims a lease, uploads a provider-format CSV with the command id as its idempotency key, and completes the lease. Etsy tracking remains on its legacy path.

**Tech Stack:** Chrome MV3, JavaScript ES modules, `chrome.storage.local`, Fetch API, Node `node:test`, Express, Joi, Mongoose, Jest.

**Spec:** `docs/superpowers/specs/2026-10-01-lng-web-be-orders-ads-design.md`

## Global Constraints

- Scope is Etsy Orders and Etsy Ads only; tracking, messages and listing sync are out of scope.
- Persist the Extension Token only in `chrome.storage.local`; never log it, include it in CSV, or fall back to anonymous requests.
- Use `Authorization: Bearer <token>` on every command and import request.
- Use `Idempotency-Key: <commandId>` on import uploads.
- Derive the target shop only from the Extension Token on the provider.
- Keep Socket.IO enabled only for tracking; Orders/Ads must not execute in both transports.
- Do not add dependencies.

## Review Focus

- Missing, expired, revoked, wrong-environment or malformed tokens must stop HTTP agent polling and display an actionable configuration error.
- A command with the wrong type, missing lease token, invalid date, or unknown response shape must not start an Etsy action.
- Retried or restarted commands must reuse the command idempotency key and produce no duplicate import batch/job.
- CSV escaping must preserve commas, quotes, Unicode and line breaks without changing row counts.
- A submitted `shopId` must not override the shop bound to an Extension Token.

---

### Task 1: Provider-owned contract and token-scoped Etsy order import

**Files:**
- Create: `C:/Users/stack/Task/lng-web-be/docs/contracts/etsy-extension-agent-v1.json`
- Modify: `C:/Users/stack/Task/lng-web-be/src/modules/integration/externalOrderImport/controllers/externalOrderImport.controller.js:83-96`
- Test: `C:/Users/stack/Task/lng-web-be/tests/integration/externalOrderImport/etsyExtensionScope.contract.test.js`

**Interfaces:**
- Consumes: existing Extension Token authentication and `POST /api/integration/external-order-imports/etsy-sold-order-items`.
- Produces: JSON contract describing heartbeat, claim/start/complete, Etsy order CSV upload and Ads CSV upload; order import always receives the token-scoped shop id.

- [ ] **Step 1: Write the provider contract test**

```js
it('uses the Extension Token shop, not a submitted shopId, for Etsy sold-order items', async () => {
  await request(app).post('/api/integration/external-order-imports/etsy-sold-order-items')
    .set('Authorization', `Bearer ${extensionToken}`)
    .field('shopId', otherShopId)
    .attach('file', csv, 'etsy-orders.csv')
    .expect(202);
  expect(importService.importFromEtsySoldOrderItems).toHaveBeenCalledWith(
    expect.objectContaining({ shopId: tokenShopId }),
    expect.anything(),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/integration/externalOrderImport/etsyExtensionScope.contract.test.js --runInBand`

Expected: FAIL because the Etsy controller trusts the submitted `shopId`.

- [ ] **Step 3: Add the canonical JSON contract and apply token scope in `importEtsySoldOrderItems`**

Override `bodySource.shopId` with `extensionShopId(req.auth) || bodySource.shopId`, matching `importManualExcel`. The JSON contract must specify endpoints, headers, command enums `IMPORT_NEW_ORDERS`/`IMPORT_ADS_SPEND`, lease fields, CSV multipart field name, error classes, and response ids consumed by the extension.

- [ ] **Step 4: Run provider verification**

Run: `npx jest tests/integration/externalOrderImport/etsyExtensionScope.contract.test.js tests/auth/services/extensionToken.service.test.js src/modules/integration/extensionCommand/__tests__/extensionCommand.validator.test.js --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit provider contract work**

```bash
git add docs/contracts/etsy-extension-agent-v1.json src/modules/integration/externalOrderImport/controllers/externalOrderImport.controller.js tests/integration/externalOrderImport/etsyExtensionScope.contract.test.js
git commit -m "feat(integration): scope Etsy extension imports to token shop"
```

### Task 2: Extension HTTP command client

**Files:**
- Create: `lng-web-be-command-client.mjs`
- Create: `tests/lng-web-be-command-client.test.mjs`
- Modify: `popup.html`
- Modify: `popup.js`

**Interfaces:**
- Consumes: the contract in Task 1 and a persisted `{ apiBaseUrl, extensionToken, clientId, label }` configuration.
- Produces: `createLngWebBeCommandClient({ fetchImpl, getConfig, setStatus })` with `heartbeat()`, `claimNext()`, `start(commandId, leaseToken)`, `complete(commandId, payload)`, and `isConfigured()`.

- [ ] **Step 1: Write failing client tests**

```js
test('sends bearer token and never calls fetch without a valid lng_ext token', async () => {
  const fetchImpl = mock.fn();
  const client = createLngWebBeCommandClient({ fetchImpl, getConfig: async () => ({ extensionToken: 'lng_ext_valid' }) });
  await client.heartbeat();
  assert.equal(fetchImpl.mock.calls[0].arguments[1].headers.Authorization, 'Bearer lng_ext_valid');
});

test('uses the command endpoint paths and returns null for an empty claim', async () => {
  // heartbeat then claim returning { success: true, data: null }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lng-web-be-command-client.test.mjs`

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement the small HTTP client and token configuration UI**

Use `chrome.storage.local`; create a UUID-style opaque `clientId` only once; normalize API base URLs; classify `401`/`403` as disabled configuration state and other failures as retryable. Add an Extension Token field to popup settings without rendering its value in logs.

- [ ] **Step 4: Run client verification**

Run: `node --test tests/lng-web-be-command-client.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the client**

```bash
git add lng-web-be-command-client.mjs tests/lng-web-be-command-client.test.mjs popup.html popup.js
git commit -m "feat(extension): add authenticated lng-web-be command client"
```

### Task 3: Deterministic Etsy CSV serializers and authenticated imports

**Files:**
- Create: `lng-web-be-import-csv.mjs`
- Create: `tests/lng-web-be-import-csv.test.mjs`
- Modify: `service-worker.js`

**Interfaces:**
- Consumes: existing extracted Etsy order/Ads rows and `createLngWebBeCommandClient` from Task 2.
- Produces: `toEtsySoldOrderItemsCsv(orders)`, `toEtsyAdsCsv(rows)`, and service-worker upload adapters returning `{ importJobId, importedCount, failedCount }`.

- [ ] **Step 1: Write failing serializer tests**

```js
test('creates the documented Etsy sold-order-item header and escapes a buyer value with comma and quote', () => {
  const csv = toEtsySoldOrderItemsCsv([{ orderId: '123', buyerName: 'A, "B"', items: [{ transactionId: 't1' }] }]);
  assert.match(csv, /"A, ""B"""/);
});

test('creates an Ads CSV for one Etsy date without dropping zero spend rows', () => {
  const csv = toEtsyAdsCsv([{ date: '2026-10-01', spend: 0, listingId: 'l1' }]);
  assert.match(csv, /2026-10-01/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lng-web-be-import-csv.test.mjs`

Expected: FAIL because serializer exports do not exist.

- [ ] **Step 3: Implement CSV conversion and import adapters**

Map only fields accepted by the provider contract. Build a `FormData` upload with a CSV `Blob`, pass the bearer token and `Idempotency-Key`, and parse only documented response ids/counts. Do not reuse the legacy unauthenticated `pushOrdersToBackend` or Ads endpoint.

- [ ] **Step 4: Run serializer verification**

Run: `node --test tests/lng-web-be-import-csv.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit serializers and imports**

```bash
git add lng-web-be-import-csv.mjs tests/lng-web-be-import-csv.test.mjs service-worker.js
git commit -m "feat(extension): upload Etsy imports to lng-web-be"
```

### Task 4: Command executor and legacy transport isolation

**Files:**
- Modify: `service-worker.js`
- Modify: `popup.js`
- Test: `tests/lng-web-be-agent-runtime.test.mjs`
- Modify: `tests/etsy-only.test.mjs`

**Interfaces:**
- Consumes: Task 2 client and Task 3 import adapters.
- Produces: one bounded alarm-driven Orders/Ads agent loop that completes each lease exactly once and leaves tracking Socket handlers unchanged.

- [ ] **Step 1: Write failing runtime tests**

```js
test('claims IMPORT_NEW_ORDERS, starts it, uploads once with command idempotency, then completes it', async () => {
  // inject a fake command client and existing Etsy extraction adapter
});

test('does not route IMPORT_NEW_ORDERS or IMPORT_ADS_SPEND through a Socket task when API-agent mode is configured', async () => {
  // assert the Socket handler skips these types in API-agent mode
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/lng-web-be-agent-runtime.test.mjs`

Expected: FAIL because no HTTP agent loop exists.

- [ ] **Step 3: Implement the bounded agent loop**

Run heartbeat and one claim at startup, configuration change, and a named Chrome alarm. For recognized command types, start the lease before Etsy work and complete it with sanitized failure information. Skip unrecognized commands and never complete them. Preserve legacy Socket behavior exclusively for tracking types.

- [ ] **Step 4: Run extension verification**

Run: `npm test`

Expected: PASS, including Etsy-only and new command runtime tests.

- [ ] **Step 5: Commit runtime integration**

```bash
git add service-worker.js popup.js tests/lng-web-be-agent-runtime.test.mjs tests/etsy-only.test.mjs
git commit -m "feat(extension): execute lng-web-be import commands"
```

### Task 5: Cross-repository contract verification

**Files:**
- Modify: `C:/Users/stack/Task/lng-web-be/tests/integration/extensionCommand/etsyExtension.contract.test.js`
- Modify: `tests/lng-web-be-agent-runtime.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: provider contract from Task 1 and extension agent behavior from Tasks 2-4.
- Produces: repeatable evidence that the two repositories agree on token scope, paths, lease lifecycle and import idempotency.

- [ ] **Step 1: Write cross-repository failing contract cases**

```js
it('accepts the documented extension token request sequence and returns only documented command fields', async () => {
  // heartbeat -> claim -> start -> complete against the provider test app
});

it('rejects a token-scoped order upload whose submitted shopId differs from the token scope', async () => {
  // status remains accepted only for the token shop
});
```

- [ ] **Step 2: Run the tests to verify expected failures or coverage gaps**

Run: `npx jest tests/integration/extensionCommand/etsyExtension.contract.test.js --runInBand && npm test`

Expected: FAIL until the exact provider fixture/import response mapping is wired.

- [ ] **Step 3: Complete contract fixtures, README setup, and test adapters**

Document token issuance, local storage setup, command polling behavior, supported command types, and the explicit exclusion of tracking. Do not document or retain anonymous legacy Orders/Ads setup.

- [ ] **Step 4: Run final verification**

Run: `npx jest tests/integration/externalOrderImport/etsyExtensionScope.contract.test.js tests/integration/extensionCommand/etsyExtension.contract.test.js --runInBand && npm test && Get-Content -Raw service-worker.js | node --input-type=module --check && Get-Content -Raw socket-client.js | node --input-type=module --check`

Expected: all targeted backend tests, all extension tests and ESM parse checks PASS.

- [ ] **Step 5: Commit verification/docs work**

```bash
git add README.md tests/lng-web-be-agent-runtime.test.mjs
git commit -m "docs(extension): document lng-web-be agent setup"
```

## Self-review

- Spec coverage: Tasks 1-5 cover token scope, command lifecycle, CSV imports, duplicate protection, error handling, legacy transport isolation, tests and manual smoke prerequisites.
- Types and names: command enums, endpoint paths, lease token and `Idempotency-Key` are consistent with the approved spec.
- Review focus: each listed failure mode has a concrete test in Tasks 1-4.
- Scope: tracking and unrelated Etsy automation are excluded from implementation tasks.
