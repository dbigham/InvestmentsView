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
let cachedChatOverrides = {};
let cachedSettings = {};
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

function coerceBoolean(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['true', 'yes', 'on', '1'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', 'off', '0'].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function applyShowDetailsSetting(target, key, value) {
  if (!target || !key) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const resolved = coerceBoolean(value);
  if (resolved === null) {
    return;
  }
  target[normalizedKey] = resolved;
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
  'chatURL',
  'chatUrl',
  'showQQQDetails',
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

const CHAT_URL_KEYS = ['chatURL', 'chatUrl'];

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

function applyChatOverride(target, key, url) {
  if (!target) {
    return;
  }
  if (!key || !url) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedUrl = String(url).trim();
  if (!normalizedUrl) {
    return;
  }
  target[normalizedKey] = normalizedUrl;
}

function resolveChatCandidate(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  for (const key of CHAT_URL_KEYS) {
    if (entry[key] !== undefined && entry[key] !== null) {
      const candidate = String(entry[key]).trim();
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function extractEntry(namesTarget, portalTarget, chatTarget, settingsTarget, entry, fallbackKey, orderingTracker) {
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
  const chatCandidate = resolveChatCandidate(entry);

  const resolvedKey =
    candidateKey !== undefined && candidateKey !== null
      ? candidateKey
      : isLikelyAccountKey(fallbackKey)
      ? fallbackKey
      : undefined;

  if (candidateLabel !== undefined && resolvedKey !== undefined) {
    applyOverride(namesTarget, resolvedKey, candidateLabel);
  }

  if (portalCandidate && resolvedKey !== undefined) {
    applyPortalOverride(portalTarget, resolvedKey, portalCandidate);
  }

  if (chatCandidate && resolvedKey !== undefined) {
    applyChatOverride(chatTarget, resolvedKey, chatCandidate);
  }

  if (settingsTarget && resolvedKey !== undefined) {
    if (Object.prototype.hasOwnProperty.call(entry, 'showQQQDetails')) {
      applyShowDetailsSetting(settingsTarget, resolvedKey, entry.showQQQDetails);
    }
  }

  if (resolvedKey !== undefined) {
    recordOrdering(orderingTracker, resolvedKey);
  }

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items', 'entries'];
  nestedKeys.forEach((key) => {
    if (entry[key]) {
      collectOverridesFromContainer(namesTarget, portalTarget, chatTarget, settingsTarget, entry[key], orderingTracker);
    }
  });
}

function collectOverridesFromContainer(namesTarget, portalTarget, chatTarget, settingsTarget, container, orderingTracker) {
  if (!container) {
    return;
  }
  if (Array.isArray(container)) {
    container.forEach((entry) => {
      extractEntry(namesTarget, portalTarget, chatTarget, settingsTarget, entry, undefined, orderingTracker);
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
      extractEntry(namesTarget, portalTarget, chatTarget, settingsTarget, value, key, orderingTracker);
      return;
    }
    collectOverridesFromContainer(namesTarget, portalTarget, chatTarget, settingsTarget, value, orderingTracker);
  });
}

function normalizeAccountOverrides(raw) {
  const overrides = {};
  const portalOverrides = {};
  const chatOverrides = {};
  const settings = {};
  const orderingTracker = { list: [], seen: new Set() };
  if (!raw) {
    return { overrides, portalOverrides, chatOverrides, settings, ordering: orderingTracker.list };
  }
  if (typeof raw !== 'object') {
    return { overrides, portalOverrides, chatOverrides, settings, ordering: orderingTracker.list };
  }

  if (Array.isArray(raw)) {
    collectOverridesFromContainer(overrides, portalOverrides, chatOverrides, settings, raw, orderingTracker);
    return { overrides, portalOverrides, chatOverrides, settings, ordering: orderingTracker.list };
  }

  collectOverridesFromContainer(overrides, portalOverrides, chatOverrides, settings, raw, orderingTracker);

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items', 'entries'];
  nestedKeys.forEach((key) => {
    if (raw[key]) {
      collectOverridesFromContainer(overrides, portalOverrides, chatOverrides, settings, raw[key], orderingTracker);
    }
  });

  return { overrides, portalOverrides, chatOverrides, settings, ordering: orderingTracker.list };
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
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedMarker = null;
    hasLoggedError = false;
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
    };
  }
  if (!fs.existsSync(filePath)) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedMarker = null;
    hasLoggedError = false;
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
    };
  }
  const stats = fs.statSync(filePath);
  const marker = createMarker(stats);
  if (marker && marker === cachedMarker) {
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
    };
  }
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedMarker = marker;
    hasLoggedError = false;
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
    };
  }
  const parsed = JSON.parse(content);
  const normalized = normalizeAccountOverrides(parsed);
  cachedOverrides = normalized.overrides;
  cachedPortalOverrides = normalized.portalOverrides;
  cachedChatOverrides = normalized.chatOverrides;
  cachedSettings = normalized.settings || {};
  cachedOrdering = normalized.ordering || [];
  cachedMarker = marker;
  hasLoggedError = false;
  return {
    overrides: cachedOverrides,
    portalOverrides: cachedPortalOverrides,
    chatOverrides: cachedChatOverrides,
    settings: cachedSettings,
    ordering: cachedOrdering,
  };
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

function getAccountChatOverrides() {
  try {
    return loadAccountOverrides().chatOverrides;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedChatOverrides || {};
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

function getAccountSettings() {
  try {
    return loadAccountOverrides().settings || {};
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedSettings || {};
  }
}

module.exports = {
  getAccountNameOverrides,
  getAccountPortalOverrides,
  getAccountChatOverrides,
  getAccountSettings,
  getAccountOrdering,
  get accountNamesFilePath() {
    return resolvedFilePath;
  },
};
