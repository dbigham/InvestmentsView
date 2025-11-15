# Questrade UI Plan

## Total P&L Range Breakdown from Chart Selection

### Goals
- Let users click an already-selected Total P&L chart range (the green rectangle in `client/src/components/SummaryMetrics.jsx`) to open the heatmap dialog scoped to that exact time window.
- Keep the current click-to-open behavior when no selection is present, and avoid spurious launches while the user is still dragging.
- Reuse activity contexts and cached data so a range-specific breakdown returns quickly even if the user tries multiple date spans in succession.

### UX / Interaction Updates
- Treat the translucent selection rectangle as a hit target. When `selectionSummary` is populated and the user clicks inside its bounds, call a new handler that opens the breakdown for that range instead of the full-series Total P&L.
- Keep the existing click handler for the chart background/path so a simple click without a selection still launches the Total P&L dialog / full-range breakdown.
- When a range click launches the dialog, include the formatted start/end dates and delta in the dialog header (e.g., “Total P&L breakdown — Jan 10 – Feb 3” and show the P&L delta for context). Provide a small inline pill/badge in the dialog to remind the user that the data is filtered to a subrange and offer a “Clear range” action that closes the dialog and clears the selection (or reopens with the full range).

### Client-Side Data Flow
1. **SummaryMetrics.jsx**
   - Augment the chart `<svg>` click handler to detect whether the pointer event is inside `selectionRange`. Use `getRelativePoint` to compare against `selectionRange.startX/endX` and the chart’s vertical bounds.
   - If inside, call `onShowPnlBreakdown` with mode `'total'` plus a new `range` option object: `{ startDate: ISO, endDate: ISO, startLabel, endLabel, deltaValue }`. Compute ISO keys via `formatDateOnly(selectionSummary.startPoint.date)` and `...endPoint.date`.
   - Continue to call the existing handler without a `range` option when there is no selection, and ensure drag completions still suppress accidental clicks via `suppressClickRef`.
2. **App.jsx state management**
   - Extend `handleShowPnlBreakdown` (currently around line 10336) to accept a `range` option. Store it in a new piece of state such as `pnlBreakdownRange` (object with `{ kind: 'total', startDate, endDate, label, deltaValue }` or `null`). Clear this state when the dialog closes or when the mode is not `'total'`.
   - Pass `pnlBreakdownRange` (or derived props) down to `<PnlHeatmapDialog>` along with the current account scope (single account id, `all`, or `group:<slug>`). Also pass callbacks so the dialog can request the range to be cleared.
   - Track a new resource state for range-specific totals, e.g., `{ status: 'idle' | 'loading' | 'ready' | 'error', key, data }`. The key should include the account scope + range dates to avoid re-fetching if the same span is reopened.
3. **Range breakdown API consumption**
   - When `pnlBreakdownRange` is set and mode is `'total'`, fire a data fetch instead of relying on `data?.accountTotalPnlBySymbol`. Call a new endpoint (see server plan) with query params `accountScope`, `startDate`, `endDate`, and `includeClosed=true`. Include the selected accounts list for aggregates so the server does not need to refetch metadata.
   - Keep using the cached `accountTotalPnlBySymbol` / `accountTotalPnlBySymbolAll` data path when there is no range override; the dialog should toggle between “precomputed full-range data” vs “ad-hoc range data” depending on whether `pnlBreakdownRange` exists.
   - Cache positive responses client-side in a simple `Map<string, RangeResult>` keyed by `${scope}|${mode}|${start}|${end}` to make repeated opens instant until the summary data refreshes.
4. **PnlHeatmapDialog.jsx**
   - Accept new props: `rangeSummary` (labels/delta), `rangeBreakdownState` (data + status), and handlers for clearing the range or reloading.
   - When `rangeBreakdownState.status === 'ready'`, bypass the existing `totalPnlBySymbol` prop and render the fetched entries instead (since the response will already match the `accountTotalPnlBySymbol` shape). Show a spinner overlay or inline skeleton while the range data is loading, and surface errors with retry controls.
   - Update the subtitle/toolbar area (lines ~1503–1585) to show the date span label whenever `rangeSummary` is present, and optionally disable the Total/Open/Day toggle buttons until the range is cleared (range applies only to Total mode).

