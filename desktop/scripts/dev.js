const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const clientDir = path.join(rootDir, 'client');
const desktopDir = path.join(rootDir, 'desktop');
const npmCommand = 'npm';

function buildCommand(command, args) {
  if (process.platform === 'win32') {
    const joined = [command, ...(args || [])].join(' ');
    return { command: joined, args: [], options: { shell: true } };
  }
  return { command, args: args || [], options: {} };
}

function runCommandSync(command, args, cwd) {
  const built = buildCommand(command, args);
  const result = spawnSync(built.command, built.args, {
    cwd,
    stdio: 'inherit',
    ...built.options,
  });
  if (result.status !== 0) {
    if (result.error) {
      console.error('Failed to run command:', result.error.message);
    }
    process.exit(result.status || 1);
  }
}

function startProcess(command, args, options) {
  const built = buildCommand(command, args);
  return spawn(built.command, built.args, {
    stdio: 'inherit',
    ...built.options,
    ...options,
  });
}

function resolveElectronBinary() {
  const binName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  return path.join(desktopDir, 'node_modules', '.bin', binName);
}

function ensureDesktopDependencies() {
  if (fs.existsSync(resolveElectronBinary())) {
    return;
  }
  console.log('Installing desktop dependencies...');
  runCommandSync(npmCommand, ['install'], desktopDir);
}

let clientProcess = null;
let electronProcess = null;
let isShuttingDown = false;
let resolvedDevServerUrl = null;
let serverPort = null;

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

function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill();
  }
  if (clientProcess && !clientProcess.killed) {
    clientProcess.kill();
  }
}

function normalizeDevServerUrl(url) {
  if (!url) {
    return null;
  }
  const trimmed = String(url).trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function parseDevServerUrl(text) {
  if (!text) {
    return null;
  }
  const cleaned = String(text).replace(/\u001b\[[0-9;]*m/g, '');
  const match = cleaned.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/);
  return match ? match[0] : null;
}

function startElectron(devServerUrl) {
  if (electronProcess) {
    return;
  }
  const normalizedUrl = normalizeDevServerUrl(devServerUrl);
  if (!normalizedUrl) {
    return;
  }
  console.log(`Starting Electron with ${normalizedUrl}`);
  electronProcess = startProcess(npmCommand, ['run', 'dev'], {
    cwd: desktopDir,
    env: {
      ...process.env,
      ELECTRON_SERVER_PORT: serverPort ? String(serverPort) : undefined,
      ELECTRON_START_URL: normalizedUrl,
    },
  });
  electronProcess.on('error', (error) => {
    console.error('Failed to start Electron:', error.message);
    shutdown();
  });
  electronProcess.on('exit', shutdown);
}

function pipeViteOutput(stream, outputStream) {
  stream.on('data', (chunk) => {
    const text = chunk.toString();
    outputStream.write(text);
    const foundUrl = parseDevServerUrl(text);
    if (foundUrl && !resolvedDevServerUrl) {
      resolvedDevServerUrl = normalizeDevServerUrl(foundUrl);
      startElectron(resolvedDevServerUrl);
    }
  });
}

function startClient() {
  clientProcess = startProcess(npmCommand, ['run', 'dev'], {
    cwd: clientDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_API_BASE_URL: serverPort ? `http://localhost:${serverPort}` : undefined,
    },
  });
  pipeViteOutput(clientProcess.stdout, process.stdout);
  pipeViteOutput(clientProcess.stderr, process.stderr);
  clientProcess.on('exit', shutdown);
}

ensureDesktopDependencies();

const explicitStartUrl = normalizeDevServerUrl(process.env.ELECTRON_START_URL);
if (explicitStartUrl) {
  startElectron(explicitStartUrl);
}

findAvailablePort(4000)
  .then((port) => {
    serverPort = port;
    console.log(`Using server port ${serverPort} for desktop dev.`);
    startClient();
  })
  .catch((error) => {
    console.error('Failed to select server port:', error.message);
    process.exit(1);
  });

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
