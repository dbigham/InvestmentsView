# Stopping Background Servers (Port Conflicts)

This guide documents a reliable, repeatable procedure to find and stop any background server processes (e.g., Node servers) that keep ports busy (like `4000` for the API or `5173` for the client).

Use this when you can launch the UI but cannot start your server because the port is already in use.

## Preferred Strategy (order)

1. Kill by PID file if present.
2. Terminate any listeners on the target port(s) (e.g., `4000`, `5173`).
3. Kill Node/NPM/Nodemon processes whose command line matches this repo/server entry point.
4. Stop background jobs created by prior sessions.
5. Verify with a health check and a port scan.

## Windows PowerShell commands

Replace ports as needed (e.g., `4000`, `5173`). All commands are safe to copy‑paste.

### 1) Kill by PID file (recommended when available)

```powershell
# Server
Get-Content server\server-pid.txt | ForEach-Object { Stop-Process -Id $_ -Force }

# Client (optional)
Get-Content client\client-pid.txt | ForEach-Object { Stop-Process -Id $_ -Force }
```

### 2) Kill anything listening on a port

```powershell
# Prefer Get-NetTCPConnection (IPv4/IPv6)
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue |
  Select-Object -Unique OwningProcess |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# Fallback via netstat if needed
netstat -ano | findstr :4000
# Take the last column (PID) from each matching line, then:
Stop-Process -Id <PID> -Force
```

### 3) Kill Node/NPM/Nodemon processes for this repo/server

This is safer than killing all `node.exe`; it targets only the processes that reference this project or its entry point.

```powershell
# Node processes running the server entry
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\\src\\index\.js' -or $_.CommandLine -match 'Investments View' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Also catch wrappers launching node (npm/nodemon/cmd)
Get-CimInstance Win32_Process |
  Where-Object { ($_.Name -match 'npm|nodemon|cmd') -and ($_.CommandLine -match 'server\\src\\index\.js') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 4) Stop background jobs

```powershell
Get-Job | Stop-Job -Force; Get-Job | Remove-Job -Force
```

### 5) Verify everything is stopped

```powershell
# Health check should fail when server is stopped
try { Invoke-RestMethod http://localhost:4000/health -TimeoutSec 2 | Out-Null; 'SERVER_RUNNING' } catch { 'NO_SERVER' }

# No listeners should remain
Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count
netstat -ano | findstr :4000
```

## Cross‑platform alternatives

macOS / Linux:

```bash
# Find and kill listener on port 4000
lsof -i :4000
kill -9 <PID>

# One‑liner alternatives
fuser -k 4000/tcp
# or
ss -ltnp | grep ':4000'
```

WSL (if you suspect the server is inside WSL):

```powershell
wsl.exe -- netstat -tulpen | grep :4000
wsl.exe -- fuser -k 4000/tcp
```

## PID‑file workflow (recommended)

Starting servers with PID files makes cleanup deterministic.

```powershell
# Start server (background) and record PID
$p = Start-Process node -ArgumentList 'src/index.js' -WorkingDirectory server -WindowStyle Hidden -PassThru
$p.Id | Out-File server\server-pid.txt -Encoding ascii

# Later, stop by PID file
Get-Content server\server-pid.txt | ForEach-Object { Stop-Process -Id $_ -Force }
```

Consider keeping a separate PID file for the client (e.g., `client\client-pid.txt`) if you frequently need to free that port too.

## Tips for precise requests

When asking an assistant to stop servers, specify:

- The port(s) to free (e.g., `4000`, `5173`).
- The entry point to match (e.g., `server\src\index.js`).
- Whether to kill by PID file first.
- Whether to terminate background jobs as well.

Example: “Kill by PID file, then kill any listeners on 4000, then terminate any process whose command line contains `server\src\index.js`, and verify no listener remains.”

