# Command activity logs — 1.1.1

The Operations Hub Logs tab records command receipt, start, Etsy collection, import creation/progress, customization file transfer, completion acknowledgement, retry and lease loss. Orders, Ads, Settlements and Tracking share the command-client log path; unsupported commands are reported instead of silently missing from the log. This does not add new command executors.

Logs retain the latest 200 local events. Unchanged import progress is suppressed, and lease-renewal notices are limited to one per five minutes per client instance. Renewals do not count as processing progress. A running entry without a progress event for seven minutes is shown as UNKNOWN; this is diagnostic, not a backend cancellation or guaranteed stall.

Request failures include operation, HTTP status and safe error code. Request bodies, tokens, customer records and raw vendor responses are not logged. Logging failures must not stop task execution. Log storage remains best effort and local to the browser profile; old missing events cannot be reconstructed.

## Updating

Extract LNG-Etsy-Worker-1.1.1.zip to a permanent folder. In chrome://extensions, use Developer mode and Load unpacked, or reload the existing extension if its source folder contains this update. Preserve the existing extension/profile configuration; replacing its installation may require configuration again. Confirm the version badge reads 1.1.1. Do not reload while another task is actively processing.

Validation: npm test (120 tests), syntax checks and archive manifest/module checks. No browser session or live Etsy task was run as part of this change. No backend task, schedule, import or tracking submission was changed.
