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

const ENABLE_TOTAL_PNL_DEBUG = (() => {
  const raw = process.env.DEBUG_TOTAL_PNL;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return true;
  }
  const normalized = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
})();

const ACTIVITY_WINDOW_DAYS = 30;
const MAX_ACTIVITY_WINDOWS = 540; // Approximately 45 years of monthly windows.
const FRED_SERIES_ID_USD_CAD = 'DEXCAUS';
const fredRateCache = new Map();
const fredPendingRequests = new Map();

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

function extractNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed.replace(/[^0-9.+-]/g, ''));
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function resolveActivityCurrency(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = [
    'netAmountCurrency',
    'currency',
    'tradeCurrency',
    'symbolCurrency',
    'settlementCurrency',
    'accountCurrency',
  ];
  for (const field of fields) {
    const value = activity[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().toUpperCase();
    }
  }
  return null;
}

function resolveActivityFxRate(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = ['fxRate', 'exchangeRate', 'conversionRate', 'rate'];
  for (const field of fields) {
    const value = extractNumeric(activity[field]);
    if (value !== null && value > 0) {
      return value;
    }
  }
  return null;
}

function resolveActivityNetAmount(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = ['netAmount', 'grossAmount', 'amount', 'cash', 'netCash', 'bookValue', 'marketValue', 'transferValue', 'transferAmount'];
  for (const field of fields) {
    const value = extractNumeric(activity[field]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function parseBookValueFromDescription(description) {
  if (typeof description !== 'string' || !description.trim()) {
    return null;
  }
  const match = description.match(/book value[^0-9+-]*([-+]?[0-9.,]+)/i);
  if (!match || !match[1]) {
    return null;
  }
  const numeric = extractNumeric(match[1]);
  if (numeric === null) {
    return null;
  }
  return numeric;
}

function normalizeTransferDescription(description) {
  if (typeof description !== 'string') {
    return null;
  }
  let normalized = description.toLowerCase();
  normalized = normalized.replace(/book value[^0-9+-]*[-+]?[0-9.,]+/gi, ' ');
  normalized = normalized.replace(/\b(to|from)\s+account\b.*$/gi, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function buildTransferPairKey(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const dateKey = formatDateKey(parseActivityDate(activity));
  const quantity = resolveActivityQuantity(activity);
  const normalizedQuantity = quantity !== null ? Math.abs(quantity).toFixed(6) : '';
  const symbolId = activity.symbolId ? String(activity.symbolId).trim() : '';
  const symbol = typeof activity.symbol === 'string' ? activity.symbol.trim().toUpperCase() : '';
  const descriptionKey = normalizeTransferDescription(activity.description);
  const components = [];
  if (dateKey) {
    components.push('date:' + dateKey);
  }
  if (symbolId) {
    components.push('sid:' + symbolId);
  } else if (symbol) {
    components.push('sym:' + symbol);
  }
  if (normalizedQuantity) {
    components.push('qty:' + normalizedQuantity);
  }
  if (descriptionKey) {
    components.push('desc:' + descriptionKey);
  }
  if (activity.transactionId) {
    components.push('tx:' + String(activity.transactionId));
  }
  if (activity.activityId) {
    components.push('act:' + String(activity.activityId));
  }
  if (!components.length) {
    return null;
  }
  return components.join('|');
}

function resolveActivityQuantity(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const quantityFields = ['quantity', 'qty', 'units', 'shares'];
  for (const field of quantityFields) {
    const value = extractNumeric(activity[field]);
    if (value !== null && value !== 0) {
      return value;
    }
  }
  return null;
}

function estimateFundingActivityValue(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }

  const currency = resolveActivityCurrency(activity);
  const normalizedCurrency = currency ? currency.toUpperCase() : null;

  const directFieldCandidates = [
    ['bookValue', 'book_value_field'],
    ['marketValue', 'market_value_field'],
    ['settlementAmount', 'settlement_amount_field'],
    ['transferValue', 'transfer_value_field'],
    ['transferAmount', 'transfer_amount_field'],
  ];

  if (!normalizedCurrency || normalizedCurrency === 'CAD') {
    directFieldCandidates.push(['bookValueInBase', 'book_value_in_base_field']);
    directFieldCandidates.push(['marketValueInBase', 'market_value_in_base_field']);
  }

  for (const [field, source] of directFieldCandidates) {
    const value = extractNumeric(activity[field]);
    if (value !== null && value !== 0) {
      return { amount: Math.abs(value), source };
    }
  }

  const descriptionValue = parseBookValueFromDescription(activity.description);
  if (descriptionValue !== null && descriptionValue !== 0) {
    return { amount: Math.abs(descriptionValue), source: 'description_book_value' };
  }

  const quantity = resolveActivityQuantity(activity);
  if (quantity !== null) {
    const priceFields = ['price', 'tradePrice', 'bookPrice', 'grossPrice', 'averagePrice'];
    for (const field of priceFields) {
      const price = extractNumeric(activity[field]);
      if (price !== null && price !== 0) {
        return { amount: Math.abs(quantity * price), source: 'quantity_price_estimate' };
      }
    }
  }

  return null;
}

function parseActivityDate(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = ['transactionDate', 'tradeDate', 'settlementDate', 'recordDate', 'date'];
  for (const field of fields) {
    const value = activity[field];
    if (!value) {
      continue;
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return null;
}

function formatDateKey(date) {
  if (!(date instanceof Date)) {
    return null;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function addDays(date, days) {
  const base = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(base.getTime())) {
    return null;
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base;
}

function formatIsoParam(date) {
  if (date instanceof Date) {
    return date.toISOString();
  }
  if (typeof date === 'string') {
    const parsed = new Date(date);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

async function fetchAccountActivities(login, accountId, startDate, endDate) {
  const params = {};
  const start = formatIsoParam(startDate);
  const end = formatIsoParam(endDate);
  if (start) {
    params.startTime = start;
  }
  if (end) {
    params.endTime = end;
  }
  const data = await questradeRequest(login, '/v1/accounts/' + accountId + '/activities', { params });
  if (!data || !Array.isArray(data.activities)) {
    return [];
  }
  return data.activities;
}

function determineFundingDirection(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const inKeywords = [
    'deposit',
    'transfer in',
    'transfer-in',
    'transferin',
    'transfer from',
    'journal in',
    'journaled in',
    'journal cash in',
    'journaled cash in',
    'cash in',
    'incoming',
    'from account',
  ];
  const outKeywords = [
    'withdraw',
    'withdrawal',
    'transfer out',
    'transfer-out',
    'transferout',
    'transfer to',
    'journal out',
    'journaled out',
    'journal cash out',
    'journaled cash out',
    'cash out',
    'outgoing',
    'to account',
  ];

  const candidateFields = [
    activity.type,
    activity.action,
    activity.transactionSubType,
    activity.description,
    activity.journalType,
  ];

  const matches = function (keywords) {
    return candidateFields.some(function (field) {
      if (typeof field !== 'string') {
        return false;
      }
      const normalized = field.toLowerCase();
      return keywords.some(function (keyword) {
        return normalized.includes(keyword);
      });
    });
  };

  if (matches(inKeywords)) {
    return 'in';
  }
  if (matches(outKeywords)) {
    return 'out';
  }

  const normalizedAction = typeof activity.action === 'string' ? activity.action.trim().toUpperCase() : '';
  if (normalizedAction) {
    const actionDirectionMap = {
      TF6: 'in',
      TFO: 'out',
      CON: 'in',
      DEP: 'in',
      WDL: 'out',
      WDR: 'out',
      WD: 'out',
    };
    if (actionDirectionMap[normalizedAction]) {
      return actionDirectionMap[normalizedAction];
    }
  }

  const normalizedType = typeof activity.type === 'string' ? activity.type.toLowerCase() : '';
  const normalizedDescription = typeof activity.description === 'string' ? activity.description.toLowerCase() : '';
  const looksLikeFunding =
    normalizedType.includes('deposit') ||
    normalizedType.includes('transfer') ||
    normalizedType.includes('withdraw') ||
    normalizedType.includes('journal') ||
    normalizedDescription.includes('transfer') ||
    normalizedDescription.includes('journal');

  if (looksLikeFunding) {
    const netAmount = resolveActivityNetAmount(activity);
    if (netAmount !== null) {
      if (netAmount > 0) {
        return 'in';
      }
      if (netAmount < 0) {
        return 'out';
      }
    }
    const quantityFields = ['quantity', 'qty', 'units', 'shares'];
    for (const field of quantityFields) {
      const quantity = extractNumeric(activity[field]);
      if (quantity !== null && quantity !== 0) {
        return quantity > 0 ? 'in' : 'out';
      }
    }
  }

  return null;
}

function buildActivityKey(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  if (activity.transactionId) {
    return 'id:' + activity.transactionId;
  }
  const components = [activity.type, activity.action, activity.transactionDate, activity.tradeDate, activity.description];
  const serialized = components
    .map(function (value) {
      return value == null ? '' : String(value);
    })
    .join('|');
  const netAmount = resolveActivityNetAmount(activity);
  const suffix = Number.isFinite(netAmount) ? ':' + netAmount.toFixed(4) : '';
  return serialized + suffix;
}

async function fetchFredRateRange(startDate, endDate, debugInfo) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return null;
  }
  const startKey = formatDateKey(startDate);
  const endKey = formatDateKey(endDate);
  if (!startKey || !endKey) {
    return null;
  }
  const requestKey = startKey + ':' + endKey;
  if (fredPendingRequests.has(requestKey)) {
    return fredPendingRequests.get(requestKey);
  }
  const requestPromise = axios
    .get('https://api.stlouisfed.org/fred/series/observations', {
      params: {
        series_id: FRED_SERIES_ID_USD_CAD,
        observation_start: startKey,
        observation_end: endKey,
        api_key: apiKey,
        file_type: 'json',
      },
    })
    .then(function (response) {
      const observations = Array.isArray(response.data && response.data.observations)
        ? response.data.observations
        : [];
      let latest = null;
      observations.forEach(function (observation) {
        const dateKey = observation && observation.date ? String(observation.date).slice(0, 10) : null;
        const numeric = observation ? extractNumeric(observation.value) : null;
        if (dateKey && numeric !== null && numeric > 0) {
          fredRateCache.set(dateKey, numeric);
          latest = { date: dateKey, value: numeric };
        }
      });
      if (debugInfo && ENABLE_TOTAL_PNL_DEBUG) {
        debugInfo.fxLookups.push({
          request: { start: startKey, end: endKey },
          observations: observations.length,
          latest: latest || null,
        });
      }
      return latest;
    })
    .catch(function (error) {
      if (ENABLE_TOTAL_PNL_DEBUG && debugInfo) {
        debugInfo.errors.push({
          scope: 'fred',
          message: error && error.message ? error.message : 'Failed to fetch FRED data',
          request: { start: startKey, end: endKey },
        });
      }
      return null;
    })
    .finally(function () {
      fredPendingRequests.delete(requestKey);
    });
  fredPendingRequests.set(requestKey, requestPromise);
  return requestPromise;
}

async function resolveUsdToCadRate(date, debugInfo) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return null;
  }
  const normalizedDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(normalizedDate.getTime())) {
    return null;
  }
  const requestedKey = formatDateKey(normalizedDate);
  if (requestedKey && fredRateCache.has(requestedKey)) {
    return fredRateCache.get(requestedKey);
  }

  const MAX_LOOKBACK_DAYS = 365;
  for (let offset = 0; offset <= MAX_LOOKBACK_DAYS; offset += 7) {
    const windowEnd = addDays(normalizedDate, -offset);
    if (!windowEnd) {
      continue;
    }
    const windowStart = addDays(windowEnd, -7);
    if (!windowStart) {
      continue;
    }
    const latest = await fetchFredRateRange(windowStart, windowEnd, debugInfo);
    if (latest && latest.value) {
      if (requestedKey && !fredRateCache.has(requestedKey)) {
        fredRateCache.set(requestedKey, latest.value);
      }
      return latest.value;
    }
  }

  return null;
}

async function loadFundingActivities(login, accountId, debugInfo) {
  const now = new Date();
  const collected = [];
  const seenKeys = new Set();
  let windowEnd = new Date(now.getTime() + 1000);
  let foundFunding = false;

  for (let index = 0; index < MAX_ACTIVITY_WINDOWS; index += 1) {
    const windowStart = addDays(windowEnd, -ACTIVITY_WINDOW_DAYS);
    if (!windowStart) {
      break;
    }
    const activities = await fetchAccountActivities(login, accountId, windowStart, windowEnd);
    const fundingEntries = [];
    activities.forEach(function (activity) {
      const direction = determineFundingDirection(activity);
      if (!direction) {
        return;
      }
      const key = buildActivityKey(activity);
      if (key && seenKeys.has(key)) {
        return;
      }
      if (key) {
        seenKeys.add(key);
      }
      fundingEntries.push({ direction, activity });
    });

    if (ENABLE_TOTAL_PNL_DEBUG && debugInfo) {
      debugInfo.windows.push({
        start: formatIsoParam(windowStart),
        end: formatIsoParam(windowEnd),
        totalActivities: activities.length,
        fundingActivities: fundingEntries.length,
      });
    }

    if (fundingEntries.length) {
      collected.push.apply(collected, fundingEntries);
      foundFunding = true;
    } else if (foundFunding) {
      break;
    }

    windowEnd = windowStart;
    if (windowEnd.getUTCFullYear() < 1998) {
      break;
    }
  }

  return collected;
}

async function computeAccountFundingSummary({ login, account, combinedBalances }) {
  if (!login || !account) {
    return null;
  }

  const debugInfo = ENABLE_TOTAL_PNL_DEBUG
    ? { accountId: account.id, windows: [], activities: [], fxLookups: [], errors: [] }
    : null;

  const fundingEntries = await loadFundingActivities(login, account.number, debugInfo);
  if (!fundingEntries.length) {
    if (ENABLE_TOTAL_PNL_DEBUG) {
      console.log('[total-pnl] No funding activities found for account', account.number);
    }
    return { status: 'no_data', debug: debugInfo };
  }

  const preparedEntries = fundingEntries.map(function (entry) {
    const activity = entry.activity;
    const direction = entry.direction === 'out' ? 'out' : 'in';
    let rawAmount = resolveActivityNetAmount(activity);
    if (rawAmount !== null) {
      const normalized = Math.abs(rawAmount);
      rawAmount = normalized > 0 ? normalized : null;
    }
    let estimationDetails = null;
    if (rawAmount === null) {
      const estimation = estimateFundingActivityValue(activity);
      if (estimation && typeof estimation.amount === 'number' && estimation.amount !== 0) {
        rawAmount = Math.abs(estimation.amount);
        estimationDetails = estimation;
      }
    }
    const pairKey = buildTransferPairKey(activity);
    return { direction, activity, rawAmount, estimation: estimationDetails, pairKey };
  });

  const pairingBuckets = new Map();
  preparedEntries.forEach(function (entry) {
    if (!entry.pairKey) {
      return;
    }
    if (!pairingBuckets.has(entry.pairKey)) {
      pairingBuckets.set(entry.pairKey, { resolved: [], pending: [] });
    }
    const bucket = pairingBuckets.get(entry.pairKey);
    if (entry.rawAmount && entry.rawAmount > 0) {
      bucket.resolved.push(entry);
    } else {
      bucket.pending.push(entry);
    }
  });

  pairingBuckets.forEach(function (bucket) {
    if (!bucket.pending.length || !bucket.resolved.length) {
      return;
    }
    const resolvedAmount = bucket.resolved
      .map(function (entry) {
        return entry.rawAmount;
      })
      .reduce(function (sum, value) {
        return sum + value;
      }, 0) / bucket.resolved.length;
    if (!(resolvedAmount > 0)) {
      return;
    }
    bucket.pending.forEach(function (entry) {
      if (!entry.rawAmount || entry.rawAmount === 0) {
        entry.rawAmount = resolvedAmount;
        entry.estimation = { amount: resolvedAmount, source: 'paired_transfer' };
      }
    });
  });

  const perCurrency = Object.create(null);
  let combinedCad = 0;

  for (const entry of preparedEntries) {
    const activity = entry.activity;
    const direction = entry.direction;
    const rawAmount = entry.rawAmount;
    if (rawAmount === null || rawAmount === 0) {
      if (debugInfo) {
        debugInfo.errors.push({
          scope: 'activity',
          message: 'Missing net amount for funding activity',
          activity,
        });
      }
      continue;
    }
    const currency = resolveActivityCurrency(activity) || 'CAD';
    const amount = direction === 'out' ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    if (!perCurrency[currency]) {
      perCurrency[currency] = { currency, netDeposits: 0, entries: [] };
    }
    perCurrency[currency].netDeposits += amount;

    let cadEquivalent = null;
    let fxRateUsed = null;
    if (currency === 'CAD') {
      cadEquivalent = amount;
      fxRateUsed = 1;
    } else if (currency === 'USD') {
      fxRateUsed = resolveActivityFxRate(activity);
      if (fxRateUsed === null || !(fxRateUsed > 0)) {
        const activityDate = parseActivityDate(activity) || new Date();
        fxRateUsed = await resolveUsdToCadRate(activityDate, debugInfo);
      }
      if (fxRateUsed && fxRateUsed > 0) {
        cadEquivalent = amount * fxRateUsed;
      }
    }

    if (cadEquivalent !== null) {
      combinedCad += cadEquivalent;
    } else if (debugInfo) {
      debugInfo.errors.push({
        scope: 'conversion',
        message: 'Unable to convert funding activity to CAD',
        activity,
        currency,
      });
    }

    if (debugInfo) {
      const debugEntry = {
        direction,
        currency,
        amount,
        cadEquivalent,
        fxRate: fxRateUsed,
        date: formatIsoParam(parseActivityDate(activity)),
        description: activity && activity.description ? String(activity.description) : null,
        type: activity && activity.type ? String(activity.type) : null,
        action: activity && activity.action ? String(activity.action) : null,
        rawAmount,
      };
      if (entry.estimation) {
        debugEntry.estimated = entry.estimation;
      }
      if (entry.pairKey) {
        debugEntry.pairKey = entry.pairKey;
      }
      debugInfo.activities.push(debugEntry);
    }
  }

  const summary = {
    status: 'ok',
    perCurrency: {},
    combined: {},
  };

  Object.keys(perCurrency).forEach(function (currency) {
    const bucket = perCurrency[currency];
    summary.perCurrency[currency] = {
      currency,
      netDeposits: bucket.netDeposits,
    };
  });

  const combinedCadEntry = { currency: 'CAD', netDeposits: combinedCad, totalEquity: null, totalPnl: null };
  if (combinedBalances && typeof combinedBalances === 'object') {
    const cadKey = Object.keys(combinedBalances).find(function (key) {
      return key && key.toUpperCase() === 'CAD';
    });
    if (cadKey) {
      const cadBalance = combinedBalances[cadKey];
      const totalEquity = extractNumeric(cadBalance && cadBalance.totalEquity);
      if (totalEquity !== null) {
        combinedCadEntry.totalEquity = totalEquity;
        if (Number.isFinite(combinedCad)) {
          combinedCadEntry.totalPnl = totalEquity - combinedCad;
        }
      }
    }
  }

  summary.combined.CAD = combinedCadEntry;

  if (debugInfo) {
    summary.debug = debugInfo;
    if (ENABLE_TOTAL_PNL_DEBUG) {
      console.log('[total-pnl] Funding summary for account', account.number, JSON.stringify(summary, null, 2));
    }
  }

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
    pnl.totalPnl = null;
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
        const combinedBalance = perAccountCombinedBalances[context.account.id] || null;
        const fundingSummary = await computeAccountFundingSummary({
          login: context.login,
          account: context.account,
          combinedBalances: combinedBalance,
        });
        if (fundingSummary) {
          accountFundingSummaries[context.account.id] = fundingSummary;
          if (fundingSummary.status === 'ok' && fundingSummary.combined) {
            const cadEntry = fundingSummary.combined.CAD || fundingSummary.combined.Cad || fundingSummary.combined.cad || null;
            const totalPnlValue = cadEntry && typeof cadEntry.totalPnl === 'number' ? cadEntry.totalPnl : null;
            if (Number.isFinite(totalPnlValue)) {
              pnl.totalPnl = totalPnlValue;
            }
          }
        }
      } catch (fundingError) {
        const message = fundingError && fundingError.message ? fundingError.message : 'Failed to compute funding summary.';
        console.warn('Funding summary error for account ' + context.account.number + ':', message);
        accountFundingSummaries[context.account.id] = { status: 'error', message };
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
      accountFundingSummaries,
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



























