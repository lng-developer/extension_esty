# Etsy Command-only Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Etsy Socket.IO tracking tasks with authenticated command-queue batch tracking.

**Architecture:** `lng-web-be-agent.mjs` will recognize and execute `UPLOAD_TRACKING`. `service-worker.js` will provide a serial batch executor backed by the existing Etsy upload helper. Socket task transport and its event/ack machinery will be removed.

**Tech Stack:** Chrome MV3 service worker, JavaScript ES modules, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-21-etsy-command-only-tracking-design.md`

## Global Constraints

- No new dependencies.
- Orders and Ads command behavior remains unchanged.
- Tracking batch rows execute serially.
- Socket.IO is not used as a task transport.

## Review Focus

- Empty or malformed `items` must be rejected before command start.
- A failed row must not block later rows in the same batch.
- Lease completion must report accurate imported and failed counts.
- Existing Orders and Ads command dispatch must remain intact.
- No `server:task`, pending-task pull, or task ack transport remains reachable.

---

### Task 1: Command dispatcher and batch result contract

**Files:**
- Modify: `lng-web-be-agent.mjs`
- Modify: `tests/lng-web-be-agent.test.mjs`

**Interfaces:**
- Consumes: a claimed `UPLOAD_TRACKING` command with `items`.
- Produces: `executeTracking({ commandId, items })` and command completion counts.

- [ ] **Step 1: Write failing dispatcher tests**

Add tests proving a valid tracking command starts, calls `executeTracking`, and completes with the executor's counts; add a malformed-items test that does not start.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/lng-web-be-agent.test.mjs`
Expected: FAIL because `UPLOAD_TRACKING` is unsupported.

- [ ] **Step 3: Extend `executeNextLngWebBeCommand`**

Dispatch `UPLOAD_TRACKING` to `executeTracking`, pass `items`, and validate a non-empty array before `client.start`.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test tests/lng-web-be-agent.test.mjs`
Expected: PASS.

### Task 2: Service-worker batch executor and Socket.IO removal

**Files:**
- Modify: `service-worker.js`
- Modify: `tests/lng-web-be-agent-runtime.test.mjs`

**Interfaces:**
- Consumes: `executeTracking({ commandId, items })` callback.
- Produces: serial Etsy uploads and `{ importedCount, failedCount, results }`.

- [ ] **Step 1: Write failing source-contract tests**

Replace the Socket task assertion with checks for `executeTracking` and command-only tracking; assert Socket.IO task transport identifiers are absent.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/lng-web-be-agent-runtime.test.mjs`
Expected: FAIL because the worker still imports and registers Socket.IO task handling.

- [ ] **Step 3: Implement the minimal command-only worker flow**

Add a serial batch helper that validates each row through `handleUploadTrackingToEtsy`, captures success/failure, and returns counts. Wire it into the command agent. Remove Socket.IO imports, state, connection setup, task handling, and manual-mode socket guards.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test tests/lng-web-be-agent-runtime.test.mjs`
Expected: PASS.

### Task 3: Full verification

**Files:**
- Verify: `tests/**/*.test.mjs`

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS with zero failures.

- [ ] **Step 2: Commit the implementation**

Run: `git add lng-web-be-agent.mjs service-worker.js tests docs/superpowers && git commit -m "feat: run Etsy tracking through commands"`
