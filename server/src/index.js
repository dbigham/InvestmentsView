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
  updateAccountLastRebalance,
} = require('./accountNames');
const { getAccountBeneficiaries } = require('./accountBeneficiaries');
const { getQqqTemperatureSummary } = require('./qqqTemperature');
const { evaluateInvestmentModel, evaluateInvestmentModelTemperatureChart } = require('./investmentModel');
const {
  CASH_FLOW_EPSILON,
  DAY_IN_MS,
  normalizeCashFlowsForXirr,
  computeAnnualizedReturnFromCashFlows,
} = require('./xirr');

const RETURN_BREAKDOWN_PERIODS = [
  { key: 'ten_year', months: 120 },
  { key: 'five_year', months: 60 },
  { key: 'twelve_month', months: 12 },
  { key: 'six_month', months: 6 },
  { key: 'one_month', months: 1 },
];

const DEFAULT_TEMPERATURE_CHART_START_DATE = '1980-01-01';

const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const tokenCache = new NodeCache();
const tokenFilePath = path.join(__dirname, '..', 'token-store.json');

let yahooFinance = null;
let yahooFinanceLoadError = null;

try {
  // yahoo-finance2 is distributed as an ESM module with a default export.
  // eslint-disable-next-line global-require
  yahooFinance = require('yahoo-finance2').default;
  if (yahooFinance && typeof yahooFinance.suppressNotices === 'function') {
    yahooFinance.suppressNotices(['ripHistorical']);
  }
} catch (error) {
  yahooFinanceLoadError = error instanceof Error ? error : new Error(String(error));
  yahooFinance = null;
}

const YAHOO_MISSING_DEPENDENCY_MESSAGE =
  'The "yahoo-finance2" package is required to fetch quote data. ' +
  'Run `npm install` inside the server directory to install it.';

class MissingYahooDependencyError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MissingYahooDependencyError';
    this.code = 'MISSING_DEPENDENCY';
    if (cause) {
      this.cause = cause;
    }
  }
}

if (!yahooFinance && yahooFinanceLoadError) {
  console.warn('[Quote API] yahoo-finance2 dependency not found:', yahooFinanceLoadError.message);
  console.warn('[Quote API]', YAHOO_MISSING_DEPENDENCY_MESSAGE);
}

function ensureYahooFinanceClient() {
  if (!yahooFinance) {
    throw new MissingYahooDependencyError(YAHOO_MISSING_DEPENDENCY_MESSAGE, yahooFinanceLoadError);
  }
  return yahooFinance;
}

const QUOTE_CACHE_TTL_SECONDS = 60;
const quoteCache = new NodeCache({ stdTTL: QUOTE_CACHE_TTL_SECONDS, checkperiod: 120 });

let customPriceHistoryFetcher = null;

const BENCHMARK_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const benchmarkReturnCache = new Map();
const interestRateCache = new Map();
const priceHistoryCache = new Map();
const PRICE_HISTORY_CACHE_MAX_ENTRIES = 200;

function getPriceHistoryCacheKey(symbol, startDate, endDate) {
  if (!symbol || !startDate || !endDate) {
    return null;
  }
  return [symbol, startDate, endDate].join('|');
}

function getCachedPriceHistory(cacheKey) {
  if (!cacheKey) {
    return { hit: false };
  }
  if (!priceHistoryCache.has(cacheKey)) {
    return { hit: false };
  }
  return { hit: true, value: priceHistoryCache.get(cacheKey) };
}

function setCachedPriceHistory(cacheKey, value) {
  if (!cacheKey) {
    return;
  }
  if (!priceHistoryCache.has(cacheKey) && priceHistoryCache.size >= PRICE_HISTORY_CACHE_MAX_ENTRIES) {
    const firstKey = priceHistoryCache.keys().next().value;
    if (firstKey) {
      priceHistoryCache.delete(firstKey);
    }
  }
  priceHistoryCache.set(cacheKey, value);
}

const BENCHMARK_SYMBOLS = {
  sp500: { symbol: '^GSPC', name: 'S&P 500' },
  qqq: { symbol: 'QQQ', name: 'QQQ' },
};

const INTEREST_RATE_SERIES = {
  symbol: '^IRX',
  name: '13-Week Treasury Bill Yield',
};

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

function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }
  const trimmed = symbol.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toUpperCase();
}

function normalizeDateOnly(value) {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) {
      return null;
    }
    return new Date(time).toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const derived = new Date(value);
    if (Number.isNaN(derived.getTime())) {
      return null;
    }
    return derived.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'date')) {
      return normalizeDateOnly(value.date);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return normalizeDateOnly(value.value);
    }
  }
  return null;
}

function getBenchmarkCacheKey(symbol, startDate, endDate) {
  if (!symbol || !startDate || !endDate) {
    return null;
  }
  return [symbol, startDate, endDate].join('|');
}

function getCachedBenchmarkReturn(cacheKey) {
  if (!cacheKey) {
    return { hit: false };
  }
  const entry = benchmarkReturnCache.get(cacheKey);
  if (!entry) {
    return { hit: false };
  }
  if (Date.now() - entry.cachedAt > BENCHMARK_CACHE_MAX_AGE_MS) {
    benchmarkReturnCache.delete(cacheKey);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

function setCachedBenchmarkReturn(cacheKey, value) {
  if (!cacheKey) {
    return;
  }
  benchmarkReturnCache.set(cacheKey, { value, cachedAt: Date.now() });
}

function getInterestRateCacheKey(symbol, startDate, endDate) {
  if (!symbol || !startDate || !endDate) {
    return null;
  }
  return [symbol, startDate, endDate].join('|');
}

function getCachedInterestRate(cacheKey) {
  if (!cacheKey) {
    return { hit: false };
  }
  const entry = interestRateCache.get(cacheKey);
  if (!entry) {
    return { hit: false };
  }
  if (Date.now() - entry.cachedAt > BENCHMARK_CACHE_MAX_AGE_MS) {
    interestRateCache.delete(cacheKey);
    return { hit: false };
  }
  return { hit: true, value: entry.value };
}

function setCachedInterestRate(cacheKey, value) {
  if (!cacheKey) {
    return;
  }
  interestRateCache.set(cacheKey, { value, cachedAt: Date.now() });
}

async function computeBenchmarkReturn(symbol, startDate, endDate) {
  if (!symbol || !startDate || !endDate) {
    return null;
  }

  const cacheKey = getBenchmarkCacheKey(symbol, startDate, endDate);
  if (cacheKey) {
    const cached = getCachedBenchmarkReturn(cacheKey);
    if (cached.hit) {
      return cached.value;
    }
  }

  const finance = ensureYahooFinanceClient();

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const exclusiveEnd = addDays(end, 1) || end;

  const history = await finance.historical(symbol, {
    period1: start,
    period2: exclusiveEnd,
    interval: '1d',
  });

  const normalized = Array.isArray(history)
    ? history
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const entryDate =
            entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
              ? entry.date
              : typeof entry.date === 'string'
                ? new Date(entry.date)
                : null;
          if (!(entryDate instanceof Date) || Number.isNaN(entryDate.getTime())) {
            return null;
          }
          const adjClose = Number(entry.adjClose);
          const close = Number(entry.close);
          const price = Number.isFinite(adjClose)
            ? adjClose
            : Number.isFinite(close)
              ? close
              : Number.NaN;
          if (!Number.isFinite(price) || price <= 0) {
            return null;
          }
          return { date: entryDate, price };
        })
        .filter(Boolean)
        .sort((a, b) => a.date - b.date)
    : [];

  if (!normalized.length) {
    if (cacheKey) {
      setCachedBenchmarkReturn(cacheKey, null);
    }
    return null;
  }

  const first = normalized[0];
  const last = normalized[normalized.length - 1];

  if (!first || !last || !Number.isFinite(first.price) || !Number.isFinite(last.price) || first.price <= 0) {
    if (cacheKey) {
      setCachedBenchmarkReturn(cacheKey, null);
    }
    return null;
  }

  const growth = (last.price - first.price) / first.price;
  const payload = {
    symbol,
    startDate: formatDateOnly(first.date),
    endDate: formatDateOnly(last.date),
    startPrice: first.price,
    endPrice: last.price,
    returnRate: Number.isFinite(growth) ? growth : null,
    source: 'yahoo-finance2',
  };

  if (cacheKey) {
    setCachedBenchmarkReturn(cacheKey, payload);
  }

  return payload;
}

async function computeAverageInterestRate(symbol, startDate, endDate) {
  if (!symbol || !startDate || !endDate) {
    return null;
  }

  const cacheKey = getInterestRateCacheKey(symbol, startDate, endDate);
  if (cacheKey) {
    const cached = getCachedInterestRate(cacheKey);
    if (cached.hit) {
      return cached.value;
    }
  }

  const finance = ensureYahooFinanceClient();

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const exclusiveEnd = addDays(end, 1) || end;

  const history = await finance.historical(symbol, {
    period1: start,
    period2: exclusiveEnd,
    interval: '1d',
  });

  const normalized = Array.isArray(history)
    ? history
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const entryDate =
            entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
              ? entry.date
              : typeof entry.date === 'string'
                ? new Date(entry.date)
                : null;
          if (!(entryDate instanceof Date) || Number.isNaN(entryDate.getTime())) {
            return null;
          }
          const adjClose = Number(entry.adjClose);
          const close = Number(entry.close);
          const rate = Number.isFinite(adjClose)
            ? adjClose
            : Number.isFinite(close)
              ? close
              : Number.NaN;
          if (!Number.isFinite(rate)) {
            return null;
          }
          return { date: entryDate, rate };
        })
        .filter(Boolean)
        .sort((a, b) => a.date - b.date)
    : [];

  if (!normalized.length) {
    if (cacheKey) {
      setCachedInterestRate(cacheKey, null);
    }
    return null;
  }

  const sum = normalized.reduce((total, entry) => total + entry.rate, 0);
  const averagePercent = Number.isFinite(sum) ? sum / normalized.length : Number.NaN;
  const averageRate = Number.isFinite(averagePercent) ? averagePercent / 100 : null;

  const requestedStart = new Date(`${startDate}T00:00:00Z`);
  const requestedEnd = new Date(`${endDate}T00:00:00Z`);
  const fallbackStart = normalized[0]?.date || null;
  const fallbackEnd = normalized[normalized.length - 1]?.date || null;

  let periodDays = null;
  if (requestedStart instanceof Date && !Number.isNaN(requestedStart.getTime()) && requestedEnd instanceof Date && !Number.isNaN(requestedEnd.getTime())) {
    const diffMs = requestedEnd.getTime() - requestedStart.getTime();
    if (Number.isFinite(diffMs) && diffMs >= 0) {
      periodDays = diffMs / DAY_IN_MS;
    }
  }

  if (periodDays === null && fallbackStart instanceof Date && fallbackEnd instanceof Date) {
    const diffMs = fallbackEnd.getTime() - fallbackStart.getTime();
    if (Number.isFinite(diffMs) && diffMs >= 0) {
      periodDays = diffMs / DAY_IN_MS;
    }
  }

  let periodReturn = null;
  if (Number.isFinite(periodDays) && periodDays >= 0 && Number.isFinite(averageRate)) {
    const periodYears = periodDays / 365.25;
    if (periodYears > 0) {
      const growth = Math.pow(1 + averageRate, periodYears) - 1;
      if (Number.isFinite(growth)) {
        periodReturn = growth;
      }
    } else {
      periodReturn = 0;
    }
  }

  const payload = {
    symbol,
    startDate: formatDateOnly(normalized[0].date),
    endDate: formatDateOnly(normalized[normalized.length - 1].date),
    averageRate,
    periodReturn,
    periodDays: Number.isFinite(periodDays) ? periodDays : null,
    dataPoints: normalized.length,
    source: 'yahoo-finance2',
  };

  if (cacheKey) {
    setCachedInterestRate(cacheKey, payload);
  }

  return payload;
}

function normalizeInvestmentModelConfig(raw) {
  if (raw == null) {
    return null;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    return { model: trimmed.toUpperCase() };
  }

  if (typeof raw !== 'object') {
    return null;
  }

  const modelCandidate =
    raw.model ?? raw.experiment ?? raw.id ?? raw.key ?? raw.name ?? raw.title ?? null;
  const normalizedModel = typeof modelCandidate === 'string' ? modelCandidate.trim() : null;
  if (!normalizedModel) {
    return null;
  }

  const result = { model: normalizedModel.toUpperCase() };

  const baseSymbol = raw.symbol ?? raw.baseSymbol ?? raw.base_symbol;
  const normalizedBase = normalizeSymbol(baseSymbol);
  if (normalizedBase) {
    result.symbol = normalizedBase;
  }

  const leveragedSymbol = raw.leveragedSymbol ?? raw.leveraged_symbol ?? raw.leveraged ?? raw.leveragedsymbol;
  const normalizedLeveraged = normalizeSymbol(leveragedSymbol);
  if (normalizedLeveraged) {
    result.leveragedSymbol = normalizedLeveraged;
  }

  const reserveSymbol = raw.reserveSymbol ?? raw.reserve_symbol ?? raw.reserve;
  const normalizedReserve = normalizeSymbol(reserveSymbol);
  if (normalizedReserve) {
    result.reserveSymbol = normalizedReserve;
  }

  const normalizedLast = normalizeDateOnly(
    raw.lastRebalance ?? raw.last_rebalance ?? raw.last_rebalance_date
  );
  if (normalizedLast) {
    result.lastRebalance = normalizedLast;
  }

  const normalizedPeriod = normalizePositiveInteger(
    raw.rebalancePeriod ??
      raw.rebalance_period ??
      raw.rebalancePeriodDays ??
      raw.rebalance_period_days
  );
  if (normalizedPeriod !== null) {
    result.rebalancePeriod = normalizedPeriod;
  }

  if (typeof raw.title === 'string' && raw.title.trim()) {
    result.title = raw.title.trim();
  } else if (typeof raw.label === 'string' && raw.label.trim()) {
    result.title = raw.label.trim();
  }

  return result;
}

function normalizeInvestmentModelList(raw) {
  if (raw == null) {
    return [];
  }

  const list = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const results = [];

  list.forEach((entry) => {
    const normalized = normalizeInvestmentModelConfig(entry);
    if (!normalized || !normalized.model) {
      return;
    }
    const key = normalized.model.toUpperCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(normalized);
  });

  return results;
}

function resolveAccountInvestmentModels(account) {
  if (!account) {
    return [];
  }

  const normalized = normalizeInvestmentModelList(account.investmentModels);
  if (normalized.length) {
    return normalized;
  }

  if (account.investmentModel) {
    return normalizeInvestmentModelList({
      model: account.investmentModel,
      lastRebalance: account.investmentModelLastRebalance,
      rebalancePeriod: account.rebalancePeriod,
    });
  }

  return [];
}

function coerceQuoteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  if (value instanceof Date) {
    const numeric = value.getTime();
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}

function resolveQuoteTimestamp(quote) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }
  const fields = ['regularMarketTime', 'postMarketTime', 'preMarketTime'];
  for (const field of fields) {
    const raw = quote[field];
    if (!raw) {
      continue;
    }
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      return raw.toISOString();
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      const timestamp = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      const date = new Date(timestamp);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }
  return null;
}

function extractQuotePrice(quote) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }
  const candidates = [
    quote.regularMarketPrice,
    quote.postMarketPrice,
    quote.preMarketPrice,
    quote.bid,
    quote.ask,
    quote.regularMarketDayHigh,
    quote.regularMarketDayLow,
    quote.previousClose,
  ];
  for (const candidate of candidates) {
    const price = coerceQuoteNumber(candidate);
    if (Number.isFinite(price) && price > 0) {
      return price;
    }
  }
  return null;
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

const EARLIEST_FUNDING_CACHE_PATH = path.join(__dirname, '..', 'earliest-funding-cache.json');
const EARLIEST_FUNDING_CACHE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const earliestFundingPromises = new Map();

function loadEarliestFundingCache() {
  try {
    if (!fs.existsSync(EARLIEST_FUNDING_CACHE_PATH)) {
      return { entries: {} };
    }
    const contents = fs.readFileSync(EARLIEST_FUNDING_CACHE_PATH, 'utf-8');
    if (!contents.trim()) {
      return { entries: {} };
    }
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { entries: parsed.entries };
    }
  } catch (error) {
    console.warn('Failed to read earliest funding cache:', error.message);
  }
  return { entries: {} };
}

