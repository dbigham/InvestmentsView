# Questrade UI Plan

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
