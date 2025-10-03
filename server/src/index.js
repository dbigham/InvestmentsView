const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const {
  getAccountNameOverrides,
  getAccountPortalOverrides,
  getAccountChatOverrides,
  getAccountOrdering,
  getAccountSettings,
  getDefaultAccountId,
} = require('./accountNames');
const { getAccountBeneficiaries } = require('./accountBeneficiaries');
const { getQqqTemperatureSummary } = require('./qqqTemperature');
const { evaluateInvestmentModel } = require('./investmentModel');

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const tokenCache = new NodeCache();
const tokenFilePath = path.join(process.cwd(), 'token-store.json');

function resolveLoginDisplay(login) {
  if (!login) {
    return null;
  }
  return login.label || login.email || login.id;
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const MIN_REQUEST_INTERVAL_MS = 50;
const requestQueue = [];
let isProcessingQueue = false;
let nextAvailableTime = Date.now();

const ENABLE_QUESTRADE_API_DEBUG = process.env.QUESTRADE_API_DEBUG !== 'false';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function updateRateLimitFromHeaders(headers) {
  if (!headers) {
    return;
  }
  const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
  const reset = parseInt(headers['x-ratelimit-reset'], 10);
  if (!Number.isNaN(remaining) && remaining <= 1 && !Number.isNaN(reset)) {
    const resetMs = reset * 1000;
    if (resetMs > nextAvailableTime) {
      nextAvailableTime = resetMs;
    }
  }
}

function enqueueRequest(executor) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ executor, resolve, reject, attempt: 0 });
    processQueue();
  });
}

function processQueue() {
  if (isProcessingQueue) {
    return;
  }
  const job = requestQueue.shift();
  if (!job) {
    return;
  }
  isProcessingQueue = true;
  const now = Date.now();
  const wait = Math.max(0, nextAvailableTime - now);
  setTimeout(async () => {
    try {
      const response = await job.executor();
      updateRateLimitFromHeaders(response.headers);
      nextAvailableTime = Math.max(Date.now() + MIN_REQUEST_INTERVAL_MS, nextAvailableTime + MIN_REQUEST_INTERVAL_MS);
      job.resolve(response);
      isProcessingQueue = false;
      processQueue();
    } catch (error) {
      updateRateLimitFromHeaders(error.response && error.response.headers);
      nextAvailableTime = Math.max(Date.now() + MIN_REQUEST_INTERVAL_MS, nextAvailableTime + MIN_REQUEST_INTERVAL_MS);
      const status = error.response && error.response.status;
      const code = error.response && error.response.data && error.response.data.code;
      if ((status === 429 || code === 1011 || code === 1006) && job.attempt < 3) {
        job.attempt += 1;
        const backoff = 200 * Math.pow(2, job.attempt);
        setTimeout(() => {
          requestQueue.unshift(job);
          isProcessingQueue = false;
          processQueue();
        }, backoff);
        return;
      }
      job.reject(error);
      isProcessingQueue = false;
      processQueue();
    }
  }, wait);
}

function normalizeLogin(login, fallbackId) {
  if (!login || typeof login !== 'object') {
    return null;
  }
  const normalized = Object.assign({}, login);
  if (normalized.refresh_token && !normalized.refreshToken) {
    normalized.refreshToken = normalized.refresh_token;
  }
  if (normalized.ownerLabel && !normalized.label) {
    normalized.label = normalized.ownerLabel;
  }
  if (normalized.ownerEmail && !normalized.email) {
    normalized.email = normalized.ownerEmail;
  }
  const resolvedId = normalized.id || fallbackId;
  if (!resolvedId) {
    return null;
  }
  normalized.id = String(resolvedId);
  if (!normalized.refreshToken) {
    return null;
  }
  delete normalized.refresh_token;
  delete normalized.ownerLabel;
  delete normalized.ownerEmail;
  return normalized;
}

function loadTokenStore() {
  try {
    if (!fs.existsSync(tokenFilePath)) {
      return { logins: [] };
    }
    const content = fs.readFileSync(tokenFilePath, 'utf-8').replace(/^\uFEFF/, '');
    if (!content.trim()) {
      return { logins: [] };
    }
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.logins)) {
      const logins = parsed.logins
        .map((login, index) => normalizeLogin(login, 'login-' + (index + 1)))
        .filter(Boolean);
      return Object.assign({}, parsed, { logins });
    }
    if (parsed.refreshToken) {
      const legacyLogin = normalizeLogin(
        {
          id: parsed.id || parsed.loginId || 'primary',
          label: parsed.label || parsed.ownerLabel || null,
          email: parsed.email || parsed.ownerEmail || null,
          refreshToken: parsed.refreshToken,
          updatedAt: parsed.updatedAt || null,
        },
        'primary'
      );
      return { logins: legacyLogin ? [legacyLogin] : [], __migratedFromLegacy: true };
    }
    return { logins: [] };
  } catch (error) {
    console.warn('Failed to read token store:', error.message);
    return { logins: [] };
  }
}

