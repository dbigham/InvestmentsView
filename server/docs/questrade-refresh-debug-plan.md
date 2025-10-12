# Questrade OAuth Redirect Investigation Plan

This note collects the concrete steps I intend to take (and the rationale behind
each step) to eliminate the difference between the successful Python helper and
the failing Node CLI refresh flow. The goal is to both narrow the root cause and
arrive at a reliable mitigation so `npm run print-total-pnl` can recover tokens
without tripping Cloudflare's 301 loop.

## 1. Capture the exact redirect that Node receives

Although the Node helper already logs the response `location` header, the next
run will persist the entire sequence (URL, status, cookies) to a trace file so
we can compare multiple executions offline. With that we can answer:

* Is Cloudflare redirecting to the bare login host, to `/` or to
  `/oauth2/token` without query parameters?
* Does the redirect include `__cf_bm`, `cf_clearance`, or other cookies that the
  Python client never sees?

## 2. Force Node to match Python's connection behaviour

Python's `requests` stack speaks HTTP/1.1 with a non-keepalive socket. Node's
`axios` relies on the built-in keepalive agent. I'll add a code path that:

* Forces `Connection: close` and disables the keep-alive agent via
  `new https.Agent({ keepAlive: false })`.
* Pins the TLS version/cipher list to mirror `openssl s_client -tls1_2` (the
  default that CPython 3.11 uses).

Each knob will be toggled in isolation so we can see which difference clears the
301, if any.

## 3. Reproduce the flow with a bare `https` request

Should the axios path continue to fail, I'll drop down to
`https.request`/`undici` so we remove axios' redirect handling from the
equation. The experiment matrix will be:

1. axios + keepalive (current failure)
2. axios + no keepalive (post-change from step 2)
3. undici client (HTTP/1.1)
4. raw `https.request`

If only the lower-level clients succeed, we can either keep that
implementation or patch axios usage accordingly.

## 4. Compare with a POST refresh exchange

While the documented flow accepts GET, most OAuth token endpoints also allow a
form-encoded POST. I'll add a flag to the helper to send
`application/x-www-form-urlencoded` payloads. If POST succeeds while GET fails
only under Node, we can immediately pivot the CLI to POST and avoid the redirect
altogether.

## 5. Automate diffing between Python and Node headers

The Python helper will emit a canonical JSON blob describing request headers and
cookies for every attempt. The Node helper will do the same. By diffing the two
snapshots we can spot any subtle discrepancy (e.g. header casing, missing
`Accept-Language`) that we can then mimic.

## Expected outcome

By executing the above experiments sequentially—stopping as soon as a 301 is
reproduced—we either identify the single behavioural difference Cloudflare is
responding to or implement a safe workaround (POST or raw https) that we can
ship in the CLI.

## Progress log

### 2025-10-12 — Step 1 trace capture

* Added configurable tracing, header overrides, and transport toggles to the
  Python and Node helpers so each experiment can snapshot request metadata,
  TLS settings, and the full redirect chain to disk.
* Captured a baseline Node redirect loop with the new trace tooling. Cloudflare
  returns `301` with a `location` that simply replays the original token
  exchange request (including `refresh_token=…`) while issuing a `__cf_bm`
  cookie. Subsequent attempts reuse that redirect URL and repeat the 301 with no
  additional cookies, confirming that the loop is self-contained on the login
  host.
* Next action once a fresh token is available: rerun the helper with
  `--node-keepalive false` and `--node-connection-close` toggled individually to
  test the hypothesis from Step 2 that socket reuse (keep-alive) is the primary
  differentiator from Python's behaviour.

### 2025-10-12 — Step 2 keep-alive toggle

* With a fresh refresh token, ran `python3 server/scripts/refresh_questrade_token.py --driver node --count 1 --node-keepalive false --trace /tmp/questrade-trace-keepalive-false.json` so the Node helper would disable its keep-alive agent and capture a full redirect trace.
* Cloudflare continued to issue an immediate 301 redirect loop back to the original `oauth2/token` URL. The first response set a `__cf_bm` cookie, subsequent retries reused that cookie, and every follow-up request repeated the 301 with no body, matching the previous failure profile.
* Because the loop invalidates the refresh token, further experiments must pause until a new token is provided. Once available, the next toggle to try is `--node-connection-close` (adding an explicit `Connection: close` header) to test whether header-level signalling rather than agent configuration is required.

