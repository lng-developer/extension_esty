# Etsy One-Order Re-import UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a one-order Etsy re-import visible at the top of Operations Hub.

**Architecture:** Add a compact card to the active Operations Hub Orders tab. A manual action validates an order ID, captures only that Etsy order with customer-file scanning, then starts the existing background import flow.

**Tech Stack:** Chrome MV3 popup HTML/CSS, vanilla JavaScript, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-21-etsy-order-reimport-ui-design.md`

## Global Constraints

- Do not change backend API fields or the existing background import flow.
- Keep batch import, tracking, ads, and settlements unchanged.
- Validate the order ID in both the UI and service worker before capture.

## Review Focus

- Empty or non-numeric order IDs must still be rejected by the existing validation; test in Task 1.
- Targeted re-import must send `targetOrderId`, one-order limits, and force customer-file scanning; test in Task 1.
- The card must appear in `options.html`, which is the manifest popup; test in Task 1.

---

### Task 1: Add targeted re-import to Operations Hub

**Files:**
- Modify: `options.html`, `options.js`, `service-worker.js`
- Test: `tests/options-reimport.test.mjs`

**Interfaces:**
- Consumes: `handleGetEtsyOrdersAndPush`, `createEtsyCapture`, and `resumeEtsyImport`.
- Produces: a visible re-import card that imports the requested order in the background.

- [ ] **Step 1: Write the failing test**

Create `Operations Hub exposes a one-order re-import action` to assert that the active Orders UI sends `ETSY_MANUAL_REIMPORT` and the service worker uses `targetOrderId`, one-order limits, and customer-file scanning.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/options-reimport.test.mjs`

Expected: FAIL because Operations Hub has no targeted re-import control or manual action.

- [ ] **Step 3: Add a compact Orders card and targeted manual action**

In `options.html` and `options.js`, add the card and action. In `service-worker.js`, validate the ID, capture one target order with forced customer-file scanning, and start `resumeEtsyImport` in the background.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/options-reimport.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`

Expected: PASS with no failures.

- [ ] **Step 6: Commit**

```bash
git add options.html options.js service-worker.js tests/options-reimport.test.mjs docs/superpowers/specs/2026-11-21-etsy-order-reimport-ui-design.md docs/superpowers/plans/2026-11-21-etsy-order-reimport-ui.md
git commit -m "feat: add Operations Hub order reimport"
```