function persistTokenStore(store) {
  try {
    const sanitizedLogins = (store.logins || []).map((login) => {
      const base = {
        id: login.id,
        label: login.label || null,
        email: login.email || null,
        refreshToken: login.refreshToken,
        updatedAt: login.updatedAt || null,
      };
      Object.keys(login).forEach((key) => {
        if (['id', 'label', 'email', 'refreshToken', 'updatedAt'].includes(key)) {
          return;
        }
        base[key] = login[key];
      });
      return base;
    });
    const payload = {
      logins: sanitizedLogins,
      updatedAt: new Date().toISOString(),
    };
    store.updatedAt = payload.updatedAt;
    fs.writeFileSync(tokenFilePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.warn('Failed to persist token store:', error.message);
  }
}

const tokenStoreState = loadTokenStore();
const allLogins = tokenStoreState.logins || [];

if (!allLogins.length) {
  console.error('Missing Questrade refresh token(s). Seed token-store.json with at least one login.');
  process.exit(1);
}

const loginsById = {};
allLogins.forEach((login) => {
  loginsById[login.id] = login;
});


function buildAccountOverrideKeys(account, login) {
  if (!account) {
    return [];
  }

  const candidates = [];
  const accountId = account.id ? String(account.id).trim() : null;
  const accountNumber = account.number ? String(account.number).trim() : null;
  const alternateNumber = account.accountNumber ? String(account.accountNumber).trim() : null;

  if (login) {
    const loginId = login.id ? String(login.id).trim() : null;
    const loginLabel = resolveLoginDisplay(login);
    const loginLabelTrimmed = loginLabel ? String(loginLabel).trim() : null;
    const loginEmail = login.email ? String(login.email).trim() : null;

    if (loginId && accountNumber) {
      candidates.push(`${loginId}:${accountNumber}`);
    }
    if (loginId && accountId && accountId !== accountNumber) {
      candidates.push(`${loginId}:${accountId}`);
    }
    if (loginLabelTrimmed && accountNumber) {
      candidates.push(`${loginLabelTrimmed}:${accountNumber}`);
    }
    if (loginLabelTrimmed && accountId && accountId !== accountNumber) {
      candidates.push(`${loginLabelTrimmed}:${accountId}`);
    }
    if (loginEmail && accountNumber) {
      candidates.push(`${loginEmail}:${accountNumber}`);
    }
  }

  if (accountId) {
    candidates.push(accountId);
  }
  if (accountNumber) {
    candidates.push(accountNumber);
  }
  if (alternateNumber && alternateNumber !== accountNumber) {
    candidates.push(alternateNumber);
  }

  return candidates;
}

function resolveAccountOverrideValue(overrides, account, login) {
  if (!overrides || !account) {
    return null;
  }

  const candidates = buildAccountOverrideKeys(account, login);
  const seen = new Set();
  for (const rawKey of candidates) {
    if (!rawKey) {
      continue;
    }
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (overrides[key]) {
      return overrides[key];
    }
    const condensed = key.replace(/\s+/g, '');
    if (!seen.has(condensed) && overrides[condensed]) {
      return overrides[condensed];
    }
    seen.add(condensed);
  }

  return null;
}

function resolveAccountDisplayName(overrides, account, login) {
  return resolveAccountOverrideValue(overrides, account, login);
}

function resolveAccountPortalId(overrides, account, login) {
  return resolveAccountOverrideValue(overrides, account, login);
}

function resolveAccountChatUrl(overrides, account, login) {
  return resolveAccountOverrideValue(overrides, account, login);
}

function findDefaultAccount(accountCollections, defaultKey) {
  if (!defaultKey) {
    return null;
  }
  const trimmedKey = String(defaultKey).trim();
  if (!trimmedKey) {
    return null;
  }
  const overrides = {};
  overrides[trimmedKey] = true;
  const condensed = trimmedKey.replace(/\s+/g, '');
  if (condensed && condensed !== trimmedKey) {
    overrides[condensed] = true;
  }

  for (const collection of accountCollections) {
    const { login, accounts } = collection;
    for (const account of accounts) {
      if (resolveAccountOverrideValue(overrides, account, login)) {
        return account;
      }
    }
  }

  return null;
}

function resolveAccountBeneficiary(beneficiaries, account, login) {
  if (!beneficiaries || !account) {
    return null;
  }

  const overrides = beneficiaries.overrides || {};

  const candidates = [];
  const accountId = account.id ? String(account.id).trim() : null;
  const accountNumber = account.number ? String(account.number).trim() : null;
  const alternateNumber = account.accountNumber ? String(account.accountNumber).trim() : null;
  const displayName = account.displayName ? String(account.displayName).trim() : null;

  if (login) {
    const loginId = login.id ? String(login.id).trim() : null;
    const loginLabel = resolveLoginDisplay(login);
    const loginLabelTrimmed = loginLabel ? String(loginLabel).trim() : null;
    const loginEmail = login.email ? String(login.email).trim() : null;

    if (loginId && accountNumber) {
      candidates.push(`${loginId}:${accountNumber}`);
    }
    if (loginId && accountId && accountId !== accountNumber) {
      candidates.push(`${loginId}:${accountId}`);
    }
    if (loginLabelTrimmed && accountNumber) {
      candidates.push(`${loginLabelTrimmed}:${accountNumber}`);
    }
    if (loginLabelTrimmed && accountId && accountId !== accountNumber) {
      candidates.push(`${loginLabelTrimmed}:${accountId}`);
    }
    if (loginEmail && accountNumber) {
      candidates.push(`${loginEmail}:${accountNumber}`);
    }
  }

  if (accountId) {
    candidates.push(accountId);
  }
  if (accountNumber) {
    candidates.push(accountNumber);
  }
  if (alternateNumber && alternateNumber !== accountNumber) {
    candidates.push(alternateNumber);
  }
  if (displayName) {
    candidates.push(displayName);
  }

  const typeCandidates = [account.type, account.clientAccountType];
  typeCandidates.forEach((candidateType) => {
    if (candidateType) {
      candidates.push(String(candidateType).trim());
    }
  });

  const seen = new Set();
  for (const rawKey of candidates) {
    if (!rawKey) {
      continue;
    }
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (overrides[normalized]) {
      return overrides[normalized];
    }
    const condensed = key.replace(/\s+/g, '').toLowerCase();
    if (!seen.has(condensed) && overrides[condensed]) {
      return overrides[condensed];
    }
    seen.add(condensed);
  }

  return null;
}
if (tokenStoreState.__migratedFromLegacy) {
  delete tokenStoreState.__migratedFromLegacy;
  persistTokenStore(tokenStoreState);
}

function getTokenCacheKey(loginId) {
  return 'tokenContext:' + loginId;
}

function updateLoginRefreshToken(login, nextRefreshToken) {
  if (!login || !nextRefreshToken || nextRefreshToken === login.refreshToken) {
    return;
  }
  login.refreshToken = nextRefreshToken;
  login.updatedAt = new Date().toISOString();
  persistTokenStore(tokenStoreState);
}

async function refreshAccessToken(login) {
  if (!login || !login.refreshToken) {
    throw new Error('Missing refresh token for Questrade login');
  }

  const tokenUrl = 'https://login.questrade.com/oauth2/token';
  const params = {
    grant_type: 'refresh_token',
    refresh_token: login.refreshToken,
  };

  let response;
  try {
    response = await axios.get(tokenUrl, { params });
  } catch (error) {
    const status = error.response ? error.response.status : 'NO_RESPONSE';
    const payload = error.response ? error.response.data : error.message;
    console.error('Failed to refresh Questrade token for login ' + resolveLoginDisplay(login), status, payload);
    throw error;
  }

  const tokenData = response.data;
  const cacheTtl = Math.max((tokenData.expires_in || 1800) - 60, 60);
  const tokenContext = {
    accessToken: tokenData.access_token,
    apiServer: tokenData.api_server,
    expiresIn: tokenData.expires_in,
    acquiredAt: Date.now(),
    loginId: login.id,
  };
  tokenCache.set(getTokenCacheKey(login.id), tokenContext, cacheTtl);

  if (tokenData.refresh_token && tokenData.refresh_token !== login.refreshToken) {
    updateLoginRefreshToken(login, tokenData.refresh_token);
  }

  return tokenContext;
}

async function getTokenContext(login) {
  const cacheKey = getTokenCacheKey(login.id);
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  return refreshAccessToken(login);
}

async function questradeRequest(login, pathSegment, options = {}) {
  if (!login) {
    throw new Error('Questrade login context is required for API requests');
  }
  const { method = 'GET', params, data, headers = {} } = options;
  const tokenContext = await getTokenContext(login);
  const url = new URL(pathSegment, tokenContext.apiServer).toString();

  const baseConfig = {
    method,
    url,
    params,
    data,
    headers: Object.assign(
      {
        Authorization: 'Bearer ' + tokenContext.accessToken,
      },
      headers
    ),
  };

  try {
    if (ENABLE_QUESTRADE_API_DEBUG) {
      const serializedParams = params ? JSON.stringify(params) : '';
      console.log('[Questrade][request]', method.toUpperCase(), url, serializedParams);
    }
    const response = await enqueueRequest(() => axios(baseConfig));
    if (ENABLE_QUESTRADE_API_DEBUG) {
      console.log('[Questrade][response]', method.toUpperCase(), url, 'status', response.status);
    }
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      tokenCache.del(getTokenCacheKey(login.id));
      const freshContext = await refreshAccessToken(login);
      const retryConfig = {
        method,
        url: new URL(pathSegment, freshContext.apiServer).toString(),
        params,
        data,
        headers: Object.assign(
          {
            Authorization: 'Bearer ' + freshContext.accessToken,
          },
          headers
        ),
      };
      if (ENABLE_QUESTRADE_API_DEBUG) {
        const serializedParams = params ? JSON.stringify(params) : '';
        console.log('[Questrade][retry]', method.toUpperCase(), retryConfig.url, serializedParams);
      }
      const retryResponse = await enqueueRequest(() => axios(retryConfig));
      if (ENABLE_QUESTRADE_API_DEBUG) {
        console.log('[Questrade][response]', method.toUpperCase(), retryConfig.url, 'status', retryResponse.status);
      }
      return retryResponse.data;
    }
    console.error(
      'Questrade API error for login ' + resolveLoginDisplay(login) + ':',
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

async function fetchAccounts(login) {
  const data = await questradeRequest(login, '/v1/accounts');
  return data.accounts || [];
}

async function fetchPositions(login, accountId) {
  const data = await questradeRequest(login, '/v1/accounts/' + accountId + '/positions');
  return data.positions || [];
}

async function fetchBalances(login, accountId) {
  const data = await questradeRequest(login, '/v1/accounts/' + accountId + '/balances');
  return data || {};
}

const NET_DEPOSIT_ACTIVITY_WINDOW_DAYS = 30;
const NET_DEPOSIT_ACTIVITY_START_PADDING_DAYS = 7;
const NET_DEPOSIT_ACTIVITY_EPOCH = new Date(Date.UTC(2000, 0, 1));
const NET_DEPOSIT_CACHE_TTL_MS = 15 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NET_DEPOSIT_SEED_LOOKBACK_DAYS = 120;
const NET_DEPOSIT_SEED_LOOKAHEAD_DAYS = 180;
const NET_DEPOSIT_FALLBACK_EXPANSION_DAYS = 365;
const ACCOUNT_ACTIVITY_SEED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ACCOUNT_ACTIVITY_START_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FX_RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FX_CANDLE_LOOKBACK_DAYS = 3;
const FX_CANDLE_LOOKAHEAD_DAYS = 3;
const BANK_OF_CANADA_BASE_URL = 'https://www.bankofcanada.ca/valet/observations/';
const BANK_OF_CANADA_TIMEOUT_MS = 5000;
const BANK_OF_CANADA_LOOKBACK_DAYS = 7;

const fxSymbolCache = new Map();
const fxRateCache = new Map();
const bankOfCanadaRateCache = new Map();

const ACCOUNT_PRIMARY_START_DATE_KEYS = [
  'openedDate',
  'openDate',
  'createdDate',
  'creationDate',
  'createdOn',
  'fundedDate',
  'activationDate',
  'effectiveDate',
  'startDate',
  'approvedDate',
  'enrolledDate',
  'clientSince',
];

const ACCOUNT_SECONDARY_START_DATE_KEYS = ['statusDate'];

function parseDateValue(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const derived = new Date(value);
    return Number.isNaN(derived.getTime()) ? null : derived;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function resolveTimestampFromObject(entity, preferredKeys = []) {
  if (!entity || typeof entity !== 'object') {
    return null;
  }

  for (const key of preferredKeys) {
    if (!(key in entity)) {
      continue;
    }
    const parsed = parseDateValue(entity[key]);
    if (parsed) {
      return parsed;
    }
  }

  for (const key of Object.keys(entity)) {
    if (preferredKeys.includes(key)) {
      continue;
    }
    if (!/date|time/i.test(key)) {
      continue;
    }
    const parsed = parseDateValue(entity[key]);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function inferAccountStartDate(account) {
  if (!account || typeof account !== 'object') {
    return null;
  }

  const candidates = [];

  const collectCandidates = function (keys) {
    keys.forEach(function (key) {
      const parsed = parseDateValue(account[key]);
      if (parsed) {
        candidates.push(parsed);
      }
    });
  };

  collectCandidates(ACCOUNT_PRIMARY_START_DATE_KEYS);

  if (!candidates.length) {
    collectCandidates(ACCOUNT_SECONDARY_START_DATE_KEYS);
  }

  if (!candidates.length) {
    Object.keys(account).forEach(function (key) {
      if (!/date/i.test(key)) {
        return;
      }
      if (ACCOUNT_PRIMARY_START_DATE_KEYS.includes(key) || ACCOUNT_SECONDARY_START_DATE_KEYS.includes(key)) {
        return;
      }
      const parsed = parseDateValue(account[key]);
      if (parsed) {
        candidates.push(parsed);
      }
    });
  }

  if (!candidates.length) {
    return null;
  }

  const filtered = candidates
    .map(function (date) {
      return Number.isNaN(date.getTime()) ? null : date;
    })
    .filter(Boolean)
    .filter(function (date) {
      return date.getTime() >= NET_DEPOSIT_ACTIVITY_EPOCH.getTime() - 365 * 24 * 60 * 60 * 1000;
    })
    .sort(function (a, b) {
      return a.getTime() - b.getTime();
    });

  if (!filtered.length) {
    return null;
  }

  return filtered[0];
}

function resolveActivityHistoryStart(candidate) {
  const parsed = parseDateValue(candidate);
  const baselineMs = NET_DEPOSIT_ACTIVITY_EPOCH.getTime();
  if (!parsed) {
    return new Date(baselineMs);
  }
  const now = Date.now();
  const paddingMs = Math.max(0, NET_DEPOSIT_ACTIVITY_START_PADDING_DAYS) * 24 * 60 * 60 * 1000;
  const clampedMs = Math.min(parsed.getTime(), now);
  const adjustedMs = Math.max(baselineMs, clampedMs - paddingMs);
  return new Date(adjustedMs);
}

const netDepositCache = new Map();
const accountActivitySeedCache = new Map();
const accountActivityStartCache = new Map();

function getTimedCacheEntry(cache, key, ttlMs) {
  if (!cache.has(key)) {
    return null;
  }
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (ttlMs > 0 && Date.now() - entry.timestamp > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setTimedCacheEntry(cache, key, value) {
  cache.set(key, { value, timestamp: Date.now() });
}

function getCachedAccountActivitySeed(key) {
  return getTimedCacheEntry(accountActivitySeedCache, key, ACCOUNT_ACTIVITY_SEED_CACHE_TTL_MS);
}

function setCachedAccountActivitySeed(key, value) {
  setTimedCacheEntry(accountActivitySeedCache, key, value);
}

function getCachedAccountActivityStart(key) {
  return getTimedCacheEntry(accountActivityStartCache, key, ACCOUNT_ACTIVITY_START_CACHE_TTL_MS);
}

function setCachedAccountActivityStart(key, value) {
  setTimedCacheEntry(accountActivityStartCache, key, value);
}

function getFxSymbolCacheKey(sourceCurrency, targetCurrency) {
  return `${sourceCurrency || 'UNKNOWN'}:${targetCurrency || 'UNKNOWN'}`;
}

function setCachedFxSymbol(sourceCurrency, targetCurrency, value) {
  const key = getFxSymbolCacheKey(sourceCurrency, targetCurrency);
  fxSymbolCache.set(key, value || null);
}

function getCachedFxSymbol(sourceCurrency, targetCurrency) {
  const key = getFxSymbolCacheKey(sourceCurrency, targetCurrency);
  return fxSymbolCache.has(key) ? fxSymbolCache.get(key) : null;
}

function getFxRateCacheKey(symbolId, dateKey) {
  return `${symbolId || 'unknown'}:${dateKey || 'unknown'}`;
}

function getCachedFxRate(symbolId, dateKey) {
  const key = getFxRateCacheKey(symbolId, dateKey);
  const entry = fxRateCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > FX_RATE_CACHE_TTL_MS) {
    fxRateCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedFxRate(symbolId, dateKey, value) {
  const key = getFxRateCacheKey(symbolId, dateKey);
  fxRateCache.set(key, { timestamp: Date.now(), value });
}

function getBankOfCanadaCacheKey(seriesId, dateKey) {
  return `${seriesId || 'unknown'}:${dateKey || 'unknown'}`;
}

function getCachedBankOfCanadaRate(seriesId, dateKey) {
  const key = getBankOfCanadaCacheKey(seriesId, dateKey);
  const entry = bankOfCanadaRateCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > FX_RATE_CACHE_TTL_MS) {
    bankOfCanadaRateCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedBankOfCanadaRate(seriesId, dateKey, value) {
  const key = getBankOfCanadaCacheKey(seriesId, dateKey);
  bankOfCanadaRateCache.set(key, { timestamp: Date.now(), value });
}

function getNetDepositCacheKey(loginId, accountNumber) {
  return `${loginId || 'unknown'}:${accountNumber || 'unknown'}`;
}

function normalizeActivityLabel(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function resolveActivityCurrency(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const candidates = [activity.currency, activity.currencyPrimary, activity.currencySecondary];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toUpperCase();
    }
  }
  return null;
}

function parseNumericValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim();
    if (!cleaned) {
      return null;
    }
    const normalized = cleaned.replace(/[,\s]/g, '');
    if (!normalized) {
      return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveNumericField(source, fields) {
  if (!source || typeof source !== 'object') {
    return null;
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      continue;
    }
    const value = parseNumericValue(source[field]);
    if (value === null || value === undefined) {
      continue;
    }
    return { field, value };
  }
  return null;
}

const NET_DEPOSIT_AMOUNT_FALLBACK_FIELDS = [
  'grossAmount',
  'grossAmountCad',
  'grossAmountCdn',
  'grossAmountUsd',
  'grossAmountBase',
  'settlementAmount',
  'settlementAmountCad',
  'settlementAmountCdn',
  'settlementAmountUsd',
  'amount',
  'amountCad',
  'amountCdn',
  'amountUsd',
  'tradeValue',
  'tradeAmount',
  'totalAmount',
  'principal',
  'proceeds',
  'value',
  'bookValue',
  'bookValueCad',
  'bookValueUsd',
  'marketValue',
  'marketValueCad',
  'marketValueUsd',
  'consideration',
  'cashAmount',
  'cash',
  'debit',
  'credit',
];

const NET_DEPOSIT_QUANTITY_FIELDS = ['quantity', 'qty', 'units', 'shares', 'shareQuantity'];
const NET_DEPOSIT_PRICE_FIELDS = ['price', 'tradePrice', 'avgPrice', 'averagePrice', 'fillPrice', 'cost', 'costPerShare', 'bookPrice'];

function resolveActivityAmountForNetDeposits(activity) {
  if (!activity || typeof activity !== 'object') {
    return { amount: 0, source: null };
  }

  const direct = parseNumericValue(activity.netAmount);
  if (isFiniteNumber(direct) && Math.abs(direct) > 1e-9) {
    return { amount: direct, source: 'netAmount' };
  }

  const fallback = resolveNumericField(activity, NET_DEPOSIT_AMOUNT_FALLBACK_FIELDS);
  if (fallback && isFiniteNumber(fallback.value) && Math.abs(fallback.value) > 1e-9) {
    return { amount: fallback.value, source: fallback.field };
  }

  const quantityInfo = resolveNumericField(activity, NET_DEPOSIT_QUANTITY_FIELDS);
  const priceInfo = resolveNumericField(activity, NET_DEPOSIT_PRICE_FIELDS);
  if (
    quantityInfo &&
    priceInfo &&
    isFiniteNumber(quantityInfo.value) &&
    isFiniteNumber(priceInfo.value)
  ) {
    const estimated = quantityInfo.value * priceInfo.value;
    if (isFiniteNumber(estimated) && Math.abs(estimated) > 1e-9) {
      return {
        amount: estimated,
        source: 'quantity*price',
        quantity: quantityInfo.value,
        quantitySource: quantityInfo.field,
        price: priceInfo.value,
        priceSource: priceInfo.field,
      };
    }
  }

  const quantityOnly = quantityInfo && isFiniteNumber(quantityInfo.value) ? quantityInfo : null;
  const priceOnly = priceInfo && isFiniteNumber(priceInfo.value) ? priceInfo : null;

  return {
    amount: 0,
    source: null,
    quantity: quantityOnly ? quantityOnly.value : null,
    quantitySource: quantityOnly ? quantityOnly.field : null,
    price: priceOnly ? priceOnly.value : null,
    priceSource: priceOnly ? priceOnly.field : null,
  };
}

function resolveActivityTimestamp(activity) {
  const preferredKeys = [
    'transactionDateTime',
    'transactionDatetime',
    'transactionTime',
    'tradeDate',
    'transactionDate',
    'settlementDate',
    'activityDate',
    'processedTime',
    'processedAt',
    'executionTime',
    'createdDate',
    'createdTime',
    'date',
  ];
  return resolveTimestampFromObject(activity, preferredKeys);
}

function resolveOrderTimestamp(order) {
  const preferredKeys = [
    'creationTime',
    'creationDate',
    'createdTime',
    'createdAt',
    'updateTime',
    'updateDate',
  ];
  return resolveTimestampFromObject(order, preferredKeys);
}

function resolveExecutionTimestamp(execution) {
  const preferredKeys = ['timestamp', 'executionTime', 'tradeDate', 'transactionDate'];
  return resolveTimestampFromObject(execution, preferredKeys);
}

function getUtcStartOfDay(date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    return null;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function getUtcEndOfDay(date) {
  const start = getUtcStartOfDay(date);
  if (!start) {
    return null;
  }
  return new Date(start.getTime() + MS_PER_DAY - 1);
}

function formatFxDateKey(date) {
  const start = getUtcStartOfDay(date);
  if (!start) {
    return null;
  }
  return start.toISOString().slice(0, 10);
}

function buildFxDateCandidates(baseDate, lookbackDays) {
  const candidates = [];
  const base = baseDate instanceof Date && !Number.isNaN(baseDate.valueOf()) ? baseDate : new Date();
  const unique = new Set();
  const totalDays = Math.max(lookbackDays || 0, 0);

  for (let offset = 0; offset <= totalDays; offset += 1) {
    const candidate = new Date(base.getTime() - offset * MS_PER_DAY);
    const dateKey = formatFxDateKey(candidate);
    if (!dateKey || unique.has(dateKey)) {
      continue;
    }
    unique.add(dateKey);
    candidates.push({ date: candidate, dateKey });
  }

  return candidates;
}

function inferFxOrientation(text, sourceCurrency, targetCurrency) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const normalized = text.toUpperCase();
  const condensed = normalized.replace(/[^A-Z]/g, '');
  const sourceIndex = condensed.indexOf(sourceCurrency);
  const targetIndex = condensed.indexOf(targetCurrency);
  if (sourceIndex === -1 || targetIndex === -1) {
    return null;
  }
  if (sourceIndex === targetIndex) {
    return null;
  }
  return sourceIndex < targetIndex ? 'direct' : 'inverse';
}

function buildFxSymbolSearchQueries(sourceCurrency, targetCurrency) {
  const normalizedSource = normalizeCurrencyCode(sourceCurrency);
  const normalizedTarget = normalizeCurrencyCode(targetCurrency);
  if (!normalizedSource || !normalizedTarget) {
    return [];
  }
  const basePatterns = [
    `${normalizedSource}.${normalizedTarget}`,
    `${normalizedSource}${normalizedTarget}`,
    `${normalizedSource}/${normalizedTarget}`,
    `${normalizedSource}-${normalizedTarget}`,
    `${normalizedTarget}.${normalizedSource}`,
    `${normalizedTarget}${normalizedSource}`,
    `${normalizedTarget}/${normalizedSource}`,
    `${normalizedTarget}-${normalizedSource}`,
  ];
  const suffixes = ['', '.FX', '.TO'];
  const queries = new Set();
  basePatterns.forEach((pattern) => {
    suffixes.forEach((suffix) => {
      const candidate = (pattern + suffix).replace(/\s+/g, '');
      if (candidate) {
        queries.add(candidate);
      }
    });
  });
  return Array.from(queries);
}

function findFxSymbolMatch(symbols, sourceCurrency, targetCurrency, orientationHint = null) {
  if (!Array.isArray(symbols)) {
    return null;
  }
  const normalizedSource = normalizeCurrencyCode(sourceCurrency);
  const normalizedTarget = normalizeCurrencyCode(targetCurrency);
  if (!normalizedSource || !normalizedTarget) {
    return null;
  }

  const matches = [];
  symbols.forEach((symbol) => {
    if (!symbol || typeof symbol !== 'object') {
      return;
    }
    const symbolId = symbol.symbolId ?? symbol.id ?? null;
    if (symbolId === null || symbolId === undefined) {
      return;
    }
    const symbolText = typeof symbol.symbol === 'string' ? symbol.symbol.toUpperCase() : '';
    const description = typeof symbol.description === 'string' ? symbol.description.toUpperCase() : '';
    const symbolDescription =
      typeof symbol.symbolDescription === 'string' ? symbol.symbolDescription.toUpperCase() : '';
    const symbolName = typeof symbol.symbolName === 'string' ? symbol.symbolName.toUpperCase() : '';
    const combined = [symbolText, description, symbolDescription, symbolName].filter(Boolean).join(' ');
    if (!combined.includes(normalizedSource) || !combined.includes(normalizedTarget)) {
      return;
    }
    const securityType = typeof symbol.securityType === 'string' ? symbol.securityType.toUpperCase() : '';
    const orientation =
      inferFxOrientation(symbolText, normalizedSource, normalizedTarget) ||
      inferFxOrientation(description, normalizedSource, normalizedTarget) ||
      inferFxOrientation(symbolDescription, normalizedSource, normalizedTarget) ||
      inferFxOrientation(symbolName, normalizedSource, normalizedTarget) ||
      orientationHint ||
      null;
    const rank =
      (orientation ? 2 : 0) +
      (securityType && /CURRENCY|FOREX|FX/.test(securityType) ? 1 : 0) +
      (symbolText && symbolText.includes('.') ? 0.1 : 0);
    matches.push({
      symbolId,
      symbol: symbol.symbol || null,
      orientation,
      securityType,
      rank,
    });
  });

  if (!matches.length) {
    return null;
  }

  matches.sort((a, b) => b.rank - a.rank);
  const chosen = matches[0];
  if (!chosen.orientation && orientationHint) {
    chosen.orientation = orientationHint;
  }
  if (!chosen.orientation) {
    chosen.orientation = 'direct';
  }
  return chosen;
}

function buildBankOfCanadaSeriesInfo(sourceCurrency, targetCurrency) {
  const normalizedSource = normalizeCurrencyCode(sourceCurrency);
  const normalizedTarget = normalizeCurrencyCode(targetCurrency);
  if (!normalizedSource || !normalizedTarget) {
    return null;
  }
  if (normalizedSource === normalizedTarget) {
    return null;
  }
  if (normalizedSource === 'CAD') {
    return { seriesId: `FXCAD${normalizedTarget}`, invert: false };
  }
  if (normalizedTarget === 'CAD') {
    return { seriesId: `FX${normalizedSource}CAD`, invert: false };
  }
  return null;
}

async function fetchBankOfCanadaSeriesObservation(seriesId, dateKey) {
  if (!seriesId || !dateKey) {
    return null;
  }
  const cached = getCachedBankOfCanadaRate(seriesId, dateKey);
  if (cached) {
    return cached;
  }

  const url = `${BANK_OF_CANADA_BASE_URL}${encodeURIComponent(seriesId)}?start_date=${dateKey}&end_date=${dateKey}`;

  try {
    const response = await axios.get(url, { timeout: BANK_OF_CANADA_TIMEOUT_MS });
    const observations = Array.isArray(response && response.observations)
      ? response.observations
      : [];
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      const observation = observations[index];
      if (!observation || typeof observation !== 'object') {
        continue;
      }
      const container = observation[seriesId];
      const value =
        container && typeof container === 'object'
          ? parseNumericValue(container.v ?? container.value ?? container.val)
          : parseNumericValue(container);
      if (!isFiniteNumber(value) || value <= 0) {
        continue;
      }
      const observationDateKey =
        typeof observation.d === 'string' && observation.d ? observation.d : dateKey;
      const meta = { rate: value, dateKey: observationDateKey };
      setCachedBankOfCanadaRate(seriesId, dateKey, meta);
      if (observationDateKey && observationDateKey !== dateKey) {
        setCachedBankOfCanadaRate(seriesId, observationDateKey, meta);
      }
      return meta;
    }
  } catch (error) {
    if (ENABLE_QUESTRADE_API_DEBUG) {
      console.warn(
        '[FX][BankOfCanada] Failed to fetch series',
        seriesId,
        'for',
        dateKey + ':',
        error && error.message ? error.message : error
      );
    }
  }

  return null;
}

async function resolveExternalHistoricalFxRateMeta(sourceCurrency, targetCurrency, timestamp, visited) {
  const normalizedSource = normalizeCurrencyCode(sourceCurrency);
  const normalizedTarget = normalizeCurrencyCode(targetCurrency);
  if (!normalizedSource || !normalizedTarget) {
    return null;
  }

  const visitKey = `${normalizedSource}->${normalizedTarget}`;
  const tracker = visited instanceof Set ? visited : new Set();
  if (tracker.has(visitKey)) {
    return null;
  }
  tracker.add(visitKey);

  if (normalizedSource === normalizedTarget) {
    return {
      rate: 1,
      source: 'identity',
      dateKey: formatFxDateKey(timestamp instanceof Date ? timestamp : new Date()),
      symbolInfo: {
        symbolId: null,
        symbol: null,
        orientation: 'identity',
        provider: 'bank-of-canada',
        sourceCurrency: normalizedSource,
        targetCurrency: normalizedTarget,
      },
    };
  }

  const baseDate = timestamp instanceof Date && !Number.isNaN(timestamp.valueOf()) ? timestamp : new Date();
  const candidates = buildFxDateCandidates(baseDate, BANK_OF_CANADA_LOOKBACK_DAYS);
  const seriesInfo = buildBankOfCanadaSeriesInfo(normalizedSource, normalizedTarget);

  if (seriesInfo) {
    for (const candidate of candidates) {
      const observation = await fetchBankOfCanadaSeriesObservation(seriesInfo.seriesId, candidate.dateKey);
      if (!observation || !isFiniteNumber(observation.rate) || observation.rate <= 0) {
        continue;
      }
      const effectiveRate = seriesInfo.invert ? 1 / observation.rate : observation.rate;
      if (!isFiniteNumber(effectiveRate) || effectiveRate <= 0) {
        continue;
      }
      return {
        rate: effectiveRate,
        source: 'bank-of-canada',
        dateKey: observation.dateKey || candidate.dateKey,
        symbolInfo: {
          symbolId: null,
          symbol: seriesInfo.seriesId,
          orientation: seriesInfo.invert ? 'inverse' : 'direct',
          provider: 'bank-of-canada',
          sourceCurrency: normalizedSource,
          targetCurrency: normalizedTarget,
        },
      };
    }
  }

  if (normalizedSource !== 'CAD' && normalizedTarget !== 'CAD') {
    const toCad = await resolveExternalHistoricalFxRateMeta(normalizedSource, 'CAD', baseDate, tracker);
    const fromCad = await resolveExternalHistoricalFxRateMeta('CAD', normalizedTarget, baseDate, tracker);
    const toCadRate = toCad && isFiniteNumber(toCad.rate) && toCad.rate > 0 ? toCad.rate : null;
    const fromCadRate = fromCad && isFiniteNumber(fromCad.rate) && fromCad.rate > 0 ? fromCad.rate : null;
    if (toCadRate && fromCadRate) {
      return {
        rate: toCadRate * fromCadRate,
        source: 'bank-of-canada:derived',
        dateKey: fromCad && fromCad.dateKey ? fromCad.dateKey : toCad ? toCad.dateKey : null,
        symbolInfo: {
          symbolId: null,
          symbol: 'BANK-OF-CANADA-VIA-CAD',
          orientation: 'derived',
          provider: 'bank-of-canada',
          sourceCurrency: normalizedSource,
          targetCurrency: normalizedTarget,
        },
      };
    }
  }

  return null;
}

const NET_DEPOSIT_INFLOW_KEYWORDS = [
  'deposit',
  'transferin',
  'transfercashin',
  'cashtransferin',
  'journalcashin',
  'jrnlcashin',
  'journalin',
  'cashin',
  'incomingtransfer',
  'fundsreceived',
  'billpayment',
  'dripcashin',
  'paymentreceived',
];

const NET_DEPOSIT_OUTFLOW_KEYWORDS = [
  'withdraw',
  'withdrawal',
  'transferout',
  'transfercashout',
  'cashtransferout',
  'journalcashout',
  'jrnlcashout',
  'journalout',
  'cashout',
  'outgoingtransfer',
  'fundssent',
  'paymentmade',
];

function classifyNetDepositActivity(activity) {
  const labels = [normalizeActivityLabel(activity && activity.type), normalizeActivityLabel(activity && activity.action)];
  const description = normalizeActivityLabel(activity && activity.description);
  if (description) {
    labels.push(description);
  }

  const hasKeyword = (keywords) => {
    return keywords.some((keyword) => labels.some((label) => label && label.includes(keyword)));
  };

  if (hasKeyword(NET_DEPOSIT_INFLOW_KEYWORDS)) {
    return 'inflow';
  }
  if (hasKeyword(NET_DEPOSIT_OUTFLOW_KEYWORDS)) {
    return 'outflow';
  }

  const baseLabel = labels.find((label) => label);
  if (!baseLabel) {
    return null;
  }

  if (baseLabel.includes('transfer') || baseLabel.includes('journal')) {
    const netAmount = Number(activity && activity.netAmount);
    if (!Number.isFinite(netAmount) || netAmount === 0) {
      return null;
    }
    return netAmount > 0 ? 'inflow' : 'outflow';
  }

  return null;
}

function isPotentialNetDepositActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }

  const classification = classifyNetDepositActivity(activity);
  if (classification) {
    return true;
  }

  const labels = [normalizeActivityLabel(activity.type), normalizeActivityLabel(activity.action)];
  const description = normalizeActivityLabel(activity.description);
  if (description) {
    labels.push(description);
  }

  const keywords = NET_DEPOSIT_INFLOW_KEYWORDS.concat(NET_DEPOSIT_OUTFLOW_KEYWORDS);
  return keywords.some(function (keyword) {
    return labels.some(function (label) {
      return label && label.includes(keyword);
    });
  });
}

function buildActivityWindows(startDate, endDate, windowDays) {
  const windows = [];
  if (!(startDate instanceof Date) || Number.isNaN(startDate.valueOf())) {
    return windows;
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.valueOf())) {
    return windows;
  }

  const windowMs = Math.max(windowDays, 1) * 24 * 60 * 60 * 1000;
  let cursorMs = startDate.getTime();
  const limit = endDate.getTime();

  while (cursorMs <= limit) {
    const remaining = limit - cursorMs;
    let windowEndMs = cursorMs + windowMs;
    let isFinalWindow = false;

    if (remaining <= windowMs) {
      windowEndMs = limit;
      isFinalWindow = true;
    } else {
      windowEndMs = Math.min(limit, windowEndMs - 1);
    }

    if (windowEndMs < cursorMs) {
      windowEndMs = cursorMs;
    }

    windows.push({ start: new Date(cursorMs), end: new Date(windowEndMs) });

    if (isFinalWindow) {
      break;
    }

    cursorMs = windowEndMs + 1;
  }

  return windows;
}

function formatActivityTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isArgumentLengthError(error) {
  return Boolean(error && error.response && error.response.data && error.response.data.code === 1003);
}

async function fetchEarliestTimestampFromPagedEndpoint(
  login,
  initialPath,
  params,
  itemsKey,
  timestampResolver,
  options = {}
) {
  if (!login || !initialPath || !itemsKey || typeof timestampResolver !== 'function') {
    return null;
  }

  let nextPath = initialPath;
  let currentParams = params || null;
  let earliest = null;
  const maxPages = Math.max(options.maxPages || 20, 1);
  let pagesFetched = 0;

  while (nextPath && pagesFetched < maxPages) {
    const trimmedPath = String(nextPath).trim();
    if (!trimmedPath) {
      break;
    }

    const requestOptions = currentParams ? { params: currentParams } : {};
    let data;
    try {
      data = await questradeRequest(login, trimmedPath, requestOptions);
    } catch (error) {
      throw error;
    }

    pagesFetched += 1;
    currentParams = null;

    const items = Array.isArray(data && data[itemsKey]) ? data[itemsKey] : [];
    for (const item of items) {
      const timestamp = timestampResolver(item);
      if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
        continue;
      }
      if (!earliest || timestamp.getTime() < earliest.getTime()) {
        earliest = timestamp;
      }
    }

    if (data && typeof data.next === 'string' && data.next.trim()) {
      nextPath = data.next.trim();
    } else {
      break;
    }
  }

  return earliest;
}

async function fetchActivitiesWindow(login, accountId, startDate, endDate) {
  const params = {};
  const startTime = formatActivityTimestamp(startDate);
  const endTime = formatActivityTimestamp(endDate);
  if (startTime) {
    params.startTime = startTime;
  }
  if (endTime) {
    params.endTime = endTime;
  }
  try {
    const data = await questradeRequest(login, '/v1/accounts/' + accountId + '/activities', { params });
    return Array.isArray(data.activities) ? data.activities : [];
  } catch (error) {
    if (isArgumentLengthError(error) && startDate instanceof Date && endDate instanceof Date) {
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs > 24 * 60 * 60 * 1000) {
        const midpointMs = Math.floor((startMs + endMs) / 2);
        if (midpointMs > startMs && midpointMs < endMs) {
          const midpoint = new Date(midpointMs);
          const firstBatch = await fetchActivitiesWindow(login, accountId, startDate, midpoint);
          const secondStart = new Date(midpoint.getTime() + 1);
          const secondBatch = await fetchActivitiesWindow(login, accountId, secondStart, endDate);
          return firstBatch.concat(secondBatch);
        }
      }
    }
    throw error;
  }
}

async function fetchEarliestOrderCreationTime(login, accountId) {
  const params = {
    startTime: formatActivityTimestamp(NET_DEPOSIT_ACTIVITY_EPOCH),
    endTime: formatActivityTimestamp(new Date()),
    stateFilter: 'All',
  };
  return fetchEarliestTimestampFromPagedEndpoint(
    login,
    '/v1/accounts/' + accountId + '/orders',
    params,
    'orders',
    resolveOrderTimestamp,
    { maxPages: 25 }
  );
}

async function fetchEarliestExecutionTimestamp(login, accountId) {
  const params = {
    startTime: formatActivityTimestamp(NET_DEPOSIT_ACTIVITY_EPOCH),
    endTime: formatActivityTimestamp(new Date()),
  };
  return fetchEarliestTimestampFromPagedEndpoint(
    login,
    '/v1/accounts/' + accountId + '/executions',
    params,
    'executions',
    resolveExecutionTimestamp,
    { maxPages: 25 }
  );
}

async function fetchAccountActivitySeed(login, accountId) {
  if (!login || !accountId) {
    return null;
  }

  const cacheKey = getNetDepositCacheKey(login.id, accountId);
  const cached = getCachedAccountActivitySeed(cacheKey);
  if (cached !== null && cached !== undefined) {
    if (cached === false) {
      return null;
    }
    const cachedDate = new Date(cached);
    return Number.isNaN(cachedDate.valueOf()) ? null : cachedDate;
  }

  let earliest = null;

  try {
    const orderSeed = await fetchEarliestOrderCreationTime(login, accountId);
    if (orderSeed && (!earliest || orderSeed.getTime() < earliest.getTime())) {
      earliest = orderSeed;
    }
  } catch (error) {
    console.warn(
      'Failed to fetch orders for account ' + accountId + ' (' + resolveLoginDisplay(login) + ') when seeding activities:',
      error && error.message ? error.message : error
    );
  }

  try {
    const executionSeed = await fetchEarliestExecutionTimestamp(login, accountId);
    if (executionSeed && (!earliest || executionSeed.getTime() < earliest.getTime())) {
      earliest = executionSeed;
    }
  } catch (error) {
    console.warn(
      'Failed to fetch executions for account ' + accountId + ' (' + resolveLoginDisplay(login) + ') when seeding activities:',
      error && error.message ? error.message : error
    );
  }

  if (earliest) {
    setCachedAccountActivitySeed(cacheKey, earliest.getTime());
    return earliest;
  }

  setCachedAccountActivitySeed(cacheKey, false);
  return null;
}

async function summarizeActivityWindow(login, accountId, startMs, endMs, cache) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { hasFunding: false, earliestTimestamp: null };
  }

  const key = startMs + ':' + endMs;
  if (cache && cache.has(key)) {
    return cache.get(key);
  }

  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const activities = await fetchActivitiesWindow(login, accountId, startDate, endDate);
  let hasFunding = false;
  let earliestTimestamp = null;

  for (const activity of activities) {
    if (!isPotentialNetDepositActivity(activity)) {
      continue;
    }
    hasFunding = true;
    const timestamp = resolveActivityTimestamp(activity);
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
      continue;
    }
    const ms = timestamp.getTime();
    if (!Number.isFinite(ms)) {
      continue;
    }
    if (earliestTimestamp === null || ms < earliestTimestamp) {
      earliestTimestamp = ms;
    }
  }

  const summary = { hasFunding, earliestTimestamp };
  if (cache) {
    cache.set(key, summary);
  }
  return summary;
}

