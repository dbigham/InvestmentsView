# UI Screenshot Capture Guide

This guide walks through everything needed to stand up the InvestmentsView stack against the live Questrade APIs and capture a screenshot of a specific account view (for example the RESP account). Follow each section carefully to avoid the most common authentication and CORS pitfalls.

## Prerequisites

- **Node.js 20.19+** (matches the versions used by the Vite frontend and the Express proxy).
- **npm** (ships with Node.js).
- **Valid Questrade refresh token** for every login you plan to mirror. Obtain these from the Questrade portal and keep them secret.
- **Network access to Questrade**. The proxy must be able to reach `https://login.questrade.com` and the REST endpoints under `https://api.questrade.com`.
- **Git ignored secrets files**:
  - `server/.env` – copy from `.env.example` and adjust `CLIENT_ORIGIN` or `PORT` only if necessary.
  - `server/token-store.json` – contains refresh tokens; never commit this file.
  - `server/accounts.json` – define friendly names (required when you need the RESP alias in the UI).

> **Do not commit** `server/.env`, `server/token-store.json`, or any other file containing credentials. They are already listed in `.gitignore` – keep it that way.

## Quick start script

For repeat runs you can automate most of the setup with
`scripts/run-live-stack.sh`. The helper script installs dependencies (unless
you opt out), writes `server/.env` when it is missing, seeds refresh tokens,
and launches both the Express proxy and Vite dev server in the foreground. It
also supports optional Playwright-based screenshots once the UI is ready.

```bash
# Example – provide secrets via environment variables to avoid shell history
FRED_API_KEY=... \
REFRESH_TOKEN=... \
scripts/run-live-stack.sh --screenshot resp.png
```

Key flags:

- `--fred-key`, `--client-origin`, and environment variables configure the
  generated `server/.env` when it does not yet exist.
- `--refresh-token` (or `REFRESH_TOKEN`) pipes the supplied value through
  `npm run seed-token`, guaranteeing that the stored refresh token is always the
  latest rotation from Questrade.
- `--skip-install`, `--no-backend`, and `--no-frontend` let you reuse already
  running services.
- `--screenshot <path>` captures a full-page Playwright screenshot after both
  servers respond. On the first run the helper installs the Playwright browser
  binaries and any missing Ubuntu libraries, which can take a few minutes while
  Chromium downloads. The script records the cache location and skips the heavy
  install on later runs, retrying with a fresh install only if the initial
  screenshot attempt fails.

The script exits only after you press `Ctrl+C`, ensuring both dev servers shut
down cleanly and any rotated refresh token is flushed to `server/token-store.json`.

> The helper seeds refresh tokens using the same undici-based client as the
> backend proxy. If the exchange fails with `HTTP 400` the supplied refresh token
> is no longer valid—request a fresh token from Questrade before retrying.
>
> The helper also refuses to start when port `4000` or the configured frontend
> port is already taken. Stop any stale `npm run dev` instances (or pass a custom
> `--client-origin`) before rerunning so the screenshot automation does not point
> at an old server.

## Configure credentials and metadata

1. Create `server/.env` with the contents (substitute your real FRED API key for the placeholder):

   ```ini
   CLIENT_ORIGIN=http://localhost:5173
   PORT=4000
   FRED_API_KEY=<FRED_API_KEY>
   ```

2. Seed the refresh token into `server/token-store.json`. You can still use the helper script, but if you need to paste the file manually start with the exact structure below. **Replace `<REFRESH_TOKEN>` with the real refresh token that you obtain from Questrade** and keep it private.

   ```json
   {
     "logins": [
       {
         "id": "daniel",
         "label": "daniel.bigham@gmail.com",
         "email": "daniel.bigham@gmail.com",
         "refreshToken": "<REFRESH_TOKEN>",
         "updatedAt": "2025-10-12T00:55:10.810Z"
       }
     ],
     "updatedAt": "2025-10-12T00:55:10.810Z"
   }
   ```

   To seed via script instead of manual editing:

   ```bash
   cd server
   npm install
   npm run seed-token -- "<refreshTokenFromQuestrade>" --id=daniel --label="daniel.bigham@gmail.com" --email="daniel.bigham@gmail.com"
   ```

   The script exchanges the refresh token, persists the rotated token that Questrade returns, and preserves any other stored logins.

3. Populate `server/accounts.json` with an entry for the RESP account using the exact template below:

   ```json
   {
     "accounts": [
       {
         "number": "53540936",
         "name": "RESP",
         "portalAccountId": "95094100-0516-40b2-0cff-0a584b8c9f19",
         "cagrStartDate": "2025-09-22",
         "ignoreSittingCash": 200,
         "default": true
       }
     ]
   }
   ```

   Keep any additional accounts you need; the proxy watches this file for updates.

