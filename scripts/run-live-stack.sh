#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
SERVER_DIR="$ROOT_DIR/server"
CLIENT_DIR="$ROOT_DIR/client"
CLIENT_ORIGIN_DEFAULT="http://localhost:5173"

print_usage() {
  cat <<'USAGE'
Usage: scripts/run-live-stack.sh [options]

Bootstraps the InvestmentsView dev stack (Express proxy + Vite frontend)
against live Questrade APIs so you can capture account screenshots.
The script installs dependencies if required, seeds refresh tokens,
launches both servers, and waits until they are reachable.

Options:
  --fred-key <key>           FRED API key to write into server/.env when the
                             file is missing. If the file already exists the
                             value is not overwritten.
  --client-origin <origin>   Origin to write into server/.env (default:
                             $CLIENT_ORIGIN_DEFAULT).
  --refresh-token <token>    Questrade refresh token to seed via
                             `npm run seed-token`. If omitted the script
                             assumes server/token-store.json already contains
                             a valid token.
  --login-id <id>            Identifier used by the seed script (default: daniel).
  --label <label>            Human readable label for the seed script
                             (default: daniel.bigham@gmail.com).
  --email <email>            Email for the seed script
                             (default: daniel.bigham@gmail.com).
  --skip-install             Skip running npm install in the server and client
                             directories.
  --no-frontend              Launch only the backend proxy.
  --no-backend               Launch only the frontend (requires an already
                             running proxy).
  --screenshot <path>        Capture a full-page screenshot using Playwright
                             after the frontend becomes reachable. Requires
                             Playwright to be installed (the script will run
                             `npx playwright install --with-deps` on first use).
  -h, --help                 Show this help message and exit.

Examples:
  FRED_API_KEY=abc REFRESH_TOKEN=def scripts/run-live-stack.sh
  scripts/run-live-stack.sh --fred-key abc --refresh-token def \
    --screenshot resp.png

Environment variables:
  FRED_API_KEY           Alternative way to provide --fred-key.
  REFRESH_TOKEN          Alternative way to provide --refresh-token.
  CLIENT_ORIGIN          Alternative way to provide --client-origin.

The script leaves both dev servers running in the foreground. Press Ctrl+C to
stop them. When the script exits it terminates any background processes it
spawned.
USAGE
}

# Default values
FRED_KEY="${FRED_API_KEY:-}"
CLIENT_ORIGIN="${CLIENT_ORIGIN:-$CLIENT_ORIGIN_DEFAULT}"
REFRESH_TOKEN="${REFRESH_TOKEN:-}"
LOGIN_ID="daniel"
LABEL="daniel.bigham@gmail.com"
EMAIL="daniel.bigham@gmail.com"
RUN_INSTALL=true
START_BACKEND=true
START_FRONTEND=true
SCREENSHOT_PATH=""

# Argument parsing
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fred-key)
      FRED_KEY="$2"; shift 2 ;;
    --client-origin)
      CLIENT_ORIGIN="$2"; shift 2 ;;
    --refresh-token)
      REFRESH_TOKEN="$2"; shift 2 ;;
    --login-id)
      LOGIN_ID="$2"; shift 2 ;;
    --label)
      LABEL="$2"; shift 2 ;;
    --email)
      EMAIL="$2"; shift 2 ;;
    --skip-install)
      RUN_INSTALL=false; shift ;;
    --no-frontend)
      START_FRONTEND=false; shift ;;
    --no-backend)
      START_BACKEND=false; shift ;;
    --screenshot)
      SCREENSHOT_PATH="$2"; shift 2 ;;
    -h|--help)
      print_usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 1 ;;
  esac
done

if [[ "$START_BACKEND" == false && "$START_FRONTEND" == false ]]; then
  echo "Nothing to do: both backend and frontend are disabled." >&2
  exit 1
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command '$1'. Please install it before continuing." >&2
    exit 1
  fi
}

ensure_env_file() {
  local env_path="$SERVER_DIR/.env"
  if [[ -f "$env_path" ]]; then
    return
  fi
  if [[ -z "$FRED_KEY" ]]; then
    echo "server/.env is missing. Provide --fred-key or set FRED_API_KEY." >&2
    exit 1
  fi
  cat >"$env_path" <<EOF_ENV
CLIENT_ORIGIN=$CLIENT_ORIGIN
PORT=4000
FRED_API_KEY=$FRED_KEY
EOF_ENV
  echo "Created server/.env with CLIENT_ORIGIN=$CLIENT_ORIGIN"
}

