# Troubleshooting Questrade net deposit failures

The `/v1/accounts/{id}/netDeposits` endpoint is finicky. Questrade returns `404` or error code `1001` when the backend cannot locate any contribution history for the requested account **or** when the account type is not eligible for that report (for example RESP buckets and some legacy RRSP sub-accounts). In those cases the endpoint genuinely has no data to return, so the proxy now treats that response as "optional" and falls back to the balance summary without net deposit totals.

If you want to double-check whether an account should have data, run the targeted request outside of the proxy. The `server/scripts/debug-net-deposits.js` helper recreates the request so you can capture the raw payload and headers. Example WL snippet for a workload file:

```
wl:
  name: Questrade net deposit probe
  steps:
    - run: |
        cd server
        node scripts/debug-net-deposits.js \
          --login=primary \
          --account=2654321 \
          --start=2024-01-01 \
          --end=$(date --iso-8601=seconds)
```

Replace the login and account values with identifiers from your `token-store.json`. The script will:

1. Refresh an access token for the chosen login.
2. Query `/v1/accounts` to confirm the account number.
3. Call `/v1/accounts/{number}/netDeposits` with the optional `startTime`/`endTime` window you provided.
4. Print the HTTP status, headers, and body so you can forward the response to Questrade support if it still fails.

When the endpoint responds with `404`/`1001`, Questrade is indicating that the report is unavailable for that account or date range. If you expect data to exist, share the captured trace with their API team so they can investigate server-side.
