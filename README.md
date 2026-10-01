# LNG Etsy Worker

Chrome MV3 worker for Etsy. Orders and Ads use the authenticated `lng-web-be` command API; tracking remains on its legacy Socket.IO path.

## Setup

Run `npm test` to validate the extension source. Node.js is not required to run the extension in Chrome.

Load this project folder in `chrome://extensions` with Developer Mode enabled.

## Configure

In the popup, configure:

- **LNG Web BE API URL** — for example `https://api.lngmerch.co` or the local backend origin.
- **Extension Token** — an `lng_ext_…` token issued for exactly one shop, with `ORDERS:WRITE` and `FINANCE:WRITE` scope.

The worker stores the token only in Chrome local extension storage. On save, startup, and once a minute it heartbeats and claims at most one command. Supported commands are `IMPORT_NEW_ORDERS` and one-day `IMPORT_ADS_SPEND`; it uploads a CSV with `Authorization: Bearer <token>` and `Idempotency-Key: <command id>`, then completes the lease. The backend derives the shop solely from the token, never from extension input.

Do not use the legacy Orders/Ads Socket setup when an Extension Token is configured. Socket.IO remains only for Etsy tracking. Listings, messages, and other legacy automation are outside the command-agent scope.
