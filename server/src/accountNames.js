const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_CANDIDATES = ['accounts.json', 'account-names.json'];

function resolveConfiguredFilePath() {
  const configured = process.env.ACCOUNTS_FILE || process.env.ACCOUNT_NAMES_FILE;
  if (configured) {
    if (path.isAbsolute(configured)) {
      return configured;
    }
    return path.join(process.cwd(), configured);
  }
  for (const name of DEFAULT_FILE_CANDIDATES) {
    const candidate = path.join(process.cwd(), name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(process.cwd(), DEFAULT_FILE_CANDIDATES[0]);
}

let resolvedFilePath = resolveConfiguredFilePath();
let cachedOverrides = {};
let cachedPortalOverrides = {};
let cachedOrdering = [];
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

function applyPortalOverride(target, key, portalId) {
  if (!key || !portalId) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedPortalId = String(portalId).trim();
  if (!normalizedPortalId) {
    return;
  }
  target[normalizedKey] = normalizedPortalId;
}

function recordOrdering(tracker, key) {
  if (!tracker) {
    return;
  }
  const normalizedKey = key == null ? '' : String(key).trim();
  if (!normalizedKey) {
    return;
  }
  if (tracker.seen.has(normalizedKey)) {
    return;
  }
  tracker.seen.add(normalizedKey);
  tracker.list.push(normalizedKey);
}

const ACCOUNT_ENTRY_HINT_KEYS = new Set([
  'name',
  'displayName',
  'label',
  'title',
  'value',
  'nickname',
  'alias',
  'number',
  'accountNumber',
  'accountId',
  'id',
  'key',
  'portalAccountId',
  'portalId',
  'portal',
  'portalUUID',
  'portalUuid',
  'uuid',
  'accountUuid',
  'summaryUuid',
]);

const PORTAL_ID_KEYS = [
  'portalAccountId',
  'portalId',
  'portal',
  'portalUUID',
  'portalUuid',
  'uuid',
  'accountUuid',
  'summaryUuid',
  'questradePortalId',
  'questradeAccountId',
];

function isLikelyAccountEntryObject(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  return Object.keys(entry).some((key) => ACCOUNT_ENTRY_HINT_KEYS.has(key));
}

function resolvePortalCandidate(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  for (const key of PORTAL_ID_KEYS) {
    if (entry[key] !== undefined && entry[key] !== null) {
      const candidate = String(entry[key]).trim();
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function extractEntry(namesTarget, portalTarget, entry, fallbackKey, orderingTracker) {
  if (entry === null || entry === undefined) {
    return;
  }
  if (typeof entry === 'string') {
    if (isLikelyAccountKey(fallbackKey)) {
      applyOverride(namesTarget, fallbackKey, entry);
      recordOrdering(orderingTracker, fallbackKey);
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

  const portalCandidate = resolvePortalCandidate(entry);

  const resolvedKey =
    candidateKey !== undefined && candidateKey !== null
      ? candidateKey
      : isLikelyAccountKey(fallbackKey)
      ? fallbackKey
      : undefined;

  if (candidateLabel !== undefined && resolvedKey !== undefined) {
    applyOverride(namesTarget, resolvedKey, candidateLabel);
  }

  if (portalCandidate) {
    if (resolvedKey !== undefined) {
      applyPortalOverride(portalTarget, resolvedKey, portalCandidate);
    }
  }

  if (resolvedKey !== undefined) {
    recordOrdering(orderingTracker, resolvedKey);
  }

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items', 'entries'];
  nestedKeys.forEach((key) => {
    if (entry[key]) {
      collectOverridesFromContainer(namesTarget, portalTarget, entry[key], orderingTracker);
    }
  });
}

function collectOverridesFromContainer(namesTarget, portalTarget, container, orderingTracker) {
  if (!container) {
    return;
  }
  if (Array.isArray(container)) {
    container.forEach((entry) => {
      extractEntry(namesTarget, portalTarget, entry, undefined, orderingTracker);
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
        applyOverride(namesTarget, key, value);
        recordOrdering(orderingTracker, key);
      }
      return;
    }
    if (isLikelyAccountKey(key) || isLikelyAccountEntryObject(value)) {
      extractEntry(namesTarget, portalTarget, value, key, orderingTracker);
      return;
    }
    collectOverridesFromContainer(namesTarget, portalTarget, value, orderingTracker);
  });
}

function normalizeAccountOverrides(raw) {
  const overrides = {};
  const portalOverrides = {};
  const orderingTracker = { list: [], seen: new Set() };
  if (!raw) {
    return { overrides, portalOverrides, ordering: orderingTracker.list };
  }
  if (typeof raw !== 'object') {
    return { overrides, portalOverrides, ordering: orderingTracker.list };
  }

  if (Array.isArray(raw)) {
    collectOverridesFromContainer(overrides, portalOverrides, raw, orderingTracker);
    return { overrides, portalOverrides, ordering: orderingTracker.list };
  }

  collectOverridesFromContainer(overrides, portalOverrides, raw, orderingTracker);

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items', 'entries'];
  nestedKeys.forEach((key) => {
    if (raw[key]) {
      collectOverridesFromContainer(overrides, portalOverrides, raw[key], orderingTracker);
    }
  });

  return { overrides, portalOverrides, ordering: orderingTracker.list };
}

function loadAccountOverrides() {
  const filePath = resolveConfiguredFilePath();
  if (filePath !== resolvedFilePath) {
    resolvedFilePath = filePath;
    cachedMarker = null;
  }
  if (!filePath) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedOrdering = [];
    cachedMarker = null;
    hasLoggedError = false;
    return { overrides: cachedOverrides, portalOverrides: cachedPortalOverrides, ordering: cachedOrdering };
  }
  if (!fs.existsSync(filePath)) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedOrdering = [];
    cachedMarker = null;
    hasLoggedError = false;
    return { overrides: cachedOverrides, portalOverrides: cachedPortalOverrides, ordering: cachedOrdering };
  }
  const stats = fs.statSync(filePath);
  const marker = createMarker(stats);
  if (marker && marker === cachedMarker) {
    return { overrides: cachedOverrides, portalOverrides: cachedPortalOverrides, ordering: cachedOrdering };
  }
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedOrdering = [];
    cachedMarker = marker;
    hasLoggedError = false;
    return { overrides: cachedOverrides, portalOverrides: cachedPortalOverrides, ordering: cachedOrdering };
  }
  const parsed = JSON.parse(content);
  const normalized = normalizeAccountOverrides(parsed);
  cachedOverrides = normalized.overrides;
  cachedPortalOverrides = normalized.portalOverrides;
  cachedOrdering = normalized.ordering || [];
  cachedMarker = marker;
  hasLoggedError = false;
  return { overrides: cachedOverrides, portalOverrides: cachedPortalOverrides, ordering: cachedOrdering };
}

function getAccountNameOverrides() {
  try {
    return loadAccountOverrides().overrides;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedOverrides || {};
  }
}

function getAccountPortalOverrides() {
  try {
    return loadAccountOverrides().portalOverrides;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedPortalOverrides || {};
  }
}

function getAccountOrdering() {
  try {
    return loadAccountOverrides().ordering || [];
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedOrdering || [];
  }
}

module.exports = {
  getAccountNameOverrides,
  getAccountPortalOverrides,
  getAccountOrdering,
  get accountNamesFilePath() {
    return resolvedFilePath;
  },
};
