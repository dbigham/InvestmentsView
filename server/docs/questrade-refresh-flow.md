# Questrade refresh token workflow

This document explains how the server exchanges a Questrade refresh token for an access token, stores the updated refresh token, and ensures future API calls always use the most recent credentials.

## OAuth token exchange

Questrade issues long-lived **refresh tokens** that can be exchanged for short-lived **access tokens**. The server and supporting tooling call the public OAuth endpoint:

```
GET https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=<refresh-token>
```

The response includes the new access token, its expiry, the API base URL, and—if the refresh token rotates—a replacement refresh token:

```json
{
  "access_token": "<access-token>",
  "expires_in": 1800,
  "api_server": "https://api02.iq.questrade.com/",
  "refresh_token": "<next-refresh-token>"
}
```

Because Questrade may return a new `refresh_token` on *every* exchange, the caller must persist the rotated value before using it again. Re-using an obsolete refresh token will cause the next exchange attempt to fail with `400`/`401` errors.

## Verifying the exchange with cURL

You can test the exchange manually with `curl` (replace placeholders with real values):

```bash
curl \
  --get "https://login.questrade.com/oauth2/token" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=${QUESTRADE_REFRESH_TOKEN}" \
  --silent | jq
```

The command:

1. Makes the same GET request that the application issues.
2. Prints the JSON payload so you can confirm the fields.
3. Lets you copy the `refresh_token` field for persistence.

If `jq` is unavailable, omit the pipe to `jq` to review the raw JSON. Keep the new refresh token safe—this is a sensitive credential.

## Persisting refresh tokens in `token-store.json`

The project tracks refresh tokens in `server/token-store.json`. Each login stores metadata plus the latest refresh token:

```json
{
  "logins": [
    {
      "id": "primary",
      "label": "Personal",
      "email": "name@example.com",
      "refreshToken": "<latest-refresh-token>",
      "updatedAt": "2024-05-12T03:54:00.000Z"
    }
  ],
  "updatedAt": "2024-05-12T03:54:00.000Z"
}
```

When you manually exchange a token (for example via `curl`), copy the new `refresh_token` into the matching login entry and bump `updatedAt`. Alternatively, run the helper script which does this automatically:

```bash
cd server
npm run seed-token -- <refreshToken> --id=<loginId> [--label="Display Name"] [--email=user@example.com]
```

The script exchanges the supplied refresh token, writes the response to `token-store.json`, and preserves other configured logins.

## How the server uses and rotates tokens

1. **Startup** – The server loads `token-store.json` and normalizes every login record into memory (`loadTokenStore`). If no logins are found the process exits with an error, ensuring the API never runs without credentials.
2. **Request execution** – Whenever the server needs to call Questrade, it obtains a token context via `getTokenContext`. If no cached access token exists, `refreshAccessToken` exchanges the current refresh token.
3. **Token rotation** – After each successful exchange, if Questrade supplies a different `refresh_token`, `updateLoginRefreshToken` updates the in-memory login, timestamps it, and calls `persistTokenStore` to rewrite `token-store.json`.
4. **Subsequent calls** – Future requests for the same login re-use the cached access token until expiry. On expiry (or `401` responses) the server refreshes again, always using the most recently persisted refresh token.

These steps ensure the **latest refresh token** is always used and stored.

## Why persistence matters

- **Avoiding failures** – Questrade invalidates prior refresh tokens immediately. If `token-store.json` is not updated after a rotation, the next refresh attempt will fail and any API endpoints depending on that login will break.
- **Crash resilience** – Access tokens live only in memory. Persisting the new refresh token guarantees that restarts continue functioning without manual intervention.
- **Multiple code paths** – Both the long-running server and the CLI utilities reuse the same persistence helpers, so every flow that encounters a rotated refresh token writes it back to disk.

Always treat `token-store.json` as the single source of truth. After any manual exchange, verify the file contains the fresh refresh token before running the server or tooling.