function persistEarliestFundingCache(state) {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      entries: state.entries,
    };
    fs.writeFileSync(EARLIEST_FUNDING_CACHE_PATH, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn('Failed to persist earliest funding cache:', error.message);
  }
}

const earliestFundingCacheState = loadEarliestFundingCache();

function buildEarliestFundingCacheKey(login, accountId, accountKey) {
  const loginId = login && login.id ? String(login.id) : 'unknown-login';
  const normalizedAccountKey = accountKey ? String(accountKey) : null;
  const normalizedAccountId = accountId ? String(accountId) : null;
  return [loginId, normalizedAccountKey || normalizedAccountId || 'unknown-account'].join('::');
}

function getCachedEarliestFunding(cacheKey) {
  const entry = earliestFundingCacheState.entries[cacheKey];
  if (!entry) {
    return { hit: false };
  }
  const cachedAtMs = Date.parse(entry.cachedAt || entry.cached_at || '');
  if (Number.isNaN(cachedAtMs) || Date.now() - cachedAtMs > EARLIEST_FUNDING_CACHE_MAX_AGE_MS) {
    delete earliestFundingCacheState.entries[cacheKey];
    persistEarliestFundingCache(earliestFundingCacheState);
    return { hit: false };
  }
  if (entry.earliestFunding === null) {
    return { hit: true, value: null };
  }
  if (typeof entry.earliestFunding === 'string') {
    const parsed = new Date(entry.earliestFunding);
    if (!Number.isNaN(parsed.getTime())) {
      return { hit: true, value: parsed };
    }
  }
  return { hit: false };
}

function setCachedEarliestFunding(cacheKey, value) {
  earliestFundingCacheState.entries[cacheKey] = {
    earliestFunding: value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null,
    cachedAt: new Date().toISOString(),
  };
  persistEarliestFundingCache(earliestFundingCacheState);
}


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

const DEBUG_TOTAL_PNL = process.env.DEBUG_TOTAL_PNL === 'true';
const DEBUG_XIRR = process.env.DEBUG_XIRR === 'true';
// Questrade's documentation cites a 31 day cap for the activities endpoint, but in
// practice we receive "Argument length exceeds imposed limit" errors whenever the
// requested range spans a full 31 calendar days. Keeping the window strictly under
// that threshold avoids the 400 errors without materially increasing the number of
// requests we make.
const MAX_ACTIVITIES_WINDOW_DAYS = 30;
const MIN_ACTIVITY_DATE = new Date('2000-01-01T00:00:00Z');
const USD_TO_CAD_SERIES = 'DEXCAUS';
const ACTIVITIES_CACHE_DIR = path.join(__dirname, '..', '.cache', 'activities');

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

function debugXirr(accountId, message, payload) {
  if (!DEBUG_XIRR) {
    return;
  }
  const parts = ['[XIRR]', accountId ? '(' + accountId + ')' : '', message];
  const filtered = parts.filter(Boolean);
  if (payload !== undefined) {
    console.log(filtered.join(' '), payload);
  } else {
    console.log(filtered.join(' '));
  }
}

if (DEBUG_XIRR) {
  console.log('[XIRR] Debug logging enabled (set DEBUG_XIRR=false to disable).');
}

function computeAccountAnnualizedReturn(cashFlows, accountKey) {
  if (DEBUG_XIRR) {
    debugXirr(accountKey, 'Raw cash flow entries', Array.isArray(cashFlows) ? cashFlows : []);
  }

  const normalizedForXirr = normalizeCashFlowsForXirr(cashFlows);

  if (DEBUG_XIRR) {
    const normalizedLog = normalizedForXirr.map((entry, index) => ({
      index,
      amount: entry.amount,
      date: entry.date instanceof Date && !Number.isNaN(entry.date.getTime()) ? entry.date.toISOString() : null,
    }));
    const summary = normalizedForXirr.reduce(
      (accumulator, entry) => {
        if (entry.amount > 0) {
          accumulator.inflows += entry.amount;
        } else {
          accumulator.outflows += entry.amount;
        }
        if (!accumulator.earliest || entry.date < accumulator.earliest) {
          accumulator.earliest = entry.date;
        }
        if (!accumulator.latest || entry.date > accumulator.latest) {
          accumulator.latest = entry.date;
        }
        return accumulator;
      },
      { inflows: 0, outflows: 0, earliest: null, latest: null }
    );
    if (summary.earliest instanceof Date && !Number.isNaN(summary.earliest.getTime())) {
      summary.earliest = summary.earliest.toISOString();
    }
    if (summary.latest instanceof Date && !Number.isNaN(summary.latest.getTime())) {
      summary.latest = summary.latest.toISOString();
    }
    summary.count = normalizedForXirr.length;
    debugXirr(accountKey, 'Normalized cash flow schedule', normalizedLog);
    debugXirr(accountKey, 'Cash flow summary', summary);
  }

  const shouldHandleFailure = DEBUG_TOTAL_PNL || DEBUG_XIRR;
  const onFailure = shouldHandleFailure
    ? (details) => {
        const payload = {
          cashFlowCount: details && Array.isArray(details.normalized) ? details.normalized.length : undefined,
          hasPositive: details && Object.prototype.hasOwnProperty.call(details, 'hasPositive')
            ? details.hasPositive
            : undefined,
          hasNegative: details && Object.prototype.hasOwnProperty.call(details, 'hasNegative')
            ? details.hasNegative
            : undefined,
          reason: details ? details.reason : undefined,
        };
        if (DEBUG_TOTAL_PNL) {
          debugTotalPnl(accountKey, 'Unable to compute XIRR for cash flows', payload);
        }
        if (DEBUG_XIRR) {
          debugXirr(
            accountKey,
            'XIRR computation failed',
            Object.assign({}, payload, {
              normalizedCashFlows:
                details && Array.isArray(details.normalized)
                  ? details.normalized.map((entry, index) => ({
                      index,
                      amount: entry.amount,
                      date:
                        entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
                          ? entry.date.toISOString()
                          : null,
                    }))
                  : undefined,
            })
          );
        }
      }
    : undefined;

  const result = computeAnnualizedReturnFromCashFlows(normalizedForXirr, {
    onFailure,
    preNormalized: true,
  });

  if (DEBUG_XIRR) {
    if (Number.isFinite(result)) {
      debugXirr(accountKey, 'XIRR computation succeeded', {
        rate: result,
        percentage: result * 100,
        cashFlowCount: normalizedForXirr.length,
      });
    } else {
      debugXirr(accountKey, 'XIRR computation returned null', {
        cashFlowCount: normalizedForXirr.length,
      });
    }
  }

  return result;
}

function parseDateOnlyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function parseCashFlowEntryDate(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const candidateDate = entry.date || entry.timestamp;
  if (candidateDate instanceof Date) {
    return Number.isNaN(candidateDate.getTime()) ? null : candidateDate;
  }
  if (typeof candidateDate === 'string') {
    const trimmed = candidateDate.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }
  return null;
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

function computeReturnBreakdownFromCashFlows(cashFlows, asOfDate, annualizedRate) {
  const normalized = normalizeCashFlowsForXirr(cashFlows);
  if (!normalized.length) {
    return [];
  }

  const lastEntry = normalized[normalized.length - 1];
  const resolvedAsOf =
    asOfDate instanceof Date && !Number.isNaN(asOfDate.getTime())
      ? asOfDate
      : lastEntry?.date instanceof Date && !Number.isNaN(lastEntry.date.getTime())
        ? lastEntry.date
        : null;

  if (!(resolvedAsOf instanceof Date) || Number.isNaN(resolvedAsOf.getTime())) {
    return [];
  }

  const earliestEntry = normalized[0];
  if (!(earliestEntry?.date instanceof Date) || Number.isNaN(earliestEntry.date.getTime())) {
    return [];
  }

  const breakdown = [];
  const safeRate = Number.isFinite(annualizedRate) && annualizedRate > -0.999 ? annualizedRate : 0;
  const compoundingBase = 1 + safeRate;

  for (const period of RETURN_BREAKDOWN_PERIODS) {
    const startDate = addMonths(resolvedAsOf, -period.months);
    if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
      continue;
    }

    if (!(earliestEntry.date < startDate)) {
      continue;
    }

    const flowsBefore = normalized.filter((entry) => entry.date < startDate);
    if (!flowsBefore.length) {
      continue;
    }

    const flowsAfter = normalized.filter((entry) => entry.date >= startDate);
    if (!flowsAfter.length) {
      continue;
    }

    let startValue = 0;
    let validStartValue = true;
    for (const entry of flowsBefore) {
      const millisDelta = startDate.getTime() - entry.date.getTime();
      const yearSpan = millisDelta / DAY_IN_MS / 365;
      if (!Number.isFinite(yearSpan) || yearSpan < 0) {
        validStartValue = false;
        break;
      }
      const growthFactor = compoundingBase > 0 ? Math.pow(compoundingBase, yearSpan) : Number.NaN;
      if (!Number.isFinite(growthFactor)) {
        validStartValue = false;
        break;
      }
      const futureValue = entry.amount * growthFactor;
      if (!Number.isFinite(futureValue)) {
        validStartValue = false;
        break;
      }
      startValue -= futureValue;
    }

    if (!validStartValue || !Number.isFinite(startValue) || Math.abs(startValue) < CASH_FLOW_EPSILON || startValue <= 0) {
      const fallbackStart = flowsBefore.reduce((sum, entry) => sum - entry.amount, 0);
      if (Number.isFinite(fallbackStart) && fallbackStart > CASH_FLOW_EPSILON) {
        startValue = fallbackStart;
        validStartValue = true;
      } else {
        continue;
      }
    }

    const flowsAfterSum = flowsAfter.reduce((sum, entry) => sum + entry.amount, 0);
    const totalReturn = flowsAfterSum - startValue;

    let periodReturnRate = null;
    if (Number.isFinite(totalReturn)) {
      const rawRate = totalReturn / startValue;
      if (Number.isFinite(rawRate)) {
        periodReturnRate = rawRate;
      }
    }

    let annualizedPeriodRate = null;
    if (Number.isFinite(periodReturnRate) && periodReturnRate >= -1 && period.months > 0) {
      const years = period.months / 12;
      const exponent = years > 0 ? 1 / years : null;
      if (Number.isFinite(exponent) && exponent > 0) {
        const growthBase = 1 + periodReturnRate;
        const growth = Math.pow(growthBase, exponent) - 1;
        if (Number.isFinite(growth)) {
          annualizedPeriodRate = growth;
        }
      }
    }

    breakdown.push({
      period: period.key,
      months: period.months,
      startDate: startDate.toISOString(),
      startValueCad: Number.isFinite(startValue) ? startValue : null,
      totalReturnCad: Number.isFinite(totalReturn) ? totalReturn : null,
      periodReturnRate: Number.isFinite(periodReturnRate) ? periodReturnRate : null,
      annualizedRate: Number.isFinite(annualizedPeriodRate) ? annualizedPeriodRate : null,
    });
  }

  return breakdown;
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

const DIVIDEND_ACTIVITY_REGEX = /(dividend|distribution)/i;

const DIVIDEND_SYMBOL_CANONICAL_ALIASES = new Map([
  ['N003056', 'NVDA'],
  ['NVDA', 'NVDA'],
  ['A033916', 'ASML'],
  ['ASML', 'ASML'],
  ['.ENB', 'ENB'],
  ['ENB', 'ENB'],
  ['ENB.TO', 'ENB'],
  ['A040553', 'GOOG'],
  ['GOOG', 'GOOG'],
  ['GOOGL', 'GOOG'],
  ['C074212', 'CI'],
  ['CI', 'CI'],
  ['CI.TO', 'CI'],
  ['D052167', 'GGLL'],
  ['GGLL', 'GGLL'],
  ['H079292', 'SGOV'],
  ['SGOV', 'SGOV'],
  ['H082968', 'QQQ'],
  ['QQQ', 'QQQ'],
  ['QQM', 'QQQ'],
  ['L415517', 'LLY'],
  ['LLY', 'LLY'],
  ['M415385', 'MSFT'],
  ['MSFT', 'MSFT'],
  ['PSA', 'PSA'],
  ['PSA.TO', 'PSA'],
  ['S022496', 'SPDR'],
  ['SPDR', 'SPDR'],
  ['T002234', 'TSM'],
  ['TSM', 'TSM'],
]);

const DIVIDEND_DESCRIPTION_HINTS = new Map(
  [
    ['NVDA', ['NVDA', 'NVIDIA']],
    ['ASML', ['ASML']],
    ['ENB', ['ENB', 'ENBRIDGE']],
    ['GOOG', ['GOOG', 'GOOGL', 'ALPHABET']],
    ['CI', ['CI', 'CI FINANCIAL']],
    ['GGLL', ['GGLL']],
    ['SGOV', ['SGOV']],
    ['QQQ', ['QQQ', 'QQM']],
    ['LLY', ['LLY', 'ELI LILLY']],
    ['MSFT', ['MSFT', 'MICROSOFT']],
    ['PSA', ['PSA', 'PUBLIC STORAGE']],
    ['SPDR', ['SPDR']],
    ['TSM', ['TSM', 'TAIWAN SEMI']],
  ].map(function ([canonical, hints]) {
    const normalizedHints = Array.isArray(hints)
      ? hints
          .map(function (hint) {
            return typeof hint === 'string' ? hint.trim().toUpperCase() : null;
          })
          .filter(Boolean)
      : [];
    return [canonical, normalizedHints];
  })
);

function normalizeDividendSymbolCandidate(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toUpperCase() : '';
}

function normalizeDividendActivitySymbol(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }

  const rawSymbolOriginal = typeof activity.symbol === 'string' ? activity.symbol.trim() : '';
  const rawSymbol = normalizeDividendSymbolCandidate(rawSymbolOriginal);
  const canonicalFromRaw = rawSymbol ? DIVIDEND_SYMBOL_CANONICAL_ALIASES.get(rawSymbol) : null;

  if (canonicalFromRaw) {
    return {
      canonical: canonicalFromRaw,
      raw: rawSymbol,
      display: canonicalFromRaw,
    };
  }

  if (rawSymbol) {
    return {
      canonical: rawSymbol,
      raw: rawSymbol,
      display: rawSymbol,
    };
  }

  const description = typeof activity.description === 'string' ? activity.description.trim() : '';
  if (description) {
    const upperDescription = description.toUpperCase();
    for (const [canonical, hints] of DIVIDEND_DESCRIPTION_HINTS.entries()) {
      if (hints.some((hint) => upperDescription.includes(hint))) {
        return {
          canonical,
          raw: rawSymbol || null,
          display: canonical,
        };
      }
    }
  }

  return null;
}

function isDividendActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }

  const fields = ['type', 'subType', 'action', 'description'];
  for (const field of fields) {
    const value = activity[field];
    if (typeof value === 'string' && DIVIDEND_ACTIVITY_REGEX.test(value)) {
      return true;
    }
  }
  return false;
}

const EMBEDDED_NUMBER_PATTERN = '\\d+(?:,\\d{3})*(?:\\.\\d+)?';
const EMBEDDED_DECIMAL_PATTERN = '\\d+(?:,\\d{3})*\\.\\d+';