async function searchActivityRangeForFunding(login, accountId, rangeStartMs, rangeEndMs, cache) {
  if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs < rangeStartMs) {
    return null;
  }

  const startDate = new Date(rangeStartMs);
  const endDate = new Date(rangeEndMs);
  const windows = buildActivityWindows(startDate, endDate, NET_DEPOSIT_ACTIVITY_WINDOW_DAYS);

  for (const window of windows) {
    const windowStartMs = window.start.getTime();
    const windowEndMs = window.end.getTime();
    const summary = await summarizeActivityWindow(login, accountId, windowStartMs, windowEndMs, cache);
    if (summary.hasFunding && summary.earliestTimestamp !== null && summary.earliestTimestamp !== undefined) {
      return summary.earliestTimestamp;
    }
  }

  return null;
}

async function resolveAccountActivityHistoryStart(login, accountId, options = {}) {
  if (!login || !accountId) {
    return resolveActivityHistoryStart(null);
  }

  const cacheKey = getNetDepositCacheKey(login.id, accountId);
  const cachedStart = getCachedAccountActivityStart(cacheKey);
  if (cachedStart !== null && cachedStart !== undefined) {
    const cachedDate = new Date(cachedStart);
    if (!Number.isNaN(cachedDate.valueOf())) {
      return cachedDate;
    }
  }

  const baselineMs = NET_DEPOSIT_ACTIVITY_EPOCH.getTime();
  const nowMs = Date.now();
  const directCandidate = parseDateValue(options.startDate);
  const directMs = directCandidate ? directCandidate.getTime() : null;
  const windowCache = new Map();

  const seedDates = [];
  if (Number.isFinite(directMs) && directMs >= baselineMs && directMs <= nowMs) {
    seedDates.push(directMs);
  }

  const seed = await fetchAccountActivitySeed(login, accountId);
  if (seed && seed.getTime() >= baselineMs && seed.getTime() <= nowMs) {
    seedDates.push(seed.getTime());
  }

  const uniqueSeeds = Array.from(new Set(seedDates)).sort(function (a, b) {
    return a - b;
  });

  const lookbackMs = Math.max(NET_DEPOSIT_SEED_LOOKBACK_DAYS, NET_DEPOSIT_ACTIVITY_WINDOW_DAYS) * MS_PER_DAY;
  const lookaheadMs = Math.max(NET_DEPOSIT_SEED_LOOKAHEAD_DAYS, NET_DEPOSIT_ACTIVITY_WINDOW_DAYS) * MS_PER_DAY;
  let earliestTimestampMs = null;

  for (const seedMs of uniqueSeeds) {
    const rangeStart = Math.max(baselineMs, seedMs - lookbackMs);
    const rangeEnd = Math.min(nowMs, seedMs + lookaheadMs);
    const found = await searchActivityRangeForFunding(login, accountId, rangeStart, rangeEnd, windowCache);
    if (found !== null && found !== undefined) {
      if (earliestTimestampMs === null || found < earliestTimestampMs) {
        earliestTimestampMs = found;
      }
    }
    if (earliestTimestampMs !== null && earliestTimestampMs <= rangeStart) {
      break;
    }
  }

  if (earliestTimestampMs === null) {
    let fallbackEndMs;
    if (uniqueSeeds.length) {
      fallbackEndMs = Math.min(uniqueSeeds[0], nowMs);
    } else if (Number.isFinite(directMs)) {
      fallbackEndMs = Math.min(directMs, nowMs);
    } else {
      fallbackEndMs = nowMs;
    }

    if (!Number.isFinite(fallbackEndMs) || fallbackEndMs < baselineMs) {
      fallbackEndMs = nowMs;
    }

    let fallbackStartMs = Math.max(baselineMs, fallbackEndMs - NET_DEPOSIT_FALLBACK_EXPANSION_DAYS * MS_PER_DAY);

    while (fallbackEndMs > baselineMs) {
      const found = await searchActivityRangeForFunding(login, accountId, fallbackStartMs, fallbackEndMs, windowCache);
      if (found !== null && found !== undefined) {
        earliestTimestampMs = found;
        break;
      }
      if (fallbackStartMs <= baselineMs) {
        break;
      }
      fallbackEndMs = fallbackStartMs - 1;
      fallbackStartMs = Math.max(baselineMs, fallbackEndMs - NET_DEPOSIT_FALLBACK_EXPANSION_DAYS * MS_PER_DAY);
    }
  }

  if (earliestTimestampMs === null && uniqueSeeds.length === 0 && !Number.isFinite(directMs)) {
    const found = await searchActivityRangeForFunding(login, accountId, baselineMs, nowMs, windowCache);
    if (found !== null && found !== undefined) {
      earliestTimestampMs = found;
    }
  }

  let resolvedStart = null;
  if (earliestTimestampMs !== null && earliestTimestampMs !== undefined) {
    resolvedStart = resolveActivityHistoryStart(new Date(earliestTimestampMs));
  } else if (directCandidate) {
    resolvedStart = resolveActivityHistoryStart(directCandidate);
  } else if (uniqueSeeds.length) {
    resolvedStart = resolveActivityHistoryStart(new Date(uniqueSeeds[0]));
  } else {
    resolvedStart = resolveActivityHistoryStart(null);
  }

  if (resolvedStart) {
    setCachedAccountActivityStart(cacheKey, resolvedStart.getTime());
  }

  if (ENABLE_QUESTRADE_API_DEBUG && resolvedStart) {
    const seedSummaries = uniqueSeeds.map(function (ms) {
      return new Date(ms).toISOString();
    });
    console.log(
      '[Questrade][activitiesSeed]',
      accountId,
      'seeds',
      seedSummaries,
      'start',
      resolvedStart.toISOString(),
      earliestTimestampMs ? 'firstActivity' : 'firstActivityMissing',
      earliestTimestampMs ? new Date(earliestTimestampMs).toISOString() : 'none'
    );
  }

  return resolvedStart;
}

