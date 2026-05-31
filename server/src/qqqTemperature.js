const fs = require('fs');
const path = require('path');
const { resolveDataPath } = require('./dataPaths');
const { cacheYahooPriceSeries, getCachedYahooPriceSeries } = require('./yahooPriceCache');
const { buildYahooFinanceFetchOptions } = require('./yahooFinanceFetchOptions');
const {
  MARKET_DATA_PROVIDER_PREFERENCE,
  buildProviderOrder,
  normalizeMarketDataProvider,
} = require('./marketDataConfig');

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

const MISSING_DEPENDENCY_MESSAGE =
  'The "yahoo-finance2" package is required to calculate QQQ temperature data. ' +
  'Run `npm install` inside the server directory to install it.';

class MissingDependencyError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MissingDependencyError';
    this.code = 'MISSING_DEPENDENCY';
    if (cause) {
      this.cause = cause;
    }
  }
}

if (!yahooFinance && yahooFinanceLoadError) {
  console.warn('[QQQ temperature] yahoo-finance2 dependency not found:', yahooFinanceLoadError.message);
  console.warn('[QQQ temperature]', MISSING_DEPENDENCY_MESSAGE);
}

const CACHE_DIR = resolveDataPath('data', 'qqq-cache');
const SUMMARY_TTL_MS = 1000 * 60 * 60 * 4; // refresh every 4 hours
const LOOKBACK_DAYS = 10;
const SERIES_COVERAGE_TOLERANCE_DAYS = 10;
const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIT_THRESHOLDS = [0.35, 0.15];
const MARKET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const TICKERS = {
  qqq: 'QQQ',
  ndx: '^NDX',
  ixic: '^IXIC',
};

const QQQ_TEMPERATURE_FIT_SOURCE = TICKERS.qqq;
const QQQ_TEMPERATURE_LONG_SERIES_SOURCE = 'IXIC_NDX_QQQ';
const QQQ_TEMPERATURE_FIT_END_DATE = '2025-01-01';

const TICKER_PROVIDER_OVERRIDES = {
  '^NDX': 'yahoo',
  '^IXIC': 'yahoo',
};

const TICKER_START = {
  QQQ: '1990-01-01',
  '^NDX': '1975-01-01',
  '^IXIC': '1970-01-01',
};

let cachedSummary = null;
let summaryExpiresAt = 0;
let pendingRefresh = null;
let lastLoggedError = null;

function daysBetweenUTC(a, b) {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return 0;
  const ms = db.getTime() - da.getTime();
  return Math.floor(ms / MS_PER_DAY);
}

function resolveProviderPreference(marketData) {
  const candidate = marketData && marketData.providerPreference ? marketData.providerPreference : null;
  return normalizeMarketDataProvider(candidate) || MARKET_DATA_PROVIDER_PREFERENCE;
}

function resolveProviderOrderForTicker(ticker, marketData) {
  const override = TICKER_PROVIDER_OVERRIDES[ticker];
  if (override) {
    return [override];
  }
  return buildProviderOrder(resolveProviderPreference(marketData));
}

function buildTickerCacheKey(ticker, provider) {
  const safeTicker = sanitizeTickerForCache(ticker);
  const safeProvider = sanitizeTickerForCache(provider || 'provider');
  return `${safeTicker}_${safeProvider}`;
}

