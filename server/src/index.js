const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;
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
const PERFORMANCE_DEBUG_ENABLED = process.env.PERFORMANCE_DEBUG !== 'false';
const tokenCache = new NodeCache();
const tokenFilePath = path.join(process.cwd(), 'token-store.json');

function performanceDebug() {
  if (!PERFORMANCE_DEBUG_ENABLED) {
    return;
  }
  const args = Array.from(arguments);
  if (!args.length) {
    return;
  }
  console.log.apply(console, ['[performance-debug]'].concat(args));
}

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

async function loadAccountsData(configuredDefaultKey) {
  const accountNameOverrides = getAccountNameOverrides();
  const accountPortalOverrides = getAccountPortalOverrides();
  const accountChatOverrides = getAccountChatOverrides();
  const accountSettings = getAccountSettings();
  const accountBeneficiaries = getAccountBeneficiaries();
  const configuredOrdering = getAccountOrdering();

  const accountCollections = [];

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
        if (Array.isArray(accountSettingsOverride.transfers) && accountSettingsOverride.transfers.length) {
          normalizedAccount.performanceTransfers = accountSettingsOverride.transfers.map((transfer) => Object.assign({}, transfer));
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

  return { accountCollections, allAccounts, accountsById, defaultAccount };
}

async function fetchExecutions(login, accountId, options = {}) {
  const params = {};
  if (options.startTime) {
    params.startTime = options.startTime;
  }
  if (options.endTime) {
    params.endTime = options.endTime;
  }

  const basePath = '/v1/accounts/' + accountId + '/executions';
  let nextPath = basePath;
  let firstRequest = true;
  const results = [];
  let safety = 0;

  while (nextPath && safety < 50) {
    safety += 1;
    const requestOptions = firstRequest ? { params } : {};
    const data = await questradeRequest(login, nextPath, requestOptions);
    firstRequest = false;
    if (data && Array.isArray(data.executions)) {
      results.push(...data.executions);
    }
    if (data && data.next) {
      nextPath = data.next;
    } else if (data && data.nextPage) {
      nextPath = data.nextPage;
    } else if (data && data.links && data.links.next) {
      nextPath = data.links.next;
    } else if (data && data.more === true && data.nextRecordsPath) {
      nextPath = data.nextRecordsPath;
    } else {
      nextPath = null;
    }
  }

  return results;
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return new Date(value.getTime());
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const derived = new Date(value);
    if (Number.isNaN(derived.getTime())) {
      return null;
    }
    return derived;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    const appended = new Date(trimmed + 'T00:00:00Z');
    if (!Number.isNaN(appended.getTime())) {
      return appended;
    }
  }
  return null;
}

function toDateKey(value) {
  const timestamp = parseTimestamp(value);
  if (!timestamp) {
    return null;
  }
  return timestamp.toISOString().slice(0, 10);
}

function pickNumericCandidate(source, keys) {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    if (!key) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = Number(source[key]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }
  return null;
}

function resolveExecutionSide(execution) {
  const candidates = [execution.side, execution.action, execution.orderSide, execution.type, execution.actionType];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') {
      continue;
    }
    const normalized = candidate.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.includes('buy')) {
      return 'buy';
    }
    if (normalized.includes('sell')) {
      return 'sell';
    }
  }
  if (execution.isBuy === true) {
    return 'buy';
  }
  if (execution.isBuy === false) {
    return 'sell';
  }
  return null;
}

const EXECUTION_QUANTITY_KEYS = ['quantity', 'qty', 'filledQuantity', 'execQuantity'];
const EXECUTION_PRICE_KEYS = ['price', 'avgPrice', 'pricePerUnit', 'pricePerShare'];
const EXECUTION_FEE_KEYS = ['commission', 'totalCommission', 'commissionAndFees', 'fees'];
const EXECUTION_TIMESTAMP_KEYS = ['transactTime', 'tradeDate', 'transactionTime', 'executionTime', 'fillTime', 'timestamp'];

function formatDecimal(value, fractionDigits) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const fixed = value.toFixed(fractionDigits);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
}

function summarizeExecutionsForDebug(executions) {
  if (!Array.isArray(executions) || !executions.length) {
    return [];
  }
  return executions
    .map(function (execution, index) {
      if (!execution || typeof execution !== 'object') {
        return null;
      }
      const symbol = execution.symbol ? String(execution.symbol).trim() : '(unknown)';
      const side = resolveExecutionSide(execution) || '(unknown)';
      const quantity = pickNumericCandidate(execution, EXECUTION_QUANTITY_KEYS);
      const price = pickNumericCandidate(execution, EXECUTION_PRICE_KEYS);
      const timestampCandidate = EXECUTION_TIMESTAMP_KEYS.map(function (key) {
        return parseTimestamp(execution[key]);
      }).find(Boolean);
      const timestamp = timestampCandidate ? timestampCandidate.toISOString() : '(no timestamp)';
      const fees = EXECUTION_FEE_KEYS.reduce(function (total, key) {
        const value = pickNumericCandidate(execution, [key]);
        if (Number.isFinite(value)) {
          return total + value;
        }
        return total;
      }, 0);
      const quantityAbs = Number.isFinite(quantity) ? Math.abs(quantity) : null;
      const gross = Number.isFinite(quantityAbs) && Number.isFinite(price) ? quantityAbs * price : null;
      const sideLabel = side ? side.toUpperCase() : '(unknown)';
      const reference = execution.id || execution.executionId || execution.orderId || execution.orderNumber || null;
      const parts = [];
      parts.push('#' + (reference || index + 1));
      parts.push(timestamp);
      parts.push(symbol);
      parts.push(sideLabel);
      parts.push('qty=' + formatDecimal(quantityAbs, 4));
      parts.push('price=' + formatDecimal(price, 4));
      parts.push('gross=' + formatDecimal(gross, 2));
      parts.push('fees=' + formatDecimal(fees, 2));
      return parts.join(' | ');
    })
    .filter(Boolean);
}