async function fetchAllAccountActivities(login, accountId, options = {}) {
  if (!login || !accountId) {
    return [];
  }

  const now = new Date();
  const start = await resolveAccountActivityHistoryStart(login, accountId, options);
  const windows = buildActivityWindows(start, now, NET_DEPOSIT_ACTIVITY_WINDOW_DAYS);
  const activities = [];

  if (ENABLE_QUESTRADE_API_DEBUG) {
    console.log(
      '[Questrade][activitiesWindowPlan]',
      accountId,
      'start',
      start.toISOString(),
      'end',
      now.toISOString(),
      'windows',
      windows.length
    );
  }

  for (const window of windows) {
    try {
      const batch = await fetchActivitiesWindow(login, accountId, window.start, window.end);
      if (batch.length) {
        activities.push(...batch);
      }
    } catch (error) {
      console.warn(
        'Failed to fetch activities for account ' + accountId + ' (' + resolveLoginDisplay(login) + '):',
        error.message || error
      );
      throw error;
    }
  }

  return activities;
}

function accumulateNetDeposits(activities) {
  const totals = new Map();
  const counts = new Map();
  const entries = [];
  const debugEntries = ENABLE_QUESTRADE_API_DEBUG ? [] : null;
  const skippedEntries = ENABLE_QUESTRADE_API_DEBUG ? [] : null;

  activities.forEach((activity) => {
    const currency = resolveActivityCurrency(activity);
    if (!currency) {
      return;
    }

    const classification = classifyNetDepositActivity(activity);
    if (!classification) {
      return;
    }

    const amountInfo = resolveActivityAmountForNetDeposits(activity);
    let amount = amountInfo ? amountInfo.amount : 0;
    if (!isFiniteNumber(amount) || Math.abs(amount) <= 1e-9) {
      if (skippedEntries) {
        skippedEntries.push({
          timestamp: resolveActivityTimestamp(activity),
          currency: currency.toUpperCase(),
          classification,
          type: activity && activity.type ? String(activity.type) : null,
          action: activity && activity.action ? String(activity.action) : null,
          description: activity && activity.description ? String(activity.description) : null,
          rawNetAmount: parseNumericValue(activity && activity.netAmount) || 0,
          amountSource: amountInfo ? amountInfo.source || null : null,
          quantity: amountInfo && isFiniteNumber(amountInfo.quantity) ? amountInfo.quantity : null,
          quantitySource: amountInfo ? amountInfo.quantitySource || null : null,
          price: amountInfo && isFiniteNumber(amountInfo.price) ? amountInfo.price : null,
          priceSource: amountInfo ? amountInfo.priceSource || null : null,
        });
      }
      return;
    }

    if (classification === 'inflow' && amount < 0) {
      amount = -amount;
    } else if (classification === 'outflow' && amount > 0) {
      amount = -amount;
    }

    const normalizedCurrency = currency.toUpperCase();
    const currentTotal = totals.get(normalizedCurrency) || 0;
    totals.set(normalizedCurrency, currentTotal + amount);
    counts.set(normalizedCurrency, (counts.get(normalizedCurrency) || 0) + 1);

    const timestamp = resolveActivityTimestamp(activity);
    const timestampMs =
      timestamp instanceof Date && !Number.isNaN(timestamp.valueOf()) ? timestamp.getTime() : null;
    entries.push({
      timestamp: timestampMs,
      currency: normalizedCurrency,
      amount,
      classification,
      amountSource: amountInfo ? amountInfo.source || null : null,
    });

    if (debugEntries) {
      debugEntries.push({
        timestamp: resolveActivityTimestamp(activity),
        currency: normalizedCurrency,
        amount,
        rawNetAmount: parseNumericValue(activity && activity.netAmount) || 0,
        classification,
        type: activity && activity.type ? String(activity.type) : null,
        action: activity && activity.action ? String(activity.action) : null,
        description: activity && activity.description ? String(activity.description) : null,
        amountSource: amountInfo ? amountInfo.source || null : null,
        estimatedAmount: amountInfo && amountInfo.source !== 'netAmount' ? amountInfo.amount : null,
        quantity: amountInfo && isFiniteNumber(amountInfo.quantity) ? amountInfo.quantity : null,
        quantitySource: amountInfo ? amountInfo.quantitySource || null : null,
        price: amountInfo && isFiniteNumber(amountInfo.price) ? amountInfo.price : null,
        priceSource: amountInfo ? amountInfo.priceSource || null : null,
      });
    }
  });

  return { totals, counts, entries, details: debugEntries, skipped: skippedEntries };
}

