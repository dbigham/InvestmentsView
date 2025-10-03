const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const response = await enqueueRequest(() => axios(baseConfig));
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
      const retryResponse = await enqueueRequest(() => axios(retryConfig));
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

const DEBUG_TOTAL_PNL = process.env.DEBUG_TOTAL_PNL !== 'false';
const DAY_IN_MS = 24 * 60 * 60 * 1000;
// Questrade's documentation cites a 31 day cap for the activities endpoint, but in
// practice we receive "Argument length exceeds imposed limit" errors whenever the
// requested range spans a full 31 calendar days. Keeping the window strictly under
// that threshold avoids the 400 errors without materially increasing the number of
// requests we make.
const MAX_ACTIVITIES_WINDOW_DAYS = 30;
const MIN_ACTIVITY_DATE = new Date('2000-01-01T00:00:00Z');
const USD_TO_CAD_SERIES = 'DEXCAUS';
const ACTIVITIES_CACHE_DIR = path.join(process.cwd(), '.cache', 'activities');

const activitiesMemoryCache = new Map();
let activitiesCacheDirEnsured = false;

function debugTotalPnl(accountId, message, payload) {
  if (!DEBUG_TOTAL_PNL) {
    return;
  }
  const parts = ['[TOTAL_PNL]', accountId ? '(' + accountId + ')' : '', message];
  const filtered = parts.filter(Boolean);
  if (payload !== undefined) {
    console.log(filtered.join(' '), payload);
  } else {
    console.log(filtered.join(' '));
  }
}

function addDays(baseDate, days) {
  if (!(baseDate instanceof Date) || Number.isNaN(baseDate.getTime())) {
    return null;
  }
  return new Date(baseDate.getTime() + days * DAY_IN_MS);
}

function addMonths(baseDate, months) {
  if (!(baseDate instanceof Date) || Number.isNaN(baseDate.getTime())) {
    return null;
  }
  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth();
  const day = baseDate.getUTCDate();
  const target = new Date(Date.UTC(year, month + months, 1));
  const daysInTargetMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      clampedDay,
      baseDate.getUTCHours(),
      baseDate.getUTCMinutes(),
      baseDate.getUTCSeconds(),
      baseDate.getUTCMilliseconds()
    )
  );
}

function clampDate(date, minDate) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  if (!(minDate instanceof Date) || Number.isNaN(minDate.getTime())) {
    return new Date(date.getTime());
  }
  return date < minDate ? new Date(minDate.getTime()) : new Date(date.getTime());
}