function resolveExecutionCurrency(execution) {
  if (!execution || typeof execution !== 'object') {
    return null;
  }
  const currencyKeys = [
    'currency',
    'grossCurrency',
    'netCurrency',
    'settlementCurrency',
    'priceCurrency',
    'commissionCurrency',
  ];
  for (const key of currencyKeys) {
    if (!key || !Object.prototype.hasOwnProperty.call(execution, key)) {
      continue;
    }
    const value = execution[key];
    if (!value || typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim().toUpperCase();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function normalizeExecutionEvents(executions) {
  if (!Array.isArray(executions)) {
    return [];
  }

  const events = [];

  executions.forEach(function (execution) {
    if (!execution || typeof execution !== 'object') {
      return;
    }
    const symbol = execution.symbol ? String(execution.symbol).trim() : null;
    if (!symbol) {
      return;
    }
    const side = resolveExecutionSide(execution);
    if (!side) {
      return;
    }
    const quantityValue = pickNumericCandidate(execution, EXECUTION_QUANTITY_KEYS);
    const priceValue = pickNumericCandidate(execution, EXECUTION_PRICE_KEYS);
    if (!Number.isFinite(quantityValue) || quantityValue === 0 || !Number.isFinite(priceValue)) {
      return;
    }
    const quantity = Math.abs(quantityValue);
    const price = priceValue;
    const timestampCandidate = EXECUTION_TIMESTAMP_KEYS
      .map(function (key) {
        return parseTimestamp(execution[key]);
      })
      .find(Boolean);
    const timestamp = timestampCandidate || null;
    const fees = EXECUTION_FEE_KEYS.reduce(function (total, key) {
      const value = pickNumericCandidate(execution, [key]);
      if (Number.isFinite(value)) {
        return total + value;
      }
      return total;
    }, 0);
    const gross = quantity * price;
    const cashFlow = side === 'buy' ? -(gross + fees) : gross - fees;
    const quantityChange = side === 'buy' ? quantity : -quantity;
    const currency = resolveExecutionCurrency(execution);

    events.push({
      symbol,
      quantity: quantityChange,
      price,
      cashFlow,
      timestamp: timestamp || null,
      type: 'execution',
      currency: currency || null,
      metadata: {
        side,
        rawQuantity: quantity,
        fees,
        gross,
        reference:
          execution.id || execution.executionId || execution.orderId || execution.orderNumber || execution.tradeId || null,
        sourceTimestamp: timestamp ? timestamp.toISOString() : null,
      },
    });
  });

  return events;
}

function normalizeTransferEvents(transfers) {
  if (!Array.isArray(transfers)) {
    return [];
  }
  return transfers
    .map(function (transfer) {
      if (!transfer || typeof transfer !== 'object') {
        return null;
      }
      const symbol = transfer.symbol ? String(transfer.symbol).trim() : null;
      if (!symbol) {
        return null;
      }
      const quantity = Number(transfer.quantity);
      if (!Number.isFinite(quantity) || quantity === 0) {
        return null;
      }
      const timestamp = transfer.timestamp ? parseTimestamp(transfer.timestamp) : null;
      const price = Number(transfer.price);
      const normalizedPrice = Number.isFinite(price) ? price : null;
      const currency = transfer.currency ? String(transfer.currency).trim() : null;
      return {
        symbol,
        quantity,
        price: normalizedPrice,
        currency: currency || null,
        cashFlow: 0,
        timestamp: timestamp || null,
        type: 'transfer',
      };
    })
    .filter(Boolean);
}

function summarizePerformanceEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    return [];
  }
  return events.map(function (event, index) {
    const dateKey = toDateKey(event.timestamp) || '(no date)';
    const symbol = event.symbol || '(no symbol)';
    const quantity = Number.isFinite(event.quantity) ? event.quantity : null;
    const price = Number.isFinite(event.price) ? event.price : null;
    const cashFlow = Number.isFinite(event.cashFlow) ? event.cashFlow : null;
    const currency = event.currency || (event.metadata && event.metadata.currency) || null;
    const side = event.metadata && event.metadata.side ? event.metadata.side : null;
    const ref = event.metadata && event.metadata.reference ? event.metadata.reference : index + 1;
    const parts = [];
    parts.push('#' + ref);
    parts.push(dateKey);
    parts.push(event.type || 'event');
    parts.push(symbol);
    if (side) {
      parts.push(side.toUpperCase());
    }
    parts.push('qty=' + formatDecimal(quantity, 4));
    parts.push('price=' + formatDecimal(price, 4));
    parts.push('cash=' + formatDecimal(cashFlow, 2));
    if (currency) {
      parts.push('currency=' + currency);
    }
    return parts.join(' | ');
  });
}

function summarizeTimelineForDebug(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return [];
  }
  return entries.map(function (entry) {
    const date = entry.date || '(no date)';
    const value = Number.isFinite(entry.totalValue) ? entry.totalValue : Number(entry.value);
    let holdingsDescription = 'no holdings';
    if (Array.isArray(entry.holdings) && entry.holdings.length) {
      holdingsDescription = entry.holdings
        .map(function (holding) {
          const quantity = Number.isFinite(holding.quantity) ? holding.quantity : null;
          const price = Number.isFinite(holding.price) ? holding.price : null;
          const holdingValue = Number.isFinite(holding.value) ? holding.value : null;
          const currency = holding.currency || null;
          return (
            (holding.symbol || '(symbol)') +
            ' qty=' +
            formatDecimal(quantity, 4) +
            ' @ ' +
            formatDecimal(price, 4) +
            ' -> ' +
            formatDecimal(holdingValue, 2) +
            (currency ? ' ' + currency : '')
          );
        })
        .join(', ');
    }
    const currency = entry.currency || null;
    return (
      date +
      ': total=' +
      formatDecimal(value, 2) +
      (currency ? ' ' + currency : '') +
      ' | ' +
      holdingsDescription
    );
  });
}

function summarizeCashFlowsForDebug(flows) {
  if (!Array.isArray(flows) || !flows.length) {
    return [];
  }
  return flows.map(function (flow, index) {
    const timestamp = flow.timestamp || flow.date || '(no timestamp)';
    const amount = Number.isFinite(flow.amount) ? flow.amount : null;
    const originalAmount = Number.isFinite(flow.originalAmount) ? flow.originalAmount : null;
    const baseCurrency = flow.currency || null;
    const originalCurrency = flow.originalCurrency || null;
    const type = flow.type || 'flow';
    const symbol = flow.symbol || '(no symbol)';
    const status = flow.conversionStatus || null;
    const parts = [
      '#' + (index + 1),
      timestamp,
      type,
      symbol,
      'amount=' + formatDecimal(amount, 2) + (baseCurrency ? ' ' + baseCurrency : ''),
    ];
    if (originalAmount !== null && (!Number.isFinite(amount) || Math.abs(amount - originalAmount) > 0.0005 || (baseCurrency && originalCurrency && baseCurrency !== originalCurrency))) {
      parts.push(
        'original=' +
          formatDecimal(originalAmount, 2) +
          (originalCurrency ? ' ' + originalCurrency : '')
      );
    }
    if (status) {
      parts.push('status=' + status);
    }
    return parts.join(' ');
  });
}

function summarizePositionSnapshotForDebug(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return [];
  }
  return Object.keys(snapshot)
    .sort()
    .map(function (symbol) {
      const entry = snapshot[symbol] || {};
      const quantity = Number.isFinite(entry.quantity) ? entry.quantity : null;
      const price = Number.isFinite(entry.price) ? entry.price : null;
      const marketValue = Number.isFinite(entry.marketValue)
        ? entry.marketValue
        : Number.isFinite(quantity) && Number.isFinite(price)
        ? quantity * price
        : null;
      const currency = entry.currency || null;
      const parts = [
        symbol,
        'qty=' + formatDecimal(quantity, 4),
        'price=' + formatDecimal(price, 4),
        'value=' + formatDecimal(marketValue, 2),
      ];
      if (currency) {
        parts.push(currency);
      }
      return parts.join(' | ');
    });
}

