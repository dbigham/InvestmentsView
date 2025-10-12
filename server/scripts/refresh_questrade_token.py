#!/usr/bin/env python3
"""Manual helper to refresh Questrade OAuth tokens with verbose logging."""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

try:
    import requests
except ImportError as exc:  # pragma: no cover - guidance for operators
    sys.stderr.write(
        "This script requires the 'requests' package. Install it with 'pip install requests' and rerun.\n"
    )
    raise

TOKEN_STORE_PATH = Path(__file__).resolve().parents[1] / "token-store.json"
TOKEN_URL = "https://login.questrade.com/oauth2/token"
MAX_REDIRECTS = 5
SESSION_PRESETS = {"python", "node"}
DRIVERS = {"requests", "node"}


def expand_path(path: str | None) -> str | None:
    if not path:
        return None
    return os.path.abspath(os.path.expanduser(path))


def mask_token(token: str) -> str:
    if not token or not isinstance(token, str):
        return "<missing>"
    if len(token) <= 8:
        return token
    return f"{token[:4]}…{token[-4:]}"


def load_token_store() -> dict:
    if not TOKEN_STORE_PATH.exists():
        raise SystemExit(f"token-store.json not found at {TOKEN_STORE_PATH}")
    with TOKEN_STORE_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def persist_token_store(payload: dict) -> None:
    with TOKEN_STORE_PATH.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=False)
        handle.write("\n")


def find_login(store: dict, login_id: str | None) -> dict:
    logins = store.get("logins") or []
    if login_id:
        for login in logins:
            if str(login.get("id")) == login_id:
                return login
        raise SystemExit(f"Login with id '{login_id}' not found in token-store.json")
    if not logins:
        raise SystemExit("token-store.json does not include any logins")
    return logins[0]


def refresh_once(session: requests.Session, refresh_token: str) -> requests.Response:
    current_url = TOKEN_URL
    params = {"grant_type": "refresh_token", "refresh_token": refresh_token}

    for attempt in range(MAX_REDIRECTS + 1):
        cookie_header = session.cookies.get_dict()
        print(
            f"[python-refresh] Attempt {attempt + 1}: GET {current_url}",
            {
                "params": list(params.keys()) if params else [],
                "cookies": sorted(cookie_header.keys()),
            },
        )
        response = session.get(current_url, params=params, allow_redirects=False)
        location = response.headers.get("location")
        set_cookies = response.headers.get("set-cookie")
        cookie_names = []
        if set_cookies:
            cookie_names = [part.split("=", 1)[0].strip() for part in set_cookies.split(",") if part]
        print(
            f"[python-refresh] Attempt {attempt + 1} status {response.status_code}",
            {"location": location, "setCookies": cookie_names},
        )
        if 300 <= response.status_code < 400 and location:
            current_url = urljoin(current_url, location)
            params = None
            continue
        return response
    raise RuntimeError("Exceeded maximum redirect attempts during refresh")


def update_login_refresh_token(store: dict, login: dict, new_token: str) -> None:
    if not new_token:
        return
    if login.get("refreshToken") == new_token:
        return
    print(
        "[python-refresh] Persisting new refresh token",
        mask_token(login.get("refreshToken")),
        "→",
        mask_token(new_token),
    )
    login["refreshToken"] = new_token
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    login["updatedAt"] = store["updatedAt"] = timestamp
    persist_token_store(store)


