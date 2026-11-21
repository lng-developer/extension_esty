# LNG Etsy Worker

Chrome MV3 worker for Etsy. Orders, Ads, and tracking use the authenticated `lng-web-be` command API.

## Setup

Run `npm test` to validate the extension source. Node.js is not required to run the extension in Chrome.

Load this project folder in `chrome://extensions` with Developer Mode enabled.

## Configure

In the popup, configure:

- **LNG Web BE API URL** — `https://dev-api.lngmerch.co` for the current dev backend, or the local backend origin. `https://api.lngmerch.co` is the old production backend, not the current command API target.
- **Extension Token** — an `lng_ext_…` token issued for exactly one shop, with `ORDERS:WRITE` and `FINANCE:WRITE` scope.

The worker stores the token only in Chrome local extension storage. On save, startup, and once a minute it heartbeats and claims at most one command. Supported commands are `IMPORT_NEW_ORDERS`, one-day `IMPORT_ADS_SPEND`, and `UPLOAD_TRACKING` with serial `items` rows. It completes the active lease with imported/failed counts and row outcomes. The backend derives the shop solely from the token, never from extension input.

After updating, reload the extension in `chrome://extensions`, reopen the order screen, select **Dev · dev-api.lngmerch.co**, and authenticate with an extension token issued by that backend. Existing saved URLs, tokens, and unfinished checkpoints are not automatically migrated. Manual-mode tokens remain in session storage. Reconcile any unfinished run on its original backend before changing its target.

Socket.IO task transport has been removed. Listings, messages, and other legacy automation are outside the command-agent scope.
