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

const NET_DEPOSIT_ACTIVITY_WINDOW_DAYS = 31;
const NET_DEPOSIT_ACTIVITY_EPOCH = new Date(Date.UTC(2000, 0, 1));
const NET_DEPOSIT_CACHE_TTL_MS = 15 * 60 * 1000;

const netDepositCache = new Map();

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

function buildActivityWindows(startDate, endDate, windowDays) {
  const windows = [];
  if (!(startDate instanceof Date) || Number.isNaN(startDate.valueOf())) {
    return windows;
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.valueOf())) {
    return windows;
  }

  const windowMs = Math.max(windowDays, 1) * 24 * 60 * 60 * 1000;
  let cursor = new Date(startDate.getTime());
  const limit = endDate.getTime();

  while (cursor.getTime() <= limit) {
    const windowEnd = new Date(Math.min(limit, cursor.getTime() + windowMs));
    windows.push({ start: new Date(cursor.getTime()), end: windowEnd });
    if (windowEnd.getTime() >= limit) {
      break;
    }
    cursor = new Date(windowEnd.getTime() + 1);
  }

  return windows;
}

async function fetchActivitiesWindow(login, accountId, startTime, endTime) {
  const params = {};
  if (startTime) {
    params.startTime = startTime;
  }
  if (endTime) {
    params.endTime = endTime;
  }
  const data = await questradeRequest(login, '/v1/accounts/' + accountId + '/activities', { params });
  return Array.isArray(data.activities) ? data.activities : [];
}

async function fetchAllAccountActivities(login, accountId) {
  if (!login || !accountId) {
    return [];
  }

  const now = new Date();
  const start = NET_DEPOSIT_ACTIVITY_EPOCH;
  const windows = buildActivityWindows(start, now, NET_DEPOSIT_ACTIVITY_WINDOW_DAYS);
  const activities = [];

  for (const window of windows) {
    try {
      const batch = await fetchActivitiesWindow(login, accountId, window.start.toISOString(), window.end.toISOString());
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

  activities.forEach((activity) => {
    const currency = resolveActivityCurrency(activity);
    if (!currency) {
      return;
    }

    const classification = classifyNetDepositActivity(activity);
    if (!classification) {
      return;
    }

    let amount = Number(activity && activity.netAmount);
    if (!Number.isFinite(amount) || amount === 0) {
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
  });

  return { totals, counts };
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

async function fetchAccountNetDeposits(login, accountId) {
  const cacheKey = getNetDepositCacheKey(login && login.id, accountId);
  const cached = getCachedNetDeposits(cacheKey);
  if (cached) {
    return cached;
  }

  const activities = await fetchAllAccountActivities(login, accountId);
  const summary = accumulateNetDeposits(activities);
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
  const perCurrencyResult = {};
  const combinedResult = {};
  let hasValue = false;

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
      hasValue = true;
    });
  }

  if (balanceSummary.combined) {
    const rates = buildCurrencyRateMapFromSummary(balanceSummary, baseCurrency);
    Object.entries(balanceSummary.combined).forEach(([key, entry]) => {
      const normalized = normalizeCurrencyCode(key);
      if (!normalized) {
        return;
      }
      const equity = entry && entry.totalEquity;
      if (!isFiniteNumber(equity)) {
        return;
      }
      let convertedDeposits = 0;
      totalsMap.forEach((amount, sourceCurrency) => {
        convertedDeposits += convertAmountToCurrency(amount, sourceCurrency, normalized, rates, baseCurrency);
      });
      combinedResult[normalized] = equity - convertedDeposits;
      hasValue = true;
    });
  }

  if (!hasValue) {
    return null;
  }

  return { perCurrency: perCurrencyResult, combined: combinedResult };
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
          const netDeposits = await fetchAccountNetDeposits(context.login, context.account.number);
          const totals = computeAccountTotalPnlSummary(accountSummary, netDeposits, { baseCurrency: 'CAD' });
          if (totals) {
            applyTotalPnlToBalanceSummary(accountSummary, totals);
            applyTotalPnlToBalanceSummary(balancesSummary, totals);
            computedTotalPnl = totals;
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



