### Server-Side Changes
1. **Extend `computeTotalPnlBySymbol`**
   - Add an optional `displayEndKey` (ISO `YYYY-MM-DD`) argument to `options`. When provided, clamp the generated `dateKeys` array so it stops at `displayEndKey` (or earlier if the requested end precedes `activityContext.now`). Ensure all derivative loops respect this clamp: holdings snapshots, USD rate lookups, price series requests, and final `points` aggregation.
   - Ensure `effectiveStartKey` still honors account `cagrStartDate` or the explicit `displayStartKey`, and validate that `displayStartKey <= displayEndKey`. For invalid ranges, return `{ entries: [] }` quickly.
   - Update existing callers in `server/src/index.js` and tests to pass the new option explicitly (default to `activityContext.now` when omitted) to keep behavior unchanged.
2. **New aggregation helper**
   - Implement a helper such as `computeRangeTotalPnlBySymbolForScope(scope, accounts, startKey, endKey, options)` that loops through each account in the scope, invokes `computeTotalPnlBySymbol` with `{ displayStartKey: startKey, displayEndKey: endKey, activityContext }`, and merges the resulting `entries`/`entriesNoFx`/`fxEffectCad`.
   - Reuse the superset cache (`getSupersetCacheEntry().activityContextsByAccountId`) so we can pull an activity context without making another provider request. If a context is missing, fetch/ensure it via `ensureAccountActivityContext`, but never trigger a wholesale “fetch all accounts” cycle—fallback to reporting a 503 if contexts are unavailable.
3. **API endpoint**
   - Add `GET /api/pnl-breakdown/range` (or similar) that accepts `scope=account:<id>|group:<slug>|all`, `startDate`, `endDate`, and optionally `currency` or `applyCagrStartDate`. Validate the range (start ≤ end, span within loaded series) and reject spans longer than the currently materialized history if needed.
   - The endpoint should return `{ scope, startDate, endDate, entries, entriesNoFx, fxEffectCad, asOf }`, matching the existing `accountTotalPnlBySymbol` payload so the client can drop it into the heatmap directly.
   - Add lightweight caching keyed by `scope|start|end` for a short TTL to make repeated clicks instant. Cache entries should store the merged breakdown plus the `asOf` date (end key).
4. **Performance considerations**
   - Because the endpoint reuses cached activity contexts and already-fetched price history (in-memory caches), the remaining work is pure JS processing. Guard against concurrent range requests by limiting per-scope work with promise memoization.
   - Ensure price history requests do **not** fire again if the requested end date is within the previously cached window. Use the existing `getPriceHistoryCacheKey` path to reuse downloads.

### Implementation Steps
1. [x] Update `computeTotalPnlBySymbol` (and tests under `server/test/totalPnlBySymbol.test.js`) to honor `displayEndKey`, and add guardrails for invalid ranges.
2. [x] Create a server helper + cache for range breakdowns and expose it through `/api/pnl-breakdown/range`.
3. [x] Wire the API into `App.jsx`: track `pnlBreakdownRange` state, fetch range data, and plumb it into `PnlHeatmapDialog`.
4. [x] Adjust `PnlHeatmapDialog.jsx` to display range metadata, show loading/error states, and route between precomputed totals vs range totals.
5. [x] Enhance `SummaryMetrics.jsx` to detect clicks within the selection rectangle, build the range descriptor, and invoke `onShowPnlBreakdown` with the new option. Add a “clear selection” action that resets the chart selection after the dialog closes.
6. [x] Update CSS/ARIA strings as needed so the new badge/labels remain accessible.

### Testing
- Unit:
  - [x] `npm test -- test/totalPnlBySymbol.test.js`
  - [ ] Add a new test file for the range endpoint that feeds synthetic activity contexts and asserts the merged output.
