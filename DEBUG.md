# Debug Log

Step 1 - Verify server reachable and Questrade working
- Action: `Invoke-WebRequest http://localhost:4000/health` and `Invoke-WebRequest http://localhost:4000/api/summary?accountId=53540936&refreshKey=debug-step1-20251230174116`.
- Result: both requests failed with "Unable to connect to the remote server".
- Questrade status: not reachable (server connection failed before Questrade calls).

Step 2 - Server running; baseline summary call
- Action: `Invoke-WebRequest http://localhost:4000/health` and `Invoke-WebRequest http://localhost:4000/api/summary?accountId=53540936&refreshKey=debug-step2-20251230174235`.
- Result: health 200, summary 200.
- Questrade status: working (summary call succeeded).

Step 3 - Attempt live payload diff script (failed)
- Action: Node script to fetch `/api/summary` + `/api/accounts/53540936/total-pnl-series` and compute summary vs hover annualized.
- Result: script failed with `ReferenceError: buildTotalPnlDisplaySeries is not defined` before outputs.
- Questrade status: unknown (script failed before reporting status).

Step 3b - Confirm Questrade after failed script
- Action: `Invoke-WebRequest http://localhost:4000/api/summary?accountId=53540936&refreshKey=debug-step3b-20251230174545`.
- Result: summary 200.
- Questrade status: working (summary call succeeded).

Step 4 - Fetch live summary + series and compute summary vs hover annualized
- Action: Node script fetched `/api/summary?accountId=53540936&refreshKey=debug-step4-20251230174804` and `/api/accounts/53540936/total-pnl-series?refreshKey=debug-step4-20251230174804`, then computed UI-equivalent hover annualized from series.
- Result: summary annualized 9.9833%, hover annualized 9.9833%; start/end keys 2025-09-18 → 2025-12-30.
- Questrade status: working (summary + series returned 200).

Step 5 - Inspect annualizedReturnAllTime for RESP
- Action: Node script fetched `/api/summary?accountId=53540936&refreshKey=debug-step5-20251230174936` and printed annualized return values.
- Result: annualizedReturn 9.9833%, annualizedReturnAllTime 10.9080%, all-time start 2025-07-23.
- Questrade status: working (summary returned 200).

Step 6 - Implement fix to include all-time series for single-account summary
- Action: Updated `server/src/index.js` to compute and include `accountTotalPnlSeries[accountId].all` using `applyAccountCagrStartDate: false` with shared activity context/positions.
- Result: code change applied; requires server restart to take effect.
- Questrade status: checked via `Invoke-WebRequest http://localhost:4000/api/summary?accountId=53540936&refreshKey=debug-step6a-20251230175151` → 200.

Step 7 - Re-run summary + hover comparison script (failed before API call)
- Action: Node script to fetch `/api/summary` and compute hover vs summary annualized, but script used `require()` inside ESM with top-level await.
- Result: script failed with `ERR_AMBIGUOUS_MODULE_SYNTAX` before any API call.
- Questrade status: unknown (script failed before any request).

Step 7b - Re-run summary + hover comparison with ESM import
- Action: Node script fetched `/api/summary?accountId=53540936&refreshKey=debug-step7b-20251230181810` and attempted to compute hover annualized.
- Result: summary 200, but all values were `n/a` and `Has all-time series: false` because accountId needed full login prefix.
- Questrade status: working (summary request returned 200).

Step 8 - Inspect summary account IDs and series keys
- Action: Node script fetched `/api/summary?accountId=53540936&refreshKey=debug-step8-20251230181832` and printed account IDs + `accountTotalPnlSeries` keys.
- Result: accounts include `daniel.bigham@gmail.com:53540936`; series keys only include that composite ID; top-level annualized fields were null.
- Questrade status: working (summary request returned 200).

Step 9 - Compare hover annualized using composite account ID
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step9-20251230182020`, computed hover annualized from series.
- Result: `Hover annualized (CAGR series): 10.0152%`, `Hover annualized (ALL series): 10.0199%`, `Has all-time series: true`; top-level annualized fields were still `n/a`.
- Questrade status: working (summary request returned 200).

Step 10 - Inspect summary payload for annualized fields
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step10-20251230182046` and printed top-level keys + annualized fields.
- Result: top-level `annualizedReturn` fields are null; `accountFunding` lives in payload.
- Questrade status: working (summary request returned 200).

