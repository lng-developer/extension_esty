# Etsy one-order re-import UI

## Intent

Make re-importing one Etsy order visible and usable from the active Operations
Hub Orders tab without first creating a batch preview.

## Scope

- Add a compact `Re-import 1 order` card at the top of the Orders tab.
- Validate a numeric Etsy Order ID, capture only that order with customer-file
  scanning, then start the existing background import flow.
- Leave batch import, tracking, ads, and settlements unchanged.

## Chosen approach

The manifest loads `options.html`, not the legacy popup. The card therefore
lives in Operations Hub and sends a dedicated manual action to the existing
service worker, which reuses the current capture and import mechanisms.

## Interaction

The card contains an Etsy order ID field, a short note that it scans customer
files, and a clearly labelled re-import button. Invalid IDs are rejected in the
UI and service worker; a running import disables only its own button.

## Non-goals

No changes to the backend API or existing batch-import flow.