### 2025-10-12 — Step 2 connection-close header

* With a fresh refresh token, ran `python3 server/scripts/refresh_questrade_token.py --driver node --count 1 --node-connection-close --trace /tmp/questrade-trace-connection-close.json` so the Node helper would send an explicit `Connection: close` header while otherwise using the default keep-alive agent.
* The first request immediately received a 301 redirect back to the original `oauth2/token` URL, set a `__cf_bm` cookie, and the helper aborted after exceeding the redirect limit—matching the prior failure signature.
* The refresh token used for this attempt is now invalidated. Once a new token is provided, the next experiment will toggle TLS settings (minimum/maximum version and cipher list) per Step 2 to determine whether the transport handshake differences influence Cloudflare's behaviour.

### 2025-10-12 — Step 2 TLS version pinning

* Received another fresh token and executed `python3 server/scripts/refresh_questrade_token.py --driver node --count 1 --node-tls-min TLSv1.2 --node-tls-max TLSv1.2 --trace /tmp/questrade-trace-tls12.json` so the Node helper would negotiate strictly with TLS 1.2, mirroring CPython's default handshake.
* Cloudflare again returned an immediate 301 redirect loop to the original `oauth2/token` URL, issued a `__cf_bm` cookie on the first response, and the helper exited after hitting the redirect ceiling—identical to the earlier failures.
* This invalidated the refresh token used in the test. The next planned toggle (once another token is available) is to override the cipher suite list so Node matches `openssl s_client -tls1_2 -cipher` output, after which we can proceed to Step 3's alternate HTTP client experiments if the redirect persists.

### 2025-10-12 — Step 2 cipher suite alignment

* With a new refresh token, invoked `python3 server/scripts/refresh_questrade_token.py --driver node --count 1 --node-tls-ciphers "TLS_AES_256_GCM_SHA384:…:DHE-RSA-AES128-SHA256" --trace /tmp/questrade-trace-ciphers.json` so the Node helper would mirror Python's default OpenSSL cipher preference order.
* The request still produced an immediate 301 redirect back to the original `oauth2/token` URL. Cloudflare set `__cf_bm` on the first response, every retry reused that cookie, and the helper aborted after exceeding the redirect limit, matching the prior failure signature.
* Because the cipher alignment did not resolve the loop, the next experiment (after obtaining another fresh token) will advance to Step 3: re-issuing the refresh request with an alternate HTTP client (`undici` followed by raw `https.request`) to determine whether axios' redirect handling is the differentiator.

### 2025-10-12 — Step 3 undici/https without proxy support

* Added the Node helper presets for `undici` and raw `https`, but the first executions failed with `ENETUNREACH` before issuing any HTTP request because those clients bypassed the environment's `HTTP(S)_PROXY` settings that axios had been honouring implicitly.
* Captured the resulting traces (e.g. `/tmp/questrade-trace-undici.json` and `/tmp/questrade-trace-https.json`) to confirm the failures occurred prior to receiving any Cloudflare redirect, so no additional refresh tokens were consumed during these attempts.
* Next action: teach all Node helper transports to respect the same proxy configuration as axios so the alternate clients exercise the real endpoint.

### 2025-10-12 — Step 3 undici via proxy

* Introduced shared proxy-aware agent construction (via `proxy-from-env` and proxy agents) plus compressed-body decoding so axios, raw `https`, and `undici` all negotiate through the corporate proxy with identical TLS/cookie behaviour.
* Re-ran the helper with `python3 server/scripts/refresh_questrade_token.py --driver node --count 1 --node-client undici --trace /tmp/questrade-trace-undici.json`; this succeeded with HTTP 200 and reproduced the same cookie pattern as Python, confirming that undici can refresh tokens without encountering the 301 loop.
* The initial undici run failed to persist the rotated refresh token because the compressed JSON response was not decoded; fixed by adding gzip/deflate/brotli handling so future runs capture the new token. The successful call invalidated the stored refresh token, so the next experiment (raw `https` client) must wait for another fresh token before proceeding.

### 2025-10-12 — Step 3 raw https client