Step 11 - Inspect funding summary annualized fields (wrong properties)
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step11-20251230182152` and printed `fundingSummary.*Rate` fields.
- Result: all `annualizedReturnRate*` fields were null because server returns `annualizedReturn` objects, not flattened rate fields.
- Questrade status: working (summary request returned 200).

Step 12 - Compare funding annualized vs hover annualized
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step12-20251230182443`, read `fundingSummary.annualizedReturn(.AllTime).rate`, computed hover annualized from `accountTotalPnlSeries` (CAGR + all).
- Result: `funding annualizedReturn.rate: 10.0152%` matches hover CAGR `10.0152%`, but `funding annualizedReturnAllTime.rate: 11.0753%` does NOT match hover ALL `10.0199%`.
- Questrade status: working (summary request returned 200).

Step 13 - Inspect all-time series vs funding totals
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step13-20251230184008`, printed first/last series points, display points, range summary, and funding totals.
- Result: series last equity 237701.9538, series last net deposits 231422.9586, series total P&L 6278.9952, hover annualized ~10.0199%. Funding net deposits all-time 231422.8954, funding total P&L all-time 6289.0584, equity 237701.9538. Funding cash flows are stripped from summary response.
- Questrade status: working (summary request returned 200).

Step 14 - Compare funding vs series via server functions (failed)
- Action: Node script using server functions to compute net deposits and series; required `dotenv` which is not installed.
- Result: script failed with `Cannot find module 'dotenv'` before any API calls.
- Questrade status: unknown (script failed before any request).

Step 14b - Compare funding vs series via server functions (success)
- Action: Node script used server functions (`computeNetDepositsCore`, `computeTotalPnlSeries`) for `daniel.bigham@gmail.com:53540936`.
- Result: net deposits all-time 230808.010000; series last net deposits 231410.983009 (delta ~602.973). Total P&L all-time (funding) 6924.015242 vs series total P&L 6321.042233. Output indicates a refresh token rotation occurred during the script.
- Questrade status: working (script executed and refreshed token successfully).

Step 15 - Validate helper uses same series basis as chart
- Action: Node script computed all-time annualized return from raw series points and from display series using `buildAnnualizedReturnFromSeriesPoints`.
- Result: helper all-time rate 0.1004881677; display-series rate 0.1004881677 (exact match). Script rotated refresh token during Questrade calls.
- Questrade status: working (script executed and refreshed token successfully).

Step 16 - Run unit test for series-based annualized helper
- Action: `node --test server/test/annualizedReturnFromSeriesPoints.test.js`.
- Result: test passed.
- Questrade status: not exercised (unit test only).

Step 17 - Post-restart summary check (failed)
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step17-20251230185543` to compare summary vs hover annualized returns.
- Result: summary request failed with HTTP 500.
- Questrade status: unknown (server error before verification).

Step 17b - Fix summary 500 due to missing variable
- Action: Updated `server/src/index.js` to re-read `fundingSummary` inside the all-time series block (previous reference was out of scope and caused a ReferenceError).
- Result: code change applied; server restart required to re-run checks.
- Questrade status: not checked (requires server restart).

Step 18 - Post-restart summary vs hover check
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step18-20251230192721` and computed summary vs hover annualized returns for CAGR and all-time series.
- Result: summary CAGR 10.0701% vs hover CAGR 10.0774%; summary all-time 10.0750% vs hover all-time 10.0822%. All-time series present.
- Questrade status: working (summary request returned 200).

Step 19 - Compare raw vs display series annualized (365.25)
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step19-20251230193028`, computed annualized return from raw series points and display series using 365.25-day year.
- Result: raw points count 161; display points count 161; no missing totals/equity/deposits; annualized from raw points = 10.082192%, display series = 10.082192%.
- Questrade status: working (summary request returned 200).

Step 20 - Recompute hover annualized with 365-day year
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step20-20251230193308` and computed hover annualized using a 365-day year (server xirr convention).
- Result: summary CAGR 10.0701% matches hover CAGR 10.0701%; summary all-time 10.0750% matches hover all-time 10.0750%.
- Questrade status: working (summary request returned 200).

Step 21 - Post-UI reload summary vs hover check
- Action: Node script fetched `/api/summary?accountId=daniel.bigham@gmail.com:53540936&refreshKey=debug-step21-20251230193733` and computed annualized returns using a 365-day year (matching server).
- Result: summary CAGR 10.0455% matches hover CAGR 10.0455%; summary all-time 10.0503% matches hover all-time 10.0503%.
- Questrade status: working (summary request returned 200).