- Client: [ ] Add a `PnlHeatmapDialog` Jest/RTL test covering range loading & error UI.
- Manual: 
  1. Load the UI, select several ranges on the Total P&L chart, and verify the dialog opens with matching start/end labels and delta values.
  2. Repeat in `All accounts` mode, confirm the range dialog returns quickly (<500 ms) and FX breakdowns still sum to the chart delta.
  3. Toggle between range and non-range modes to ensure the dialog resets properly and the chart selection clears when requested.

## Total P&L Daily Series Plan

Goal: Compute a per-day Total P&L series for a selected account that:
- Starts at 0 on the first day of the period.
- Ends at the same “Total P&L” shown in the summary pod for that account.
- For each day `t` in the period: `TotalPnL(t) = EquityCAD(t) - CumulativeNetDepositsCAD(t)`.

### Current Total P&L Computation (server)
- Net deposits are derived from funding activities (deposits, withdrawals, transfers, journals), converted to CAD by date using FX, plus an optional manual adjustment.
  - Core: `server/src/index.js:2543` `computeNetDepositsCore(...)`
  - Funding activity extraction: `server/src/index.js:2140` `filterFundingActivities(...)`
  - Activity timestamp normalization: `server/src/index.js:1611` `resolveActivityTimestamp(...)`
  - Amount extraction/sign: `server/src/index.js:1823` `resolveActivityAmount(...)`, `server/src/index.js:1855` `inferActivityDirection(...)`, wrapped by `server/src/index.js:2483` `resolveActivityAmountDetails(...)`
  - FX conversion to CAD: `server/src/index.js:2521` `convertAmountToCad(...)` using `server/src/index.js:2041` `resolveUsdToCadRate(...)` (FRED + latest fallback)
  - Optional `account.netDepositAdjustment` included in totals and cash flows
- Total equity (CAD) is read from balances and used to compute Total P&L:
  - Balance merge/finalize helpers: `server/src/index.js:3244`+ (see `summarizeAccountBalances`, `mergeBalances`, `finalizeBalances`)
  - Equity extraction and `totalPnlCad = totalEquityCad - combinedCadValue`: inside `computeNetDepositsCore(...)`
- Cash flows list is also produced (CAD), ending with a positive entry for the latest total equity value; XIRR and breakdowns are computed from this schedule:
  - Return breakdown: `server/src/index.js:1416` `computeReturnBreakdownFromCashFlows(...)`
  - XIRR utilities: `server/src/xirr.js`
- Activity discovery, pagination, caching, and earliest funding search:
  - Activity windows and range: `server/src/index.js:2062` `fetchActivitiesWindow(...)`, `server/src/index.js:2109` `fetchActivitiesRange(...)`
  - Earliest funding discovery: `server/src/index.js:2188`+ `discoverEarliestFundingDate(...)`
  - Context builder (activities, dates, fingerprint): `server/src/index.js:2425` `buildAccountActivityContext(...)`

These pieces are robust and should be reused for the daily series.

### Daily Series Definition
- For a date range `[start, end]` with `start = earliest funding date` (or an overridden start), compute for each day `d`:
  - `CumulativeNetDepositsCAD(d)`: sum of CAD-converted funding cash flows with timestamps ≤ `d`, plus manual adjustment when applicable.
  - `EquityCAD(d)`: end-of-day portfolio value in CAD, including all held securities (by closing price in their native currency converted to CAD) plus cash balances (CAD + USD converted to CAD) as of `d`.
  - `TotalPnL(d) = EquityCAD(d) - CumulativeNetDepositsCAD(d)`.
  - Series starts at 0 on the first day in range and must end at the same Total P&L reported by today’s summary.

### Inputs and Data Sources
- Activities (all types) for the account over `[start, end]` via existing context builder.
- Funding cash flows and FX conversion logic already in place.
- Security master (symbol currency) and current positions:
  - Symbol details: Questrade symbols API via `server/src/index.js:3182` `fetchSymbolsDetails(...)`
- Price history: Yahoo Finance historical daily bars via `server/src/index.js:293` `computeBenchmarkReturn(...)` example; use `ensureYahooFinanceClient()` at `server/src/index.js:78` and call `yahooFinance.historical(symbol, { period1, period2, interval: '1d' })`.
- USD/CAD daily FX: `resolveUsdToCadRate(...)` with weekend/backfill behavior.