function summarizeQuantityReconciliationForDebug(netQuantities, snapshot) {
  const symbols = new Set();
  if (netQuantities && typeof netQuantities.forEach === 'function') {
    netQuantities.forEach(function (_, symbol) {
      if (symbol) {
        symbols.add(symbol);
      }
    });
  }
  if (snapshot && typeof snapshot === 'object') {
    Object.keys(snapshot).forEach(function (symbol) {
      if (symbol) {
        symbols.add(symbol);
      }
    });
  }
  return Array.from(symbols)
    .sort()
    .map(function (symbol) {
      const hasEventQuantity =
        netQuantities && typeof netQuantities.has === 'function' && netQuantities.has(symbol);
      const eventQuantity = hasEventQuantity ? netQuantities.get(symbol) : 0;
      const snapshotEntry = snapshot && snapshot[symbol] ? snapshot[symbol] : null;
      const hasSnapshot = snapshotEntry && typeof snapshotEntry === 'object';
      const snapshotQuantity = hasSnapshot && Number.isFinite(snapshotEntry.quantity)
        ? snapshotEntry.quantity
        : null;
      const delta = Number.isFinite(snapshotQuantity)
        ? snapshotQuantity - eventQuantity
        : null;
      const currency = snapshotEntry && snapshotEntry.currency ? snapshotEntry.currency : null;
      const parts = [
        symbol,
        'events=' + formatDecimal(eventQuantity, 4) + (hasEventQuantity ? '' : ' (none)'),
        'snapshot=' + (Number.isFinite(snapshotQuantity) ? formatDecimal(snapshotQuantity, 4) : 'n/a'),
      ];
      parts.push('delta=' + (Number.isFinite(delta) ? formatDecimal(delta, 4) : 'n/a'));
      if (currency) {
        parts.push(currency);
      }
      return parts.join(' | ');
    });
}

function summarizeAggregatedTotalsForDebug(totals) {
  if (!totals || typeof totals !== 'object') {
    return [];
  }
  const startValue = Number(totals.startValue) || 0;
  const endValue = Number(totals.endValue) || 0;
  const contributions = Number(totals.totalContributions) || 0;
  const withdrawals = Number(totals.totalWithdrawals) || 0;
  const investedBase = startValue + contributions;
  const endingCapital = endValue + withdrawals;
  const totalReturn = Number.isFinite(totals.totalReturn) ? totals.totalReturn : null;
  const cagr = Number.isFinite(totals.cagr) ? totals.cagr : null;
  const lines = [];
  const periodLabel = (totals.startDate || 'n/a') + ' → ' + (totals.endDate || 'n/a');
  lines.push('period=' + periodLabel);
  lines.push('startValue=' + formatDecimal(startValue, 2));
  lines.push('endValue=' + formatDecimal(endValue, 2));
  lines.push('contributions=' + formatDecimal(contributions, 2));
  lines.push('withdrawals=' + formatDecimal(withdrawals, 2));
  lines.push('investedCapital=' + formatDecimal(investedBase, 2));
  lines.push('endingCapital=' + formatDecimal(endingCapital, 2));
  lines.push('pnl=' + formatDecimal(Number(totals.totalPnl) || 0, 2));
  lines.push(
    'totalReturn=' + (totalReturn !== null ? formatDecimal(totalReturn * 100, 2) + '%' : 'n/a')
  );
  lines.push('cagr=' + (cagr !== null ? formatDecimal(cagr * 100, 2) + '%' : 'n/a'));
  const startDate = totals.startDate ? parseTimestamp(totals.startDate + 'T00:00:00Z') : null;
  const endDate = totals.endDate ? parseTimestamp(totals.endDate + 'T00:00:00Z') : null;
  if (startDate && endDate && endDate >= startDate) {
    const durationDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 3600 * 1000));
    lines.push('duration=' + durationDays + ' days');
  }
  const netCashFlow = withdrawals - contributions;
  lines.push('netCashFlow=' + formatDecimal(netCashFlow, 2));
  return lines;
}

function buildPositionSnapshot(positions) {
  const snapshot = {};
  if (!Array.isArray(positions)) {
    return snapshot;
  }
  positions.forEach(function (position) {
    if (!position || typeof position !== 'object') {
      return;
    }
    const symbol = position.symbol ? String(position.symbol).trim() : null;
    if (!symbol) {
      return;
    }
    const quantity = Number(position.openQuantity);
    const price = Number(position.currentPrice);
    const marketValue = Number(position.currentMarketValue);
    const currency = position.currency ? String(position.currency).trim() : null;
    snapshot[symbol] = {
      quantity: Number.isFinite(quantity) ? quantity : 0,
      price: Number.isFinite(price) ? price : null,
      marketValue: Number.isFinite(marketValue) ? marketValue : null,
      currency: currency || null,
    };
  });
  return snapshot;
}

function resolveCashBalanceFromBalances(balances, baseCurrency) {
  if (!balances || typeof balances !== 'object') {
    return null;
  }
  const entries = [];
  if (Array.isArray(balances.perCurrencyBalances)) {
    entries.push.apply(entries, balances.perCurrencyBalances);
  }
  if (Array.isArray(balances.combinedBalances)) {
    entries.push.apply(entries, balances.combinedBalances);
  }
  if (!entries.length) {
    return null;
  }
  const targetCurrency = baseCurrency && typeof baseCurrency === 'string'
    ? baseCurrency.trim().toUpperCase()
    : null;
  let total = 0;
  let matched = false;
  entries.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const currency = entry.currency && typeof entry.currency === 'string'
      ? entry.currency.trim().toUpperCase()
      : null;
    if (targetCurrency && currency && currency !== targetCurrency) {
      return;
    }
    const cashValue = pickNumericValue(entry, 'cash');
    if (!Number.isFinite(cashValue)) {
      return;
    }
    if (targetCurrency && !currency) {
      return;
    }
    matched = true;
    total += cashValue;
  });
  if (!matched) {
    return null;
  }
  return total;
}

function buildSymbolCurrencyMap(positions, executions, transfers, fallbackCurrency) {
  const map = new Map();
  const assign = function (symbol, currency) {
    if (!symbol || typeof symbol !== 'string') {
      return;
    }
    const trimmedSymbol = symbol.trim();
    if (!trimmedSymbol) {
      return;
    }
    if (!currency || typeof currency !== 'string') {
      return;
    }
    const normalizedCurrency = currency.trim().toUpperCase();
    if (!normalizedCurrency) {
      return;
    }
    if (!map.has(trimmedSymbol)) {
      map.set(trimmedSymbol, normalizedCurrency);
    }
  };

  if (Array.isArray(positions)) {
    positions.forEach(function (position) {
      if (!position || typeof position !== 'object') {
        return;
      }
      assign(position.symbol, position.currency || fallbackCurrency || null);
    });
  }

  if (Array.isArray(executions)) {
    executions.forEach(function (execution) {
      if (!execution || typeof execution !== 'object') {
        return;
      }
      const symbol = execution.symbol || execution.symbolId || null;
      const currency = resolveExecutionCurrency(execution) || execution.currency || null;
      if (symbol && currency) {
        assign(String(symbol), currency);
      }
    });
  }

  if (Array.isArray(transfers)) {
    transfers.forEach(function (transfer) {
      if (!transfer || typeof transfer !== 'object') {
        return;
      }
      assign(transfer.symbol, transfer.currency || fallbackCurrency || null);
    });
  }

  return map;
}

