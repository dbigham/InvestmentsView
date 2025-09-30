const MS_PER_DAY = 24 * 60 * 60 * 1000;

let yahooFinance = null;
let yahooFinanceLoadError = null;

try {
  // yahoo-finance2 is an ESM module that exposes its API via a default export.
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
  'The "yahoo-finance2" package is required to calculate account performance data. ' +
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
  console.warn('[Account performance] yahoo-finance2 dependency not found:', yahooFinanceLoadError.message);
  console.warn('[Account performance]', MISSING_DEPENDENCY_MESSAGE);
}

function ensureYahooFinance() {
  if (!yahooFinance) {
    throw new MissingDependencyError(MISSING_DEPENDENCY_MESSAGE, yahooFinanceLoadError);
  }
  return yahooFinance;
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time);
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

function parseDateTime(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
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

function buildDateRange(startDate, endDate) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || end < start) {
    return [];
  }
  const days = Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY);
  const dates = [];
  for (let i = 0; i <= days; i += 1) {
    const current = new Date(start.getTime() + i * MS_PER_DAY);
    dates.push(current.toISOString().slice(0, 10));
  }
  return dates;
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return num;
}

async function fetchHistoricalSeries(ticker, startDate, endDate) {
  const finance = ensureYahooFinance();
  const period1 = formatDate(startDate);
  const period2 = formatDate(addDays(endDate, 1));
  if (!period1 || !period2) {
    return new Map();
  }
  try {
    const quotes = await finance.historical(ticker, {
      period1,
      period2,
      interval: '1d',
    });
    const entries = Array.isArray(quotes) ? quotes : [];
    const map = new Map();
    entries.forEach((entry) => {
      const date = formatDate(entry && entry.date);
      const close = entry && (entry.adjClose ?? entry.close ?? entry.close_);
      const value = safeNumber(close, null);
      if (!date || value === null || value <= 0) {
        return;
      }
      map.set(date, value);
    });
    return map;
  } catch (error) {
    console.warn('[Account performance] Failed to fetch history for', ticker, error.message || error);
    return new Map();
  }
}

async function fetchFxSeries(currency, baseCurrency, startDate, endDate) {
  const upperCurrency = String(currency || '').toUpperCase();
  const upperBase = String(baseCurrency || '').toUpperCase();
  if (!upperCurrency || !upperBase || upperCurrency === upperBase) {
    const map = new Map();
    buildDateRange(startDate, endDate).forEach((date) => {
      map.set(date, 1);
    });
    return map;
  }
  const ticker = `${upperCurrency}${upperBase}=X`;
  const series = await fetchHistoricalSeries(ticker, startDate, endDate);
  if (!series.size) {
    // Fallback to an implied parity when no FX data is available.
    console.warn('[Account performance] Missing FX series for', upperCurrency, '→', upperBase);
    const fallback = new Map();
    buildDateRange(startDate, endDate).forEach((date) => {
      fallback.set(date, 1);
    });
    return fallback;
  }
  return series;
}

function resolveDirection(rawSide) {
  const side = String(rawSide || '').toLowerCase();
  if (!side) {
    return 0;
  }
  if (side.includes('buy') || side.includes('cover')) {
    return 1;
  }
  if (side.includes('sell') || side.includes('short')) {
    return -1;
  }
  return 0;
}

function pickFirstNumber(source, fields, fallback = null) {
  if (!source) {
    return fallback;
  }
  for (const field of fields) {
    if (!field) {
      continue;
    }
    const value = source[field];
    const numeric = safeNumber(value, null);
    if (Number.isFinite(numeric) && numeric !== null) {
      return numeric;
    }
  }
  return fallback;
}

function resolveExecutionTime(execution) {
  return (
    parseDateTime(execution && (execution.executionTime || execution.transactTime || execution.tradeDate)) ||
    parseDateTime(execution && execution.transactionTime)
  );
}

function normalizeExecution(execution) {
  const dateTime = resolveExecutionTime(execution);
  const date = formatDate(dateTime);
  if (!date) {
    return null;
  }
  const direction = resolveDirection(execution && execution.side);
  if (direction === 0) {
    return null;
  }
  const quantity = pickFirstNumber(execution, ['quantity', 'execShares', 'enteredQuantity', 'filledQuantity'], 0);
  if (quantity === 0) {
    return null;
  }
  const price = pickFirstNumber(execution, ['price', 'avgPrice', 'averagePrice', 'executionPrice'], 0);
  const gross = Math.abs(price * quantity);
  const netAmount = pickFirstNumber(
    execution,
    ['netAmount', 'netCash', 'netAmountInAccountCurrency', 'netAmountCad'],
    null
  );
  const signedContribution =
    netAmount !== null && netAmount !== 0 ? netAmount : direction > 0 ? -gross : gross;
  const amount = Math.abs(signedContribution) > 0 ? Math.abs(signedContribution) : gross;
  return {
    symbolId: execution.symbolId || execution.symbolID || execution.symbol || null,
    symbol: execution.symbol || null,
    currency: String(execution.currency || execution.payableCurrency || 'CAD').toUpperCase(),
    date,
    direction,
    quantity,
    amount,
    contribution: signedContribution,
  };
}

