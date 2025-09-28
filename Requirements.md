# Questrade Summary Requirements

## UI Scope
- Reproduce Questrade web Summary tab visuals as closely as possible.
- Exclude the following elements:
  - "To access your Authorized Trader accounts, trade in Edge Web" banner.
  - "Add funds" button.
  - Performance chart (visual placeholder acceptable).
  - Watchlists, Trending, News tabs (only Positions tab active).
  - "Looking for a symbol or investment type?" search bar.
- Ensure spacing, typography, colors, borders, icons, and hover/active states align with Questrade styling.

## Data Behaviour
- Read-only view aggregating accounts; allow filtering by individual account number.
- Refresh token stored solely in `token-store.json`; seed via `npm run seed-token -- <refreshToken>`.
- OAuth refresh flow: GET `oauth2/token` with `grant_type=refresh_token`.
- All Questrade API calls pass through a rate-limited queue (<=30 account requests/sec) with retries on 429/1011/1006.
- Fetch balances/positions sequentially per account using account numbers; enrich with symbol metadata.

## Frontend Functionality
- Account selector lists account numbers with descriptors; default to "All accounts".
- Currency toggle supports combined/per-currency balances and aligned P&L chips.
- Total equity card displays equity value, P&L pills, timeframe buttons (visual only), and key metrics.
- Positions table shows symbol details, today/open P&L, quantities, prices, market value, currency, % of portfolio.
- Refresh action triggers summary reload; loading and error states visible.

## Deployment/Config
- `npm run seed-token -- <refreshToken>` seeds/rotates the refresh token and persists it to `server/token-store.json`.
- `npm run dev` (server) and `npm run dev -- --host` (client) for local development.
- `.env` contains only stable settings (`CLIENT_ORIGIN`, `PORT`).