function resolveFxPairSymbol(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency) {
    return null;
  }
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (!from || !to || from === to) {
    return null;
  }
  return from + to + '=X';
}

async function fetchFxSeries(pairSymbol, startDate, endDate) {
  if (!pairSymbol) {
    return [];
  }
  const period1 = new Date(startDate.getTime() - 24 * 3600 * 1000);
  const period2 = new Date(endDate.getTime() + 24 * 3600 * 1000);
  try {
    const history = await yahooFinance.historical(pairSymbol, {
      period1,
      period2,
      interval: '1d',
    });
    if (!Array.isArray(history)) {
      return [];
    }
    const dedup = new Map();
    history.forEach(function (entry) {
      if (!entry || !entry.date) {
        return;
      }
      const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
      if (Number.isNaN(date.getTime())) {
        return;
      }
      const rateCandidate = Number.isFinite(entry.adjClose) ? entry.adjClose : Number(entry.close);
      if (!Number.isFinite(rateCandidate) || rateCandidate <= 0) {
        return;
      }
      const key = date.toISOString().slice(0, 10);
      dedup.set(key, rateCandidate);
    });
    return Array.from(dedup.entries())
      .map(function ([date, rate]) {
        return { date, rate };
      })
      .sort(function (a, b) {
        return a.date.localeCompare(b.date);
      });
  } catch (error) {
    console.warn('Failed to load FX history for pair ' + pairSymbol + ':', error.message);
    return [];
  }
}

function resolveFxRateForDate(series, targetDate) {
  if (!Array.isArray(series) || !series.length) {
    return null;
  }
  if (!targetDate) {
    const fallback = series[series.length - 1];
    return fallback && Number.isFinite(fallback.rate) ? fallback.rate : null;
  }
  let latestRate = null;
  for (let index = 0; index < series.length; index += 1) {
    const entry = series[index];
    if (!entry || !entry.date) {
      continue;
    }
    if (!Number.isFinite(entry.rate)) {
      continue;
    }
    if (entry.date <= targetDate) {
      latestRate = entry.rate;
      continue;
    }
    if (entry.date > targetDate) {
      if (latestRate !== null) {
        return latestRate;
      }
      return entry.rate;
    }
  }
  return latestRate;
}

function convertSeriesWithFx(history, fxSeries) {
  if (!Array.isArray(history) || !history.length) {
    return [];
  }
  if (!Array.isArray(fxSeries) || !fxSeries.length) {
    return history
      .filter(function (point) {
        return point && point.date && Number.isFinite(point.price);
      })
      .map(function (point) {
        return { date: point.date, price: point.price };
      });
  }
  const sortedFx = fxSeries
    .filter(function (entry) {
      return entry && entry.date && Number.isFinite(entry.rate);
    })
    .sort(function (a, b) {
      return a.date.localeCompare(b.date);
    });
  if (!sortedFx.length) {
    return [];
  }
  const converted = [];
  const rateCache = new Map();
  history.forEach(function (point) {
    if (!point || !point.date || !Number.isFinite(point.price)) {
      return;
    }
    let rate = rateCache.get(point.date);
    if (rate === undefined) {
      rate = resolveFxRateForDate(sortedFx, point.date);
      rateCache.set(point.date, rate);
    }
    if (!Number.isFinite(rate)) {
      return;
    }
    converted.push({ date: point.date, price: point.price * rate });
  });
  return converted;
}

function convertValueWithFx(value, fxSeries, targetDate) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (!Array.isArray(fxSeries) || !fxSeries.length) {
    return value;
  }
  const rate = resolveFxRateForDate(fxSeries, targetDate);
  if (!Number.isFinite(rate)) {
    return null;
  }
  return value * rate;
}

function convertCashFlowToBase(event, baseCurrency, fxCache) {
  if (!event || !Number.isFinite(event.cashFlow) || Math.abs(event.cashFlow) < 0.00001) {
    return null;
  }
  const originalAmount = event.cashFlow;
  const originalCurrency = event.currency || null;
  if (!baseCurrency || !originalCurrency || originalCurrency === baseCurrency) {
    return {
      amount: originalAmount,
      currency: baseCurrency || originalCurrency || null,
      originalAmount,
      originalCurrency,
      status: 'native',
    };
  }
  const normalizedCurrency = originalCurrency.trim().toUpperCase();
  const fxInfo = fxCache && fxCache.get(normalizedCurrency);
  if (!fxInfo || !Array.isArray(fxInfo.series) || !fxInfo.series.length) {
    return {
      amount: originalAmount,
      currency: originalCurrency,
      originalAmount,
      originalCurrency,
      status: 'fx-missing',
    };
  }
  const dateKey = toDateKey(event.timestamp) || null;
  const rate = resolveFxRateForDate(fxInfo.series, dateKey);
  if (!Number.isFinite(rate)) {
    return {
      amount: originalAmount,
      currency: originalCurrency,
      originalAmount,
      originalCurrency,
      status: 'fx-rate-missing',
    };
  }
  return {
    amount: originalAmount * rate,
    currency: baseCurrency,
    originalAmount,
    originalCurrency,
    status: 'converted',
  };
}

async function fetchHistoricalPrices(symbol, startDate, endDate) {
  const period1 = new Date(startDate.getTime() - 24 * 3600 * 1000);
  const period2 = new Date(endDate.getTime() + 24 * 3600 * 1000);
  try {
    const history = await yahooFinance.historical(symbol, {
      period1,
      period2,
      interval: '1d',
    });
    if (!Array.isArray(history)) {
      return [];
    }
    const dedup = new Map();
    history.forEach(function (entry) {
      if (!entry || !entry.date) {
        return;
      }
      const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
      if (Number.isNaN(date.getTime())) {
        return;
      }
      const price = Number.isFinite(entry.adjClose) ? entry.adjClose : Number(entry.close);
      if (!Number.isFinite(price)) {
        return;
      }
      const key = date.toISOString().slice(0, 10);
      dedup.set(key, price);
    });
    return Array.from(dedup.entries())
      .map(function ([date, price]) {
        return { date, price };
      })
      .sort(function (a, b) {
        return a.date.localeCompare(b.date);
      });
  } catch (error) {
    console.warn('Failed to load price history for symbol ' + symbol + ':', error.message);
    return [];
  }
}