function normalizeSymbolMetadata(symbolDetails, execution) {
  const symbolId = execution.symbolId;
  const detail = symbolDetails && symbolId != null ? symbolDetails[symbolId] : null;
  const ticker = detail && detail.symbol ? String(detail.symbol).trim() : execution.symbol ? String(execution.symbol).trim() : null;
  const currency = detail && detail.currency ? String(detail.currency).toUpperCase() : execution.currency;
  if (!ticker) {
    return null;
  }
  return {
    symbolId,
    ticker,
    currency: currency || 'CAD',
  };
}

function buildTrades(executions, symbolDetails) {
  const trades = [];
  const metadataBySymbol = new Map();
  executions.forEach((raw) => {
    const normalized = normalizeExecution(raw);
    if (!normalized || !normalized.symbolId) {
      return;
    }
    const meta = normalizeSymbolMetadata(symbolDetails, normalized);
    if (!meta) {
      return;
    }
    metadataBySymbol.set(normalized.symbolId, meta);
    trades.push({
      symbolId: normalized.symbolId,
      date: normalized.date,
      currency: meta.currency,
      ticker: meta.ticker,
      quantityChange: normalized.direction * normalized.quantity,
      contribution:
        normalized.contribution !== null && normalized.contribution !== undefined
          ? normalized.contribution
          : normalized.direction > 0
            ? -normalized.amount
            : normalized.amount,
    });
  });
  trades.sort((a, b) => {
    if (a.date === b.date) {
      if (a.symbolId === b.symbolId) {
        return 0;
      }
      return a.symbolId < b.symbolId ? -1 : 1;
    }
    return a.date < b.date ? -1 : 1;
  });
  return { trades, metadataBySymbol };
}

function collectCurrencies(metadataBySymbol) {
  const set = new Set();
  metadataBySymbol.forEach((meta) => {
    if (meta && meta.currency) {
      set.add(String(meta.currency).toUpperCase());
    }
  });
  return Array.from(set);
}

function collectTickers(metadataBySymbol) {
  const set = new Set();
  metadataBySymbol.forEach((meta) => {
    if (meta && meta.ticker) {
      set.add(meta.ticker);
    }
  });
  return Array.from(set);
}

function buildTradesByDate(trades) {
  const map = new Map();
  trades.forEach((trade) => {
    if (!map.has(trade.date)) {
      map.set(trade.date, []);
    }
    map.get(trade.date).push(trade);
  });
  return map;
}

function buildPriceMaps(priceSeriesByTicker) {
  const map = new Map();
  Object.keys(priceSeriesByTicker).forEach((ticker) => {
    const series = priceSeriesByTicker[ticker];
    if (series instanceof Map) {
      map.set(ticker, series);
    }
  });
  return map;
}

function buildFxMaps(fxSeriesByCurrency) {
  const map = new Map();
  Object.keys(fxSeriesByCurrency).forEach((currency) => {
    const series = fxSeriesByCurrency[currency];
    if (series instanceof Map) {
      map.set(currency, series);
    }
  });
  return map;
}

function resolveFxRate(currency, date, fxMaps, lastFxRates, baseCurrency) {
  const upperCurrency = String(currency || '').toUpperCase();
  if (!upperCurrency || upperCurrency === baseCurrency) {
    return 1;
  }
  if (fxMaps.has(upperCurrency)) {
    const map = fxMaps.get(upperCurrency);
    if (map.has(date)) {
      const rate = safeNumber(map.get(date), null);
      if (rate !== null && rate > 0) {
        lastFxRates.set(upperCurrency, rate);
        return rate;
      }
    }
  }
  if (lastFxRates.has(upperCurrency)) {
    return lastFxRates.get(upperCurrency);
  }
  return 1;
}

function resolvePrice(symbolId, ticker, date, priceMaps, lastPrices) {
  if (priceMaps.has(ticker)) {
    const map = priceMaps.get(ticker);
    if (map.has(date)) {
      const price = safeNumber(map.get(date), null);
      if (price !== null && price > 0) {
        lastPrices.set(symbolId, price);
        return price;
      }
    }
  }
  if (lastPrices.has(symbolId)) {
    return lastPrices.get(symbolId);
  }
  return null;
}