* After receiving a new refresh token, executed `python3 server/scripts/refresh_questrade_token.py --driver node --count 1 --node-client https --trace /tmp/questrade-trace-https.json`; the raw `https.request` implementation returned HTTP 200 on the first attempt and rotated the refresh token successfully.
* The raw client shared the same proxy, header, and cookie handling as undici, so the green result confirms that axios' redirect handling is the differentiator triggering Cloudflare's 301 loop.
* With both undici and raw `https` succeeding, the next action is to swap the production refresh path (`refreshAccessToken` and the CLI) to use the undici-based implementation and then validate `npm run print-total-pnl` end-to-end.

### 2025-10-12 — Step 3 implementation verification

* Replaced the server's `refreshAccessToken` flow with the undici-based client (matching the successful helper) and re-ran `npm run print-total-pnl -- --account 53413864`.
* The CLI now refreshes successfully on the first attempt (HTTP 200, rotated refresh token captured) instead of entering a 301 loop; subsequent account discovery failed with an upstream 503 timeout, confirming the remaining issue is unrelated to token refresh.
* Next step: gather additional diagnostics for the upstream 503 or retry once network conditions improve.

### 2025-10-12 — Step 4 POST refresh validation

* With a fresh refresh token, executed `python3 server/scripts/refresh_questrade_token.py --count 1` to confirm the baseline Python flow still succeeds and rotates the token.
* Ran the Node helper via `python3 server/scripts/refresh_questrade_token.py --driver node --node-client undici --node-method POST --count 1 --trace /tmp/questrade-trace-post-undici.json`; the POST exchange returned HTTP 200 on the first attempt, mirrored the Python cookie pattern, and persisted the rotated refresh token.
* Because both GET and POST succeed with the undici client, the remaining work shifts to addressing the downstream 503 surfaced during `print-total-pnl` rather than the refresh method itself. The next diagnostic step is to capture richer error context when the CLI requests `/v1/accounts`.

### 2025-10-12 — `/v1/accounts` diagnostics

* Added structured logging to `questradeRequest` and the CLI script so failures now include status, headers, and body previews.
* Running `npm run print-total-pnl -- --account 53413864` after the POST validation shows the refresh completes successfully but the first `/v1/accounts` call returns HTTP 503 from an Envoy proxy with message `upstream connect error or disconnect/reset before headers. reset reason: connection timeout`.
* The new telemetry confirms the refresh flow is healthy and the remaining blocker is an upstream connectivity or availability issue on the API server. Next step: decide whether to introduce retries/backoff for 503s or gather network-level diagnostics via the helper tooling.

### 2025-10-12 — `/v1/accounts` retry instrumentation

* Implemented exponential backoff and retry handling inside `questradeRequest` so 408/429/5xx responses and transient network errors automatically requeue with jittered delays instead of failing immediately.
* 401 responses now invalidate the cached token and repeat the call without consuming the retry budget, matching the manual workflow we verified with the helpers.
* Reran `npm run print-total-pnl -- --account 53413864`; the refresh succeeded, but `/v1/accounts` returned Envoy 503 on four successive attempts despite backoff, confirming the issue persists upstream.
* Next action: capture additional diagnostics (e.g., sequence of Envoy response headers across retries and comparison against the Python helper) to determine whether proxy routing differences remain after adopting undici.

### 2025-10-12 — `/v1/accounts` via undici client

* Replaced the axios-based Questrade REST helper with the same proxy-aware undici implementation used for token refreshes so API calls share identical headers, compression handling, and connection behaviour.
* Added undici-specific retryable error codes (e.g., `UND_ERR_CONNECT_TIMEOUT`) to the retry classifier so transient socket failures bubble into the exponential backoff pipeline instead of surfacing as hard failures.
* Updated the helper scaffolding to log JSON parsing issues from undici responses and to normalise headers for downstream rate-limit tracking.
* Next step: rerun `npm run print-total-pnl -- --account 53413864` to confirm whether the undici migration clears the Envoy 503 responses or if additional diagnostics are required.

### 2025-10-12 — FRED requests migrated to undici

* Identified that the remaining "Maximum number of redirects exceeded" failure came from the FRED USD/CAD rate lookups, where axios proxied calls bounced endlessly between Cloudflare redirects.
* Swapped the FRED observation fetchers to the shared undici client so proxy negotiation, redirect handling, and compression match the working Questrade flow.
* Captured full response telemetry—including redirect metadata—for both Questrade and FRED calls, confirming every request now returns HTTP 200 under the proxy.
* `npm run print-total-pnl -- --account 53413864` now completes successfully (with the existing `[FX]` timeout warning when a fallback provider stalls), producing the full Total P&L summary output.
