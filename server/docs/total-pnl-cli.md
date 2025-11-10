# Total P&L CLI helpers

This project includes a pair of Node scripts that let you compute and validate the Total P&L series for a Questrade account without spinning up the full web stack. They live under `server/src/scripts/` and are exposed through npm scripts so you can run them from the `server/` directory.

## Prerequisites

1. Follow the main [README](../../README.md) to install dependencies and seed `server/token-store.json` with at least one Questrade refresh token.
2. Copy `server/.env.example` to `server/.env` if you have not already so the proxy can load required environment variables.
3. Make sure you are using Node.js 20.19 or newer.

Both scripts automatically load environment variables from `.env` via `dotenv` and reuse the same login/account helpers that back the Express proxy.

## `validate-total-pnl`

Use this command when you want to confirm that the running Total P&L series reconciles with the summary net deposits and P&L values returned by the Questrade API. It compares the final point in the computed series with the combined CAD summary and fails if the difference exceeds your chosen threshold (default `0.01`).

```bash
cd server
npm run validate-total-pnl -- --account <accountNumber|id> [--login <loginId>] [--threshold <cad>] [--no-cagr-start]
```

Arguments:

- `--account` / positional `id` (required): Account number, UUID, or friendly name as returned by Questrade.
- `--login` (optional): Explicit login id when multiple tokens are configured. If omitted the first login in `token-store.json` is used.
- `--threshold` (optional): Absolute CAD difference allowed between the summary Total P&L and the final series point before the script exits with code `1`.
- `--no-cagr-start` (optional flag): Skip any account-specific `cagrStartDate` adjustments when computing the series.

Sample output:

```
Account: 12345678 - RESP Family
Period : 2019-01-01 → 2025-02-14
Points : 438
Summary total P&L (CAD): 12,345.67
Series final P&L  (CAD): 12,345.61
Difference          (CAD): 0.06
Threshold           (CAD): 0.25
Within threshold: yes

Validation succeeded.
```

If the diff exceeds the threshold the script prints the last five data points to help you diagnose where the series diverged and exits with status code `1` so it can be wired into CI.

## `validate-group-total-pnl`

Use this command to validate an aggregate (account group or "All") Total P&L. It computes the group’s all‑time Total P&L series by summing per‑account series and cross‑checks the final value against the sum of per‑account funding summaries (all‑time). If the absolute CAD difference exceeds your threshold, the script fails with exit code `1` and prints a short trailing preview.

```bash
cd server
npm run validate-group-total-pnl -- --group <name|group:id> [--threshold <cad>]
```

Examples:

- `npm run validate-group-total-pnl -- --group RRSP`
- `npm run validate-group-total-pnl -- --group group:rrsp --threshold 0.25`

This is useful to ensure the value shown in the Total P&L dialog (from the aggregated series) matches the summary’s all‑time P&L for the same group.

## `print-total-pnl-series`

Use this helper to inspect the computed Total P&L series. It prints a high-level summary and a preview table so you can spot gaps in funding data or missing price history before running the validation step.

```bash
cd server
npm run print-total-pnl -- --account <accountNumber|id> [--no-cagr-start] [--preview count]
```

Arguments:

- `--account` / positional `id` (required): Account identifier (same matching rules as the validator).
- `--no-cagr-start` (optional flag): Skip applying any account-level CAGR start date override.
- `--preview` (optional): Number of trailing rows to print in the preview table (defaults to `10`).

The summary includes the computed net deposits, total equity, and total P&L. The script also reports any missing price symbols or issues returned by the underlying calculator and highlights whether the last point matches the summary within 5 cents.

When you pass `--no-cagr-start`, the preview table displays delta values (`Δ`) that represent changes since the first date in the series, and the summary prints both the change and the all-time totals so you can see how the account has performed over the window you requested. The CLI now also echoes the baseline net deposits, equity, and total P&L for that first date so it is easy to reconcile the deltas with the actual funding activity.

## Troubleshooting tips

- Ensure the target account has recent activity before limiting the date window—Questrade may omit historical balances for long-dormant accounts.
- If you see `Unable to locate account` errors, re-run `npm run seed-token` with `--id` labels that match what you pass to `--login` and confirm the account number in Questrade's portal.
- The helpers depend on live API calls. If the Questrade API is down or rate limiting requests, rerun the scripts later.
- To debug further, open `server/src/scripts/validate-total-pnl.js` or `print-total-pnl-series.js` and adjust logging as needed.
