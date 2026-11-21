# Etsy one-order re-import UI

## Intent

Make the common recovery action—re-importing one Etsy order—visible and usable
from the Orders screen without opening the generic Trigger tools.

## Scope

- Add a compact `Re-import 1 order` card at the top of the Orders tab.
- Keep the existing numeric validation and one-order import payload unchanged.
- Leave tracking, ads, listing sync, and other manual tools in Trigger.

## Chosen approach

Two options were considered: improve the Trigger modal, or promote the
one-order action to Orders. The latter was chosen because it removes an
unnecessary step for the operational task the user performs most often.

## Interaction

The card contains an Etsy order ID field, a short note that it scans customer
files, and a clearly labelled re-import button. Invalid IDs continue to report
through the existing activity log; a running import disables only its own
button.

## Non-goals

No changes to the extension's backend contract, order capture logic, or batch
import controls.