function roundValue(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function buildTimeline({
  trades,
  metadataBySymbol,
  priceMaps,
  fxMaps,
  startDate,
  endDate,
  baseCurrency,
}) {
  const dates = buildDateRange(startDate, endDate);
  if (!dates.length) {
    return { timeline: [], warnings: [] };
  }
  const tradesByDate = buildTradesByDate(trades);
  const holdings = new Map();
  const lastPrices = new Map();
  const lastFxRates = new Map();
  const warnings = new Set();
  const timeline = [];

  metadataBySymbol.forEach((meta) => {
    if (meta && meta.currency && meta.currency.toUpperCase() === baseCurrency) {
      lastFxRates.set(meta.currency.toUpperCase(), 1);
    }
  });

  dates.forEach((date) => {
    // Refresh FX rates with any data for the current date.
    fxMaps.forEach((series, currency) => {
      if (currency === baseCurrency) {
        lastFxRates.set(currency, 1);
        return;
      }
      if (series.has(date)) {
        const rate = safeNumber(series.get(date), null);
        if (rate !== null && rate > 0) {
          lastFxRates.set(currency, rate);
        }
      }
    });

    // Refresh prices for the current date.
    metadataBySymbol.forEach((meta, symbolId) => {
      const price = resolvePrice(symbolId, meta.ticker, date, priceMaps, lastPrices);
      if (price !== null) {
        lastPrices.set(symbolId, price);
      }
    });

    const tradesForDate = tradesByDate.get(date) || [];
    let netContributionBase = 0;

    tradesForDate.forEach((trade) => {
      const currentQuantity = holdings.get(trade.symbolId) || 0;
      const nextQuantity = currentQuantity + trade.quantityChange;
      if (Math.abs(nextQuantity) < 1e-8) {
        holdings.delete(trade.symbolId);
      } else {
        holdings.set(trade.symbolId, nextQuantity);
      }
      const fxRate = resolveFxRate(trade.currency, date, fxMaps, lastFxRates, baseCurrency);
      netContributionBase += trade.contribution * fxRate;
    });

    let portfolioValue = 0;
    holdings.forEach((quantity, symbolId) => {
      const meta = metadataBySymbol.get(symbolId);
      if (!meta) {
        return;
      }
      const price = lastPrices.get(symbolId);
      if (price === undefined || price === null) {
        warnings.add(`Missing price history for ${meta.ticker}`);
        return;
      }
      const fxRate = resolveFxRate(meta.currency, date, fxMaps, lastFxRates, baseCurrency);
      portfolioValue += quantity * price * fxRate;
    });

    timeline.push({
      date,
      value: roundValue(portfolioValue),
      netFlows: roundValue(netContributionBase),
    });
  });

  return { timeline, warnings: Array.from(warnings) };
}

async function computeAccountPerformance({
  executions,
  symbolDetails,
  baseCurrency = 'CAD',
  endDate = new Date(),
}) {
  if (!Array.isArray(executions) || executions.length === 0) {
    return {
      baseCurrency,
      timeline: [],
      startDate: null,
      endDate: null,
      warnings: [],
    };
  }

  const { trades, metadataBySymbol } = buildTrades(executions, symbolDetails);
  if (!trades.length || metadataBySymbol.size === 0) {
    return {
      baseCurrency,
      timeline: [],
      startDate: null,
      endDate: null,
      warnings: ['No executable trades with recognizable symbols were found.'],
    };
  }

  const firstTradeDate = trades[0].date;
  const startDate = formatDate(addDays(firstTradeDate, -1));
  const normalizedEndDate = formatDate(endDate) || trades[trades.length - 1].date;

  const tickers = collectTickers(metadataBySymbol);
  const currencies = collectCurrencies(metadataBySymbol);

  const priceSeriesByTicker = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const ticker of tickers) {
    // eslint-disable-next-line no-await-in-loop
    priceSeriesByTicker[ticker] = await fetchHistoricalSeries(ticker, startDate, normalizedEndDate);
  }

  const fxSeriesByCurrency = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const currency of currencies) {
    // eslint-disable-next-line no-await-in-loop
    fxSeriesByCurrency[currency] = await fetchFxSeries(currency, baseCurrency, startDate, normalizedEndDate);
  }

  const priceMaps = buildPriceMaps(priceSeriesByTicker);
  const fxMaps = buildFxMaps(fxSeriesByCurrency);

  const { timeline, warnings } = buildTimeline({
    trades,
    metadataBySymbol,
    priceMaps,
    fxMaps,
    startDate,
    endDate: normalizedEndDate,
    baseCurrency,
  });

  return {
    baseCurrency,
    timeline,
    startDate,
    endDate: normalizedEndDate,
    warnings,
  };
}

module.exports = {
  computeAccountPerformance,
  MissingDependencyError,
};
