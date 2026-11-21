# Etsy Tracking Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Etsy tracking batches auditable and terminal only after Etsy visibly contains every submitted tracking number.

**Architecture:** The extension verifies each accepted upload from the Etsy order view and sends per-item terminal results. Backend persists those results and derives the batch status; frontend renders the returned item state.

**Tech Stack:** Manifest V3 JavaScript, Node.js, MongoDB/Mongoose, React/TypeScript.

**Spec:** `docs/superpowers/specs/2026-11-21-etsy-tracking-verification-design.md`

## Global Constraints

- Keep the existing authenticated command API and one-minute alarm retry.
- Never re-upload an item after Etsy accepted it.
- Preserve Amazon command behavior.
- All new behavior starts with a failing focused test.

## Review Focus

- Etsy page temporarily does not show a newly accepted tracking number.
- A retry callback arrives after the command became terminal.
- One item in a batch verifies while another fails.
- An existing Etsy tracking must not cause a duplicate upload retry.
- Older commands without per-item results remain listable.

### Task 1: Verify a submitted Etsy tracking item in the extension

**Files:** `content-etsy.js`, `service-worker.js`, `tests/etsy-tracking-command.test.mjs`

- [ ] Write a failing test for an accepted upload followed by a matching Etsy-order verification result.
- [ ] Implement a content action that reads the matching sold order and returns `VERIFIED` only for the submitted tracking value.
- [ ] Make the tracking batch retain per-item accepted/verified/failed results without re-uploading accepted items.
- [ ] Run the focused extension tests.

### Task 2: Persist and expose item verification results in the backend

**Files:** `extensionCommand.model.js`, validator, DTO, service, tests

- [ ] Write failing service/validator tests for `trackingResults` and derived terminal status.
- [ ] Persist bounded per-item verification results and derive `SUCCEEDED`, `PARTIAL_FAILED`, or `FAILED` at completion.
- [ ] Keep completion idempotent for the same Etsy lease.
- [ ] Run focused backend tests.

### Task 3: Show item verification in Tracking Center

**Files:** tracking preview/history UI and tests in `lng-web-fe`

- [ ] Write a failing UI test for verified/failed item results.
- [ ] Render the returned per-item status and use `Verify again` for accepted but unverified items.
- [ ] Run focused frontend tests and build checks.