function parseNumericString(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const normalized = value.replace(/,/g, '');
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function extractAmountFromDescription(description) {
  if (typeof description !== 'string' || !description) {
    return null;
  }

  const bookValueMatch = description.match(new RegExp('BOOK\\s+VALUE\\s+(' + EMBEDDED_NUMBER_PATTERN + ')', 'i'));
  if (bookValueMatch && bookValueMatch[1]) {
    const bookValue = parseNumericString(bookValueMatch[1]);
    if (bookValue !== null) {
      return { amount: bookValue, raw: bookValueMatch[1], source: 'bookValue' };
    }
  }

  const decimalMatches = description.match(new RegExp(EMBEDDED_DECIMAL_PATTERN, 'g'));
  if (decimalMatches && decimalMatches.length > 0) {
    const rawDecimal = decimalMatches[decimalMatches.length - 1];
    const decimalValue = parseNumericString(rawDecimal);
    if (decimalValue !== null) {
      return { amount: decimalValue, raw: rawDecimal, source: 'decimal' };
    }
  }

  const genericMatches = description.match(new RegExp(EMBEDDED_NUMBER_PATTERN, 'g'));
  if (!genericMatches || !genericMatches.length) {
    return null;
  }
  const filtered = genericMatches.filter((value) => value && value.indexOf('.') !== -1);
  const candidate = (filtered.length ? filtered[filtered.length - 1] : genericMatches[genericMatches.length - 1]) || null;
  if (!candidate) {
    return null;
  }
  const numeric = parseNumericString(candidate);
  if (numeric === null) {
    return null;
  }
  return { amount: numeric, raw: candidate, source: filtered.length ? 'filteredNumeric' : 'numeric' };
}

function resolveActivityAmount(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const candidates = ['netAmount', 'grossAmount'];
  for (const field of candidates) {
    const value = Number(activity[field]);
    if (Number.isFinite(value) && Math.abs(value) > 1e-8) {
      return { amount: value, source: 'field', field };
    }
  }
  const quantity = Number(activity.quantity);
  const price = Number(activity.price);
  if (
    Number.isFinite(quantity) &&
    Math.abs(quantity) > 1e-8 &&
    Number.isFinite(price) &&
    Math.abs(price) > 1e-8
  ) {
    return { amount: quantity * price, source: 'quantityPrice', quantity, price };
  }
  const embedded = extractAmountFromDescription(activity.description);
  if (embedded !== null) {
    return {
      amount: embedded.amount,
      source: 'description',
      description: embedded,
    };
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

async function fetchLatestUsdToCadRate() {
  const providers = [
    async function awesomeApiProvider() {
      const response = await axios.get(
        'https://economia.awesomeapi.com.br/json/last/USD-CAD',
        { timeout: 5000 }
      );
      const payload = response && response.data && response.data.USDCAD;
      if (!payload || typeof payload !== 'object') {
        return null;
      }
      const bid = Number.parseFloat(payload.bid);
      const ask = Number.parseFloat(payload.ask);
      if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
        return (bid + ask) / 2;
      }
      if (Number.isFinite(bid) && bid > 0) {
        return bid;
      }
      if (Number.isFinite(ask) && ask > 0) {
        return ask;
      }
      const price = Number.parseFloat(payload.price);
      if (Number.isFinite(price) && price > 0) {
        return price;
      }
      return null;
    },
    async function openErApiProvider() {
      const response = await axios.get('https://open.er-api.com/v6/latest/USD', {
        timeout: 5000,
      });
      const value =
        response &&
        response.data &&
        response.data.rates &&
        Number.parseFloat(response.data.rates.CAD);
      return Number.isFinite(value) && value > 0 ? value : null;
    },
  ];

  for (const provider of providers) {
    try {
      const rate = await provider();
      if (Number.isFinite(rate) && rate > 0) {
        return rate;
      }
    } catch (error) {
      const message =
        error &&
        (error.message ||
          (typeof error.toString === 'function' ? error.toString() : String(error)));
      console.warn('[FX] Failed USD/CAD rate provider:', message);
    }
  }
  return null;
}

async function fetchUsdToCadRate(date) {
  const keyDate = formatDateOnly(date);
  if (!keyDate) {
    return null;
  }

  const todayKey = formatDateOnly(new Date());
  if (keyDate === todayKey) {
    const latestCacheKey = keyDate + ':latest';
    if (usdCadRateCache.has(latestCacheKey)) {
      const cachedLatest = usdCadRateCache.get(latestCacheKey);
      if (Number.isFinite(cachedLatest) && cachedLatest > 0) {
        return cachedLatest;
      }
    }
    const latestRate = await fetchLatestUsdToCadRate();
    if (Number.isFinite(latestRate) && latestRate > 0) {
      usdCadRateCache.set(latestCacheKey, latestRate);
      return latestRate;
    }
    usdCadRateCache.set(latestCacheKey, null);
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

async function fetchUsdToCadRateRange(startDateKey, endDateKey) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error('Missing FRED_API_KEY environment variable');
  }

  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', USD_TO_CAD_SERIES);
  url.searchParams.set('observation_start', startDateKey);
  url.searchParams.set('observation_end', endDateKey);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');

  try {
    const response = await axios.get(url.toString());
    const observations = response.data && response.data.observations;
    if (Array.isArray(observations)) {
      observations.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const dateKey = typeof entry.date === 'string' ? entry.date.trim() : null;
        if (!dateKey) {
          return;
        }
        const value = Number(entry.value);
        if (Number.isFinite(value) && value > 0) {
          usdCadRateCache.set(dateKey, value);
        } else if (!usdCadRateCache.has(dateKey)) {
          usdCadRateCache.set(dateKey, null);
        }
      });
    }
  } catch (error) {
    console.warn('[FX] Failed to prefetch USD/CAD range:', error?.message || String(error));
  }
}

async function ensureUsdToCadRates(dateKeys) {
  if (!Array.isArray(dateKeys) || dateKeys.length === 0) {
    return;
  }
  const uniqueKeys = Array.from(new Set(dateKeys)).filter(Boolean).sort();
  const firstKey = uniqueKeys[0];
  const lastKey = uniqueKeys[uniqueKeys.length - 1];
  if (!usdCadRateCache.has(firstKey) || !usdCadRateCache.has(lastKey)) {
    await fetchUsdToCadRateRange(firstKey, lastKey);
  }
  let lastKnown = null;
  uniqueKeys.forEach((key) => {
    if (!key) {
      return;
    }
    const cached = usdCadRateCache.get(key);
    if (Number.isFinite(cached) && cached > 0) {
      lastKnown = cached;
      return;
    }
    if (lastKnown !== null) {
      usdCadRateCache.set(key, lastKnown);
    }
  });
}

function normalizePositiveInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    const rounded = Math.round(value);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number.parseFloat(trimmed);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    const rounded = Math.round(numeric);
    return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return normalizePositiveInteger(value.value);
    }
  }
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

