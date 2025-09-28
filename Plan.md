# Questrade UI Parity Plan

- [x] Update numeric typography to use standard weight across summary metrics and positions table pills.
- [x] Summary metrics parity improvements:
  - [x] Expand the metrics panel width by roughly 30% and harmonize spacing/dividers.
  - [x] Drive Combined-in-CAD/USD P&L from aggregated balance data (per-currency conversions).
  - [x] Populate Net deposits via the dedicated API endpoint and expose the correct value.
  - [x] Integrate net deposits/buying power into the main metrics grid to fix dotted separator alignment.
  - [x] Normalize formatting so zero values never render with a leading minus sign.
  - [x] Keep the headline total equity locked to the Combined CAD figure regardless of selection.
- [x] Remove the duplicate refresh control from the positions card header.
- [x] Right-align the P&L badges in the positions table to match Questrade styling.