async function buildPriceSeries(
  symbols,
  startDate,
  endDate,
  finalDateKey,
  positionSnapshot,
  options = {}
) {
  const baseCurrency = options.baseCurrency && typeof options.baseCurrency === 'string'
    ? options.baseCurrency.trim().toUpperCase()
    : null;
  const currencyMapInput = options.currencyBySymbol;
  const currencyBySymbol = currencyMapInput instanceof Map ? currencyMapInput : new Map();
  if (!(currencyMapInput instanceof Map) && currencyMapInput && typeof currencyMapInput === 'object') {
    Object.keys(currencyMapInput).forEach(function (key) {
      const value = currencyMapInput[key];
      if (typeof value === 'string' && value.trim()) {
        currencyBySymbol.set(key, value.trim().toUpperCase());
      }
    });
  }

  const seriesMap = new Map();
  const fxCache = new Map();
  const diagnostics = {
    baseCurrency: baseCurrency || null,
    symbols: [],
    fxPairs: [],
  };

  const ensureFxSeries = async function (fromCurrency) {
    if (!fromCurrency || !baseCurrency || fromCurrency === baseCurrency) {
      return null;
    }
    const normalizedFrom = fromCurrency.trim().toUpperCase();
    if (!normalizedFrom || normalizedFrom === baseCurrency) {
      return null;
    }
    if (fxCache.has(normalizedFrom)) {
      return fxCache.get(normalizedFrom);
    }
    const pairSymbol = resolveFxPairSymbol(normalizedFrom, baseCurrency);
    let series = [];
    let status = 'skipped';
    if (pairSymbol) {
      series = await fetchFxSeries(pairSymbol, startDate, endDate);
      status = series.length ? 'ok' : 'empty';
    } else {
      status = 'unavailable';
    }
    const entry = {
      series,
      pairSymbol,
      fromCurrency: normalizedFrom,
      toCurrency: baseCurrency,
      status,
    };
    fxCache.set(normalizedFrom, entry);
    diagnostics.fxPairs.push({
      fromCurrency: normalizedFrom,
      toCurrency: baseCurrency,
      pairSymbol,
      points: series.length,
      status,
    });
    return entry;
  };

  for (const symbol of symbols) {
    const history = await fetchHistoricalPrices(symbol, startDate, endDate);
    const instrumentCurrency = currencyBySymbol.get(symbol) || baseCurrency || null;
    const fxInfo = await ensureFxSeries(instrumentCurrency);
    const convertedHistory = fxInfo && Array.isArray(fxInfo.series) && fxInfo.series.length
      ? convertSeriesWithFx(history, fxInfo.series)
      : history
          .filter(function (point) {
            return point && point.date && Number.isFinite(point.price);
          })
          .map(function (point) {
            return { date: point.date, price: point.price };
          });

    const pointsMap = new Map();
    convertedHistory.forEach(function (entry) {
      if (!entry || !entry.date) {
        return;
      }
      pointsMap.set(entry.date, entry.price);
    });

    const snapshot = positionSnapshot[symbol];
    let snapshotPrice = null;
    let snapshotConversion = null;
    if (snapshot && finalDateKey) {
      if (Number.isFinite(snapshot.price) && snapshot.price > 0) {
        snapshotPrice = snapshot.price;
      } else if (
        Number.isFinite(snapshot.marketValue) &&
        Number.isFinite(snapshot.quantity) &&
        Math.abs(snapshot.quantity) > 1e-9 &&
        snapshot.marketValue !== 0
      ) {
        snapshotPrice = snapshot.marketValue / snapshot.quantity;
      }
      if (Number.isFinite(snapshotPrice) && snapshotPrice > 0) {
        let converted = snapshotPrice;
        if (fxInfo && Array.isArray(fxInfo.series) && fxInfo.series.length) {
          const maybeConverted = convertValueWithFx(snapshotPrice, fxInfo.series, finalDateKey);
          if (Number.isFinite(maybeConverted) && maybeConverted > 0) {
            converted = maybeConverted;
            snapshotConversion = 'converted';
          } else {
            snapshotConversion = 'fx-fallback';
          }
        } else if (fxInfo && (!Array.isArray(fxInfo.series) || !fxInfo.series.length)) {
          snapshotConversion = 'fx-missing';
        } else {
          snapshotConversion = 'native';
        }
        if (Number.isFinite(converted) && converted > 0) {
          pointsMap.set(finalDateKey, converted);
        }
      }
    }

    const ordered = Array.from(pointsMap.entries())
      .map(function ([date, price]) {
        return { date, price };
      })
      .sort(function (a, b) {
        return a.date.localeCompare(b.date);
      });

    seriesMap.set(symbol, ordered);

    diagnostics.symbols.push({
      symbol,
      currency: instrumentCurrency || null,
      pricePoints: history.length,
      convertedPoints: ordered.length,
      fxPair: fxInfo ? fxInfo.pairSymbol : null,
      fxStatus: fxInfo ? fxInfo.status : baseCurrency ? 'base' : 'unknown',
      snapshotApplied: Number.isFinite(snapshotPrice),
      snapshotConversion,
    });
  }

  return { seriesMap, fxCache, diagnostics };
}

function computeAccountPerformanceTimeline(events, priceSeries, symbols, finalDateKey, options) {
  const debug = options && options.debug;
  const baseCurrency = options && typeof options.baseCurrency === 'string' && options.baseCurrency
    ? options.baseCurrency
    : null;
  const changeMaps = new Map();
  const dateSet = new Set();

  events.forEach(function (event) {
    const dateKey = toDateKey(event.timestamp);
    if (!dateKey) {
      return;
    }
    dateSet.add(dateKey);
    let symbolMap = changeMaps.get(event.symbol);
    if (!symbolMap) {
      symbolMap = new Map();
      changeMaps.set(event.symbol, symbolMap);
    }
    symbolMap.set(dateKey, (symbolMap.get(dateKey) || 0) + event.quantity);
  });

  priceSeries.forEach(function (points) {
    points.forEach(function (point) {
      if (point && point.date) {
        dateSet.add(point.date);
      }
    });
  });

  if (finalDateKey) {
    dateSet.add(finalDateKey);
  }

  const sortedDates = Array.from(dateSet).filter(Boolean).sort(function (a, b) {
    return a.localeCompare(b);
  });

  const priceCursors = new Map();
  symbols.forEach(function (symbol) {
    const points = priceSeries.get(symbol) || [];
    priceCursors.set(symbol, { points, index: 0, lastPrice: null });
  });

  const quantityBySymbol = new Map();
  const timeline = [];
  const debugDetails = debug ? [] : null;

  sortedDates.forEach(function (dateKey) {
    const holdings = debug ? [] : null;
    symbols.forEach(function (symbol) {
      const symbolMap = changeMaps.get(symbol);
      if (symbolMap && symbolMap.has(dateKey)) {
        const next = (quantityBySymbol.get(symbol) || 0) + symbolMap.get(dateKey);
        if (Math.abs(next) < 1e-9) {
          quantityBySymbol.delete(symbol);
        } else {
          quantityBySymbol.set(symbol, next);
        }
      }
    });

    let totalValue = 0;
    symbols.forEach(function (symbol) {
      const cursor = priceCursors.get(symbol);
      if (!cursor) {
        return;
      }
      while (cursor.index < cursor.points.length && cursor.points[cursor.index].date <= dateKey) {
        cursor.lastPrice = cursor.points[cursor.index].price;
        cursor.index += 1;
      }
      const quantity = quantityBySymbol.get(symbol) || 0;
      if (!quantity) {
        return;
      }
      if (!Number.isFinite(cursor.lastPrice)) {
        return;
      }
      totalValue += quantity * cursor.lastPrice;
      if (debug && holdings) {
        holdings.push({
          symbol,
          quantity,
          price: cursor.lastPrice,
          value: quantity * cursor.lastPrice,
          currency: baseCurrency || null,
        });
      }
    });

    const value = Number.isFinite(totalValue) ? totalValue : 0;
    const entry = { date: dateKey, value };
    if (baseCurrency) {
      entry.currency = baseCurrency;
    }
    timeline.push(entry);
    if (debug && debugDetails) {
      debugDetails.push({
        date: dateKey,
        totalValue: value,
        holdings: holdings || [],
        currency: baseCurrency || null,
      });
    }
  });

  if (debug && debugDetails) {
    return { timeline, debugDetails };
  }
  return timeline;
}