function computeActivityFingerprint(activities) {
  if (!Array.isArray(activities) || activities.length === 0) {
    return 'count:0|latest:none';
  }
  let latest = null;
  activities.forEach((activity) => {
    const timestamp = resolveActivityTimestamp(activity);
    if (timestamp && (!latest || timestamp > latest)) {
      latest = timestamp;
    }
  });
  const latestIso = latest instanceof Date && !Number.isNaN(latest.getTime()) ? latest.toISOString() : 'none';
  return 'count:' + activities.length + '|latest:' + latestIso;
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
  const cacheKey = buildEarliestFundingCacheKey(login, accountId, accountKey);
  if (cacheKey) {
    const cached = getCachedEarliestFunding(cacheKey);
    if (cached.hit) {
      return cached.value || null;
    }
    if (earliestFundingPromises.has(cacheKey)) {
      return earliestFundingPromises.get(cacheKey);
    }
  }

  async function computeEarliestFundingDate() {
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
      let monthEnd = new Date(Math.min(nextMonthStart.getTime() - 1000, now.getTime()));
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
        debugTotalPnl(
          accountKey,
          'Funding month hit',
          Object.assign({ activities: funding.length }, monthLabel)
        );
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

  if (!cacheKey) {
    return computeEarliestFundingDate();
  }

  const pendingPromise = computeEarliestFundingDate()
    .then((value) => {
      setCachedEarliestFunding(cacheKey, value);
      return value || null;
    })
    .finally(() => {
      earliestFundingPromises.delete(cacheKey);
    });
  earliestFundingPromises.set(cacheKey, pendingPromise);
  return pendingPromise;
}

const NET_DEPOSITS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_NET_DEPOSITS_CACHE_SIZE = 200;
const netDepositsCache = new Map();
const netDepositsPromiseCache = new Map();

function cloneNetDepositsSummary(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (error) {
      // Fall back to JSON serialization
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function computeBalanceFingerprint(balanceSummary) {
  if (!balanceSummary || typeof balanceSummary !== 'object') {
    return 'balance:none';
  }
  const combined = balanceSummary.combined && typeof balanceSummary.combined === 'object'
    ? balanceSummary.combined
    : balanceSummary;
  const cadEntry = combined.CAD || combined.cad || null;
  if (!cadEntry || typeof cadEntry !== 'object') {
    return 'balance:no-cad';
  }
  const fields = ['totalEquity', 'marketValue', 'cash'];
  const parts = fields.map((field) => {
    const numeric = Number(cadEntry[field]);
    return Number.isFinite(numeric) ? numeric.toFixed(2) : 'na';
  });
  const asOf = typeof cadEntry.asOf === 'string' ? cadEntry.asOf : 'na';
  return ['balance', asOf, ...parts].join('|');
}

function buildNetDepositsCacheKey(login, account, perAccountCombinedBalances, options, activityContext) {
  if (!account || !activityContext) {
    return null;
  }
  const loginId = login && login.id ? String(login.id) : account.loginId || 'unknown-login';
  const accountId = account.id ? String(account.id) : account.number ? String(account.number) : 'unknown-account';
  const tradingDay =
    typeof activityContext.nowIsoString === 'string'
      ? activityContext.nowIsoString.slice(0, 10)
      : formatDateOnly(activityContext.now || new Date());
  if (!tradingDay) {
    return null;
  }
  const fingerprint =
    activityContext && typeof activityContext.fingerprint === 'string'
      ? activityContext.fingerprint
      : computeActivityFingerprint(activityContext.activities || []);
  const balanceSummary = perAccountCombinedBalances ? perAccountCombinedBalances[account.id] : null;
  const balanceFingerprint = computeBalanceFingerprint(balanceSummary);
  const cagrKey = options && options.applyAccountCagrStartDate ? 'cagr:1' : 'cagr:0';
  const cagrDateKey =
    options && options.applyAccountCagrStartDate && typeof account.cagrStartDate === 'string'
      ? 'cagrDate:' + account.cagrStartDate.trim()
      : 'cagrDate:none';
  const adjustment = Number(account.netDepositAdjustment);
  const adjustmentKey = Number.isFinite(adjustment) ? 'adj:' + adjustment.toFixed(2) : 'adj:none';
  return [
    loginId,
    accountId,
    tradingDay,
    fingerprint,
    balanceFingerprint,
    cagrKey,
    cagrDateKey,
    adjustmentKey,
  ].join('|');
}

function pruneNetDepositsCache() {
  if (netDepositsCache.size <= MAX_NET_DEPOSITS_CACHE_SIZE) {
    return;
  }
  const entries = Array.from(netDepositsCache.entries()).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  while (entries.length > MAX_NET_DEPOSITS_CACHE_SIZE) {
    const entry = entries.shift();
    if (entry) {
      netDepositsCache.delete(entry[0]);
    }
  }
}

function getNetDepositsCacheEntry(cacheKey) {
  const entry = netDepositsCache.get(cacheKey);
  if (!entry) {
    return { hit: false };
  }
  if (Date.now() - entry.cachedAt > NET_DEPOSITS_CACHE_MAX_AGE_MS) {
    netDepositsCache.delete(cacheKey);
    return { hit: false };
  }
  return { hit: true, value: cloneNetDepositsSummary(entry.value) };
}

function setNetDepositsCacheEntry(cacheKey, value) {
  netDepositsCache.set(cacheKey, { value, cachedAt: Date.now() });
  pruneNetDepositsCache();
}

async function buildAccountActivityContext(login, account, options = {}) {
  if (!login || !account) {
    return null;
  }

  const accountKey = account.id;
  const accountNumber = account.number || account.accountNumber || account.id;
  if (!accountKey || !accountNumber) {
    return null;
  }

  const { fallbackMonths = 12 } = options;
  const earliestFunding = await discoverEarliestFundingDate(login, accountNumber, accountKey);
  const now = new Date();
  const nowIsoString = now.toISOString();

  const paddedStart = earliestFunding
    ? addDays(floorToMonthStart(earliestFunding), -7)
    : addMonths(now, -Math.max(1, fallbackMonths));
  const crawlStart = clampDate(paddedStart || now, MIN_ACTIVITY_DATE) || MIN_ACTIVITY_DATE;

  const activitiesRaw = await fetchActivitiesRange(login, accountNumber, crawlStart, now, accountKey);
  const activities = dedupeActivities(activitiesRaw);

  return {
    accountId: accountKey,
    accountNumber,
    accountKey,
    earliestFunding,
    crawlStart,
    activities,
    now,
    nowIsoString,
    fingerprint: computeActivityFingerprint(activities),
  };
}

async function resolveAccountActivityContext(login, account, providedContext) {
  if (
    providedContext &&
    typeof providedContext === 'object' &&
    providedContext.accountId &&
    account &&
    providedContext.accountId === account.id
  ) {
    const normalized = Object.assign({}, providedContext);
    if (!Array.isArray(normalized.activities)) {
      normalized.activities = [];
    }
    if (typeof normalized.fingerprint !== 'string') {
      normalized.fingerprint = computeActivityFingerprint(normalized.activities);
    }
    return normalized;
  }

  return buildAccountActivityContext(login, account);
}

function resolveActivityAmountDetails(activity) {
  const amountInfo = resolveActivityAmount(activity);
  if (!amountInfo) {
    return null;
  }
  const direction = inferActivityDirection(activity, amountInfo.amount);
  if (!direction) {
    return null;
  }
  const signedAmount = direction >= 0 ? Math.abs(amountInfo.amount) : -Math.abs(amountInfo.amount);
  const currency = normalizeCurrency(activity.currency) || 'CAD';
  const timestamp = resolveActivityTimestamp(activity);
  const descriptionResolution = amountInfo.description
    ? {
        amount: amountInfo.description.amount,
        raw: amountInfo.description.raw || null,
        source: amountInfo.description.source || null,
        signedAmount:
          direction >= 0
            ? Math.abs(amountInfo.description.amount)
            : -Math.abs(amountInfo.description.amount),
      }
    : null;

  return {
    amount: signedAmount,
    currency,
    timestamp,
    resolution: {
      source: amountInfo.source || null,
      field: amountInfo.field || null,
      quantity: amountInfo.quantity || null,
      price: amountInfo.price || null,
      description: descriptionResolution,
    },
  };
}

async function convertAmountToCad(amount, currency, timestamp, accountKey) {
  if (!Number.isFinite(amount)) {
    return { cadAmount: null, fxRate: null };
  }
  if (!currency || currency === 'CAD') {
    return { cadAmount: amount, fxRate: 1 };
  }
  if (currency === 'USD') {
    if (!timestamp) {
      return { cadAmount: null, fxRate: null };
    }
    const rate = await resolveUsdToCadRate(timestamp, accountKey);
    if (!Number.isFinite(rate) || rate <= 0) {
      debugTotalPnl(accountKey, 'Missing FX rate for ' + formatDateOnly(timestamp));
      return { cadAmount: null, fxRate: null };
    }
    return { cadAmount: amount * rate, fxRate: rate };
  }
  debugTotalPnl(accountKey, 'Unsupported currency for net deposits: ' + currency);
  return { cadAmount: null, fxRate: null };
}

async function computeNetDepositsCore(account, perAccountCombinedBalances, options = {}, activityContext) {
  if (!account || !account.id || !activityContext) {
    return null;
  }
  const accountKey = account.id;

  const earliestFunding = activityContext.earliestFunding || null;
  const now =
    activityContext.now instanceof Date && !Number.isNaN(activityContext.now.getTime())
      ? activityContext.now
      : new Date();
  const nowIsoString =
    typeof activityContext.nowIsoString === 'string'
      ? activityContext.nowIsoString
      : now.toISOString();
  const crawlStart =
    activityContext.crawlStart instanceof Date && !Number.isNaN(activityContext.crawlStart.getTime())
      ? activityContext.crawlStart
      : clampDate(addDays(now, -365) || now, MIN_ACTIVITY_DATE) || MIN_ACTIVITY_DATE;
  const activities = Array.isArray(activityContext.activities) ? activityContext.activities : [];
  const fundingActivities = dedupeActivities(filterFundingActivities(activities));
  debugTotalPnl(accountKey, 'Funding activities considered', fundingActivities.length);

  const perCurrencyTotals = new Map();
  let combinedCad = 0;
  let conversionIncomplete = false;
  const breakdown = [];
  const cashFlowEntries = [];
  let missingCashFlowDates = false;

  for (const activity of fundingActivities) {
    const details = resolveActivityAmountDetails(activity);
    if (!details) {
      debugTotalPnl(accountKey, 'Skipped activity due to missing amount', activity);
      continue;
    }
    const { amount, currency, timestamp, resolution } = details;
    const conversion = await convertAmountToCad(amount, currency, timestamp, accountKey);
    const cadAmount = conversion.cadAmount;
    if (!perCurrencyTotals.has(currency)) {
      perCurrencyTotals.set(currency, 0);
    }
    perCurrencyTotals.set(currency, perCurrencyTotals.get(currency) + amount);
    if (Number.isFinite(cadAmount)) {
      combinedCad += cadAmount;
      if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
        if (Math.abs(cadAmount) >= CASH_FLOW_EPSILON) {
          cashFlowEntries.push({ amount: -cadAmount, date: timestamp.toISOString() });
        }
      } else if (Math.abs(cadAmount) >= CASH_FLOW_EPSILON) {
        missingCashFlowDates = true;
      }
    } else if (currency !== 'CAD') {
      conversionIncomplete = true;
    }
    breakdown.push({
      amount,
      currency,
      cadAmount,
      usdAmount: currency === 'USD' ? amount : null,
      fxRate: conversion.fxRate || null,
      resolvedAmountSource: resolution && resolution.source ? resolution.source : null,
      resolvedAmountField: resolution && resolution.field ? resolution.field : null,
      resolvedQuantity: resolution && Number.isFinite(resolution.quantity) ? resolution.quantity : null,
      resolvedPrice: resolution && Number.isFinite(resolution.price) ? resolution.price : null,
      descriptionExtracted: !!(resolution && resolution.description),
      descriptionExtractedAmount:
        resolution && resolution.description ? resolution.description.amount : null,
      descriptionExtractedAmountSigned:
        resolution && resolution.description ? resolution.description.signedAmount : null,
      descriptionExtractedRaw:
        resolution && resolution.description ? resolution.description.raw || null : null,
      descriptionExtractionStrategy:
        resolution && resolution.description ? resolution.description.source || null : null,
      timestamp: timestamp ? formatDateOnly(timestamp) : null,
      type: activity.type || null,
      action: activity.action || null,
      description: activity.description || null,
    });
  }

  const accountAdjustment =
    account && typeof account.netDepositAdjustment === 'number' && Number.isFinite(account.netDepositAdjustment)
      ? account.netDepositAdjustment
      : 0;

  if (accountAdjustment !== 0) {
    const existingCad = perCurrencyTotals.has('CAD') ? perCurrencyTotals.get('CAD') : 0;
    perCurrencyTotals.set('CAD', existingCad + accountAdjustment);
    combinedCad += accountAdjustment;
    breakdown.push({
      amount: accountAdjustment,
      currency: 'CAD',
      cadAmount: accountAdjustment,
      usdAmount: null,
      fxRate: 1,
      resolvedAmountSource: 'accountOverride',
      resolvedAmountField: 'netDepositAdjustment',
      resolvedQuantity: null,
      resolvedPrice: null,
      descriptionExtracted: false,
      descriptionExtractedAmount: null,
      descriptionExtractedAmountSigned: null,
      descriptionExtractedRaw: null,
      descriptionExtractionStrategy: null,
      timestamp: null,
      type: 'Adjustment',
      action: 'netDepositAdjustment',
      description: 'Manual net deposit adjustment applied from account settings.',
    });

    const adjustmentDate = (earliestFunding && earliestFunding instanceof Date)
      ? earliestFunding
      : crawlStart instanceof Date && !Number.isNaN(crawlStart.getTime())
        ? crawlStart
        : now;
    if (Math.abs(accountAdjustment) >= CASH_FLOW_EPSILON && adjustmentDate instanceof Date) {
      cashFlowEntries.push({ amount: -accountAdjustment, date: adjustmentDate.toISOString() });
    }
  }

  const perCurrencyObject = {};
  for (const [currency, value] of perCurrencyTotals.entries()) {
    perCurrencyObject[currency] = value;
  }

  const combinedCadValue = conversionIncomplete ? null : combinedCad;

  const accountBalanceSummary =
    perAccountCombinedBalances && perAccountCombinedBalances[account.id];
  const combinedBalances =
    accountBalanceSummary && accountBalanceSummary.combined
      ? accountBalanceSummary.combined
      : accountBalanceSummary;
  const cadBalance = combinedBalances ? combinedBalances.CAD || combinedBalances.cad : null;
  const totalEquityCad = cadBalance && Number.isFinite(Number(cadBalance.totalEquity))
    ? Number(cadBalance.totalEquity)
    : null;

  const totalPnlCad =
    Number.isFinite(totalEquityCad) && Number.isFinite(combinedCadValue)
      ? totalEquityCad - combinedCadValue
      : null;

  if (Number.isFinite(totalEquityCad) && Math.abs(totalEquityCad) >= CASH_FLOW_EPSILON) {
    cashFlowEntries.push({ amount: totalEquityCad, date: nowIsoString });
  }

  if (DEBUG_XIRR) {
    debugXirr(accountKey, 'Cash flow entries before CAGR adjustments', cashFlowEntries.slice());
  }

  let effectiveCashFlows = cashFlowEntries;
  let appliedCagrStartDate = null;

  if (options.applyAccountCagrStartDate && typeof account.cagrStartDate === 'string') {
    const parsedStartDate = parseDateOnlyString(account.cagrStartDate);
    if (parsedStartDate) {
      appliedCagrStartDate = parsedStartDate;
      let aggregatedAmount = 0;
      let rolledEntryCount = 0;
      const filtered = [];
      for (const entry of cashFlowEntries) {
        if (!entry || typeof entry !== 'object') {
          filtered.push(entry);
          continue;
        }
        const amount = Number(entry.amount);
        if (!Number.isFinite(amount)) {
          filtered.push(entry);
          continue;
        }
        const entryDate = parseCashFlowEntryDate(entry);
        if (entryDate && entryDate < parsedStartDate) {
          aggregatedAmount += amount;
          rolledEntryCount += 1;
          continue;
        }
        filtered.push(entry);
      }
      if (rolledEntryCount > 0) {
        if (aggregatedAmount !== 0) {
          filtered.unshift({ amount: aggregatedAmount, date: parsedStartDate.toISOString() });
        }
        if (DEBUG_XIRR) {
          debugXirr(accountKey, 'Applied CAGR start date override', {
            startDate: parsedStartDate.toISOString().slice(0, 10),
            rolledEntryCount,
            aggregatedAmount,
            insertedAggregation: aggregatedAmount !== 0,
          });
        }
      } else if (DEBUG_XIRR) {
        debugXirr(accountKey, 'CAGR start date override present but no prior cash flows to adjust', {
          startDate: parsedStartDate.toISOString().slice(0, 10),
        });
      }
      effectiveCashFlows = filtered;
    } else if (DEBUG_XIRR) {
      debugXirr(accountKey, 'Invalid cagrStartDate override ignored', {
        raw: account.cagrStartDate,
      });
    }
  }

  const annualizedReturnRate = !conversionIncomplete
    ? computeAccountAnnualizedReturn(effectiveCashFlows, accountKey)
    : null;

  const returnBreakdown = computeReturnBreakdownFromCashFlows(
    effectiveCashFlows,
    now,
    annualizedReturnRate
  );

  const incompleteReturnData = conversionIncomplete || missingCashFlowDates;

  debugTotalPnl(accountKey, 'Net deposits summary', {
    perCurrency: perCurrencyObject,
    combinedCad: combinedCadValue,
    totalEquityCad,
    totalPnlCad,
    crawlStart: formatDateOnly(crawlStart),
    asOf: formatDateOnly(now),
    netDepositAdjustmentCad: accountAdjustment || undefined,
    cashFlowCount: effectiveCashFlows.length || undefined,
    annualizedReturnRate: Number.isFinite(annualizedReturnRate) ? annualizedReturnRate : undefined,
    missingCashFlowDates: missingCashFlowDates || undefined,
  });

  if (DEBUG_TOTAL_PNL) {
    debugTotalPnl(accountKey, 'Funding breakdown entries', breakdown);
  }

  let annualizedReturn = undefined;
  if (Number.isFinite(annualizedReturnRate)) {
    annualizedReturn = {
      rate: annualizedReturnRate,
      method: 'xirr',
      cashFlowCount: effectiveCashFlows.length,
      asOf: nowIsoString,
      incomplete: incompleteReturnData || undefined,
    };
  } else if (incompleteReturnData && effectiveCashFlows.length > 0) {
    annualizedReturn = {
      method: 'xirr',
      cashFlowCount: effectiveCashFlows.length,
      asOf: nowIsoString,
      incomplete: true,
    };
  }

  if (annualizedReturn && appliedCagrStartDate) {
    annualizedReturn.startDate = appliedCagrStartDate.toISOString().slice(0, 10);
  }

  let normalizedPeriodStart = null;
  let normalizedPeriodEnd = formatDateOnly(now);
  if (!normalizedPeriodEnd && typeof nowIsoString === 'string' && nowIsoString.trim()) {
    normalizedPeriodEnd = nowIsoString.slice(0, 10);
  }

  if (Array.isArray(effectiveCashFlows)) {
    for (const entry of effectiveCashFlows) {
      const entryDate = parseCashFlowEntryDate(entry);
      if (entryDate && (!normalizedPeriodStart || entryDate < new Date(`${normalizedPeriodStart}T00:00:00Z`))) {
        normalizedPeriodStart = formatDateOnly(entryDate);
      }
    }
  }

  if (!normalizedPeriodStart && earliestFunding instanceof Date && !Number.isNaN(earliestFunding.getTime())) {
    normalizedPeriodStart = formatDateOnly(earliestFunding);
  }

  if (normalizedPeriodStart && normalizedPeriodEnd) {
    const startDateObj = new Date(`${normalizedPeriodStart}T00:00:00Z`);
    const endDateObj = new Date(`${normalizedPeriodEnd}T00:00:00Z`);
    if (Number.isNaN(startDateObj.getTime()) || Number.isNaN(endDateObj.getTime()) || startDateObj > endDateObj) {
      normalizedPeriodStart = null;
    }
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
    annualizedReturn,
    returnBreakdown: returnBreakdown.length ? returnBreakdown : undefined,
    cashFlowsCad: effectiveCashFlows.length > 0 ? effectiveCashFlows : undefined,
    adjustments:
      accountAdjustment !== 0
        ? {
            netDepositsCad: accountAdjustment,
          }
        : undefined,
    periodStartDate: normalizedPeriodStart || undefined,
    periodEndDate: normalizedPeriodEnd || undefined,
  };
}

async function computeNetDeposits(login, account, perAccountCombinedBalances, options = {}) {
  if (!account || !account.id) {
    return null;
  }

  const activityContext = await resolveAccountActivityContext(login, account, options.activityContext);
  if (!activityContext) {
    return null;
  }

  const cacheKey = buildNetDepositsCacheKey(login, account, perAccountCombinedBalances, options, activityContext);
  if (cacheKey) {
    const cached = getNetDepositsCacheEntry(cacheKey);
    if (cached.hit) {
      return cached.value;
    }
    if (netDepositsPromiseCache.has(cacheKey)) {
      const pending = await netDepositsPromiseCache.get(cacheKey);
      return cloneNetDepositsSummary(pending);
    }
  }

  const execute = () => computeNetDepositsCore(account, perAccountCombinedBalances, options, activityContext);

  if (!cacheKey) {
    return execute();
  }

  const pendingPromise = execute()
    .then((result) => {
      setNetDepositsCacheEntry(cacheKey, result);
      return result;
    })
    .finally(() => {
      netDepositsPromiseCache.delete(cacheKey);
    });
  netDepositsPromiseCache.set(cacheKey, pendingPromise);
  const computed = await pendingPromise;
  return cloneNetDepositsSummary(computed);
}


async function computeDividendBreakdown(login, account, options = {}) {
  if (!account || !account.id) {
    return null;
  }

  const accountKey = account.id;
  const activityContext = await resolveAccountActivityContext(login, account, options.activityContext);
  if (!activityContext) {
    return null;
  }

  const activities = Array.isArray(activityContext.activities) ? activityContext.activities : [];
  const dividendActivities = activities.filter((activity) => isDividendActivity(activity));

  if (!dividendActivities.length) {
    return {
      entries: [],
      totalsByCurrency: {},
      totalCad: 0,
      totalCount: 0,
      conversionIncomplete: false,
      startDate: null,
      endDate: null,
    };
  }

  const totalsBySymbol = new Map();
  const totalsByCurrency = new Map();
  let totalCad = 0;
  let totalCount = 0;
  let conversionIncomplete = false;
  let earliest = null;
  let latest = null;

  for (const activity of dividendActivities) {
    const details = resolveActivityAmountDetails(activity);
    if (!details) {
      continue;
    }

    const amount = Number(details.amount);
    if (!Number.isFinite(amount) || Math.abs(amount) < CASH_FLOW_EPSILON) {
      continue;
    }

    const currency = normalizeCurrency(details.currency) || 'CAD';
    const timestamp =
      details.timestamp instanceof Date && !Number.isNaN(details.timestamp.getTime())
        ? details.timestamp
        : null;

    const symbolInfo = normalizeDividendActivitySymbol(activity);
    if (!symbolInfo) {
      continue;
    }

    const entryKey = symbolInfo.canonical || symbolInfo.raw || activity.description || 'UNKNOWN';
    let entry = totalsBySymbol.get(entryKey);
    if (!entry) {
      entry = {
        canonical: symbolInfo.canonical || null,
        display: symbolInfo.canonical || symbolInfo.raw || null,
        rawSymbols: new Set(),
        description: null,
        currencyTotals: new Map(),
        cadAmount: 0,
        conversionIncomplete: false,
        activityCount: 0,
        earliestTimestamp: null,
        latestTimestamp: null,
        latestAmount: null,
        latestCurrency: null,
      };
      totalsBySymbol.set(entryKey, entry);
    }

    if (symbolInfo.canonical && !entry.canonical) {
      entry.canonical = symbolInfo.canonical;
    }
    if (!entry.display && (symbolInfo.canonical || symbolInfo.raw)) {
      entry.display = symbolInfo.canonical || symbolInfo.raw;
    }
    if (symbolInfo.raw) {
      entry.rawSymbols.add(symbolInfo.raw);
    }
    if (!entry.description && typeof activity.description === 'string' && activity.description.trim()) {
      entry.description = activity.description.trim();
    }

    entry.activityCount += 1;
    totalCount += 1;

    if (!entry.currencyTotals.has(currency)) {
      entry.currencyTotals.set(currency, 0);
    }
    entry.currencyTotals.set(currency, entry.currencyTotals.get(currency) + amount);

    if (!totalsByCurrency.has(currency)) {
      totalsByCurrency.set(currency, 0);
    }
    totalsByCurrency.set(currency, totalsByCurrency.get(currency) + amount);

    if (timestamp) {
      if (!entry.earliestTimestamp || timestamp < entry.earliestTimestamp) {
        entry.earliestTimestamp = timestamp;
      }
      if (!entry.latestTimestamp || timestamp > entry.latestTimestamp) {
        entry.latestTimestamp = timestamp;
        entry.latestAmount = amount;
        entry.latestCurrency = currency;
      }
      if (!earliest || timestamp < earliest) {
        earliest = timestamp;
      }
      if (!latest || timestamp > latest) {
        latest = timestamp;
      }
    }

    let cadContribution = null;
    if (!currency || currency === 'CAD') {
      cadContribution = amount;
    } else {
      const conversion = await convertAmountToCad(amount, currency, timestamp, accountKey);
      if (Number.isFinite(conversion.cadAmount)) {
        cadContribution = conversion.cadAmount;
      } else {
        entry.conversionIncomplete = true;
        conversionIncomplete = true;
      }
    }

    if (Number.isFinite(cadContribution)) {
      entry.cadAmount += cadContribution;
      totalCad += cadContribution;
    }
  }

  const toCurrencyTotalsObject = (map) => {
    const result = {};
    for (const [currency, value] of map.entries()) {
      result[currency] = value;
    }
    return result;
  };

  const computeMagnitude = (entry) => {
    if (Number.isFinite(entry.cadAmount)) {
      return Math.abs(entry.cadAmount);
    }
    const totals = entry.currencyTotals || {};
    return Object.values(totals).reduce((sum, value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? sum + Math.abs(numeric) : sum;
    }, 0);
  };

  const entries = Array.from(totalsBySymbol.values()).map((entry) => {
    const currencyTotals = toCurrencyTotalsObject(entry.currencyTotals);
    const rawSymbols = Array.from(entry.rawSymbols);
    const displaySymbol = entry.display || entry.canonical || (rawSymbols.length ? rawSymbols[0] : null);
    const cadAmount = Number.isFinite(entry.cadAmount) ? entry.cadAmount : 0;
    return {
      symbol: entry.canonical || null,
      displaySymbol: displaySymbol || null,
      rawSymbols: rawSymbols.length ? rawSymbols : undefined,
      description: entry.description || null,
      currencyTotals,
      cadAmount: Number.isFinite(cadAmount) ? cadAmount : null,
      conversionIncomplete: entry.conversionIncomplete || undefined,
      activityCount: entry.activityCount,
      firstDate: entry.earliestTimestamp ? formatDateOnly(entry.earliestTimestamp) : null,
      lastDate: entry.latestTimestamp ? formatDateOnly(entry.latestTimestamp) : null,
      lastTimestamp: entry.latestTimestamp ? entry.latestTimestamp.toISOString() : null,
      lastAmount: Number.isFinite(entry.latestAmount) ? entry.latestAmount : null,
      lastCurrency: entry.latestCurrency || null,
      _magnitude: computeMagnitude({
        cadAmount,
        currencyTotals,
      }),
    };
  });

  entries.sort((a, b) => (b._magnitude || 0) - (a._magnitude || 0));

  const cleanedEntries = entries.map((entry) => {
    const cleaned = Object.assign({}, entry);
    delete cleaned._magnitude;
    if (!cleaned.rawSymbols) {
      delete cleaned.rawSymbols;
    }
    if (!cleaned.conversionIncomplete) {
      delete cleaned.conversionIncomplete;
    }
    return cleaned;
  });

  const totalsByCurrencyObject = toCurrencyTotalsObject(totalsByCurrency);

  return {
    entries: cleanedEntries,
    totalsByCurrency: totalsByCurrencyObject,
    totalCad: Number.isFinite(totalCad) ? totalCad : null,
    conversionIncomplete: conversionIncomplete || undefined,
    startDate: earliest ? formatDateOnly(earliest) : null,
    endDate: latest ? formatDateOnly(latest) : null,
    totalCount,
  };
}

function enumerateDateKeys(startDate, endDate) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return [];
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    return [];
  }
  if (startDate > endDate) {
    return [];
  }
  const keys = [];
  let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const endTime = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  while (cursor.getTime() <= endTime) {
    keys.push(formatDateOnly(cursor));
    cursor = addDays(cursor, 1) || new Date(cursor.getTime() + DAY_IN_MS);
  }
  return keys;
}