### Algorithm Outline
1) Build activity context
   - Use `buildAccountActivityContext(login, account)` to get `earliestFunding`, `crawlStart`, `activities`, `now`.
   - Default `start` = floor-to-month-start(earliestFunding) or `crawlStart`. Allow optional override (e.g., `account.cagrStartDate`).

2) Funding cash flows → daily cumulative net deposits
   - Reuse `filterFundingActivities(...)` + `resolveActivityAmountDetails(...)` + `convertAmountToCad(...)` to produce CAD cash-flow entries `{ date, amount }`.
   - Group by date (UTC date key `YYYY-MM-DD`), sum amounts, then cumulative-sum across days to produce `CumulativeNetDepositsCAD(d)`.
   - Include `account.netDepositAdjustment` on the earliest effective date (same logic as `computeNetDepositsCore(...)`).

3) Symbol set and currency map
   - Build the set of traded/held symbols from `activities` (buy/sell, dividend-reinvest, journal security transfers) plus current positions.
   - Resolve currency per symbol using Questrade `fetchSymbolsDetails(...)` (prefer symbolId from activities/positions). Fallbacks: current positions’ currency, or one-time Yahoo `quote` call to obtain currency if needed.

4) Price history per symbol (daily close)
   - For each symbol in the set, fetch daily history for `[start, end]` via Yahoo `historical` with `interval: '1d'`.
   - Use unadjusted `close` for valuation (share counts will reflect splits via activities; avoid double-adjusting by using `adjClose`).
   - Cache per (symbol, start, end) in memory and optionally to disk under `server/.cache/prices/` to limit network calls.
   - Build `priceMap[symbol][YYYY-MM-DD] = closePrice` and forward-fill missing trading days where appropriate.

5) USD→CAD FX series
   - Pre-fill `fxMap[YYYY-MM-DD] = usdToCad` via `resolveUsdToCadRate` across `[start, end]`. This already backfills across weekends/holidays.

6) Daily ledger simulation (positions + cash)
   - Initialize per-currency cash balances `{ CAD: 0, USD: 0 }` and per-symbol share counts `{ [symbol]: 0 }` at `start`.
   - Sort activities by normalized timestamp (reuse `resolveActivityTimestamp`).
   - For each activity, update ledger on its effective date:
     - Trades (buy/sell): adjust `{ shares[symbol] += quantity }` and cash by the net amount in activity currency (including fees/commissions if present in `netAmount`).
     - Dividends/interest/fees: adjust cash in appropriate currency (reinvested dividends → shares + cash decrease if modeled that way by activities; if ambiguous, treat as cash credit by default and only adjust shares if explicit).
     - Security transfers/journals: adjust share counts between accounts/currencies appropriately (when activity provides symbol and quantity).
     - Corporate actions (splits, reverse splits, symbol changes): adjust share counts based on activity details; if ratio is not parseable, mark series as “approximate” and continue.
     - FX conversions (currency journal): update cash CAD/USD according to activity currency and amounts.
   - At end of each day `d`:
     - Compute securities market value per symbol: `shares[symbol] * priceMap[symbol][d]` in native currency.
     - Convert securities in USD to CAD using `fxMap[d]`; sum all symbols to `securitiesValueCAD(d)`.
     - Compute cash CAD: `cash.CAD`; cash USD converted to CAD using `fxMap[d]` → `cashValueCAD(d)`.
     - `EquityCAD(d) = securitiesValueCAD(d) + cashValueCAD(d)`.

7) Build Total P&L series
   - For each day `d` in `[start, end]`: `TotalPnL(d) = EquityCAD(d) - CumulativeNetDepositsCAD(d)`.
   - Normalize the first point to 0. Ensure the final point equals `computeNetDepositsCore(...).totalPnl.combinedCad` (tolerance epsilon to account for rounding).