function computeAggregatedMetrics(timeline, cashFlows) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return {
      startDate: null,
      endDate: null,
      startValue: 0,
      endValue: 0,
      totalContributions: 0,
      totalWithdrawals: 0,
      totalPnl: 0,
      totalReturn: null,
      cagr: null,
    };
  }

  const startEntry = timeline[0];
  const endEntry = timeline[timeline.length - 1];
  const startValue = Number(startEntry.value) || 0;
  const endValue = Number(endEntry.value) || 0;

  let totalContributions = 0;
  let totalWithdrawals = 0;
  if (Array.isArray(cashFlows)) {
    cashFlows.forEach(function (flow) {
      const amount = Number(flow.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        return;
      }
      if (amount > 0) {
        totalWithdrawals += amount;
      } else {
        totalContributions += -amount;
      }
    });
  }

  const totalPnl = (endValue + totalWithdrawals) - (startValue + totalContributions);
  const investedBase = startValue + totalContributions;
  const totalReturn = investedBase > 0 ? totalPnl / investedBase : null;

  const startDate = startEntry.date || null;
  const endDate = endEntry.date || null;
  const startTime = startDate ? parseTimestamp(startDate + 'T00:00:00Z') : null;
  const endTime = endDate ? parseTimestamp(endDate + 'T00:00:00Z') : null;
  let cagr = null;
  if (startTime && endTime && endTime > startTime && investedBase > 0 && endValue > 0) {
    const durationYears = (endTime.getTime() - startTime.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (durationYears > 0) {
      const endingCapital = endValue + totalWithdrawals;
      const startingCapital = investedBase;
      if (endingCapital > 0 && startingCapital > 0) {
        cagr = Math.pow(endingCapital / startingCapital, 1 / durationYears) - 1;
      }
    }
  }

  return {
    startDate,
    endDate,
    startValue,
    endValue,
    totalContributions,
    totalWithdrawals,
    totalPnl,
    totalReturn,
    cagr,
  };
}

function ensureEventTimestamps(events, fallbackTimestamp) {
  if (!Array.isArray(events)) {
    return;
  }
  events.forEach(function (event) {
    if (!event.timestamp) {
      event.timestamp = fallbackTimestamp ? new Date(fallbackTimestamp.getTime()) : null;
    }
  });
}