function floorToMonthStart(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function formatDateParam(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ensureActivitiesCacheDir() {
  if (activitiesCacheDirEnsured) {
    return;
  }
  try {
    fs.mkdirSync(ACTIVITIES_CACHE_DIR, { recursive: true });
  } catch (error) {
    console.warn('Failed to ensure activities cache directory:', error.message);
  }
  activitiesCacheDirEnsured = true;
}

function getActivitiesCacheKey(loginId, accountId, startParam, endParam) {
  const rawKey = [loginId || 'unknown', accountId || 'unknown', startParam || '', endParam || ''].join('|');
  return crypto.createHash('sha1').update(rawKey).digest('hex');
}

function getActivitiesCacheFilePath(cacheKey) {
  return path.join(ACTIVITIES_CACHE_DIR, cacheKey + '.json');
}

function readActivitiesCache(cacheKey) {
  try {
    const filePath = getActivitiesCacheFilePath(cacheKey);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const contents = fs.readFileSync(filePath, 'utf-8');
    if (!contents) {
      return null;
    }
    const parsed = JSON.parse(contents);
    if (parsed && Array.isArray(parsed.activities)) {
      return parsed.activities;
    }
  } catch (error) {
    console.warn('Failed to read activities cache entry:', error.message);
  }
  return null;
}

function writeActivitiesCache(cacheKey, activities) {
  try {
    ensureActivitiesCacheDir();
    const payload = {
      cachedAt: new Date().toISOString(),
      activities: Array.isArray(activities) ? activities : [],
    };
    fs.writeFileSync(getActivitiesCacheFilePath(cacheKey), JSON.stringify(payload));
  } catch (error) {
    console.warn('Failed to persist activities cache entry:', error.message);
  }
}

function resolveActivityTimestamp(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = ['transactionDate', 'tradeDate', 'settlementDate', 'date'];
  for (const field of fields) {
    if (activity[field]) {
      const date = new Date(activity[field]);
      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }
  return null;
}

const FUNDING_TYPE_REGEX = /(deposit|withdraw|transfer|journal)/i;

function isFundingActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }
  const type = typeof activity.type === 'string' ? activity.type : '';
  const action = typeof activity.action === 'string' ? activity.action : '';
  const description = typeof activity.description === 'string' ? activity.description : '';
  return (
    FUNDING_TYPE_REGEX.test(type) ||
    FUNDING_TYPE_REGEX.test(action) ||
    FUNDING_TYPE_REGEX.test(description)
  );
}

function extractAmountFromDescription(description) {
  if (typeof description !== 'string' || !description) {
    return null;
  }

  const bookValueMatch = description.match(/BOOK\s+VALUE\s+([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/i);
  if (bookValueMatch && bookValueMatch[1]) {
    const normalizedBookValue = bookValueMatch[1].replace(/,/g, '');
    const bookValue = Number(normalizedBookValue);
    if (Number.isFinite(bookValue)) {
      return bookValue;
    }
  }

  const decimalMatches = description.match(/[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]+/g);
  if (decimalMatches && decimalMatches.length > 0) {
    const normalizedDecimal = decimalMatches[decimalMatches.length - 1].replace(/,/g, '');
    const decimalValue = Number(normalizedDecimal);
    if (Number.isFinite(decimalValue)) {
      return decimalValue;
    }
  }

  const genericMatches = description.match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?)/g);
  if (!genericMatches || !genericMatches.length) {
    return null;
  }
  const filtered = genericMatches.filter((value) => value && value.indexOf('.') !== -1);
  const candidate = (filtered.length ? filtered[filtered.length - 1] : genericMatches[genericMatches.length - 1]) || null;
  if (!candidate) {
    return null;
  }
  const normalized = candidate.replace(/,/g, '');
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function resolveActivityAmount(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const candidates = ['netAmount', 'grossAmount'];
  for (const field of candidates) {
    const value = Number(activity[field]);
    if (Number.isFinite(value) && Math.abs(value) > 1e-8) {
      return value;
    }
  }
  const quantity = Number(activity.quantity);
  if (Number.isFinite(quantity) && Math.abs(quantity) > 1e-8) {
    const price = Number(activity.price);
    if (Number.isFinite(price) && Math.abs(price) > 1e-8) {
      return quantity * price;
    }
  }
  const embedded = extractAmountFromDescription(activity.description);
  if (embedded !== null) {
    return embedded;
  }
  return null;
}

function inferActivityDirection(activity, fallbackAmount) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const candidates = ['netAmount', 'grossAmount'];
  for (const field of candidates) {
    const value = Number(activity[field]);
    if (Number.isFinite(value) && Math.abs(value) > 1e-8) {
      return value >= 0 ? 1 : -1;
    }
  }
  const quantity = Number(activity.quantity);
  if (Number.isFinite(quantity) && Math.abs(quantity) > 1e-8) {
    return quantity >= 0 ? 1 : -1;
  }
  const action = typeof activity.action === 'string' ? activity.action.toLowerCase() : '';
  const description = typeof activity.description === 'string' ? activity.description.toLowerCase() : '';
  if (/(withdraw|to account|transfer out|debit|wire out)/.test(action) || /(withdraw|to account|debit|wire out)/.test(description)) {
    return -1;
  }
  if (/(deposit|from account|transfer in|credit|wire in)/.test(action) || /(deposit|from account|credit|wire in)/.test(description)) {
    return 1;
  }
  if (typeof fallbackAmount === 'number' && fallbackAmount < 0) {
    return -1;
  }
  if (typeof fallbackAmount === 'number' && fallbackAmount > 0) {
    return 1;
  }
  return null;
}

function normalizeCurrency(code) {
  if (typeof code !== 'string') {
    return null;
  }
  return code.trim().toUpperCase();
}

const usdCadRateCache = new Map();

async function fetchUsdToCadRate(date) {
  const keyDate = formatDateOnly(date);
  if (!keyDate) {
    return null;
  }
  if (usdCadRateCache.has(keyDate)) {
    return usdCadRateCache.get(keyDate);
  }

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error('Missing FRED_API_KEY environment variable');
  }

  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', USD_TO_CAD_SERIES);
  url.searchParams.set('observation_start', keyDate);
  url.searchParams.set('observation_end', keyDate);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');

  const response = await axios.get(url.toString());
  const observations = response.data && response.data.observations;
  if (Array.isArray(observations) && observations.length > 0) {
    const value = Number(observations[0].value);
    if (Number.isFinite(value) && value > 0) {
      usdCadRateCache.set(keyDate, value);
      return value;
    }
  }
  usdCadRateCache.set(keyDate, null);
  return null;
}

function formatDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

async function resolveUsdToCadRate(date, accountKey) {
  let cursor = new Date(date.getTime());
  for (let i = 0; i < 7; i += 1) {
    const attemptDate = addDays(cursor, -i);
    if (!attemptDate) {
      continue;
    }
    const rate = await fetchUsdToCadRate(attemptDate);
    if (Number.isFinite(rate) && rate > 0) {
      if (i > 0 && DEBUG_TOTAL_PNL) {
        debugTotalPnl(
          accountKey,
          'Used prior FX date ' + formatDateOnly(attemptDate) + ' for ' + formatDateOnly(date)
        );
      }
      return rate;
    }
  }
  return null;
}

async function fetchActivitiesWindow(login, accountId, startDate, endDate, accountKey) {
  const startParam = formatDateParam(startDate);
  const endParam = formatDateParam(endDate);
  if (!startParam || !endParam) {
    return [];
  }
  const nowMs = Date.now();
  const isHistorical = endDate instanceof Date && !Number.isNaN(endDate.getTime()) && endDate.getTime() < nowMs;
  const cacheKey =
    isHistorical && login
      ? getActivitiesCacheKey(login.id, accountId, startParam, endParam)
      : null;
  if (isHistorical && cacheKey) {
    if (activitiesMemoryCache.has(cacheKey)) {
      debugTotalPnl(accountKey, 'Using cached activities window (memory)', {
        start: startParam,
        end: endParam,
      });
      return activitiesMemoryCache.get(cacheKey);
    }
    const cached = readActivitiesCache(cacheKey);
    if (Array.isArray(cached)) {
      activitiesMemoryCache.set(cacheKey, cached);
      debugTotalPnl(accountKey, 'Using cached activities window (disk)', {
        start: startParam,
        end: endParam,
      });
      return cached;
    }
  }
  debugTotalPnl(accountKey, 'Fetching activities window', {
    start: startParam,
    end: endParam,
  });
  const params = {
    startTime: startParam,
    endTime: endParam,
  };
  const data = await questradeRequest(login, '/v1/accounts/' + accountId + '/activities', { params });
  const activities = data && Array.isArray(data.activities) ? data.activities : [];
  if (isHistorical && cacheKey) {
    activitiesMemoryCache.set(cacheKey, activities);
    writeActivitiesCache(cacheKey, activities);
  }
  return activities;
}

async function fetchActivitiesRange(login, accountId, startDate, endDate, accountKey) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return [];
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    return [];
  }
  if (startDate > endDate) {
    return [];
  }
  const results = [];
  let cursor = new Date(startDate.getTime());
  while (cursor <= endDate) {
    const windowEnd = new Date(
      Math.min(
        endDate.getTime(),
        cursor.getTime() + MAX_ACTIVITIES_WINDOW_DAYS * DAY_IN_MS - 1000
      )
    );
    const windowActivities = await fetchActivitiesWindow(login, accountId, cursor, windowEnd, accountKey);
    results.push(...windowActivities);
    const nextStart = new Date(windowEnd.getTime() + 1000);
    if (nextStart > endDate) {
      break;
    }
    cursor = nextStart;
  }
  debugTotalPnl(accountKey, 'Fetched activities count', results.length);
  return results;
}

function filterFundingActivities(activities) {
  return activities.filter((activity) => isFundingActivity(activity));
}

function buildActivityKey(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const idFields = ['id', 'activityId', 'transactionId'];
  for (const field of idFields) {
    if (activity[field]) {
      return String(activity[field]);
    }
  }
  const timestamp = resolveActivityTimestamp(activity);
  const timestampPart = timestamp ? timestamp.toISOString() : '';
  const parts = [timestampPart];
  const keyFields = ['type', 'action', 'symbol', 'description', 'currency'];
  keyFields.forEach((field) => {
    if (activity[field]) {
      parts.push(String(activity[field]));
    }
  });
  const amountFields = ['netAmount', 'grossAmount', 'amount', 'quantity', 'price'];
  amountFields.forEach((field) => {
    if (activity[field] !== undefined && activity[field] !== null) {
      parts.push(String(activity[field]));
    }
  });
  return parts.join('|');
}

function dedupeActivities(activities) {
  if (!Array.isArray(activities) || activities.length === 0) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const activity of activities) {
    const key = buildActivityKey(activity) || JSON.stringify(activity);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(activity);
  }
  return result;
}

