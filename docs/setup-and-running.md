# Setup & running guide

This document collects every detail needed to stand up the dashboard locally, customize it for a household, and ship a production build.

## Repository layout

- `client/` - React + Vite single-page app (SPA) rendered in the browser.
- `server/` - Node/Express proxy that calls the Questrade APIs, refreshes OAuth tokens, and exposes a single `/api/summary` endpoint to the UI.
- `shared/` - Utility modules reused across the client and server (formatters, deployment helpers, date math, etc.).
- `docs/` - Guides, screenshots, and operational notes.
- `vendor/` - Optional checkouts for external helpers like the TQQQ investment-model bridge.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 20.19+ | The UI still builds on 20.11, but Vite prints a warning. |
| npm 10+ | Installed with Node 20. |
| Python 3.9+ (optional) | Needed only when running the investment model helper / QQQ temperature overlays. |
| Git | For cloning this repo and any optional helpers. |
| Questrade API refresh tokens | One per login you want to mirror. Generate them through Questrade's official portal. |

## 1. Configure credentials & metadata

1. Copy `server/.env.example` to `server/.env`. Adjust `PORT`, `CLIENT_ORIGIN`, or logging flags as required.
2. Seed refresh tokens for each login:

   ```bash
   cd server
   npm run seed-token -- <refreshTokenFromQuestrade> [--id=<loginId>] [--label="Display name"] [--email=<email>]
   ```

   - Run the command once per login. `--id` defaults to `primary` if omitted. Use friendly IDs such as `daniel`, `meredith`, or `resp`.
   - The seed script exchanges the refresh token, stores the resulting access + refresh pair in `server/token-store.json`, and preserves existing logins.
   - Re-run the command any time you rotate a refresh token.
3. (Optional) Copy `server/account-beneficiaries.example.json` to `server/account-beneficiaries.json` and replace the placeholder account numbers. The proxy uses the file to surface per-account beneficiary metadata (for example "Eli" or "Philanthropy").
4. (Optional) Copy `server/accounts.example.json` to `server/accounts.json` to define richer metadata:
   - `label`, `chatURL`, `uuid`, and `email` for deep links and quick support actions.
   - `showQQQDetails` to display the QQQ temperature card for specific accounts.
   - `investmentModels` arrays describing each strategy (`model`, `symbol`, `leveragedSymbol`, `reserveSymbol`, `lastRebalance`).
   - `netDepositAdjustment`, `cagrStartDate`, `default`, and nested `accounts` arrays to control ordering and calculations.
   - Override the path to this file with `ACCOUNTS_FILE` / `ACCOUNT_NAMES_FILE` if you keep metadata elsewhere.
5. (Optional) Copy `client/.env.example` to `client/.env` if the frontend should target a non-default proxy URL or needs extra keys such as `VITE_LOGO_DEV_PUBLISHABLE_KEY`.
6. (Optional) Provide `OPENAI_API_KEY` (and `OPENAI_NEWS_MODEL`) in `server/.env` to enable the News tab powered by OpenAI.
7. Enable verbose API logging by setting `DEBUG_QUESTRADE_API=true` in `server/.env` when diagnosing proxy calls.

## 2. Install dependencies

```bash
cd server
npm install

cd ../client
npm install
```

## 3. (Optional) Install the investment-model helper

```bash
mkdir -p vendor
cd vendor
git clone https://github.com/dbigham/TQQQ.git TQQQ
```

Follow the helper repository's README to install its Python dependencies (virtualenv recommended). The server honours `INVESTMENT_MODEL_REPO` if you keep the checkout somewhere else. You only need this helper when accounts opt in to `investmentModels` or `showQQQDetails`.

## 4. Run the backend (development)

```bash
cd server
npm run dev
```

- Default port: `4000`.
- The proxy stores refreshed tokens in memory and persists the latest refresh token per login to `server/token-store.json` so restarts do not require reseeding.
- The proxy only authorizes the frontend origin defined in `CLIENT_ORIGIN`. When driving automated browsers, match that origin exactly (for example `http://localhost:5173/` instead of `http://127.0.0.1:5173/`). See [`docs/ui-screenshot-guide.md`](./ui-screenshot-guide.md) for an end-to-end walkthrough.

## 5. Run the frontend (development)

```bash
cd client
npm run dev
```

Vite serves the SPA at `http://localhost:5173`. Open the URL in a browser window that is allowed by `CLIENT_ORIGIN`.

## 6. Building for production

```bash
cd client
npm run build
```

The compiled assets are written to `client/dist/`. Serve that folder with any static host (NGINX, S3 + CloudFront, etc.) and point it at the running proxy.

## Feature toggles & integrations

### Logo.dev support

Set `VITE_LOGO_DEV_PUBLISHABLE_KEY=pk_...` inside `client/.env` to enable high-quality company logos in the Positions table. The UI loads logos from `https://img.logo.dev/ticker/<TICKER>?token=...`. Never embed a secret (`sk_...`) key in the client bundle.

### News tab

Provide `OPENAI_API_KEY` and optionally `OPENAI_NEWS_MODEL` (defaults to a GPT-4.1/4o series model) inside `server/.env`. When set, the News tab summarizes recent public articles related to the holdings shown on screen.

### Deployment overrides & projections

Use `server/accounts.json` to set `cashOverrides`, `investmentModels`, and projection presets per account. The proxy watches the file for changes and hot-reloads metadata without restarting the process.

## Rotating tokens

Whenever you generate a fresh refresh token inside Questrade, run:

```bash
cd server
npm run seed-token -- <refreshToken> --id=<loginId> [--label="Display name"] [--email=<email>]
```

The script replaces only the matching login entry in `token-store.json` and keeps other logins untouched.

## Notes & limitations

- API coverage: the proxy calls `/v1/accounts`, `/v1/accounts/{id}/positions`, `/v1/accounts/{id}/balances`, `/v1/accounts/{id}/activities`, and `/v1/symbols` for enrichment. Additional widgets from the official portal (watchlists, events, etc.) are intentionally omitted.
- Currency translation: combined P&L values reflect the native currency of each position. Cross-currency translation is on the enhancement list.
- Read-only by design: no trade placement, journaling, or fund transfers are exposed.
- Dividend coverage depends on `activities` responses. If the API does not return history for an account, the Dividends tab may show partial data.
- Investment model evaluation requires the optional Python helper. When it fails, the UI gracefully falls back to the standard QQQ card.
- Pull-request automation: when preparing a PR with the OpenAI `make_pr` helper, avoid Git submodules. The helper snapshots files but does not understand gitlink entries, and the request fails silently.

## Troubleshooting & ops notes

- Use `npm run lint` / `npm run test` inside `client` if you add automated checks.
- The `docs/stop-servers.md` guide lists commands for cleaning up lingering dev servers on Windows.
- For deterministic screenshots (useful when updating documentation), follow [`docs/ui-screenshot-guide.md`](./ui-screenshot-guide.md).
