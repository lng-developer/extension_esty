# Etsy Tracking Verification Design

## Intent

An Etsy tracking batch is successful only after Etsy displays the submitted tracking number for every selected order. This prevents a successful callback from masking a rejected or duplicate marketplace update.

## Contract

The command remains `RUNNING` while the extension processes items. Each item reports one of `PENDING`, `ETSY_ACCEPTED`, `VERIFIED`, or `FAILED`, with order ID, tracking number, resolved carrier, timestamps, and a bounded error message. The final command is `SUCCEEDED` only when every item is `VERIFIED`; otherwise it is `PARTIAL_FAILED` when at least one item verified, or `FAILED` when none did.

The extension callback is idempotent: retries send the same command ID, lease token, and item results. Backend completion accepts the same terminal Etsy lease again without reopening the command.

## Behavior

1. Portal creates one `UPLOAD_TRACKING` command from selected shipment rows.
2. Extension uploads each item and records `ETSY_ACCEPTED` only after Etsy accepts the POST response.
3. Extension fetches the matching Etsy sold-order view and marks the item `VERIFIED` only when that page contains the submitted tracking number.
4. A transient callback failure is time-bounded and retried by the existing one-minute alarm from its saved completion checkpoint.
5. Backend heartbeat expires any stale lease for that worker. A stale command is terminal `FAILED`, never indefinitely `RUNNING`.

## Non-goals

- Do not delete or replace existing Etsy tracking entries.
- Do not retry the Etsy upload after an accepted response; retry only verification/callback to avoid duplicate tracking.
- Do not introduce a second socket flow.