function findEarliestFundingTimestamp(activities) {
  let earliest = null;
  activities.forEach((activity) => {
    const timestamp = resolveActivityTimestamp(activity);
    if (timestamp && (!earliest || timestamp < earliest)) {
      earliest = timestamp;
    }
  });
  return earliest;
}

async function discoverEarliestFundingDate(login, accountId, accountKey) {
  const now = new Date();
  const currentMonthStart = floorToMonthStart(now);
  if (!currentMonthStart) {
    debugTotalPnl(accountKey, 'Unable to determine current month start during discovery');
    return null;
  }

  let monthStart = currentMonthStart;
  let earliest = null;
  let consecutiveEmpty = 0;
  let iterations = 0;
  const MAX_MONTH_LOOKBACK = 600; // 50 years of monthly checks

  while (monthStart && monthStart >= MIN_ACTIVITY_DATE && iterations < MAX_MONTH_LOOKBACK) {
    iterations += 1;
    const nextMonthStart = addMonths(monthStart, 1);
    if (!nextMonthStart) {
      break;
    }
    let monthEnd = new Date(nextMonthStart.getTime() - 1000);
    if (monthEnd > now) {
      monthEnd = new Date(now.getTime());
    }
    if (monthEnd < monthStart) {
      break;
    }
    const monthLabel = {
      start: formatDateOnly(monthStart),
      end: formatDateOnly(monthEnd),
    };
    const activities = await fetchActivitiesRange(login, accountId, monthStart, monthEnd, accountKey);
    const funding = filterFundingActivities(activities);
    if (funding.length > 0) {
      const windowEarliest = findEarliestFundingTimestamp(funding);
      if (windowEarliest && (!earliest || windowEarliest < earliest)) {
        earliest = windowEarliest;
      }
      consecutiveEmpty = 0;
      debugTotalPnl(accountKey, 'Funding month hit', Object.assign({ activities: funding.length }, monthLabel));
    } else {
      consecutiveEmpty += 1;
      debugTotalPnl(
        accountKey,
        'Funding month empty',
        Object.assign({ consecutiveEmpty }, monthLabel)
      );
    }

    if (earliest && consecutiveEmpty >= 12) {
      debugTotalPnl(accountKey, 'Stopping discovery after 12 empty months beyond earliest');
      break;
    }
    if (!earliest && consecutiveEmpty >= 12) {
      debugTotalPnl(accountKey, 'Stopping discovery after 12 consecutive empty months with no funding');
      break;
    }

    const previousMonthStart = addMonths(monthStart, -1);
    if (!previousMonthStart || previousMonthStart < MIN_ACTIVITY_DATE) {
      break;
    }
    monthStart = previousMonthStart;
  }

  if (earliest) {
    debugTotalPnl(accountKey, 'Earliest funding date discovered', formatDateOnly(earliest));
    return earliest;
  }

  debugTotalPnl(accountKey, 'No funding activities found during discovery');
  return null;
}

function resolveActivityAmountDetails(activity) {
  const amount = resolveActivityAmount(activity);
  if (amount === null) {
    return null;
  }
  const direction = inferActivityDirection(activity, amount);
  if (!direction) {
    return null;
  }
  const signedAmount = direction >= 0 ? Math.abs(amount) : -Math.abs(amount);
  const currency = normalizeCurrency(activity.currency) || 'CAD';
  const timestamp = resolveActivityTimestamp(activity);
  return {
    amount: signedAmount,
    currency,
    timestamp,
  };
}

async function convertAmountToCad(amount, currency, timestamp, accountKey) {
  if (!Number.isFinite(amount)) {
    return null;
  }
  if (!currency || currency === 'CAD') {
    return amount;
  }
  if (currency === 'USD') {
    if (!timestamp) {
      return null;
    }
    const rate = await resolveUsdToCadRate(timestamp, accountKey);
    if (!Number.isFinite(rate) || rate <= 0) {
      debugTotalPnl(accountKey, 'Missing FX rate for ' + formatDateOnly(timestamp));
      return null;
    }
    return amount * rate;
  }
  debugTotalPnl(accountKey, 'Unsupported currency for net deposits: ' + currency);
  return null;
}

