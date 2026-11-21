# Etsy Command-only Tracking Design

## Intent

Run Etsy tracking uploads through the authenticated LNG command protocol, matching the completed Amazon model. A command is leased, started, executed by the extension, and completed with a per-row result summary.

## Goals

- Accept `UPLOAD_TRACKING` commands from the LNG command queue.
- Process a command's tracking rows serially and retain a per-row success/failure result.
- Complete the command through its active lease.
- Remove Socket.IO as a task transport; no socket task, ack, or pending-task flow remains.

## Non-goals

- Do not change Etsy's upload request or the Operations Hub UI.
- Do not redesign the backend command API.
- Do not claim persistent idempotency beyond backend command identity.

## Interface

The claimed command uses `type: "UPLOAD_TRACKING"` and supplies `items`, an array of `{ orderId, trackingNumber, carrier? }`. The extension validates a non-empty list, uploads each row one at a time, and returns `{ importedCount, failedCount, results }`, where results identify the order and outcome. A malformed command is skipped before `start`; a row failure is collected so remaining rows still run.

## Approach

Extend the existing `executeNextLngWebBeCommand` dispatcher with a tracking executor. The service worker supplies that executor and uses the existing Etsy upload helper. Delete Socket.IO initialization and task dispatch rather than leaving a second path that can diverge.

## Constraints

- Use no new dependencies.
- Keep orders and ads command behavior unchanged.
- Preserve the extension's existing Etsy authentication and carrier resolution.