### API and Output Shape
- Add endpoint (server): `GET /api/accounts/:accountId/total-pnl-series?start=YYYY-MM-DD&end=YYYY-MM-DD`
  - Response:
    - `accountId`, `periodStartDate`, `periodEndDate`.
    - `points`: array of `{ date, equityCad, cumulativeNetDepositsCad, totalPnlCad }`.
    - Optional: `events` summary for overlays (daily funding amounts, notes on corporate actions), `incomplete: boolean` when approximations/fallbacks applied.
- Client: fetch series for the selected account; render as a line chart of `totalPnlCad` over time, starting at 0.

### Performance and Caching
- Activity fetch: reuse existing range/window caching under `server/.cache/activities`.
- Price history: implement in-memory cache keyed by `symbol|start|end` and optional disk cache under `server/.cache/prices`.
- FX rates: reuse existing `usdCadRateCache` logic.
- Concurrency: reuse `mapWithConcurrency(...)` with a conservative limit (e.g., 4–6) for price fetches.
- Minimize symbol set by deriving from activities + current positions only.

### Edge Cases and Rules
- Non-trading days: carry forward last known price; FX already backfills.
- Before first purchase of a symbol: shares are 0, so value is 0 even if a price exists.
- Missing symbol currency: fallback to positions’ currency or Yahoo quote currency; if unresolved, exclude that symbol and flag `incomplete`.
- Corporate actions without parseable ratios: skip share adjustment, mark `incomplete`; valuation may deviate slightly but end total should still reconcile if closing balance is correct.
- Reinvested dividends vs. cash-only dividends: prefer activity-provided structure; if ambiguous, default to cash credit only.
- USD cash valuation: always convert via `fxMap[d]` for each day.
- Time zone: use UTC date keys throughout (consistent with existing code paths and Yahoo historical responses).

### Validation
- Terminal check: last series point must equal the current Total P&L reported by `computeNetDepositsCore(...)` for the same account and as-of date.
- Sanity checks:
  - Equity series monotonicity is not required; net deposits cumulative is monotonic except for withdrawals.
  - Spot check a day with known large deposit/withdrawal or trade; verify expected step in cumulative net deposits and equity.
  - If `annualizedReturn` and `returnBreakdown` exist, ensure reinvested dividends handling doesn’t contradict those assumptions.

### Incremental Implementation Tasks (Current Focus)
- Core computation
  - [x] Implement `computeTotalPnlSeries(login, account, balances, options)` producing daily series objects.
  - [x] Build reusable price-history loader with caching using existing `ensureYahooFinanceClient()`.
  - [x] Extend activity parsing/ledger logic to support daily position & cash roll-forward (trades, dividends, journals, splits, FX).
  - [x] Derive cumulative net deposits per day reusing `computeNetDepositsCore` helpers.
- Surfaces
  - [x] Create a server-side script/CLI entry (e.g., `node server/src/scripts/print-total-pnl-series.js`) to emit textual series output.
  - [x] Provide a helper callable from tests to return data structures for future UI integration.
- Verification
  - [x] Add unit tests with synthetic activities validating ledger math and final reconciliation to existing total P&L.
  - [x] Add an integration test or harness runner that fetches live RESP account data and confirms the series terminal value matches the current summary total P&L.
  - [x] Document manual verification steps and record results for RESP account in this plan.

### Manual Verification (RESP `53540936`)
- 2025-10-11 run via `npm run print-total-pnl -- --account 53540936 --preview 15`
- Summary output:
  - Net deposits CAD: 229,431.73
  - Total equity CAD : 230,569.06
  - Total P&L CAD    : 1,137.33
  - Final series point matched summary total P&L (difference ≤ 0.01)
- Previewed daily points around 2025-10-11 and compared against activity history; major funding events and equity swings align with Questrade activities.
- UI now surfaces a “Total P&L” dialog (click the Total P&L metric) with an interactive chart matching the investment model styling.

### Deferred / Nice-to-have
- [ ] REST endpoint for Total P&L series (mirroring `/api/summary`).
- [ ] Client UI line chart with overlays and hover states.

### Notes
- This approach reuses all existing, hardened pieces for activities, FX, and balances, minimizing new risk.
- The main complexity is accurate day-by-day ledgering of positions/cash and symbol price retrieval; caches and conservative fallbacks keep it reliable.
