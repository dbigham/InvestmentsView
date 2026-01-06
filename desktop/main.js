const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

let mainWindow = null;
let serverProcess = null;
let serverPort = null;

function resolveServerRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server');
  }
  return path.resolve(__dirname, '..', 'server');
}

function resolveClientBuildDir() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'client')
    : path.resolve(__dirname, '..', 'client', 'dist');
  const indexPath = path.join(candidate, 'index.html');
  return fs.existsSync(indexPath) ? candidate : null;
}

function ensureDirExists(dirPath) {
  if (!dirPath) {
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferredPort) {
  const basePort = Number.isFinite(preferredPort) ? preferredPort : 4000;
  for (let offset = 0; offset < 20; offset += 1) {
    const candidate = basePort + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 10000 + Math.floor(Math.random() * 50000);
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to find an available port for the server.');
}

function normalizePort(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

async function resolveServerPort() {
  const requestedPort = normalizePort(
    process.env.ELECTRON_SERVER_PORT || process.env.INVESTMENTSVIEW_SERVER_PORT
  );
  if (requestedPort) {
    const available = await isPortAvailable(requestedPort);
    if (!available) {
      throw new Error(`Requested server port ${requestedPort} is already in use.`);
    }
    return requestedPort;
  }
  return findAvailablePort(4000);
}

function getClientOrigin(startUrl, port) {
  if (typeof startUrl === 'string') {
    try {
      const parsed = new URL(startUrl);
      if (parsed.origin && parsed.origin !== 'null') {
        return parsed.origin;
      }
    } catch (_) {
      // ignore
    }
  }
  return `http://localhost:${port}`;
}

function shouldOpenExternally(url, appOrigin) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return true;
    }
    if (appOrigin && parsed.origin === appOrigin) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function waitForHttpUrl(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for ${url}`));
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        return reject(error);
      }
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          timeout: 2000,
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            return resolve();
          }
          setTimeout(attempt, 300);
        }
      );
      req.on('error', () => setTimeout(attempt, 300));
      req.on('timeout', () => {
        req.destroy();
        setTimeout(attempt, 300);
      });
      return undefined;
    };
    attempt();
  });
}

function waitForServer(port, timeoutMs) {
  return waitForHttpUrl(`http://127.0.0.1:${port}/health`, timeoutMs);
}

function startServer(port, options) {
  const serverRoot = resolveServerRoot();
  const entryPath = path.join(serverRoot, 'src', 'index.js');
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: options.dataDir,
    CLIENT_ORIGIN: options.clientOrigin,
    INVESTMENTSVIEW_CLIENT_ORIGIN: options.clientOrigin,
    NODE_ENV: app.isPackaged ? 'production' : 'development',
  };
  if (options.clientBuildDir) {
    env.CLIENT_BUILD_DIR = options.clientBuildDir;
  }
  const child = spawn(process.execPath, [entryPath], {
    cwd: serverRoot,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    if (code !== null) {
      console.log(`Server process exited with code ${code}`);
      return;
    }
    if (signal) {
      console.log(`Server process exited with signal ${signal}`);
    }
  });
  return child;
}

async function createWindow() {
  serverPort = await resolveServerPort();
  const dataDir = path.join(app.getPath('userData'), 'data');
  ensureDirExists(dataDir);
  const clientBuildDir = resolveClientBuildDir();
  const startUrl = process.env.ELECTRON_START_URL || `http://localhost:${serverPort}/`;
  const clientOrigin = getClientOrigin(startUrl, serverPort);
  const appOrigin = clientOrigin;

  serverProcess = startServer(serverPort, { dataDir, clientBuildDir, clientOrigin });

  await waitForServer(serverPort, 60_000);
  if (typeof startUrl === 'string' && /^https?:/i.test(startUrl)) {
    await waitForHttpUrl(startUrl, 60_000).catch(() => undefined);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    backgroundColor: '#101014',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, appOrigin)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (shouldOpenExternally(url, appOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(startUrl);
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  serverProcess = null;
}

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      console.error('Failed to recreate window', error);
      app.quit();
    });
  }
});

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error('Failed to launch desktop app', error);
    app.quit();
  });
});