4. Return to the repository root before proceeding:

   ```bash
   cd ..
   ```

## Start the proxy

1. From the repository root, launch the backend in dev mode:

   ```bash
   cd server
   npm run dev
   ```

2. Wait for the console to log that it is listening on port 4000. On the first frontend request the proxy will:
   - Refresh the access token using the stored refresh token.
   - Log the `api_server` URL supplied by Questrade.
   - Persist a **new** refresh token to `server/token-store.json`.

   Keep the terminal open – the server must stay running while you capture the screenshot.

3. After the first successful refresh, open `server/token-store.json` and note the new refresh token. Use this latest value for any subsequent runs so you do not receive HTTP 400 errors from Questrade.

## Start the frontend

1. Open a second terminal.
2. Install dependencies and start Vite:

   ```bash
   cd client
   npm install
   npm run dev -- --host
   ```

   The `--host` flag binds to `0.0.0.0`, which is required when tooling accesses the site through `localhost` inside a container.

3. Vite prints the development server URLs. Use the exact value in `CLIENT_ORIGIN` (for example `http://localhost:5173/`). Browsing with a different host such as `http://127.0.0.1:5173/` will fail CORS checks and the UI will display "Failed to fetch".

4. **If you are driving the UI from another container (e.g., Playwright in `browser_container`) forward both ports 5173 and 4000.** The frontend talks to the Express proxy at `http://localhost:4000`. If that port is not exposed to the browser container the account list never loads, the UI shows empty tables, and Playwright eventually times out waiting for selectors.

## Load the RESP dashboard

1. Open the frontend in a real browser (manual or automated) using the origin from the previous step.
2. The UI will immediately fetch `/api/summary`. Confirm in the backend logs that the request succeeds (HTTP 200). If it fails with HTTP 400, re-run the seed script with the refresh token currently stored in `server/token-store.json`.
3. Once the data loads, use the account selector in the top-left corner to choose the **RESP** account. The metrics, holdings table, and cash breakdown should now reflect only that account.
4. Wait patiently for all metrics to populate. The holdings table shows a spinner while data is loading; the spinner disappears when the API response has been processed. Depending on API latency, this can take 30 seconds or longer, so avoid stopping the servers prematurely.
5. The first `/api/summary` request performs a full historical sync (multiple years of monthly activity per account). It is normal for this call to run for several minutes and flood the proxy logs with Questrade requests. Do not interrupt it or assume it has hung—even a simple `curl` of the endpoint will block until the sync finishes.

## Capture the screenshot

- **Manual browser**: In Chromium-based browsers press `Ctrl+Shift+P` / `Cmd+Shift+P`, run the `Capture full size screenshot` command, and save the image. Ensure the account selector displays `RESP` in the header before capturing.
- **Playwright**: With the frontend already running, execute:

  ```bash
  npx playwright screenshot --device="Desktop Chrome" --output=resp.png http://localhost:5173/
  ```

  Then crop as needed to focus on the account view.

  When the test runner executes in a different sandbox (such as a dedicated browser container), make sure port forwarding is set up *before* invoking Playwright:

  ```bash
  # Example when using the eval harness
  container.exec(port_forward=[5173, 4000])
  ```

  Forgetting to forward port 4000 causes the frontend API calls to hang forever because the browser cannot reach the proxy.

- **Other automation**: Any headless driver is acceptable as long as it loads the same origin and waits for the React app to finish rendering before snapping the image.

Store screenshots under a temporary artifacts directory so they are not committed to the repository.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Failed to fetch` toast in the UI | Make sure the browser is visiting the exact origin defined in `CLIENT_ORIGIN` (typically `http://localhost:5173/`). |
| Backend logs `400 Bad Request` from Questrade | Your refresh token is stale. Copy the newest token from `server/token-store.json` (it is rotated on every refresh) and re-run `npm run seed-token -- "<token>" --id=<loginId>`. |
| Backend cannot reach Questrade (ENOTFOUND / ECONNREFUSED) | Verify internet access from the environment and retry. Questrade endpoints must be reachable. |
| Screenshot shows loading spinners | Wait for the `/api/summary` request to finish (check the Network tab or server logs) before capturing. |
| Accidentally committed secrets | Reset the commit immediately and rotate the affected refresh tokens in the Questrade portal. |

## After you are done

1. Stop the frontend (`Ctrl+C`).
2. Stop the backend (`Ctrl+C`).
3. Securely store the latest refresh token (the value in `server/token-store.json`). You will need it the next time you run the stack.
4. Delete any temporary screenshots that contain sensitive financial information when they are no longer needed.

Following the above sequence allows an LLM (or any operator) to consistently spin up the project, authenticate with live Questrade APIs, and capture accurate RESP account screenshots without running into expired refresh tokens or CORS blockers.