def perform_refreshes(
    login_id: str | None,
    iterations: int,
    preset: str,
    driver: str,
    *,
    trace_path: str | None = None,
    node_method: str | None = None,
    node_client: str | None = None,
    node_keepalive: bool | None = None,
    node_connection_close: bool = False,
    node_tls_min: str | None = None,
    node_tls_max: str | None = None,
    node_tls_ciphers: str | None = None,
    node_headers: dict[str, str] | None = None,
) -> None:
    store = load_token_store()
    login = find_login(store, login_id)
    token = login.get("refreshToken")
    if not token:
        raise SystemExit("Selected login does not include a refreshToken field")

    print(
        "[python-refresh] Starting",
        {"loginId": login.get("id"), "label": login.get("label"), "token": mask_token(token)},
    )

    driver_key = driver.lower().strip()
    if driver_key not in DRIVERS:
        raise SystemExit(f"Unsupported driver '{driver}'. Expected one of: {sorted(DRIVERS)}")

    if driver_key == "node":
        perform_refreshes_with_node_driver(
            store,
            login,
            token,
            iterations,
            trace_path=trace_path,
            method=node_method,
            client=node_client,
            keepalive=node_keepalive,
            connection_close=node_connection_close,
            tls_min=node_tls_min,
            tls_max=node_tls_max,
            tls_ciphers=node_tls_ciphers,
            headers=node_headers,
        )
        return

    session = build_session(preset)

    for index in range(iterations):
        print(f"[python-refresh] === Refresh cycle {index + 1} of {iterations} ===")
        response = refresh_once(session, token)
        if response.status_code != 200:
            print(
                "[python-refresh] Refresh failed",
                {"status": response.status_code, "body": response.text[:500]},
            )
            response.raise_for_status()
        payload = response.json()
        print(
            "[python-refresh] Success",
            {
                "apiServer": payload.get("api_server"),
                "expiresIn": payload.get("expires_in"),
                "newRefreshToken": mask_token(payload.get("refresh_token")),
            },
        )
        if payload.get("refresh_token"):
            update_login_refresh_token(store, login, payload["refresh_token"])
            token = payload["refresh_token"]

    print("[python-refresh] All refresh cycles completed")


def perform_refreshes_with_node_driver(
    store: dict,
    login: dict,
    token: str,
    iterations: int,
    *,
    trace_path: str | None = None,
    method: str | None = None,
    client: str | None = None,
    keepalive: bool | None = None,
    connection_close: bool = False,
    tls_min: str | None = None,
    tls_max: str | None = None,
    tls_ciphers: str | None = None,
    headers: dict[str, str] | None = None,
) -> None:
    script_path = Path(__file__).with_name("refresh_questrade_token_node.js")
    if not script_path.exists():
        raise SystemExit(f"Node helper not found at {script_path}")

    config: dict[str, object] = {
        "method": method,
        "tracePath": trace_path,
        "client": client,
    }

    connection: dict[str, object] = {}
    if keepalive is not None:
        connection["keepAlive"] = keepalive
    if connection_close:
        connection["connectionClose"] = True
    if connection:
        config["connection"] = connection

    tls: dict[str, object] = {}
    if tls_min:
        tls["minVersion"] = tls_min
    if tls_max:
        tls["maxVersion"] = tls_max
    if tls_ciphers:
        tls["ciphers"] = tls_ciphers
    if tls:
        config["tls"] = tls

    if headers:
        config["headers"] = headers

    payload = {
        "refreshToken": token,
        "iterations": iterations,
    }

    cleaned_config = {key: value for key, value in config.items() if value is not None}
    if cleaned_config:
        payload["config"] = cleaned_config

    command = [
        "node",
        str(script_path),
        json.dumps(payload),
    ]

    print("[python-refresh] Invoking Node driver", command)
    result = subprocess.run(command, capture_output=True, text=True, check=False)

    if result.stderr:
        sys.stderr.write(result.stderr)

    stdout = result.stdout.strip()
    if not stdout:
        raise SystemExit("Node driver did not return any output")

    try:
        response = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Failed to parse Node driver output: {stdout}") from exc

    if result.returncode != 0 or not response.get("success"):
        status = response.get("status")
        body = response.get("body")
        message = response.get("error")
        raise SystemExit(
            "Node driver failed"
            + (f" with status {status}" if status else "")
            + (f": {message}" if message else "")
            + (f" body={body}" if body else "")
        )

    results = response.get("results") or []
    for entry in results:
        new_token = entry.get("refreshToken")
        if new_token:
            update_login_refresh_token(store, login, new_token)
            token = new_token

    print("[python-refresh] Node driver completed", {"iterations": iterations, "finalToken": mask_token(token)})


