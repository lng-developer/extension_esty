# Test Etsy manual import

## Web-requested Orders

With BE protocol v1, configured manual mode also accepts **WEB Orders** from Integrations → Extensions → Automation. It advertises ETSY/protocolVersion 1 and only claims after backend acknowledgement. Select maximum 1 for the first explicit test; Orders auto-import with files/manifest, no manual confirmation required. Amazon day windows, Etsy schedules, Ads and tracking are not enabled by this workflow.

An unfinished manual preview blocks remote claims. Remote work uses `etsyRemoteOrderRun`, separate from `etsyManualRun`; its lease stays in session storage, never local. Do not change shop/backend during an unfinished remote task. On worker restart, a live session lease resumes the same immutable CSV/key/job. Lost completion responses retry acknowledgement only. Closing Chrome/losing lease preserves evidence and blocks new claims until operator reconciliation; no recovery/reset UI is included yet.

Update BE first, then FE, then extension. The earlier heartbeat-only description below applies only to a backend that does not acknowledge protocol v1. The manual Pull → Confirm Import flow below is unchanged when no remote task is active.

Use a separate unpacked-extension Chrome profile. Do not replace the installed legacy worker or use production data for the first test.

1. Run the paired `lng-web-be` branch `codex/etsy-extension-provider` with a test database, Redis and the external-order-import/customization/post-import workers. Keep vendor submission and tracking disabled.
2. Copy the updated extension into the VM and reload it from branch `codex/etsy-lng-web-be`. Open the popup and choose **Mở màn hình kéo đơn**. The old popup and Ads/tracking code remain in the package but are not the default UI.
3. Open **Cài đặt kết nối**. From the shop VM choose `http://192.168.1.3:3000` (the code machine); use localhost only when BE runs on the same machine as Chrome. Paste a scoped `lng_ext_` token and click **Xác thực token & kết nối**. The extension calls `GET /api/auth/me` and displays the token's active LNG shop read-only; never enter Shop ID manually. BE must include the Extension Token identity response. An unfinished capture prevents switching backend/shop until it is completed or explicitly cleared. LAN HTTP is only for a trusted test network: bearer tokens and customer data are not transport-encrypted. The token remains in `chrome.storage.session`, not the saved run. Successful configuration enables manual mode and disables command claims, Socket task execution and legacy network logs. The Etsy shop logged into Chrome must still be checked by the operator. The displayed authentication result is from configuration time, not a continuously monitored connection.
4. Start with 1–3 orders. Pull only captures metadata/CSV locally. It does not upload orders or transfer customer artwork to BE. Viewing Etsy may still load its own page thumbnails. The limit is an order count, not a day window, and more orders can exist beyond it.
5. Review counts, then explicitly confirm Import. The worker saves one stable request key and immutable CSV, waits for actual order-import completion, uploads original IPF images, then attaches Media IDs by transaction. PNG/JPEG/WebP up to 10 MiB each; at most 20 files per item. Transfers are sequential (below the approved maximum of three) and transient failures retry at most three times.
6. Reopen the page and click **Xem tiến độ**, then **Import / tiếp tục** if interrupted. Worker restart reuses the saved job and uploaded asset IDs. A browser restart requires re-entering the session token for the original backend/shop. Reused asset IDs are checked again by BE during manifest attachment. No automatic resume/background scheduling is enabled.

## Acceptance checks

- Address, quantity, unit price, variations and multiline personalization match Etsy. Tax/shipping are carried once per order, not duplicated across rows.
- Exact Etsy Listing ID wins over SKU; absent identity produces DRAFT, not auto-approved readiness. Variant/PSD/vendor gates remain unchanged.
- Image-only item stays blocked until its expected files arrive. A missing or ambiguous multi-item DOM association remains NEEDS_REVIEW; do not guess by array position.
- Inspect images in the Order Workbench, including actual original resolution. Failed original download never falls back to a thumbnail.
- Repeat Import/resume: same job, same assets. Try interruption after CSV upload and after image upload, before manifest acknowledgment.
- Queue failure remains retryable; rejected token pauses the run. A COMPLETED import means orders and manifest were accepted and mapping queued, not that production gates passed.

## Operational limits

- Allowed backend origins are the four UI choices; another staging host needs an explicit matching UI/worker allowlist/host-permission/CSP change.
- Downloads are made in the extension worker with the Chrome session, not by sending Etsy cookies to BE. Live Etsy cookie/CORS/redirect behavior and worker lifetime still need browser verification.
- Preview/checkpoints contain customer data and file references in local extension storage. Use **Xóa dữ liệu preview cục bộ** after testing; it does not delete backend records. No token is included in checkpoints.
- Legacy command mode is unchanged except truthful import counts. Manual mode is persistent; to return to the legacy profile, use the original separate profile. Do not run both against the same shop unintentionally.
- Deployment must install the new Media dedupe unique index and existing import idempotency index before accepting concurrent uploads. BE production has `autoIndex: false`; defining a Mongoose index alone does not install it.

Not yet verified: live Etsy originals, browser stop/restart E2E, real Mongo concurrent writes/index deployment, staging or production deployment.
