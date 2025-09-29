const fs = require('fs');
const path = require('path');

let yahooFinance = null;
let yahooFinanceLoadError = null;

try {
  // yahoo-finance2 is distributed as an ESM module with a default export.
  // eslint-disable-next-line global-require
  yahooFinance = require('yahoo-finance2').default;
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

const CACHE_DIR = path.join(__dirname, '..', 'data', 'qqq-cache');
const SUMMARY_TTL_MS = 1000 * 60 * 60 * 4; // refresh every 4 hours
const LOOKBACK_DAYS = 10;
const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FIT_THRESHOLDS = [0.35, 0.15];

const TICKERS = {
  qqq: 'QQQ',
  ndx: '^NDX',
  ixic: '^IXIC',
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
  const parsed = new Date(`${str}T00:00:00Z`);
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

function writeCachedSeries(cachePath, ticker, series) {
  try {
    const payload = {
      ticker,
      updated: new Date().toISOString(),
      series,
    };
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    logErrorOnce('Failed to persist QQQ cache', error);
  }
}

function sanitizeHistoricalRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .map((row) => {
      const date = formatDate(row && row.date);
      const adjClose = Number(row && (row.adjClose ?? row.close));
      if (!date || !Number.isFinite(adjClose) || adjClose <= 0) {
        return null;
      }
      return { date, close: adjClose };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function loadTickerSeries(ticker) {
  const finance = ensureYahooFinance();
  ensureCacheDir();
  const cachePath = path.join(CACHE_DIR, `${sanitizeTickerForCache(ticker)}.json`);
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
    try {
      const results = await finance.historical(ticker, {
        period1: fetchStart,
        interval: '1d',
      });
      const fresh = sanitizeHistoricalRows(results);
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
        writeCachedSeries(cachePath, ticker, mergedSeries);
      }
    } catch (error) {
      logErrorOnce(`Failed to download historical data for ${ticker}`, error);
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
  if (!qqq.length || !ndx.length || !ixic.length) {
    return [];
  }

  const seamQqqNdx = findFirstOverlap(qqq, ndx);
  const seamIxicNdx = findFirstOverlap(ixic, ndx);
  if (!seamQqqNdx || !seamIxicNdx) {
    return [];
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
    return [];
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

function computeAllocation(temperature) {
  if (!Number.isFinite(temperature)) {
    return null;
  }

  let proportion;
  if (temperature >= 1.5) {
    proportion = 0.2;
  } else if (temperature >= 1) {
    const ratio = (temperature - 1) / 0.5;
    proportion = 0.8 - 0.6 * ratio;
  } else if (temperature > 0.9) {
    const ratio = (temperature - 0.9) / 0.1;
    proportion = 1 - 0.2 * ratio;
  } else {
    proportion = 1;
  }

  proportion = Math.max(0.2, Math.min(1, proportion));

  const exposure = 3 * proportion;
  let totalEquity = proportion;
  let tqqq = 0;
  let qqq = 0;

  if (exposure <= 1) {
    totalEquity = clampFraction(proportion * 3);
    qqq = totalEquity;
  } else if (proportion < 0.425) {
    const tqqqPortion = (exposure - 1) / 2;
    const qqqPortion = (3 - exposure) / 2;
    totalEquity = 1;
    tqqq = clampFraction(tqqqPortion);
    qqq = clampFraction(qqqPortion);
  } else {
    totalEquity = clampFraction(proportion);
    tqqq = totalEquity;
  }

  const tBills = clampFraction(1 - totalEquity);

  return {
    temperature,
    baseProportion: proportion,
    totalEquity,
    tqqq,
    qqq,
    tBills,
  };
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

async function refreshSummary() {
  ensureYahooFinance();
  const [qqqSeries, ndxSeries, ixicSeries] = await Promise.all([
    loadTickerSeries(TICKERS.qqq),
    loadTickerSeries(TICKERS.ndx),
    loadTickerSeries(TICKERS.ixic),
  ]);

  const unified = buildUnifiedSeries(qqqSeries, ndxSeries, ixicSeries);
  if (!unified.length) {
    return null;
  }

  const tYears = computeTimeOffsets(unified);
  if (!tYears.length || tYears.length !== unified.length) {
    return null;
  }

  let growth;
  try {
    growth = iterativeConstantGrowth(tYears, unified.map((entry) => entry.close));
  } catch (error) {
    logErrorOnce('Failed to fit constant growth curve', error);
    return null;
  }

  const series = [];
  for (let i = 0; i < unified.length; i += 1) {
    const entry = unified[i];
    const t = tYears[i];
    const predicted = growth.A * Math.pow(1 + growth.r, t);
    const temperature = roundTemperature(entry.close / predicted);
    if (temperature === null) {
      continue;
    }
    series.push({ date: entry.date, temperature });
  }

  if (!series.length) {
    return null;
  }

  const latest = series[series.length - 1];
  const allocation = computeAllocation(latest.temperature);

  return {
    updated: new Date().toISOString(),
    rangeStart: series[0].date,
    rangeEnd: latest.date,
    series,
    latest,
    allocation,
    growthCurve: {
      A: growth.A,
      r: growth.r,
    },
  };
}

async function getQqqTemperatureSummary() {
  const now = Date.now();
  if (cachedSummary && now < summaryExpiresAt) {
    return cachedSummary;
  }
  if (pendingRefresh) {
    return pendingRefresh;
  }

  pendingRefresh = (async () => {
    const summary = await refreshSummary();
    if (summary) {
      cachedSummary = summary;
      summaryExpiresAt = Date.now() + SUMMARY_TTL_MS;
    } else {
      cachedSummary = null;
      summaryExpiresAt = Date.now() + SUMMARY_TTL_MS / 4;
    }
    return summary;
  })();

  try {
    return await pendingRefresh;
  } finally {
    pendingRefresh = null;
  }
}

module.exports = {
  getQqqTemperatureSummary,
};
