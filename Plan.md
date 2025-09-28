# Questrade UI Parity Plan

Legend: `[ ]` todo · `[x]` done · `[~]` in progress · `[!]` punted (with reason)

## Account Selector
- [x] Replace the unintended glyph between "Self-directed RSP" and the account number with a proper ASCII dash.

## Summary Metrics Card
- [x] Remove the placeholder chart block entirely.
- [x] Adjust layout so the metrics table width matches Questrade (roughly half-width with appropriate spacing).
- [x] Add dotted separators between metric rows.
- [x] Add a final row showing Net deposits (left) and Buying power (right); placeholder values acceptable if unavailable.
- [x] Prevent negative signs from appearing for true zero values in any monetary display.
- [x] Correct "Combined in CAD" P&L values so the correct numbers display.
- [x] Ensure refresh chip hover only darkens the border (no green text) and uses the provided refresh icon SVG.

## Positions Table
- [x] Prevent horizontal overflow; ensure table content fits without clipping.
- [x] Enable sorting by clicking on column headers with appropriate up/down indicators using the provided arrow SVG (rotated as needed).
- [x] Truncate symbol descriptions to 21 characters with an ellipsis.
- [x] Apply a darker gray hover state to entire rows (darker than zebra striping).
- [x] Increase padding inside the P&L pills slightly.
- [x] Support toggling between currency and percentage display for all P&L pills when any pill is clicked.

## Miscellaneous
- [x] Update this plan as tasks are completed or punted, including reasons for any punts.
