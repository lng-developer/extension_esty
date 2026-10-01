# Etsy extension to LNG Web BE: Orders and Ads

## Scope

Move only Etsy order and Etsy Ads imports from the legacy Socket.IO/legacy API path to `lng-web-be`. Etsy tracking upload remains unchanged and out of scope.

## Goal

Make the Chrome extension an authenticated extension agent for one shop. The shop identity comes only from an Extension Token issued by `lng-web-be`; the extension must not choose or override it.

## Authoritative boundary

The provider-owned contract will be added under `lng-web-be/docs/contracts/etsy-extension-agent-v1.json`. Its source operations are the existing endpoints below; the JSON contract records the request and response fields the extension relies on.

| Job | Provider operation | Consumer action |
| --- | --- | --- |
| Register/online state | `POST /api/integration/extension-commands/agent/heartbeat` | Send stable client id, label, version and API base URL. |
| Acquire work | `POST /api/integration/extension-commands/agent/claim` | Poll at a bounded interval and receive one leased command or `null`. |
| Lifecycle | `POST /api/integration/extension-commands/agent/commands/:commandId/start` and `/complete` | Start/complete with the lease token. |
| Etsy orders | `POST /api/integration/external-order-imports/etsy-sold-order-items` | Convert extracted Etsy order items to the provider CSV format and upload multipart data. |
| Etsy Ads | `POST /api/finance/imports/ads` | Convert extracted Ads rows to the provider CSV format and upload multipart data. |

All extension HTTP calls carry `Authorization: Bearer lng_ext_*`. Import calls use `Idempotency-Key: <commandId>`.

## Extension changes

- Add one configuration field for Extension Token and persist it in `chrome.storage.local`, never `sync`.
- Generate and persist one opaque `clientId`; users can edit the display label only.
- Add a small HTTP command client responsible for authenticated requests, retry classification and heartbeat/claim scheduling.
- For a claimed `IMPORT_NEW_ORDERS` command, execute the existing Etsy extraction, create the documented CSV, upload it, then complete the lease with imported/failed counts and the returned import job id.
- For a claimed `IMPORT_ADS_SPEND` command, execute the existing Etsy Ads extraction for the command date, create the documented CSV, upload it, then complete the lease with imported/failed counts and the returned import batch id.
- In this API-agent mode, do not run legacy Socket.IO order or ads handlers. Tracking upload remains on its existing path.

## Provider changes

- Make `etsy-sold-order-items` derive `shopId` from an Extension Token exactly as the existing manual Excel controller does, so a token cannot import into another shop by submitting a different id.
- Add the canonical JSON contract and provider contract tests for authentication, token-derived shop scope, command claim/lease lifecycle and import response fields.

## Failure handling and safety

- A missing, revoked, expired or wrong-environment token disables polling and shows a configuration error; it must not fall back to anonymous requests.
- `401`/`403` stop polling until the configuration changes. Transient network/`5xx` errors use bounded retry and leave the leased command uncompleted so the provider lease policy governs recovery.
- Never include order payloads, buyer data, tokens or raw page HTML in extension logs.
- The provider lease and idempotency key are the durable duplicate guard; extension in-memory state is only an optimization.

## Verification

- Extension unit tests: token header, disabled state without token, command-to-CSV conversion, lease start/complete, and no legacy order/ads Socket execution in API-agent mode.
- Backend tests: Extension Token scope overrides submitted shop ids; each command path accepts only the documented payload and returns the documented response.
- Integration test: issue a scoped token, heartbeat, queue one Orders command and one Ads command, claim and complete each, then verify one provider import record per command.
- Manual smoke test: logged-in Etsy browser imports one known order window and one Ads day into a non-production shop.

## Out of scope

- Etsy tracking upload, message monitoring, listing synchronization and any migration of historical legacy imports.
- New Socket.IO protocol or simultaneous Socket and HTTP execution for Orders/Ads.
