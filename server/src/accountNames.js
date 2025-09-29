const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_NAME = 'account-names.json';

const accountNamesFilePath = (() => {
  const configured = process.env.ACCOUNT_NAMES_FILE;
  if (!configured) {
    return path.join(process.cwd(), DEFAULT_FILE_NAME);
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.join(process.cwd(), configured);
})();

let cachedOverrides = {};
let cachedMarker = null;
let hasLoggedError = false;

function createMarker(stats) {
  if (!stats) {
    return null;
  }
  return String(stats.size) + ':' + String(stats.mtimeMs);
}

function isLikelyAccountKey(key) {
  if (key === undefined || key === null) {
    return false;
  }
  return /[0-9]/.test(String(key));
}

function applyOverride(target, key, label) {
  if (!key || !label) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedLabel = String(label).trim();
  if (!normalizedLabel) {
    return;
  }
  target[normalizedKey] = normalizedLabel;
}

function extractEntry(target, entry, fallbackKey) {
  if (entry === null || entry === undefined) {
    return;
  }
  if (typeof entry === 'string') {
    if (isLikelyAccountKey(fallbackKey)) {
      applyOverride(target, fallbackKey, entry);
    }
    return;
  }
  if (typeof entry !== 'object') {
    return;
  }

  const candidateKey =
    entry.number ?? entry.accountNumber ?? entry.id ?? entry.key ?? entry.accountId ?? fallbackKey;

  const candidateLabel =
    entry.name ??
    entry.displayName ??
    entry.label ??
    entry.title ??
    entry.value ??
    entry.nickname ??
    entry.alias;

  if (candidateKey !== undefined && candidateLabel !== undefined) {
    applyOverride(target, candidateKey, candidateLabel);
  } else if (isLikelyAccountKey(fallbackKey) && candidateLabel !== undefined) {
    applyOverride(target, fallbackKey, candidateLabel);
  }
}

function collectOverridesFromContainer(target, container) {
  if (!container) {
    return;
  }
  if (Array.isArray(container)) {
    container.forEach((entry) => {
      extractEntry(target, entry, undefined);
    });
    return;
  }
  if (typeof container !== 'object') {
    return;
  }
  Object.keys(container).forEach((key) => {
    const value = container[key];
    if (typeof value === 'string') {
      if (isLikelyAccountKey(key)) {
        applyOverride(target, key, value);
      }
      return;
    }
    extractEntry(target, value, key);
  });
}

function normalizeAccountNameOverrides(raw) {
  const overrides = {};
  if (!raw) {
    return overrides;
  }
  if (typeof raw !== 'object') {
    return overrides;
  }

  if (Array.isArray(raw)) {
    collectOverridesFromContainer(overrides, raw);
    return overrides;
  }

  collectOverridesFromContainer(overrides, raw);

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items'];
  nestedKeys.forEach((key) => {
    if (raw[key]) {
      collectOverridesFromContainer(overrides, raw[key]);
    }
  });

  return overrides;
}

function loadAccountNameOverrides() {
  if (!accountNamesFilePath) {
    cachedOverrides = {};
    cachedMarker = null;
    return cachedOverrides;
  }
  if (!fs.existsSync(accountNamesFilePath)) {
    cachedOverrides = {};
    cachedMarker = null;
    hasLoggedError = false;
    return cachedOverrides;
  }
  const stats = fs.statSync(accountNamesFilePath);
  const marker = createMarker(stats);
  if (marker && marker === cachedMarker) {
    return cachedOverrides;
  }
  const content = fs.readFileSync(accountNamesFilePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    cachedOverrides = {};
    cachedMarker = marker;
    hasLoggedError = false;
    return cachedOverrides;
  }
  const parsed = JSON.parse(content);
  cachedOverrides = normalizeAccountNameOverrides(parsed);
  cachedMarker = marker;
  hasLoggedError = false;
  return cachedOverrides;
}

function getAccountNameOverrides() {
  try {
    return loadAccountNameOverrides();
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account name overrides from ' + accountNamesFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedOverrides || {};
  }
}

module.exports = {
  getAccountNameOverrides,
  accountNamesFilePath,
};
