# Installation

## Desktop app (Windows)

The desktop build bundles the Express server and the React client, so end users do not need Node.js.

### Build the installer

From the repo root:

```bash
npm run desktop:build
```

The NSIS installer will be created in `desktop/dist/`. Run the `.exe` to install.

### Run the app

Launch "Investments View" from the Start Menu or desktop shortcut. The app starts the local server automatically.

## Data storage

Persistent data (refresh tokens, account metadata, demo flags, caches) is stored in the Electron user data directory:

- Windows: `C:\Users\<you>\AppData\Roaming\Investments View\data\`
- macOS: `~/Library/Application Support/Investments View/data/`
- Linux: `~/.config/Investments View/data/`

The server also supports a custom data location via `DATA_DIR` (or `INVESTMENTSVIEW_DATA_DIR`) for developer workflows.

## Uninstall

1. Uninstall "Investments View" via Windows Apps & Features.
2. Remove the data directory if you want to wipe saved tokens and metadata:
   - `C:\Users\<you>\AppData\Roaming\Investments View\data\`

## Troubleshooting

- Port conflict: the desktop app defaults to port 4000 and automatically falls back if it is busy. If the UI fails to load, try closing other local servers or rebooting.
- Antivirus false positives: Electron installers are occasionally flagged. If needed, whitelist the installer and the installed app folder.
- Blank window in dev: ensure the Vite dev server is running on `http://localhost:5173` when using `npm run desktop:dev`.

## Docker (bonus)

### Build and run

```bash
docker compose up --build
```

The app will be available at `http://localhost:4000/`.

### Data persistence

Docker uses a named volume mounted at `/app/data` for persisted tokens and metadata. To reset the app state, remove the volume:

```bash
docker compose down -v
```
