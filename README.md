# LNG Portal Agent Extension

Chrome MV3 extension agent that connects to the LNG Portal backend over Socket.IO and executes task stubs.

## Setup

```bash
npm install
npm run build
```

Load the generated `dist` folder in `chrome://extensions` with Developer Mode enabled.

## Configure

Open the extension popup, enter `shopId`, optional device label, and choose Production or Local dev. Saving triggers a background reconnect with the required Socket.IO auth handshake.

Task handlers in `src/handlers` are intentionally stubbed and return mock results. Replace those files with Amazon Seller Central and Advertising automation logic when ready.