async function fetchSymbolPriceHistory(symbol, startDateKey, endDateKey) {
  if (!symbol || !startDateKey || !endDateKey) {
    return null;
  }

  const startDate = new Date(`${startDateKey}T00:00:00Z`);
  const endDate = new Date(`${endDateKey}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return null;
  }

  const exclusiveEnd = addDays(endDate, 1) || new Date(endDate.getTime() + DAY_IN_MS);

  const finance = ensureYahooFinanceClient();
  const history = await finance.historical(symbol, {
    period1: startDate,
    period2: exclusiveEnd,
    interval: '1d',
  });

  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const normalized = history
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const entryDate =
        entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
          ? entry.date
          : typeof entry.date === 'string'
            ? new Date(entry.date)
            : null;
      if (!(entryDate instanceof Date) || Number.isNaN(entryDate.getTime())) {
        return null;
      }
      const adjClose = Number(entry.adjClose);
      const close = Number(entry.close);
      const price = Number.isFinite(adjClose)
        ? adjClose
        : Number.isFinite(close)
          ? close
          : Number.NaN;
      if (!Number.isFinite(price) || price <= 0) {
        return null;
      }
      return { date: entryDate, price };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  return normalized;
}

function buildDailyPriceSeries(normalizedHistory, dateKeys) {
  const series = new Map();
  if (!Array.isArray(normalizedHistory) || normalizedHistory.length === 0 || !Array.isArray(dateKeys)) {
    return series;
  }
  let cursorIndex = 0;
  let lastPrice = null;
  for (const dateKey of dateKeys) {
    const targetTime = Date.parse(`${dateKey}T00:00:00Z`);
    if (!Number.isFinite(targetTime)) {
      continue;
    }
    while (
      cursorIndex < normalizedHistory.length &&
      normalizedHistory[cursorIndex].date instanceof Date &&
      !Number.isNaN(normalizedHistory[cursorIndex].date.getTime()) &&
      normalizedHistory[cursorIndex].date.getTime() <= targetTime
    ) {
      lastPrice = normalizedHistory[cursorIndex].price;
      cursorIndex += 1;
    }
    if (Number.isFinite(lastPrice)) {
      series.set(dateKey, lastPrice);
    }
  }
  if (series.size > 0) {
    let carry = null;
    for (const dateKey of dateKeys) {
      if (!dateKey) {
        continue;
      }
      if (series.has(dateKey)) {
        const value = series.get(dateKey);
        if (Number.isFinite(value)) {
          carry = value;
        }
      } else if (Number.isFinite(carry)) {
        series.set(dateKey, carry);
      }
    }
    const firstKnownKey = dateKeys.find((key) => Number.isFinite(series.get(key)));
    if (firstKnownKey) {
      const firstValue = series.get(firstKnownKey);
      for (const dateKey of dateKeys) {
        if (dateKey === firstKnownKey) {
          break;
        }
        if (!series.has(dateKey) && Number.isFinite(firstValue)) {
          series.set(dateKey, firstValue);
        }
      }
    }
  }
  return series;
}

function adjustNumericMap(map, key, delta, epsilon = 1e-8) {
  if (!map || !key || !Number.isFinite(delta)) {
    return;
  }
  const current = map.has(key) ? map.get(key) : 0;
  const next = current + delta;
  if (Math.abs(next) < epsilon) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
}

async function computeDailyNetDeposits(activityContext, account, accountKey) {
  const activities = Array.isArray(activityContext.activities) ? activityContext.activities : [];
  const fundingActivities = dedupeActivities(filterFundingActivities(activities));
  const perDay = new Map();
  let conversionIncomplete = false;
  for (const activity of fundingActivities) {
    const details = resolveActivityAmountDetails(activity);
    if (!details) {
      continue;
    }
    const { amount, currency, timestamp } = details;
    const { cadAmount } = await convertAmountToCad(amount, currency, timestamp, accountKey);
    if (!Number.isFinite(cadAmount)) {
      if (currency && currency !== 'CAD') {
        conversionIncomplete = true;
      }
      continue;
    }
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      conversionIncomplete = true;
      continue;
    }
    const dateKey = formatDateOnly(timestamp);
    if (!dateKey) {
      conversionIncomplete = true;
      continue;
    }
    adjustNumericMap(perDay, dateKey, cadAmount, CASH_FLOW_EPSILON);
  }

  const accountAdjustment =
    account && typeof account.netDepositAdjustment === 'number' && Number.isFinite(account.netDepositAdjustment)
      ? account.netDepositAdjustment
      : 0;
  if (accountAdjustment !== 0) {
    const adjustmentDate =
      activityContext.earliestFunding instanceof Date && !Number.isNaN(activityContext.earliestFunding.getTime())
        ? activityContext.earliestFunding
        : activityContext.crawlStart instanceof Date && !Number.isNaN(activityContext.crawlStart.getTime())
          ? activityContext.crawlStart
          : activityContext.now instanceof Date && !Number.isNaN(activityContext.now.getTime())
            ? activityContext.now
            : null;
    if (adjustmentDate) {
      const dateKey = formatDateOnly(adjustmentDate);
      if (dateKey) {
        adjustNumericMap(perDay, dateKey, accountAdjustment, CASH_FLOW_EPSILON);
      }
    }
  }

  return { perDay, conversionIncomplete };
}

const LEDGER_QUANTITY_EPSILON = 1e-8;

function extractActivityPriceHint(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }

  const directPrice = Number(activity.price);
  if (Number.isFinite(directPrice) && directPrice > 0) {
    return Math.abs(directPrice);
  }

  const quantity = Number(activity.quantity);
  if (!Number.isFinite(quantity) || Math.abs(quantity) < LEDGER_QUANTITY_EPSILON) {
    return null;
  }

  const grossAmount = Number(activity.grossAmount);
  if (Number.isFinite(grossAmount) && Math.abs(grossAmount) >= CASH_FLOW_EPSILON / 10) {
    const derived = Math.abs(grossAmount) / Math.abs(quantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }

  const netAmount = Number(activity.netAmount);
  if (Number.isFinite(netAmount) && Math.abs(netAmount) >= CASH_FLOW_EPSILON / 10) {
    const derived = Math.abs(netAmount) / Math.abs(quantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }

  const amountInfo = resolveActivityAmount(activity);
  if (
    amountInfo &&
    Number.isFinite(amountInfo.amount) &&
    Math.abs(amountInfo.amount) >= CASH_FLOW_EPSILON / 10
  ) {
    const derived = Math.abs(amountInfo.amount) / Math.abs(quantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }

  return null;
}

function buildPriceSeriesFromHints(hints, dateKeys) {
  if (!Array.isArray(hints) || !Array.isArray(dateKeys) || dateKeys.length === 0) {
    return new Map();
  }

  const entriesByDate = new Map();
  hints.forEach((hint) => {
    if (!hint) {
      return;
    }
    const price = Number(hint.price);
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }
    let timestamp = hint.timestamp;
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      const parsed = typeof hint.dateKey === 'string' ? parseDateOnlyString(hint.dateKey) : null;
      timestamp = parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
    }
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      return;
    }
    const normalized = new Date(
      Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate())
    );
    const dateKey = formatDateOnly(normalized);
    if (!dateKey) {
      return;
    }
    const existing = entriesByDate.get(dateKey);
    if (!existing || normalized > existing.date) {
      entriesByDate.set(dateKey, { date: normalized, price });
    }
  });

  if (!entriesByDate.size) {
    return new Map();
  }

  const normalizedHistory = Array.from(entriesByDate.values()).sort((a, b) => a.date - b.date);
  return buildDailyPriceSeries(normalizedHistory, dateKeys);
}

function adjustHolding(holdings, symbol, delta) {
  if (!symbol || !Number.isFinite(delta)) {
    return;
  }
  const current = holdings.has(symbol) ? holdings.get(symbol) : 0;
  const next = current + delta;
  if (Math.abs(next) < LEDGER_QUANTITY_EPSILON) {
    holdings.delete(symbol);
  } else {
    holdings.set(symbol, next);
  }
}

function adjustCash(cashByCurrency, currency, delta) {
  if (!currency || !Number.isFinite(delta)) {
    return;
  }
  const current = cashByCurrency.has(currency) ? cashByCurrency.get(currency) : 0;
  const next = current + delta;
  if (Math.abs(next) < 0.00001) {
    cashByCurrency.delete(currency);
  } else {
    cashByCurrency.set(currency, next);
  }
}

async function resolveUsdRateForDate(dateKey, accountKey, cache) {
  if (!dateKey) {
    return null;
  }
  if (cache.has(dateKey)) {
    return cache.get(dateKey);
  }
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    cache.set(dateKey, null);
    return null;
  }
  const rate = await resolveUsdToCadRate(date, accountKey);
  cache.set(dateKey, Number.isFinite(rate) && rate > 0 ? rate : null);
  return cache.get(dateKey);
}

function computeLedgerEquitySnapshot(dateKey, holdings, cashByCurrency, symbolMeta, priceSeriesMap, usdRate) {
  let cadValue = 0;
  let usdValue = 0;
  const missingPrices = [];
  const unsupportedCurrencies = new Set();

  for (const [symbol, quantity] of holdings.entries()) {
    if (!Number.isFinite(quantity) || Math.abs(quantity) < LEDGER_QUANTITY_EPSILON) {
      continue;
    }
    const meta = symbolMeta.get(symbol) || {};
    const currency = meta.currency || 'CAD';
    const series = priceSeriesMap.get(symbol);
    const price = series && series.size ? series.get(dateKey) : null;
    if (!Number.isFinite(price) || price <= 0) {
      missingPrices.push(symbol);
      continue;
    }
    const positionValue = quantity * price;
    if (!Number.isFinite(positionValue)) {
      missingPrices.push(symbol);
      continue;
    }
    if (currency === 'USD') {
      usdValue += positionValue;
    } else if (currency === 'CAD' || !currency) {
      cadValue += positionValue;
    } else {
      unsupportedCurrencies.add(currency);
    }
  }

  const cadCash = cashByCurrency.get('CAD') || 0;
  const usdCash = cashByCurrency.get('USD') || 0;
  cadValue += cadCash;
  usdValue += usdCash;

  let equityCad = cadValue;
  if (Math.abs(usdValue) > 0.00001) {
    if (Number.isFinite(usdRate) && usdRate > 0) {
      equityCad += usdValue * usdRate;
    } else {
      unsupportedCurrencies.add('USD');
    }
  }

  return {
    equityCad,
    missingPrices,
    unsupportedCurrencies: Array.from(unsupportedCurrencies),
    cadCash,
    usdCash,
    cadSecurityValue: cadValue - cadCash,
    usdSecurityValue: usdValue - usdCash,
  };
}

async function computeTotalPnlSeries(login, account, perAccountCombinedBalances, options = {}) {
  if (!account || !account.id) {
    return null;
  }

  const accountKey = account.id;
  const activityContext = await resolveAccountActivityContext(login, account, options.activityContext);
  if (!activityContext) {
    return null;
  }

  const netDepositOptions = {
    applyAccountCagrStartDate:
      Object.prototype.hasOwnProperty.call(options, 'applyAccountCagrStartDate')
        ? !!options.applyAccountCagrStartDate
        : true,
  };

  const netDepositsSummary = await computeNetDepositsCore(account, perAccountCombinedBalances, netDepositOptions, activityContext);
  if (!netDepositsSummary) {
    return null;
  }

  const startDateIso =
    typeof options.startDate === 'string' && options.startDate.trim()
      ? options.startDate.trim()
      : netDepositsSummary.periodStartDate || formatDateOnly(activityContext.crawlStart) || formatDateOnly(activityContext.now);
  const cagrStartDate =
    options && options.applyAccountCagrStartDate !== false && typeof account.cagrStartDate === 'string'
      ? account.cagrStartDate.trim()
      : null;
  const displayStartIso = cagrStartDate || startDateIso;
  const endDateIso =
    typeof options.endDate === 'string' && options.endDate.trim()
      ? options.endDate.trim()
      : netDepositsSummary.periodEndDate || formatDateOnly(activityContext.now);

  const startDate = parseDateOnlyString(startDateIso);
  const displayStartDate = parseDateOnlyString(displayStartIso);
  const endDate = parseDateOnlyString(endDateIso);
  if (!startDate || !endDate || startDate > endDate) {
    return null;
  }

  const dateKeys = enumerateDateKeys(startDate, endDate);
  if (!dateKeys.length) {
    return null;
  }

  await ensureUsdToCadRates(dateKeys);

  const processedActivities = [];
  const symbolIds = new Set();
  const symbolMeta = new Map();
  const priceHintsBySymbol = new Map();

  const rawActivities = Array.isArray(activityContext.activities) ? activityContext.activities : [];
  rawActivities.forEach((activity) => {
    const timestamp = resolveActivityTimestamp(activity);
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      return;
    }
    const dateKey = formatDateOnly(timestamp);
    if (!dateKey) {
      return;
    }
    processedActivities.push({ activity, timestamp, dateKey });

    const rawSymbol = typeof activity.symbol === 'string' ? activity.symbol.trim() : '';
    const symbol = rawSymbol || null;
    const symbolId = Number(activity.symbolId);
    const currency = normalizeCurrency(activity.currency) || null;

    if (Number.isFinite(symbolId) && symbolId > 0) {
      symbolIds.add(symbolId);
    }

    if (!symbol) {
      return;
    }

    if (!priceHintsBySymbol.has(symbol)) {
      priceHintsBySymbol.set(symbol, []);
    }
    const priceHint = extractActivityPriceHint(activity);
    if (Number.isFinite(priceHint) && priceHint > 0) {
      priceHintsBySymbol.get(symbol).push({ price: priceHint, timestamp, dateKey });
    }

    if (!symbolMeta.has(symbol)) {
      symbolMeta.set(symbol, {
        symbolId: Number.isFinite(symbolId) && symbolId > 0 ? symbolId : null,
        currency,
      });
    } else {
      const meta = symbolMeta.get(symbol);
      if (!meta.currency && currency) {
        meta.currency = currency;
      }
      if ((!meta.symbolId || meta.symbolId <= 0) && Number.isFinite(symbolId) && symbolId > 0) {
        meta.symbolId = symbolId;
      }
    }
  });

  processedActivities.sort((a, b) => a.timestamp - b.timestamp);

  let symbolDetails = {};
  if (symbolIds.size > 0) {
    try {
      symbolDetails = await fetchSymbolsDetails(login, Array.from(symbolIds));
    } catch (symbolError) {
      symbolDetails = {};
    }
  }

  for (const [symbol, meta] of symbolMeta.entries()) {
    if (!meta.currency && meta.symbolId && symbolDetails && symbolDetails[meta.symbolId]) {
      const detailCurrency = normalizeCurrency(symbolDetails[meta.symbolId].currency);
      if (detailCurrency) {
        meta.currency = detailCurrency;
      }
    }
    if (!meta.currency) {
      meta.currency = 'CAD';
    }
  }

  const symbols = Array.from(symbolMeta.keys());
  const priceSeriesMap = new Map();
  const missingPriceSymbols = new Set();
  if (symbols.length) {
    const startKey = dateKeys[0];
    const endKey = dateKeys[dateKeys.length - 1];
    await mapWithConcurrency(symbols, Math.min(4, symbols.length), async function (symbol) {
      const cacheKey = getPriceHistoryCacheKey(symbol, startKey, endKey);
      let history = null;
      if (cacheKey) {
        const cached = getCachedPriceHistory(cacheKey);
        if (cached.hit) {
          history = cached.value;
        }
      }
      if (!history) {
        try {
          const useCustomFetcher = typeof customPriceHistoryFetcher === 'function';
          const fetcher = useCustomFetcher ? customPriceHistoryFetcher : fetchSymbolPriceHistory;
          history = await fetcher(symbol, startKey, endKey);
        } catch (priceError) {
          history = null;
        }
        const shouldCache = !customPriceHistoryFetcher && cacheKey;
        if (history && shouldCache) {
          setCachedPriceHistory(cacheKey, history);
        }
      }
      let series = null;
      if (Array.isArray(history) && history.length > 0) {
        series = buildDailyPriceSeries(history, dateKeys);
      }
      const hints = priceHintsBySymbol.get(symbol);
      const hintSeries =
        Array.isArray(hints) && hints.length > 0 ? buildPriceSeriesFromHints(hints, dateKeys) : null;

      if (series && series.size > 0) {
        if (hintSeries && hintSeries.size > 0) {
          hintSeries.forEach((price, dateKey) => {
            if (!Number.isFinite(series.get(dateKey))) {
              series.set(dateKey, price);
            }
          });
        }
        priceSeriesMap.set(symbol, series);
      } else if (hintSeries && hintSeries.size > 0) {
        priceSeriesMap.set(symbol, hintSeries);
      } else {
        priceSeriesMap.set(symbol, new Map());
        missingPriceSymbols.add(symbol);
      }
    });
  }

  const { perDay: dailyNetDepositsMap, conversionIncomplete } = await computeDailyNetDeposits(activityContext, account, accountKey);

  const holdings = new Map();
  const cashByCurrency = new Map();
  const usdRateCache = new Map();
  const points = [];
  const issues = new Set();
  let cumulativeNetDeposits = 0;
  let activityIndex = 0;

  for (const dateKey of dateKeys) {
    while (activityIndex < processedActivities.length && processedActivities[activityIndex].dateKey <= dateKey) {
      const entry = processedActivities[activityIndex];
      const { activity } = entry;
      const currency = normalizeCurrency(activity.currency);
      const netAmount = Number(activity.netAmount);
      const quantity = Number(activity.quantity);
      const rawSymbol = typeof activity.symbol === 'string' ? activity.symbol.trim() : '';
      const symbol = rawSymbol || null;

      if (symbol && Number.isFinite(quantity) && Math.abs(quantity) >= LEDGER_QUANTITY_EPSILON) {
        adjustHolding(holdings, symbol, quantity);
      }

      if (currency && Number.isFinite(netAmount) && Math.abs(netAmount) >= CASH_FLOW_EPSILON / 10) {
        adjustCash(cashByCurrency, currency, netAmount);
      }

      activityIndex += 1;
    }

    const dailyDelta = dailyNetDepositsMap.has(dateKey) ? dailyNetDepositsMap.get(dateKey) : 0;
    if (Number.isFinite(dailyDelta) && Math.abs(dailyDelta) >= CASH_FLOW_EPSILON / 10) {
      cumulativeNetDeposits += dailyDelta;
    }

    let usdRate = null;
    const needsUsdRate =
      cashByCurrency.has('USD') && Math.abs(cashByCurrency.get('USD')) >= 0.00001;
    if (!needsUsdRate) {
      for (const symbol of holdings.keys()) {
        const meta = symbolMeta.get(symbol);
        if (meta && meta.currency === 'USD' && Math.abs(holdings.get(symbol)) >= LEDGER_QUANTITY_EPSILON) {
          usdRate = await resolveUsdRateForDate(dateKey, accountKey, usdRateCache);
          break;
        }
      }
    } else {
      usdRate = await resolveUsdRateForDate(dateKey, accountKey, usdRateCache);
    }

    const snapshot = computeLedgerEquitySnapshot(
      dateKey,
      holdings,
      cashByCurrency,
      symbolMeta,
      priceSeriesMap,
      usdRate
    );

    if (snapshot.missingPrices.length) {
      snapshot.missingPrices.forEach((symbol) => missingPriceSymbols.add(symbol));
    }
    if (snapshot.unsupportedCurrencies.length) {
      snapshot.unsupportedCurrencies.forEach((code) => issues.add('unsupported-currency:' + code));
    }
    if (usdRate === null && (Math.abs(snapshot.usdCash) > 0.00001 || Math.abs(snapshot.usdSecurityValue) > 0.00001)) {
      issues.add('missing-usd-rate:' + dateKey);
    }

    const equityCad = Number.isFinite(snapshot.equityCad) ? snapshot.equityCad : null;
    const cumulativeNetDepositsCad = Number.isFinite(cumulativeNetDeposits) ? cumulativeNetDeposits : null;
    let totalPnlCad = null;
    if (Number.isFinite(equityCad) && Number.isFinite(cumulativeNetDepositsCad)) {
      totalPnlCad = equityCad - cumulativeNetDepositsCad;
    }

    points.push({
      date: dateKey,
      equityCad,
      cumulativeNetDepositsCad,
      totalPnlCad,
      usdToCadRate: Number.isFinite(usdRate) ? usdRate : undefined,
    });
  }

  const summaryTotalPnl = netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.combinedCad)
    ? netDepositsSummary.totalPnl.combinedCad
    : null;
  const summaryNetDeposits = netDepositsSummary.netDeposits && Number.isFinite(netDepositsSummary.netDeposits.combinedCad)
    ? netDepositsSummary.netDeposits.combinedCad
    : null;
  const summaryEquity = Number.isFinite(netDepositsSummary.totalEquityCad)
    ? netDepositsSummary.totalEquityCad
    : null;

  if (points.length) {
    const first = points[0];
    if (first && Number.isFinite(first.totalPnlCad) && Math.abs(first.totalPnlCad) < 0.01) {
      first.totalPnlCad = 0;
    }
    const last = points[points.length - 1];
    if (last) {
      if (summaryEquity !== null) {
        last.equityCad = summaryEquity;
        if (Number.isFinite(last.cumulativeNetDepositsCad)) {
          last.totalPnlCad = summaryEquity - last.cumulativeNetDepositsCad;
        }
      }
      if (summaryTotalPnl !== null) {
        if (!Number.isFinite(last.totalPnlCad) || Math.abs(last.totalPnlCad - summaryTotalPnl) > 0.05) {
          last.totalPnlCad = summaryTotalPnl;
          if (Number.isFinite(last.cumulativeNetDepositsCad)) {
            last.equityCad = summaryTotalPnl + last.cumulativeNetDepositsCad;
          }
        }
      }
    }
  }

  if (conversionIncomplete) {
    issues.add('funding-conversion-incomplete');
  }
  if (missingPriceSymbols.size) {
    issues.add('missing-price-data');
  }

  const filteredPoints = displayStartDate
    ? points.filter((point) => {
        const pointDate = parseDateOnlyString(point.date);
        return pointDate ? pointDate >= displayStartDate : true;
      })
    : points;

  return {
    accountId: accountKey,
    periodStartDate: dateKeys[0],
    displayStartDate: displayStartDate ? formatDateOnly(displayStartDate) : undefined,
    periodEndDate: dateKeys[dateKeys.length - 1],
    points: filteredPoints,
    summary: {
      totalPnlCad: summaryTotalPnl,
      totalEquityCad: summaryEquity,
      netDepositsCad: summaryNetDeposits,
    },
    issues: issues.size ? Array.from(issues) : undefined,
    missingPriceSymbols: missingPriceSymbols.size ? Array.from(missingPriceSymbols) : undefined,
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
  'exchangeRate',
  'fxRate',
  'conversionRate',
  'rate',
];

const BALANCE_DIRECT_FIELDS = new Set(['exchangeRate', 'fxRate', 'conversionRate', 'rate']);

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
      if (BALANCE_DIRECT_FIELDS.has(field)) {
        target[field] = value;
      } else {
        const current = typeof target[field] === 'number' && Number.isFinite(target[field]) ? target[field] : 0;
        target[field] = current + value;
      }
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

function summarizeAccountBalances(balanceEntry) {
  const summary = mergeBalances([balanceEntry]);
  finalizeBalances(summary);
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const hasCombined = summary.combined && Object.keys(summary.combined).length > 0;
  const hasPerCurrency = summary.perCurrency && Object.keys(summary.perCurrency).length > 0;

  if (!hasCombined && !hasPerCurrency) {
    return null;
  }

  return summary;
}

async function resolveAccountContextByKey(accountKey) {
  if (!accountKey) {
    return null;
  }
  const normalizedKey = String(accountKey).trim();
  if (!normalizedKey) {
    return null;
  }
  const loweredKey = normalizedKey.toLowerCase();
  const colonIndex = loweredKey.indexOf(':');
  const targetKeys = [loweredKey];
  let loginFilter = null;
  if (colonIndex > 0) {
    loginFilter = loweredKey.slice(0, colonIndex);
    const accountPortion = loweredKey.slice(colonIndex + 1);
    if (accountPortion) {
      targetKeys.push(accountPortion);
    }
  }

  for (const login of allLogins) {
    const loginIdLower = String(login.id || '').trim().toLowerCase();
    if (loginFilter && loginIdLower !== loginFilter) {
      continue;
    }
    let accounts;
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      throw error;
    }
    if (!Array.isArray(accounts)) {
      continue;
    }
    for (const rawAccount of accounts) {
      if (!rawAccount) {
        continue;
      }
      const candidates = [];
      if (rawAccount.id != null) {
        candidates.push(String(rawAccount.id).trim().toLowerCase());
      }
      if (rawAccount.number != null) {
        candidates.push(String(rawAccount.number).trim().toLowerCase());
      }
      if (rawAccount.accountNumber != null) {
        candidates.push(String(rawAccount.accountNumber).trim().toLowerCase());
      }
      if (rawAccount.name != null) {
        candidates.push(String(rawAccount.name).trim().toLowerCase());
      }
      if (targetKeys.some((key) => candidates.includes(key))) {
        const normalizedAccount = Object.assign({}, rawAccount);
        const derivedId =
          (rawAccount.id != null && String(rawAccount.id).trim()) ||
          (rawAccount.number != null && String(rawAccount.number).trim()) ||
          (rawAccount.accountNumber != null && String(rawAccount.accountNumber).trim()) ||
          normalizedKey;
        const derivedNumber =
          (rawAccount.number != null && String(rawAccount.number).trim()) ||
          (rawAccount.accountNumber != null && String(rawAccount.accountNumber).trim()) ||
          (rawAccount.id != null && String(rawAccount.id).trim()) ||
          normalizedKey;
        normalizedAccount.id = derivedId;
        normalizedAccount.number = derivedNumber;
        return { login, account: normalizedAccount };
      }
    }
  }
  return null;
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

async function mapWithConcurrency(items, limit, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit || 1, items.length));
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

const MAX_AGGREGATE_FUNDING_CONCURRENCY = 4;

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

  const combinedBalances =
    balances && typeof balances === 'object' && balances.combined ? balances.combined : balances;

  if (!combinedBalances || typeof combinedBalances !== 'object') {
    return null;
  }

  const cadKey = Object.keys(combinedBalances).find(function (key) {
    return key && typeof key === 'string' && key.toUpperCase() === 'CAD';
  });
  if (!cadKey) {
    return null;
  }
  const cadBalance = combinedBalances[cadKey];
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

function buildInitialInvestmentModelPositions(account, perAccountBalances, modelConfig) {
  const cadBalance = findAccountCadBalance(account.id, perAccountBalances);
  const configuredReserveSymbol =
    modelConfig && modelConfig.reserveSymbol ? normalizeSymbol(modelConfig.reserveSymbol) : null;
  const reserveSymbol = configuredReserveSymbol || 'SGOV';
  if (!cadBalance) {
    return { positions: [], reserveSymbol };
  }
  const cadValue = extractCadMarketValue(cadBalance);
  if (!Number.isFinite(cadValue)) {
    return { positions: [], reserveSymbol };
  }
  return {
    positions: [
      {
        symbol: reserveSymbol,
        dollars: cadValue,
      },
    ],
    reserveSymbol,
  };
}

function buildInvestmentModelRequest(account, positions, perAccountBalances, modelConfig) {
  if (!account) {
    return null;
  }

  const normalizedConfig =
    normalizeInvestmentModelConfig(modelConfig) ||
    normalizeInvestmentModelConfig({
      model: account.investmentModel,
      lastRebalance: account.investmentModelLastRebalance,
    });

  if (!normalizedConfig || !normalizedConfig.model) {
    return null;
  }

  const requestDate = new Date().toISOString().slice(0, 10);
  const payload = {
    experiment: normalizedConfig.model,
    request_date: requestDate,
  };

  if (normalizedConfig.symbol) {
    payload.base_symbol = normalizedConfig.symbol;
  }
  if (normalizedConfig.leveragedSymbol) {
    payload.leveraged_symbol = normalizedConfig.leveragedSymbol;
  }

  const lastRebalance =
    normalizedConfig.lastRebalance || normalizeDateOnly(account.investmentModelLastRebalance);

  if (normalizedConfig.reserveSymbol) {
    payload.reserve_symbol = normalizedConfig.reserveSymbol;
  }

  if (lastRebalance) {
    payload.positions = buildInvestmentModelPositions(positions, account.id);
    payload.last_rebalance = lastRebalance;
  } else {
    const initial = buildInitialInvestmentModelPositions(account, perAccountBalances, normalizedConfig);
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

function toFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTemperatureChartPoints(points) {
  if (!Array.isArray(points)) {
    return [];
  }
  return points
    .map(function (entry) {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const date = normalizeDateOnly(entry.date || entry.timestamp || null);
      if (!date) {
        return null;
      }
      const temperature = toFiniteNumber(entry.temperature ?? entry.temp);
      if (temperature === null) {
        return null;
      }
      const normalized = { date, temperature };
      const close = toFiniteNumber(entry.close);
      if (close !== null) {
        normalized.close = close;
      }
      const fitted = toFiniteNumber(entry.fitted ?? entry.fit);
      if (fitted !== null) {
        normalized.fitted = fitted;
      }
      return normalized;
    })
    .filter(Boolean)
    .sort(function (a, b) {
      if (a.date < b.date) {
        return -1;
      }
      if (a.date > b.date) {
        return 1;
      }
      return 0;
    });
}

function normalizeTemperatureChartResponse(requestedModel, response) {
  const series = normalizeTemperatureChartPoints(response && response.points);
  const latest = series.length ? { ...series[series.length - 1] } : null;
  const resolvedStart = normalizeDateOnly(response && response.resolved_start_date);
  const resolvedEnd = normalizeDateOnly(response && response.resolved_end_date);
  const fallbackStart = series.length ? series[0].date : null;
  const fallbackEnd = latest ? latest.date : null;
  const rangeStart = resolvedStart || fallbackStart;
  const rangeEnd = resolvedEnd || fallbackEnd;
  const requestedStart = normalizeDateOnly(response && response.requested_start_date);
  const requestedEnd = normalizeDateOnly(response && response.requested_end_date);

  const referenceTemperatures = Array.isArray(response && response.reference_temperatures)
    ? response.reference_temperatures
        .map(function (value) {
          return toFiniteNumber(value);
        })
        .filter(function (value) {
          return value !== null;
        })
    : [];

  const allocationAnchors = Array.isArray(response && response.temperature_allocation)
    ? response.temperature_allocation
        .map(function (entry) {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const temperature = toFiniteNumber(entry.temperature ?? entry.temp);
          const allocation = toFiniteNumber(entry.allocation);
          if (temperature === null || allocation === null) {
            return null;
          }
          return { temperature, allocation };
        })
        .filter(Boolean)
    : [];

  const fitRaw = response && typeof response.fit === 'object' ? response.fit : null;
  let growthCurve = null;
  let fitDetails = null;
  if (fitRaw) {
    const fitA = toFiniteNumber(fitRaw.A);
    const fitR = toFiniteNumber(fitRaw.growth_rate);
    const fitPercent = toFiniteNumber(fitRaw.growth_rate_percent);
    const fitStart = normalizeDateOnly(fitRaw.start_date);
    const manualOverride = typeof fitRaw.manual_override === 'boolean' ? fitRaw.manual_override : null;

    fitDetails = {};
    if (fitA !== null) {
      fitDetails.A = fitA;
    }
    if (fitR !== null) {
      fitDetails.growthRate = fitR;
    }
    if (fitPercent !== null) {
      fitDetails.growthRatePercent = fitPercent;
    }
    if (fitStart) {
      fitDetails.startDate = fitStart;
    }
    if (manualOverride !== null) {
      fitDetails.manualOverride = manualOverride;
    }
    if (Object.keys(fitDetails).length === 0) {
      fitDetails = null;
    }

    if (fitA !== null || fitR !== null || fitStart || manualOverride !== null) {
      growthCurve = {};
      if (fitA !== null) {
        growthCurve.A = fitA;
      }
      if (fitR !== null) {
        growthCurve.r = fitR;
      }
      if (fitStart) {
        growthCurve.startDate = fitStart;
      }
      if (manualOverride !== null) {
        growthCurve.manualOverride = manualOverride;
      }
    }
  }

  const normalizedBaseSymbol = typeof response?.base_symbol === 'string' ? response.base_symbol : null;
  const baseSymbol = normalizedBaseSymbol ? normalizeSymbol(normalizedBaseSymbol) : null;
  const priceSource =
    response && typeof response.price_source === 'string' && response.price_source.trim()
      ? response.price_source.trim()
      : null;
  const experiment =
    response && typeof response.experiment === 'string' && response.experiment.trim()
      ? response.experiment.trim()
      : null;

  return {
    model: requestedModel || null,
    experiment: experiment || (requestedModel ? requestedModel.toUpperCase() : null),
    updated: new Date().toISOString(),
    rangeStart: rangeStart || null,
    rangeEnd: rangeEnd || null,
    requestedRange:
      requestedStart || requestedEnd
        ? {
            start: requestedStart || null,
            end: requestedEnd || null,
          }
        : null,
    baseSymbol,
    priceSource,
    referenceTemperatures,
    temperatureAllocation: allocationAnchors.length ? allocationAnchors : null,
    fit: fitDetails,
    growthCurve,
    series,
    latest,
  };
}

app.get('/api/quote', async function (req, res) {
  const rawSymbol = typeof req.query.symbol === 'string' ? req.query.symbol : '';
  const trimmedSymbol = rawSymbol ? rawSymbol.trim() : '';
  const normalizedSymbol = normalizeSymbol(trimmedSymbol);

  if (!normalizedSymbol) {
    return res.status(400).json({ message: 'Query parameter "symbol" is required' });
  }

  const cacheKey = normalizedSymbol;
  const cached = quoteCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const finance = ensureYahooFinanceClient();
    const quote = await finance.quote(trimmedSymbol || normalizedSymbol);
    const price = extractQuotePrice(quote);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(404).json({ message: `Price unavailable for ${normalizedSymbol}` });
    }

    const currency =
      quote && typeof quote.currency === 'string' && quote.currency.trim()
        ? quote.currency.trim().toUpperCase()
        : null;
    const name =
      (quote &&
        (quote.longName || quote.shortName || quote.displayName || quote.symbol || normalizedSymbol)) ||
      normalizedSymbol;
    const payload = {
      symbol: normalizedSymbol,
      price,
      currency,
      name,
      source: 'yahoo-finance2',
      asOf: resolveQuoteTimestamp(quote),
    };
    quoteCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    if (error instanceof MissingYahooDependencyError || error?.code === 'MISSING_DEPENDENCY') {
      return res.status(503).json({ message: error.message });
    }
    const statusCode = error?.statusCode || error?.status;
    const message = error && error.message ? error.message : 'Unknown error';
    if (statusCode === 404) {
      return res.status(404).json({ message: `Quote unavailable for ${normalizedSymbol}` });
    }
    if (typeof message === 'string' && message.toLowerCase().includes('not found')) {
      return res.status(404).json({ message: `Quote unavailable for ${normalizedSymbol}` });
    }
    console.error('Failed to fetch quote from Yahoo Finance:', normalizedSymbol, message);
    return res.status(500).json({ message: `Failed to fetch quote for ${normalizedSymbol}`, details: message });
  }
});

app.get('/api/benchmark-returns', async function (req, res) {
  const rawStart = typeof req.query.startDate === 'string' ? req.query.startDate : '';
  const rawEnd = typeof req.query.endDate === 'string' ? req.query.endDate : '';

  const normalizedStart = normalizeDateOnly(rawStart);
  if (!normalizedStart) {
    return res.status(400).json({ message: 'Query parameter "startDate" is required' });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  let normalizedEnd = normalizeDateOnly(rawEnd) || todayIso;
  if (normalizedEnd > todayIso) {
    normalizedEnd = todayIso;
  }

  const startDateObj = new Date(`${normalizedStart}T00:00:00Z`);
  const endDateObj = new Date(`${normalizedEnd}T00:00:00Z`);
  if (Number.isNaN(startDateObj.getTime()) || Number.isNaN(endDateObj.getTime())) {
    return res.status(400).json({ message: 'Invalid date range specified' });
  }
  if (startDateObj > endDateObj) {
    return res.status(400).json({ message: 'startDate must be on or before endDate' });
  }

  try {
    const [sp500Return, qqqReturn, interestRate] = await Promise.all([
      computeBenchmarkReturn(BENCHMARK_SYMBOLS.sp500.symbol, normalizedStart, normalizedEnd),
      computeBenchmarkReturn(BENCHMARK_SYMBOLS.qqq.symbol, normalizedStart, normalizedEnd),
      computeAverageInterestRate(INTEREST_RATE_SERIES.symbol, normalizedStart, normalizedEnd),
    ]);

    return res.json({
      startDate: normalizedStart,
      endDate: normalizedEnd,
      sp500: sp500Return
        ? {
            name: BENCHMARK_SYMBOLS.sp500.name,
            ...sp500Return,
          }
        : null,
      qqq: qqqReturn
        ? {
            name: BENCHMARK_SYMBOLS.qqq.name,
            ...qqqReturn,
          }
        : null,
      interestRate: interestRate
        ? {
            name: INTEREST_RATE_SERIES.name,
            ...interestRate,
          }
        : null,
    });
  } catch (error) {
    if (error && error.code === 'MISSING_DEPENDENCY') {
      return res.status(503).json({ message: error.message });
    }
    const message = error && error.message ? error.message : 'Unknown error';
    console.error('Failed to compute benchmark returns:', message);
    return res.status(500).json({ message: 'Failed to compute benchmark returns', details: message });
  }
});

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

app.get('/api/investment-model-temperature', async function (req, res) {
  const rawModel = typeof req.query.model === 'string' ? req.query.model : '';
  const trimmedModel = rawModel.trim();
  if (!trimmedModel) {
    return res.status(400).json({ message: 'Query parameter "model" is required' });
  }

  const normalizedExperiment = trimmedModel.toUpperCase();
  const startDate = normalizeDateOnly(req.query.startDate) || DEFAULT_TEMPERATURE_CHART_START_DATE;
  const todayIso = new Date().toISOString().slice(0, 10);
  const endDate = normalizeDateOnly(req.query.endDate) || todayIso;

  const startTime = new Date(startDate + 'T00:00:00Z').getTime();
  const endTime = new Date(endDate + 'T00:00:00Z').getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
    return res.status(400).json({ message: 'Invalid date range specified.' });
  }

  const payload = {
    experiment: normalizedExperiment,
    start_date: startDate,
    end_date: endDate,
  };

  const baseSymbol = normalizeSymbol(req.query.symbol || req.query.baseSymbol || null);
  if (baseSymbol) {
    payload.base_symbol = baseSymbol;
  }
  const leveragedSymbol = normalizeSymbol(req.query.leveragedSymbol || null);
  if (leveragedSymbol) {
    payload.leveraged_symbol = leveragedSymbol;
  }
  const reserveSymbol = normalizeSymbol(req.query.reserveSymbol || null);
  if (reserveSymbol) {
    payload.reserve_symbol = reserveSymbol;
  }

  try {
    const response = await evaluateInvestmentModelTemperatureChart(payload);
    const normalized = normalizeTemperatureChartResponse(trimmedModel, response);
    if (!normalized.series.length) {
      return res.status(404).json({ message: 'Investment model chart unavailable' });
    }
    return res.json(normalized);
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown error';
    if (error && (error.code === 'BRIDGE_NOT_FOUND' || error.code === 'PYTHON_NOT_FOUND')) {
      return res.status(503).json({ message });
    }
    const detail = typeof message === 'string' && message.includes('\n') ? message.split('\n')[0].trim() : message;
    console.warn(
      'Failed to load investment model temperature for model ' + trimmedModel + ':',
      message
    );
    return res.status(500).json({ message: 'Failed to load investment model chart', details: detail });
  }
});

app.post('/api/accounts/:accountKey/mark-rebalanced', function (req, res) {
  const rawAccountKey = typeof req.params.accountKey === 'string' ? req.params.accountKey : '';
  const accountKey = rawAccountKey.trim();
  if (!accountKey) {
    return res.status(400).json({ message: 'Account identifier is required' });
  }

  const modelParam = req.body && typeof req.body.model === 'string' ? req.body.model.trim() : '';

  try {
    const result = updateAccountLastRebalance(accountKey, {
      model: modelParam ? modelParam : null,
    });
    return res.json({ lastRebalance: result.lastRebalance, updatedCount: result.updatedCount });
  } catch (error) {
    if (error && error.code === 'INVALID_ACCOUNT') {
      return res.status(400).json({ message: error.message });
    }
    if (error && error.code === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Account configuration not found' });
    }
    if (error && error.code === 'NO_FILE') {
      return res.status(500).json({ message: error.message });
    }
    if (error && error.code === 'PARSE_ERROR') {
      return res
        .status(500)
        .json({ message: 'Failed to parse accounts configuration file', details: error.message });
    }
    console.error('Failed to mark account as rebalanced:', error);
    return res.status(500).json({ message: 'Failed to update rebalance date' });
  }
});

app.get('/api/summary', async function (req, res) {
  const requestedAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
  const includeAllAccounts = !requestedAccountId || requestedAccountId === 'all';
  const isDefaultRequested = requestedAccountId === 'default';
  const configuredDefaultKey = getDefaultAccountId();

  try {
    const accountNameOverrides = getAccountNameOverrides();
    const accountPortalOverrides = getAccountPortalOverrides();
    const accountChatOverrides = getAccountChatOverrides();
    const configuredOrdering = getAccountOrdering();
    const accountSettings = getAccountSettings();
    const accountBeneficiaries = getAccountBeneficiaries();
    const accountCollections = await Promise.all(
      allLogins.map(async function (login) {
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
            let normalizedInvestmentModels = [];
            if (Object.prototype.hasOwnProperty.call(accountSettingsOverride, 'investmentModels')) {
              normalizedInvestmentModels = normalizeInvestmentModelList(
                accountSettingsOverride.investmentModels
              );
              if (normalizedInvestmentModels.length) {
                normalizedAccount.investmentModels = normalizedInvestmentModels;
              }
            }
            if (typeof accountSettingsOverride.investmentModel === 'string') {
              const trimmedModel = accountSettingsOverride.investmentModel.trim();
              if (trimmedModel) {
                normalizedAccount.investmentModel = trimmedModel;
              }
            } else if (normalizedInvestmentModels.length && normalizedInvestmentModels[0].model) {
              normalizedAccount.investmentModel = normalizedInvestmentModels[0].model;
            }
            if (
              normalizedAccount.rebalancePeriod === undefined &&
              normalizedInvestmentModels.length
            ) {
              const withPeriod = normalizedInvestmentModels.find((entry) => {
                return Number.isFinite(entry.rebalancePeriod);
              });
              if (withPeriod) {
                normalizedAccount.rebalancePeriod = withPeriod.rebalancePeriod;
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
            } else if (!normalizedAccount.investmentModelLastRebalance && normalizedInvestmentModels.length) {
              const withRebalance = normalizedInvestmentModels.find((entry) => entry.lastRebalance);
              if (withRebalance) {
                normalizedAccount.investmentModelLastRebalance = withRebalance.lastRebalance;
              }
            }
            if (
              typeof accountSettingsOverride.netDepositAdjustment === 'number' &&
              Number.isFinite(accountSettingsOverride.netDepositAdjustment)
            ) {
              normalizedAccount.netDepositAdjustment = accountSettingsOverride.netDepositAdjustment;
            }
            if (
              typeof accountSettingsOverride.rebalancePeriod === 'number' &&
              Number.isFinite(accountSettingsOverride.rebalancePeriod)
            ) {
              normalizedAccount.rebalancePeriod = Math.round(
                accountSettingsOverride.rebalancePeriod
              );
            }
            if (typeof accountSettingsOverride.cagrStartDate === 'string') {
              const trimmedDate = accountSettingsOverride.cagrStartDate.trim();
              if (trimmedDate) {
                normalizedAccount.cagrStartDate = trimmedDate;
              }
            } else if (
              accountSettingsOverride.cagrStartDate &&
              typeof accountSettingsOverride.cagrStartDate === 'object' &&
              typeof accountSettingsOverride.cagrStartDate.date === 'string'
            ) {
              const trimmedDate = accountSettingsOverride.cagrStartDate.date.trim();
              if (trimmedDate) {
                normalizedAccount.cagrStartDate = trimmedDate;
              }
            }
            if (
              typeof accountSettingsOverride.ignoreSittingCash === 'number' &&
              Number.isFinite(accountSettingsOverride.ignoreSittingCash)
            ) {
              normalizedAccount.ignoreSittingCash = accountSettingsOverride.ignoreSittingCash;
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
        return { login, accounts: normalized };
      })
    );

    const defaultAccount = findDefaultAccount(accountCollections, configuredDefaultKey);

    let allAccounts = accountCollections.flatMap(function (entry) {
      return entry.accounts;
    });

    allAccounts = allAccounts.map(function (account) {
      if (!account) {
        return account;
      }
      const normalizedModels = resolveAccountInvestmentModels(account);
      if (normalizedModels.length) {
        account.investmentModels = normalizedModels;
        if (!account.investmentModel && normalizedModels[0]?.model) {
          account.investmentModel = normalizedModels[0].model;
        }
        if (!account.investmentModelLastRebalance) {
          const withRebalance = normalizedModels.find((entry) => entry.lastRebalance);
          if (withRebalance) {
            account.investmentModelLastRebalance = withRebalance.lastRebalance;
          }
        }
      } else {
        account.investmentModels = [];
      }
      return account;
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
      const summary = summarizeAccountBalances(balancesResults[index]);
      if (summary) {
        perAccountCombinedBalances[context.account.id] = summary;
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
    await Promise.all(
      selectedContexts.map(async function (context) {
        const { account } = context;
        const modelsToEvaluate = resolveAccountInvestmentModels(account);
        if (!account || !modelsToEvaluate.length) {
          return;
        }

        const evaluationBucket = {};
        for (const modelConfig of modelsToEvaluate) {
          if (!modelConfig || !modelConfig.model) {
            continue;
          }

          const payload = buildInvestmentModelRequest(
            account,
            flattenedPositions,
            perAccountCombinedBalances,
            modelConfig
          );

          if (!payload || !Array.isArray(payload.positions) || payload.positions.length === 0) {
            evaluationBucket[modelConfig.model] = { status: 'no_positions' };
            continue;
          }

          try {
            const evaluation = await evaluateInvestmentModel(payload);
            evaluationBucket[modelConfig.model] = { status: 'ok', data: evaluation };
          } catch (modelError) {
            const message =
              modelError && modelError.message ? modelError.message : 'Failed to evaluate investment model.';
            console.warn(
              'Investment model evaluation failed for account ' + account.id + ' (' + modelConfig.model + '):',
              message
            );
            evaluationBucket[modelConfig.model] = { status: 'error', message };
          }
        }

        if (Object.keys(evaluationBucket).length > 0) {
          investmentModelEvaluations[account.id] = evaluationBucket;
        }
      })
    );

    const accountFundingSummaries = {};
    const accountDividendSummaries = {};
    const accountActivityContextCache = new Map();

    async function ensureAccountActivityContext(context) {
      if (!context || !context.account || !context.account.id) {
        return null;
      }
      const accountId = context.account.id;
      if (!accountActivityContextCache.has(accountId)) {
        const contextPromise = buildAccountActivityContext(context.login, context.account).catch(
          (error) => {
            accountActivityContextCache.delete(accountId);
            throw error;
          }
        );
        accountActivityContextCache.set(accountId, contextPromise);
      }
      return accountActivityContextCache.get(accountId);
    }
    if (selectedContexts.length === 1) {
      const context = selectedContexts[0];
      let sharedActivityContext = null;
      try {
        sharedActivityContext = await buildAccountActivityContext(context.login, context.account);
      } catch (activityError) {
        const activityMessage =
          activityError && activityError.message ? activityError.message : String(activityError);
        console.warn(
          'Failed to prepare activity history for account ' + context.account.id + ':',
          activityMessage
        );
      }

      try {
        const fundingSummary = await computeNetDeposits(
          context.login,
          context.account,
          perAccountCombinedBalances,
          { applyAccountCagrStartDate: true, activityContext: sharedActivityContext }
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

      try {
        const dividendSummary = await computeDividendBreakdown(context.login, context.account, {
          activityContext: sharedActivityContext,
        });
        if (dividendSummary) {
          accountDividendSummaries[context.account.id] = dividendSummary;
        }
      } catch (dividendError) {
        const message = dividendError && dividendError.message ? dividendError.message : String(dividendError);
        console.warn(
          'Failed to compute dividends for account ' + context.account.id + ':',
          message
        );
      }
    } else if (viewingAllAccounts && selectedContexts.length > 1) {
      const aggregateTotals = {
        netDepositsCad: 0,
        netDepositsCount: 0,
        totalPnlCad: 0,
        totalPnlCount: 0,
        totalEquityCad: 0,
        totalEquityCount: 0,
        cashFlowsCad: [],
        incomplete: false,
      };

      const perAccountFunding = await mapWithConcurrency(
        selectedContexts,
        MAX_AGGREGATE_FUNDING_CONCURRENCY,
        async function (context) {
          let activityContext = null;
          try {
            activityContext = await ensureAccountActivityContext(context);
          } catch (activityError) {
            const activityMessage =
              activityError && activityError.message ? activityError.message : String(activityError);
            console.warn(
              'Failed to prepare activity history for account ' + context.account.id + ':',
              activityMessage
            );
          }

          let fundingSummary = null;
          try {
            fundingSummary = await computeNetDeposits(
              context.login,
              context.account,
              perAccountCombinedBalances,
              activityContext
                ? { applyAccountCagrStartDate: false, activityContext }
                : { applyAccountCagrStartDate: false }
            );
          } catch (fundingError) {
            const message = fundingError && fundingError.message ? fundingError.message : String(fundingError);
            console.warn(
              'Failed to compute net deposits for account ' + context.account.id + ':',
              message
            );
          }

          return { context, fundingSummary };
        }
      );

      perAccountFunding.forEach(function (result) {
        const context = result && result.context;
        const fundingSummary = result && result.fundingSummary;
        if (!context || !fundingSummary) {
          return;
        }

        accountFundingSummaries[context.account.id] = fundingSummary;
        const netDepositsCad =
          fundingSummary && fundingSummary.netDeposits ? fundingSummary.netDeposits.combinedCad : null;
        if (Number.isFinite(netDepositsCad)) {
          aggregateTotals.netDepositsCad += netDepositsCad;
          aggregateTotals.netDepositsCount += 1;
        }

        const totalPnlCad =
          fundingSummary && fundingSummary.totalPnl ? fundingSummary.totalPnl.combinedCad : null;
        if (Number.isFinite(totalPnlCad)) {
          aggregateTotals.totalPnlCad += totalPnlCad;
          aggregateTotals.totalPnlCount += 1;
        }

        const totalEquityCad = fundingSummary ? fundingSummary.totalEquityCad : null;
        if (Number.isFinite(totalEquityCad)) {
          aggregateTotals.totalEquityCad += totalEquityCad;
          aggregateTotals.totalEquityCount += 1;
        }

        if (Array.isArray(fundingSummary.cashFlowsCad)) {
          fundingSummary.cashFlowsCad.forEach((entry) => {
            if (!entry || typeof entry !== 'object') {
              return;
            }
            const amount = Number(entry.amount);
            if (!Number.isFinite(amount) || Math.abs(amount) < CASH_FLOW_EPSILON) {
              return;
            }
            let isoDate = null;
            if (entry.date instanceof Date) {
              isoDate = entry.date.toISOString();
            } else if (typeof entry.date === 'string' && entry.date.trim()) {
              const parsed = new Date(entry.date);
              if (!Number.isNaN(parsed.getTime())) {
                isoDate = parsed.toISOString();
              }
            } else if (entry.timestamp instanceof Date) {
              isoDate = entry.timestamp.toISOString();
            } else if (typeof entry.timestamp === 'string' && entry.timestamp.trim()) {
              const parsedTimestamp = new Date(entry.timestamp);
              if (!Number.isNaN(parsedTimestamp.getTime())) {
                isoDate = parsedTimestamp.toISOString();
              }
            }
            if (!isoDate) {
              return;
            }
            aggregateTotals.cashFlowsCad.push({ amount, date: isoDate });
          });
        }

        if (fundingSummary.annualizedReturn && fundingSummary.annualizedReturn.incomplete) {
          aggregateTotals.incomplete = true;
        }
      });

      const aggregateEntry = {};
      if (aggregateTotals.netDepositsCount > 0) {
        aggregateEntry.netDeposits = { combinedCad: aggregateTotals.netDepositsCad };
      }
      if (aggregateTotals.totalPnlCount > 0) {
        aggregateEntry.totalPnl = { combinedCad: aggregateTotals.totalPnlCad };
      } else if (
        aggregateTotals.netDepositsCount > 0 &&
        aggregateTotals.totalEquityCount > 0 &&
        Number.isFinite(aggregateTotals.totalEquityCad)
      ) {
        const derivedTotalPnl = aggregateTotals.totalEquityCad - aggregateTotals.netDepositsCad;
        if (Number.isFinite(derivedTotalPnl)) {
          aggregateEntry.totalPnl = { combinedCad: derivedTotalPnl };
        }
      }
      if (aggregateTotals.totalEquityCount > 0) {
        aggregateEntry.totalEquityCad = aggregateTotals.totalEquityCad;
      }

      if (aggregateTotals.cashFlowsCad.length > 0) {
        const aggregateAsOf = new Date().toISOString();
        const aggregatePeriodEnd = aggregateAsOf.slice(0, 10);
        let aggregatePeriodStartDate = null;
        for (const entry of aggregateTotals.cashFlowsCad) {
          const entryDate = parseCashFlowEntryDate(entry);
          if (
            entryDate &&
            (!aggregatePeriodStartDate || entryDate < aggregatePeriodStartDate) &&
            entryDate instanceof Date &&
            !Number.isNaN(entryDate.getTime())
          ) {
            aggregatePeriodStartDate = entryDate;
          }
        }
        let formattedAggregateStart = null;
        if (aggregatePeriodStartDate) {
          formattedAggregateStart = formatDateOnly(aggregatePeriodStartDate);
        }
        if (formattedAggregateStart && aggregatePeriodEnd) {
          const startDateObj = new Date(`${formattedAggregateStart}T00:00:00Z`);
          const endDateObj = new Date(`${aggregatePeriodEnd}T00:00:00Z`);
          if (
            Number.isNaN(startDateObj.getTime()) ||
            Number.isNaN(endDateObj.getTime()) ||
            startDateObj > endDateObj
          ) {
            formattedAggregateStart = null;
          }
        }
        if (formattedAggregateStart) {
          aggregateEntry.periodStartDate = formattedAggregateStart;
        }
        if (aggregatePeriodEnd) {
          aggregateEntry.periodEndDate = aggregatePeriodEnd;
        }
        let aggregateRate = null;
        if (!aggregateTotals.incomplete) {
          const computedRate = computeAccountAnnualizedReturn(aggregateTotals.cashFlowsCad, 'all');
          if (Number.isFinite(computedRate)) {
            aggregateRate = computedRate;
          }
        }
        if (Number.isFinite(aggregateRate)) {
          aggregateEntry.annualizedReturn = {
            rate: aggregateRate,
            method: 'xirr',
            cashFlowCount: aggregateTotals.cashFlowsCad.length,
            asOf: aggregateAsOf,
            incomplete: aggregateTotals.incomplete || undefined,
          };
        } else if (aggregateTotals.incomplete) {
          aggregateEntry.annualizedReturn = {
            method: 'xirr',
            cashFlowCount: aggregateTotals.cashFlowsCad.length,
            asOf: aggregateAsOf,
            incomplete: true,
          };
        }
        const aggregateBreakdown = computeReturnBreakdownFromCashFlows(
          aggregateTotals.cashFlowsCad,
          new Date(aggregateAsOf),
          aggregateRate
        );
        if (aggregateBreakdown.length) {
          aggregateEntry.returnBreakdown = aggregateBreakdown;
        }
      }

      if (Object.keys(aggregateEntry).length > 0) {
        accountFundingSummaries.all = aggregateEntry;
      }
    }

    if (selectedContexts.length > 1) {
      for (const context of selectedContexts) {
        let activityContext = null;
        try {
          activityContext = await ensureAccountActivityContext(context);
        } catch (activityError) {
          const activityMessage =
            activityError && activityError.message ? activityError.message : String(activityError);
          console.warn(
            'Failed to prepare activity history for account ' + context.account.id + ':',
            activityMessage
          );
        }

        try {
          const dividendSummary = await computeDividendBreakdown(
            context.login,
            context.account,
            activityContext ? { activityContext } : undefined
          );
          if (dividendSummary) {
            accountDividendSummaries[context.account.id] = dividendSummary;
          }
        } catch (dividendError) {
          const message = dividendError && dividendError.message ? dividendError.message : String(dividendError);
          console.warn(
            'Failed to compute dividends for account ' + context.account.id + ':',
            message
          );
        }
      }
    }

    Object.values(accountFundingSummaries).forEach((entry) => {
      if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'cashFlowsCad')) {
        delete entry.cashFlowsCad;
      }
    });

    const responseAccounts = allAccounts.map(function (account) {
      const models = resolveAccountInvestmentModels(account);
      const serializedModels = models.map(function (entry) {
        return {
          model: entry.model,
          symbol: entry.symbol || null,
          leveragedSymbol: entry.leveragedSymbol || null,
          reserveSymbol: entry.reserveSymbol || null,
          lastRebalance: entry.lastRebalance || null,
          rebalancePeriod: Number.isFinite(entry.rebalancePeriod)
            ? Math.round(entry.rebalancePeriod)
            : null,
          title: entry.title || null,
        };
      });
      const primaryModel = models.length ? models[0] : null;
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
        investmentModel: primaryModel ? primaryModel.model : account.investmentModel || null,
        investmentModelLastRebalance:
          (primaryModel && primaryModel.lastRebalance) || account.investmentModelLastRebalance || null,
        investmentModels: serializedModels,
        rebalancePeriod: Number.isFinite(account.rebalancePeriod)
          ? Math.round(account.rebalancePeriod)
          : null,
        ignoreSittingCash:
          typeof account.ignoreSittingCash === 'number' &&
          Number.isFinite(account.ignoreSittingCash)
            ? Math.max(0, account.ignoreSittingCash)
            : null,
        isDefault: defaultAccountId ? account.id === defaultAccountId : false,
      };
    });

    // Fetch latest intraday USD→CAD rate (best-effort; non-blocking for rest of payload)
    let latestUsdToCadRate = null;
    try {
      latestUsdToCadRate = await fetchLatestUsdToCadRate();
      if (!(Number.isFinite(latestUsdToCadRate) && latestUsdToCadRate > 0)) {
        latestUsdToCadRate = null;
      }
    } catch (fxError) {
      // Intentionally non-fatal; omit field on failure
      console.warn('[FX] Failed to resolve intraday USD/CAD rate for summary:', fxError?.message || String(fxError));
      latestUsdToCadRate = null;
    }

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
      accountDividends: accountDividendSummaries,
      asOf: new Date().toISOString(),
      usdToCadRate: latestUsdToCadRate,
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ message: 'Questrade API error', details: error.response.data });
    }
    res.status(500).json({ message: 'Unexpected server error', details: error.message });
  }
});

app.get('/api/accounts/:accountKey/total-pnl-series', async function (req, res) {
  const rawAccountKey = typeof req.params.accountKey === 'string' ? req.params.accountKey.trim() : '';
  if (!rawAccountKey) {
    return res.status(400).json({ message: 'Account identifier is required' });
  }

  try {
    const resolved = await resolveAccountContextByKey(rawAccountKey);
    if (!resolved) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const { login, account } = resolved;
    const normalizedAccount = Object.assign({}, account);
    const accountId = normalizedAccount.id || normalizedAccount.number || rawAccountKey;
    normalizedAccount.id = accountId;
    normalizedAccount.number = normalizedAccount.number || rawAccountKey;

    const balancesRaw = await fetchBalances(login, normalizedAccount.number);
    const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
    const perAccountCombinedBalances = { [accountId]: balanceSummary };

    const options = {};
    if (typeof req.query.startDate === 'string' && req.query.startDate.trim()) {
      options.startDate = req.query.startDate.trim();
    }
    if (typeof req.query.endDate === 'string' && req.query.endDate.trim()) {
      options.endDate = req.query.endDate.trim();
    }
    if (req.query.applyAccountCagrStartDate === 'false' || req.query.applyAccountCagrStartDate === '0') {
      options.applyAccountCagrStartDate = false;
    }

    const series = await computeTotalPnlSeries(login, normalizedAccount, perAccountCombinedBalances, options);
    if (!series) {
      return res.status(503).json({ message: 'Total P&L series unavailable' });
    }

    return res.json(series);
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({ message: 'Questrade API error', details: error.response.data });
    }
    console.error('Failed to compute total P&L series for account ' + rawAccountKey + ':', error.message || error);
    return res.status(500).json({ message: 'Failed to compute total P&L series', details: error.message || String(error) });
  }
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log('Server listening on port ' + PORT);
  });
}

function getAllLogins() {
  return allLogins.map((login) => Object.assign({}, login));
}

function getLoginById(loginId) {
  if (!loginId) {
    return null;
  }
  return loginsById[loginId] || null;
}

function setPriceHistoryFetcherForTests(fetcher) {
  if (typeof fetcher === 'function') {
    customPriceHistoryFetcher = fetcher;
  } else {
    customPriceHistoryFetcher = null;
  }
}

module.exports = {
  app,
  computeTotalPnlSeries,
  computeNetDeposits,
  computeNetDepositsCore,
  buildAccountActivityContext,
  resolveAccountActivityContext,
  filterFundingActivities,
  dedupeActivities,
  resolveActivityAmountDetails,
  convertAmountToCad,
  resolveUsdToCadRate,
  fetchAccounts,
  fetchBalances,
  fetchPositions,
  summarizeAccountBalances,
  getAllLogins,
  getLoginById,
  __setPriceHistoryFetcherForTests: setPriceHistoryFetcherForTests,
};











