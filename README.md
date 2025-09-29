# Questrade Summary View

A local web app that mirrors the Questrade web portal "Summary" tab so you can review both your account and your spouse's on the same screen. The app is read-only and pulls live balances and positions through Questrade's public API.

## Project layout

- `server/` - Node/Express proxy that refreshes OAuth tokens, calls Questrade endpoints, and exposes a single `/api/summary` endpoint to the frontend.
- `client/` - React single-page app (Vite) that recreates the Summary dashboard UI with account selector, currency toggle, metrics, and holdings table.

## Prerequisites

- Node.js 20.19 or later (the UI still builds on 20.11 but Vite prints a warning).
- One or more valid Questrade API refresh tokens (one per Questrade login you want to include).

## Getting started

1. Configure credentials
   - Copy `server/.env.example` to `server/.env` (no refresh token needed).
   - Seed refresh tokens for each login by running

        npm run seed-token -- <refreshTokenFromQuestrade> [--id=<loginId>] [--label="Display name"] [--email=<email>]

     inside the `server` directory. Repeat for every login you want to mirror (for example, `--id=daniel` and `--id=meredith`). When omitted, `--id` defaults to `primary` and updates that entry.
   - Optionally adjust `CLIENT_ORIGIN` or `PORT` if you change the frontend host.
   - (Optional) Copy `server/account-beneficiaries.example.json` to `server/account-beneficiaries.json` and replace the placeholder account numbers with your own. The proxy reads this file to attach household beneficiary metadata (for example "Eli Bigham" or "Philanthropy") to each account.
   - (Optional) Copy `server/accounts.example.json` to `server/accounts.json` to define friendly account names and Questrade portal UUIDs per account number. The proxy watches this file for updates and forwards the resolved `portalAccountId` to the UI so Ctrl/⌘-clicking the account selector can open the matching page in the Questrade portal.
   - Copy `client/.env.example` to `client/.env` if you want to point the UI at a non-default proxy URL.

2. Install dependencies

        cd server
        npm install

        cd ../client
        npm install

3. Run the backend

        cd server
        npm run dev

   The server listens on port `4000` by default. It keeps access tokens in memory and saves the most recent refresh token to `server/token-store.json` so restarts do not require manual updates.

4. Run the frontend

        cd client
        npm run dev

   Vite serves the app on `http://localhost:5173` by default. Open that URL in your browser.

## Features

- Account drop-down with "All accounts" aggregate view across every configured login.
- Currency toggle that surfaces combined and per-currency balances if Questrade returns them.
- Total equity card with today's and open P&L badges, cash, market value, and buying power.
- Positions table listing symbol, description, account number, intraday/open P&L, quantities, prices, and market value.
- Manual refresh button to force a new fetch from Questrade.
- Beneficiaries overlay that converts every account to CAD and totals holdings for each household member.
- Automatic handling of access-token refresh and persistence of the newest refresh token.

## Notes & limitations

- The proxy requests `/v1/accounts`, `/v1/accounts/{id}/positions`, `/v1/accounts/{id}/balances`, and `/v1/symbols` for enrichment. Additional summary widgets (charts, watchlists, events) from the official site are intentionally omitted.
- Combined P&L values still reflect the native currency of each position; cross-currency translation is on the enhancement list.
- The app is read-only by design; no trade placement or fund transfers are exposed.

## Building for production

        cd client
        npm run build

The compiled frontend lives under `client/dist/`. Serve it with any static host and point it at the running proxy.

## Rotating tokens

Use `npm run seed-token -- <refreshToken> --id=<loginId>` any time you generate a fresh token in the Questrade portal. The script exchanges it, updates the matching login inside `server/token-store.json`, and preserves the other stored logins. Add `--label` and `--email` to refresh the display metadata when needed.