function ensureYahooFinance() {
  if (!yahooFinance) {
    throw new MissingDependencyError(MISSING_DEPENDENCY_MESSAGE, yahooFinanceLoadError);
  }
  return yahooFinance;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function sanitizeTickerForCache(ticker) {
  return String(ticker || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'ticker';
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return new Date(value.getTime());
  }
  const str = String(value).trim();
  if (!str) {
    return null;
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(str);
  const parsed = new Date(dateOnly ? `${str}T00:00:00Z` : str);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function formatDate(date) {
  const parsed = parseDate(date);
  if (!parsed) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function formatMarketDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const parsed = parseDate(value);
  if (!parsed) {
    return null;
  }
  const parts = MARKET_DATE_FORMATTER.formatToParts(parsed).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
  return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

function addDays(date, days) {
  const parsed = parseDate(date);
  if (!parsed) {
    return null;
  }
  return new Date(parsed.getTime() + days * MS_PER_DAY);
}

function clampFraction(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function readCachedSeries(cachePath) {
  try {
    if (!fs.existsSync(cachePath)) {
      return [];
    }
    const raw = fs.readFileSync(cachePath, 'utf-8');
    if (!raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.series)) {
      return [];
    }
    return parsed.series
      .map((entry) => {
        const date = formatDate(entry && entry.date);
        const close = Number(entry && entry.close);
        if (!date || !Number.isFinite(close) || close <= 0) {
          return null;
        }
        return { date, close };
      })
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch (error) {
    logErrorOnce('Failed to read cached QQQ data', error);
    return [];
  }
}

function writeCachedSeries(cachePath, ticker, series, provider) {
  try {
    const payload = {
      ticker,
      provider: provider || null,
      updated: new Date().toISOString(),
      series,
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    logErrorOnce('Failed to persist QQQ cache', error);
  }
}

function sanitizeChartQuotes(quotes) {
  if (!Array.isArray(quotes)) {
    return [];
  }
  return quotes
    .map((entry) => {
      const date = formatDate(entry && entry.date);
      const close = Number(entry && (entry.adjclose ?? entry.close));
      if (!date || !Number.isFinite(close) || close <= 0) {
        return null;
      }
      return { date, close };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function normalizeQuestradeSeries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => {
      const date = formatDate(entry && (entry.date || entry.start || entry.time));
      const close = Number(entry && (entry.price ?? entry.close));
      if (!date || !Number.isFinite(close) || close <= 0) {
        return null;
      }
      return { date, close };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function isSeriesCoverageSufficient(series, startKey, endKey, toleranceDays = SERIES_COVERAGE_TOLERANCE_DAYS) {
  if (!Array.isArray(series) || series.length === 0) {
    return false;
  }
  const firstKey = series[0] && series[0].date ? series[0].date : null;
  const lastKey = series[series.length - 1] && series[series.length - 1].date
    ? series[series.length - 1].date
    : null;
  if (!firstKey || !lastKey || !startKey || !endKey) {
    return false;
  }
  const startGap = Math.max(0, daysBetweenUTC(startKey, firstKey));
  const endGap = Math.max(0, daysBetweenUTC(lastKey, endKey));
  return startGap <= toleranceDays && endGap <= toleranceDays;
}

function describeYahooError(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  if (error.errors && Array.isArray(error.errors) && error.errors.length) {
    const nested = error.errors.find((item) => item && item.message);
    if (nested && nested.message) {
      return nested.message;
    }
  }
  if (error.cause && error.cause instanceof Error) {
    return error.cause.message || null;
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return null;
}

async function downloadYahooTickerSlice(ticker, fetchStart, today) {
  const finance = ensureYahooFinance();
  const startKey = formatDate(fetchStart);
  const endKey = formatDate(today);
  if (startKey && endKey) {
    try {
      const cachedSeries = getCachedYahooPriceSeries(ticker, startKey, endKey);
      if (cachedSeries.hit) {
        return cachedSeries.value
          .map((entry) => {
            const date = formatDate(entry.date);
            if (!date) {
              return null;
            }
            return { date, close: entry.price };
          })
          .filter(Boolean)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
    } catch (_) {
      // ignore cache errors
    }
  }
  const options = {
    interval: '1d',
    events: 'history',
    includePrePost: false,
    return: 'array',
  };

  if (fetchStart) {
    options.period1 = fetchStart;
  }
  if (today) {
    options.period2 = today;
  }

  try {
    const result = await finance.chart(ticker, options, {
      fetchOptions: buildYahooFinanceFetchOptions(),
    });
    const container = Array.isArray(result) ? result[0] : result;
    const quotes = container && Array.isArray(container.quotes) ? container.quotes : [];
    const sanitized = sanitizeChartQuotes(quotes);
    if (sanitized.length && startKey && endKey) {
      try {
        cacheYahooPriceSeries(
          ticker,
          startKey,
          endKey,
          sanitized.map((entry) => ({ date: entry.date, price: entry.close }))
        );
      } catch (_) {
        // ignore cache write errors
      }
    }
    return sanitized;
  } catch (error) {
    const message = describeYahooError(error);
    logErrorOnce(`Failed to download historical data for ${ticker}`, message ? new Error(message) : error);
    return [];
  }
}

async function downloadQuestradeTickerSlice(ticker, fetchStart, today, marketData) {
  if (!marketData || typeof marketData.fetchQuestradeHistory !== 'function') {
    return [];
  }
  const startKey = formatDate(fetchStart);
  const endKey = formatDate(today);
  if (!startKey || !endKey) {
    return [];
  }
  let history = null;
  try {
    history = await marketData.fetchQuestradeHistory({
      symbol: ticker,
      startDate: startKey,
      endDate: endKey,
    });
  } catch (error) {
    logErrorOnce(`Failed to download Questrade data for ${ticker}`, error);
    return [];
  }
  const normalized = normalizeQuestradeSeries(history);
  if (!normalized.length) {
    return [];
  }
  if (!isSeriesCoverageSufficient(normalized, startKey, endKey)) {
    logErrorOnce(`Questrade history partial for ${ticker}`, new Error('Partial history window'));
  }
  return normalized;
}

async function downloadTickerSlice(ticker, fetchStart, today, marketData) {
  const providerOrder = resolveProviderOrderForTicker(ticker, marketData);
  for (const provider of providerOrder) {
    const normalizedProvider = normalizeMarketDataProvider(provider) || provider;
    if (normalizedProvider === 'questrade') {
      const series = await downloadQuestradeTickerSlice(ticker, fetchStart, today, marketData);
      if (series.length) {
        return series;
      }
    }
    if (normalizedProvider === 'yahoo') {
      const series = await downloadYahooTickerSlice(ticker, fetchStart, today);
      if (series.length) {
        return series;
      }
    }
  }
  return [];
}

async function loadTickerSeries(ticker, marketData) {
  ensureCacheDir();
  const providerOrder = resolveProviderOrderForTicker(ticker, marketData);
  const primaryProvider = providerOrder[0] || 'yahoo';
  const cachePath = path.join(CACHE_DIR, `${buildTickerCacheKey(ticker, primaryProvider)}.json`);
  const cachedSeries = readCachedSeries(cachePath);
  const startDate = parseDate(TICKER_START[ticker] || '1970-01-01');
  const today = new Date();
  let fetchStart = startDate;

  if (cachedSeries.length) {
    const lastDate = parseDate(cachedSeries[cachedSeries.length - 1].date);
    if (lastDate) {
      const candidate = addDays(lastDate, -LOOKBACK_DAYS);
      if (candidate && (!fetchStart || candidate > fetchStart)) {
        fetchStart = candidate;
      }
    }
  }

  if (!fetchStart) {
    fetchStart = parseDate('1970-01-01');
  }

  let mergedSeries = cachedSeries.slice();

  if (fetchStart && fetchStart <= today) {
    const fresh = await downloadTickerSlice(ticker, fetchStart, today, marketData);
    if (!fresh.length && !mergedSeries.length && fetchStart && fetchStart > startDate) {
      const fullHistory = await downloadTickerSlice(ticker, startDate, today, marketData);
      if (fullHistory.length) {
        mergedSeries = fullHistory;
        writeCachedSeries(cachePath, ticker, mergedSeries, primaryProvider);
      }
    }
    if (fresh.length) {
      const map = new Map();
      for (const entry of mergedSeries) {
        map.set(entry.date, entry.close);
      }
      for (const entry of fresh) {
        if (!startDate || parseDate(entry.date) >= startDate) {
          map.set(entry.date, entry.close);
        }
      }
      mergedSeries = Array.from(map.entries())
        .map(([date, close]) => ({ date, close }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      writeCachedSeries(cachePath, ticker, mergedSeries, primaryProvider);
    }
  }

  return mergedSeries.filter((entry) => {
    const entryDate = parseDate(entry.date);
    return entryDate && (!startDate || entryDate >= startDate);
  });
}

function findFirstOverlap(seriesA, seriesB) {
  if (!seriesA.length || !seriesB.length) {
    return null;
  }
  const datesB = new Set(seriesB.map((entry) => entry.date));
  for (const entry of seriesA) {
    if (datesB.has(entry.date)) {
      return entry.date;
    }
  }
  return null;
}

function valueOnDate(series, date) {
  if (!date) {
    return null;
  }
  for (const entry of series) {
    if (entry.date === date) {
      return entry.close;
    }
  }
  return null;
}

function buildUnifiedSeries(qqq, ndx, ixic) {
  if (!qqq.length) {
    return [];
  }

  const hasNdx = ndx && ndx.length;
  const hasIxic = ixic && ixic.length;

  if (hasNdx && hasIxic) {
    const seamQqqNdx = findFirstOverlap(qqq, ndx);
    const seamIxicNdx = findFirstOverlap(ixic, ndx);
    if (!seamQqqNdx || !seamIxicNdx) {
      return qqq.slice();
    }

    const qqqAtSeam = valueOnDate(qqq, seamQqqNdx);
    const ndxAtQqqSeam = valueOnDate(ndx, seamQqqNdx);
    const ndxAtIxicSeam = valueOnDate(ndx, seamIxicNdx);
    const ixicAtSeam = valueOnDate(ixic, seamIxicNdx);

    if (
      !Number.isFinite(qqqAtSeam) ||
      !Number.isFinite(ndxAtQqqSeam) ||
      !Number.isFinite(ndxAtIxicSeam) ||
      !Number.isFinite(ixicAtSeam)
    ) {
      return qqq.slice();
    }

    const scaleNdxToQqq = qqqAtSeam / ndxAtQqqSeam;
    const scaleIxicToNdx = (ndxAtIxicSeam * scaleNdxToQqq) / ixicAtSeam;
    const unified = [];

    for (const entry of ixic) {
      if (entry.date < seamIxicNdx) {
        unified.push({ date: entry.date, close: entry.close * scaleIxicToNdx });
      }
    }

    for (const entry of ndx) {
      if (entry.date >= seamIxicNdx && entry.date < seamQqqNdx) {
        unified.push({ date: entry.date, close: entry.close * scaleNdxToQqq });
      }
    }

    for (const entry of qqq) {
      if (entry.date >= seamQqqNdx) {
        unified.push({ date: entry.date, close: entry.close });
      }
    }

    return unified
      .filter((entry) => Number.isFinite(entry.close) && entry.close > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  if (hasNdx) {
    const seamQqqNdx = findFirstOverlap(qqq, ndx);
    if (!seamQqqNdx) {
      return qqq.slice();
    }
    const qqqAtSeam = valueOnDate(qqq, seamQqqNdx);
    const ndxAtSeam = valueOnDate(ndx, seamQqqNdx);
    if (!Number.isFinite(qqqAtSeam) || !Number.isFinite(ndxAtSeam)) {
      return qqq.slice();
    }
    const scaleNdxToQqq = qqqAtSeam / ndxAtSeam;
    const unified = [];
    for (const entry of ndx) {
      if (entry.date < seamQqqNdx) {
        unified.push({ date: entry.date, close: entry.close * scaleNdxToQqq });
      }
    }
    for (const entry of qqq) {
      if (entry.date >= seamQqqNdx) {
        unified.push({ date: entry.date, close: entry.close });
      }
    }
    return unified
      .filter((entry) => Number.isFinite(entry.close) && entry.close > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  if (hasIxic) {
    const seamQqqIxic = findFirstOverlap(qqq, ixic);
    if (!seamQqqIxic) {
      return qqq.slice();
    }
    const qqqAtSeam = valueOnDate(qqq, seamQqqIxic);
    const ixicAtSeam = valueOnDate(ixic, seamQqqIxic);
    if (!Number.isFinite(qqqAtSeam) || !Number.isFinite(ixicAtSeam)) {
      return qqq.slice();
    }
    const scaleIxicToQqq = qqqAtSeam / ixicAtSeam;
    const unified = [];
    for (const entry of ixic) {
      if (entry.date < seamQqqIxic) {
        unified.push({ date: entry.date, close: entry.close * scaleIxicToQqq });
      }
    }
    for (const entry of qqq) {
      if (entry.date >= seamQqqIxic) {
        unified.push({ date: entry.date, close: entry.close });
      }
    }
    return unified
      .filter((entry) => Number.isFinite(entry.close) && entry.close > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  return qqq
    .filter((entry) => Number.isFinite(entry.close) && entry.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function computeTimeOffsets(series) {
  if (!series.length) {
    return [];
  }
  const start = parseDate(series[0].date);
  if (!start) {
    return [];
  }
  return series.map((entry) => {
    const current = parseDate(entry.date);
    if (!current) {
      return 0;
    }
    const elapsedDays = (current - start) / MS_PER_DAY;
    return elapsedDays / DAYS_PER_YEAR;
  });
}

function fitLogLinear(tYears, prices) {
  if (!tYears.length || tYears.length !== prices.length) {
    throw new Error('Mismatched inputs for regression');
  }
  const n = tYears.length;
  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;

  for (let i = 0; i < n; i += 1) {
    const t = tYears[i];
    const price = prices[i];
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) {
      throw new Error('Invalid data for regression');
    }
    const y = Math.log(price);
    sumT += t;
    sumY += y;
    sumTT += t * t;
    sumTY += t * y;
  }

  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-12) {
    throw new Error('Degenerate regression inputs');
  }

  const slope = (n * sumTY - sumT * sumY) / denom;
  const intercept = (sumY - slope * sumT) / n;
  const A = Math.exp(intercept);
  const r = Math.exp(slope) - 1;
  return { A, r };
}

function computePredictions(A, r, tYears, prices) {
  const predictions = [];
  const relativeErrors = [];
  for (let i = 0; i < tYears.length; i += 1) {
    const t = tYears[i];
    const pred = A * Math.pow(1 + r, t);
    const price = prices[i];
    predictions.push(pred);
    if (Number.isFinite(pred) && pred !== 0) {
      relativeErrors.push(Math.abs((price - pred) / pred));
    } else {
      relativeErrors.push(Number.POSITIVE_INFINITY);
    }
  }
  return { predictions, relativeErrors };
}

function iterativeConstantGrowth(tYears, prices) {
  if (tYears.length !== prices.length || tYears.length === 0) {
    throw new Error('Invalid inputs for constant growth fit');
  }

  const { A: A1, r: r1 } = fitLogLinear(tYears, prices);
  const { relativeErrors: rel1 } = computePredictions(A1, r1, tYears, prices);

  const mask2 = rel1.map((value) => value <= FIT_THRESHOLDS[0]);
  if (!mask2.some(Boolean)) {
    throw new Error('No points remain after applying first threshold');
  }

  const filteredT2 = tYears.filter((_, index) => mask2[index]);
  const filteredP2 = prices.filter((_, index) => mask2[index]);
  const { A: A2, r: r2 } = fitLogLinear(filteredT2, filteredP2);
  const { relativeErrors: rel2 } = computePredictions(A2, r2, tYears, prices);

  const mask3 = rel2.map((value) => value <= FIT_THRESHOLDS[1]);
  if (!mask3.some(Boolean)) {
    throw new Error('No points remain after applying second threshold');
  }

  const filteredT3 = tYears.filter((_, index) => mask3[index]);
  const filteredP3 = prices.filter((_, index) => mask3[index]);
  const { A, r } = fitLogLinear(filteredT3, filteredP3);
  return { A, r };
}

function normalizeTemperatureInputSeries(series) {
  return Array.isArray(series)
    ? series
        .map((entry) => {
          const date = formatDate(entry && entry.date);
          const close = Number(entry && entry.close);
          if (!date || !Number.isFinite(close) || close <= 0) {
            return null;
          }
          return { date, close };
        })
        .filter(Boolean)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    : [];
}

function resolveFitEndDate(series, requestedFitEndDate = QQQ_TEMPERATURE_FIT_END_DATE) {
  const requested = formatDate(requestedFitEndDate);
  if (!requested || !Array.isArray(series) || !series.length) {
    return null;
  }
  let resolved = null;
  for (const entry of series) {
    if (entry.date <= requested) {
      resolved = entry.date;
    } else {
      break;
    }
  }
  return resolved;
}

function buildTemperatureSummaryFromSeries(displaySeries, fitInputSeries, options = {}) {
  const seriesInput = normalizeTemperatureInputSeries(displaySeries);
  const fitInput = normalizeTemperatureInputSeries(fitInputSeries || displaySeries);
  if (!seriesInput.length || !fitInput.length) {
    return null;
  }

  const fitEndDate = resolveFitEndDate(fitInput, options.fitEndDate);
  if (!fitEndDate) {
    return null;
  }

  const fitSeries = fitInput.filter((entry) => entry.date <= fitEndDate);
  const tYears = computeTimeOffsets(fitSeries);
  if (!tYears.length || tYears.length !== fitSeries.length) {
    return null;
  }

  let growth;
  try {
    growth = iterativeConstantGrowth(tYears, fitSeries.map((entry) => entry.close));
  } catch (error) {
    logErrorOnce('Failed to fit constant growth curve', error);
    return null;
  }

  const fitStartDate = fitSeries[0].date;
  const fitStart = parseDate(fitStartDate);
  if (!fitStart) {
    return null;
  }

  const temperatureSeries = [];
  for (const entry of seriesInput) {
    const entryDate = parseDate(entry.date);
    if (!entryDate) {
      continue;
    }
    const t = (entryDate.getTime() - fitStart.getTime()) / MS_PER_DAY / DAYS_PER_YEAR;
    const predicted = growth.A * Math.pow(1 + growth.r, t);
    const temperature = roundTemperature(entry.close / predicted);
    if (temperature === null) {
      continue;
    }
    temperatureSeries.push({ date: entry.date, temperature });
  }

  if (!temperatureSeries.length) {
    return null;
  }

  const latest = temperatureSeries[temperatureSeries.length - 1];
  return {
    updated: options.updated || new Date().toISOString(),
    rangeStart: temperatureSeries[0].date,
    rangeEnd: latest.date,
    series: temperatureSeries,
    latest,
    growthCurve: {
      A: growth.A,
      r: growth.r,
      fitStartDate,
      fitEndDate,
      fitSource: options.fitSource || QQQ_TEMPERATURE_FIT_SOURCE,
      displaySource: options.displaySource || null,
    },
  };
}

function buildTemperatureSummaryFromQqqSeries(qqqSeries, options = {}) {
  return buildTemperatureSummaryFromSeries(qqqSeries, qqqSeries, {
    ...options,
    fitSource: QQQ_TEMPERATURE_FIT_SOURCE,
    displaySource: QQQ_TEMPERATURE_FIT_SOURCE,
  });
}

function logErrorOnce(message, error) {
  if (!error) {
    return;
  }
  const signature = `${message}: ${error && error.message ? error.message : String(error)}`;
  if (signature === lastLoggedError) {
    return;
  }
  lastLoggedError = signature;
  console.warn(message + ':', error);
}

function roundTemperature(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number.parseFloat(value.toFixed(6));
}

function normalizeQuoteTimestamp(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numericString = Number(trimmed);
    if (Number.isFinite(numericString)) {
      const millis = numericString > 2_000_000_000 ? numericString : numericString * 1000;
      const parsed = new Date(millis);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const millis = numeric > 2_000_000_000 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function selectFreshestLiveQuote(quotes) {
  const validQuotes = Array.isArray(quotes)
    ? quotes.filter((quote) => quote && Number.isFinite(quote.price) && quote.price > 0)
    : [];
  if (!validQuotes.length) {
    return null;
  }
  const timestamped = validQuotes
    .map((quote, index) => ({
      quote,
      index,
      timestamp: normalizeQuoteTimestamp(quote.asOf),
    }))
    .filter((entry) => entry.timestamp);
  if (!timestamped.length) {
    return validQuotes[0];
  }
  timestamped.sort((a, b) => {
    const diff = b.timestamp.getTime() - a.timestamp.getTime();
    return diff || a.index - b.index;
  });
  return timestamped[0].quote;
}

function resolveYahooLiveQuote(quote) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }
  const candidates = [
    { value: quote.regularMarketPrice, source: 'regular', time: quote.regularMarketTime },
    { value: quote.postMarketPrice, source: 'post', time: quote.postMarketTime },
    { value: quote.preMarketPrice, source: 'pre', time: quote.preMarketTime },
  ]
    .map((entry) => ({
      value: Number(entry.value),
      source: entry.source,
      timestamp: normalizeQuoteTimestamp(entry.time),
    }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value > 0);

  if (!candidates.length) {
    return null;
  }

  const timestamped = candidates.filter((entry) => entry.timestamp);
  let resolved = null;
  if (timestamped.length) {
    timestamped.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    resolved = timestamped[0];
  } else {
    const marketState = String(quote.marketState || '').trim().toUpperCase();
    const fallbackOrder = marketState.includes('POST')
      ? ['post', 'regular', 'pre']
      : marketState.includes('PRE')
        ? ['pre', 'regular', 'post']
        : ['regular', 'post', 'pre'];
    resolved = fallbackOrder
      .map((source) => candidates.find((entry) => entry.source === source))
      .find(Boolean);
  }

  if (!resolved) {
    return null;
  }

  return {
    price: Number(resolved.value),
    asOf: resolved.timestamp ? resolved.timestamp.toISOString() : null,
    source: `yahoo-${resolved.source}`,
  };
}

async function fetchLiveQqqPrice(marketData) {
  const providerOrder = resolveProviderOrderForTicker(TICKERS.qqq, marketData);
  const quotes = [];
  for (const provider of providerOrder) {
    const normalizedProvider = normalizeMarketDataProvider(provider) || provider;
    if (normalizedProvider === 'questrade') {
      if (marketData && typeof marketData.fetchQuestradeQuote === 'function') {
        try {
          const quote = await marketData.fetchQuestradeQuote(TICKERS.qqq);
          if (quote && Number.isFinite(quote.price) && quote.price > 0) {
            quotes.push({
              price: Number(quote.price),
              asOf: quote.asOf || null,
              source: quote.source || 'questrade',
            });
          }
        } catch (error) {
          logErrorOnce('Failed to fetch Questrade live QQQ price', error);
        }
      }
      continue;
    }
    if (normalizedProvider === 'yahoo') {
      try {
        const finance = ensureYahooFinance();
        const quote = await finance.quote(TICKERS.qqq, undefined, {
          fetchOptions: buildYahooFinanceFetchOptions(),
        });
        const resolved = resolveYahooLiveQuote(quote);
        if (!resolved) {
          continue;
        }
        quotes.push(resolved);
      } catch (error) {
        logErrorOnce('Failed to fetch live QQQ price', error);
      }
    }
  }
  return selectFreshestLiveQuote(quotes);
}

function applyLiveQuoteToSummary(summary, liveQuote) {
  if (!summary || !liveQuote || !Number.isFinite(liveQuote.price) || liveQuote.price <= 0) {
    return summary;
  }
  const growth = summary.growthCurve || {};
  if (!Number.isFinite(growth.A) || !Number.isFinite(growth.r)) {
    return summary;
  }

  const series = Array.isArray(summary.series) ? summary.series.filter(Boolean) : [];
  const firstSeriesDate = series[0] && series[0].date;
  const startDate = parseDate(growth.fitStartDate || summary.rangeStart || firstSeriesDate);
  const liveDate = formatMarketDate(liveQuote.asOf) || formatMarketDate(new Date());
  const liveDateObj = parseDate(liveDate);
  if (!startDate || !liveDateObj || !liveDate) {
    return summary;
  }

  const elapsedDays = (liveDateObj.getTime() - startDate.getTime()) / MS_PER_DAY;
  const tLive = elapsedDays / DAYS_PER_YEAR;
  const predicted = Number.isFinite(tLive) ? growth.A * Math.pow(1 + growth.r, tLive) : null;
  if (!Number.isFinite(predicted) || predicted <= 0) {
    return summary;
  }

  const liveTemperature = roundTemperature(liveQuote.price / predicted);
  if (liveTemperature === null) {
    return summary;
  }

  const augmentedSeries = [...series];
  const liveEntry = { date: liveDate, temperature: liveTemperature, source: 'live' };
  const existingIndex = augmentedSeries.findIndex((entry) => entry && entry.date === liveDate);
  if (existingIndex >= 0) {
    augmentedSeries[existingIndex] = { ...augmentedSeries[existingIndex], ...liveEntry };
  } else {
    augmentedSeries.push(liveEntry);
  }
  augmentedSeries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    ...summary,
    series: augmentedSeries,
    rangeEnd: augmentedSeries[augmentedSeries.length - 1].date,
    latest: augmentedSeries[augmentedSeries.length - 1],
    livePrice: {
      value: liveQuote.price,
      asOf: liveQuote.asOf || null,
      source: liveQuote.source || 'live',
    },
  };
}

async function augmentSummaryWithLivePrice(summary, marketData) {
  const liveQuote = await fetchLiveQqqPrice(marketData);
  return applyLiveQuoteToSummary(summary, liveQuote);
}

async function refreshSummary(options = {}) {
  const includeLivePrice = Boolean(options && options.includeLivePrice);
  const marketData = options && options.marketData ? options.marketData : null;
  const requiresYahoo = [TICKERS.qqq, TICKERS.ndx, TICKERS.ixic].some((ticker) =>
    resolveProviderOrderForTicker(ticker, marketData).includes('yahoo')
  );
  if (requiresYahoo) {
    ensureYahooFinance();
  }
  const [qqqSeries, ndxSeries, ixicSeries] = await Promise.all([
    loadTickerSeries(TICKERS.qqq, marketData),
    loadTickerSeries(TICKERS.ndx, marketData),
    loadTickerSeries(TICKERS.ixic, marketData),
  ]);
  const displaySeries = buildUnifiedSeries(qqqSeries, ndxSeries, ixicSeries);
  let summary = buildTemperatureSummaryFromSeries(displaySeries, displaySeries, {
    fitSource: QQQ_TEMPERATURE_LONG_SERIES_SOURCE,
    displaySource: QQQ_TEMPERATURE_LONG_SERIES_SOURCE,
  });

  if (includeLivePrice) {
    summary = await augmentSummaryWithLivePrice(summary, marketData);
  }

  return summary;
}

async function getQqqTemperatureSummary(options = {}) {
  const forceRefresh = Boolean(options && options.forceRefresh);
  const includeLivePrice = Boolean(options && options.includeLivePrice);
  const marketData = options && options.marketData ? options.marketData : null;
  const now = Date.now();
  // If the cached summary predates today by at least one full day,
  // bypass TTL so we always pull in yesterday's close first thing.
  const todayStr = formatMarketDate(new Date()) || formatDate(new Date());
  const isCacheStaleByDate = !!(
    cachedSummary &&
    cachedSummary.rangeEnd &&
    todayStr &&
    daysBetweenUTC(cachedSummary.rangeEnd, todayStr) >= 1
  );

  const canUseCachedSummary = !!(cachedSummary && now < summaryExpiresAt && !isCacheStaleByDate);

  if (!forceRefresh && canUseCachedSummary) {
    return includeLivePrice ? augmentSummaryWithLivePrice(cachedSummary, marketData) : cachedSummary;
  }
  if (!forceRefresh && pendingRefresh) {
    if (includeLivePrice) {
      const summary = await pendingRefresh;
      return augmentSummaryWithLivePrice(summary, marketData);
    }
    return pendingRefresh;
  }

  const refreshPromise = (async () => {
    const summary = await refreshSummary({ includeLivePrice, marketData });
    if (summary) {
      cachedSummary = summary;
      summaryExpiresAt = Date.now() + SUMMARY_TTL_MS;
    } else {
      cachedSummary = null;
      summaryExpiresAt = Date.now() + SUMMARY_TTL_MS / 4;
    }
    return summary;
  })();

  pendingRefresh = refreshPromise;

  try {
    return await refreshPromise;
  } finally {
    if (pendingRefresh === refreshPromise) {
      pendingRefresh = null;
    }
  }
}

module.exports = {
  getQqqTemperatureSummary,
  __test__: {
    QQQ_TEMPERATURE_FIT_END_DATE,
    buildUnifiedSeries,
    buildTemperatureSummaryFromSeries,
    buildTemperatureSummaryFromQqqSeries,
    applyLiveQuoteToSummary,
  },
};
