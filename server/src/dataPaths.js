const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..');

function resolveDataDir() {
  const raw = process.env.DATA_DIR || process.env.INVESTMENTSVIEW_DATA_DIR;
  if (!raw) {
    return DEFAULT_DATA_DIR;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return DEFAULT_DATA_DIR;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(process.cwd(), trimmed);
}

function resolveDataPath(...segments) {
  return path.join(resolveDataDir(), ...segments);
}

function resolveCachePath(...segments) {
  return resolveDataPath('.cache', ...segments);
}

module.exports = {
  resolveCachePath,
  resolveDataDir,
  resolveDataPath,
};