def build_session(preset: str) -> requests.Session:
    preset_key = preset.lower().strip()
    if preset_key not in SESSION_PRESETS:
        raise SystemExit(f"Unsupported session preset '{preset}'. Expected one of: {sorted(SESSION_PRESETS)}")

    session = requests.Session()

    if preset_key == "node":
        session.headers.clear()
        session.headers.update(
            {
                "User-Agent": "python-requests/2.32.5",
                "Accept": "application/json, text/plain, */*",
                "Connection": "close",
                "Accept-Encoding": "gzip, compress, deflate, br",
            }
        )
    else:
        # Normal requests defaults, but align the User-Agent string so both
        # flows present the same identity to Questrade.
        session.headers["User-Agent"] = "python-requests/2.32.5"

    print("[python-refresh] Session headers", dict(session.headers))

    return session


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manually refresh Questrade OAuth tokens")
    parser.add_argument("--login", dest="login_id", help="Optional login id to refresh")
    parser.add_argument(
        "--count",
        dest="count",
        type=int,
        default=1,
        help="Number of successive refreshes to perform (default: 1)",
    )
    parser.add_argument(
        "--preset",
        dest="preset",
        default="python",
        help="HTTP header preset to use (python or node). Default: python",
    )
    parser.add_argument(
        "--driver",
        dest="driver",
        default="requests",
        help="HTTP implementation to use: 'requests' (default) or 'node'",
    )
    parser.add_argument(
        "--trace",
        dest="trace_path",
        help="Optional path to write a Node driver redirect trace (Node driver only)",
    )
    parser.add_argument(
        "--node-method",
        dest="node_method",
        help="HTTP method for the Node driver refresh request (default: GET)",
    )
    parser.add_argument(
        "--node-client",
        dest="node_client",
        help="HTTP client implementation for the Node driver (e.g., axios, undici, https)",
    )
    parser.add_argument(
        "--node-keepalive",
        dest="node_keepalive",
        choices=["true", "false"],
        help="Override the Node driver's keepAlive agent setting",
    )
    parser.add_argument(
        "--node-connection-close",
        dest="node_connection_close",
        action="store_true",
        help="Send 'Connection: close' on Node driver requests",
    )
    parser.add_argument(
        "--node-tls-min",
        dest="node_tls_min",
        help="Set Node HTTPS agent minimum TLS version (e.g., TLSv1.2)",
    )
    parser.add_argument(
        "--node-tls-max",
        dest="node_tls_max",
        help="Set Node HTTPS agent maximum TLS version",
    )
    parser.add_argument(
        "--node-tls-ciphers",
        dest="node_tls_ciphers",
        help="Override Node HTTPS agent cipher list",
    )
    parser.add_argument(
        "--node-header",
        dest="node_headers",
        action="append",
        help="Additional header for Node driver in 'Key: Value' format. Can be repeated.",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.count <= 0:
        raise SystemExit("--count must be >= 1")
    node_headers: dict[str, str] | None = None
    if args.node_headers:
        node_headers = {}
        for header in args.node_headers:
            if not header or header.strip() == "":
                continue
            if ":" not in header:
                raise SystemExit(
                    "--node-header values must be in 'Key: Value' format"
                )
            key, value = header.split(":", 1)
            node_headers[key.strip()] = value.strip()

    node_keepalive: bool | None = None
    if args.node_keepalive is not None:
        node_keepalive = args.node_keepalive.lower() == "true"

    perform_refreshes(
        args.login_id,
        args.count,
        args.preset,
        args.driver,
        trace_path=expand_path(args.trace_path),
        node_method=args.node_method,
        node_client=args.node_client,
        node_keepalive=node_keepalive,
        node_connection_close=args.node_connection_close,
        node_tls_min=args.node_tls_min,
        node_tls_max=args.node_tls_max,
        node_tls_ciphers=args.node_tls_ciphers,
        node_headers=node_headers,
    )


if __name__ == "__main__":
    main(sys.argv[1:])