run_npm_install() {
  local dir="$1"
  if [[ "$RUN_INSTALL" == true ]]; then
    echo "Installing npm dependencies in $dir"
    (cd "$dir" && npm install)
  else
    echo "Skipping npm install in $dir"
  fi
}

seed_refresh_token() {
  if [[ -z "$REFRESH_TOKEN" ]]; then
    return
  fi
  echo "Seeding refresh token for login '$LOGIN_ID'"
  (cd "$SERVER_DIR" && npm run seed-token -- "$REFRESH_TOKEN" --id="$LOGIN_ID" --label="$LABEL" --email="$EMAIL")
}

wait_for_tcp() {
  local host_port="$1"
  local timeout="${2:-60}"
  node <<NODE
const net = require('net');
const [host, port] = '$host_port'.split(':');
const deadline = Date.now() + (${timeout} * 1000);

function attempt() {
  const socket = new net.Socket();
  socket.setTimeout(2000);
  socket.once('connect', () => {
    socket.destroy();
    process.exit(0);
  });
  socket.once('timeout', () => socket.destroy());
  socket.once('error', () => socket.destroy());
  socket.once('close', () => {
    if (Date.now() > deadline) {
      console.error(`Timed out waiting for ${host}:${port}`);
      process.exit(1);
    }
    setTimeout(attempt, 500);
  });
  socket.connect(port, host);
}

attempt();
NODE
}

capture_screenshot() {
  if [[ -z "$SCREENSHOT_PATH" ]]; then
    return
  fi
  require_command npx
  echo "Ensuring Playwright browser binaries are installed"
  npx --yes playwright install --with-deps >/dev/null
  echo "Capturing screenshot to $SCREENSHOT_PATH"
  npx --yes playwright screenshot --device="Desktop Chrome" --wait-for-timeout=5000 \
    --full-page --output="$SCREENSHOT_PATH" "${CLIENT_ORIGIN%/}/"
  echo "Screenshot saved to $SCREENSHOT_PATH"
}

main() {
  require_command node
  require_command npm

  ensure_env_file

  if [[ "$START_BACKEND" == true ]]; then
    run_npm_install "$SERVER_DIR"
  fi
  if [[ "$START_FRONTEND" == true ]]; then
    run_npm_install "$CLIENT_DIR"
  fi

  seed_refresh_token

  BACKEND_PID=""
  FRONTEND_PID=""

  cleanup() {
    local exit_code=$?
    if [[ -n "$FRONTEND_PID" ]]; then
      echo "Stopping frontend (pid $FRONTEND_PID)"
      kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    if [[ -n "$BACKEND_PID" ]]; then
      echo "Stopping backend (pid $BACKEND_PID)"
      kill "$BACKEND_PID" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
    exit "$exit_code"
  }
  trap cleanup EXIT INT TERM

  if [[ "$START_BACKEND" == true ]]; then
    echo "Starting backend proxy on http://localhost:4000"
    (cd "$SERVER_DIR" && npm run dev) &
    BACKEND_PID=$!
    wait_for_tcp "127.0.0.1:4000" 90
    echo "Backend proxy is ready"
  fi

  if [[ "$START_FRONTEND" == true ]]; then
    echo "Starting frontend on $CLIENT_ORIGIN"
    (cd "$CLIENT_DIR" && npm run dev -- --host) &
    FRONTEND_PID=$!
    wait_for_tcp "127.0.0.1:5173" 90
    echo "Frontend dev server is ready"
  fi

  if [[ -n "$SCREENSHOT_PATH" ]]; then
    capture_screenshot
  fi

  echo "\nServers are running. Use the URLs below to load the RESP dashboard:"
  if [[ "$START_FRONTEND" == true ]]; then
    echo "  Frontend: ${CLIENT_ORIGIN%/}/"
  fi
  if [[ "$START_BACKEND" == true ]]; then
    echo "  Backend API base: http://localhost:4000"
    echo "  Example sanity check: curl http://localhost:4000/api/summary"
  fi
  echo "\nPress Ctrl+C when you are finished to stop both services."

  wait
}

main "$@"
