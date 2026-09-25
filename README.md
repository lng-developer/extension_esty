# LNG Portal Agent Extension

Chrome MV3 extension agent that connects to the LNG Portal backend over Socket.IO and executes task stubs.

## Setup

Run `npm test` to validate the extension source. Node.js is not required to run the extension in Chrome.

Load this project folder in `chrome://extensions` with Developer Mode enabled.

## Configure

Open the extension popup, enter `shopId`, optional device label, and choose Production or Local dev. Saving triggers a background reconnect with the required Socket.IO auth handshake.

The extension automates Etsy order import, listing sync, tracking upload, ads import, and message diagnostics.