async function computeNetDeposits(login, account, perAccountCombinedBalances) {
  if (!account || !account.id) {
    return null;
  }
  const accountKey = account.id;
  const accountNumber = account.number || account.accountNumber || account.id;
  const earliestFunding = await discoverEarliestFundingDate(login, accountNumber, accountKey);
  const now = new Date();
  const paddedStart = earliestFunding ? addDays(floorToMonthStart(earliestFunding), -7) : addDays(now, -365);
  const crawlStart = clampDate(paddedStart || now, MIN_ACTIVITY_DATE) || MIN_ACTIVITY_DATE;
  const activities = await fetchActivitiesRange(login, accountNumber, crawlStart, now, accountKey);
  const fundingActivities = dedupeActivities(filterFundingActivities(activities));
  debugTotalPnl(accountKey, 'Funding activities considered', fundingActivities.length);

  const perCurrencyTotals = new Map();
  let combinedCad = 0;
  let conversionIncomplete = false;
  const breakdown = [];

  for (const activity of fundingActivities) {
    const details = resolveActivityAmountDetails(activity);
    if (!details) {
      debugTotalPnl(accountKey, 'Skipped activity due to missing amount', activity);
      continue;
    }
    const { amount, currency, timestamp } = details;
    const cadAmount = await convertAmountToCad(amount, currency, timestamp, accountKey);
    if (!perCurrencyTotals.has(currency)) {
      perCurrencyTotals.set(currency, 0);
    }
    perCurrencyTotals.set(currency, perCurrencyTotals.get(currency) + amount);
    if (Number.isFinite(cadAmount)) {
      combinedCad += cadAmount;
    } else if (currency !== 'CAD') {
      conversionIncomplete = true;
    }
    breakdown.push({
      amount,
      currency,
      cadAmount,
      timestamp: timestamp ? formatDateOnly(timestamp) : null,
      type: activity.type || null,
      action: activity.action || null,
      description: activity.description || null,
    });
  }

  const perCurrencyObject = {};
  for (const [currency, value] of perCurrencyTotals.entries()) {
    perCurrencyObject[currency] = value;
  }

  const combinedCadValue = conversionIncomplete ? null : combinedCad;

  const combinedBalances = perAccountCombinedBalances && perAccountCombinedBalances[account.id];
  const cadBalance = combinedBalances ? combinedBalances.CAD || combinedBalances.cad : null;
  const totalEquityCad = cadBalance && Number.isFinite(Number(cadBalance.totalEquity))
    ? Number(cadBalance.totalEquity)
    : null;

  const totalPnlCad =
    Number.isFinite(totalEquityCad) && Number.isFinite(combinedCadValue)
      ? totalEquityCad - combinedCadValue
      : null;

  debugTotalPnl(accountKey, 'Net deposits summary', {
    perCurrency: perCurrencyObject,
    combinedCad: combinedCadValue,
    totalEquityCad,
    totalPnlCad,
    crawlStart: formatDateOnly(crawlStart),
    asOf: formatDateOnly(now),
  });

  if (DEBUG_TOTAL_PNL) {
    debugTotalPnl(accountKey, 'Funding breakdown entries', breakdown);
  }

  return {
    netDeposits: {
      perCurrency: perCurrencyObject,
      combinedCad: Number.isFinite(combinedCadValue) ? combinedCadValue : null,
    },
    totalPnl: {
      combinedCad: Number.isFinite(totalPnlCad) ? totalPnlCad : null,
    },
    totalEquityCad: Number.isFinite(totalEquityCad) ? totalEquityCad : null,
  };
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

function mergePnL(positions) {
  return positions.reduce(
    function (acc, position) {
      acc.dayPnl += position.dayPnl || 0;
      acc.openPnl += position.openPnl || 0;
      return acc;
    },
    { dayPnl: 0, openPnl: 0 }
  );
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
    selectedContexts.forEach(function (context, index) {
      const combined = summarizeAccountCombinedBalances(balancesResults[index]);
      if (combined) {
        perAccountCombinedBalances[context.account.id] = combined;
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
    const pnl = mergePnL(flattenedPositions);
    const balancesSummary = mergeBalances(balancesResults);
    finalizeBalances(balancesSummary);

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

    const accountFundingSummaries = {};
    if (selectedContexts.length === 1) {
      const context = selectedContexts[0];
      try {
        const fundingSummary = await computeNetDeposits(
          context.login,
          context.account,
          perAccountCombinedBalances
        );
        if (fundingSummary) {
          accountFundingSummaries[context.account.id] = fundingSummary;
        }
      } catch (fundingError) {
        const message = fundingError && fundingError.message ? fundingError.message : String(fundingError);
        console.warn(
          'Failed to compute net deposits for account ' + context.account.id + ':',
          message
        );
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
      accountFunding: accountFundingSummaries,
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



























