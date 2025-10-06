# Questrade Summary View

A local web app that mirrors the Questrade web portal "Summary" tab so you can review both your account and your spouse's on the same screen. The app is read-only and pulls live balances and positions through Questrade's public API.

## Project layout

- `server/` - Node/Express proxy that refreshes OAuth tokens, calls Questrade endpoints, and exposes a single `/api/summary` endpoint to the frontend.
- `client/` - React single-page app (Vite) that recreates the Summary dashboard UI with account selector, currency toggle, metrics, and holdings table.
- `vendor/` - Optional checkouts for external helpers (for example the TQQQ investment model bridge).

## Prerequisites

- Node.js 20.19 or later (the UI still builds on 20.11 but Vite prints a warning).
- Python 3.9 or later if you plan to evaluate investment models / QQQ temperature overlays.
- One or more valid Questrade API refresh tokens (one per Questrade login you want to include).

## Getting started

1. Configure credentials
   - Copy `server/.env.example` to `server/.env` (no refresh token needed).
   - Seed refresh tokens for each login by running

        npm run seed-token -- <refreshTokenFromQuestrade> [--id=<loginId>] [--label="Display name"] [--email=<email>]

     inside the `server` directory. Repeat for every login you want to mirror (for example, `--id=daniel` and `--id=meredith`). When omitted, `--id` defaults to `primary` and updates that entry.
   - Optionally adjust `CLIENT_ORIGIN` or `PORT` if you change the frontend host.
   - (Optional) Copy `server/account-beneficiaries.example.json` to `server/account-beneficiaries.json` and replace the placeholder account numbers with your own. The proxy reads this file to attach household beneficiary metadata (for example "Eli Bigham" or "Philanthropy") to each account.
   - (Optional) Copy `server/accounts.example.json` to `server/accounts.json` to define friendly account names, chat links, and Questrade portal UUIDs per account number. The proxy watches this file (or the path pointed to by `ACCOUNTS_FILE` / `ACCOUNT_NAMES_FILE`) for updates and forwards the resolved metadata to the UI so Ctrl/⌘-clicking the account selector can open the matching page in the Questrade portal. You can also:
     - Set `showQQQDetails` to surface the per-account QQQ temperature card.
     - Attach an `investmentModel` key (plus `lastRebalance`) to evaluate a strategy with the optional bridge.
     - Provide `chatURL` links that appear under the summary card "Actions" menu.
     - Apply `netDepositAdjustment` and `cagrStartDate` overrides to tune funding / return calculations.
     - Mark `"default": true` on an account to have the dashboard start there after a restart.
     - Supply nested `accounts` arrays to record preferred ordering for the account picker.
   - (Optional) Copy `client/.env.example` to `client/.env` if you want to point the UI at a non-default proxy URL.

2. Install dependencies

        cd server
        npm install

        cd ../client
        npm install

3. (Optional) Install the investment model helpers

       mkdir -p vendor
       git clone https://github.com/dbigham/TQQQ.git vendor/TQQQ

   Install Python dependencies for the bridge according to the helper repository's README. The server will also honour the
   `INVESTMENT_MODEL_REPO` environment variable if you prefer to keep the checkout elsewhere. The bridge is only required when
   accounts are configured with an `investmentModel` or `showQQQDetails`.

4. Run the backend

        cd server
        npm run dev

   The server listens on port `4000` by default. It keeps access tokens in memory and saves the most recent refresh token to `server/token-store.json` so restarts do not require manual updates.

5. Run the frontend

        cd client
        npm run dev

   Vite serves the app on `http://localhost:5173` by default. Open that URL in your browser.

## Features

- Account drop-down with "All accounts" aggregate view across every configured login.
- Currency toggle that surfaces combined and per-currency balances if Questrade returns them.
- Total equity card with today's and open P&L badges, cash, buying power, and a funding summary (net deposits, cumulative P&L, annualized return, and account-level adjustments).
- Positions table listing symbol, description, account number, intraday/open P&L, quantities, prices, and market value.
- Dividends tab that groups historical distributions by symbol, currency, and time range.
- Action menu to copy a text summary, draft a CAGR prompt, or build an "invest cash evenly" plan from live holdings and balances.
- Manual refresh button to force a new fetch from Questrade.
- People overlay that converts every account to CAD and totals holdings for each household member.
- Cash breakdown dialog for aggregate CAD or USD balances.
- P&L heatmap that breaks down gains by symbol or sector.
- Optional QQQ temperature / investment model evaluation card when the helper bridge is installed.
- Automatic handling of access-token refresh and persistence of the newest refresh token.

## Notes & limitations

- The proxy requests `/v1/accounts`, `/v1/accounts/{id}/positions`, `/v1/accounts/{id}/balances`, and `/v1/symbols` for enrichment. Additional summary widgets (charts, watchlists, events) from the official site are intentionally omitted.
- Combined P&L values still reflect the native currency of each position; cross-currency translation is on the enhancement list.
- The app is read-only by design; no trade placement or fund transfers are exposed.
- Dividend summaries rely on `/v1/accounts/{id}/activities`; if the API omits history for an account or the server cannot backfill FX conversions the panel will show partial data.
- Investment model evaluation requires Python and the optional helper repository; failures fall back to the standard QQQ view without blocking the rest of the dashboard.
- When preparing a pull request with the OpenAI `make_pr` helper, avoid adding Git submodules. The helper snapshots files but does not understand gitlink entries, so the request fails silently after a few seconds instead of creating the PR. Vendor external code directly if it needs to ship with the app.

## Building for production

        cd client
        npm run build

The compiled frontend lives under `client/dist/`. Serve it with any static host and point it at the running proxy.

## Rotating tokens

Use `npm run seed-token -- <refreshToken> --id=<loginId>` any time you generate a fresh token in the Questrade portal. The script exchanges it, updates the matching login inside `server/token-store.json`, and preserves the other stored logins. Add `--label` and `--email` to refresh the display metadata when needed.
