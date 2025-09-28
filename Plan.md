# Questrade UI Parity Plan

## Progress Summary
- Completed: All parity work across header, equity card, positions table, and visual treatments.
- Remaining: None pending; monitor for future UX feedback.
- Punt: None.
- Tests: `npm run build`

# A) Page header / account context
- [x] Account selector renders as a single dropdown labelled `Main RRSP` (or `Main {type}` when applicable) with grey `Self-directed RRSP · 53384039` style sublabel; control reuses the same native select for all accounts.
- [x] Removed the Summary H1 and MAIN INDIVIDUAL chip so the header mirrors Questrade's minimal treatment.

# B) Equity header card (above the chart placeholder)
- [x] Title copy now resolves to `Total equity (Combined in ...)` using the active currency view.
- [x] Added a reusable refresh time pill with icon (`h:mm:ss am/pm ET`) pinned top-right and reused near the positions table.
- [x] Currency chips relocated under the chart placeholder with active/inactive styling.
- [x] Summary metrics reworked into two compact columns showing Today's P&L (+%), Open P&L, Total P&L | Total equity, Market value, Cash; buying power removed.

# C) Tabs above the table
- [x] Implemented a single Positions tab with green underline and removed the holdings badge.

# D) Positions table - columns & headers
- [x] Headers match Questrade order, label casing, and now include Currency plus % of portfolio columns.
- [x] Added a sort indicator tied to the default `% of portfolio` descending order.
- [x] Mirrored the time-only refresh pill along the table header row.

# E) Positions table - row content & formatting
- [x] Symbol cell trimmed to ticker plus company name only.
- [x] Numeric cells right-aligned with tabular numerals and monetary formatting switched to `$` values.
- [x] P&L cells render pill badges with +/– and neutral zero state; Currency column shows CAD/USD codes.
- [x] Precision rules applied (qty up to 4 decimals, avg price fixed 4, symbol price/market value at 2) with thousands separators.
- [x] Default ordering now derives from `% of portfolio` (fallback to market value when share unavailable).

# F) Visual tone & spacing
- [x] Reduced radii to 6px, softened shadows, and introduced alternating row backgrounds for denser table feel.
- [x] Normalized headers and microcopy to Title Case.

# G) Compliance with "ignore" list
- [x] Verified excluded UI elements (banner, search, add funds, secondary tabs, etc.) remain omitted.

---

## Acceptance criteria (quick checklist)

* [x] Account selector reads **Main RRSP** with sub-label **Self-directed RRSP · 53384039**.
* [x] Title reads **Total equity (Combined in CAD)**.
* [x] Time pill with refresh icon shows **time-only** (`h:mm:ss am/pm ET`), top-right; duplicate near table.
* [x] Currency chips under the chart placeholder: **Combined in CAD / Combined in USD / CAD / USD**.
* [x] Summary metrics rendered in two columns: Today's P&L (+%), Open P&L, Total P&L | Total equity, Market value, Cash.
* [x] Single **Positions** tab (active).
* [x] Table columns match Questrade order & labels; includes **Currency** and **% of portfolio**.
* [x] P&L cells use green/red/grey **pill badges** with +/–.
* [x] Amounts use `$` with thousands separators; **Currency** column shows `USD`/`CAD`.
* [x] **Open qty** & **Avg price** at **4 decimals**; **Symbol price/Market value** at **2 decimals**.
* [x] Default sort = **% of portfolio (desc)**.
* [x] No extra per-row metadata (e.g., `RRSP U0222 ...`); all numerics right-aligned.
* [x] Visual density matches Questrade (compact rows, minimal elevation).
* [x] All items in the ignore list are absent.