async function resolveFxSymbolInfo(login, sourceCurrency, targetCurrency) {
  const normalizedSource = normalizeCurrencyCode(sourceCurrency);
  const normalizedTarget = normalizeCurrencyCode(targetCurrency);
  if (!normalizedSource || !normalizedTarget) {
    return null;
  }
  if (normalizedSource === normalizedTarget) {
    return {
      symbolId: null,
      symbol: null,
      orientation: 'identity',
      sourceCurrency: normalizedSource,
      targetCurrency: normalizedTarget,
    };
  }

  const cached = getCachedFxSymbol(normalizedSource, normalizedTarget);
  if (cached !== null && cached !== undefined) {
    return cached;
  }

  const queries = buildFxSymbolSearchQueries(normalizedSource, normalizedTarget);
  for (const query of queries) {
    const params = { prefix: query };
    let data;
    try {
      data = await questradeRequest(login, '/v1/symbols/search', { params });
    } catch (error) {
      continue;
    }
    const symbols = Array.isArray(data && data.symbols) ? data.symbols : [];
    const orientationHint = inferFxOrientation(query, normalizedSource, normalizedTarget);
    const match = findFxSymbolMatch(symbols, normalizedSource, normalizedTarget, orientationHint);
    if (match) {
      const resolved = Object.assign({}, match, {
        sourceCurrency: normalizedSource,
        targetCurrency: normalizedTarget,
      });
      setCachedFxSymbol(normalizedSource, normalizedTarget, resolved);
      return resolved;
    }
  }

  setCachedFxSymbol(normalizedSource, normalizedTarget, null);
  return null;
}

async function fetchFxCandles(login, symbolId, startDate, endDate) {
  if (!login || symbolId === null || symbolId === undefined) {
    return [];
  }
  if (!(startDate instanceof Date) || Number.isNaN(startDate.valueOf())) {
    return [];
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.valueOf())) {
    return [];
  }

  const params = { interval: 'OneDay' };
  const startTime = formatActivityTimestamp(startDate);
  const endTime = formatActivityTimestamp(endDate);
  if (startTime) {
    params.startTime = startTime;
  }
  if (endTime) {
    params.endTime = endTime;
  }

  try {
    const data = await questradeRequest(login, '/v1/markets/candles/' + symbolId, { params });
    return Array.isArray(data && data.candles) ? data.candles : [];
  } catch (error) {
    if (ENABLE_QUESTRADE_API_DEBUG) {
      console.warn(
        'Failed to fetch FX candles for symbol ' + symbolId + ':',
        error && error.message ? error.message : error
      );
    }
    return [];
  }
}

function resolveCandleTimestamp(candle) {
  const preferred = ['start', 'startTime', 'time', 'date', 'timestamp', 'begin'];
  return resolveTimestampFromObject(candle, preferred);
}

function extractCandleClose(candle) {
  if (!candle || typeof candle !== 'object') {
    return null;
  }
  const fields = ['close', 'closePrice', 'last', 'value', 'price'];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(candle, field)) {
      continue;
    }
    const value = parseNumericValue(candle[field]);
    if (isFiniteNumber(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function selectFxCandle(candles, targetDate) {
  if (!Array.isArray(candles) || !candles.length) {
    return null;
  }
  const targetStart = getUtcStartOfDay(targetDate);
  const targetEnd = getUtcEndOfDay(targetDate);
  if (!targetStart || !targetEnd) {
    return candles[0] || null;
  }
  const startMs = targetStart.getTime();
  const endMs = targetEnd.getTime();
  let exact = null;
  let exactMs = null;
  let before = null;
  let beforeMs = null;
  let after = null;
  let afterMs = null;

  candles.forEach((candle) => {
    const timestamp = resolveCandleTimestamp(candle);
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
      return;
    }
    const ms = timestamp.getTime();
    if (ms >= startMs && ms <= endMs) {
      if (exact === null || ms < exactMs) {
        exact = candle;
        exactMs = ms;
      }
      return;
    }
    if (ms < startMs) {
      if (before === null || ms > beforeMs) {
        before = candle;
        beforeMs = ms;
      }
      return;
    }
    if (ms > endMs) {
      if (after === null || ms < afterMs) {
        after = candle;
        afterMs = ms;
      }
    }
  });

  return exact || before || after || candles[0] || null;
}

async function resolveHistoricalFxRate(login, sourceCurrency, targetCurrency, timestamp, options = {}) {
  const normalizedSource = normalizeCurrencyCode(sourceCurrency);
  const normalizedTarget = normalizeCurrencyCode(targetCurrency);
  const includeMetadata = Boolean(options && options.returnMetadata);

  if (!normalizedSource || !normalizedTarget) {
    return includeMetadata ? { rate: null, source: 'invalid-currency', dateKey: null, symbolInfo: null } : null;
  }

  if (normalizedSource === normalizedTarget) {
    if (includeMetadata) {
      return {
        rate: 1,
        source: 'identity',
        dateKey: formatFxDateKey(timestamp instanceof Date ? timestamp : new Date()),
        symbolInfo: {
          symbolId: null,
          symbol: null,
          orientation: 'identity',
          sourceCurrency: normalizedSource,
          targetCurrency: normalizedTarget,
        },
      };
    }
    return 1;
  }

  const symbolInfo = await resolveFxSymbolInfo(login, normalizedSource, normalizedTarget);
  let resolvedSymbolInfo = symbolInfo || null;

  if (symbolInfo) {
    const candidateDates = [];
    if (timestamp instanceof Date && !Number.isNaN(timestamp.valueOf())) {
      candidateDates.push({ date: timestamp, tag: 'historical' });
    }
    const now = new Date();
    const nowTag = candidateDates.length ? 'fallback-latest' : 'historical';
    candidateDates.push({ date: now, tag: nowTag });

    for (const candidate of candidateDates) {
      const dayKey = formatFxDateKey(candidate.date);
      if (!dayKey) {
        continue;
      }
      const cached = getCachedFxRate(symbolInfo.symbolId, dayKey);
      if (cached !== null && cached !== undefined) {
        if (includeMetadata) {
          return {
            rate: cached,
            source: candidate.tag,
            dateKey: dayKey,
            symbolInfo,
          };
        }
        return cached;
      }
      const dayStart = getUtcStartOfDay(candidate.date);
      const dayEnd = getUtcEndOfDay(candidate.date);
      if (!dayStart || !dayEnd) {
        continue;
      }
      const rangeStart = new Date(dayStart.getTime() - FX_CANDLE_LOOKBACK_DAYS * MS_PER_DAY);
      const rangeEnd = new Date(dayEnd.getTime() + FX_CANDLE_LOOKAHEAD_DAYS * MS_PER_DAY);
      const candles = await fetchFxCandles(login, symbolInfo.symbolId, rangeStart, rangeEnd);
      const candle = selectFxCandle(candles, candidate.date);
      const close = extractCandleClose(candle);
      if (!isFiniteNumber(close) || close <= 0) {
        continue;
      }
      let rate = close;
      if (symbolInfo.orientation === 'inverse') {
        rate = 1 / close;
      }
      if (!isFiniteNumber(rate) || rate <= 0) {
        continue;
      }
      setCachedFxRate(symbolInfo.symbolId, dayKey, rate);
      if (includeMetadata) {
        return {
          rate,
          source: candidate.tag,
          dateKey: dayKey,
          symbolInfo,
        };
      }
      return rate;
    }
  }

  const fallbackMeta = await resolveExternalHistoricalFxRateMeta(normalizedSource, normalizedTarget, timestamp);
  if (fallbackMeta && isFiniteNumber(fallbackMeta.rate) && fallbackMeta.rate > 0) {
    if (fallbackMeta.dateKey) {
      const cacheId = fallbackMeta.symbolInfo && fallbackMeta.symbolInfo.symbol
        ? `external:${fallbackMeta.symbolInfo.symbol}`
        : `external:${normalizedSource}:${normalizedTarget}`;
      setCachedFxRate(cacheId, fallbackMeta.dateKey, fallbackMeta.rate);
    }
    if (includeMetadata) {
      return fallbackMeta;
    }
    return fallbackMeta.rate;
  }

  if (includeMetadata) {
    const failureSource = symbolInfo ? 'unavailable' : 'missing-symbol';
    return { rate: null, source: failureSource, dateKey: null, symbolInfo: resolvedSymbolInfo };
  }
  return null;
}

async function augmentNetDepositSummaryWithHistoricalConversions(login, summary, options = {}) {
  if (!summary || typeof summary !== 'object') {
    return summary;
  }

  const baseCurrency = normalizeCurrencyCode(options.baseCurrency, 'CAD') || 'CAD';
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  const convertedTotals = new Map();
  const fxDetails = ENABLE_QUESTRADE_API_DEBUG ? [] : null;
  const fxSkipped = ENABLE_QUESTRADE_API_DEBUG ? [] : null;
  const localRateCache = new Map();

  for (const entry of entries) {
    const amount = entry && entry.amount;
    const currency = normalizeCurrencyCode(entry && entry.currency);
    if (!isFiniteNumber(amount) || Math.abs(amount) <= 1e-9 || !currency) {
      continue;
    }

    if (currency === baseCurrency) {
      convertedTotals.set(baseCurrency, (convertedTotals.get(baseCurrency) || 0) + amount);
      if (fxDetails) {
        fxDetails.push({
          timestamp: Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toISOString() : null,
          sourceCurrency: currency,
          targetCurrency: baseCurrency,
          amount,
          rate: 1,
          convertedAmount: amount,
          rateSource: 'identity',
          dateKey: entry.timestamp ? formatFxDateKey(new Date(entry.timestamp)) : null,
          symbol: null,
          symbolId: null,
          orientation: 'identity',
        });
      }
      continue;
    }

    const timestamp = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp) : null;
    const dateKey = timestamp ? formatFxDateKey(timestamp) : null;
    const dateCacheKey = dateKey ? `${currency}:${baseCurrency}:${dateKey}` : null;
    const latestCacheKey = `${currency}:${baseCurrency}:latest`;

    let meta = null;
    if (dateCacheKey && localRateCache.has(dateCacheKey)) {
      meta = localRateCache.get(dateCacheKey);
    } else if (localRateCache.has(latestCacheKey)) {
      meta = localRateCache.get(latestCacheKey);
    }

    if (!meta) {
      meta = await resolveHistoricalFxRate(login, currency, baseCurrency, timestamp, { returnMetadata: true });
      const targetCacheKey = dateCacheKey || latestCacheKey;
      localRateCache.set(targetCacheKey, meta);
      if (dateCacheKey && meta && meta.source === 'fallback-latest') {
        localRateCache.set(latestCacheKey, meta);
      }
    }

    const effectiveRate = meta && isFiniteNumber(meta.rate) && meta.rate > 0 ? meta.rate : null;
    if (!effectiveRate) {
      if (fxSkipped) {
        fxSkipped.push({
          timestamp: timestamp ? timestamp.toISOString() : null,
          sourceCurrency: currency,
          targetCurrency: baseCurrency,
          amount,
          reason: meta && meta.source ? meta.source : 'missing-rate',
        });
      }
      continue;
    }

    convertedTotals.set(baseCurrency, (convertedTotals.get(baseCurrency) || 0) + amount * effectiveRate);

    if (fxDetails) {
      fxDetails.push({
        timestamp: timestamp ? timestamp.toISOString() : null,
        sourceCurrency: currency,
        targetCurrency: baseCurrency,
        amount,
        rate: effectiveRate,
        convertedAmount: amount * effectiveRate,
        rateSource: meta.source || 'historical',
        dateKey: meta.dateKey || dateKey,
        symbol: meta.symbolInfo ? meta.symbolInfo.symbol : null,
        symbolId: meta.symbolInfo ? meta.symbolInfo.symbolId : null,
        orientation: meta.symbolInfo ? meta.symbolInfo.orientation : null,
      });
    }
  }

  if (!convertedTotals.has(baseCurrency)) {
    convertedTotals.set(baseCurrency, 0);
  }

  summary.historicalConvertedTotals = convertedTotals;
  if (fxDetails) {
    summary.fxDetails = fxDetails;
  }
  if (fxSkipped) {
    summary.fxSkipped = fxSkipped;
  }
  return summary;
}

