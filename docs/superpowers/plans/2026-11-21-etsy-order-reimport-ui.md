# Etsy One-Order Re-import UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a one-order Etsy re-import visible at the top of the extension popup.

**Architecture:** Move the existing re-import controls out of the generic Trigger modal into a compact, visually distinct card before batch import controls. The existing event handler and payload remain unchanged, so the UI continues to use the tested targeted import path.

**Tech Stack:** Chrome MV3 popup HTML/CSS, vanilla JavaScript, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-21-etsy-order-reimport-ui-design.md`

## Global Constraints

- Do not change backend payload fields or the order-capture flow.
- Keep tracking, ads, and listing sync in Trigger.
- Reuse `reimportOrderId` and `btnReimportOrder` so validation and disabled-state logic stay intact.

## Review Focus

- Empty or non-numeric order IDs must still be rejected by the existing validation; test in Task 1.
- Targeted re-import must still send `targetOrderId`, one-order limits, and force customer-file scanning; test in Task 1.
- The popup must show the re-import control before generic batch import; test in Task 1.
- Trigger must no longer contain the duplicated re-import controls; test in Task 1.

---

### Task 1: Promote the targeted re-import card

**Files:**
- Modify: `popup.html`
- Test: `tests/order-custom-file-default.test.mjs`

**Interfaces:**
- Consumes: existing `#reimportOrderId` and `#btnReimportOrder` references in `popup.js`.
- Produces: a visible re-import card above the generic batch-order controls.

- [ ] **Step 1: Write the failing test**

Extend `offers a one-order reimport control that forces the customer-file scan` to assert that the re-import card class exists, its input and button appear before `btnGetOrders`, and neither control remains within `triggerModalOverlay`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/order-custom-file-default.test.mjs`

Expected: FAIL because the controls are still in Trigger and no re-import card exists.

- [ ] **Step 3: Move the existing controls into a compact Orders card**

In `popup.html`, add minimal CSS for `.reimport-card`; move the existing controls unchanged before the batch import button; add concise copy that customer files will be scanned.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/order-custom-file-default.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`

Expected: PASS with no failures.

- [ ] **Step 6: Commit**

```bash
git add popup.html tests/order-custom-file-default.test.mjs docs/superpowers/specs/2026-11-21-etsy-order-reimport-ui-design.md docs/superpowers/plans/2026-11-21-etsy-order-reimport-ui.md
git commit -m "feat: promote Etsy order reimport control"
```