async function generateAccountPerformance({ executions, transfers, positions, balances, account }) {
  if (PERFORMANCE_DEBUG_ENABLED) {
    const executionSummaries = summarizeExecutionsForDebug(executions);
    const count = Array.isArray(executions) ? executions.length : 0;
    if (executionSummaries.length) {
      performanceDebug(
        'Executions fetched from Questrade (count=' +
          count +
          '):\n' +
          executionSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Executions fetched from Questrade (count=' + count + '): none');
    }
  }

  const executionEvents = normalizeExecutionEvents(executions);
  if (PERFORMANCE_DEBUG_ENABLED) {
    const normalizedSummaries = summarizePerformanceEvents(executionEvents);
    if (normalizedSummaries.length) {
      performanceDebug(
        'Normalized execution events (count=' +
          executionEvents.length +
          '):\n' +
          normalizedSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Normalized execution events (count=0): none');
    }
  }

  const accountCurrency = account && typeof account.currency === 'string' ? account.currency.trim().toUpperCase() : null;
  let baseCurrency = accountCurrency || null;
  if (!baseCurrency && Array.isArray(positions)) {
    const positionWithCurrency = positions.find(function (position) {
      return position && typeof position.currency === 'string' && position.currency.trim();
    });
    if (positionWithCurrency && positionWithCurrency.currency) {
      baseCurrency = positionWithCurrency.currency.trim().toUpperCase();
    }
  }
  if (!baseCurrency && Array.isArray(executionEvents)) {
    const eventWithCurrency = executionEvents.find(function (event) {
      return event && typeof event.currency === 'string' && event.currency.trim();
    });
    if (eventWithCurrency && eventWithCurrency.currency) {
      baseCurrency = eventWithCurrency.currency.trim().toUpperCase();
    }
  }
  if (!baseCurrency) {
    baseCurrency = 'CAD';
  }

  const symbolCurrencyMap = buildSymbolCurrencyMap(positions, executions, transfers, baseCurrency);
  if (PERFORMANCE_DEBUG_ENABLED) {
    const currencyMappings = Array.from(symbolCurrencyMap.entries()).map(function ([symbol, currency]) {
      return symbol + ' → ' + currency;
    });
    performanceDebug(
      'Performance currency context: base=' +
        (baseCurrency || 'n/a') +
        ', account=' +
        (accountCurrency || 'n/a') +
        (currencyMappings.length ? '\n  symbol currencies:\n    ' + currencyMappings.join('\n    ') : '')
    );
  }

  const transferEvents = normalizeTransferEvents(transfers);
  const positionSnapshot = buildPositionSnapshot(positions);
  const cashBaseline = resolveCashBalanceFromBalances(balances, baseCurrency);
  if (PERFORMANCE_DEBUG_ENABLED) {
    const snapshotCount = Object.keys(positionSnapshot).length;
    const snapshotSummaries = summarizePositionSnapshotForDebug(positionSnapshot);
    if (snapshotSummaries.length) {
      performanceDebug(
        'Position snapshot baseline (count=' +
          snapshotCount +
          '):\n' +
          snapshotSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Position snapshot baseline: none');
    }
    performanceDebug(
      'Cash baseline (base ' +
        (baseCurrency || 'n/a') +
        '): ' +
        (Number.isFinite(cashBaseline) ? formatDecimal(cashBaseline, 2) : 'n/a')
    );
  }
  const now = new Date();
  const finalDateKey = now.toISOString().slice(0, 10);

  const events = executionEvents.concat(transferEvents);
  if (PERFORMANCE_DEBUG_ENABLED && transferEvents.length) {
    const transferSummaries = summarizePerformanceEvents(transferEvents);
    performanceDebug(
      'Transfer events included (count=' +
        transferEvents.length +
        '):\n' +
        transferSummaries
          .map(function (line) {
            return '  ' + line;
          })
          .join('\n')
    );
  }

  let earliestTimestamp = null;
  events.forEach(function (event) {
    if (!event.timestamp) {
      return;
    }
    if (!earliestTimestamp || event.timestamp < earliestTimestamp) {
      earliestTimestamp = event.timestamp;
    }
  });

  if (!earliestTimestamp) {
    earliestTimestamp = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  }

  ensureEventTimestamps(events, new Date(earliestTimestamp.getTime() - 24 * 3600 * 1000));

  const netQuantities = new Map();
  events.forEach(function (event) {
    netQuantities.set(event.symbol, (netQuantities.get(event.symbol) || 0) + event.quantity);
  });
  if (PERFORMANCE_DEBUG_ENABLED) {
    const reconciliationSummaries = summarizeQuantityReconciliationForDebug(netQuantities, positionSnapshot);
    if (reconciliationSummaries.length) {
      performanceDebug(
        'Net position coverage before adjustments:\n' +
          reconciliationSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Net position coverage before adjustments: none');
    }
  }

  const adjustmentTimestamp = earliestTimestamp ? new Date(earliestTimestamp.getTime()) : new Date(now.getTime());
  const adjustmentEvents = [];

  Object.keys(positionSnapshot).forEach(function (symbol) {
    const snapshot = positionSnapshot[symbol];
    const targetQuantity = snapshot && Number.isFinite(snapshot.quantity) ? snapshot.quantity : 0;
    const current = netQuantities.get(symbol) || 0;
    const delta = targetQuantity - current;
    if (Math.abs(delta) > 1e-6) {
      const adjustmentCurrency = snapshot && snapshot.currency
        ? snapshot.currency.trim().toUpperCase()
        : baseCurrency;
      const adjustment = {
        symbol,
        quantity: delta,
        price: snapshot && Number.isFinite(snapshot.price) ? snapshot.price : null,
        cashFlow: 0,
        timestamp: new Date(adjustmentTimestamp.getTime()),
        type: 'adjustment',
        currency: adjustmentCurrency || null,
      };
      events.push(adjustment);
      adjustmentEvents.push(adjustment);
    }
  });

  if (PERFORMANCE_DEBUG_ENABLED && adjustmentEvents.length) {
    const adjustmentSummaries = summarizePerformanceEvents(adjustmentEvents);
    performanceDebug(
      'Position adjustments applied (count=' +
        adjustmentEvents.length +
        '):\n' +
        adjustmentSummaries
          .map(function (line) {
            return '  ' + line;
          })
          .join('\n')
    );
  }

  events.sort(function (a, b) {
    const timeA = a.timestamp ? a.timestamp.getTime() : 0;
    const timeB = b.timestamp ? b.timestamp.getTime() : 0;
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return a.symbol.localeCompare(b.symbol);
  });

  const symbols = new Set();
  events.forEach(function (event) {
    if (event.symbol) {
      symbols.add(event.symbol);
    }
  });
  Object.keys(positionSnapshot).forEach(function (symbol) {
    if (symbol) {
      symbols.add(symbol);
    }
  });

  if (!symbols.size) {
    return {
      timeline: [],
      cashFlows: [],
      totals: computeAggregatedMetrics([], []),
      metadata: {
        eventCount: 0,
        symbolCount: 0,
        generatedAt: now.toISOString(),
      },
    };
  }

  const sortedSymbols = Array.from(symbols).sort();

  const earliestEventTime = events.length ? events[0].timestamp || earliestTimestamp : earliestTimestamp;
  const startDate = earliestEventTime ? new Date(earliestEventTime.getTime()) : new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const priceSeriesResult = await buildPriceSeries(sortedSymbols, startDate, now, finalDateKey, positionSnapshot, {
    baseCurrency,
    currencyBySymbol: symbolCurrencyMap,
  });
  const priceSeries = priceSeriesResult.seriesMap;
  const fxCache = priceSeriesResult.fxCache;
  if (PERFORMANCE_DEBUG_ENABLED && priceSeriesResult.diagnostics) {
    performanceDebug(
      'Price series diagnostics (base ' +
        (priceSeriesResult.diagnostics.baseCurrency || 'n/a') +
        '):\n' +
        priceSeriesResult.diagnostics.symbols
          .map(function (entry) {
            return (
              '  ' +
              entry.symbol +
              ' currency=' +
              (entry.currency || 'n/a') +
              ' points=' +
              entry.pricePoints +
              ' converted=' +
              entry.convertedPoints +
              (entry.fxPair ? ' fx=' + entry.fxPair + ' (' + entry.fxStatus + ')' : ' fx=' + entry.fxStatus) +
              (entry.snapshotApplied
                ? ' snapshot=' + (entry.snapshotConversion || 'applied')
                : '')
            );
          })
          .join('\n') +
        (priceSeriesResult.diagnostics.fxPairs.length
          ? '\n  fx pairs:\n' +
            priceSeriesResult.diagnostics.fxPairs
              .map(function (fx) {
                return (
                  '    ' +
                  fx.fromCurrency +
                  '→' +
                  (fx.toCurrency || 'n/a') +
                  ' pair=' +
                  (fx.pairSymbol || 'n/a') +
                  ' points=' +
                  fx.points +
                  ' status=' +
                  fx.status
                );
              })
              .join('\n')
          : '')
    );
  }

  const timelineResult = computeAccountPerformanceTimeline(events, priceSeries, sortedSymbols, finalDateKey, {
    debug: PERFORMANCE_DEBUG_ENABLED,
    baseCurrency,
  });
  const timeline = Array.isArray(timelineResult) ? timelineResult : timelineResult.timeline;
  const debugTimelineEntries = !Array.isArray(timelineResult) && timelineResult && timelineResult.debugDetails
    ? timelineResult.debugDetails
    : [];

  const cashFlows = events
    .filter(function (event) {
      return Number.isFinite(event.cashFlow) && Math.abs(event.cashFlow) > 0.00001;
    })
    .map(function (event) {
      const converted = convertCashFlowToBase(event, baseCurrency, fxCache);
      const amount = converted ? converted.amount : event.cashFlow;
      const currency = converted ? converted.currency : baseCurrency;
      const originalAmount = converted ? converted.originalAmount : event.cashFlow;
      const originalCurrency = converted ? converted.originalCurrency || event.currency || null : event.currency || null;
      const flow = {
        timestamp: event.timestamp ? event.timestamp.toISOString() : null,
        amount,
        symbol: event.symbol,
        type: event.type,
      };
      if (currency) {
        flow.currency = currency;
      }
      if (originalAmount !== amount || (originalCurrency && currency && originalCurrency !== currency)) {
        flow.originalAmount = originalAmount;
        flow.originalCurrency = originalCurrency;
      }
      if (converted && converted.status && converted.status !== 'converted' && converted.status !== 'native') {
        flow.conversionStatus = converted.status;
      }
      return flow;
    });

  if (Number.isFinite(cashBaseline) && timeline.length) {
    const cashByDate = new Map();
    cashFlows.forEach(function (flow) {
      const dateKey = toDateKey(flow.timestamp || flow.date);
      if (!dateKey) {
        return;
      }
      cashByDate.set(dateKey, (cashByDate.get(dateKey) || 0) + (Number(flow.amount) || 0));
    });
    let runningCash = Number.isFinite(cashBaseline) ? cashBaseline : null;
    if (Number.isFinite(runningCash)) {
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const entry = timeline[index];
        entry.cashValue = runningCash;
        entry.value = (Number(entry.value) || 0) + runningCash;
        if (PERFORMANCE_DEBUG_ENABLED && debugTimelineEntries[index] && Array.isArray(debugTimelineEntries[index].holdings)) {
          debugTimelineEntries[index].holdings.push({
            symbol: 'CASH',
            quantity: runningCash,
            price: 1,
            value: runningCash,
            currency: baseCurrency || null,
          });
          debugTimelineEntries[index].totalValue = entry.value;
        }
        const dateKey = entry.date || null;
        if (dateKey && cashByDate.has(dateKey)) {
          runningCash -= cashByDate.get(dateKey);
        }
      }
    }
  }

  if (PERFORMANCE_DEBUG_ENABLED) {
    const summaryEntries = debugTimelineEntries.length ? debugTimelineEntries : timeline;
    const timelineSummaries = summarizeTimelineForDebug(summaryEntries);
    if (timelineSummaries.length) {
      const startLabel = timeline.length ? timeline[0].date : 'n/a';
      const endLabel = timeline.length ? timeline[timeline.length - 1].date : 'n/a';
      performanceDebug(
        'Account value timeline (' +
          timeline.length +
          ' entries, ' +
          'range ' +
          startLabel +
          ' → ' +
          endLabel +
          ') ' +
          (baseCurrency ? '[' + baseCurrency + ']' : '') +
          ':\n' +
          timelineSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Account value timeline is empty.');
    }
  }

  if (PERFORMANCE_DEBUG_ENABLED) {
    const cashFlowSummaries = summarizeCashFlowsForDebug(cashFlows);
    if (cashFlowSummaries.length) {
      performanceDebug(
        'Cash flows considered (' +
          cashFlows.length +
          '):\n' +
          cashFlowSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Cash flows considered: none');
    }
  }

  const totals = computeAggregatedMetrics(
    timeline,
    cashFlows.filter(function (flow) {
      return (flow.type || '') !== 'execution';
    })
  );
  if (PERFORMANCE_DEBUG_ENABLED) {
    const totalsSummaries = summarizeAggregatedTotalsForDebug(totals);
    if (totalsSummaries.length) {
      performanceDebug(
        'Aggregated totals (' +
          (baseCurrency || 'n/a') +
          '):\n' +
          totalsSummaries
            .map(function (line) {
              return '  ' + line;
            })
            .join('\n')
      );
    } else {
      performanceDebug('Aggregated totals (' + (baseCurrency || 'n/a') + '): none');
    }
    performanceDebug('Aggregated totals raw data:', totals);
  }

  return {
    timeline,
    cashFlows,
    totals,
    metadata: {
      eventCount: events.length,
      symbolCount: sortedSymbols.length,
      generatedAt: now.toISOString(),
      accountId: account ? account.id : null,
      baseCurrency,
      accountCurrency: accountCurrency || null,
      currencyDiagnostics: {
        symbolCurrencyCount: symbolCurrencyMap.size,
      },
      cashBaseline: Number.isFinite(cashBaseline) ? cashBaseline : null,
    },
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
    const { accountCollections, allAccounts, accountsById, defaultAccount } = await loadAccountsData(configuredDefaultKey);

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

app.get('/api/account-performance', async function (req, res) {
  const rawAccountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
  if (!rawAccountId) {
    return res.status(400).json({ message: 'Query parameter "accountId" is required.' });
  }
  if (rawAccountId === 'all') {
    return res
      .status(400)
      .json({ message: 'Performance metrics are only available when viewing a single account.' });
  }

  try {
    const configuredDefaultKey = getDefaultAccountId();
    const { accountCollections, accountsById, allAccounts } = await loadAccountsData(configuredDefaultKey);

    let targetAccount = accountsById[rawAccountId] || null;
    if (!targetAccount) {
      targetAccount = allAccounts.find(function (account) {
        return account && (account.number === rawAccountId || account.accountNumber === rawAccountId);
      });
    }

    if (!targetAccount) {
      return res.status(404).json({ message: 'No matching account found for performance analysis.' });
    }

    const collection = accountCollections.find(function (entry) {
      return entry && entry.login && entry.login.id === targetAccount.loginId;
    });
    if (!collection || !collection.login) {
      return res.status(500).json({ message: 'Unable to resolve login context for the requested account.' });
    }

    const login = collection.login;
    const accountNumber = targetAccount.number;
    if (!accountNumber) {
      return res.status(500).json({ message: 'Account number unavailable for performance query.' });
    }

    const startTimeParam = typeof req.query.startTime === 'string' ? req.query.startTime.trim() : '';
    const endTimeParam = typeof req.query.endTime === 'string' ? req.query.endTime.trim() : '';
    const executionOptions = {};
    if (startTimeParam) {
      executionOptions.startTime = startTimeParam;
    } else {
      executionOptions.startTime = '1970-01-01T00:00:00Z';
    }
    if (endTimeParam) {
      executionOptions.endTime = endTimeParam;
    }

    const [positions, executions, balances] = await Promise.all([
      fetchPositions(login, accountNumber),
      fetchExecutions(login, accountNumber, executionOptions),
      fetchBalances(login, accountNumber),
    ]);

    const transfers = Array.isArray(targetAccount.performanceTransfers) ? targetAccount.performanceTransfers : [];

    const performance = await generateAccountPerformance({
      executions,
      transfers,
      positions,
      balances,
      account: targetAccount,
    });

    res.json({
      accountId: targetAccount.id,
      accountNumber: targetAccount.number,
      accountType: targetAccount.type || null,
      currency: targetAccount.currency || null,
      generatedAt: new Date().toISOString(),
      timeline: performance.timeline,
      cashFlows: performance.cashFlows,
      totals: performance.totals,
      metadata: performance.metadata,
    });
  } catch (error) {
    if (error.response) {
      return res
        .status(error.response.status)
        .json({ message: 'Questrade API error', details: error.response.data });
    }
    res.status(500).json({ message: 'Failed to compute account performance.', details: error.message });
  }
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, function () {
  console.log('Server listening on port ' + PORT);
});



