function getCachedNetDeposits(key) {
  const entry = netDepositCache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > NET_DEPOSIT_CACHE_TTL_MS) {
    netDepositCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedNetDeposits(key, value) {
  netDepositCache.set(key, { timestamp: Date.now(), value });
}

function convertMapToObject(map) {
  const result = {};
  if (!(map instanceof Map)) {
    return result;
  }
  map.forEach((value, key) => {
    if (typeof key !== 'string') {
      return;
    }
    const normalizedKey = key.toUpperCase();
    if (!isFiniteNumber(value) && value !== 0) {
      return;
    }
    result[normalizedKey] = value;
  });
  return result;
}

async function fetchAccountNetDeposits(login, accountId, options = {}) {
  const cacheKey = getNetDepositCacheKey(login && login.id, accountId);
  const cached = getCachedNetDeposits(cacheKey);
  if (cached) {
    return cached;
  }

  const activities = await fetchAllAccountActivities(login, accountId, options);
  const summary = accumulateNetDeposits(activities);
  const baseCurrency = normalizeCurrencyCode(options.baseCurrency, 'CAD') || 'CAD';
  await augmentNetDepositSummaryWithHistoricalConversions(login, summary, { baseCurrency });
  if (ENABLE_QUESTRADE_API_DEBUG && summary && Array.isArray(summary.details) && summary.details.length) {
    const preview = summary.details.slice(0, 20).map((entry) => {
      return {
        timestamp: entry.timestamp ? new Date(entry.timestamp).toISOString() : null,
        currency: entry.currency,
        amount: entry.amount,
        classification: entry.classification,
        type: entry.type,
        action: entry.action,
        description: entry.description,
        amountSource: entry.amountSource || null,
        rawNetAmount: entry.rawNetAmount || 0,
        estimatedAmount: entry.estimatedAmount || null,
        quantity: entry.quantity || null,
        quantitySource: entry.quantitySource || null,
        price: entry.price || null,
        priceSource: entry.priceSource || null,
      };
    });
    console.log('[Questrade][netDepositEntries]', accountId, preview);
    if (summary.details.length > preview.length) {
      console.log('[Questrade][netDepositEntries]', accountId, '…', summary.details.length - preview.length, 'more entries');
    }
  }
  if (ENABLE_QUESTRADE_API_DEBUG && summary && Array.isArray(summary.skipped) && summary.skipped.length) {
    const skippedPreview = summary.skipped.slice(0, 20).map((entry) => {
      return {
        timestamp: entry.timestamp ? new Date(entry.timestamp).toISOString() : null,
        currency: entry.currency,
        classification: entry.classification,
        type: entry.type,
        action: entry.action,
        description: entry.description,
        rawNetAmount: entry.rawNetAmount || 0,
        amountSource: entry.amountSource || null,
        quantity: entry.quantity || null,
        quantitySource: entry.quantitySource || null,
        price: entry.price || null,
        priceSource: entry.priceSource || null,
      };
    });
    console.log('[Questrade][netDepositEntriesSkipped]', accountId, skippedPreview);
    if (summary.skipped.length > skippedPreview.length) {
      console.log('[Questrade][netDepositEntriesSkipped]', accountId, '…', summary.skipped.length - skippedPreview.length, 'more entries');
    }
  }
  if (ENABLE_QUESTRADE_API_DEBUG && summary && Array.isArray(summary.fxDetails) && summary.fxDetails.length) {
    const fxPreview = summary.fxDetails.slice(0, 20).map((entry) => ({
      timestamp: entry.timestamp,
      sourceCurrency: entry.sourceCurrency,
      targetCurrency: entry.targetCurrency,
      amount: entry.amount,
      rate: entry.rate,
      convertedAmount: entry.convertedAmount,
      rateSource: entry.rateSource,
      dateKey: entry.dateKey || null,
      symbol: entry.symbol || null,
      symbolId: entry.symbolId || null,
      orientation: entry.orientation || null,
    }));
    console.log('[Questrade][netDepositFx]', accountId, fxPreview);
    if (summary.fxDetails.length > fxPreview.length) {
      console.log('[Questrade][netDepositFx]', accountId, '…', summary.fxDetails.length - fxPreview.length, 'more entries');
    }
  }
  if (ENABLE_QUESTRADE_API_DEBUG && summary && Array.isArray(summary.fxSkipped) && summary.fxSkipped.length) {
    const skippedFxPreview = summary.fxSkipped.slice(0, 20).map((entry) => ({
      timestamp: entry.timestamp,
      sourceCurrency: entry.sourceCurrency,
      targetCurrency: entry.targetCurrency,
      amount: entry.amount,
      reason: entry.reason,
    }));
    console.log('[Questrade][netDepositFxSkipped]', accountId, skippedFxPreview);
    if (summary.fxSkipped.length > skippedFxPreview.length) {
      console.log('[Questrade][netDepositFxSkipped]', accountId, '…', summary.fxSkipped.length - skippedFxPreview.length, 'more entries');
    }
  }
  setCachedNetDeposits(cacheKey, summary);
  return summary;
}


const BALANCE_NUMERIC_FIELDS = [
  'totalEquity',
  'marketValue',
  'cash',
  'buyingPower',
  'maintenanceExcess',
  'dayPnl',
  'openPnl',
  'totalPnl',
  'totalCost',
  'realizedPnl',
  'unrealizedPnl',
];

const BALANCE_FIELD_ALIASES = {
  dayPnl: ['dayPnL'],
  openPnl: ['openPnL'],
  totalPnl: ['totalPnL', 'totalPnLInBase', 'totalReturn'],
  realizedPnl: ['realizedPnL'],
  unrealizedPnl: ['unrealizedPnL'],
};

function createEmptyBalanceAccumulator(currency) {
  const base = { currency: currency || null, isRealTime: false, __fieldCounts: Object.create(null) };
  BALANCE_NUMERIC_FIELDS.forEach(function (field) {
    base[field] = 0;
    base.__fieldCounts[field] = 0;
  });
  return base;
}

function markBalanceFieldPresent(target, field) {
  if (!target.__fieldCounts) {
    target.__fieldCounts = Object.create(null);
  }
  target.__fieldCounts[field] = (target.__fieldCounts[field] || 0) + 1;
}

function pickNumericValue(source, key) {
  if (!source) {
    return null;
  }
  const direct = source[key];
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  const aliases = BALANCE_FIELD_ALIASES[key] || [];
  for (const alias of aliases) {
    const value = source[alias];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function accumulateBalance(target, source) {
  BALANCE_NUMERIC_FIELDS.forEach(function (field) {
    const value = pickNumericValue(source, field);
    if (value !== null) {
      const current = typeof target[field] === 'number' && Number.isFinite(target[field]) ? target[field] : 0;
      target[field] = current + value;
      markBalanceFieldPresent(target, field);
    }
  });
  if (source && typeof source.isRealTime === 'boolean') {
    target.isRealTime = target.isRealTime || source.isRealTime;
  }
}

async function fetchSymbolsDetails(login, symbolIds) {
  if (!symbolIds.length) {
    return {};
  }

  const batches = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < symbolIds.length; i += BATCH_SIZE) {
    batches.push(symbolIds.slice(i, i + BATCH_SIZE));
  }

  const results = {};
  for (const batch of batches) {
    const idsParam = batch.join(',');
    const data = await questradeRequest(login, '/v1/symbols', { params: { ids: idsParam } });
    (data.symbols || []).forEach(function (symbol) {
      results[symbol.symbolId] = symbol;
    });
  }
  return results;
}

function mergeBalances(allBalances) {
  const summary = {
    combined: {},
    perCurrency: {},
  };

  allBalances.forEach(function (balanceEntry) {
    const combinedBalances = balanceEntry && (balanceEntry.combinedBalances || []);
    const perCurrencyBalances = balanceEntry && (balanceEntry.perCurrencyBalances || []);

    combinedBalances.forEach(function (balance) {
      const currency = balance && balance.currency;
      if (!currency) {
        return;
      }
      if (!summary.combined[currency]) {
        summary.combined[currency] = createEmptyBalanceAccumulator(currency);
      }
      accumulateBalance(summary.combined[currency], balance);
    });

    perCurrencyBalances.forEach(function (balance) {
      const currency = balance && balance.currency;
      if (!currency) {
        return;
      }
      if (!summary.perCurrency[currency]) {
        summary.perCurrency[currency] = createEmptyBalanceAccumulator(currency);
      }
      accumulateBalance(summary.perCurrency[currency], balance);
    });
  });

  return summary;
}

function summarizeAccountCombinedBalances(balanceEntry) {
  const summary = mergeBalances([balanceEntry]);
  finalizeBalances(summary);
  if (!summary || !summary.combined) {
    return null;
  }
  const combined = summary.combined;
  if (!combined || typeof combined !== 'object' || !Object.keys(combined).length) {
    return null;
  }
  return combined;
}

function finalizeBalances(summary) {
  if (!summary) {
    return summary;
  }
  ['combined', 'perCurrency'].forEach(function (scope) {
    const bucket = summary[scope];
    if (!bucket) {
      return;
    }
    Object.values(bucket).forEach(function (entry) {
      if (!entry || !entry.__fieldCounts) {
        return;
      }
      BALANCE_NUMERIC_FIELDS.forEach(function (field) {
        const count = entry.__fieldCounts[field] || 0;
        if (count === 0) {
          delete entry[field];
        }
      });
      delete entry.__fieldCounts;
    });
  });
  return summary;
}

function normalizeCurrencyCode(currency, fallback = null) {
  if (typeof currency !== 'string') {
    return fallback;
  }
  const trimmed = currency.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.toUpperCase();
}

function findBalanceEntryKey(bucket, currency) {
  if (!bucket || !currency) {
    return null;
  }
  const normalized = normalizeCurrencyCode(currency);
  if (!normalized) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(bucket, normalized)) {
    return normalized;
  }
  for (const key of Object.keys(bucket)) {
    if (typeof key === 'string' && key.toUpperCase() === normalized) {
      return key;
    }
  }
  return null;
}

function getBalanceEntry(bucket, currency) {
  const key = findBalanceEntryKey(bucket, currency);
  if (!key) {
    return null;
  }
  return bucket[key] || null;
}

function deriveExchangeRate(perEntry, combinedEntry, baseCombinedEntry) {
  if (!perEntry && !combinedEntry) {
    return null;
  }

  const directFields = ['exchangeRate', 'fxRate', 'conversionRate', 'rate'];
  for (const field of directFields) {
    const candidate = (perEntry && perEntry[field]) ?? (combinedEntry && combinedEntry[field]) ?? null;
    if (isFiniteNumber(candidate) && candidate > 0) {
      return candidate;
    }
  }

  if (baseCombinedEntry && combinedEntry) {
    const baseFields = ['totalEquity', 'marketValue', 'cash', 'buyingPower'];
    for (const field of baseFields) {
      const baseValue = baseCombinedEntry[field];
      const currencyValue = combinedEntry[field];
      if (!isFiniteNumber(baseValue) || !isFiniteNumber(currencyValue)) {
        continue;
      }
      if (Math.abs(currencyValue) <= 1e-9) {
        continue;
      }
      const ratio = baseValue / currencyValue;
      if (isFiniteNumber(ratio) && Math.abs(ratio) > 1e-9) {
        return Math.abs(ratio);
      }
    }
  }

  const ratioSources = [
    ['totalEquity', 'totalEquity'],
    ['marketValue', 'marketValue'],
  ];

  for (const [perField, combinedField] of ratioSources) {
    const perValue = perEntry ? perEntry[perField] : null;
    const combinedValue = combinedEntry ? combinedEntry[combinedField] : null;
    if (!isFiniteNumber(perValue) || !isFiniteNumber(combinedValue)) {
      continue;
    }
    if (Math.abs(perValue) <= 1e-9 || Math.abs(combinedValue) <= 1e-9) {
      continue;
    }
    const ratio = combinedValue / perValue;
    if (isFiniteNumber(ratio) && Math.abs(ratio) > 1e-9) {
      return Math.abs(ratio);
    }
  }

  return null;
}

function buildCurrencyRateMapFromSummary(summary, baseCurrency = 'CAD') {
  const normalizedBase = normalizeCurrencyCode(baseCurrency, 'CAD') || 'CAD';
  const rates = new Map();
  rates.set(normalizedBase, 1);

  if (!summary || typeof summary !== 'object') {
    return rates;
  }

  const combined = summary.combined || {};
  const perCurrency = summary.perCurrency || {};
  const baseCombinedEntry = getBalanceEntry(combined, normalizedBase);
  const allKeys = new Set([...Object.keys(combined || {}), ...Object.keys(perCurrency || {})]);

  allKeys.forEach((key) => {
    if (!key) {
      return;
    }
    const normalizedKey = normalizeCurrencyCode(key, normalizedBase);
    if (!normalizedKey || rates.has(normalizedKey)) {
      return;
    }
    const perEntry = getBalanceEntry(perCurrency, normalizedKey);
    const combinedEntry = getBalanceEntry(combined, normalizedKey);
    const derived = deriveExchangeRate(perEntry, combinedEntry, baseCombinedEntry);
    if (derived && derived > 0) {
      rates.set(normalizedKey, derived);
      return;
    }
    if (normalizedKey === normalizedBase) {
      rates.set(normalizedKey, 1);
    }
  });

  return rates;
}

function convertAmountToCurrency(value, sourceCurrency, targetCurrency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  const normalizedBase = normalizeCurrencyCode(baseCurrency, 'CAD') || 'CAD';
  const normalizedSource = normalizeCurrencyCode(sourceCurrency, normalizedBase) || normalizedBase;
  const normalizedTarget = normalizeCurrencyCode(targetCurrency, normalizedBase) || normalizedBase;

  const sourceRate = currencyRates && currencyRates.get(normalizedSource);
  let baseValue = null;
  if (isFiniteNumber(sourceRate) && sourceRate > 0) {
    baseValue = value * sourceRate;
  } else if (normalizedSource === normalizedBase) {
    baseValue = value;
  }

  if (baseValue === null) {
    return 0;
  }

  if (normalizedTarget === normalizedBase) {
    return baseValue;
  }

  const targetRate = currencyRates && currencyRates.get(normalizedTarget);
  if (isFiniteNumber(targetRate) && targetRate > 0) {
    return baseValue / targetRate;
  }

  return baseValue;
}

function applyTotalPnlToBalanceSummary(summary, totals) {
  if (!summary || typeof summary !== 'object' || !totals) {
    return;
  }

  if (totals.perCurrency && summary.perCurrency) {
    Object.entries(totals.perCurrency).forEach(([currency, value]) => {
      if (!isFiniteNumber(value) && value !== 0) {
        return;
      }
      const key = findBalanceEntryKey(summary.perCurrency, currency);
      if (!key || !summary.perCurrency[key] || typeof summary.perCurrency[key] !== 'object') {
        return;
      }
      summary.perCurrency[key].totalPnl = value;
    });
  }

  if (totals.combined && summary.combined) {
    Object.entries(totals.combined).forEach(([currency, value]) => {
      if (!isFiniteNumber(value) && value !== 0) {
        return;
      }
      const key = findBalanceEntryKey(summary.combined, currency);
      if (!key || !summary.combined[key] || typeof summary.combined[key] !== 'object') {
        return;
      }
      summary.combined[key].totalPnl = value;
    });
  }
}

function computeAccountTotalPnlSummary(balanceSummary, netDeposits, options = {}) {
  if (!balanceSummary || typeof balanceSummary !== 'object' || !netDeposits) {
    return null;
  }
  const totalsMap = netDeposits.totals instanceof Map ? netDeposits.totals : null;
  const countsMap = netDeposits.counts instanceof Map ? netDeposits.counts : null;
  if (!totalsMap || totalsMap.size === 0) {
    return null;
  }
  const baseCurrency = options.baseCurrency || 'CAD';
  const normalizedBaseCurrency = normalizeCurrencyCode(baseCurrency, 'CAD') || 'CAD';
  const perCurrencyResult = {};
  const combinedResult = {};
  const netDepositPerCurrency = {};
  const netDepositCounts = convertMapToObject(countsMap);
  const combinedNetDeposits = {};
  const perCurrencyEquity = {};
  const combinedEquity = {};
  let hasValue = false;
  let hasNetDepositData = false;
  const historicalCombinedMap =
    netDeposits && netDeposits.historicalConvertedTotals instanceof Map
      ? netDeposits.historicalConvertedTotals
      : null;

  totalsMap.forEach((amount, currency) => {
    const normalized = normalizeCurrencyCode(currency);
    if (!normalized) {
      return;
    }
    if (!isFiniteNumber(amount) && amount !== 0) {
      return;
    }
    netDepositPerCurrency[normalized] = amount;
    hasNetDepositData = true;
  });

  if (balanceSummary.perCurrency && countsMap) {
    Object.entries(balanceSummary.perCurrency).forEach(([key, entry]) => {
      const normalized = normalizeCurrencyCode(key);
      if (!normalized || !countsMap.has(normalized)) {
        return;
      }
      const equity = entry && entry.totalEquity;
      if (!isFiniteNumber(equity)) {
        return;
      }
      const deposit = totalsMap.get(normalized) || 0;
      const totalPnl = equity - deposit;
      perCurrencyResult[normalized] = totalPnl;
      perCurrencyEquity[normalized] = equity;
      hasValue = true;
    });
  }

  if (balanceSummary.combined) {
    let rates = null;
    Object.entries(balanceSummary.combined).forEach(([key, entry]) => {
      const normalized = normalizeCurrencyCode(key);
      if (!normalized) {
        return;
      }
      const equity = entry && entry.totalEquity;
      if (!isFiniteNumber(equity)) {
        return;
      }
      let convertedDeposits = null;
      if (
        normalized === normalizedBaseCurrency &&
        historicalCombinedMap &&
        historicalCombinedMap.has(normalizedBaseCurrency)
      ) {
        const candidate = historicalCombinedMap.get(normalizedBaseCurrency);
        if (isFiniteNumber(candidate)) {
          convertedDeposits = candidate;
        }
      }
      if (!isFiniteNumber(convertedDeposits)) {
        if (!rates) {
          rates = buildCurrencyRateMapFromSummary(balanceSummary, baseCurrency);
        }
        let fallbackDeposits = 0;
        totalsMap.forEach((amount, sourceCurrency) => {
          fallbackDeposits += convertAmountToCurrency(amount, sourceCurrency, normalized, rates, baseCurrency);
        });
        convertedDeposits = fallbackDeposits;
      }
      combinedResult[normalized] = equity - convertedDeposits;
      combinedEquity[normalized] = equity;
      if (hasNetDepositData) {
        combinedNetDeposits[normalized] = convertedDeposits;
      }
      hasValue = true;
    });
  }

  if (!hasValue && !hasNetDepositData) {
    return null;
  }

  const result = {
    perCurrency: perCurrencyResult,
    combined: combinedResult,
    netDeposits: {
      perCurrency: netDepositPerCurrency,
      combined: combinedNetDeposits,
      counts: netDepositCounts,
    },
    equity: {
      perCurrency: perCurrencyEquity,
      combined: combinedEquity,
    },
  };

  return result;
}

function mergePnL(positions, totalPnlValue = null) {
  const summary = positions.reduce(
    function (acc, position) {
      acc.dayPnl += position.dayPnl || 0;
      acc.openPnl += position.openPnl || 0;
      return acc;
    },
    { dayPnl: 0, openPnl: 0 }
  );
  if (isFiniteNumber(totalPnlValue) || totalPnlValue === 0) {
    summary.totalPnl = totalPnlValue;
  } else {
    summary.totalPnl = null;
  }
  return summary;
}

function buildInvestmentModelPositions(positions, accountId) {
  if (!Array.isArray(positions) || !accountId) {
    return [];
  }

  const normalizedAccountId = String(accountId);
  const results = [];

  positions.forEach(function (position) {
    if (!position || String(position.accountId) !== normalizedAccountId) {
      return;
    }
    const symbol = position.symbol ? String(position.symbol).trim() : null;
    if (!symbol) {
      return;
    }
    const marketValue = Number(position.currentMarketValue);
    if (!Number.isFinite(marketValue)) {
      return;
    }
    const entry = { symbol, dollars: marketValue };
    const shares = Number(position.openQuantity);
    if (Number.isFinite(shares) && shares !== 0) {
      entry.shares = shares;
    }
    if (Math.abs(entry.dollars) < 0.01 && (!entry.shares || Math.abs(entry.shares) < 0.01)) {
      return;
    }
    results.push(entry);
  });

  return results;
}

function findAccountCadBalance(accountId, perAccountBalances) {
  if (!accountId || !perAccountBalances) {
    return null;
  }

  const balances = perAccountBalances[accountId];
  if (!balances || typeof balances !== 'object') {
    return null;
  }

  const cadKey = Object.keys(balances).find(function (key) {
    return key && typeof key === 'string' && key.toUpperCase() === 'CAD';
  });
  if (!cadKey) {
    return null;
  }
  const cadBalance = balances[cadKey];
  if (!cadBalance || typeof cadBalance !== 'object') {
    return null;
  }
  return cadBalance;
}

function extractCadMarketValue(balanceEntry) {
  if (!balanceEntry || typeof balanceEntry !== 'object') {
    return null;
  }
  const preferredFields = ['marketValue', 'totalEquity', 'cash'];
  for (const field of preferredFields) {
    const value = Number(balanceEntry[field]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function buildInitialInvestmentModelPositions(account, perAccountBalances) {
  const cadBalance = findAccountCadBalance(account.id, perAccountBalances);
  if (!cadBalance) {
    return { positions: [], reserveSymbol: 'SGOV' };
  }
  const cadValue = extractCadMarketValue(cadBalance);
  if (!Number.isFinite(cadValue)) {
    return { positions: [], reserveSymbol: 'SGOV' };
  }
  return {
    positions: [
      {
        symbol: 'SGOV',
        dollars: cadValue,
      },
    ],
    reserveSymbol: 'SGOV',
  };
}

function buildInvestmentModelRequest(account, positions, perAccountBalances) {
  if (!account || !account.investmentModel) {
    return null;
  }

  const modelKey = String(account.investmentModel).trim();
  if (!modelKey) {
    return null;
  }

  const requestDate = new Date().toISOString().slice(0, 10);
  const payload = {
    experiment: modelKey,
    request_date: requestDate,
  };

  if (account.investmentModelLastRebalance) {
    payload.positions = buildInvestmentModelPositions(positions, account.id);
    payload.last_rebalance = account.investmentModelLastRebalance;
  } else {
    const initial = buildInitialInvestmentModelPositions(account, perAccountBalances);
    payload.positions = initial.positions;
    if (initial.reserveSymbol) {
      payload.reserve_symbol = initial.reserveSymbol;
    }
  }

  return payload;
}

function decoratePositions(positions, symbolsMap, accountsMap) {
  return positions.map(function (position) {
    const symbolInfo = symbolsMap[position.symbolId];
    const accountInfo = accountsMap[position.accountId] || accountsMap[position.accountNumber] || null;
    return {
      accountId: position.accountId,
      accountNumber: position.accountNumber || (accountInfo ? accountInfo.number : null),
      accountType: accountInfo ? accountInfo.type : null,
      accountPrimary: accountInfo ? accountInfo.isPrimary : null,
      accountOwnerId: accountInfo ? accountInfo.loginId || accountInfo.ownerId || null : null,
      accountOwnerLabel: accountInfo ? accountInfo.ownerLabel || accountInfo.loginLabel || null : null,
      accountOwnerEmail: accountInfo ? accountInfo.ownerEmail || accountInfo.loginEmail || null : null,
      loginId: position.loginId || (accountInfo ? accountInfo.loginId : null),
      symbol: position.symbol,
      symbolId: position.symbolId,
      description: symbolInfo ? symbolInfo.description : null,
      currency: position.currency || (symbolInfo ? symbolInfo.currency : null),
      openQuantity: position.openQuantity,
      currentPrice: position.currentPrice,
      currentMarketValue: position.currentMarketValue,
      averageEntryPrice: position.averageEntryPrice,
      dayPnl: position.dayPnl,
      openPnl: position.openPnl,
      totalCost: position.totalCost,
      isRealTime: position.isRealTime,
    };
  });
}

app.get('/api/qqq-temperature', async function (req, res) {
  try {
    const summary = await getQqqTemperatureSummary();
    if (!summary) {
      return res.status(404).json({ message: 'QQQ temperature data unavailable' });
    }
    res.json(summary);
  } catch (error) {
    if (error && error.code === 'MISSING_DEPENDENCY') {
      return res.status(503).send(error.message);
    }
    const message = error && error.message ? error.message : 'Unknown error';
    res.status(500).json({ message: 'Failed to load QQQ temperature data', details: message });
  }
});

app.get('/api/summary', async function (req, res) {
  const requestedAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
  const includeAllAccounts = !requestedAccountId || requestedAccountId === 'all';
  const isDefaultRequested = requestedAccountId === 'default';
  const configuredDefaultKey = getDefaultAccountId();

  try {
    const accountCollections = [];
    const accountNameOverrides = getAccountNameOverrides();
    const accountPortalOverrides = getAccountPortalOverrides();
    const accountChatOverrides = getAccountChatOverrides();
    const configuredOrdering = getAccountOrdering();
    const accountSettings = getAccountSettings();
    const accountBeneficiaries = getAccountBeneficiaries();
    for (const login of allLogins) {
      const fetchedAccounts = await fetchAccounts(login);
      const normalized = fetchedAccounts.map(function (account, index) {
        const rawNumber = account.number || account.accountNumber || account.id || index;
        const number = String(rawNumber);
        const compositeId = login.id + ':' + number;
        const ownerLabel = resolveLoginDisplay(login);
        const normalizedAccount = Object.assign({}, account, {
          id: compositeId,
          number,
          accountNumber: number,
          loginId: login.id,
          ownerId: login.id,
          ownerLabel,
          ownerEmail: login.email || null,
          loginLabel: ownerLabel,
          loginEmail: login.email || null,
        });
        const inferredStartDate = inferAccountStartDate(account);
        if (inferredStartDate) {
          normalizedAccount.activityHistoryStart = inferredStartDate.toISOString();
          normalizedAccount.activityHistoryStartMs = inferredStartDate.getTime();
        }
        const displayName = resolveAccountDisplayName(accountNameOverrides, normalizedAccount, login);
        if (displayName) {
          normalizedAccount.displayName = displayName;
        }
        const overridePortalId = resolveAccountPortalId(accountPortalOverrides, normalizedAccount, login);
        if (overridePortalId) {
          normalizedAccount.portalAccountId = overridePortalId;
        }
        const overrideChatUrl = resolveAccountChatUrl(accountChatOverrides, normalizedAccount, login);
        if (overrideChatUrl) {
          normalizedAccount.chatURL = overrideChatUrl;
        } else if (normalizedAccount.chatURL === undefined) {
          normalizedAccount.chatURL = null;
        }
        const accountSettingsOverride = resolveAccountOverrideValue(accountSettings, normalizedAccount, login);
        if (typeof accountSettingsOverride === 'boolean') {
          normalizedAccount.showQQQDetails = accountSettingsOverride;
        } else if (accountSettingsOverride && typeof accountSettingsOverride === 'object') {
          if (typeof accountSettingsOverride.showQQQDetails === 'boolean') {
            normalizedAccount.showQQQDetails = accountSettingsOverride.showQQQDetails;
          }
          if (typeof accountSettingsOverride.investmentModel === 'string') {
            const trimmedModel = accountSettingsOverride.investmentModel.trim();
            if (trimmedModel) {
              normalizedAccount.investmentModel = trimmedModel;
            }
          }
          if (typeof accountSettingsOverride.lastRebalance === 'string') {
            const trimmedDate = accountSettingsOverride.lastRebalance.trim();
            if (trimmedDate) {
              normalizedAccount.investmentModelLastRebalance = trimmedDate;
            }
          } else if (
            accountSettingsOverride.lastRebalance &&
            typeof accountSettingsOverride.lastRebalance === 'object' &&
            typeof accountSettingsOverride.lastRebalance.date === 'string'
          ) {
            const trimmedDate = accountSettingsOverride.lastRebalance.date.trim();
            if (trimmedDate) {
              normalizedAccount.investmentModelLastRebalance = trimmedDate;
            }
          }
        }
        const defaultBeneficiary = accountBeneficiaries.defaultBeneficiary || null;
        if (defaultBeneficiary) {
          normalizedAccount.beneficiary = defaultBeneficiary;
        }
        const resolvedBeneficiary = resolveAccountBeneficiary(accountBeneficiaries, normalizedAccount, login);
        if (resolvedBeneficiary) {
          normalizedAccount.beneficiary = resolvedBeneficiary;
        }
        return normalizedAccount;
      });
      accountCollections.push({ login, accounts: normalized });
    }

    const defaultAccount = findDefaultAccount(accountCollections, configuredDefaultKey);

    let allAccounts = accountCollections.flatMap(function (entry) {
      return entry.accounts;
    });

    if (Array.isArray(configuredOrdering) && configuredOrdering.length) {
      const orderingMap = new Map();
      configuredOrdering.forEach(function (entry, index) {
        const normalized = entry == null ? '' : String(entry).trim();
        if (!normalized) {
          return;
        }
        if (!orderingMap.has(normalized)) {
          orderingMap.set(normalized, index);
        }
      });

      if (orderingMap.size) {
        const DEFAULT_ORDER = Number.MAX_SAFE_INTEGER;
        const resolveAccountOrder = function (account) {
          if (!account) {
            return DEFAULT_ORDER;
          }
          const candidates = [];
          if (account.number) {
            candidates.push(String(account.number).trim());
          }
          if (account.accountNumber) {
            candidates.push(String(account.accountNumber).trim());
          }
          if (account.id) {
            candidates.push(String(account.id).trim());
          }
          for (const candidate of candidates) {
            if (!candidate) {
              continue;
            }
            if (orderingMap.has(candidate)) {
              return orderingMap.get(candidate);
            }
          }
          return DEFAULT_ORDER;
        };

        allAccounts = allAccounts
          .map(function (account, index) {
            return { account, index, order: resolveAccountOrder(account) };
          })
          .sort(function (a, b) {
            if (a.order !== b.order) {
              return a.order - b.order;
            }
            return a.index - b.index;
          })
          .map(function (entry) {
            return entry.account;
          });
      }
    }

    const accountsById = {};
    allAccounts.forEach(function (account) {
      accountsById[account.id] = account;
    });

    let selectedAccounts = allAccounts;
    let resolvedAccountId = null;
    let resolvedAccountNumber = null;
    const viewingAllAccounts = includeAllAccounts || (isDefaultRequested && !defaultAccount);

    if (isDefaultRequested) {
      if (defaultAccount) {
        selectedAccounts = [defaultAccount];
      }
    } else if (!includeAllAccounts) {
      selectedAccounts = allAccounts.filter(function (account) {
        return account.id === requestedAccountId || account.number === requestedAccountId;
      });
      if (!selectedAccounts.length) {
        return res.status(404).json({ message: 'No accounts found for the provided filter.' });
      }
    }

    if (viewingAllAccounts) {
      resolvedAccountId = 'all';
    } else if (selectedAccounts.length === 1) {
      resolvedAccountId = selectedAccounts[0].id;
      resolvedAccountNumber = selectedAccounts[0].number;
    }

    const selectedContexts = selectedAccounts.map(function (account) {
      const login = loginsById[account.loginId];
      if (!login) {
        throw new Error('Unknown login ' + account.loginId + ' for account ' + account.id);
      }
      return { login, account };
    });

    const positionsResults = await Promise.all(
      selectedContexts.map(function (context) {
        return fetchPositions(context.login, context.account.number);
      })
    );
    const balancesResults = await Promise.all(
      selectedContexts.map(function (context) {
        return fetchBalances(context.login, context.account.number);
      })
    );
    const perAccountCombinedBalances = {};
    const perAccountBalanceSummaries = {};
    selectedContexts.forEach(function (context, index) {
      const accountBalancesSummary = mergeBalances([balancesResults[index]]);
      finalizeBalances(accountBalancesSummary);
      if (accountBalancesSummary && accountBalancesSummary.combined) {
        perAccountCombinedBalances[context.account.id] = accountBalancesSummary.combined;
      }
      if (accountBalancesSummary) {
        perAccountBalanceSummaries[context.account.id] = accountBalancesSummary;
      }
    });
    const flattenedPositions = positionsResults
      .map(function (positions, index) {
        const context = selectedContexts[index];
        return positions.map(function (position) {
          return Object.assign({}, position, {
            accountId: context.account.id,
            accountNumber: context.account.number,
            loginId: context.login.id,
          });
        });
      })
      .flat();

    const symbolIdsByLogin = new Map();
    flattenedPositions.forEach(function (position) {
      if (!position.symbolId) {
        return;
      }
      const loginBucket = symbolIdsByLogin.get(position.loginId) || new Set();
      loginBucket.add(position.symbolId);
      symbolIdsByLogin.set(position.loginId, loginBucket);
    });

    const symbolsMap = {};
    for (const [loginId, symbolSet] of symbolIdsByLogin.entries()) {
      const login = loginsById[loginId];
      if (!login) {
        continue;
      }
      const ids = Array.from(symbolSet);
      const details = await fetchSymbolsDetails(login, ids);
      Object.assign(symbolsMap, details);
    }

    const accountsMap = {};
    allAccounts.forEach(function (account) {
      accountsMap[account.id] = account;
    });

    const decoratedPositions = decoratePositions(flattenedPositions, symbolsMap, accountsMap);
    const balancesSummary = mergeBalances(balancesResults);
    finalizeBalances(balancesSummary);

    let computedTotalPnl = null;
    if (selectedContexts.length === 1) {
      const context = selectedContexts[0];
      const accountSummary = perAccountBalanceSummaries[context.account.id] || null;
      if (accountSummary && context.account && context.account.number) {
        try {
          const netDepositStart =
            context.account.activityHistoryStartMs || context.account.activityHistoryStart || null;
          const baseCurrency = 'CAD';
          const netDeposits = await fetchAccountNetDeposits(context.login, context.account.number, {
            startDate: netDepositStart,
            baseCurrency,
          });
          const totals = computeAccountTotalPnlSummary(accountSummary, netDeposits, { baseCurrency });
          if (totals) {
            applyTotalPnlToBalanceSummary(accountSummary, totals);
            applyTotalPnlToBalanceSummary(balancesSummary, totals);
            computedTotalPnl = totals;
            if (ENABLE_QUESTRADE_API_DEBUG) {
              console.log('[Questrade][totalPnl]', context.account.number, {
                perCurrency: totals.perCurrency,
                combined: totals.combined,
                netDeposits: totals.netDeposits,
                equity: totals.equity,
              });
            }
          }
        } catch (totalError) {
          console.warn(
            'Failed to compute total P&L for account ' + context.account.id + ':',
            totalError && totalError.message ? totalError.message : totalError
          );
        }
      }
    }

    let totalPnlOverride = null;
    if (computedTotalPnl && computedTotalPnl.combined) {
      const cadKey = findBalanceEntryKey(balancesSummary.combined, 'CAD');
      if (cadKey) {
        const cadEntry = balancesSummary.combined[cadKey];
        if (cadEntry && isFiniteNumber(cadEntry.totalPnl)) {
          totalPnlOverride = cadEntry.totalPnl;
        }
      }
      if (totalPnlOverride === null) {
        for (const value of Object.values(computedTotalPnl.combined)) {
          if (isFiniteNumber(value)) {
            totalPnlOverride = value;
            break;
          }
        }
      }
    }

    const pnl = mergePnL(flattenedPositions, totalPnlOverride);
    if (computedTotalPnl) {
      if (computedTotalPnl.perCurrency || computedTotalPnl.combined) {
        pnl.totalPnlBreakdown = {
          perCurrency: computedTotalPnl.perCurrency || {},
          combined: computedTotalPnl.combined || {},
        };
      }
      if (computedTotalPnl.netDeposits) {
        pnl.netDeposits = computedTotalPnl.netDeposits;
      }
      if (computedTotalPnl.equity) {
        pnl.totalEquityBreakdown = computedTotalPnl.equity;
      }
    }
    const defaultAccountId = defaultAccount ? defaultAccount.id : null;

    const investmentModelEvaluations = {};
    if (selectedContexts.length === 1) {
      const context = selectedContexts[0];
      const { account } = context;
      if (account && account.investmentModel) {
        const payload = buildInvestmentModelRequest(account, flattenedPositions, perAccountCombinedBalances);
        if (!payload || !Array.isArray(payload.positions) || payload.positions.length === 0) {
          investmentModelEvaluations[account.id] = { status: 'no_positions' };
        } else {
          try {
            const evaluation = await evaluateInvestmentModel(payload);
            investmentModelEvaluations[account.id] = { status: 'ok', data: evaluation };
          } catch (modelError) {
            const message =
              modelError && modelError.message ? modelError.message : 'Failed to evaluate investment model.';
            console.warn('Investment model evaluation failed for account ' + account.id + ':', message);
            investmentModelEvaluations[account.id] = { status: 'error', message };
          }
        }
      }
    }

    const responseAccounts = allAccounts.map(function (account) {
      return {
        id: account.id,
        number: account.number,
        type: account.type,
        status: account.status,
        isPrimary: account.isPrimary,
        isBilling: account.isBilling,
        clientAccountType: account.clientAccountType,
        ownerLabel: account.ownerLabel,
        ownerEmail: account.ownerEmail,
        displayName: account.displayName || null,
        loginId: account.loginId,
        beneficiary: account.beneficiary || null,
        portalAccountId: account.portalAccountId || null,
        chatURL: account.chatURL || null,
        showQQQDetails: account.showQQQDetails === true,
        investmentModel: account.investmentModel || null,
        investmentModelLastRebalance: account.investmentModelLastRebalance || null,
        isDefault: defaultAccountId ? account.id === defaultAccountId : false,
      };
    });

    res.json({
      accounts: responseAccounts,
      filteredAccountIds: selectedContexts.map(function (context) {
        return context.account.id;
      }),
      defaultAccountId,
      defaultAccountNumber: defaultAccount ? defaultAccount.number : null,
      resolvedAccountId,
      resolvedAccountNumber,
      requestedAccountId: requestedAccountId || null,
      positions: decoratedPositions,
      pnl: pnl,
      balances: balancesSummary,
      accountBalances: perAccountCombinedBalances,
      investmentModelEvaluations,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ message: 'Questrade API error', details: error.response.data });
    }
    res.status(500).json({ message: 'Unexpected server error', details: error.message });
  }
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, function () {
  console.log('Server listening on port ' + PORT);
});



























