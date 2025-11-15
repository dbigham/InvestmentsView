const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const NodeCache = require('node-cache');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { request: undiciRequest, Agent: UndiciAgent, ProxyAgent: UndiciProxyAgent } = require('undici');
const util = require('util');
const { getProxyForUrl } = require('proxy-from-env');
const dotenv = require('dotenv');
dotenv.config();

const serverEnvPath = path.join(__dirname, '..', '.env');
const additionalEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'server.env'),
  serverEnvPath,
  path.join(__dirname, '..', 'server.env'),
];

const loadedEnvPaths = new Set();
additionalEnvPaths.forEach((candidate) => {
  try {
    if (!candidate || loadedEnvPaths.has(candidate)) {
      return;
    }
    if (!fs.existsSync(candidate)) {
      return;
    }
    // Ensure server/.env can override any pre-set env vars so toggles like
    // DEBUG_QUESTRADE_API=false always take effect when running the server.
    const shouldOverride = candidate === serverEnvPath;
    dotenv.config({ path: candidate, override: shouldOverride });
    loadedEnvPaths.add(candidate);
  } catch (envError) {
    if (envError && envError.code !== 'ENOENT') {
      console.warn('Failed to load environment file', candidate, envError.message || envError);
    }
  }
});

const accountNamesModule = require('./accountNames');
const {
  getAccountNameOverrides,
  getAccountPortalOverrides,
  getAccountChatOverrides,
  getAccountOrdering,
  getAccountSettings,
  getDefaultAccountId,
  updateAccountLastRebalance,
  updateAccountTargetProportions,
  updateAccountSymbolNote,
  updateAccountPlanningContext,
  extractSymbolSettingsFromOverride,
  getAccountGroupRelations,
  getAccountGroupMetadata,
  updateAccountMetadata,
} = require('./accountNames');
const { assignAccountGroups, slugifyAccountGroupKey } = require('./grouping');
const { getAccountBeneficiaries } = require('./accountBeneficiaries');
const { getQqqTemperatureSummary } = require('./qqqTemperature');
const { evaluateInvestmentModel, evaluateInvestmentModelTemperatureChart } = require('./investmentModel');
const deploymentDisplay = require('../../shared/deploymentDisplay.cjs');
const {
  CASH_FLOW_EPSILON,
  DAY_IN_MS,
  normalizeCashFlowsForXirr,
  computeAnnualizedReturnFromCashFlows,
} = require('./xirr');

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return defaultValue;
    }
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }
    if (['1', 'true', 'yes', 'on', 'y', 't'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off', 'n', 'f'].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

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
const DEBUG_QUESTRADE_API = parseBooleanEnv(process.env.DEBUG_QUESTRADE_API, false);
const DEBUG_API_REQUESTS = parseBooleanEnv(process.env.DEBUG_API_REQUESTS, false);
const DEBUG_QUESTRADE_REFRESH = parseBooleanEnv(process.env.DEBUG_QUESTRADE_REFRESH, false);
// Shorter HTTP timeouts so requests fail fast instead of hanging for minutes.
// Adjustable via env if needed.
const HTTP_HEADERS_TIMEOUT_MS = (() => {
  const v = Number(process.env.HTTP_HEADERS_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 15_000; // default 15s
})();
const HTTP_BODY_TIMEOUT_MS = (() => {
  const v = Number(process.env.HTTP_BODY_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60_000; // default 60s
})();
const RESERVE_SYMBOL_SET = new Set(Array.isArray(deploymentDisplay?.RESERVE_SYMBOLS)
  ? deploymentDisplay.RESERVE_SYMBOLS.map((symbol) =>
      typeof symbol === 'string' ? symbol.trim().toUpperCase() : ''
    ).filter(Boolean)
  : []);
const tokenCache = new NodeCache();
const portfolioNewsCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 120 });
const tokenFilePath = path.join(__dirname, '..', 'token-store.json');
const QUESTRADE_API_MAX_ATTEMPTS = 4;
const QUESTRADE_API_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const QUESTRADE_API_RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT',
]);

const OPENAI_API_KEY = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY.trim() : '';
// Default model for Responses API + web_search. Override via OPENAI_NEWS_MODEL.
const OPENAI_NEWS_MODEL = process.env.OPENAI_NEWS_MODEL || 'gpt-5';
const OPENAI_NEWS_FALLBACK_MODEL = process.env.OPENAI_NEWS_FALLBACK_MODEL || 'gpt-4o-mini';
// Pricing (USD per 1M tokens) for common models; can be overridden via env vars
// OPENAI_NEWS_INPUT_PRICE_PER_MTOKEN and OPENAI_NEWS_OUTPUT_PRICE_PER_MTOKEN
const MODEL_PRICING_PER_MTOK = {
  'o4-mini': { input: 1.1, output: 4.4 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 5.0, output: 15.0 },
  'gpt-4.1-mini': { input: 0.3, output: 1.2 },
  // GPT‑5 family (from provided pricing screenshot). Override via env to customize.
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-pro': { input: 15.0, output: 120.0 },
};

const SUMMARY_CACHE_TTL_MS = (() => {
  const value = Number(process.env.SUMMARY_CACHE_TTL_MS);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  const minutes = Number(process.env.SUMMARY_CACHE_TTL_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.round(minutes * 60 * 1000);
  }
  return 2 * 60 * 1000; // default 2 minutes
})();

const TOTAL_PNL_SERIES_CACHE_TTL_MS = (() => {
  const value = Number(process.env.TOTAL_PNL_SERIES_CACHE_TTL_MS);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  const minutes = Number(process.env.TOTAL_PNL_SERIES_CACHE_TTL_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.round(minutes * 60 * 1000);
  }
  return 5 * 60 * 1000; // default 5 minutes
})();

const DEBUG_SUMMARY_CACHE = parseBooleanEnv(process.env.DEBUG_SUMMARY_CACHE, false);
const DEBUG_YAHOO_PEG = parseBooleanEnv(process.env.DEBUG_YAHOO_PEG, false);
if (DEBUG_YAHOO_PEG) {
  console.log('[peg-debug] Yahoo PEG ratio debugging enabled');
}
// Max valid JS Date timestamp in ms is ±8.64e15; use slightly below as a pinned expiry
const PINNED_EXPIRY_MS = 8_640_000_000_000_000 - 1;
const PREHEAT_GROUP_TOTAL_PNL = parseBooleanEnv(process.env.PREHEAT_GROUP_TOTAL_PNL, false);
const PREHEAT_ACCOUNT_TOTAL_PNL = parseBooleanEnv(process.env.PREHEAT_ACCOUNT_TOTAL_PNL, false);
const PREHEAT_MAX_CONCURRENCY = (() => {
  const v = Number(process.env.PREHEAT_MAX_CONCURRENCY);
  if (Number.isFinite(v) && v > 0) return v;
  // Reasonable default: modest concurrency to avoid overwhelming APIs
  return 4;
})();

if (DEBUG_SUMMARY_CACHE) {
  const sources = Array.from(loadedEnvPaths);
  const suffix = sources.length ? ` (env sources: ${sources.join(', ')})` : '';
  console.log(`[summary-cache] debug logging enabled${suffix}`);
} else {
  console.log(
    '[summary-cache] debug logging disabled. Set DEBUG_SUMMARY_CACHE=true in server/.env (or export it) before starting the server to enable diagnostics.'
  );
}

const summaryCacheStore = new Map();
let supersetSummaryCache = null;
const totalPnlSeriesCacheStore = new Map();
const RANGE_BREAKDOWN_CACHE_TTL_MS = 60 * 1000;
const rangeBreakdownCache = new Map();
// Cache for Questrade candle lookups to avoid duplicate provider calls for identical ranges
const questradeCandleCache = new Map();
// Track the current client-driven refresh key to support manual cache invalidation
let activeRefreshKey = null;

function nowMs() {
  return Date.now();
}

function debugSummaryCache(message, ...args) {
  if (!DEBUG_SUMMARY_CACHE) {
    return;
  }
  try {
    console.log('[summary-cache]', message, ...args);
  } catch (error) {
    console.warn('[summary-cache] failed to log message:', error);
  }
}

function formatExpiryIso(ms) {
  try {
    const d = new Date(ms);
    const t = d.getTime();
    if (!Number.isFinite(t)) {
      return 'pinned';
    }
    return d.toISOString();
  } catch {
    return 'pinned';
  }
}

function buildTotalPnlSeriesCacheKey(accountKey, params = {}) {
  const normalizedKey = typeof accountKey === 'string' ? accountKey.trim().toLowerCase() : '';
  if (!normalizedKey) {
    return null;
  }
  const applyCagr = params.applyAccountCagrStartDate !== false;
  const parts = [normalizedKey, applyCagr ? 'cagr' : 'all'];
  const startDate = typeof params.startDate === 'string' ? params.startDate.trim() : '';
  if (startDate) {
    parts.push(`start:${startDate}`);
  }
  const endDate = typeof params.endDate === 'string' ? params.endDate.trim() : '';
  if (endDate) {
    parts.push(`end:${endDate}`);
  }
  const symbol = typeof params.symbol === 'string' ? params.symbol.trim().toUpperCase() : '';
  if (symbol) {
    parts.push(`symbol:${symbol}`);
  }
  const rk = params && params.refreshKey !== undefined && params.refreshKey !== null ? String(params.refreshKey) : '';
  if (rk) {
    parts.unshift(`rk:${rk}`);
  }
  return parts.join('|');
}

function getTotalPnlSeriesCacheEntry(cacheKey) {
  if (!cacheKey) {
    return null;
  }
  const entry = totalPnlSeriesCacheStore.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    totalPnlSeriesCacheStore.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setTotalPnlSeriesCacheEntry(cacheKey, data) {
  if (!cacheKey || !data) {
    return;
  }
  const pinned = typeof cacheKey === 'string' && cacheKey.startsWith('rk:');
  totalPnlSeriesCacheStore.set(cacheKey, {
    data,
    expiresAt: pinned ? PINNED_EXPIRY_MS : Date.now() + TOTAL_PNL_SERIES_CACHE_TTL_MS,
  });
}

function ensureAccountTotalPnlSeriesEntry(map, accountId) {
  if (!map || !accountId) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(map, accountId) || !map[accountId] || typeof map[accountId] !== 'object') {
    map[accountId] = {};
  }
  return map[accountId];
}

function setAccountTotalPnlSeries(map, accountId, mode, series) {
  const entry = ensureAccountTotalPnlSeriesEntry(map, accountId);
  if (!entry || !series) {
    return;
  }
  entry[mode] = series;
}

async function computeAggregateTotalPnlSeriesForContexts(
  targetContexts,
  perAccountCombinedBalances,
  options = {},
  outputAccountId = 'all',
  hadAccountFetchFailure = false,
  resolveActivityContext /* optional: (context) => Promise<ActivityContext>|ActivityContext|null */
) {
  if (!Array.isArray(targetContexts) || !targetContexts.length) {
    return null;
  }
  const symbolParam = typeof options.symbol === 'string' && options.symbol.trim() ? options.symbol.trim() : null;
  const seriesResults = await mapWithConcurrency(
    targetContexts,
    MAX_AGGREGATE_FUNDING_CONCURRENCY,
    async function (context) {
      try {
        const cacheKey = buildTotalPnlSeriesCacheKey(context.account.id, options);
        const cached = cacheKey ? getTotalPnlSeriesCacheEntry(cacheKey) : null;
        if (cached) {
          return { context, series: cached };
        }
        let activityContext = null;
        if (typeof resolveActivityContext === 'function') {
          try {
            activityContext = await resolveActivityContext(context);
          } catch (ctxErr) {
            // ignore; fall back to internal resolution
            activityContext = null;
          }
        }
        const baseOptions = activityContext ? { ...options, activityContext } : { ...options };
        // If caller supplied a positions map, pass per-account positions downward to avoid refetch
        try {
          const positionsMap = options && options.positionsByAccountId ? options.positionsByAccountId : null;
          if (positionsMap) {
            const accountId = context && context.account && context.account.id;
            let providedPositions = null;
            if (accountId && positionsMap instanceof Map) {
              providedPositions = positionsMap.get(accountId) || null;
            } else if (accountId && typeof positionsMap === 'object') {
              providedPositions = positionsMap[accountId] || null;
            }
            if (Array.isArray(providedPositions)) {
              baseOptions.providedPositions = providedPositions;
            }
          }
        } catch (_) {
          // non-fatal: proceed without provided positions
        }
        const series = symbolParam
          ? await computeTotalPnlSeriesForSymbol(
              context.login,
              context.account,
              perAccountCombinedBalances,
              {
                ...baseOptions,
                symbol: symbolParam,
              }
            )
          : await computeTotalPnlSeries(
              context.login,
              context.account,
              perAccountCombinedBalances,
              baseOptions
            );
        if (series && cacheKey) {
          setTotalPnlSeriesCacheEntry(cacheKey, series);
        }
        return { context, series };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        console.warn(
          'Failed to compute total P&L series for account ' + context.account.id + ' in aggregate view:',
          message
        );
        return { context, error };
      }
    }
  );

  const successfulSeries = seriesResults.filter((result) => result && result.series);
  if (!successfulSeries.length) {
    return null;
  }

  const totalsByDate = new Map();
  const aggregatedIssues = new Set();
  const aggregatedMissingSymbols = new Set();
  const summaryTotals = {
    totalPnlCad: 0,
    totalPnlAllTimeCad: 0,
    netDepositsCad: 0,
    netDepositsAllTimeCad: 0,
    totalEquityCad: 0,
    reserveValueCad: 0,
    deployedValueCad: 0,
  };
  const summaryCounts = {
    totalPnlCad: 0,
    totalPnlAllTimeCad: 0,
    netDepositsCad: 0,
    netDepositsAllTimeCad: 0,
    totalEquityCad: 0,
    reserveValueCad: 0,
    deployedValueCad: 0,
  };
  let aggregatedStart = null;
  let aggregatedEnd = null;

  successfulSeries.forEach(({ series }) => {
    if (!series) {
      return;
    }
    if (typeof series.periodStartDate === 'string' && series.periodStartDate) {
      if (!aggregatedStart || series.periodStartDate < aggregatedStart) {
        aggregatedStart = series.periodStartDate;
      }
    }
    if (typeof series.periodEndDate === 'string' && series.periodEndDate) {
      if (!aggregatedEnd || series.periodEndDate > aggregatedEnd) {
        aggregatedEnd = series.periodEndDate;
      }
    }

    if (Array.isArray(series.issues)) {
      series.issues.forEach((issue) => {
        if (typeof issue === 'string' && issue.trim()) {
          aggregatedIssues.add(issue.trim());
        }
      });
    }
    if (Array.isArray(series.missingPriceSymbols)) {
      series.missingPriceSymbols.forEach((symbol) => {
        if (typeof symbol === 'string' && symbol.trim()) {
          aggregatedMissingSymbols.add(symbol.trim());
        }
      });
    }

    if (Array.isArray(series.points)) {
      series.points.forEach((point) => {
        const dateKey = point && typeof point.date === 'string' ? point.date : null;
        if (!dateKey) {
          return;
        }
        let bucket = totalsByDate.get(dateKey);
        if (!bucket) {
          bucket = {
            date: dateKey,
            equity: 0,
            equityCount: 0,
            deposits: 0,
            depositsCount: 0,
            pnl: 0,
            pnlCount: 0,
            reserve: 0,
            reserveCount: 0,
            deployed: 0,
            deployedCount: 0,
          };
          totalsByDate.set(dateKey, bucket);
        }
        const equity = Number(point.equityCad);
        if (Number.isFinite(equity)) {
          bucket.equity += equity;
          bucket.equityCount += 1;
        }
        const deposits = Number(point.cumulativeNetDepositsCad);
        if (Number.isFinite(deposits)) {
          bucket.deposits += deposits;
          bucket.depositsCount += 1;
        }
        const pnl = Number(point.totalPnlCad);
        if (Number.isFinite(pnl)) {
          bucket.pnl += pnl;
          bucket.pnlCount += 1;
        }
        const reserveValue = point && Number.isFinite(point.reserveValueCad) ? point.reserveValueCad : null;
        if (Number.isFinite(reserveValue)) {
          bucket.reserve += reserveValue;
          bucket.reserveCount += 1;
        }
        const deployedValue = point && Number.isFinite(point.deployedValueCad) ? point.deployedValueCad : null;
        if (Number.isFinite(deployedValue)) {
          bucket.deployed += deployedValue;
          bucket.deployedCount += 1;
        }
      });
    }

    const { summary } = series;
    if (summary && typeof summary === 'object') {
      if (Number.isFinite(summary.totalPnlCad)) {
        summaryTotals.totalPnlCad += summary.totalPnlCad;
        summaryCounts.totalPnlCad += 1;
      }
      if (Number.isFinite(summary.totalPnlAllTimeCad)) {
        summaryTotals.totalPnlAllTimeCad += summary.totalPnlAllTimeCad;
        summaryCounts.totalPnlAllTimeCad += 1;
      }
      if (Number.isFinite(summary.netDepositsCad)) {
        summaryTotals.netDepositsCad += summary.netDepositsCad;
        summaryCounts.netDepositsCad += 1;
      }
      if (Number.isFinite(summary.netDepositsAllTimeCad)) {
        summaryTotals.netDepositsAllTimeCad += summary.netDepositsAllTimeCad;
        summaryCounts.netDepositsAllTimeCad += 1;
      }
      if (Number.isFinite(summary.totalEquityCad)) {
        summaryTotals.totalEquityCad += summary.totalEquityCad;
        summaryCounts.totalEquityCad += 1;
      }
      if (Number.isFinite(summary.reserveValueCad)) {
        summaryTotals.reserveValueCad += summary.reserveValueCad;
        summaryCounts.reserveValueCad += 1;
      }
      if (Number.isFinite(summary.deployedValueCad)) {
        summaryTotals.deployedValueCad += summary.deployedValueCad;
        summaryCounts.deployedValueCad += 1;
      }
    }
  });

  if (successfulSeries.length !== targetContexts.length || hadAccountFetchFailure) {
    aggregatedIssues.add('aggregate-partial-data');
  }

  const sortedDates = Array.from(totalsByDate.keys()).sort();
  const combinedPoints = sortedDates
    .map((dateKey) => {
      const bucket = totalsByDate.get(dateKey);
      return {
        date: dateKey,
        equityCad: bucket && bucket.equityCount > 0 ? bucket.equity : undefined,
        cumulativeNetDepositsCad: bucket && bucket.depositsCount > 0 ? bucket.deposits : undefined,
        totalPnlCad: bucket && bucket.pnlCount > 0 ? bucket.pnl : undefined,
        reserveValueCad: bucket && bucket.reserveCount > 0 ? bucket.reserve : undefined,
        deployedValueCad: bucket && bucket.deployedCount > 0 ? bucket.deployed : undefined,
        deployedPercent:
          bucket &&
          bucket.deployedCount > 0 &&
          bucket.equityCount > 0 &&
          Number.isFinite(bucket.deployed) &&
          Number.isFinite(bucket.equity) &&
          Math.abs(bucket.equity) > 0.00001
            ? (bucket.deployed / bucket.equity) * 100
            : undefined,
        reservePercent:
          bucket &&
          bucket.reserveCount > 0 &&
          bucket.equityCount > 0 &&
          Number.isFinite(bucket.reserve) &&
          Number.isFinite(bucket.equity) &&
          Math.abs(bucket.equity) > 0.00001
            ? (bucket.reserve / bucket.equity) * 100
            : undefined,
      };
    })
    .filter((point) => point && Number.isFinite(point.totalPnlCad));

  if (!combinedPoints.length) {
    return null;
  }

  const summaryPayload = {
    totalPnlCad: summaryCounts.totalPnlCad > 0 ? summaryTotals.totalPnlCad : null,
    totalPnlAllTimeCad:
      summaryCounts.totalPnlAllTimeCad > 0
        ? summaryTotals.totalPnlAllTimeCad
        : summaryCounts.totalPnlCad > 0
          ? summaryTotals.totalPnlCad
          : null,
    netDepositsCad: summaryCounts.netDepositsCad > 0 ? summaryTotals.netDepositsCad : null,
    netDepositsAllTimeCad:
      summaryCounts.netDepositsAllTimeCad > 0
        ? summaryTotals.netDepositsAllTimeCad
        : summaryCounts.netDepositsCad > 0
          ? summaryTotals.netDepositsCad
          : null,
    totalEquityCad: summaryCounts.totalEquityCad > 0 ? summaryTotals.totalEquityCad : null,
    reserveValueCad: summaryCounts.reserveValueCad > 0 ? summaryTotals.reserveValueCad : null,
    deployedValueCad: summaryCounts.deployedValueCad > 0 ? summaryTotals.deployedValueCad : null,
  };

  if (
    Number.isFinite(summaryPayload.deployedValueCad) &&
    Number.isFinite(summaryPayload.totalEquityCad) &&
    Math.abs(summaryPayload.totalEquityCad) > 0.00001
  ) {
    summaryPayload.deployedPercent = (summaryPayload.deployedValueCad / summaryPayload.totalEquityCad) * 100;
  }

  const payload = {
    accountId: outputAccountId,
    periodStartDate: aggregatedStart || combinedPoints[0].date,
    periodEndDate: aggregatedEnd || combinedPoints[combinedPoints.length - 1].date,
    points: combinedPoints,
    summary: summaryPayload,
  };

  if (aggregatedIssues.size) {
    payload.issues = Array.from(aggregatedIssues);
  }
  if (aggregatedMissingSymbols.size) {
    payload.missingPriceSymbols = Array.from(aggregatedMissingSymbols);
  }

  return payload;
}

function normalizeSummaryRequestKey(rawAccountId) {
  const trimmed = typeof rawAccountId === 'string' ? rawAccountId.trim() : '';
  if (!trimmed || trimmed.toLowerCase() === 'all') {
    return {
      cacheKey: 'all',
      type: 'all',
      requestedId: trimmed || 'all',
      originalRequestedId: trimmed || null,
    };
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'default') {
    return {
      cacheKey: 'default',
      type: 'default',
      requestedId: trimmed,
      originalRequestedId: trimmed,
    };
  }
  if (lower.startsWith('group:')) {
    return {
      cacheKey: lower,
      type: 'group',
      requestedId: trimmed,
      groupId: trimmed,
      groupCacheKey: lower,
      originalRequestedId: trimmed,
    };
  }
  return {
    cacheKey: trimmed,
    type: 'account',
    requestedId: trimmed,
    originalRequestedId: trimmed,
  };
}

function pruneSummaryCache() {
  const now = nowMs();
  for (const [key, entry] of summaryCacheStore.entries()) {
    if (!entry || entry.expiresAt <= now) {
      summaryCacheStore.delete(key);
    }
  }
  if (supersetSummaryCache && supersetSummaryCache.expiresAt <= now) {
    supersetSummaryCache = null;
  }
}

function getSummaryCacheEntry(cacheKey) {
  pruneSummaryCache();
  const entry = summaryCacheStore.get(cacheKey);
  if (!entry) {
    return null;
  }
  return entry;
}

function setSummaryCacheEntry(cacheKey, payload, metadata = {}) {
  if (!cacheKey) {
    return;
  }
  const timestamp = nowMs();
  const pinned = metadata && metadata.cacheScope && metadata.cacheScope.pinned === true;
  const entry = {
    payload,
    metadata,
    timestamp,
    expiresAt: pinned ? PINNED_EXPIRY_MS : timestamp + SUMMARY_CACHE_TTL_MS,
  };
  summaryCacheStore.set(cacheKey, entry);
  try {
    const expiresAtIso = formatExpiryIso(entry.expiresAt);
    debugSummaryCache('cache stored', cacheKey, { expiresAt: expiresAtIso, metadata });
  } catch {
    // ignore logging errors
  }
  return entry;
}

function clearSummaryCache() {
  summaryCacheStore.clear();
}

function pruneRangeBreakdownCache() {
  const now = nowMs();
  for (const [key, entry] of rangeBreakdownCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      rangeBreakdownCache.delete(key);
    }
  }
}

function buildRangeBreakdownCacheKey(scopeKey, startDate, endDate) {
  const scope = typeof scopeKey === 'string' ? scopeKey.trim().toLowerCase() : '';
  if (!scope) {
    return null;
  }
  const normalizedStart = typeof startDate === 'string' ? startDate.trim() : '';
  const normalizedEnd = typeof endDate === 'string' ? endDate.trim() : '';
  if (!normalizedStart || !normalizedEnd) {
    return null;
  }
  return [scope, normalizedStart, normalizedEnd].join('|');
}

function getRangeBreakdownCacheEntry(key) {
  if (!key) {
    return null;
  }
  pruneRangeBreakdownCache();
  const entry = rangeBreakdownCache.get(key);
  if (!entry) {
    return null;
  }
  return entry.payload;
}

function setRangeBreakdownCacheEntry(key, payload) {
  if (!key) {
    return;
  }
  const expiresAt = nowMs() + RANGE_BREAKDOWN_CACHE_TTL_MS;
  rangeBreakdownCache.set(key, { payload, expiresAt });
}

function getSupersetCacheEntry() {
  pruneSummaryCache();
  return supersetSummaryCache;
}

function setSupersetCacheEntry(entry) {
  if (!entry) {
    supersetSummaryCache = null;
    return;
  }
  supersetSummaryCache = entry;
  try {
    const expiresAtIso = formatExpiryIso(entry.expiresAt);
    debugSummaryCache('superset cache stored', {
      expiresAt: expiresAtIso,
      accounts: Array.isArray(entry.allAccountIds) ? entry.allAccountIds.length : 0,
    });
  } catch {
    // ignore logging errors
  }
}

function registerGroupLookupKey(lookupMap, rawKey, groupId) {
  if (!lookupMap || !rawKey || !groupId) {
    return;
  }
  const key = typeof rawKey === 'string' ? rawKey.trim() : String(rawKey || '');
  if (!key) {
    return;
  }
  const id = typeof groupId === 'string' ? groupId : String(groupId || '');
  if (!id) {
    return;
  }
  if (!lookupMap.has(key)) {
    lookupMap.set(key, id);
  }
  const lower = key.toLowerCase();
  if (lower && !lookupMap.has(lower)) {
    lookupMap.set(lower, id);
  }
}

function buildGroupLookupMap(accountGroupsById) {
  const lookup = new Map();
  if (!accountGroupsById || typeof accountGroupsById.forEach !== 'function') {
    return lookup;
  }

  accountGroupsById.forEach((group, key) => {
    if (!group || typeof group !== 'object') {
      return;
    }

    const canonicalId = typeof group.id === 'string' && group.id ? group.id : null;
    if (canonicalId) {
      registerGroupLookupKey(lookup, canonicalId, canonicalId);
      registerGroupLookupKey(lookup, canonicalId.toLowerCase(), canonicalId);
    }

    if (typeof key === 'string' && key) {
      registerGroupLookupKey(lookup, key, canonicalId || key);
      registerGroupLookupKey(lookup, key.toLowerCase(), canonicalId || key);
      if (key.startsWith('group:')) {
        const withoutPrefix = key.slice('group:'.length);
        if (withoutPrefix) {
          registerGroupLookupKey(lookup, withoutPrefix, canonicalId || key);
          registerGroupLookupKey(lookup, withoutPrefix.toLowerCase(), canonicalId || key);
        }
      }
    }

    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (name) {
      registerGroupLookupKey(lookup, name, canonicalId || name);
      registerGroupLookupKey(lookup, name.toLowerCase(), canonicalId || name);
      const slug = slugifyAccountGroupKey ? slugifyAccountGroupKey(name) : null;
      if (slug) {
        registerGroupLookupKey(lookup, slug, canonicalId || `group:${slug}`);
        registerGroupLookupKey(lookup, `group:${slug}`, canonicalId || `group:${slug}`);
      }
    }
  });

  return lookup;
}

function cloneJsonSafe(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (error) {
      // fall through to JSON fallback
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function createEmptyDividendSummary() {
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

function resolveDividendSummaryForTimeframe(summary, timeframeKey) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }
  const normalizedKey = typeof timeframeKey === 'string' && timeframeKey ? timeframeKey : 'all';
  if (normalizedKey === 'all') {
    return summary;
  }
  const timeframes =
    summary.timeframes && typeof summary.timeframes === 'object' && !Array.isArray(summary.timeframes)
      ? summary.timeframes
      : null;
  if (timeframes) {
    const match = timeframes[normalizedKey];
    if (match && typeof match === 'object') {
      return match;
    }
    const fallback = timeframes.all;
    if (fallback && typeof fallback === 'object') {
      return fallback;
    }
  }
  return summary;
}

function parseDateLike(value) {
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
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function aggregateDividendSummaries(dividendsByAccount, accountIds, timeframeKey = 'all') {
  if (!dividendsByAccount || typeof dividendsByAccount !== 'object') {
    return createEmptyDividendSummary();
  }

  const seenIds = new Set();
  const normalizedIds = [];
  if (Array.isArray(accountIds)) {
    accountIds.forEach((accountId) => {
      if (accountId === null || accountId === undefined) {
        return;
      }
      const key = String(accountId);
      if (!key || seenIds.has(key)) {
        return;
      }
      seenIds.add(key);
      normalizedIds.push(key);
    });
  }

  if (!normalizedIds.length) {
    return createEmptyDividendSummary();
  }

  const entryMap = new Map();
  const totalsByCurrency = new Map();
  let totalCad = 0;
  let totalCadHasValue = false;
  let totalCount = 0;
  let conversionIncomplete = false;
  let aggregateStart = null;
  let aggregateEnd = null;
  let processedSummary = false;

  const normalizeCurrencyKey = (currency) => {
    if (typeof currency === 'string' && currency.trim()) {
      return currency.trim().toUpperCase();
    }
    return '';
  };

  normalizedIds.forEach((accountId) => {
    const container = dividendsByAccount[accountId];
    const summary = resolveDividendSummaryForTimeframe(container, timeframeKey);
    if (!summary || typeof summary !== 'object') {
      return;
    }
    processedSummary = true;

    const summaryTotals =
      summary.totalsByCurrency && typeof summary.totalsByCurrency === 'object'
        ? summary.totalsByCurrency
        : {};

    Object.entries(summaryTotals).forEach(([currency, value]) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return;
      }
      const key = normalizeCurrencyKey(currency);
      const current = totalsByCurrency.get(key) || 0;
      totalsByCurrency.set(key, current + numeric);
    });

    if (Number.isFinite(summary.totalCad)) {
      totalCad += summary.totalCad;
      totalCadHasValue = true;
    }

    if (Number.isFinite(summary.totalCount)) {
      totalCount += summary.totalCount;
    }

    if (summary.conversionIncomplete) {
      conversionIncomplete = true;
    }

    const summaryStart = parseDateLike(summary.startDate);
    if (summaryStart && (!aggregateStart || summaryStart < aggregateStart)) {
      aggregateStart = summaryStart;
    }
    const summaryEnd = parseDateLike(summary.endDate);
    if (summaryEnd && (!aggregateEnd || summaryEnd > aggregateEnd)) {
      aggregateEnd = summaryEnd;
    }

    const entries = Array.isArray(summary.entries) ? summary.entries : [];
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }

      const canonicalSymbol =
        typeof entry.symbol === 'string' && entry.symbol.trim() ? entry.symbol.trim() : '';
      const displaySymbol =
        typeof entry.displaySymbol === 'string' && entry.displaySymbol.trim()
          ? entry.displaySymbol.trim()
          : '';
      const description =
        typeof entry.description === 'string' && entry.description.trim()
          ? entry.description.trim()
          : '';
      const rawSymbolsArray = Array.isArray(entry.rawSymbols) ? entry.rawSymbols : [];
      const rawSymbolLabel = rawSymbolsArray
        .map((raw) => (typeof raw === 'string' ? raw.trim() : ''))
        .filter(Boolean)
        .join('|');

      const entryKey =
        canonicalSymbol || displaySymbol || rawSymbolLabel || description || `entry-${entryMap.size}`;

      let aggregateEntry = entryMap.get(entryKey);
      if (!aggregateEntry) {
        aggregateEntry = {
          symbol: canonicalSymbol || null,
          displaySymbol: displaySymbol || canonicalSymbol || null,
          rawSymbols: new Set(),
          description: description || null,
          currencyTotals: new Map(),
          cadAmount: 0,
          cadAmountHasValue: false,
          conversionIncomplete: false,
          activityCount: 0,
          firstDate: null,
          lastDate: null,
          lastTimestamp: null,
          lastAmount: null,
          lastCurrency: null,
          lastDateKey: null,
          lastDateTotals: new Map(),
          lineItems: [],
        };
        entryMap.set(entryKey, aggregateEntry);
      } else {
        if (!aggregateEntry.symbol && canonicalSymbol) {
          aggregateEntry.symbol = canonicalSymbol;
        }
        if (!aggregateEntry.displaySymbol && (displaySymbol || canonicalSymbol)) {
          aggregateEntry.displaySymbol = displaySymbol || canonicalSymbol;
        }
        if (!aggregateEntry.description && description) {
          aggregateEntry.description = description;
        }
      }

      rawSymbolsArray.forEach((raw) => {
        if (typeof raw === 'string' && raw.trim()) {
          aggregateEntry.rawSymbols.add(raw.trim());
        }
      });

      const entryTotals =
        entry.currencyTotals && typeof entry.currencyTotals === 'object'
          ? entry.currencyTotals
          : {};
      Object.entries(entryTotals).forEach(([currency, value]) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return;
        }
        const key = normalizeCurrencyKey(currency);
        const current = aggregateEntry.currencyTotals.get(key) || 0;
        aggregateEntry.currencyTotals.set(key, current + numeric);
      });

      const cadAmount = Number(entry.cadAmount);
      if (Number.isFinite(cadAmount)) {
        aggregateEntry.cadAmount += cadAmount;
        aggregateEntry.cadAmountHasValue = true;
      }

      if (entry.conversionIncomplete) {
        aggregateEntry.conversionIncomplete = true;
      }

      const activityCount = Number(entry.activityCount);
      if (Number.isFinite(activityCount)) {
        aggregateEntry.activityCount += activityCount;
      }

      const entryFirst = parseDateLike(entry.firstDate || entry.startDate);
      if (entryFirst && (!aggregateEntry.firstDate || entryFirst < aggregateEntry.firstDate)) {
        aggregateEntry.firstDate = entryFirst;
      }

      const entryLast = parseDateLike(entry.lastDate || entry.endDate);
      if (entryLast && (!aggregateEntry.lastDate || entryLast > aggregateEntry.lastDate)) {
        aggregateEntry.lastDate = entryLast;
      }

      const entryTimestamp = parseDateLike(entry.lastTimestamp || entry.lastDate || entry.endDate);
      const entryDateKey = entryTimestamp
        ? entryTimestamp.toISOString().slice(0, 10)
        : typeof entry.lastDate === 'string' && entry.lastDate.trim()
        ? entry.lastDate.trim().slice(0, 10)
        : null;
      const normalizedLastAmount = Number(entry.lastAmount);
      const hasNormalizedAmount = Number.isFinite(normalizedLastAmount);
      const normalizedLastCurrency =
        typeof entry.lastCurrency === 'string' && entry.lastCurrency.trim()
          ? entry.lastCurrency.trim().toUpperCase()
          : null;

      const isLaterTimestamp =
        entryTimestamp && (!aggregateEntry.lastTimestamp || entryTimestamp > aggregateEntry.lastTimestamp);
      const isLaterDateKey =
        !entryTimestamp &&
        entryDateKey &&
        (!aggregateEntry.lastDateKey || entryDateKey > aggregateEntry.lastDateKey);

      if (isLaterTimestamp || isLaterDateKey) {
        if (isLaterTimestamp) {
          aggregateEntry.lastTimestamp = entryTimestamp;
        } else if (!aggregateEntry.lastTimestamp && entryTimestamp) {
          aggregateEntry.lastTimestamp = entryTimestamp;
        }
        const computedDateKey = entryDateKey || (entryTimestamp ? entryTimestamp.toISOString().slice(0, 10) : null);
        const shouldResetTotals =
          !computedDateKey ||
          !(aggregateEntry.lastDateTotals instanceof Map) ||
          aggregateEntry.lastDateKey !== computedDateKey;
        aggregateEntry.lastDateKey = computedDateKey;
        aggregateEntry.lastAmount = hasNormalizedAmount ? normalizedLastAmount : null;
        aggregateEntry.lastCurrency = normalizedLastCurrency || null;
        if (shouldResetTotals) {
          aggregateEntry.lastDateTotals = new Map();
        }
      } else if (!aggregateEntry.lastTimestamp && entryTimestamp) {
        aggregateEntry.lastTimestamp = entryTimestamp;
      }

      if (entryDateKey && aggregateEntry.lastDateKey === entryDateKey && hasNormalizedAmount) {
        if (!(aggregateEntry.lastDateTotals instanceof Map)) {
          aggregateEntry.lastDateTotals = new Map();
        }
        const currencyKey = normalizedLastCurrency || '';
        const current = aggregateEntry.lastDateTotals.get(currencyKey) || 0;
        aggregateEntry.lastDateTotals.set(currencyKey, current + normalizedLastAmount);
        if (!aggregateEntry.lastCurrency && normalizedLastCurrency) {
          aggregateEntry.lastCurrency = normalizedLastCurrency;
        }
        if (!Number.isFinite(aggregateEntry.lastAmount) || aggregateEntry.lastAmount === null) {
          aggregateEntry.lastAmount = normalizedLastAmount;
        }
      }

      const lineItems = Array.isArray(entry.lineItems) ? entry.lineItems : [];
      lineItems.forEach((lineItem, lineIndex) => {
        if (!lineItem || typeof lineItem !== 'object') {
          return;
        }

        const normalizedLineItem = { ...lineItem };
        if (!normalizedLineItem.symbol && canonicalSymbol) {
          normalizedLineItem.symbol = canonicalSymbol;
        }
        if (!normalizedLineItem.displaySymbol && (displaySymbol || canonicalSymbol)) {
          normalizedLineItem.displaySymbol = displaySymbol || canonicalSymbol;
        }
        if (!normalizedLineItem.description && description) {
          normalizedLineItem.description = description;
        }
        if (!normalizedLineItem.lineItemId) {
          normalizedLineItem.lineItemId = `${entryKey}:${lineIndex}`;
        }

        aggregateEntry.lineItems.push(normalizedLineItem);
      });
    });
  });

  if (!processedSummary) {
    return createEmptyDividendSummary();
  }

  let computedStart = aggregateStart;
  let computedEnd = aggregateEnd;

  const finalEntries = Array.from(entryMap.values()).map((entry) => {
    if (entry.firstDate && (!computedStart || entry.firstDate < computedStart)) {
      computedStart = entry.firstDate;
    }
    if (entry.lastDate && (!computedEnd || entry.lastDate > computedEnd)) {
      computedEnd = entry.lastDate;
    }

    const rawSymbols = Array.from(entry.rawSymbols);
    const currencyTotalsObject = {};
    entry.currencyTotals.forEach((value, currency) => {
      currencyTotalsObject[currency] = value;
    });

    const cadAmount = entry.cadAmountHasValue ? entry.cadAmount : null;
    const magnitude =
      cadAmount !== null
        ? Math.abs(cadAmount)
        : Array.from(entry.currencyTotals.values()).reduce((sum, value) => sum + Math.abs(value), 0);

    const lastDateTotalsMap =
      entry.lastDateKey && entry.lastDateTotals instanceof Map ? entry.lastDateTotals : null;
    let lastAmount = Number.isFinite(entry.lastAmount) ? entry.lastAmount : null;
    let lastCurrency = entry.lastCurrency || null;
    if (lastDateTotalsMap && lastDateTotalsMap.size > 0) {
      const preferredKey = lastCurrency || '';
      if (preferredKey && lastDateTotalsMap.has(preferredKey)) {
        const summed = lastDateTotalsMap.get(preferredKey);
        if (Number.isFinite(summed)) {
          lastAmount = summed;
        }
      } else if (!preferredKey && lastDateTotalsMap.has('')) {
        const summed = lastDateTotalsMap.get('');
        if (Number.isFinite(summed)) {
          lastAmount = summed;
        }
      } else if (lastDateTotalsMap.size === 1) {
        const [currencyKey, summed] = lastDateTotalsMap.entries().next().value;
        if (Number.isFinite(summed)) {
          lastAmount = summed;
          lastCurrency = currencyKey || null;
        }
      } else {
        const firstValid = Array.from(lastDateTotalsMap.entries()).find(([, value]) =>
          Number.isFinite(value)
        );
        if (firstValid) {
          const [currencyKey, summed] = firstValid;
          lastAmount = summed;
          if (currencyKey) {
            lastCurrency = currencyKey;
          }
        }
      }
    }

    const normalizedLineItems = Array.isArray(entry.lineItems)
      ? entry.lineItems
          .map((lineItem) => {
            if (!lineItem || typeof lineItem !== 'object') {
              return null;
            }

            const rawLineSymbols = Array.isArray(lineItem.rawSymbols)
              ? lineItem.rawSymbols
                  .map((value) => (typeof value === 'string' ? value.trim() : ''))
                  .filter(Boolean)
              : rawSymbols;

            const lineCurrencyTotals = {};
            if (lineItem.currencyTotals && typeof lineItem.currencyTotals === 'object') {
              Object.entries(lineItem.currencyTotals).forEach(([currency, value]) => {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) {
                  return;
                }
                const key = normalizeCurrencyKey(currency);
                lineCurrencyTotals[key] = (lineCurrencyTotals[key] || 0) + numeric;
              });
            }
            if (!Object.keys(lineCurrencyTotals).length) {
              const fallbackAmount = Number(lineItem.amount);
              if (Number.isFinite(fallbackAmount)) {
                const fallbackCurrency = normalizeCurrencyKey(lineItem.currency);
                lineCurrencyTotals[fallbackCurrency] = (lineCurrencyTotals[fallbackCurrency] || 0) + fallbackAmount;
              }
            }

            const firstDate =
              (typeof lineItem.firstDate === 'string' && lineItem.firstDate.trim()) ||
              (typeof lineItem.startDate === 'string' && lineItem.startDate.trim()) ||
              (typeof lineItem.date === 'string' && lineItem.date.trim()) ||
              null;
            const lastDate =
              (typeof lineItem.lastDate === 'string' && lineItem.lastDate.trim()) ||
              (typeof lineItem.endDate === 'string' && lineItem.endDate.trim()) ||
              firstDate;
            const timestamp =
              (typeof lineItem.lastTimestamp === 'string' && lineItem.lastTimestamp.trim()) ||
              (typeof lineItem.timestamp === 'string' && lineItem.timestamp.trim()) ||
              null;
            const lastAmount = Number.isFinite(lineItem.lastAmount)
              ? lineItem.lastAmount
              : Number.isFinite(lineItem.amount)
              ? lineItem.amount
              : null;
            const lastCurrency = normalizeCurrencyKey(
              (typeof lineItem.lastCurrency === 'string' && lineItem.lastCurrency.trim()) ||
                (typeof lineItem.currency === 'string' && lineItem.currency.trim()) ||
                null
            );

            return {
              symbol: lineItem.symbol || entry.symbol || null,
              displaySymbol:
                lineItem.displaySymbol ||
                lineItem.symbol ||
                entry.displaySymbol ||
                entry.symbol ||
                (rawLineSymbols && rawLineSymbols.length ? rawLineSymbols[0] : null) ||
                null,
              rawSymbols: rawLineSymbols && rawLineSymbols.length ? rawLineSymbols : undefined,
              description: lineItem.description || entry.description || null,
              currencyTotals: lineCurrencyTotals,
              cadAmount: Number.isFinite(lineItem.cadAmount) ? lineItem.cadAmount : null,
              conversionIncomplete: lineItem.conversionIncomplete ? true : undefined,
              activityCount: Number.isFinite(lineItem.activityCount) ? lineItem.activityCount : 1,
              firstDate,
              lastDate,
              lastTimestamp: timestamp,
              lastAmount: Number.isFinite(lastAmount) ? lastAmount : null,
              lastCurrency,
              lineItemId:
                (typeof lineItem.lineItemId === 'string' && lineItem.lineItemId.trim()) ||
                (typeof lineItem.id === 'string' && lineItem.id.trim()) ||
                null,
              accountId: lineItem.accountId || null,
            };
          })
          .filter(Boolean)
      : [];

    return {
      symbol: entry.symbol || null,
      displaySymbol:
        entry.displaySymbol || entry.symbol || (rawSymbols.length ? rawSymbols[0] : null) || null,
      rawSymbols: rawSymbols.length ? rawSymbols : undefined,
      description: entry.description || null,
      currencyTotals: currencyTotalsObject,
      cadAmount,
      conversionIncomplete: entry.conversionIncomplete || undefined,
      activityCount: entry.activityCount,
      firstDate: entry.firstDate ? entry.firstDate.toISOString().slice(0, 10) : null,
      lastDate: entry.lastDate ? entry.lastDate.toISOString().slice(0, 10) : null,
      lastTimestamp: entry.lastTimestamp ? entry.lastTimestamp.toISOString() : null,
      lastAmount: Number.isFinite(lastAmount) ? lastAmount : null,
      lastCurrency: lastCurrency || null,
      _magnitude: magnitude,
      lineItems: normalizedLineItems.length ? normalizedLineItems : undefined,
    };
  });

  finalEntries.sort((a, b) => (b._magnitude || 0) - (a._magnitude || 0));

  const cleanedEntries = finalEntries.map((entry) => {
    const cleaned = { ...entry };
    delete cleaned._magnitude;
    if (!cleaned.rawSymbols) {
      delete cleaned.rawSymbols;
    }
    if (!cleaned.conversionIncomplete) {
      delete cleaned.conversionIncomplete;
    }
    return cleaned;
  });

  const totalsByCurrencyObject = {};
  totalsByCurrency.forEach((value, currency) => {
    totalsByCurrencyObject[currency] = value;
  });

  return {
    entries: cleanedEntries,
    totalsByCurrency: totalsByCurrencyObject,
    totalCad: totalCadHasValue ? totalCad : null,
    totalCount,
    conversionIncomplete: conversionIncomplete || undefined,
    startDate: computedStart ? computedStart.toISOString().slice(0, 10) : null,
    endDate: computedEnd ? computedEnd.toISOString().slice(0, 10) : null,
  };
}

function aggregateFundingSummariesForAccounts(fundingMap, accountIds) {
  if (!fundingMap || typeof fundingMap !== 'object') {
    return null;
  }

  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((id) => (id === undefined || id === null ? '' : String(id)))
        .filter(Boolean)
    )
  );

  if (!uniqueIds.length) {
    return null;
  }

  let netDepositsTotal = 0;
  let netDepositsCount = 0;
  let netDepositsAllTimeTotal = 0;
  let netDepositsAllTimeCount = 0;
  let totalPnlTotal = 0;
  let totalPnlCount = 0;
  let totalPnlAllTimeTotal = 0;
  let totalPnlAllTimeCount = 0;
  let totalEquityTotal = 0;
  let totalEquityCount = 0;

  uniqueIds.forEach((accountId) => {
    const entry = fundingMap[accountId];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const netDepositsCad = entry?.netDeposits?.combinedCad;
    if (Number.isFinite(netDepositsCad)) {
      netDepositsTotal += netDepositsCad;
      netDepositsCount += 1;
    }
    const netDepositsAllTimeCad = entry?.netDeposits?.allTimeCad;
    if (Number.isFinite(netDepositsAllTimeCad)) {
      netDepositsAllTimeTotal += netDepositsAllTimeCad;
      netDepositsAllTimeCount += 1;
    }
    const totalPnlCad = entry?.totalPnl?.combinedCad;
    if (Number.isFinite(totalPnlCad)) {
      totalPnlTotal += totalPnlCad;
      totalPnlCount += 1;
    }
    const totalPnlAllTimeCad = entry?.totalPnl?.allTimeCad;
    if (Number.isFinite(totalPnlAllTimeCad)) {
      totalPnlAllTimeTotal += totalPnlAllTimeCad;
      totalPnlAllTimeCount += 1;
    }
    const totalEquityCad = entry?.totalEquityCad;
    if (Number.isFinite(totalEquityCad)) {
      totalEquityTotal += totalEquityCad;
      totalEquityCount += 1;
    }
  });

  if (!netDepositsCount && !totalPnlCount && !totalEquityCount) {
    return null;
  }

  const aggregate = {};
  if (netDepositsCount > 0 || netDepositsAllTimeCount > 0) {
    aggregate.netDeposits = {};
    if (netDepositsCount > 0) aggregate.netDeposits.combinedCad = netDepositsTotal;
    if (netDepositsAllTimeCount > 0) aggregate.netDeposits.allTimeCad = netDepositsAllTimeTotal;
  }
  if (totalPnlCount > 0 || totalPnlAllTimeCount > 0) {
    aggregate.totalPnl = {};
    if (totalPnlCount > 0) aggregate.totalPnl.combinedCad = totalPnlTotal;
    if (totalPnlAllTimeCount > 0) aggregate.totalPnl.allTimeCad = totalPnlAllTimeTotal;
  } else if ((netDepositsCount > 0 || netDepositsAllTimeCount > 0) && totalEquityCount > 0) {
    const derivedCombined = netDepositsCount > 0 ? totalEquityTotal - netDepositsTotal : null;
    const derivedAllTime = netDepositsAllTimeCount > 0 ? totalEquityTotal - netDepositsAllTimeTotal : null;
    if (Number.isFinite(derivedCombined) || Number.isFinite(derivedAllTime)) {
      aggregate.totalPnl = {};
      if (Number.isFinite(derivedCombined)) aggregate.totalPnl.combinedCad = derivedCombined;
      if (Number.isFinite(derivedAllTime)) aggregate.totalPnl.allTimeCad = derivedAllTime;
    }
  }
  if (totalEquityCount > 0) {
    aggregate.totalEquityCad = totalEquityTotal;
  }

  return Object.keys(aggregate).length ? aggregate : null;
}

function aggregateTotalPnlEntries(totalPnlMap, accountIds) {
  if (!totalPnlMap || typeof totalPnlMap !== 'object') {
    return null;
  }

  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((id) => (id === undefined || id === null ? '' : String(id).trim()))
        .filter(Boolean)
    )
  );

  if (!normalizedIds.length) {
    return null;
  }

  const aggregateEntries = new Map();
  const aggregateEntriesNoFx = new Map();
  let fxEffectTotal = 0;
  let fxEffectHasValue = false;
  let latestAsOf = null;

  const addEntryToMap = (bucket, sourceEntry) => {
    const key =
      sourceEntry && typeof sourceEntry.symbol === 'string' && sourceEntry.symbol.trim()
        ? sourceEntry.symbol.trim().toUpperCase()
        : null;
    if (!key) {
      return;
    }
    const existing = bucket.get(key);
    if (!existing) {
      const clone = cloneJsonSafe(sourceEntry) || {};
      bucket.set(key, clone);
      return;
    }
    Object.entries(sourceEntry).forEach(([field, value]) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const current = typeof existing[field] === 'number' && Number.isFinite(existing[field]) ? existing[field] : 0;
        existing[field] = current + value;
      } else if (existing[field] === undefined) {
        existing[field] = value;
      }
    });
  };

  normalizedIds.forEach((accountId) => {
    const entry = totalPnlMap[accountId];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    if (Array.isArray(entry.entries)) {
      entry.entries.forEach((symbolEntry) => addEntryToMap(aggregateEntries, symbolEntry));
    }
    if (Array.isArray(entry.entriesNoFx)) {
      entry.entriesNoFx.forEach((symbolEntry) => addEntryToMap(aggregateEntriesNoFx, symbolEntry));
    }
    const fx = entry.fxEffectCad;
    if (Number.isFinite(fx)) {
      fxEffectTotal += fx;
      fxEffectHasValue = true;
    }
    const asOf = typeof entry.asOf === 'string' ? entry.asOf : null;
    if (asOf && (!latestAsOf || asOf > latestAsOf)) {
      latestAsOf = asOf;
    }
  });

  const aggregateEntriesArray = Array.from(aggregateEntries.values()).filter((entry) => entry && typeof entry === 'object');
  const aggregateEntriesNoFxArray = Array.from(aggregateEntriesNoFx.values()).filter(
    (entry) => entry && typeof entry === 'object'
  );

  aggregateEntriesArray.sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));
  aggregateEntriesNoFxArray.sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));

  const aggregated = {};
  if (aggregateEntriesArray.length) {
    aggregated.entries = aggregateEntriesArray;
  }
  if (aggregateEntriesNoFxArray.length) {
    aggregated.entriesNoFx = aggregateEntriesNoFxArray;
  }
  if (fxEffectHasValue) {
    aggregated.fxEffectCad = fxEffectTotal;
  }
  if (latestAsOf) {
    aggregated.asOf = latestAsOf;
  }

  return Object.keys(aggregated).length ? aggregated : null;
}

function reinterpretSelectionWithSuperset(selection, superset) {
  if (!selection || !superset) {
    return selection;
  }
  if (selection.type === 'group' || selection.type === 'all' || selection.type === 'default') {
    return selection;
  }

  const lookup = superset.groupLookup instanceof Map ? superset.groupLookup : null;
  const rawRequested =
    typeof selection.originalRequestedId === 'string' && selection.originalRequestedId
      ? selection.originalRequestedId
      : selection.requestedId;
  if (!rawRequested || typeof rawRequested !== 'string') {
    return selection;
  }

  const candidates = new Set();
  const pushCandidate = (value) => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidates.add(trimmed);
    const lower = trimmed.toLowerCase();
    if (lower && lower !== trimmed) {
      candidates.add(lower);
    }
  };

  pushCandidate(selection.requestedId);
  pushCandidate(rawRequested);

  const ensurePrefixed = (value) => {
    if (!value) {
      return null;
    }
    return value.startsWith('group:') ? value : `group:${value}`;
  };

  Array.from(candidates).forEach((candidate) => {
    const prefixed = ensurePrefixed(candidate);
    if (prefixed) {
      pushCandidate(prefixed);
    }
  });

  const allGroups = [];
  if (Array.isArray(superset.accountGroups)) {
    superset.accountGroups.forEach((group) => {
      if (group && typeof group === 'object') {
        allGroups.push(group);
      }
    });
  }
  if (Array.isArray(superset.payload?.accountGroups)) {
    superset.payload.accountGroups.forEach((group) => {
      if (group && typeof group === 'object') {
        allGroups.push(group);
      }
    });
  }

  let resolvedGroupId = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (lookup && lookup.has(candidate)) {
      resolvedGroupId = lookup.get(candidate);
      break;
    }
    for (const group of allGroups) {
      const groupId = typeof group.id === 'string' ? group.id : null;
      const groupIdLower = groupId ? groupId.toLowerCase() : null;
      const groupName = typeof group.name === 'string' ? group.name.trim() : '';
      const groupNameLower = groupName ? groupName.toLowerCase() : null;
      if (
        (groupId && candidate === groupId) ||
        (groupIdLower && candidate === groupIdLower) ||
        (groupName && candidate === groupName) ||
        (groupNameLower && candidate === groupNameLower)
      ) {
        resolvedGroupId = groupId || candidate;
        break;
      }
      if (groupName) {
        const slug = slugifyAccountGroupKey ? slugifyAccountGroupKey(groupName) : null;
        if (slug) {
          if (candidate === slug || candidate === `group:${slug}`) {
            resolvedGroupId = groupId || `group:${slug}`;
            break;
          }
        }
      }
    }
    if (resolvedGroupId) {
      break;
    }
  }

  if (!resolvedGroupId) {
    return selection;
  }

  const normalizedGroupId = String(resolvedGroupId).trim();
  if (!normalizedGroupId) {
    return selection;
  }

  const groupCacheKey = normalizedGroupId.toLowerCase();
  return {
    cacheKey: groupCacheKey,
    type: 'group',
    requestedId: normalizedGroupId,
    groupId: normalizedGroupId,
    groupCacheKey,
    originalRequestedId: selection.originalRequestedId || selection.requestedId,
  };
}

function resolveAccountIdsForSelection(superset, normalizedSelection) {
  if (!superset || !normalizedSelection) {
    return [];
  }
  if (normalizedSelection.type === 'all') {
    return Array.isArray(superset.allAccountIds) ? superset.allAccountIds.slice() : [];
  }
  if (normalizedSelection.type === 'default') {
    return superset.defaultAccountId ? [superset.defaultAccountId] : [];
  }
  if (normalizedSelection.type === 'group') {
    const key = normalizedSelection.groupCacheKey || normalizedSelection.groupId || '';
    if (!key) {
      return [];
    }
    const lowerKey = key.toLowerCase();
    const match =
      superset.groupAccountIds?.get(key) ||
      superset.groupAccountIds?.get(lowerKey);
    if (Array.isArray(match) && match.length) {
      return match
        .map((value) => (value !== undefined && value !== null ? String(value).trim() : ''))
        .filter(Boolean);
    }

    const collected = new Set();
    const considerGroup = (group) => {
      if (!group || typeof group !== 'object') {
        return;
      }
      const groupId = typeof group.id === 'string' ? group.id : '';
      if (!groupId) {
        return;
      }
      if (groupId === key || groupId.toLowerCase() === lowerKey) {
        const ids = Array.isArray(group.accountIds)
          ? group.accountIds
          : Array.isArray(group.accounts)
            ? group.accounts.map((account) => account && account.id)
            : [];
        ids.forEach((value) => {
          if (value !== undefined && value !== null) {
            const normalized = String(value).trim();
            if (normalized) {
              collected.add(normalized);
            }
          }
        });
      }
    };

    if (Array.isArray(superset.accountGroups)) {
      superset.accountGroups.forEach(considerGroup);
    }
    if (Array.isArray(superset.payload?.accountGroups)) {
      superset.payload.accountGroups.forEach(considerGroup);
    }
    if (collected.size) {
      return Array.from(collected);
    }
    return [];
  }
  const accountId = normalizedSelection.requestedId;
  if (accountId && superset.accountsById?.has(accountId)) {
    return [accountId];
  }
  const byNumber = superset.accountsByNumber?.get(accountId);
  if (byNumber && superset.accountsById?.has(byNumber)) {
    return [byNumber];
  }
  return [];
}

function buildContextFromSupersetAccount(superset, accountId) {
  if (!superset || !accountId) {
    return null;
  }
  const normalizedId = String(accountId).trim();
  if (!normalizedId) {
    return null;
  }
  let accountRecord = null;
  if (superset.accountsById instanceof Map && superset.accountsById.has(normalizedId)) {
    accountRecord = superset.accountsById.get(normalizedId);
  }
  if (!accountRecord && Array.isArray(superset.accounts)) {
    accountRecord = superset.accounts.find((entry) => entry && String(entry.id).trim() === normalizedId) || null;
  }
  if (!accountRecord && Array.isArray(superset.payload?.accounts)) {
    accountRecord = superset.payload.accounts.find((entry) => entry && String(entry.id).trim() === normalizedId) || null;
  }
  if (!accountRecord) {
    return null;
  }
  const login = getLoginById(accountRecord.loginId);
  if (!login) {
    return null;
  }
  const normalizedNumber =
    accountRecord.number !== undefined && accountRecord.number !== null
      ? String(accountRecord.number).trim()
      : accountRecord.accountNumber !== undefined && accountRecord.accountNumber !== null
        ? String(accountRecord.accountNumber).trim()
        : normalizedId;
  const normalizedAccount = Object.assign({}, accountRecord, {
    id: normalizedId,
    number: normalizedNumber || normalizedId,
    accountNumber: normalizedNumber || normalizedId,
    loginId: login.id,
  });
  const accountWithOverrides = applyAccountSettingsOverrides
    ? applyAccountSettingsOverrides(normalizedAccount, login)
    : normalizedAccount;
  const effectiveAccount = Object.assign({}, accountWithOverrides, {
    id: normalizedId,
    number: accountWithOverrides.number || normalizedAccount.number,
    accountNumber: accountWithOverrides.accountNumber || normalizedAccount.accountNumber,
  });
  return { login, account: effectiveAccount };
}

function aggregateSymbolBreakdowns(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { entries: [] };
  }
  const aggregateEntriesMap = new Map();
  const aggregateEntriesNoFxMap = new Map();
  let fxEffectCad = 0;
  let asOf = null;
  const addNumber = (value) => (Number.isFinite(value) ? value : 0);
  const mergeEntry = (targetMap, entry) => {
    const key = entry && typeof entry.symbol === 'string' ? entry.symbol.trim().toUpperCase() : null;
    if (!key) {
      return;
    }
    const existing =
      targetMap.get(key) || {
        symbol: entry.symbol,
        symbolId: entry.symbolId || null,
        totalPnlCad: 0,
        investedCad: 0,
        openQuantity: 0,
        marketValueCad: 0,
        currency: entry.currency || null,
      };
    existing.totalPnlCad += addNumber(entry.totalPnlCad);
    existing.investedCad += addNumber(entry.investedCad);
    existing.openQuantity += addNumber(entry.openQuantity);
    existing.marketValueCad += addNumber(entry.marketValueCad);
    if (!existing.symbolId && Number.isFinite(entry.symbolId)) {
      existing.symbolId = entry.symbolId;
    }
    if (!existing.currency && entry.currency) {
      existing.currency = entry.currency;
    }
    targetMap.set(key, existing);
  };

  results.forEach((result) => {
    if (!result || typeof result !== 'object') {
      return;
    }
    if (typeof result.endDate === 'string' && result.endDate) {
      if (!asOf || result.endDate > asOf) {
        asOf = result.endDate;
      }
    }
    if (Number.isFinite(result.fxEffectCad)) {
      fxEffectCad += result.fxEffectCad;
    }
    if (Array.isArray(result.entries)) {
      result.entries.forEach((entry) => mergeEntry(aggregateEntriesMap, entry));
    }
    if (Array.isArray(result.entriesNoFx)) {
      result.entriesNoFx.forEach((entry) => mergeEntry(aggregateEntriesNoFxMap, entry));
    }
  });

  const aggregateEntries = Array.from(aggregateEntriesMap.values())
    .filter((entry) => Number.isFinite(entry.totalPnlCad) || Number.isFinite(entry.marketValueCad))
    .sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));
  const aggregateEntriesNoFx = Array.from(aggregateEntriesNoFxMap.values()).sort(
    (a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0)
  );

  const payload = {
    entries: aggregateEntries,
  };
  if (aggregateEntriesNoFx.length) {
    payload.entriesNoFx = aggregateEntriesNoFx;
  }
  if (Number.isFinite(fxEffectCad)) {
    payload.fxEffectCad = fxEffectCad;
  }
  if (asOf) {
    payload.asOf = asOf;
  }
  return payload;
}

function deriveSummaryFromSuperset(superset, normalizedSelection, debugDetails) {
  if (!superset || !normalizedSelection) {
    if (debugDetails) {
      debugDetails.reason = 'missing-input';
    }
    return null;
  }

  const accountIds = resolveAccountIdsForSelection(superset, normalizedSelection);
  if (!accountIds.length) {
    if (debugDetails) {
      debugDetails.reason = 'no-account-ids';
      debugDetails.selectionType = normalizedSelection.type;
      debugDetails.requestedId = normalizedSelection.requestedId;
      debugDetails.originalRequestedId = normalizedSelection.originalRequestedId || null;
      if (superset.groupLookup instanceof Map) {
        debugDetails.availableGroupKeys = Array.from(superset.groupLookup.keys()).slice(0, 20);
      }
    }
    return null;
  }

  if (debugDetails) {
    debugDetails.accountIdsResolved = accountIds.slice(0, 20);
    debugDetails.totalAccountIds = accountIds.length;
  }

  const accountIdSet = new Set(accountIds);

  const decoratedPositions = Array.isArray(superset.decoratedPositions)
    ? superset.decoratedPositions.filter((position) =>
        position && accountIdSet.has(position.accountId || position.accountNumber)
      )
    : [];

  const flattenedPositions = Array.isArray(superset.flattenedPositions)
    ? superset.flattenedPositions.filter((position) =>
        position && accountIdSet.has(position.accountId || position.accountNumber)
      )
    : [];

  const decoratedOrders = Array.isArray(superset.decoratedOrders)
    ? superset.decoratedOrders.filter((order) => order && accountIdSet.has(order.accountId || order.accountNumber))
    : [];

  const balancesRaw = accountIds
    .map((accountId) => superset.balancesRawByAccountId?.get(accountId))
    .filter(Boolean);
  const balancesSummary = mergeBalances(balancesRaw);
  finalizeBalances(balancesSummary);

  const pnl = mergePnL(flattenedPositions);

  const accountBalances = {};
  accountIds.forEach((accountId) => {
    if (superset.perAccountCombinedBalances && superset.perAccountCombinedBalances[accountId]) {
      accountBalances[accountId] = superset.perAccountCombinedBalances[accountId];
    }
  });

  const investmentModelEvaluations = {};
  accountIds.forEach((accountId) => {
    if (superset.investmentModelEvaluations && superset.investmentModelEvaluations[accountId]) {
      investmentModelEvaluations[accountId] = superset.investmentModelEvaluations[accountId];
    }
  });

  const accountFunding = {};
  accountIds.forEach((accountId) => {
    if (superset.accountFundingSummaries && superset.accountFundingSummaries[accountId]) {
      accountFunding[accountId] = superset.accountFundingSummaries[accountId];
    }
  });

  const accountDividends = {};
  accountIds.forEach((accountId) => {
    if (superset.accountDividendSummaries && superset.accountDividendSummaries[accountId]) {
      accountDividends[accountId] = superset.accountDividendSummaries[accountId];
    }
  });

  const accountTotalPnlBySymbol = {};
  accountIds.forEach((accountId) => {
    if (superset.accountTotalPnlBySymbol && superset.accountTotalPnlBySymbol[accountId]) {
      accountTotalPnlBySymbol[accountId] = superset.accountTotalPnlBySymbol[accountId];
    }
  });

  const accountTotalPnlBySymbolAll = {};
  accountIds.forEach((accountId) => {
    if (superset.accountTotalPnlBySymbolAll && superset.accountTotalPnlBySymbolAll[accountId]) {
      accountTotalPnlBySymbolAll[accountId] = superset.accountTotalPnlBySymbolAll[accountId];
    }
  });

  const accountTotalPnlSeries = {};
  accountIds.forEach((accountId) => {
    if (superset.accountTotalPnlSeries && superset.accountTotalPnlSeries[accountId]) {
      accountTotalPnlSeries[accountId] = superset.accountTotalPnlSeries[accountId];
    }
  });

  const aggregateKey =
    normalizedSelection.type === 'group'
      ? normalizedSelection.requestedId
      : normalizedSelection.type === 'all'
        ? 'all'
        : accountIds.length > 1
          ? normalizedSelection.requestedId || 'all'
          : null;

  if (aggregateKey) {
    const aggregateFunding = aggregateFundingSummariesForAccounts(
      superset.accountFundingSummaries,
      accountIds
    );
    if (aggregateFunding) {
      accountFunding[aggregateKey] = aggregateFunding;
    }

    const aggregateDividends = aggregateDividendSummaries(
      superset.accountDividendSummaries,
      accountIds,
      'all'
    );
    if (aggregateDividends) {
      accountDividends[aggregateKey] = aggregateDividends;
    }

    const aggregateTotalPnl = aggregateTotalPnlEntries(superset.accountTotalPnlBySymbol, accountIds);
    if (aggregateTotalPnl) {
      accountTotalPnlBySymbol[aggregateKey] = aggregateTotalPnl;
    }

    const aggregateTotalPnlAll = aggregateTotalPnlEntries(
      superset.accountTotalPnlBySymbolAll,
      accountIds
    );
    if (aggregateTotalPnlAll) {
      accountTotalPnlBySymbolAll[aggregateKey] = aggregateTotalPnlAll;
    }

    // If we have a precomputed group series, prefer its summary to seed group funding accurately
    const groupSeriesContainer = accountTotalPnlSeries[aggregateKey];
    const groupAllSeries = groupSeriesContainer && typeof groupSeriesContainer === 'object' ? groupSeriesContainer.all : null;
    const groupAllSummary = groupAllSeries && typeof groupAllSeries.summary === 'object' ? groupAllSeries.summary : null;
    if (groupAllSummary) {
      const override = accountFunding[aggregateKey] || {};
      const merged = { ...override };
      // Only use group 'all' series to populate all-time fields; keep combinedCad from per-account (CAGR) aggregation
      const netDeposits = Object.assign({}, merged.netDeposits || {});
      if (Number.isFinite(groupAllSummary.netDepositsAllTimeCad)) {
        netDeposits.allTimeCad = groupAllSummary.netDepositsAllTimeCad;
      }
      if (Object.keys(netDeposits).length) {
        merged.netDeposits = netDeposits;
      }
      const totalPnl = Object.assign({}, merged.totalPnl || {});
      if (Number.isFinite(groupAllSummary.totalPnlAllTimeCad)) {
        totalPnl.allTimeCad = groupAllSummary.totalPnlAllTimeCad;
      }
      if (Object.keys(totalPnl).length) {
        merged.totalPnl = totalPnl;
      }
      if (Number.isFinite(groupAllSummary.totalEquityCad)) {
        merged.totalEquityCad = groupAllSummary.totalEquityCad;
      }
      if (groupAllSeries.periodStartDate) {
        merged.periodStartDate = merged.periodStartDate || groupAllSeries.periodStartDate;
      }
      if (groupAllSeries.periodEndDate) {
        merged.periodEndDate = merged.periodEndDate || groupAllSeries.periodEndDate;
      }
      accountFunding[aggregateKey] = merged;
    }

    // Compute group-level since-display deltas by summing per-account since-display fields
    (function attachSinceDisplayTotals() {
      if (!Array.isArray(accountIds) || accountIds.length === 0) {
        return;
      }
      let pnlSinceDisplay = 0;
      let pnlSinceCount = 0;
      let equitySinceDisplay = 0;
      let equitySinceCount = 0;
      accountIds.forEach((accountId) => {
        const entry = superset.accountFundingSummaries && superset.accountFundingSummaries[accountId];
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const p = Number(entry.totalPnlSinceDisplayStartCad);
        if (Number.isFinite(p)) {
          pnlSinceDisplay += p;
          pnlSinceCount += 1;
        }
        const e = Number(entry.totalEquitySinceDisplayStartCad);
        if (Number.isFinite(e)) {
          equitySinceDisplay += e;
          equitySinceCount += 1;
        }
      });
      if (pnlSinceCount > 0 || equitySinceCount > 0) {
        const merged = Object.assign({}, accountFunding[aggregateKey] || {});
        if (pnlSinceCount > 0) {
          merged.totalPnlSinceDisplayStartCad = pnlSinceDisplay;
          merged.totalPnl = Object.assign({}, merged.totalPnl || {}, { combinedCad: pnlSinceDisplay });
        }
        if (equitySinceCount > 0) {
          merged.totalEquitySinceDisplayStartCad = equitySinceDisplay;
        }
        accountFunding[aggregateKey] = merged;
      }
    })();
  }

  let orderWindowStartIso = null;
  let orderWindowEndIso = null;
  accountIds.forEach((accountId) => {
    const window = superset.orderWindowsByAccountId?.get(accountId);
    if (!window) {
      return;
    }
    if (window.start && (!orderWindowStartIso || window.start < orderWindowStartIso)) {
      orderWindowStartIso = window.start;
    }
    if (window.end && (!orderWindowEndIso || window.end > orderWindowEndIso)) {
      orderWindowEndIso = window.end;
    }
  });

  if (!orderWindowStartIso) {
    orderWindowStartIso = superset.payload?.ordersWindow?.start || superset.asOf || new Date().toISOString();
  }
  if (!orderWindowEndIso) {
    orderWindowEndIso = superset.payload?.ordersWindow?.end || superset.asOf || new Date().toISOString();
  }

  const resolvedAccounts = superset.accountsById || new Map();
  let resolvedAccountId = null;
  let resolvedAccountNumber = null;
  if (normalizedSelection.type === 'group') {
    resolvedAccountId = normalizedSelection.requestedId;
  } else if (normalizedSelection.type === 'all') {
    resolvedAccountId = 'all';
  } else {
    resolvedAccountId = accountIds.length === 1 ? accountIds[0] : normalizedSelection.requestedId;
    if (accountIds.length === 1 && resolvedAccounts.has(accountIds[0])) {
      const account = resolvedAccounts.get(accountIds[0]);
      resolvedAccountNumber =
        (account && typeof account.number === 'string' && account.number.trim()) ||
        (account && account.number != null ? String(account.number).trim() : null);
    }
  }

  const payload = {
    accounts: superset.accounts || [],
    accountGroups: superset.accountGroups || [],
    groupRelations: superset.groupRelations || {},
    accountNamesFilePath: superset.accountNamesFilePath || null,
    filteredAccountIds: accountIds,
    defaultAccountId: superset.defaultAccountId || null,
    defaultAccountNumber: superset.defaultAccountNumber || null,
    resolvedAccountId,
    resolvedAccountNumber,
    requestedAccountId:
      normalizedSelection.type === 'all' && (!normalizedSelection.requestedId || normalizedSelection.requestedId === 'all')
        ? null
        : normalizedSelection.requestedId,
    positions: decoratedPositions,
    orders: decoratedOrders,
    ordersWindow: { start: orderWindowStartIso, end: orderWindowEndIso },
    pnl,
    balances: balancesSummary,
    accountBalances,
    investmentModelEvaluations,
    accountFunding,
    accountDividends,
    accountTotalPnlBySymbol,
    accountTotalPnlBySymbolAll,
    accountTotalPnlSeries,
    asOf: superset.asOf || new Date().toISOString(),
    usdToCadRate: superset.usdToCadRate || null,
  };

  return payload;
}

function getNewsModelPricing(modelName) {
  // Highest priority: explicit env overrides
  const envInput = Number(process.env.OPENAI_NEWS_INPUT_PRICE_PER_MTOKEN);
  const envOutput = Number(process.env.OPENAI_NEWS_OUTPUT_PRICE_PER_MTOKEN);
  if (Number.isFinite(envInput) && envInput > 0 && Number.isFinite(envOutput) && envOutput > 0) {
    return { input: envInput, output: envOutput };
  }

  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) {
    // Fall back to configured default model pricing
    return getNewsModelPricing(OPENAI_NEWS_MODEL);
  }

  // Exact match
  if (MODEL_PRICING_PER_MTOK[normalized]) {
    return MODEL_PRICING_PER_MTOK[normalized];
  }

  // Fuzzy match: handle versioned or suffixed model IDs (prefer most specific/longest key)
  const fuzzyKeys = Object.keys(MODEL_PRICING_PER_MTOK).sort((a, b) => b.length - a.length);
  for (const key of fuzzyKeys) {
    if (normalized.startsWith(key) || normalized.includes(key)) {
      return MODEL_PRICING_PER_MTOK[key];
    }
  }

  // If still unknown, try the configured model mapping as a last resort
  const fallback = String(OPENAI_NEWS_MODEL || '').trim().toLowerCase();
  if (fallback) {
    if (MODEL_PRICING_PER_MTOK[fallback]) {
      return MODEL_PRICING_PER_MTOK[fallback];
    }
    const fallbackFuzzyKeys = Object.keys(MODEL_PRICING_PER_MTOK).sort((a, b) => b.length - a.length);
    for (const key of fallbackFuzzyKeys) {
      if (fallback.startsWith(key) || fallback.includes(key)) {
        return MODEL_PRICING_PER_MTOK[key];
      }
    }
  }

  // Unknown model; pricing unavailable
  return { input: null, output: null };
}
// Timezone used for date filtering in the News panel to match UI display
const TORONTO_TIME_ZONE = 'America/Toronto';
const torontoDateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TORONTO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function getTorontoDateKey(input) {
  if (!input) {
    return null;
  }
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return torontoDateKeyFormatter.format(date);
}
const MAX_NEWS_SYMBOLS = 24;
let openAiClient = null;
let openAiClientInitError = null;

function maskTokenForLog(token) {
  if (!token || typeof token !== 'string') {
    return '<missing>';
  }
  if (token.length <= 8) {
    return token;
  }
  return token.slice(0, 4) + '…' + token.slice(-4);
}

function summarizeCookieHeader(cookieHeader) {
  if (!cookieHeader) {
    return [];
  }
  if (Array.isArray(cookieHeader)) {
    return cookieHeader
      .map((cookie) => String(cookie).split(';')[0])
      .map((pair) => pair.split('=')[0].trim())
      .filter(Boolean);
  }
  return String(cookieHeader)
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
    .filter(Boolean);
}

function decodeResponseBody(buffer, encoding) {
  if (!buffer) {
    return '';
  }
  const normalized = String(encoding || '').toLowerCase();
  try {
    if (!normalized || normalized === 'identity') {
      return buffer.toString('utf8');
    }
    if (normalized.includes('br')) {
      return zlib.brotliDecompressSync(buffer).toString('utf8');
    }
    if (normalized.includes('gzip')) {
      return zlib.gunzipSync(buffer).toString('utf8');
    }
    if (normalized.includes('deflate')) {
      return zlib.inflateSync(buffer).toString('utf8');
    }
  } catch (error) {
    console.warn('[Questrade][refresh] Failed to decode response body', {
      message: error.message,
      encoding: normalized,
    });
  }
  return buffer.toString('utf8');
}

function collectSetCookieValues(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

const dispatcherCache = new Map();

function getDispatcherForUrl(targetUrl, { reuse = false } = {}) {
  const proxyUri = getProxyForUrl(targetUrl);
  if (!reuse) {
    return {
      dispatcher: proxyUri ? new UndiciProxyAgent({ uri: proxyUri }) : new UndiciAgent(),
      proxyUri,
      shouldClose: true,
    };
  }

  const cacheKey = proxyUri || 'direct';
  if (!dispatcherCache.has(cacheKey)) {
    dispatcherCache.set(cacheKey, proxyUri ? new UndiciProxyAgent({ uri: proxyUri }) : new UndiciAgent());
  }
  return { dispatcher: dispatcherCache.get(cacheKey), proxyUri, shouldClose: false };
}

const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com';
const YAHOO_QUOTE_BASE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const YAHOO_QUOTE_SUMMARY_BASE_URL = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';

// Explicit per-symbol Yahoo alias overrides. Keys are case-insensitive.
const YAHOO_SYMBOL_ALIASES = new Map([
  // CBIT is a Cboe Canada (NEO) listing that Yahoo exposes as CBIT.V
  ['cbit.vn', 'CBIT.V'],
]);

function resolveYahooSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }
  const trimmed = symbol.trim();
  if (!trimmed) {
    return null;
  }
  let normalized = trimmed;
  // Apply explicit alias overrides first
  const alias = YAHOO_SYMBOL_ALIASES.get(normalized.toLowerCase());
  if (alias) {
    normalized = alias;
  }
  if (/\.U\./i.test(normalized)) {
    normalized = normalized.replace(/\.U\./gi, '-U.');
  }
  // Questrade uses .VN for symbols listed on Cboe Canada (formerly NEO).
  // Yahoo generally lists these under the .TO suffix.
  if (/\.VN$/i.test(normalized)) {
    normalized = normalized.replace(/\.VN$/i, '.TO');
  }
  return normalized;
}

async function fetchYahooHistorical(symbol, queryOptions) {
  const finance = ensureYahooFinanceClient();
  const yahooSymbol = resolveYahooSymbol(symbol);
  if (!yahooSymbol) {
    return null;
  }
  if (DEBUG_API_REQUESTS) {
    try {
      // Compact synthetic log for yahoo-finance2 (library performs its own HTTP)
      const params = Object.keys(queryOptions || {}).length ? ' params=' + JSON.stringify(queryOptions) : '';
      console.log('[api-req]', `[yahoo] GET historical ${yahooSymbol}${params}`);
    } catch (_) { /* ignore */ }
  }
  const { dispatcher } = getDispatcherForUrl(YAHOO_CHART_BASE_URL, { reuse: true });
  return finance.historical(yahooSymbol, queryOptions, {
    fetchOptions: { dispatcher },
  });
}

async function fetchYahooQuote(symbol) {
  const finance = ensureYahooFinanceClient();
  const yahooSymbol = resolveYahooSymbol(symbol);
  if (!yahooSymbol) {
    return null;
  }
  if (DEBUG_API_REQUESTS) {
    try {
      console.log('[api-req]', `[yahoo] GET quote ${yahooSymbol}`);
    } catch (_) { /* ignore */ }
  }
  const { dispatcher } = getDispatcherForUrl(YAHOO_QUOTE_BASE_URL, { reuse: true });
  return finance.quote(yahooSymbol, undefined, {
    fetchOptions: { dispatcher },
  });
}

const YAHOO_QUOTE_SUMMARY_MODULES = ['defaultKeyStatistics', 'summaryDetail', 'financialData'];

async function fetchYahooQuoteSummary(symbol, modules = YAHOO_QUOTE_SUMMARY_MODULES) {
  const finance = ensureYahooFinanceClient();
  const yahooSymbol = resolveYahooSymbol(symbol);
  if (!yahooSymbol) {
    return null;
  }
  const requestedModules = Array.isArray(modules) && modules.length ? modules : YAHOO_QUOTE_SUMMARY_MODULES;
  if (DEBUG_API_REQUESTS) {
    try {
      console.log('[api-req]', `[yahoo] GET quoteSummary ${yahooSymbol} modules=${requestedModules.join(',')}`);
    } catch (_) { /* ignore */ }
  }
  const { dispatcher } = getDispatcherForUrl(YAHOO_QUOTE_SUMMARY_BASE_URL, { reuse: true });
  return finance.quoteSummary(
    yahooSymbol,
    { modules: requestedModules },
    {
      fetchOptions: { dispatcher },
    }
  );
}

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

const DIVIDEND_YIELD_CACHE_DIR = path.join(__dirname, '..', '.cache', 'dividend-yields');
// Bump when changing how yields are computed so stale cache is ignored
const DIVIDEND_YIELD_CACHE_SCHEMA_VERSION = 3;
const DIVIDEND_YIELD_SUSPICIOUS_THRESHOLD = 8;
const DIVIDEND_YIELD_CACHE_MAX_AGE_MS = 15 * DAY_IN_MS;
const dividendYieldMemoryCache = new Map();
let dividendYieldCacheDirEnsured = false;
let dividendDependencyWarningIssued = false;

function ensureDividendYieldCacheDir() {
  if (dividendYieldCacheDirEnsured) {
    return;
  }
  try {
    fs.mkdirSync(DIVIDEND_YIELD_CACHE_DIR, { recursive: true });
  } catch (error) {
    console.warn('[Dividends] Failed to ensure dividend yield cache directory:', error?.message || String(error));
  }
  dividendYieldCacheDirEnsured = true;
}

function getDividendYieldCacheFilePath(symbolKey) {
  const hash = crypto
    .createHash('sha1')
    .update(`${DIVIDEND_YIELD_CACHE_SCHEMA_VERSION}|${symbolKey}`)
    .digest('hex');
  return path.join(DIVIDEND_YIELD_CACHE_DIR, `${hash}.json`);
}

function readDividendYieldCache(symbolKey) {
  try {
    ensureDividendYieldCacheDir();
    const filePath = getDividendYieldCacheFilePath(symbolKey);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const contents = fs.readFileSync(filePath, 'utf-8');
    if (!contents) {
      return null;
    }
    const parsed = JSON.parse(contents);
    const cachedAtRaw = parsed && (parsed.cachedAt || parsed.cached_at || parsed.cached_at_ms || parsed.cachedAtMs);
    const cachedAtMs = typeof cachedAtRaw === 'number' ? cachedAtRaw : Date.parse(cachedAtRaw || '');
    if (!Number.isFinite(cachedAtMs)) {
      return null;
    }
    const numericValue = parsed && Object.prototype.hasOwnProperty.call(parsed, 'value') ? Number(parsed.value) : null;
    const value = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
    return { cachedAt: cachedAtMs, value };
  } catch (error) {
    console.warn('[Dividends] Failed to read dividend yield cache entry:', error?.message || String(error));
    return null;
  }
}

function writeDividendYieldCache(symbolKey, entry) {
  try {
    ensureDividendYieldCacheDir();
    const payload = {
      cachedAt: new Date(entry.cachedAt).toISOString(),
      value: entry.value == null ? null : Number(entry.value),
    };
    fs.writeFileSync(getDividendYieldCacheFilePath(symbolKey), JSON.stringify(payload));
  } catch (error) {
    console.warn('[Dividends] Failed to persist dividend yield cache entry:', error?.message || String(error));
  }
}

function getCachedDividendYield(symbolKey) {
  if (!symbolKey) {
    return { hit: false, value: null };
  }
  const now = Date.now();
  const memoryEntry = dividendYieldMemoryCache.get(symbolKey) || null;
  if (memoryEntry && now - memoryEntry.cachedAt <= DIVIDEND_YIELD_CACHE_MAX_AGE_MS) {
    return { hit: true, value: memoryEntry.value };
  }
  if (memoryEntry) {
    dividendYieldMemoryCache.delete(symbolKey);
  }
  const diskEntry = readDividendYieldCache(symbolKey);
  if (diskEntry && now - diskEntry.cachedAt <= DIVIDEND_YIELD_CACHE_MAX_AGE_MS) {
    dividendYieldMemoryCache.set(symbolKey, diskEntry);
    return { hit: true, value: diskEntry.value };
  }
  return { hit: false, value: null };
}

function setCachedDividendYield(symbolKey, value) {
  if (!symbolKey) {
    return;
  }
  const numericValue = Number(value);
  const normalizedValue = Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
  const entry = { cachedAt: Date.now(), value: normalizedValue };
  dividendYieldMemoryCache.set(symbolKey, entry);
  writeDividendYieldCache(symbolKey, entry);
}

function pickFirstFiniteNumber(values) {
  if (!Array.isArray(values)) {
    return null;
  }
  for (const candidate of values) {
    if (candidate === undefined || candidate === null) {
      continue;
    }
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function pickPositiveNumber(values) {
  if (!Array.isArray(values)) {
    return null;
  }
  for (const candidate of values) {
    if (candidate === undefined || candidate === null) {
      continue;
    }
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}

function normalizeDividendYieldPercent(rawValue, referencePercent = null) {
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const normalized = numeric <= 1 ? numeric * 100 : numeric;
  const percentValue = Number(normalized.toFixed(4));
  if (!Number.isFinite(percentValue) || percentValue <= 0 || percentValue > 100) {
    return null;
  }
  if (
    Number.isFinite(referencePercent) &&
    referencePercent > 0 &&
    percentValue / referencePercent >= 8 &&
    numeric <= 1
  ) {
    const percentAsProvided = Number(numeric.toFixed(4));
    if (percentAsProvided > 0 && percentAsProvided <= 100) {
      return percentAsProvided;
    }
  }
  return percentValue;
}

function deriveDividendYieldPercentFromRate(quote, summaryDetail = null) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }
  const rate = pickPositiveNumber([
    quote.trailingAnnualDividendRate,
    summaryDetail?.trailingAnnualDividendRate,
    summaryDetail?.dividendRate,
    summaryDetail?.annualDividendRate,
  ]);
  if (!Number.isFinite(rate)) {
    return null;
  }
  const price = pickPositiveNumber([
    quote.regularMarketPrice,
    quote.postMarketPrice,
    quote.preMarketPrice,
    summaryDetail?.navPrice,
    summaryDetail?.regularMarketPreviousClose,
    summaryDetail?.previousClose,
  ]);
  if (!Number.isFinite(price)) {
    return null;
  }
  return normalizeDividendYieldPercent(rate / price);
}

// Prefer forward yield when available, fall back to trailing yield,
// and as a last resort compute from trailing dividend rate and price.
// Intentionally ignore the ambiguous Yahoo `yield` field.
function resolveDividendYieldPercentFromQuote(quote, options = {}) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }

  const summaryDetail =
    options && typeof options.summaryDetail === 'object' ? options.summaryDetail : null;
  const context = options && typeof options.context === 'object' ? options.context : null;
  const derivedFromRate = deriveDividendYieldPercentFromRate(quote, summaryDetail);
  const forwardRaw = pickFirstFiniteNumber([
    quote.dividendYield,
    summaryDetail?.dividendYield,
    summaryDetail?.yield,
  ]);
  const trailingRaw = pickFirstFiniteNumber([
    quote.trailingAnnualDividendYield,
    summaryDetail?.trailingAnnualDividendYield,
  ]);
  const summaryYield = normalizeDividendYieldPercent(summaryDetail?.yield, derivedFromRate);
  const forward = normalizeDividendYieldPercent(forwardRaw, derivedFromRate);
  const trailing = normalizeDividendYieldPercent(trailingRaw, derivedFromRate);

  if (context) {
    context.derivedFromRate = Number.isFinite(derivedFromRate) && derivedFromRate > 0 ? derivedFromRate : null;
    context.valueSource = null;
  }

  let candidate = null;
  let candidateSource = null;
  if (Number.isFinite(forward) && forward > 0 && Number.isFinite(trailing) && trailing > 0) {
    candidate = Math.min(forward, trailing);
    candidateSource = forward <= trailing ? 'forward' : 'trailing';
  } else if (Number.isFinite(forward) && forward > 0) {
    candidate = forward;
    candidateSource = 'forward';
  } else if (Number.isFinite(trailing) && trailing > 0) {
    candidate = trailing;
    candidateSource = 'trailing';
  }

  const derived = Number.isFinite(derivedFromRate) && derivedFromRate > 0 ? derivedFromRate : null;
  if (candidate !== null) {
    if (
      Number.isFinite(summaryYield) &&
      summaryYield > 0 &&
      candidate / summaryYield >= 6
    ) {
      candidate = summaryYield;
      candidateSource = 'summary';
    } else if (
      Number.isFinite(derived) &&
      derived > 0 &&
      candidate / derived >= 8
    ) {
      candidate = derived;
      candidateSource = 'derived';
    }
    if (context) {
      context.valueSource = candidateSource;
    }
    return candidate;
  }

  if (Number.isFinite(derived) && derived > 0) {
    if (context) {
      context.valueSource = 'derived';
    }
    return derived;
  }

  if (Number.isFinite(summaryYield) && summaryYield > 0) {
    if (context) {
      context.valueSource = 'summary';
    }
    return summaryYield;
  }

  return null;
}

function shouldRefineDividendYieldWithSummary(value, context) {
  if (!Number.isFinite(value) || value <= 0) {
    return false;
  }
  if (!context || (Number.isFinite(context.derivedFromRate) && context.derivedFromRate > 0)) {
    return false;
  }
  if (context.valueSource !== 'forward') {
    return false;
  }
  return value >= DIVIDEND_YIELD_SUSPICIOUS_THRESHOLD;
}

function sanitizePegDiagnosticRawValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'object') {
    const compact = {};
    if ('raw' in value) {
      compact.raw = value.raw;
    }
    if ('fmt' in value) {
      compact.fmt = value.fmt;
    }
    if ('longFmt' in value) {
      compact.longFmt = value.longFmt;
    }
    const keys = Object.keys(compact);
    if (keys.length > 0) {
      return compact;
    }
  }
  return value;
}

function selectPegMetricCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  let firstCandidate = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const { value, normalizer, source } = candidate;
    const normalized = typeof normalizer === 'function' ? normalizer(value) : null;
    const entry = {
      source: typeof source === 'string' ? source : null,
      rawValue: value,
      normalized,
    };
    if (!firstCandidate) {
      firstCandidate = entry;
    }
    if (Number.isFinite(normalized) && normalized > 0) {
      return entry;
    }
  }
  return firstCandidate;
}

function formatPegComponentDiagnostics(candidate) {
  if (!candidate) {
    return null;
  }
  const normalized = Number.isFinite(candidate.normalized) ? Number(candidate.normalized) : null;
  return {
    source: candidate.source,
    normalized,
    raw: sanitizePegDiagnosticRawValue(candidate.rawValue),
  };
}

function buildDerivedPegCandidate(quote, quoteSummary) {
  const summaryDetail = quoteSummary && typeof quoteSummary === 'object' ? quoteSummary.summaryDetail : null;
  const defaultKeyStatistics = quoteSummary && typeof quoteSummary === 'object' ? quoteSummary.defaultKeyStatistics : null;
  const financialData = quoteSummary && typeof quoteSummary === 'object' ? quoteSummary.financialData : null;

  const forwardCandidates = [
    { value: quote && quote.forwardPE, normalizer: coerceQuoteNumber, source: 'quote.forwardPE' },
    summaryDetail
      ? { value: summaryDetail.forwardPE, normalizer: coerceQuoteSummaryNumber, source: 'summaryDetail.forwardPE' }
      : null,
    defaultKeyStatistics
      ? {
          value: defaultKeyStatistics.forwardPE,
          normalizer: coerceQuoteSummaryNumber,
          source: 'defaultKeyStatistics.forwardPE',
        }
      : null,
  ];
  const growthCandidates = [
    financialData
      ? {
          value: financialData.earningsGrowth,
          normalizer: coerceQuoteSummaryNumber,
          source: 'financialData.earningsGrowth',
        }
      : null,
    defaultKeyStatistics
      ? {
          value: defaultKeyStatistics.earningsQuarterlyGrowth,
          normalizer: coerceQuoteSummaryNumber,
          source: 'defaultKeyStatistics.earningsQuarterlyGrowth',
        }
      : null,
  ];

  const forwardCandidate = selectPegMetricCandidate(forwardCandidates);
  const growthCandidate = selectPegMetricCandidate(growthCandidates);

  if (!forwardCandidate && !growthCandidate) {
    return null;
  }

  const entry = {
    source: 'derived.forwardPeOverEarningsGrowth',
    raw: {
      forwardPe: formatPegComponentDiagnostics(forwardCandidate),
      earningsGrowth: formatPegComponentDiagnostics(growthCandidate),
    },
    value: null,
  };

  const forwardNormalized = forwardCandidate && Number.isFinite(forwardCandidate.normalized) && forwardCandidate.normalized > 0
    ? Number(forwardCandidate.normalized)
    : null;
  const growthNormalized = growthCandidate && Number.isFinite(growthCandidate.normalized) && growthCandidate.normalized > 0
    ? Number(growthCandidate.normalized)
    : null;

  if (!forwardNormalized && !growthNormalized) {
    entry.reason = 'missing_inputs';
    return entry;
  }
  if (!forwardNormalized) {
    entry.reason = 'missing_forward_pe';
    return entry;
  }
  if (!growthNormalized) {
    entry.reason = 'missing_earnings_growth';
    return entry;
  }

  const growthPercent = growthNormalized < 1 ? growthNormalized * 100 : growthNormalized;
  entry.raw.growthPercent = Number.isFinite(growthPercent) ? Number(growthPercent) : null;
  if (!Number.isFinite(growthPercent) || growthPercent <= 0) {
    entry.reason = 'invalid_growth';
    return entry;
  }

  const derivedValue = forwardNormalized / growthPercent;
  if (!Number.isFinite(derivedValue) || derivedValue <= 0) {
    entry.reason = 'invalid';
    return entry;
  }

  entry.value = Number(derivedValue);
  return entry;
}

function collectPegRatioDiagnostics(quote, quoteSummary) {
  const accepted = [];
  const rejected = [];

  const consider = (rawValue, source, normalizer) => {
    const normalized = typeof normalizer === 'function' ? normalizer(rawValue) : null;
    const entry = {
      source,
      raw: sanitizePegDiagnosticRawValue(rawValue),
      value: Number.isFinite(normalized) && normalized > 0 ? Number(normalized) : null,
    };
    if (entry.value !== null) {
      accepted.push(entry);
      return;
    }
    if (rawValue === undefined || rawValue === null) {
      entry.reason = 'missing';
    } else if (typeof rawValue === 'number' || typeof entry.raw === 'number') {
      const numeric = typeof rawValue === 'number' ? rawValue : entry.raw;
      entry.reason = Number(numeric) > 0 ? 'invalid' : 'non_positive';
    } else {
      entry.reason = 'invalid';
    }
    rejected.push(entry);
  };

  if (quote && typeof quote === 'object') {
    consider(quote.trailingPegRatio, 'quote.trailingPegRatio', coerceQuoteNumber);
    consider(quote.pegRatio, 'quote.pegRatio', coerceQuoteNumber);
    consider(quote.forwardPegRatio, 'quote.forwardPegRatio', coerceQuoteNumber);
  }

  if (quoteSummary && typeof quoteSummary === 'object') {
    const summaryDetail = quoteSummary.summaryDetail;
    if (summaryDetail && typeof summaryDetail === 'object') {
      consider(summaryDetail.trailingPegRatio, 'summaryDetail.trailingPegRatio', coerceQuoteSummaryNumber);
      consider(summaryDetail.pegRatio, 'summaryDetail.pegRatio', coerceQuoteSummaryNumber);
    }
    const defaultKeyStatistics = quoteSummary.defaultKeyStatistics;
    if (defaultKeyStatistics && typeof defaultKeyStatistics === 'object') {
      consider(defaultKeyStatistics.pegRatio, 'defaultKeyStatistics.pegRatio', coerceQuoteSummaryNumber);
    }
    const financialData = quoteSummary.financialData;
    if (financialData && typeof financialData === 'object') {
      consider(financialData.pegRatio, 'financialData.pegRatio', coerceQuoteSummaryNumber);
      consider(financialData.forwardPegRatio, 'financialData.forwardPegRatio', coerceQuoteSummaryNumber);
    }
  }

  if (accepted.length === 0) {
    const derivedCandidate = buildDerivedPegCandidate(quote, quoteSummary);
    if (derivedCandidate) {
      if (Number.isFinite(derivedCandidate.value) && derivedCandidate.value > 0) {
        accepted.push(derivedCandidate);
      } else {
        if (!derivedCandidate.reason) {
          derivedCandidate.reason = 'invalid';
        }
        rejected.push(derivedCandidate);
      }
    }
  }

  return { accepted, rejected };
}

function normalizePegDiagnosticEntries(entries, stageName) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const stage = typeof stageName === 'string' ? stageName : null;
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const source = typeof entry.source === 'string' ? entry.source : null;
    const candidate = {
      stage,
      source,
      value:
        entry.value === null || entry.value === undefined || Number.isNaN(Number(entry.value))
          ? null
          : Number(entry.value),
    };
    if (entry.reason && typeof entry.reason === 'string' && entry.reason.trim()) {
      candidate.reason = entry.reason.trim();
    }
    if (entry.raw !== undefined) {
      candidate.raw = entry.raw;
    }
    normalized.push(candidate);
  }
  return normalized;
}

function selectPegResolvedCandidate(stages) {
  if (!Array.isArray(stages)) {
    return null;
  }
  for (const stage of stages) {
    if (!stage) {
      continue;
    }
    const accepted = Array.isArray(stage.accepted) ? stage.accepted : [];
    if (accepted.length === 0) {
      continue;
    }
    const candidate = accepted[0];
    if (candidate && typeof candidate === 'object') {
      return {
        stage: stage.stage || candidate.stage || null,
        candidate,
      };
    }
  }
  return null;
}

function selectPegFailureCandidate(stages) {
  if (!Array.isArray(stages)) {
    return null;
  }
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    const stage = stages[index];
    if (!stage) {
      continue;
    }
    const rejected = Array.isArray(stage.rejected) ? stage.rejected : [];
    if (rejected.length === 0) {
      continue;
    }
    let candidate = rejected.find((entry) => entry && entry.source === 'derived.forwardPeOverEarningsGrowth');
    if (!candidate) {
      candidate = rejected[0];
    }
    if (candidate && typeof candidate === 'object') {
      return {
        stage: stage.stage || candidate.stage || null,
        candidate,
      };
    }
  }
  return null;
}

function buildPegDiagnosticsContext(stages, baseContext = {}) {
  const context = {
    trailingPe:
      Number.isFinite(baseContext.trailingPe) || baseContext.trailingPe === 0
        ? Number(baseContext.trailingPe)
        : null,
    trailingPeSource:
      typeof baseContext.trailingPeSource === 'string' && baseContext.trailingPeSource.trim()
        ? baseContext.trailingPeSource.trim()
        : null,
    forwardPe:
      Number.isFinite(baseContext.forwardPe) || baseContext.forwardPe === 0
        ? Number(baseContext.forwardPe)
        : null,
    forwardPeSource:
      typeof baseContext.forwardPeSource === 'string' && baseContext.forwardPeSource.trim()
        ? baseContext.forwardPeSource.trim()
        : null,
    earningsGrowth:
      Number.isFinite(baseContext.earningsGrowth) || baseContext.earningsGrowth === 0
        ? Number(baseContext.earningsGrowth)
        : null,
    earningsGrowthPercent:
      Number.isFinite(baseContext.earningsGrowthPercent) || baseContext.earningsGrowthPercent === 0
        ? Number(baseContext.earningsGrowthPercent)
        : null,
    earningsGrowthSource:
      typeof baseContext.earningsGrowthSource === 'string' && baseContext.earningsGrowthSource.trim()
        ? baseContext.earningsGrowthSource.trim()
        : null,
  };

  if (!Array.isArray(stages)) {
    return context;
  }

  for (const stage of stages) {
    if (!stage) {
      continue;
    }
    const candidates = [];
    if (Array.isArray(stage.accepted)) {
      candidates.push(...stage.accepted);
    }
    if (Array.isArray(stage.rejected)) {
      candidates.push(...stage.rejected);
    }
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }
      if (candidate.source !== 'derived.forwardPeOverEarningsGrowth') {
        continue;
      }
      const raw = candidate.raw && typeof candidate.raw === 'object' ? candidate.raw : null;
      if (!raw) {
        continue;
      }
      const forwardPe = raw.forwardPe && typeof raw.forwardPe === 'object' ? raw.forwardPe : null;
      if (
        forwardPe &&
        Number.isFinite(forwardPe.normalized) &&
        (context.forwardPe === null || context.forwardPe === undefined)
      ) {
        context.forwardPe = Number(forwardPe.normalized);
      }
      if (forwardPe && typeof forwardPe.source === 'string' && forwardPe.source.trim() && !context.forwardPeSource) {
        context.forwardPeSource = forwardPe.source.trim();
      }
      const earningsGrowth = raw.earningsGrowth && typeof raw.earningsGrowth === 'object' ? raw.earningsGrowth : null;
      if (
        earningsGrowth &&
        Number.isFinite(earningsGrowth.normalized) &&
        (context.earningsGrowth === null || context.earningsGrowth === undefined)
      ) {
        context.earningsGrowth = Number(earningsGrowth.normalized);
      }
      if (
        earningsGrowth &&
        typeof earningsGrowth.source === 'string' &&
        earningsGrowth.source.trim() &&
        !context.earningsGrowthSource
      ) {
        context.earningsGrowthSource = earningsGrowth.source.trim();
      }
      if (
        raw.growthPercent !== undefined &&
        raw.growthPercent !== null &&
        Number.isFinite(Number(raw.growthPercent)) &&
        (context.earningsGrowthPercent === null || context.earningsGrowthPercent === undefined)
      ) {
        context.earningsGrowthPercent = Number(raw.growthPercent);
      }
    }
  }

  return context;
}

function buildPegDiagnosticsPayload(stages, baseContext) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return null;
  }

  const normalizedStages = stages.map((stage) => {
    if (!stage || typeof stage !== 'object') {
      return null;
    }
    const stageName = typeof stage.stage === 'string' && stage.stage.trim() ? stage.stage.trim() : null;
    const normalizedStage = {
      stage: stageName,
      accepted: normalizePegDiagnosticEntries(stage.accepted, stageName),
      rejected: normalizePegDiagnosticEntries(stage.rejected, stageName),
    };
    if (stage.error && typeof stage.error === 'string' && stage.error.trim()) {
      normalizedStage.error = stage.error.trim();
    }
    return normalizedStage;
  }).filter(Boolean);

  if (normalizedStages.length === 0) {
    return null;
  }

  const resolved = selectPegResolvedCandidate(normalizedStages);
  const failure = resolved ? null : selectPegFailureCandidate(normalizedStages);
  const context = buildPegDiagnosticsContext(normalizedStages, baseContext);

  return {
    stages: normalizedStages,
    resolved,
    failure,
    context,
  };
}

function logPegDebug(symbol, stage, payloadFactory) {
  if (!DEBUG_YAHOO_PEG) {
    return;
  }
  try {
    const payload = typeof payloadFactory === 'function' ? payloadFactory() : payloadFactory;
    const debugPayload = {
      symbol,
      stage,
      payload,
    };
    const inspected = util.inspect(debugPayload, {
      depth: null,
      colors: false,
      compact: false,
      breakLength: 120,
      maxArrayLength: null,
    });
    console.log('[peg-debug]', inspected);
  } catch (logError) {
    console.warn('[peg-debug]', 'Failed to emit PEG debug output', symbol, stage, logError?.message || logError);
  }
}

async function fetchDividendYieldMap(symbolEntries) {
  if (!Array.isArray(symbolEntries) || symbolEntries.length === 0) {
    return new Map();
  }
  const results = new Map();
  await mapWithConcurrency(symbolEntries, Math.min(4, symbolEntries.length), async function (entry) {
    if (!entry || !entry.normalizedSymbol) {
      return null;
    }
    const { normalizedSymbol, rawSymbol } = entry;
    const cached = getCachedDividendYield(normalizedSymbol);
    if (cached.hit) {
      if (Number.isFinite(cached.value) && cached.value > 0) {
        results.set(normalizedSymbol, cached.value);
      }
      return null;
    }
    if (!rawSymbol) {
      setCachedDividendYield(normalizedSymbol, null);
      return null;
    }
    try {
      const quote = await fetchYahooQuote(rawSymbol);
      const dividendContext = {};
      let dividendYieldPercent = resolveDividendYieldPercentFromQuote(quote, { context: dividendContext });
      if (shouldRefineDividendYieldWithSummary(dividendYieldPercent, dividendContext)) {
        try {
          const summary = await fetchYahooQuoteSummary(rawSymbol, ['summaryDetail']);
          const summaryDetail =
            summary && typeof summary.summaryDetail === 'object' ? summary.summaryDetail : null;
          if (summaryDetail) {
            dividendYieldPercent = resolveDividendYieldPercentFromQuote(quote, { summaryDetail });
          }
        } catch (summaryError) {
          const message = summaryError?.message || String(summaryError);
          console.warn(`[Dividends] Failed to refine dividend yield for ${normalizedSymbol}:`, message);
        }
      }
      setCachedDividendYield(normalizedSymbol, dividendYieldPercent);
      if (Number.isFinite(dividendYieldPercent) && dividendYieldPercent > 0) {
        results.set(normalizedSymbol, dividendYieldPercent);
      }
    } catch (error) {
      if (error instanceof MissingYahooDependencyError || error?.code === 'MISSING_DEPENDENCY') {
        if (!dividendDependencyWarningIssued) {
          dividendDependencyWarningIssued = true;
          console.warn('[Dividends] Yahoo Finance dependency unavailable; dividend yields will be omitted.');
        }
      } else {
        const message = error?.message || String(error);
        console.warn(`[Dividends] Failed to fetch dividend yield for ${normalizedSymbol}:`, message);
      }
      setCachedDividendYield(normalizedSymbol, null);
    }
    return null;
  });
  return results;
}

const BENCHMARK_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const benchmarkReturnCache = new Map();
const interestRateCache = new Map();
const priceHistoryCache = new Map();
const PRICE_HISTORY_CACHE_MAX_ENTRIES = 200;
// Cache of Questrade symbol details keyed by `${loginId}|${symbolId}` to avoid
// repeated /v1/symbols lookups when data was already fetched during summary.
const symbolDetailsCache = new Map();

function getSymbolDetailsCacheKey(loginId, symbolId) {
  if (!loginId || !Number.isFinite(symbolId)) return null;
  return `${loginId}|${symbolId}`;
}

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

function ensureOpenAiClient() {
  if (openAiClientInitError) {
    throw openAiClientInitError;
  }
  if (!OPENAI_API_KEY) {
    return null;
  }
  if (!openAiClient) {
    try {
      openAiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      openAiClientInitError = normalizedError;
      throw normalizedError;
    }
  }
  return openAiClient;
}

function normalizeNewsSymbols(symbols) {
  if (!Array.isArray(symbols)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < symbols.length; index += 1) {
    const normalizedSymbol = normalizeSymbol(symbols[index]);
    if (!normalizedSymbol || seen.has(normalizedSymbol)) {
      continue;
    }
    seen.add(normalizedSymbol);
    normalized.push(normalizedSymbol);
    if (normalized.length >= MAX_NEWS_SYMBOLS) {
      break;
    }
  }
  return normalized;
}

function buildNewsCacheKey(accountKey, symbols) {
  const normalizedAccountKey = typeof accountKey === 'string' ? accountKey.trim() : '';
  return `${normalizedAccountKey || 'portfolio'}|${symbols.join('|')}`;
}

function extractOpenAiResponseText(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }
  if (typeof response.output_text === 'string') {
    return response.output_text;
  }
  if (Array.isArray(response.output_text)) {
    for (let index = 0; index < response.output_text.length; index += 1) {
      const entry = response.output_text[index];
      if (typeof entry === 'string' && entry.trim()) {
        return entry;
      }
    }
  }
  if (Array.isArray(response.output)) {
    for (let i = 0; i < response.output.length; i += 1) {
      const outputEntry = response.output[i];
      if (!outputEntry || typeof outputEntry !== 'object' || !Array.isArray(outputEntry.content)) {
        continue;
      }
      for (let j = 0; j < outputEntry.content.length; j += 1) {
        const contentEntry = outputEntry.content[j];
        if (!contentEntry || typeof contentEntry !== 'object') {
          continue;
        }
        if (typeof contentEntry.text === 'string' && contentEntry.text.trim()) {
          return contentEntry.text;
        }
        if (contentEntry.text && typeof contentEntry.text === 'object') {
          const val = contentEntry.text.value || contentEntry.text.text || null;
          if (typeof val === 'string' && val.trim()) {
            return val;
          }
          try {
            return JSON.stringify(contentEntry.text);
          } catch {
            // ignore
          }
        }
        if (typeof contentEntry.output_text === 'string' && contentEntry.output_text.trim()) {
          return contentEntry.output_text;
        }
        // Some Responses API variants return structured JSON content for json_schema
        // formatted requests. Capture it and stringify so downstream JSON.parse works.
        if (contentEntry.json && typeof contentEntry.json === 'object') {
          try {
            return JSON.stringify(contentEntry.json);
          } catch {
            // ignore stringify errors and continue
          }
        }
        if (contentEntry.output_json && typeof contentEntry.output_json === 'object') {
          try {
            return JSON.stringify(contentEntry.output_json);
          } catch {
            // ignore
          }
        }
        if (contentEntry.type === 'json' && contentEntry.value && typeof contentEntry.value === 'object') {
          try {
            return JSON.stringify(contentEntry.value);
          } catch {
            // ignore
          }
        }
      }
    }
  }
  if (Array.isArray(response.choices) && response.choices.length) {
    const firstChoice = response.choices[0];
    if (firstChoice && firstChoice.message) {
      const message = firstChoice.message;
      if (typeof message.content === 'string' && message.content.trim()) {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        for (let index = 0; index < message.content.length; index += 1) {
          const part = message.content[index];
          if (part && typeof part.text === 'string' && part.text.trim()) {
            return part.text;
          }
        }
      }
    }
  }
  return null;
}

function extractOpenAiResponseJson(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }
  // Walk the modern Responses API shape
  if (Array.isArray(response.output)) {
    for (let i = 0; i < response.output.length; i += 1) {
      const outputEntry = response.output[i];
      if (!outputEntry || typeof outputEntry !== 'object' || !Array.isArray(outputEntry.content)) {
        continue;
      }
      for (let j = 0; j < outputEntry.content.length; j += 1) {
        const contentEntry = outputEntry.content[j];
        if (!contentEntry || typeof contentEntry !== 'object') {
          continue;
        }
        // Structured JSON content entries
        if (contentEntry.type === 'output_json' && contentEntry.json && typeof contentEntry.json === 'object') {
          return contentEntry.json;
        }
        if (contentEntry.json && typeof contentEntry.json === 'object') {
          return contentEntry.json;
        }
        if (contentEntry.output_json && typeof contentEntry.output_json === 'object') {
          return contentEntry.output_json;
        }
        if (contentEntry.type === 'json' && contentEntry.value && typeof contentEntry.value === 'object') {
          return contentEntry.value;
        }
        // Some SDKs wrap content under a message
        if (contentEntry.message && typeof contentEntry.message === 'object') {
          const msg = contentEntry.message;
          if (msg.parsed && typeof msg.parsed === 'object') {
            return msg.parsed;
          }
          if (Array.isArray(msg.content)) {
            for (let k = 0; k < msg.content.length; k += 1) {
              const part = msg.content[k];
              if (part && typeof part === 'object') {
                if (part.type === 'output_json' && part.json && typeof part.json === 'object') {
                  return part.json;
                }
                if (part.json && typeof part.json === 'object') {
                  return part.json;
                }
              }
            }
          }
        }
      }
    }
  }
  // Legacy chat-like choices
  if (Array.isArray(response.choices) && response.choices.length) {
    const first = response.choices[0];
    const message = first && first.message;
    if (message && typeof message === 'object') {
      if (message.parsed && typeof message.parsed === 'object') {
        return message.parsed;
      }
      if (Array.isArray(message.content)) {
        for (let idx = 0; idx < message.content.length; idx += 1) {
          const part = message.content[idx];
          if (part && typeof part === 'object') {
            if (part.type === 'output_json' && part.json && typeof part.json === 'object') {
              return part.json;
            }
            if (part.json && typeof part.json === 'object') {
              return part.json;
            }
          }
        }
      }
    }
  }
  return null;
}

function normalizeNewsArticle(article) {
  if (!article || typeof article !== 'object') {
    return null;
  }
  const title = typeof article.title === 'string' ? article.title.trim() : '';
  const url = typeof article.url === 'string' ? article.url.trim() : '';
  if (!title || !url) {
    return null;
  }
  const summary = typeof article.summary === 'string' ? article.summary.trim() : '';
  const source = typeof article.source === 'string' ? article.source.trim() : '';
  const publishedRaw =
    typeof article.published_at === 'string'
      ? article.published_at.trim()
      : typeof article.publishedAt === 'string'
        ? article.publishedAt.trim()
        : '';
  return {
    title,
    url,
    summary: summary || null,
    source: source || null,
    publishedAt: publishedRaw || null,
  };
}

// Basic HTML entity decoding for titles/descriptions from RSS feeds.
function decodeHtmlEntities(input) {
  if (typeof input !== 'string' || !input) {
    return '';
  }
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtmlTags(input) {
  if (typeof input !== 'string' || !input) {
    return '';
  }
  return input.replace(/<[^>]*>/g, '');
}

function parseGoogleNewsRss(xml) {
  const content = typeof xml === 'string' ? xml : '';
  if (!content) {
    return [];
  }
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(content)) !== null) {
    const itemXml = match[1];
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(itemXml);
    const linkMatch = /<link>([\s\S]*?)<\/link>/i.exec(itemXml);
    const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(itemXml);
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(itemXml);

    const rawTitle = titleMatch ? decodeHtmlEntities(stripHtmlTags(titleMatch[1]).trim()) : '';
    const rawLink = linkMatch ? stripHtmlTags(linkMatch[1]).trim() : '';
    const publishedAt = pubDateMatch ? stripHtmlTags(pubDateMatch[1]).trim() : '';
    const source = sourceMatch ? decodeHtmlEntities(stripHtmlTags(sourceMatch[1]).trim()) : '';

    if (!rawTitle || !rawLink) {
      continue;
    }

    // Try to resolve the original URL if Google adds a redirect layer.
    let url = rawLink;
    try {
      const urlObj = new URL(rawLink);
      const real = urlObj.searchParams.get('url');
      if (real) {
        url = real;
      }
    } catch {
      // Keep the raw link if URL parsing fails.
    }

    // Titles in Google News often end with " - Source"; prefer the explicit source element when present.
    let title = rawTitle;
    const dashIdx = title.lastIndexOf(' - ');
    if (dashIdx > 0 && (!source || title.slice(dashIdx + 3).toLowerCase() === source.toLowerCase())) {
      title = title.slice(0, dashIdx);
    }

    items.push({
      title,
      url,
      summary: null,
      source: source || null,
      publishedAt: publishedAt || null,
    });
  }
  return items;
}

async function fetchPortfolioNewsFromFeeds(params) {
  const { symbols } = params || {};
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { articles: [], disclaimer: null };
  }
  // Build a single Google News RSS query to minimize requests.
  const query = `${symbols.join(' OR ')} when:14d`;
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'en-US');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('ceid', 'US:en');

  let response;
  try {
    response = await performUndiciApiRequest({ url: url.toString() });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }

  const xml = typeof response?.data === 'string' ? response.data : '';
  const allArticles = parseGoogleNewsRss(xml);
  // De-duplicate by URL/title and cap to 8 items, most recent first (feed is already ordered by time).
  const seen = new Set();
  const unique = [];
  for (const article of allArticles) {
    const key = (article.url || '') + '|' + (article.title || '');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(article);
    if (unique.length >= 8) {
      break;
    }
  }

  return {
    articles: unique,
    disclaimer:
      unique.length
        ? 'Headlines via Google News RSS. Summaries not generated.'
        : null,
  };
}

async function fetchPortfolioNewsFromOpenAi(params) {
  const { accountLabel, symbols } = params || {};
  const client = params && params.client ? params.client : ensureOpenAiClient();
  if (!client) {
    const error = new Error('OpenAI API key not configured');
    error.code = 'OPENAI_NOT_CONFIGURED';
    throw error;
  }
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return { articles: [], disclaimer: null };
  }

  const trimmedLabel = typeof accountLabel === 'string' ? accountLabel.trim() : '';
  // Structured output format for Responses API using text.format
  const structuredTextFormat = {
    type: 'json_schema',
    name: 'portfolio_news',
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          articles: {
            type: 'array',
            maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'url', 'summary', 'source', 'publishedAt'],
            properties: {
              title: { type: 'string' },
              url: { type: 'string' },
              summary: { type: 'string' },
              source: { type: 'string' },
              publishedAt: { type: 'string' },
            },
          },
          },
          disclaimer: { type: 'string' },
        },
        required: ['articles', 'disclaimer'],
      },
  };

  const torontoTodayKey = getTorontoDateKey(new Date());

  const baseRequest = {
    model: OPENAI_NEWS_MODEL,
    reasoning: { effort: 'low' },
    max_output_tokens: 1100,
    instructions:
      'You are a portfolio research assistant. Use the web_search tool when helpful to gather the most recent, reputable news articles or posts about the provided securities. Respond with concise JSON summaries. ' +
      'Return ONLY articles published on the current date in the America/Toronto timezone. If no qualifying articles exist, return an empty list. Ensure each article has title, direct URL, source, and publishedAt in ISO 8601.',
    input: [
      `Account label: ${trimmedLabel || 'Portfolio'}`,
      `Stock symbols: ${symbols.join(', ')}`,
      `Today (America/Toronto): ${torontoTodayKey}`,
      'Task: Find up to eight relevant and timely news articles or notable posts published TODAY (not older) that mention these tickers. Prioritize reputable financial publications, company announcements, and influential analysis.',
      'For each article provide the title, a direct URL, the publisher/source when available, the publication date (ISO 8601 preferred), and a concise summary under 60 words.',
    ].join('\n'),
  };

  // Optional tools (e.g., web_search) via env: OPENAI_NEWS_TOOLS=web_search
  let requestWithTools = baseRequest;
  const toolsEnv = (process.env.OPENAI_NEWS_TOOLS || '').toLowerCase();
  if (toolsEnv.includes('web_search')) {
    requestWithTools = { ...baseRequest, tools: [{ type: 'web_search' }] };
  }

  // Capture the exact composed prompt text used for the OpenAI call.
  // This mirrors the content sent via the `instructions` and `input` fields.
  const composedPromptText = `${baseRequest.instructions}\n\n${baseRequest.input}`;

  function shouldRetryWithLegacyResponseFormat(requestError) {
    if (!requestError || typeof requestError !== 'object') {
      return false;
    }
    const statusCode = Number(requestError.status || requestError.statusCode || requestError.code || 0);
    if (statusCode && statusCode !== 400) {
      return false;
    }
    const messageParts = [];
    if (typeof requestError.message === 'string') {
      messageParts.push(requestError.message);
    }
    if (requestError.error && typeof requestError.error === 'object') {
      if (typeof requestError.error.message === 'string') {
        messageParts.push(requestError.error.message);
      }
      if (typeof requestError.error.param === 'string') {
        messageParts.push(requestError.error.param);
      }
    }
    if (!messageParts.length) {
      return false;
    }
    const normalizedMessage = messageParts.join(' ').toLowerCase();
    // Only retry with legacy response_format if the API complains that
    // the 'text' or 'text.format' parameter is unknown or invalid.
    // Do NOT retry if the error mentions response_format (that implies
    // we should be using text.format already).
    if (normalizedMessage.includes('response_format')) {
      return false;
    }
    return (
      normalizedMessage.includes("unknown parameter: 'text'") ||
      normalizedMessage.includes('unknown parameter: text') ||
      normalizedMessage.includes('unrecognized parameter "text"') ||
      normalizedMessage.includes('text.format is not supported') ||
      normalizedMessage.includes('text.format unknown') ||
      normalizedMessage.includes('text format unknown')
    );
  }

  function rethrowAsOpenAiError(requestError) {
    if (requestError && typeof requestError === 'object') {
      const status = requestError.status || requestError.code;
      if (status === 401 || status === 403) {
        const wrapped = new Error('OpenAI request was not authorized');
        wrapped.code = 'OPENAI_UNAUTHORIZED';
        throw wrapped;
      }
      if (status === 429) {
        const wrapped = new Error('OpenAI rate limit exceeded');
        wrapped.code = 'OPENAI_RATE_LIMIT';
        throw wrapped;
      }
    }
    throw requestError instanceof Error ? requestError : new Error(String(requestError));
  }

  let response;
  try {
    response = await client.responses.create({
      ...requestWithTools,
      response_format: {
        type: 'json_schema',
        json_schema: { name: structuredTextFormat.name, schema: structuredTextFormat.schema },
      },
    });
  } catch (error) {
    function shouldRetryWithoutTools(requestError) {
      const msg = [
        requestError?.message,
        requestError?.error?.message,
        requestError?.error?.param,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!msg) return false;
      return (
        msg.includes('web_search') ||
        msg.includes('unknown tool') ||
        msg.includes('tools are not supported') ||
        msg.includes('invalid parameter: tools') ||
        msg.includes('does not support tools')
      );
    }

    function shouldRetryWithTextFormat(requestError) {
      const msg = [
        requestError?.message,
        requestError?.error?.message,
        requestError?.error?.param,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!msg) return false;
      return (
        msg.includes('response_format') &&
        (msg.includes('unknown parameter') || msg.includes('not supported') || msg.includes('unrecognized') || msg.includes('unsupported') || msg.includes('moved to'))
      );
    }

    if (shouldRetryWithoutTools(error)) {
      try {
        response = await client.responses.create({
          ...baseRequest,
          tools: undefined,
          response_format: {
            type: 'json_schema',
            json_schema: { name: structuredTextFormat.name, schema: structuredTextFormat.schema },
          },
        });
      } catch (toolError) {
        rethrowAsOpenAiError(toolError);
      }
    } else if (shouldRetryWithTextFormat(error)) {
      try {
        response = await client.responses.create({
          ...requestWithTools,
          text: { format: structuredTextFormat },
        });
      } catch (textError) {
        rethrowAsOpenAiError(textError);
      }
    } else {
      rethrowAsOpenAiError(error);
    }
  }

  if (process.env.DEBUG_OPENAI_NEWS === '1') {
    try {
      const summary = {
        model: response?.model,
        usage: response?.usage,
        output_text: typeof response?.output_text === 'string' ? response.output_text.slice(0, 200) : null,
        output_first:
          Array.isArray(response?.output) && response.output.length
            ? response.output[0]
            : null,
        choices_first:
          Array.isArray(response?.choices) && response.choices.length ? response.choices[0] : null,
      };
      console.log('[OpenAI][news][debug] response summary:', JSON.stringify(summary, null, 2));
    } catch (e) {
      console.warn('[OpenAI][news][debug] Failed to summarize response', e);
    }
  }

  // Prefer structured JSON extraction; fall back to parsing text output. If still empty, retry with a fallback model.
  async function parseOrNull(resp) {
    let structured = extractOpenAiResponseJson(resp);
    if (structured) {
      try {
        return { parsed: structured, raw: JSON.stringify(structured) };
      } catch {
        return { parsed: structured, raw: null };
      }
    }
    const rawText = extractOpenAiResponseText(resp);
    if (!rawText) {
      return null;
    }
    try {
      const obj = JSON.parse(rawText);
      return { parsed: obj, raw: rawText };
    } catch {
      const text = String(rawText);
      const fenceMatch = /```(?:json)?\n([\s\S]*?)```/i.exec(text);
      const candidate = fenceMatch ? fenceMatch[1] : text;
      let start = candidate.indexOf('{');
      if (start !== -1) {
        let depth = 0;
        for (let i = start; i < candidate.length; i += 1) {
          const ch = candidate[i];
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              const slice = candidate.slice(start, i + 1);
              try {
                const obj = JSON.parse(slice);
                return { parsed: obj, raw: slice };
              } catch {}
            }
          }
        }
      }
      return null;
    }
  }

  let parsedPayload = await parseOrNull(response);
  if (!parsedPayload) {
    try {
      const fallbackResponse = await client.responses.create({
        ...requestWithTools,
        model: OPENAI_NEWS_FALLBACK_MODEL,
        text: { format: structuredTextFormat },
      });
      parsedPayload = await parseOrNull(fallbackResponse);
      if (!parsedPayload) {
        throw new Error('OpenAI response did not contain any text output');
      }
      response = fallbackResponse;
    } catch (fallbackErr) {
      if (process.env.DEBUG_OPENAI_NEWS === '1') {
        try {
          const fs = require('fs');
          const path = require('path');
          const outPath = path.join(__dirname, '..', '.openai-news-response.json');
          fs.writeFileSync(outPath, JSON.stringify(response, null, 2), 'utf-8');
          console.error('[OpenAI][news][debug] Fallback failed; wrote raw response to', outPath);
        } catch {}
      }
      throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
    }
  }

  const parsed = parsedPayload.parsed;
  const outputText = parsedPayload.raw;

  const rawArticles = Array.isArray(parsed.articles) ? parsed.articles : [];
  const allArticles = rawArticles.map(normalizeNewsArticle).filter(Boolean);
  const todayKey = torontoTodayKey;
  const articles = allArticles.filter((a) => {
    if (!a || !a.publishedAt) {
      return false;
    }
    const key = getTorontoDateKey(a.publishedAt);
    return key === todayKey;
  });
  const disclaimer = typeof parsed.disclaimer === 'string' ? parsed.disclaimer.trim() : '';

  // Token usage and cost estimation
  const usage = (response && typeof response === 'object' && response.usage) || null;
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens);
  const safeInputTokens = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : null;
  const safeOutputTokens = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : null;
  const usedModel = (response && response.model) || OPENAI_NEWS_MODEL;
  const pricing = getNewsModelPricing(usedModel);
  const cost = { inputUsd: null, outputUsd: null, totalUsd: null };
  if (
    pricing && pricing.input !== null && pricing.output !== null &&
    safeInputTokens !== null && safeOutputTokens !== null
  ) {
    const inputUsd = (safeInputTokens * pricing.input) / 1_000_000;
    const outputUsd = (safeOutputTokens * pricing.output) / 1_000_000;
    cost.inputUsd = Number(inputUsd.toFixed(6));
    cost.outputUsd = Number(outputUsd.toFixed(6));
    cost.totalUsd = Number((inputUsd + outputUsd).toFixed(6));
  }

  return {
    articles,
    disclaimer: disclaimer || null,
    prompt: composedPromptText,
    rawOutput: outputText,
    usage: {
      inputTokens: safeInputTokens,
      outputTokens: safeOutputTokens,
      totalTokens:
        safeInputTokens !== null && safeOutputTokens !== null ? safeInputTokens + safeOutputTokens : null,
    },
    pricing: { model: usedModel, inputPerMillionUsd: pricing.input, outputPerMillionUsd: pricing.output },
    cost,
  };
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

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const exclusiveEnd = addDays(end, 1) || end;

  let history = null;
  try {
    history = await fetchYahooHistorical(symbol, {
      period1: start,
      period2: exclusiveEnd,
      interval: '1d',
    });
  } catch (error) {
    history = null;
  }

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

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const exclusiveEnd = addDays(end, 1) || end;

  let history = null;
  try {
    history = await fetchYahooHistorical(symbol, {
      period1: start,
      period2: exclusiveEnd,
      interval: '1d',
    });
  } catch (error) {
    history = null;
  }

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

function coerceQuoteSummaryNumber(value) {
  const direct = coerceQuoteNumber(value);
  if (direct !== null) {
    return direct;
  }
  if (value && typeof value === 'object') {
    if ('raw' in value) {
      const raw = coerceQuoteNumber(value.raw);
      if (raw !== null) {
        return raw;
      }
    }
    if ('fmt' in value) {
      const formatted = coerceQuoteNumber(value.fmt);
      if (formatted !== null) {
        return formatted;
      }
    }
    if ('longFmt' in value) {
      const longFormatted = coerceQuoteNumber(value.longFmt);
      if (longFormatted !== null) {
        return longFormatted;
      }
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

function normalizePlanningContext(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function normalizeAccountGroupName(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = typeof value === 'string' ? value : String(value);
  const normalized = stringValue.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

// NOTE: assignAccountGroups is now provided by ./grouping for testability.
function __assignAccountGroupsInternalUnused(accounts, options) {
  const opts = options || {};
  const groupRelationsRaw = opts.groupRelations || null; // { childName: [parentName, ...] }
  const groupsByKey = new Map();
  const groupsById = new Map();
  const usedSlugs = new Set();
  const displayNameByKey = new Map(); // lowercased key -> display name

  accounts.forEach((account) => {
    if (!account) {
      return;
    }
    const groupName = normalizeAccountGroupName(account.accountGroup);
    if (!groupName) {
      account.accountGroup = null;
      account.accountGroupId = null;
      return;
    }

    const key = groupName.toLowerCase();
    let group = groupsByKey.get(key);
    if (!group) {
      const baseSlug = slugifyAccountGroupKey(groupName);
      let slug = baseSlug;
      let suffix = 2;
      while (usedSlugs.has(slug)) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }
      usedSlugs.add(slug);
      const id = `group:${slug}`;
      group = { id, name: groupName, accounts: [] };
      groupsByKey.set(key, group);
      groupsById.set(id, group);
      displayNameByKey.set(key, groupName);
    }

    group.accounts.push(account);
    account.accountGroup = groupName;
    account.accountGroupId = group.id;
  });

  // If group relations are provided (child -> [parent,...]), synthesize parent groups by aggregating
  // accounts from descendant groups.
  if (groupRelationsRaw && typeof groupRelationsRaw === 'object') {
    // Normalize relations: childKey (lowercased) -> Set(parentKey)
    const childToParents = new Map();
    Object.entries(groupRelationsRaw).forEach(([rawChild, rawParents]) => {
      const childName = normalizeAccountGroupName(rawChild);
      const childKey = childName ? childName.toLowerCase() : null;
      const parentList = Array.isArray(rawParents) ? rawParents : [];
      if (!childKey) {
        return;
      }
      let set = childToParents.get(childKey);
      if (!set) {
        set = new Set();
        childToParents.set(childKey, set);
      }
      displayNameByKey.set(childKey, displayNameByKey.get(childKey) || childName);
      parentList.forEach((rawParent) => {
        const parentName = normalizeAccountGroupName(rawParent);
        const parentKey = parentName ? parentName.toLowerCase() : null;
        if (!parentKey) {
          return;
        }
        set.add(parentKey);
        displayNameByKey.set(parentKey, displayNameByKey.get(parentKey) || parentName);
      });
    });

    // Build reverse mapping: parentKey -> Set(childKey)
    const parentToChildren = new Map();
    childToParents.forEach((parents, childKey) => {
      parents.forEach((parentKey) => {
        let children = parentToChildren.get(parentKey);
        if (!children) {
          children = new Set();
          parentToChildren.set(parentKey, children);
        }
        children.add(childKey);
      });
    });

    // Helper to get transitive descendants of a parent
    const getDescendants = (parentKey) => {
      const result = new Set();
      const queue = [];
      const seen = new Set();
      const direct = parentToChildren.get(parentKey);
      if (direct) {
        direct.forEach((c) => queue.push(c));
      }
      while (queue.length) {
        const child = queue.shift();
        if (seen.has(child)) {
          continue;
        }
        seen.add(child);
        result.add(child);
        const next = parentToChildren.get(child);
        if (next) {
          next.forEach((n) => queue.push(n));
        }
      }
      return result;
    };

    // For each parent, aggregate accounts from all descendant groups (and include direct members if any)
    parentToChildren.forEach((childrenSet, parentKey) => {
      const parentName = displayNameByKey.get(parentKey) || parentKey;
      // Ensure parent group exists with stable id
      let parentGroup = groupsByKey.get(parentKey);
      if (!parentGroup) {
        const baseSlug = slugifyAccountGroupKey(parentName);
        let slug = baseSlug;
        let suffix = 2;
        while (usedSlugs.has(slug)) {
          slug = `${baseSlug}-${suffix}`;
          suffix += 1;
        }
        usedSlugs.add(slug);
        const id = `group:${slug}`;
        parentGroup = { id, name: parentName, accounts: [] };
        groupsByKey.set(parentKey, parentGroup);
        groupsById.set(id, parentGroup);
        displayNameByKey.set(parentKey, parentName);
      }

      const accountsSet = new Map(); // id -> account

      // Include any direct members of the parent (if a base group already existed)
      const maybeExisting = groupsByKey.get(parentKey);
      if (maybeExisting && Array.isArray(maybeExisting.accounts)) {
        maybeExisting.accounts.forEach((acc) => {
          if (acc && acc.id) {
            accountsSet.set(acc.id, acc);
          }
        });
      }

      const allDescendants = getDescendants(parentKey);
      allDescendants.forEach((childKey) => {
        const childGroup = groupsByKey.get(childKey);
        if (!childGroup || !Array.isArray(childGroup.accounts)) {
          return;
        }
        childGroup.accounts.forEach((acc) => {
          if (acc && acc.id) {
            accountsSet.set(acc.id, acc);
          }
        });
      });

      const aggregated = Array.from(accountsSet.values());
      if (aggregated.length) {
        parentGroup.accounts = aggregated;
      }
    });
  }

  const accountGroups = Array.from(groupsById.values()).map((group) => {
    const ownerLabels = new Set();
    const accountNumbers = new Set();
    group.accounts.forEach((account) => {
      if (!account) {
        return;
      }
      if (typeof account.ownerLabel === 'string') {
        const label = account.ownerLabel.trim();
        if (label) {
          ownerLabels.add(label);
        }
      }
      if (account.number !== undefined && account.number !== null) {
        const number = String(account.number).trim();
        if (number) {
          accountNumbers.add(number);
        }
      }
    });
    return {
      id: group.id,
      name: group.name,
      accounts: group.accounts,
      memberCount: group.accounts.length,
      accountIds: group.accounts.map((account) => account.id),
      accountNumbers: Array.from(accountNumbers),
      ownerLabels: Array.from(ownerLabels),
    };
  });

  accountGroups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return { accountGroups, accountGroupsById: groupsById };
}

function applyAccountSettingsOverrideToAccount(target, override) {
  if (!target || override === undefined) {
    return;
  }

  if (override === null) {
    return;
  }

  if (typeof override === 'boolean') {
    target.showQQQDetails = override;
    return;
  }

  if (!override || typeof override !== 'object') {
    return;
  }

  if (typeof override.showQQQDetails === 'boolean') {
    target.showQQQDetails = override.showQQQDetails;
  }

  let normalizedInvestmentModels = [];
  if (Object.prototype.hasOwnProperty.call(override, 'investmentModels')) {
    normalizedInvestmentModels = normalizeInvestmentModelList(override.investmentModels);
    if (normalizedInvestmentModels.length) {
      target.investmentModels = normalizedInvestmentModels;
    }
  }

  if (typeof override.investmentModel === 'string') {
    const trimmedModel = override.investmentModel.trim();
    if (trimmedModel) {
      target.investmentModel = trimmedModel;
    }
  } else if (normalizedInvestmentModels.length && normalizedInvestmentModels[0].model) {
    target.investmentModel = normalizedInvestmentModels[0].model;
  }

  if (target.rebalancePeriod === undefined && normalizedInvestmentModels.length) {
    const withPeriod = normalizedInvestmentModels.find((entry) => {
      return Number.isFinite(entry.rebalancePeriod);
    });
    if (withPeriod) {
      target.rebalancePeriod = withPeriod.rebalancePeriod;
    }
  }

  if (typeof override.lastRebalance === 'string') {
    const trimmedDate = override.lastRebalance.trim();
    if (trimmedDate) {
      target.investmentModelLastRebalance = trimmedDate;
    }
  } else if (
    override.lastRebalance &&
    typeof override.lastRebalance === 'object' &&
    typeof override.lastRebalance.date === 'string'
  ) {
    const trimmedDate = override.lastRebalance.date.trim();
    if (trimmedDate) {
      target.investmentModelLastRebalance = trimmedDate;
    }
  } else if (!target.investmentModelLastRebalance && normalizedInvestmentModels.length) {
    const withRebalance = normalizedInvestmentModels.find((entry) => entry.lastRebalance);
    if (withRebalance) {
      target.investmentModelLastRebalance = withRebalance.lastRebalance;
    }
  }

  if (
    typeof override.netDepositAdjustment === 'number' &&
    Number.isFinite(override.netDepositAdjustment)
  ) {
    target.netDepositAdjustment = override.netDepositAdjustment;
  }

  if (typeof override.rebalancePeriod === 'number' && Number.isFinite(override.rebalancePeriod)) {
    target.rebalancePeriod = Math.round(override.rebalancePeriod);
  }

  if (typeof override.cagrStartDate === 'string') {
    const trimmedDate = override.cagrStartDate.trim();
    if (trimmedDate) {
      target.cagrStartDate = trimmedDate;
    }
  } else if (
    override.cagrStartDate &&
    typeof override.cagrStartDate === 'object' &&
    typeof override.cagrStartDate.date === 'string'
  ) {
    const trimmedDate = override.cagrStartDate.date.trim();
    if (trimmedDate) {
      target.cagrStartDate = trimmedDate;
    }
  }

  if (
    typeof override.ignoreSittingCash === 'number' &&
    Number.isFinite(override.ignoreSittingCash)
  ) {
    target.ignoreSittingCash = override.ignoreSittingCash;
  }

  const { symbolSettings: resolvedSymbolSettings, symbolNotes: resolvedSymbolNotes } =
    extractSymbolSettingsFromOverride(override);

  if (resolvedSymbolSettings) {
    target.symbolSettings = resolvedSymbolSettings;
  } else if (Object.prototype.hasOwnProperty.call(target, 'symbolSettings')) {
    delete target.symbolSettings;
  }
  if (Object.prototype.hasOwnProperty.call(target, 'targetProportions')) {
    delete target.targetProportions;
  }
  if (resolvedSymbolNotes) {
    target.symbolNotes = resolvedSymbolNotes;
  } else if (Object.prototype.hasOwnProperty.call(target, 'symbolNotes')) {
    delete target.symbolNotes;
  }

  if (Object.prototype.hasOwnProperty.call(override, 'planningContext')) {
    const normalizedContext = normalizePlanningContext(override.planningContext);
    if (normalizedContext) {
      target.planningContext = normalizedContext;
    } else if (Object.prototype.hasOwnProperty.call(target, 'planningContext')) {
      delete target.planningContext;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'accountGroup')) {
    const normalizedGroup = normalizeAccountGroupName(override.accountGroup);
    if (normalizedGroup) {
      target.accountGroup = normalizedGroup;
    } else if (Object.prototype.hasOwnProperty.call(target, 'accountGroup')) {
      delete target.accountGroup;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'mainRetirementAccount')) {
    if (typeof override.mainRetirementAccount === 'boolean') {
      target.mainRetirementAccount = override.mainRetirementAccount;
    } else if (Object.prototype.hasOwnProperty.call(target, 'mainRetirementAccount')) {
      delete target.mainRetirementAccount;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'retirementAge')) {
    const age = Number(override.retirementAge);
    if (Number.isFinite(age) && age > 0) {
      target.retirementAge = Math.round(age);
    } else if (Object.prototype.hasOwnProperty.call(target, 'retirementAge')) {
      delete target.retirementAge;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'retirementIncome')) {
    const income = Number(override.retirementIncome);
    if (Number.isFinite(income) && income >= 0) {
      target.retirementIncome = Math.round(income * 100) / 100;
    } else if (Object.prototype.hasOwnProperty.call(target, 'retirementIncome')) {
      delete target.retirementIncome;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'retirementLivingExpenses')) {
    const expenses = Number(override.retirementLivingExpenses);
    if (Number.isFinite(expenses) && expenses >= 0) {
      target.retirementLivingExpenses = Math.round(expenses * 100) / 100;
    } else if (Object.prototype.hasOwnProperty.call(target, 'retirementLivingExpenses')) {
      delete target.retirementLivingExpenses;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'retirementBirthDate')) {
    const raw = override.retirementBirthDate;
    const normalized =
      typeof raw === 'string' && raw.trim() ? raw.trim() : normalizeDateOnly(override.retirementBirthDate) || null;
    if (normalized) {
      target.retirementBirthDate = normalized;
    } else if (Object.prototype.hasOwnProperty.call(target, 'retirementBirthDate')) {
      delete target.retirementBirthDate;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'retirementInflationPercent')) {
    const raw = override.retirementInflationPercent;
    const num = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (Number.isFinite(num)) {
      target.retirementInflationPercent = num;
    } else if (Object.prototype.hasOwnProperty.call(target, 'retirementInflationPercent')) {
      delete target.retirementInflationPercent;
    }
  }

  if (Object.prototype.hasOwnProperty.call(override, 'projectionGrowthPercent')) {
    const raw = override.projectionGrowthPercent;
    const num = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (Number.isFinite(num)) {
      target.projectionGrowthPercent = num;
    } else if (Object.prototype.hasOwnProperty.call(target, 'projectionGrowthPercent')) {
      delete target.projectionGrowthPercent;
    }
  }
}

function applyAccountSettingsOverrides(account, login) {
  if (!account) {
    return account;
  }

  const accountSettings = getAccountSettings();
  const override = resolveAccountOverrideValue(accountSettings, account, login);
  if (override === null || override === undefined) {
    return Object.assign({}, account);
  }

  const normalizedAccount = Object.assign({}, account);
  applyAccountSettingsOverrideToAccount(normalizedAccount, override);
  return normalizedAccount;
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
  console.log(
    '[Questrade][refresh] Persisting new refresh token for login',
    resolveLoginDisplay(login),
    '(' + maskTokenForLog(login.refreshToken) + ' → ' + maskTokenForLog(nextRefreshToken) + ')'
  );
  login.refreshToken = nextRefreshToken;
  login.updatedAt = new Date().toISOString();
  persistTokenStore(tokenStoreState);
}

async function refreshAccessToken(login) {
  if (!login || !login.refreshToken) {
    throw new Error('Missing refresh token for Questrade login');
  }

  const tokenUrl = 'https://login.questrade.com/oauth2/token';
  const maxRedirects = 5;
  const jar = new CookieJar();
  const baseHeaders = {
    'User-Agent': 'python-requests/2.32.5',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, compress, deflate, br',
  };

  const { dispatcher, proxyUri, shouldClose } = getDispatcherForUrl(tokenUrl);

  if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][refresh] Starting refresh for login', resolveLoginDisplay(login), {
    token: maskTokenForLog(login.refreshToken),
    proxy: proxyUri || false,
  });

  let responsePayload = null;
  let currentUrl = tokenUrl;
  let includeParams = true;

  try {
    for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
      const requestUrlObj = new URL(currentUrl);
      if (includeParams) {
        requestUrlObj.searchParams.set('grant_type', 'refresh_token');
        requestUrlObj.searchParams.set('refresh_token', login.refreshToken);
      }
      const requestUrl = requestUrlObj.toString();
      const headers = { ...baseHeaders };
      const cookieHeader = await jar.getCookieString(requestUrl);
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][refresh]', {
        step: 'request',
        attempt: attempt + 1,
        url: requestUrl,
        cookies: summarizeCookieHeader(headers.Cookie),
      });

      let rawResponse;
      try {
        rawResponse = await undiciRequest(requestUrl, {
          method: 'GET',
          headers,
          dispatcher,
          // Ensure refresh attempts don't hang indefinitely
          headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
          bodyTimeout: HTTP_BODY_TIMEOUT_MS,
        });
      } catch (error) {
        if (DEBUG_QUESTRADE_REFRESH) console.error('[Questrade][refresh] Network error during refresh', {
          login: resolveLoginDisplay(login),
          attempt: attempt + 1,
          message: error.message,
        });
        throw error;
      }

      const headersObject = {};
      Object.entries(rawResponse.headers || {}).forEach(([key, value]) => {
        headersObject[key.toLowerCase()] = value;
      });

      const bodyBuffer = Buffer.from(await rawResponse.body.arrayBuffer());
      const decodedBody = decodeResponseBody(bodyBuffer, headersObject['content-encoding']);
      let data = decodedBody;
      const contentType = headersObject['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          data = JSON.parse(decodedBody || '{}');
        } catch (parseError) {
          if (DEBUG_QUESTRADE_REFRESH) console.warn('[Questrade][refresh] Failed to parse JSON response', {
            message: parseError.message,
          });
        }
      }

      const status = rawResponse.statusCode;
      const setCookieHeader = headersObject['set-cookie'];
      const inboundCookieNames = summarizeCookieHeader(setCookieHeader);

      if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][refresh]', {
        step: 'response',
        attempt: attempt + 1,
        status,
        location: headersObject.location || null,
        setCookies: inboundCookieNames,
      });

      for (const cookie of collectSetCookieValues(setCookieHeader)) {
        try {
          await jar.setCookie(cookie, requestUrl);
        } catch (cookieError) {
          if (DEBUG_QUESTRADE_REFRESH) console.warn('[Questrade][refresh] Failed to persist response cookie', {
            message: cookieError.message,
          });
        }
      }

      if (status >= 300 && status < 400 && headersObject.location) {
        const nextUrl = new URL(headersObject.location, requestUrl).toString();
        if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][refresh]', {
          step: 'redirect',
          attempt: attempt + 1,
          nextUrl,
        });
        currentUrl = nextUrl;
        includeParams = false;
        continue;
      }

      responsePayload = {
        status,
        headers: headersObject,
        data,
      };
      break;
    }
  } finally {
    if (shouldClose && dispatcher && typeof dispatcher.close === 'function') {
      try {
        await dispatcher.close();
      } catch (closeError) {
        if (DEBUG_QUESTRADE_REFRESH) console.warn('[Questrade][refresh] Failed to close dispatcher', { message: closeError.message });
      }
    }
  }

  if (!responsePayload || responsePayload.status < 200 || responsePayload.status >= 300) {
    const status = responsePayload ? responsePayload.status : 'NO_RESPONSE';
    const payload = responsePayload ? responsePayload.data : null;
    console.error('Failed to refresh Questrade token for login ' + resolveLoginDisplay(login), status, payload);
    throw new Error('Unable to refresh Questrade token: ' + status);
  }

  const tokenData = responsePayload.data || {};
  const cacheTtl = Math.max((tokenData.expires_in || 1800) - 60, 60);
  const tokenContext = {
    accessToken: tokenData.access_token,
    apiServer: tokenData.api_server,
    expiresIn: tokenData.expires_in,
    acquiredAt: Date.now(),
    loginId: login.id,
  };
  tokenCache.set(getTokenCacheKey(login.id), tokenContext, cacheTtl);

  const refreshRotated = Boolean(tokenData.refresh_token && tokenData.refresh_token !== login.refreshToken);
  if (refreshRotated) {
    updateLoginRefreshToken(login, tokenData.refresh_token);
  }

  if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][refresh] Completed refresh for login', resolveLoginDisplay(login), {
    expiresIn: tokenData.expires_in,
    apiServer: tokenData.api_server,
    refreshTokenRotated: refreshRotated ? maskTokenForLog(tokenData.refresh_token) : false,
  });

  return tokenContext;
}

async function getTokenContext(login) {
  const cacheKey = getTokenCacheKey(login.id);
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    if (DEBUG_QUESTRADE_API) {
      if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][token-cache] Using cached access token for login', resolveLoginDisplay(login), {
        acquiredAt: new Date(cached.acquiredAt).toISOString(),
        expiresIn: cached.expiresIn,
        apiServer: cached.apiServer,
      });
    }
    return cached;
  }
  if (DEBUG_QUESTRADE_API) {
    if (DEBUG_QUESTRADE_REFRESH) console.log('[Questrade][token-cache] Cache miss for login', resolveLoginDisplay(login));
  }
  return refreshAccessToken(login);
}

function isRetryableStatus(status) {
  if (!status) {
    return false;
  }
  return QUESTRADE_API_RETRYABLE_STATUS.has(Number(status));
}

function isRetryableErrorCode(code) {
  if (!code) {
    return false;
  }
  return QUESTRADE_API_RETRYABLE_ERROR_CODES.has(String(code));
}

function isRetryableError(error) {
  if (!error) {
    return false;
  }
  if (isRetryableStatus(error?.response?.status)) {
    return true;
  }
  if (isRetryableErrorCode(error.code)) {
    return true;
  }
  if (!error.response && error.request) {
    // Network-level failure without any response payload.
    return true;
  }
  return false;
}

function computeRetryDelayMs(attempt) {
  const clampedAttempt = Math.max(1, attempt);
  const backoff = 500 * 2 ** (clampedAttempt - 1);
  const capped = Math.min(backoff, 5000);
  const jitter = Math.floor(Math.random() * 250);
  return capped + jitter;
}

async function performUndiciApiRequest(config) {
  if (!config || !config.url) {
    throw new Error('Request configuration with URL is required');
  }

  const method = config.method || 'GET';
  const headers = Object.assign(
    {
      'User-Agent': 'python-requests/2.32.5',
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, compress, deflate, br',
    },
    config.headers || {}
  );

  const requestUrl = new URL(config.url);
  if (config.params && typeof config.params === 'object') {
    for (const [key, value] of Object.entries(config.params)) {
      if (value == null) {
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (entry != null) {
            requestUrl.searchParams.append(key, entry);
          }
        });
        continue;
      }
      requestUrl.searchParams.set(key, value);
    }
  }

  let body = null;
  if (config.data !== undefined && config.data !== null) {
    if (typeof config.data === 'string' || Buffer.isBuffer(config.data)) {
      body = config.data;
    } else {
      let hasContentType = false;
      for (const headerKey of Object.keys(headers)) {
        if (headerKey.toLowerCase() === 'content-type') {
          hasContentType = true;
          break;
        }
      }
      if (!hasContentType) {
        headers['Content-Type'] = 'application/json';
      }
      body = JSON.stringify(config.data);
    }
  }

  const initialUrl = requestUrl.toString();
  const maxRedirects = Number.isFinite(config.maxRedirects) ? config.maxRedirects : 5;
  let redirectCount = 0;
  let currentUrl = initialUrl;

  while (redirectCount <= maxRedirects) {
    const { dispatcher } = getDispatcherForUrl(currentUrl, { reuse: true });

    // Compact request logging (requests only; no responses)
    if (DEBUG_API_REQUESTS) {
      try {
        const parsed = new URL(currentUrl);
        const host = parsed.host || '';
        const path = parsed.pathname || '/';
        // Redact sensitive query params
        const redacted = new URL(parsed.toString());
        const redactKeys = ['api_key', 'apikey', 'access_token', 'token', 'refresh_token', 'code'];
        redactKeys.forEach((k) => { if (redacted.searchParams.has(k)) redacted.searchParams.set(k, '***'); });
        const qs = redacted.search ? redacted.search : '';
        const bodyLen = body ? Buffer.byteLength(typeof body === 'string' ? body : String(body)) : 0;
        let provider = 'api';
        if (/questrade/i.test(host)) provider = 'questrade';
        else if (/stlouisfed\.org/i.test(host)) provider = 'fred';
        else if (/finance\.yahoo\.com/i.test(host)) provider = 'yahoo';
        else if (/news\.google\.com/i.test(host)) provider = 'google-news';
        else if (/openai\.com|api\.openai\.com/i.test(host)) provider = 'openai';
        const compact = `[${provider}] ${method} ${host}${path}${qs} ${bodyLen ? `(body ${bodyLen}b)` : ''}`.trim();
        console.log('[api-req]', compact);
      } catch (_e) {
        // ignore logging errors
      }
    }

    let rawResponse;
    try {
      rawResponse = await undiciRequest(currentUrl, {
        method,
        headers,
        body,
        dispatcher,
        // Fail fast on slow or stalled responses to avoid UI spinner hang
        headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
        bodyTimeout: HTTP_BODY_TIMEOUT_MS,
      });
    } catch (error) {
      const networkError = error instanceof Error ? error : new Error(String(error));
      if (networkError && networkError.cause && !networkError.code) {
        networkError.code = networkError.cause.code;
      }
      networkError.request = {
        method,
        url: currentUrl,
        headers,
        bodyLength: body ? Buffer.byteLength(typeof body === 'string' ? body : String(body)) : 0,
      };
      throw networkError;
    }

    const headersObject = {};
    Object.entries(rawResponse.headers || {}).forEach(([key, value]) => {
      headersObject[key.toLowerCase()] = value;
    });

    const bodyBuffer = Buffer.from(await rawResponse.body.arrayBuffer());
    const decodedBody = decodeResponseBody(bodyBuffer, headersObject['content-encoding']);

    const statusCode = rawResponse.statusCode;
    if (DEBUG_QUESTRADE_API) {
      console.log('[Questrade][api] Response', {
        url: currentUrl,
        status: statusCode,
        location: headersObject.location || null,
      });
    }
    if (statusCode >= 300 && statusCode < 400 && headersObject.location) {
      redirectCount += 1;
      if (DEBUG_QUESTRADE_API) {
        console.warn('[Questrade][api] Received redirect', {
          status: statusCode,
          location: headersObject.location,
          attempt: redirectCount,
          url: currentUrl,
        });
      }
      if (redirectCount > maxRedirects) {
        const redirectError = new Error('Maximum number of redirects exceeded for ' + config.url);
        redirectError.response = {
          status: statusCode,
          headers: headersObject,
          data: decodedBody,
        };
        redirectError.request = { method, url: currentUrl, headers };
        throw redirectError;
      }
      currentUrl = new URL(headersObject.location, currentUrl).toString();
      continue;
    }

    let parsedData = decodedBody;
    const contentType = headersObject['content-type'] || '';
    if (contentType.includes('application/json')) {
      try {
        parsedData = decodedBody ? JSON.parse(decodedBody) : null;
      } catch (parseError) {
        console.warn('[Questrade][api] Failed to parse JSON response', {
          message: parseError.message,
          url: currentUrl,
        });
      }
    }

    const responsePayload = {
      status: statusCode,
      headers: headersObject,
      data: parsedData,
    };

    if (statusCode >= 200 && statusCode < 300) {
      return responsePayload;
    }

    const error = new Error('Questrade API request failed with status ' + statusCode);
    error.response = responsePayload;
    error.request = { method, url: currentUrl, headers };
    throw error;
  }

  throw new Error('Maximum number of redirects exceeded for ' + config.url);
}

async function questradeRequest(login, pathSegment, options = {}) {
  if (!login) {
    throw new Error('Questrade login context is required for API requests');
  }
  const { method = 'GET', params, data, headers = {}, maxAttempts } = options;
  const attemptsLimit = Math.max(1, Number.isFinite(maxAttempts) ? maxAttempts : QUESTRADE_API_MAX_ATTEMPTS);

  let tokenContext = await getTokenContext(login);
  let attempt = 0;
  let lastError = null;

  while (attempt < attemptsLimit) {
    attempt += 1;
    const requestUrl = new URL(pathSegment, tokenContext.apiServer).toString();
    const requestConfig = {
      method,
      url: requestUrl,
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
      const response = await enqueueRequest(() => performUndiciApiRequest(requestConfig));
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status || null;
      const responseHeaders = error?.response?.headers || null;
      const responseData = error?.response?.data;
      const bodyPreview =
        typeof responseData === 'string'
          ? responseData.slice(0, 500)
          : responseData && typeof responseData === 'object'
            ? JSON.stringify(responseData).slice(0, 500)
            : responseData;

      if (status === 401) {
        console.warn('[Questrade][api] Received 401, refreshing token before retry', {
          login: resolveLoginDisplay(login),
          path: pathSegment,
          attempt,
        });
        tokenCache.del(getTokenCacheKey(login.id));
        tokenContext = await refreshAccessToken(login);
        attempt -= 1; // Do not count the auth retry against the attempt budget.
        continue;
      }

      const retryable = isRetryableError(error);
      if (retryable && attempt < attemptsLimit) {
        const delayMs = computeRetryDelayMs(attempt);
        console.warn('[Questrade][api] Retrying request after recoverable error', {
          login: resolveLoginDisplay(login),
          method,
          url: requestUrl,
          status,
          code: error.code || null,
          attempt,
          remainingAttempts: attemptsLimit - attempt,
          delayMs,
        });
        await delay(delayMs);
        continue;
      }

      console.error('[Questrade][api] Request failed', {
        login: resolveLoginDisplay(login),
        method,
        url: requestUrl,
        status,
        headers: responseHeaders,
        bodyPreview,
        attempt,
        attemptsLimit,
      });

      if (status) {
        error.message = 'Questrade API request failed with status ' + status + ' for ' + pathSegment;
      }
      break;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('Questrade request failed without capturing an error');
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

const RECENT_ORDERS_LOOKBACK_DAYS = 90;
const MAX_ORDER_HISTORY_PAGES = 20;
const DEFAULT_ORDER_HISTORY_MONTHS = 12;

async function fetchOrders(login, accountId, options = {}) {
  const now = new Date();
  const startTime =
    typeof options.startTime === 'string' && options.startTime
      ? options.startTime
      : new Date(now.getTime() - RECENT_ORDERS_LOOKBACK_DAYS * DAY_IN_MS).toISOString();
  const endTime =
    typeof options.endTime === 'string' && options.endTime ? options.endTime : now.toISOString();
  const stateFilter = typeof options.stateFilter === 'string' && options.stateFilter ? options.stateFilter : 'All';
  const maxPagesOption = Number.isFinite(options.maxPages) ? options.maxPages : MAX_ORDER_HISTORY_PAGES;
  const maxPages = Math.max(1, Math.min(Math.round(maxPagesOption), 500));

  const params = { stateFilter, startTime, endTime };
  let path = '/v1/accounts/' + accountId + '/orders';
  let requestOptions = { params };
  const orders = [];
  let page = 0;

  while (path && page < maxPages) {
    page += 1;
    const data = await questradeRequest(login, path, requestOptions || {});
    const batch = Array.isArray(data?.orders) ? data.orders : [];
    if (batch.length) {
      orders.push(...batch);
    }
    if (data?.next) {
      path = data.next;
      requestOptions = null;
    } else {
      break;
    }
  }

  return orders;
}

async function fetchOrdersHistory(login, accountId, options = {}) {
  const endDate =
    options.endDate instanceof Date && !Number.isNaN(options.endDate.getTime())
      ? options.endDate
      : new Date();
  const fallbackStart = addMonths(endDate, -DEFAULT_ORDER_HISTORY_MONTHS);
  let startDate =
    options.startDate instanceof Date && !Number.isNaN(options.startDate.getTime())
      ? options.startDate
      : fallbackStart;
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    startDate = new Date(endDate.getTime() - RECENT_ORDERS_LOOKBACK_DAYS * DAY_IN_MS);
  }
  if (startDate > endDate) {
    startDate = new Date(endDate.getTime());
  }

  const stateFilter =
    typeof options.stateFilter === 'string' && options.stateFilter.trim()
      ? options.stateFilter.trim()
      : 'All';
  const windowDays = Math.max(1, Math.round(options.windowDays || RECENT_ORDERS_LOOKBACK_DAYS));
  const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : 100;

  const ordersMap = new Map();
  let cursor = new Date(startDate.getTime());
  const endTimeMs = endDate.getTime();

  while (cursor.getTime() <= endTimeMs) {
    const windowEndMs = Math.min(cursor.getTime() + windowDays * DAY_IN_MS, endTimeMs);
    const windowEnd = new Date(windowEndMs);
    let batch = [];
    try {
      batch = await fetchOrders(login, accountId, {
        startTime: cursor.toISOString(),
        endTime: windowEnd.toISOString(),
        stateFilter,
        maxPages,
      });
    } catch (error) {
      throw error;
    }

    if (Array.isArray(batch)) {
      batch.forEach((order) => {
        if (!order || typeof order !== 'object') {
          return;
        }
        const identifier = resolveOrderIdentifier(order);
        const existing = identifier && ordersMap.has(identifier) ? ordersMap.get(identifier) : null;
        const chosen = pickMoreRecentOrder(existing, order);
        if (identifier) {
          ordersMap.set(identifier, chosen);
        } else if (!existing) {
          const fallbackKey = Symbol('order');
          ordersMap.set(fallbackKey, chosen);
        }
      });
    }

    if (windowEndMs >= endTimeMs) {
      break;
    }
    cursor = new Date(windowEndMs + 1000);
  }

  return Array.from(ordersMap.values()).filter(Boolean);
}

const TRADE_ACTIVITY_EXCLUDE_REGEX = /(dividend|distribution|interest|fee|commission|transfer|journal|tax|withholding)/i;
const SPLIT_ACTIVITY_REGEX = /(split|consolidat)/i; // match stock splits and consolidations
const TRADE_ACTIVITY_KEYWORD_REGEX = /(buy|sell|short|cover|exercise|assign|assignment|option|trade)/i;

function isOrderLikeActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }

  const quantity = Number(activity.quantity);
  if (!Number.isFinite(quantity) || Math.abs(quantity) <= 1e-8) {
    return false;
  }

  const type = typeof activity.type === 'string' ? activity.type : '';
  const action = typeof activity.action === 'string' ? activity.action : '';
  const description = typeof activity.description === 'string' ? activity.description : '';

  // Only apply the exclude regex to the structured fields (type/action).
  // Some trade descriptions contain the word "INTEREST" (e.g., PSA fund name),
  // which should not disqualify bona fide Buy/Sell trades.
  const excludeSource = [type, action].join(' ');
  if (TRADE_ACTIVITY_EXCLUDE_REGEX.test(excludeSource)) {
    return false;
  }

  const combined = [type, action, description].join(' ');
  return TRADE_ACTIVITY_KEYWORD_REGEX.test(combined);
}

function isSplitLikeActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }
  const type = typeof activity.type === 'string' ? activity.type : '';
  const action = typeof activity.action === 'string' ? activity.action : '';
  const description = typeof activity.description === 'string' ? activity.description : '';
  const combined = [type, action, description].join(' ');
  return SPLIT_ACTIVITY_REGEX.test(combined);
}

function resolveActivityOrderAction(activity, rawQuantity) {
  if (activity && typeof activity.action === 'string') {
    const trimmed = activity.action.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (Number.isFinite(rawQuantity)) {
    if (rawQuantity > 0) {
      return 'Buy';
    }
    if (rawQuantity < 0) {
      return 'Sell';
    }
  }
  return 'Trade';
}

function resolveActivityOrderPrice(activity, rawQuantity) {
  const price = Number(activity.price);
  if (Number.isFinite(price) && Math.abs(price) > 1e-8) {
    return Math.abs(price);
  }

  const grossAmount = Number(activity.grossAmount);
  if (
    Number.isFinite(grossAmount) &&
    Number.isFinite(rawQuantity) &&
    Math.abs(rawQuantity) > 1e-8
  ) {
    const derived = Math.abs(grossAmount / rawQuantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }

  const netAmount = Number(activity.netAmount);
  if (
    Number.isFinite(netAmount) &&
    Number.isFinite(rawQuantity) &&
    Math.abs(rawQuantity) > 1e-8
  ) {
    const derived = Math.abs(netAmount / rawQuantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }

  return null;
}

function resolveActivityOrderCommission(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = ['commission', 'commissionUsd', 'commissionCad', 'commissionCdn', 'commissionCharged'];
  for (const field of fields) {
    const value = Number(activity[field]);
    if (Number.isFinite(value) && Math.abs(value) > 1e-8) {
      return Math.abs(value);
    }
  }
  return null;
}

function buildActivityOrderIdentifierKey(accountKey, symbol, timestamp, action, quantity) {
  const parts = [
    accountKey ? String(accountKey).trim().toUpperCase() : '',
    symbol ? String(symbol).trim().toUpperCase() : '',
    timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : '',
    action ? String(action).trim().toUpperCase() : '',
    Number.isFinite(quantity) ? quantity.toFixed(8) : '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function convertActivityToOrder(activity, context) {
  if (!context || !context.account || !context.login) {
    return null;
  }
  if (!isOrderLikeActivity(activity)) {
    return null;
  }

  const timestamp = resolveActivityTimestamp(activity);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return null;
  }

  const symbol = resolveActivitySymbol(activity);

  const rawQuantity = Number(activity.quantity);
  if (!Number.isFinite(rawQuantity) || Math.abs(rawQuantity) <= 1e-8) {
    return null;
  }

  const identifierCandidates = [
    activity.orderId,
    activity.activityId,
    activity.id,
    activity.transactionId,
    activity.tradeId,
  ];
  let identifier = null;
  for (const candidate of identifierCandidates) {
    if (candidate === null || candidate === undefined) {
      continue;
    }
    const trimmed = String(candidate).trim();
    if (trimmed) {
      identifier = trimmed;
      break;
    }
  }
  if (!identifier) {
    identifier = buildActivityOrderIdentifierKey(
      context.account.id || context.account.number,
      symbol,
      timestamp,
      resolveActivityOrderAction(activity, rawQuantity),
      rawQuantity
    );
  }

  const orderId = 'activity:' + identifier;
  const quantity = Math.abs(rawQuantity);
  const price = resolveActivityOrderPrice(activity, rawQuantity);
  const action = resolveActivityOrderAction(activity, rawQuantity);
  const commission = resolveActivityOrderCommission(activity);
  const currency = normalizeCurrency(activity.currency) || null;
  const symbolId = Number(activity.symbolId);
  const accountId = context.account && context.account.id ? String(context.account.id) : null;
  const accountNumber =
    context.account && context.account.number
      ? String(context.account.number)
      : context.account && context.account.accountNumber
        ? String(context.account.accountNumber)
        : accountId;
  const loginId = context.login && context.login.id ? String(context.login.id) : null;

  return {
    id: orderId,
    orderId,
    accountId,
    accountNumber,
    loginId,
    symbol: symbol || null,
    symbolId: Number.isFinite(symbolId) ? symbolId : null,
    description: typeof activity.description === 'string' ? activity.description.trim() : null,
    currency,
    status: 'Executed',
    action,
    type:
      typeof activity.orderType === 'string' && activity.orderType.trim()
        ? activity.orderType.trim()
        : null,
    timeInForce: null,
    totalQuantity: quantity,
    openQuantity: 0,
    filledQuantity: quantity,
    limitPrice: price,
    stopPrice: null,
    avgExecPrice: price,
    lastExecPrice: price,
    commission,
    commissionCharged: commission,
    venue:
      typeof activity.exchange === 'string' && activity.exchange.trim()
        ? activity.exchange.trim()
        : typeof activity.venue === 'string' && activity.venue.trim()
          ? activity.venue.trim()
          : null,
    notes: typeof activity.notes === 'string' && activity.notes.trim() ? activity.notes.trim() : null,
    source: 'activity',
    creationTime: timestamp.toISOString(),
    updateTime: timestamp.toISOString(),
    gtdDate: null,
  };
}

function buildOrdersFromActivities(activityContext, context, cutoffDate) {
  if (
    !activityContext ||
    typeof activityContext !== 'object' ||
    !Array.isArray(activityContext.activities) ||
    !context
  ) {
    return [];
  }

  const cutoffMs =
    cutoffDate instanceof Date && !Number.isNaN(cutoffDate.getTime()) ? cutoffDate.getTime() : null;

  const orders = activityContext.activities
    .map((activity, idx) => {
      const order = convertActivityToOrder(activity, context);
      if (order && order.source === 'activity') {
        order.activityIndex = idx;
      }
      return order;
    })
    .filter((order) => {
      if (!order) {
        return false;
      }
      if (cutoffMs === null) {
        return true;
      }
      const createdMs = Date.parse(order.creationTime || order.updateTime || '');
      if (!Number.isFinite(createdMs)) {
        return true;
      }
      return createdMs < cutoffMs;
    });

  return aggregateActivityOrders(orders);
}

function aggregateActivityOrders(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return [];
  }

  const aggregatedOrders = [];
  const aggregationMeta = new Map();

  orders.forEach((order) => {
    if (!order || order.source !== 'activity') {
      aggregatedOrders.push(order);
      return;
    }

    const key = order.orderId || order.id;
    if (!key) {
      aggregatedOrders.push(order);
      return;
    }

    const identifier = String(key);
    let meta = aggregationMeta.get(identifier);
    if (!meta) {
      const cloned = Object.assign({}, order);
      meta = initializeActivityAggregationMeta(cloned);
      aggregationMeta.set(identifier, meta);
      aggregatedOrders.push(cloned);
      return;
    }

    updateActivityAggregationMeta(meta, order);
  });

  aggregationMeta.forEach((meta) => finalizeActivityAggregationMeta(meta));

  return aggregatedOrders;
}

function initializeActivityAggregationMeta(order) {
  const totalQuantity = toFiniteNumber(order.totalQuantity) || 0;
  const filledQuantity = toFiniteNumber(order.filledQuantity) || 0;
  const commission = toFiniteNumber(order.commission) || 0;
  const commissionCharged = toFiniteNumber(order.commissionCharged) || 0;
  const price = resolveAggregationPrice(order);
  const executionMs = resolveAggregationExecutionMs(order);
  const creationMs = resolveAggregationCreationMs(order);
  const updateMs = resolveAggregationUpdateMs(order);
  const activityIndex = Number.isFinite(Number(order.activityIndex)) ? Number(order.activityIndex) : null;

  const initialQuantityForPrice = price !== null ? filledQuantity || totalQuantity || 0 : 0;

  return {
    order,
    totalQuantity,
    filledQuantity,
    commission,
    commissionCharged,
    priceNotional: price !== null ? price * initialQuantityForPrice : 0,
    priceQuantity: price !== null ? initialQuantityForPrice : 0,
    latestExecMs: executionMs,
    latestExecPrice: price,
    earliestMs: creationMs,
    latestMs: updateMs,
    earliestIso: creationMs !== null ? new Date(creationMs).toISOString() : order.creationTime || null,
    latestIso: updateMs !== null ? new Date(updateMs).toISOString() : order.updateTime || null,
    minActivityIndex: activityIndex,
  };
}

function updateActivityAggregationMeta(meta, addition) {
  const quantity = toFiniteNumber(addition.totalQuantity) || 0;
  const filled = toFiniteNumber(addition.filledQuantity) || 0;
  const commission = toFiniteNumber(addition.commission);
  const commissionCharged = toFiniteNumber(addition.commissionCharged);
  const price = resolveAggregationPrice(addition);
  const executionMs = resolveAggregationExecutionMs(addition);
  const creationMs = resolveAggregationCreationMs(addition);
  const updateMs = resolveAggregationUpdateMs(addition);
  const activityIndex = Number.isFinite(Number(addition.activityIndex)) ? Number(addition.activityIndex) : null;

  meta.totalQuantity += quantity;
  meta.filledQuantity += filled;

  if (commission !== null) {
    meta.commission += commission;
  }
  if (commissionCharged !== null) {
    meta.commissionCharged += commissionCharged;
  }

  if (price !== null) {
    const quantityForPrice = filled || quantity;
    if (Number.isFinite(quantityForPrice) && Math.abs(quantityForPrice) > 1e-8) {
      meta.priceNotional += price * quantityForPrice;
      meta.priceQuantity += quantityForPrice;
    }
  }

  if (executionMs !== null) {
    if (meta.latestExecMs === null || executionMs >= meta.latestExecMs) {
      meta.latestExecMs = executionMs;
      meta.latestExecPrice = price !== null ? price : meta.latestExecPrice;
    }
  }

  if (creationMs !== null && (meta.earliestMs === null || creationMs < meta.earliestMs)) {
    meta.earliestMs = creationMs;
    meta.earliestIso = new Date(creationMs).toISOString();
  }

  if (updateMs !== null && (meta.latestMs === null || updateMs > meta.latestMs)) {
    meta.latestMs = updateMs;
    meta.latestIso = new Date(updateMs).toISOString();
  }

  if (activityIndex !== null) {
    if (meta.minActivityIndex === null || activityIndex < meta.minActivityIndex) {
      meta.minActivityIndex = activityIndex;
    }
  }
}

function finalizeActivityAggregationMeta(meta) {
  if (!meta || !meta.order) {
    return;
  }

  const order = meta.order;

  if (meta.totalQuantity > 0) {
    order.totalQuantity = meta.totalQuantity;
  }
  if (meta.filledQuantity > 0) {
    order.filledQuantity = meta.filledQuantity;
  }

  const totalQty = toFiniteNumber(order.totalQuantity);
  const filledQty = toFiniteNumber(order.filledQuantity);
  if (totalQty !== null && filledQty !== null) {
    const remaining = totalQty - filledQty;
    if (Number.isFinite(remaining)) {
      const normalizedRemaining = Math.max(remaining, 0);
      order.openQuantity = normalizedRemaining;
    }
  }

  if (meta.commission > 0) {
    order.commission = meta.commission;
  }
  if (meta.commissionCharged > 0) {
    order.commissionCharged = meta.commissionCharged;
  }

  if (meta.priceQuantity > 0 && Number.isFinite(meta.priceNotional)) {
    const average = meta.priceNotional / meta.priceQuantity;
    if (Number.isFinite(average)) {
      order.avgExecPrice = average;
    }
  }

  if (meta.latestExecPrice !== null && meta.latestExecPrice !== undefined) {
    order.lastExecPrice = meta.latestExecPrice;
  }

  if (meta.earliestIso) {
    order.creationTime = meta.earliestIso;
  }

  if (meta.latestIso) {
    order.updateTime = meta.latestIso;
  }

  if (meta.minActivityIndex !== null && meta.minActivityIndex !== undefined) {
    order.activityIndex = meta.minActivityIndex;
  }
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveAggregationPrice(order) {
  if (!order || typeof order !== 'object') {
    return null;
  }
  const fields = ['avgExecPrice', 'lastExecPrice', 'limitPrice'];
  for (const field of fields) {
    const value = toFiniteNumber(order[field]);
    if (value !== null && Math.abs(value) > 1e-8) {
      return value;
    }
  }
  return null;
}

function resolveAggregationExecutionMs(order) {
  if (!order || typeof order !== 'object') {
    return null;
  }
  const candidates = [order.updateTime, order.creationTime];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function resolveAggregationCreationMs(order) {
  if (!order || typeof order !== 'object') {
    return null;
  }
  if (typeof order.creationTime === 'string') {
    const parsed = Date.parse(order.creationTime);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return resolveAggregationExecutionMs(order);
}

function resolveAggregationUpdateMs(order) {
  if (!order || typeof order !== 'object') {
    return null;
  }
  if (typeof order.updateTime === 'string') {
    const parsed = Date.parse(order.updateTime);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return resolveAggregationExecutionMs(order);
}

function findEarliestOrderTimestamp(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return null;
  }
  let earliestMs = null;
  orders.forEach((order) => {
    if (!order || typeof order !== 'object') {
      return;
    }
    const candidates = [];
    if (typeof order.creationTime === 'string') {
      candidates.push(order.creationTime);
    }
    if (typeof order.updateTime === 'string') {
      candidates.push(order.updateTime);
    }
    candidates.forEach((value) => {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      if (earliestMs === null || parsed < earliestMs) {
        earliestMs = parsed;
      }
    });
  });
  if (earliestMs === null) {
    return null;
  }
  return new Date(earliestMs).toISOString();
}

function resolveOrderIdentifier(order) {
  if (!order || typeof order !== 'object') {
    return null;
  }
  if (order.orderId !== null && order.orderId !== undefined) {
    return 'id:' + String(order.orderId);
  }
  if (order.id !== null && order.id !== undefined) {
    return 'id:' + String(order.id);
  }
  const accountKey =
    order.accountId != null
      ? 'acct:' + String(order.accountId)
      : order.accountNumber != null
        ? 'acct:' + String(order.accountNumber)
        : '';
  const symbol = order.symbol != null ? String(order.symbol) : '';
  const timestamp =
    order.creationTime ||
    order.createdTime ||
    order.updateTime ||
    order.updatedTime ||
    order.time ||
    '';
  const side = order.side || order.action || '';
  const quantity =
    Number.isFinite(Number(order.totalQuantity))
      ? 'qty:' + String(Number(order.totalQuantity))
      : Number.isFinite(Number(order.openQuantity))
        ? 'qty:' + String(Number(order.openQuantity))
        : Number.isFinite(Number(order.filledQuantity))
          ? 'qty:' + String(Number(order.filledQuantity))
          : '';
  const keyParts = [accountKey, symbol, timestamp, side, quantity].filter(Boolean);
  if (!keyParts.length) {
    return null;
  }
  return 'fallback:' + keyParts.join('|');
}

function pickMoreRecentOrder(existing, candidate) {
  if (!existing) {
    return candidate;
  }
  if (!candidate) {
    return existing;
  }
  const existingTime = Date.parse(
    existing.updateTime || existing.updatedTime || existing.creationTime || existing.createdTime || ''
  );
  const candidateTime = Date.parse(
    candidate.updateTime || candidate.updatedTime || candidate.creationTime || candidate.createdTime || ''
  );
  if (!Number.isFinite(existingTime) && Number.isFinite(candidateTime)) {
    return candidate;
  }
  if (Number.isFinite(existingTime) && Number.isFinite(candidateTime) && candidateTime > existingTime) {
    return candidate;
  }
  return existing;
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
const FX_CACHE_DIR = path.join(__dirname, '..', '.cache', 'fx');
const USD_CAD_CACHE_FILE_PATH = path.join(FX_CACHE_DIR, 'usd-cad-rates.json');

const usdCadRateCache = new Map();
let fxCacheDirEnsured = false;
let usdCadRateCacheLoaded = false;
let usdCadRateCacheDirty = false;
let usdCadRateCacheFlushTimeout = null;

function ensureFxCacheDir() {
  if (fxCacheDirEnsured) {
    return;
  }
  try {
    fs.mkdirSync(FX_CACHE_DIR, { recursive: true });
  } catch (error) {
    console.warn('[FX] Failed to ensure FX cache directory:', error?.message || String(error));
  }
  fxCacheDirEnsured = true;
}

function flushUsdCadRateCacheSync() {
  if (usdCadRateCacheFlushTimeout) {
    clearTimeout(usdCadRateCacheFlushTimeout);
    usdCadRateCacheFlushTimeout = null;
  }
  if (!usdCadRateCacheDirty) {
    return;
  }
  usdCadRateCacheDirty = false;
  try {
    ensureFxCacheDir();
    const entries = Array.from(usdCadRateCache.entries())
      .filter(([key]) => typeof key === 'string' && key)
      .map(([key, value]) => ({
        key,
        value: value === null ? null : Number(value),
      }))
      .filter((entry) =>
        entry.value === null || (Number.isFinite(entry.value) && entry.value > 0)
      );
    const payload = {
      updatedAt: new Date().toISOString(),
      entries,
    };
    fs.writeFileSync(USD_CAD_CACHE_FILE_PATH, JSON.stringify(payload));
  } catch (error) {
    console.warn('[FX] Failed to persist USD/CAD rate cache:', error?.message || String(error));
  }
}

function scheduleUsdCadRateCachePersist() {
  usdCadRateCacheDirty = true;
  if (usdCadRateCacheFlushTimeout) {
    return;
  }
  usdCadRateCacheFlushTimeout = setTimeout(() => {
    usdCadRateCacheFlushTimeout = null;
    flushUsdCadRateCacheSync();
  }, 1000);
  if (typeof usdCadRateCacheFlushTimeout.unref === 'function') {
    usdCadRateCacheFlushTimeout.unref();
  }
}

function updateUsdCadRateCache(key, value, { persist = true } = {}) {
  if (!key || typeof key !== 'string') {
    return;
  }
  let normalizedValue = null;
  if (value === null) {
    normalizedValue = null;
  } else {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return;
    }
    normalizedValue = numeric;
  }
  const existing = usdCadRateCache.has(key) ? usdCadRateCache.get(key) : undefined;
  if (existing === normalizedValue) {
    return;
  }
  usdCadRateCache.set(key, normalizedValue);
  if (persist) {
    scheduleUsdCadRateCachePersist();
  }
}

function loadUsdCadRateCacheFromDisk() {
  if (usdCadRateCacheLoaded) {
    return;
  }
  usdCadRateCacheLoaded = true;
  try {
    ensureFxCacheDir();
    if (!fs.existsSync(USD_CAD_CACHE_FILE_PATH)) {
      return;
    }
    const contents = fs.readFileSync(USD_CAD_CACHE_FILE_PATH, 'utf-8');
    if (!contents) {
      return;
    }
    const parsed = JSON.parse(contents);
    const rawEntries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.entries(parsed)
      : [];
    const initialSize = usdCadRateCache.size;
    for (const entry of rawEntries) {
      if (!entry) {
        continue;
      }
      if (Array.isArray(entry)) {
        const [entryKey, entryValue] = entry;
        if (typeof entryKey === 'string') {
          updateUsdCadRateCache(entryKey, entryValue, { persist: false });
        }
        continue;
      }
      if (typeof entry === 'object') {
        const entryKey = typeof entry.key === 'string' ? entry.key : null;
        if (!entryKey) {
          continue;
        }
        updateUsdCadRateCache(entryKey, entry.value ?? null, { persist: false });
      }
    }
    const loadedEntries = usdCadRateCache.size - initialSize;
    if (loadedEntries > 0) {
      console.log(`[FX] Loaded ${loadedEntries} cached USD/CAD rate entries from disk.`);
    }
  } catch (error) {
    console.warn('[FX] Failed to load USD/CAD rate cache:', error?.message || String(error));
  }
}

loadUsdCadRateCacheFromDisk();
process.on('exit', flushUsdCadRateCacheSync);

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
  const fields = ['tradeDate', 'transactionDate', 'settlementDate', 'date'];
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
// For per-symbol Total P&L, some income (e.g., T-bill ETFs) is booked as
// "interest" rather than dividend/distribution. Treat it as income here.
const INCOME_ACTIVITY_REGEX = /(dividend|distribution|interest|coupon)/i;

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
  ['S022496', 'SPYM'],
  ['SPYM', 'SPYM'],
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
    ['SPYM', ['SPYM']],
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

const USD_DESCRIPTION_HINTS = [
  'USD',
  'US DOLLAR',
  'US DOLLARS',
  'US FUNDS',
  'US$',
  'U$',
];

const CAD_DESCRIPTION_HINTS = [
  'CAD',
  'C$',
  'C DOLLAR',
  'C DOLLARS',
  'CDN',
  'CAD FUNDS',
  'CANADIAN DOLLAR',
  'CANADIAN DOLLARS',
];

function hasUsdHintInDescription(description) {
  if (typeof description !== 'string' || !description) {
    return false;
  }
  const normalized = description.toUpperCase();
  return USD_DESCRIPTION_HINTS.some((hint) => normalized.includes(hint));
}

function hasCadHintInDescription(description) {
  if (typeof description !== 'string' || !description) {
    return false;
  }
  const normalized = description.toUpperCase();
  return CAD_DESCRIPTION_HINTS.some((hint) => normalized.includes(hint));
}

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

const CAD_SYMBOL_SUFFIXES = new Set([
  'TO',
  'TSX',
  'V',
  'CN',
  'NE',
  'ME',
  'M',
  'CA',
  'SV',
]);

function inferSymbolCurrency(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return null;
  }
  const parts = normalized.split('.');
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const penultimate = parts.length > 1 ? parts[parts.length - 2] : null;
    if (penultimate) {
      const hint = penultimate.replace(/[^A-Z]/g, '');
      if (hint === 'U' || hint === 'US' || hint === 'USD') {
        return 'USD';
      }
    }
    if (CAD_SYMBOL_SUFFIXES.has(last)) {
      return 'CAD';
    }
  }
  return 'USD';
}

const ACTIVITY_DESCRIPTION_SYMBOL_HINTS = [
  {
    symbol: 'SPY',
    keywords: ['SPDR S&P 500 ETF TRUST'],
  },
  {
    symbol: 'TQQQ',
    keywords: ['PROSHARES TRUST ULTRAPRO QQQ'],
  },
  {
    symbol: 'BIL',
    keywords: ['SPDR SERIES TRUST SPDR BLOOMBERG 1 3 MONTH T BILL ETF'],
  },
].map((entry) => ({
  symbol: entry.symbol,
  keywords: Array.isArray(entry.keywords)
    ? entry.keywords
        .map((keyword) =>
          typeof keyword === 'string' ? keyword.replace(/\s+/g, ' ').trim().toUpperCase() : null
        )
        .filter(Boolean)
    : [],
}));

function resolveActivitySymbol(activity) {
  if (!activity || typeof activity !== 'object') {
    return '';
  }
  const rawSymbol = typeof activity.symbol === 'string' ? activity.symbol.trim() : '';
  if (rawSymbol) {
    return rawSymbol;
  }
  const type = typeof activity.type === 'string' ? activity.type.trim().toLowerCase() : '';
  if (type !== 'trades') {
    return '';
  }
  const description =
    typeof activity.description === 'string' ? activity.description : '';
  if (!description) {
    return '';
  }
  const normalizedDescription = description.replace(/\s+/g, ' ').trim().toUpperCase();
  for (const entry of ACTIVITY_DESCRIPTION_SYMBOL_HINTS) {
    if (entry.keywords.some((keyword) => normalizedDescription.includes(keyword))) {
      return entry.symbol;
    }
  }
  return '';
}

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
      updateUsdCadRateCache(latestCacheKey, latestRate);
      return latestRate;
    }
    updateUsdCadRateCache(latestCacheKey, null);
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

  const response = await performUndiciApiRequest({ url: url.toString() });
  const observations = response.data && response.data.observations;
  if (Array.isArray(observations) && observations.length > 0) {
    const value = Number(observations[0].value);
    if (Number.isFinite(value) && value > 0) {
      updateUsdCadRateCache(keyDate, value);
      return value;
    }
  }
  updateUsdCadRateCache(keyDate, null);
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
    const response = await performUndiciApiRequest({ url: url.toString() });
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
          updateUsdCadRateCache(dateKey, value);
        } else if (!usdCadRateCache.has(dateKey)) {
          updateUsdCadRateCache(dateKey, null);
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
      updateUsdCadRateCache(key, lastKnown);
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
  let result = [];
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
      // Consider trade-like position movements (e.g., book-value transfers logged as trades with quantity)
      // as a fallback when no explicit funding is present for the window.
      const tradeLike = activities.filter((activity) => {
        if (!activity || typeof activity !== 'object') {
          return false;
        }
        const type = typeof activity.type === 'string' ? activity.type : '';
        const description = typeof activity.description === 'string' ? activity.description : '';
        // Exclude dividends/distributions explicitly
        if (/dividend|distribution/i.test(type) || /dividend|distribution/i.test(description)) {
          return false;
        }
        const qty = Number(activity.quantity);
        if (Number.isFinite(qty) && Math.abs(qty) > 1e-8) {
          return true;
        }
        // Book-value hints without cash
        if (/\bBOOK\s+VALUE\b/i.test(description)) {
          return true;
        }
        return false;
      });
      const relevant = funding.length > 0 ? funding : tradeLike;
      if (relevant.length > 0) {
        const windowEarliest = findEarliestFundingTimestamp(relevant);
        if (windowEarliest && (!earliest || windowEarliest < earliest)) {
          earliest = windowEarliest;
        }
        consecutiveEmpty = 0;
        debugTotalPnl(
          accountKey,
          funding.length > 0 ? 'Funding month hit' : 'Trade-like month hit',
          Object.assign({ activities: relevant.length }, monthLabel)
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
  const startDateKey =
    options && typeof options.startDate === 'string' && options.startDate.trim()
      ? 'start:' + options.startDate.trim()
      : 'start:none';
  const endDateKey =
    options && typeof options.endDate === 'string' && options.endDate.trim()
      ? 'end:' + options.endDate.trim()
      : 'end:none';
  const adjustment = Number(account.netDepositAdjustment);
  const adjustmentKey = Number.isFinite(adjustment) ? 'adj:' + adjustment.toFixed(2) : 'adj:none';
  const ignoreAdjustmentsKey =
    options && options.ignoreAccountAdjustments ? 'ignoreAdj:1' : 'ignoreAdj:0';
  return [
    loginId,
    accountId,
    tradingDay,
    fingerprint,
    balanceFingerprint,
    cagrKey,
    cagrDateKey,
    startDateKey,
    endDateKey,
    adjustmentKey,
    ignoreAdjustmentsKey,
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
  const fetchBookValueTransferPrice = createAccountBookValueTransferPriceFetcher(login, accountKey);

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
    fetchBookValueTransferPrice,
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
  let currency = normalizeCurrency(activity.currency) || 'CAD';
  const netAmount = Number(activity.netAmount);
  const grossAmount = Number(activity.grossAmount);
  const usesDescriptionAmount = amountInfo.source === 'description' && amountInfo.description;
  const descriptionText = typeof activity.description === 'string' ? activity.description : '';
  const usdHintInDescription = hasUsdHintInDescription(descriptionText);
  const cadHintInDescription = hasCadHintInDescription(descriptionText);
  const cadHintIsContextual = /\b(?:FROM|TO)\s+CAD\b/i.test(descriptionText || '');
  if (usesDescriptionAmount) {
    const descriptionSource = amountInfo.description.source;
    if (
      descriptionSource === 'bookValue' &&
      (!Number.isFinite(netAmount) || Math.abs(netAmount) < 1e-8) &&
      (!Number.isFinite(grossAmount) || Math.abs(grossAmount) < 1e-8)
    ) {
      const inferredCurrency = inferSymbolCurrency(activity.symbol);
      if (inferredCurrency && inferredCurrency !== currency) {
        const descriptionPrefersCad = cadHintInDescription && !usdHintInDescription && !cadHintIsContextual;
        if (!(inferredCurrency === 'USD' && descriptionPrefersCad)) {
          currency = inferredCurrency;
        }
      }
    }
  }
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

const bookValueTransferPriceCache = new Map();
let customBookValueTransferPriceFetcher = null;

function setBookValueTransferPriceFetcher(fetcher) {
  if (fetcher !== null && typeof fetcher !== 'function') {
    throw new Error('Book value transfer price fetcher must be a function or null');
  }
  customBookValueTransferPriceFetcher = fetcher;
  bookValueTransferPriceCache.clear();
}

async function fetchBookValueTransferClosePrice(symbol, dateKey, accountKey) {
  if (!symbol || !dateKey) {
    return null;
  }
  const cacheKey = symbol + '|' + dateKey;
  if (bookValueTransferPriceCache.has(cacheKey)) {
    return bookValueTransferPriceCache.get(cacheKey);
  }
  let price = null;
  try {
    const history = await fetchSymbolPriceHistory(symbol, dateKey, dateKey);
    if (Array.isArray(history) && history.length > 0) {
      const latest = history[history.length - 1];
      if (latest && Number.isFinite(latest.price) && latest.price > 0) {
        price = latest.price;
      }
    }
  } catch (error) {
    if (DEBUG_TOTAL_PNL) {
      debugTotalPnl(accountKey, 'Failed to fetch market price for book-value transfer', {
        symbol,
        dateKey,
        message: error && error.message ? error.message : String(error),
      });
    }
  }
  bookValueTransferPriceCache.set(cacheKey, price);
  return price;
}

const BOOK_VALUE_TRANSFER_QUANTITY_REGEX = /([\d,.]+)\s+(?:SHARE|SHARES|UNITS|TRANSFER)/i;

function createAccountBookValueTransferPriceFetcher(login, accountKey) {
  const cache = new Map();
  return async function fetcher(activity, symbol, dateKey) {
    if (!symbol || !dateKey) {
      return null;
    }
    const cacheKey = symbol + '|' + dateKey;
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    let price = null;
    const symbolId = activity && Number.isFinite(Number(activity.symbolId)) ? Number(activity.symbolId) : NaN;
    if (login && Number.isFinite(symbolId) && symbolId > 0) {
      try {
        price = await fetchQuestradeBookValueTransferClose(login, symbolId, dateKey, accountKey);
      } catch (error) {
        if (DEBUG_TOTAL_PNL) {
          debugTotalPnl(accountKey, 'Failed to fetch Questrade market price for book-value transfer', {
            symbol,
            symbolId,
            dateKey,
            message: error && error.message ? error.message : String(error),
          });
        }
        price = null;
      }
    }
    cache.set(cacheKey, price);
    return price;
  };
}

async function fetchQuestradeBookValueTransferClose(login, symbolId, dateKey, accountKey) {
  if (!login || !symbolId || !dateKey) {
    return null;
  }
  const startDate = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }
  const endDate = addDays(startDate, 1) || new Date(startDate.getTime() + DAY_IN_MS);
  const params = {
    startTime: startDate.toISOString(),
    endTime: endDate.toISOString(),
    interval: 'OneDay',
  };
  let data;
  try {
    data = await questradeRequest(login, `/v1/markets/candles/${symbolId}`, { params });
  } catch (error) {
    if (DEBUG_TOTAL_PNL) {
      debugTotalPnl(accountKey, 'Questrade candle lookup failed for book-value transfer', {
        symbolId,
        dateKey,
        message: error && error.message ? error.message : String(error),
      });
    }
    return null;
  }
  const candles = data && Array.isArray(data.candles) ? data.candles : [];
  for (const candle of candles) {
    if (!candle || typeof candle !== 'object') {
      continue;
    }
    const start = candle.start || candle.time || candle.startTime;
    if (typeof start === 'string') {
      const candleDate = new Date(start);
      if (!Number.isNaN(candleDate.getTime())) {
        const candleDateKey = formatDateOnly(candleDate);
        if (candleDateKey && candleDateKey !== dateKey) {
          continue;
        }
      }
    }
    const close = Number(candle.close);
    if (Number.isFinite(close) && close > 0) {
      return close;
    }
    const vwap = Number(candle.VWAP || candle.vwap);
    if (Number.isFinite(vwap) && vwap > 0) {
      return vwap;
    }
  }
  return null;
}

function extractBookValueTransferQuantity(activity) {
  const explicitQuantity = Number(activity && activity.quantity);
  if (Number.isFinite(explicitQuantity) && Math.abs(explicitQuantity) > 1e-8) {
    return Math.abs(explicitQuantity);
  }
  const description = typeof activity?.description === 'string' ? activity.description : '';
  if (!description) {
    return null;
  }
  const match = description.match(BOOK_VALUE_TRANSFER_QUANTITY_REGEX);
  if (match && match[1]) {
    const parsed = parseNumericString(match[1]);
    if (Number.isFinite(parsed) && Math.abs(parsed) > 1e-8) {
      return Math.abs(parsed);
    }
  }
  return null;
}

function shouldApplyBookValueMarketOverride(activity, details) {
  if (!activity || !details) {
    return false;
  }
  const resolution = details.resolution;
  if (!resolution || !resolution.description || resolution.description.source !== 'bookValue') {
    return false;
  }
  const netAmount = Number(activity.netAmount);
  if (Number.isFinite(netAmount) && Math.abs(netAmount) >= 1e-8) {
    return false;
  }
  const grossAmount = Number(activity.grossAmount);
  if (Number.isFinite(grossAmount) && Math.abs(grossAmount) >= 1e-8) {
    return false;
  }
  const timestamp =
    details.timestamp instanceof Date && !Number.isNaN(details.timestamp.getTime())
      ? details.timestamp
      : resolveActivityTimestamp(activity);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return false;
  }
  const symbol = normalizeSymbol(activity.symbol);
  if (!symbol) {
    return false;
  }
  const quantity = extractBookValueTransferQuantity(activity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return false;
  }
  return true;
}

async function resolveBookValueTransferMarketOverride(activity, details, accountKey, activityContext) {
  if (!shouldApplyBookValueMarketOverride(activity, details)) {
    return null;
  }
  const timestamp =
    details.timestamp instanceof Date && !Number.isNaN(details.timestamp.getTime())
      ? details.timestamp
      : resolveActivityTimestamp(activity);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return null;
  }
  const dateKey = formatDateOnly(timestamp);
  if (!dateKey) {
    return null;
  }
  const symbol = normalizeSymbol(activity.symbol);
  if (!symbol) {
    return null;
  }
  const quantity = extractBookValueTransferQuantity(activity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  const contextualFetcher =
    activityContext && typeof activityContext.fetchBookValueTransferPrice === 'function'
      ? activityContext.fetchBookValueTransferPrice
      : null;
  let price = null;
  if (contextualFetcher) {
    try {
      price = await contextualFetcher(activity, symbol, dateKey, accountKey);
    } catch (error) {
      if (DEBUG_TOTAL_PNL) {
        debugTotalPnl(accountKey, 'Account book-value price fetcher failed', {
          symbol,
          dateKey,
          message: error && error.message ? error.message : String(error),
        });
      }
      price = null;
    }
  }
  if (!Number.isFinite(price) || price <= 0) {
    const priceFetcher = customBookValueTransferPriceFetcher || fetchBookValueTransferClosePrice;
    try {
      price = await priceFetcher(symbol, dateKey, accountKey);
    } catch (error) {
      if (DEBUG_TOTAL_PNL) {
        debugTotalPnl(accountKey, 'Custom book-value price fetcher failed', {
          symbol,
          dateKey,
          message: error && error.message ? error.message : String(error),
        });
      }
      return null;
    }
  }
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  const inferredCurrency = inferSymbolCurrency(symbol) || normalizeCurrency(activity.currency) || details.currency || 'CAD';
  const magnitude = quantity * price;
  const sign = Number(details.amount) >= 0 ? 1 : -1;
  const overrideAmount = magnitude * sign;
  if (DEBUG_TOTAL_PNL) {
    debugTotalPnl(accountKey, 'Applied market value override for book-value transfer', {
      symbol,
      dateKey,
      price,
      quantity,
      inferredCurrency,
      overrideAmount,
      bookValueAmount: details.amount,
      bookValueCurrency: details.currency,
    });
  }
  return {
    source: 'marketValue',
    amount: overrideAmount,
    currency: inferredCurrency,
    price,
    quantity,
    bookValueAmount: details.amount,
    bookValueCurrency: details.currency,
    dateKey,
  };
}

async function resolveFundingActivityAmountDetails(activity, accountKey, activityContext) {
  const baseDetails = resolveActivityAmountDetails(activity);
  if (!baseDetails) {
    return null;
  }
  const override = await resolveBookValueTransferMarketOverride(activity, baseDetails, accountKey, activityContext);
  if (!override) {
    return baseDetails;
  }
  return Object.assign({}, baseDetails, {
    amount: override.amount,
    currency: override.currency,
    override,
  });
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

  const ignoreAccountAdjustments =
    options && Object.prototype.hasOwnProperty.call(options, 'ignoreAccountAdjustments')
      ? !!options.ignoreAccountAdjustments
      : false;

  const normalizedStartOverride =
    typeof options.startDate === 'string' && options.startDate.trim()
      ? options.startDate.trim()
      : null;
  const normalizedEndOverride =
    typeof options.endDate === 'string' && options.endDate.trim()
      ? options.endDate.trim()
      : null;

  let requestedPeriodStartDate = null;
  if (normalizedStartOverride) {
    requestedPeriodStartDate = parseDateOnlyString(normalizedStartOverride);
    if (!requestedPeriodStartDate) {
      const fallbackStart = new Date(normalizedStartOverride);
      requestedPeriodStartDate = Number.isNaN(fallbackStart.getTime()) ? null : fallbackStart;
    }
  }

  let requestedPeriodEndDate = null;
  if (normalizedEndOverride) {
    requestedPeriodEndDate = parseDateOnlyString(normalizedEndOverride);
    if (!requestedPeriodEndDate) {
      const fallbackEnd = new Date(normalizedEndOverride);
      requestedPeriodEndDate = Number.isNaN(fallbackEnd.getTime()) ? null : fallbackEnd;
    }
  }

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
    const details = await resolveFundingActivityAmountDetails(activity, accountKey, activityContext);
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
      overrideSource: details.override ? details.override.source || null : null,
      overridePrice:
        details.override && Number.isFinite(details.override.price) ? details.override.price : null,
      overrideQuantity:
        details.override && Number.isFinite(details.override.quantity) ? details.override.quantity : null,
      overrideCurrency: details.override ? details.override.currency || null : null,
      overrideAmount:
        details.override && Number.isFinite(details.override.amount) ? details.override.amount : null,
      bookValueAmount:
        details.override && Number.isFinite(details.override.bookValueAmount)
          ? details.override.bookValueAmount
          : null,
      bookValueCurrency: details.override ? details.override.bookValueCurrency || null : null,
      timestamp: timestamp ? formatDateOnly(timestamp) : null,
      type: activity.type || null,
      action: activity.action || null,
      description: activity.description || null,
    });
  }

  const accountAdjustment =
    !ignoreAccountAdjustments &&
    account &&
    typeof account.netDepositAdjustment === 'number' &&
    Number.isFinite(account.netDepositAdjustment)
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

  let originalPeriodStartDate = null;
  if (Array.isArray(cashFlowEntries)) {
    for (const entry of cashFlowEntries) {
      const entryDate = parseCashFlowEntryDate(entry);
      if (entryDate && (!originalPeriodStartDate || entryDate < originalPeriodStartDate)) {
        originalPeriodStartDate = entryDate;
      }
    }
  }

  const allTimeCashFlows = cashFlowEntries;
  let effectiveCashFlows = cashFlowEntries;
  let appliedCagrStartDate = null;
  let preCagrNetDepositsCad = null;
  let appliedPeriodStartDate = null;
  let prePeriodNetDepositsCad = null;

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
        if (Number.isFinite(aggregatedAmount)) {
          const normalizedRolled = -aggregatedAmount;
          preCagrNetDepositsCad =
            Math.abs(normalizedRolled) < CASH_FLOW_EPSILON ? 0 : normalizedRolled;
        } else {
          preCagrNetDepositsCad = null;
        }
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

  if (requestedPeriodStartDate instanceof Date && !Number.isNaN(requestedPeriodStartDate.getTime())) {
    appliedPeriodStartDate = requestedPeriodStartDate;
    let aggregatedAmount = 0;
    let rolledEntryCount = 0;
    const filtered = [];
    for (const entry of effectiveCashFlows) {
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
      if (entryDate && entryDate < requestedPeriodStartDate) {
        aggregatedAmount += amount;
        rolledEntryCount += 1;
        continue;
      }
      filtered.push(entry);
    }
    if (rolledEntryCount > 0) {
      if (Number.isFinite(aggregatedAmount)) {
        const normalizedRolled = -aggregatedAmount;
        prePeriodNetDepositsCad =
          Math.abs(normalizedRolled) < CASH_FLOW_EPSILON ? 0 : normalizedRolled;
      } else {
        prePeriodNetDepositsCad = null;
      }
      if (aggregatedAmount !== 0) {
        filtered.unshift({ amount: aggregatedAmount, date: requestedPeriodStartDate.toISOString() });
      }
    } else if (prePeriodNetDepositsCad === null) {
      prePeriodNetDepositsCad = 0;
    }
    effectiveCashFlows = filtered;
  }

  const annualizedReturnRateAllTime = !conversionIncomplete
    ? computeAccountAnnualizedReturn(allTimeCashFlows, accountKey)
    : null;

  const annualizedReturnRate = !conversionIncomplete
    ? computeAccountAnnualizedReturn(effectiveCashFlows, accountKey)
    : null;

  const returnBreakdown = computeReturnBreakdownFromCashFlows(
    effectiveCashFlows,
    now,
    annualizedReturnRate
  );

  const incompleteReturnData = conversionIncomplete || missingCashFlowDates;

  const netDepositsAllTimeCad = Number.isFinite(combinedCadValue) ? combinedCadValue : null;
  const totalPnlAllTimeCad = Number.isFinite(totalPnlCad) ? totalPnlCad : null;
  const hasCagrOverride =
    appliedCagrStartDate instanceof Date && !Number.isNaN(appliedCagrStartDate.getTime());

  let netDepositsEffectiveCad = netDepositsAllTimeCad;
  let totalPnlEffectiveCad = totalPnlAllTimeCad;

  const priorNetDepositAdjustments = [];

  if (hasCagrOverride) {
    if (Number.isFinite(preCagrNetDepositsCad)) {
      priorNetDepositAdjustments.push(preCagrNetDepositsCad);
    } else if (preCagrNetDepositsCad !== null) {
      netDepositsEffectiveCad = null;
    }
  }

  if (prePeriodNetDepositsCad !== null) {
    if (Number.isFinite(prePeriodNetDepositsCad)) {
      priorNetDepositAdjustments.push(prePeriodNetDepositsCad);
    } else {
      netDepositsEffectiveCad = null;
    }
  }

  if (netDepositsEffectiveCad !== null && priorNetDepositAdjustments.length > 0) {
    const totalPriorNetDeposits = priorNetDepositAdjustments.reduce((sum, value) => sum + value, 0);
    const derivedNetDeposits = netDepositsAllTimeCad - totalPriorNetDeposits;
    if (Number.isFinite(derivedNetDeposits)) {
      netDepositsEffectiveCad =
        Math.abs(derivedNetDeposits) < CASH_FLOW_EPSILON ? 0 : derivedNetDeposits;
    } else {
      netDepositsEffectiveCad = null;
    }
  }

  if (totalEquityCad !== null && netDepositsEffectiveCad !== null) {
    const derivedPnl = totalEquityCad - netDepositsEffectiveCad;
    totalPnlEffectiveCad = Math.abs(derivedPnl) < CASH_FLOW_EPSILON ? 0 : derivedPnl;
  } else if (netDepositsEffectiveCad === null) {
    totalPnlEffectiveCad = null;
  }

  if (!Number.isFinite(netDepositsEffectiveCad)) {
    netDepositsEffectiveCad = null;
  }
  if (!Number.isFinite(totalPnlEffectiveCad)) {
    totalPnlEffectiveCad = null;
  }

  debugTotalPnl(accountKey, 'Net deposits summary', {
    perCurrency: perCurrencyObject,
    combinedCad: netDepositsAllTimeCad,
    effectiveCombinedCad: netDepositsEffectiveCad,
    totalEquityCad,
    totalPnlCad: totalPnlAllTimeCad,
    effectiveTotalPnlCad: totalPnlEffectiveCad,
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
  let annualizedReturnAllTime = undefined;
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

  if (annualizedReturn && appliedPeriodStartDate) {
    annualizedReturn.startDate = appliedPeriodStartDate.toISOString().slice(0, 10);
  }

  if (Number.isFinite(annualizedReturnRateAllTime)) {
    annualizedReturnAllTime = {
      rate: annualizedReturnRateAllTime,
      method: 'xirr',
      cashFlowCount: allTimeCashFlows.length,
      asOf: nowIsoString,
      incomplete: incompleteReturnData || undefined,
    };
  } else if (incompleteReturnData && allTimeCashFlows.length > 0) {
    annualizedReturnAllTime = {
      method: 'xirr',
      cashFlowCount: allTimeCashFlows.length,
      asOf: nowIsoString,
      incomplete: true,
    };
  }

  if (annualizedReturnAllTime && originalPeriodStartDate instanceof Date) {
    annualizedReturnAllTime.startDate = originalPeriodStartDate.toISOString().slice(0, 10);
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

  if (requestedPeriodStartDate instanceof Date && !Number.isNaN(requestedPeriodStartDate.getTime())) {
    normalizedPeriodStart = formatDateOnly(requestedPeriodStartDate);
  }

  if (requestedPeriodEndDate instanceof Date && !Number.isNaN(requestedPeriodEndDate.getTime())) {
    normalizedPeriodEnd = formatDateOnly(requestedPeriodEndDate);
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
      combinedCad: netDepositsEffectiveCad,
      allTimeCad: netDepositsAllTimeCad,
    },
    totalPnl: {
      combinedCad: totalPnlEffectiveCad,
      allTimeCad: totalPnlAllTimeCad,
    },
    totalEquityCad: Number.isFinite(totalEquityCad) ? totalEquityCad : null,
    annualizedReturn,
    annualizedReturnAllTime,
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
    cagrStartDate: appliedCagrStartDate ? formatDateOnly(appliedCagrStartDate) : undefined,
    originalPeriodStartDate: originalPeriodStartDate ? formatDateOnly(originalPeriodStartDate) : undefined,
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


const DIVIDEND_TIMEFRAME_DEFINITIONS = [
  { key: 'all', type: 'all' },
  { key: '1y', type: 'months', amount: 12 },
  { key: '6m', type: 'months', amount: 6 },
  { key: '1m', type: 'months', amount: 1 },
  { key: '1w', type: 'days', amount: 7 },
  { key: '1d', type: 'days', amount: 1 },
];

function normalizeDateInput(value) {
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
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

function normalizeRangeStart(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function normalizeRangeEndExclusive(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  const endOfDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  );
  return endOfDay;
}

function computeDividendTimeframeStart(referenceDate, definition) {
  if (!definition || definition.type === 'all') {
    return null;
  }
  const base =
    referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
  const startOfToday = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())
  );
  if (definition.type === 'months') {
    return addMonths(startOfToday, -Math.abs(definition.amount || 0));
  }
  if (definition.type === 'days') {
    return addDays(startOfToday, -Math.abs(definition.amount || 0));
  }
  return null;
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

  const rawStart = normalizeDateInput(options.startDate);
  const rawEnd = normalizeDateInput(options.endDate);
  const startFilter = normalizeRangeStart(rawStart);
  const endFilterExclusive = normalizeRangeEndExclusive(rawEnd);

  const filteredDividendActivities =
    startFilter || endFilterExclusive
      ? dividendActivities.filter((activity) => {
          const timestamp = resolveActivityTimestamp(activity);
          if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
            if (startFilter && timestamp < startFilter) {
              return false;
            }
            if (endFilterExclusive && timestamp >= endFilterExclusive) {
              return false;
            }
          }
          return true;
        })
      : dividendActivities;

  if (!filteredDividendActivities.length) {
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

  let lineItemCounter = 0;

  for (const activity of filteredDividendActivities) {
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
        latestDateKey: null,
        totalsByDate: new Map(),
        lineItems: [],
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
      const dateKey = formatDateOnly(timestamp);
      if (dateKey) {
        if (!entry.totalsByDate.has(dateKey)) {
          entry.totalsByDate.set(dateKey, new Map());
        }
        const dateTotals = entry.totalsByDate.get(dateKey);
        dateTotals.set(currency, (dateTotals.get(currency) || 0) + amount);
      }
      if (!entry.earliestTimestamp || timestamp < entry.earliestTimestamp) {
        entry.earliestTimestamp = timestamp;
      }
      if (!entry.latestTimestamp || timestamp > entry.latestTimestamp) {
        entry.latestTimestamp = timestamp;
        entry.latestAmount = amount;
        entry.latestCurrency = currency;
        entry.latestDateKey = dateKey || null;
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

    const normalizedCurrency = normalizeCurrency(currency) || '';
    const lineItemId = `${accountKey || 'acct'}:${lineItemCounter += 1}`;
    const dateKey = timestamp ? formatDateOnly(timestamp) : null;
    const lineCurrencyTotals = {};
    if (Number.isFinite(amount)) {
      lineCurrencyTotals[normalizedCurrency] = amount;
    }
    const activityDescription =
      typeof activity.description === 'string' && activity.description.trim()
        ? activity.description.trim()
        : null;

    entry.lineItems.push({
      lineItemId,
      symbol: symbolInfo.canonical || null,
      displaySymbol: symbolInfo.display || symbolInfo.canonical || symbolInfo.raw || null,
      rawSymbols: symbolInfo.raw ? [symbolInfo.raw] : undefined,
      description: activityDescription,
      currencyTotals: lineCurrencyTotals,
      amount,
      currency: normalizedCurrency,
      cadAmount: Number.isFinite(cadContribution) ? cadContribution : null,
      conversionIncomplete: !Number.isFinite(cadContribution),
      activityCount: 1,
      firstDate: dateKey,
      lastDate: dateKey,
      lastTimestamp: timestamp ? timestamp.toISOString() : null,
      lastAmount: Number.isFinite(amount) ? amount : null,
      lastCurrency: normalizedCurrency || null,
      accountId: accountKey || null,
    });
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
    const latestDateTotals =
      entry.latestDateKey && entry.totalsByDate instanceof Map
        ? entry.totalsByDate.get(entry.latestDateKey)
        : null;
    let latestCurrency = entry.latestCurrency || null;
    let latestAmount = Number.isFinite(entry.latestAmount) ? entry.latestAmount : null;
    if (latestDateTotals && latestDateTotals.size > 0) {
      if (latestCurrency && latestDateTotals.has(latestCurrency)) {
        const summed = latestDateTotals.get(latestCurrency);
        if (Number.isFinite(summed)) {
          latestAmount = summed;
        }
      } else if (latestDateTotals.size === 1) {
        const [currencyKey, summed] = latestDateTotals.entries().next().value;
        if (Number.isFinite(summed)) {
          latestAmount = summed;
          latestCurrency = currencyKey || null;
        }
      } else {
        const firstValid = Array.from(latestDateTotals.entries()).find(([, value]) =>
          Number.isFinite(value)
        );
        if (firstValid) {
          const [currencyKey, summed] = firstValid;
          latestAmount = summed;
          latestCurrency = currencyKey || latestCurrency;
        }
      }
    }

    const normalizedLineItems = Array.isArray(entry.lineItems)
      ? entry.lineItems
          .map((item) => {
            if (!item || typeof item !== 'object') {
              return null;
            }

            const itemCurrencyTotals = {};
            if (item.currencyTotals && typeof item.currencyTotals === 'object') {
              for (const [key, value] of Object.entries(item.currencyTotals)) {
                const numeric = Number(value);
                if (!Number.isFinite(numeric)) {
                  continue;
                }
                const normalizedKey = normalizeCurrency(key) || '';
                itemCurrencyTotals[normalizedKey] = (itemCurrencyTotals[normalizedKey] || 0) + numeric;
              }
            }
            if (!Object.keys(itemCurrencyTotals).length) {
              const numericAmount = Number(item.amount);
              if (Number.isFinite(numericAmount)) {
                const normalizedKey = normalizeCurrency(item.currency) || '';
                itemCurrencyTotals[normalizedKey] = (itemCurrencyTotals[normalizedKey] || 0) + numericAmount;
              }
            }

            const resolvedFirstDate =
              (typeof item.firstDate === 'string' && item.firstDate.trim()) ||
              (typeof item.startDate === 'string' && item.startDate.trim()) ||
              (typeof item.date === 'string' && item.date.trim()) ||
              (typeof item.lastTimestamp === 'string' && item.lastTimestamp.trim())
                ? item.lastTimestamp.trim().slice(0, 10)
                : null;
            const resolvedLastDate =
              (typeof item.lastDate === 'string' && item.lastDate.trim()) ||
              (typeof item.endDate === 'string' && item.endDate.trim()) ||
              resolvedFirstDate;
            const timestamp =
              (typeof item.lastTimestamp === 'string' && item.lastTimestamp.trim()) ||
              (typeof item.timestamp === 'string' && item.timestamp.trim()) ||
              null;
            const resolvedLastAmount = Number.isFinite(item.lastAmount)
              ? item.lastAmount
              : Number.isFinite(item.amount)
              ? item.amount
              : null;
            const resolvedLastCurrency =
              normalizeCurrency(item.lastCurrency) || normalizeCurrency(item.currency) || null;

            const rawLineSymbols = Array.isArray(item.rawSymbols)
              ? item.rawSymbols
                  .map((value) => (typeof value === 'string' ? value.trim() : ''))
                  .filter(Boolean)
              : rawSymbols;

            return {
              symbol: item.symbol || entry.canonical || null,
              displaySymbol:
                item.displaySymbol ||
                item.symbol ||
                displaySymbol ||
                (rawLineSymbols && rawLineSymbols.length ? rawLineSymbols[0] : null) ||
                null,
              rawSymbols: rawLineSymbols && rawLineSymbols.length ? rawLineSymbols : undefined,
              description: item.description || entry.description || null,
              currencyTotals: itemCurrencyTotals,
              cadAmount: Number.isFinite(item.cadAmount) ? item.cadAmount : null,
              conversionIncomplete: item.conversionIncomplete ? true : undefined,
              activityCount: Number.isFinite(item.activityCount) ? item.activityCount : 1,
              firstDate: resolvedFirstDate,
              lastDate: resolvedLastDate,
              lastTimestamp: timestamp,
              lastAmount: Number.isFinite(resolvedLastAmount) ? resolvedLastAmount : null,
              lastCurrency: resolvedLastCurrency,
              lineItemId:
                (typeof item.lineItemId === 'string' && item.lineItemId.trim()) ||
                (typeof item.id === 'string' && item.id.trim()) ||
                null,
              accountId: item.accountId || null,
            };
          })
          .filter(Boolean)
      : [];
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
      lastAmount: Number.isFinite(latestAmount) ? latestAmount : null,
      lastCurrency: latestCurrency || null,
      _magnitude: computeMagnitude({
        cadAmount,
        currencyTotals,
      }),
      lineItems: normalizedLineItems.length ? normalizedLineItems : undefined,
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

async function computeDividendSummaries(login, account, options = {}) {
  const baseOptions = options && typeof options === 'object' ? { ...options } : {};
  const baseSummary = await computeDividendBreakdown(login, account, baseOptions);
  if (!baseSummary) {
    return null;
  }

  // Build timeframe summaries. Avoid circular references by not
  // pointing `timeframes.all` at `baseSummary` directly.
  const timeframes = {};
  const referenceDate = new Date();

  for (const definition of DIVIDEND_TIMEFRAME_DEFINITIONS) {
    if (!definition || definition.key === 'all') {
      continue;
    }
    const timeframeStart = computeDividendTimeframeStart(referenceDate, definition);
    if (!timeframeStart) {
      continue;
    }
    const summary = await computeDividendBreakdown(login, account, {
      ...baseOptions,
      startDate: timeframeStart,
    });
    if (summary) {
      timeframes[definition.key] = summary;
    }
  }

  // Set the 'all' timeframe to a shallow copy so attaching
  // `timeframes` below does not create a circular structure.
  timeframes.all = { ...baseSummary };
  baseSummary.timeframes = timeframes;
  return baseSummary;
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

function normalizeYahooHistoricalEntries(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
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
}

function normalizeQuestradeCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const byDate = new Map();

  for (const candle of candles) {
    if (!candle || typeof candle !== 'object') {
      continue;
    }
    const start = candle.start || candle.time || candle.startTime || candle.end || null;
    if (typeof start !== 'string') {
      continue;
    }
    const parsed = new Date(start);
    if (Number.isNaN(parsed.getTime())) {
      continue;
    }
    const close = Number(candle.close);
    if (!Number.isFinite(close) || close <= 0) {
      continue;
    }
    const normalizedDate = new Date(
      Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
    );
    const key = normalizedDate.getTime();
    byDate.set(key, { date: normalizedDate, price: close });
  }

  return Array.from(byDate.values()).sort((a, b) => a.date - b.date);
}

async function fetchQuestradePriceHistorySeries(login, symbolId, startDate, exclusiveEnd, accountKey, symbol) {
  if (!login || !Number.isFinite(symbolId) || symbolId <= 0) {
    return [];
  }

  // Avoid duplicate network calls for identical candle windows
  try {
    const ck = `${symbolId}|${startDate.toISOString()}|${exclusiveEnd.toISOString()}`;
    if (questradeCandleCache.has(ck)) {
      return questradeCandleCache.get(ck) || [];
    }
  } catch (_) {
    // ignore cache read errors
  }

  const params = {
    startTime: startDate.toISOString(),
    endTime: exclusiveEnd.toISOString(),
    interval: 'OneDay',
  };

  let data;
  try {
    data = await questradeRequest(login, `/v1/markets/candles/${symbolId}`, { params });
  } catch (error) {
    if (DEBUG_TOTAL_PNL) {
      debugTotalPnl(accountKey, 'Questrade candle lookup failed for symbol price history', {
        symbol,
        symbolId,
        startDate: startDate.toISOString(),
        endDate: exclusiveEnd.toISOString(),
        message: error?.message || String(error),
      });
    }
    return [];
  }

  const candles = data && Array.isArray(data.candles) ? data.candles : [];
  const normalized = normalizeQuestradeCandles(candles);
  try {
    const ck = `${symbolId}|${startDate.toISOString()}|${exclusiveEnd.toISOString()}`;
    questradeCandleCache.set(ck, normalized);
  } catch (_) {
    // ignore cache write errors
  }
  return normalized;
}

async function fetchSymbolPriceHistory(symbol, startDateKey, endDateKey, options = {}) {
  if (!symbol || !startDateKey || !endDateKey) {
    return null;
  }

  const startDate = new Date(`${startDateKey}T00:00:00Z`);
  const endDate = new Date(`${endDateKey}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return null;
  }

  const exclusiveEnd = addDays(endDate, 1) || new Date(endDate.getTime() + DAY_IN_MS);

  // Try fetching via Yahoo with a few possible symbol variants
  const candidates = (() => {
    const base = resolveYahooSymbol(symbol) || symbol;
    const list = [base];
    if (/\.VN$/i.test(base)) {
      list.push(base.replace(/\.VN$/i, '.NE'));
      list.push(base.replace(/\.VN$/i, '.TO'));
    }
    // Deduplicate and keep order
    return Array.from(new Set(list));
  })();

  let normalized = [];
  for (const candidate of candidates) {
    // Use any existing cached range that fully covers the requested window
    try {
      const covering = (function findCoveringRange() {
        for (const [key, value] of priceHistoryCache.entries()) {
          if (!key || !value) continue;
          const parts = String(key).split('|');
          if (parts.length !== 3) continue;
          const [kSym, kStart, kEnd] = parts;
          if (String(kSym).toUpperCase() !== String(candidate).toUpperCase()) continue;
          if (typeof kStart === 'string' && typeof kEnd === 'string' && kStart <= startDateKey && kEnd >= endDateKey) {
            return value;
          }
        }
        return null;
      })();
      if (Array.isArray(covering) && covering.length) {
        return covering;
      }
    } catch (_) { /* ignore */ }
    // Reuse in-memory cached normalized history when available
    try {
      const cacheKey = getPriceHistoryCacheKey(candidate, startDateKey, endDateKey);
      const cached = getCachedPriceHistory(cacheKey);
      if (cached && cached.hit) {
        return cached.value;
      }
    } catch (_) { /* ignore cache errors */ }
    let history = null;
    try {
      history = await fetchYahooHistorical(candidate, {
        period1: startDate,
        period2: exclusiveEnd,
        interval: '1d',
      });
    } catch (error) {
      history = null;
    }
    normalized = normalizeYahooHistoricalEntries(history);
    if (normalized.length) {
      try {
        const cacheKey = getPriceHistoryCacheKey(candidate, startDateKey, endDateKey);
        setCachedPriceHistory(cacheKey, normalized);
      } catch (_) { /* ignore cache errors */ }
      break;
    }
  }

  if (!normalized.length && options && options.login) {
    const rawSymbolId = Number.isFinite(options.symbolId)
      ? options.symbolId
      : Number(options.symbolId);
    const symbolId = Number.isFinite(rawSymbolId) ? rawSymbolId : null;
    if (symbolId && symbolId > 0) {
      if (DEBUG_TOTAL_PNL) {
        debugTotalPnl(options.accountKey, 'Falling back to Questrade candles for price history', {
          symbol,
          symbolId,
          startDateKey,
          endDateKey,
        });
      }
      normalized = await fetchQuestradePriceHistorySeries(
        options.login,
        symbolId,
        startDate,
        exclusiveEnd,
        options.accountKey,
        symbol
      );
    }
  }

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
    const targetDate = parseDateOnlyString(dateKey);
    const targetTime =
      targetDate instanceof Date && !Number.isNaN(targetDate.getTime())
        ? targetDate.getTime() + DAY_IN_MS - 1
        : Number.NaN;
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

async function computeDailyNetDeposits(activityContext, account, accountKey, options = {}) {
  const activities = Array.isArray(activityContext.activities) ? activityContext.activities : [];
  const fundingActivities = dedupeActivities(filterFundingActivities(activities));
  const perDay = new Map();
  let conversionIncomplete = false;
  for (const activity of fundingActivities) {
    const details = await resolveFundingActivityAmountDetails(activity, accountKey, activityContext);
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

  const ignoreAdjustments =
    options && Object.prototype.hasOwnProperty.call(options, 'ignoreAccountAdjustments')
      ? !!options.ignoreAccountAdjustments
      : false;
  const accountAdjustment =
    !ignoreAdjustments &&
    account &&
    typeof account.netDepositAdjustment === 'number' &&
    Number.isFinite(account.netDepositAdjustment)
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

function computeLedgerEquitySnapshot(
  dateKey,
  holdings,
  cashByCurrency,
  symbolMeta,
  priceSeriesMap,
  usdRate,
  options = {}
) {
  let cadValue = 0;
  let usdValue = 0;
  const missingPrices = [];
  const unsupportedCurrencies = new Set();
  const reserveSymbols = options && options.reserveSymbols instanceof Set
    ? options.reserveSymbols
    : RESERVE_SYMBOL_SET;
  let cadReserveSecurities = 0;
  let usdReserveSecurities = 0;
  let cadDeployedSecurities = 0;
  let usdDeployedSecurities = 0;

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
    const normalizedSymbol = symbol;
    const isReserve = reserveSymbols.has(normalizedSymbol);
    if (currency === 'USD') {
      usdValue += positionValue;
      if (isReserve) {
        usdReserveSecurities += positionValue;
      } else {
        usdDeployedSecurities += positionValue;
      }
    } else if (currency === 'CAD' || !currency) {
      cadValue += positionValue;
      if (isReserve) {
        cadReserveSecurities += positionValue;
      } else {
        cadDeployedSecurities += positionValue;
      }
    } else {
      unsupportedCurrencies.add(currency);
    }
  }

  const cadCash = cashByCurrency.get('CAD') || 0;
  const usdCash = cashByCurrency.get('USD') || 0;
  cadValue += cadCash;
  usdValue += usdCash;

  const cadReserveTotal = cadCash + cadReserveSecurities;
  const usdReserveTotal = usdCash + usdReserveSecurities;
  const cadDeployedTotal = cadDeployedSecurities;
  const usdDeployedTotal = usdDeployedSecurities;

  let equityCad = cadValue;
  let reserveValueCad = cadReserveTotal;
  let reserveSecurityValueCad = cadReserveSecurities;
  let deployedValueCad = cadDeployedTotal;
  let deployedSecurityValueCad = cadDeployedSecurities;
  let hasUsdConversionIssue = false;
  if (Math.abs(usdValue) > 0.00001) {
    if (Number.isFinite(usdRate) && usdRate > 0) {
      equityCad += usdValue * usdRate;
      reserveValueCad += usdReserveTotal * usdRate;
      reserveSecurityValueCad += usdReserveSecurities * usdRate;
      deployedValueCad += usdDeployedTotal * usdRate;
      deployedSecurityValueCad += usdDeployedSecurities * usdRate;
    } else {
      unsupportedCurrencies.add('USD');
      hasUsdConversionIssue = Math.abs(usdReserveTotal) > 0.00001 || Math.abs(usdDeployedTotal) > 0.00001;
    }
  }

  if (hasUsdConversionIssue) {
    reserveValueCad = null;
    reserveSecurityValueCad = null;
    deployedValueCad = null;
    deployedSecurityValueCad = null;
  }

  return {
    equityCad,
    missingPrices,
    unsupportedCurrencies: Array.from(unsupportedCurrencies),
    cadCash,
    usdCash,
    cadSecurityValue: cadValue - cadCash,
    usdSecurityValue: usdValue - usdCash,
    reserveValueCad,
    reserveSecurityValueCad,
    deployedValueCad,
    deployedSecurityValueCad,
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

  const reserveSymbols = (() => {
    if (options && options.reserveSymbols instanceof Set) {
      return options.reserveSymbols;
    }
    if (options && Array.isArray(options.reserveSymbols)) {
      return new Set(
        options.reserveSymbols
          .map((symbol) => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : ''))
          .filter(Boolean)
      );
    }
    return RESERVE_SYMBOL_SET;
  })();

  const netDepositOptions = {
    applyAccountCagrStartDate:
      Object.prototype.hasOwnProperty.call(options, 'applyAccountCagrStartDate')
        ? !!options.applyAccountCagrStartDate
        : true,
    ignoreAccountAdjustments:
      options && Object.prototype.hasOwnProperty.call(options, 'ignoreAccountAdjustments')
        ? !!options.ignoreAccountAdjustments
        : false,
  };

  const netDepositsSummary = await computeNetDepositsCore(account, perAccountCombinedBalances, netDepositOptions, activityContext);
  if (!netDepositsSummary) {
    return null;
  }

  // Choose a conservative series start: prefer the earliest available activity/crawl start so we can
  // compute a correct baseline even when a CAGR start date is applied.
  const candidateStarts = [];
  if (typeof options.startDate === 'string' && options.startDate.trim()) {
    candidateStarts.push(options.startDate.trim());
  }
  if (typeof netDepositsSummary.periodStartDate === 'string' && netDepositsSummary.periodStartDate.trim()) {
    candidateStarts.push(netDepositsSummary.periodStartDate.trim());
  }
  const crawlStartIso = formatDateOnly(activityContext.crawlStart) || null;
  if (crawlStartIso) {
    candidateStarts.push(crawlStartIso);
  }
  const nowIso = formatDateOnly(activityContext.now) || null;
  if (nowIso) {
    candidateStarts.push(nowIso);
  }
  // Pick the earliest valid date among candidates
  let startDateIso = null;
  if (candidateStarts.length) {
    const valid = candidateStarts
      .map((d) => ({ d, t: Date.parse(d + 'T00:00:00Z') }))
      .filter((x) => Number.isFinite(x.t));
    if (valid.length) {
      valid.sort((a, b) => a.t - b.t);
      startDateIso = valid[0].d;
    }
  }
  if (!startDateIso) {
    startDateIso = netDepositsSummary.periodStartDate || crawlStartIso || nowIso;
  }
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
    const directSymbol = normalizeSymbol(activity.symbol);
    const fallbackSymbol = resolveActivitySymbol(activity);
    const resolvedSymbol = directSymbol || fallbackSymbol || null;
    processedActivities.push({ activity, timestamp, dateKey, symbol: resolvedSymbol });

    const symbolId = Number(activity.symbolId);
    const activityCurrency = normalizeCurrency(activity.currency) || null;
    const isTrade = isOrderLikeActivity(activity);
    const activityDesc = [activity.type || '', activity.action || '', activity.description || ''].join(' ');
    const isIncome = INCOME_ACTIVITY_REGEX.test(activityDesc);
    const preferredFromActivity = (isTrade || isIncome) ? activityCurrency : null;

    if (Number.isFinite(symbolId) && symbolId > 0) {
      symbolIds.add(symbolId);
    }

    if (!resolvedSymbol) {
      return;
    }

    if (!symbolMeta.has(resolvedSymbol)) {
      symbolMeta.set(resolvedSymbol, {
        symbolId: Number.isFinite(symbolId) && symbolId > 0 ? symbolId : null,
        currency: preferredFromActivity || inferSymbolCurrency(resolvedSymbol) || null,
        activityCurrency,
      });
    } else {
      const meta = symbolMeta.get(resolvedSymbol);
      if (meta) {
        if ((!meta.symbolId || meta.symbolId <= 0) && Number.isFinite(symbolId) && symbolId > 0) {
          meta.symbolId = symbolId;
        }
        if (preferredFromActivity && meta.currency !== preferredFromActivity) {
          meta.currency = preferredFromActivity;
        } else if (!meta.currency) {
          meta.currency = inferSymbolCurrency(resolvedSymbol) || null;
        }
        if (!meta.activityCurrency && activityCurrency) {
          meta.activityCurrency = activityCurrency;
        }
      }
    }
  });

  processedActivities.sort((a, b) => a.timestamp - b.timestamp);

  // Fetch symbol details early and augment activities missing symbols using symbolId
  let symbolDetails = {};
  if (symbolIds.size > 0) {
    try {
      symbolDetails = await fetchSymbolsDetails(login, Array.from(symbolIds));
    } catch (symbolError) {
      symbolDetails = {};
    }
  }
  if (processedActivities.length && symbolDetails && typeof symbolDetails === 'object') {
    for (const entry of processedActivities) {
      if (!entry || entry.symbol) {
        continue;
      }
      const id = Number(entry.activity && entry.activity.symbolId);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }
      const detail = symbolDetails[id];
      const detailSymbol = detail && typeof detail.symbol === 'string' ? detail.symbol : null;
      const normalized = detailSymbol ? normalizeSymbol(detailSymbol) : null;
      if (!normalized) {
        continue;
      }
      entry.symbol = normalized;
      const activityCurrencyForEntry = normalizeCurrency(entry.activity && entry.activity.currency) || null;
      const entryIsTrade = isOrderLikeActivity(entry.activity);
      const entryDesc = [entry.activity?.type || '', entry.activity?.action || '', entry.activity?.description || ''].join(' ');
      const entryIsIncome = INCOME_ACTIVITY_REGEX.test(entryDesc);
      const preferredFromActivity = (entryIsTrade || entryIsIncome) ? activityCurrencyForEntry : null;
      if (!symbolMeta.has(normalized)) {
        symbolMeta.set(normalized, {
          symbolId: id,
          currency:
            (detail && normalizeCurrency(detail.currency)) || preferredFromActivity || inferSymbolCurrency(normalized) || null,
          activityCurrency: activityCurrencyForEntry,
        });
      } else {
        const meta = symbolMeta.get(normalized);
        if (meta) {
          if ((!meta.symbolId || meta.symbolId <= 0)) {
            meta.symbolId = id;
          }
          const detailCurrency = (detail && normalizeCurrency(detail.currency)) || null;
          if (detailCurrency && meta.currency !== detailCurrency) {
            meta.currency = detailCurrency;
          } else if (preferredFromActivity && meta.currency !== preferredFromActivity) {
            meta.currency = preferredFromActivity;
          }
          if (!meta.activityCurrency && activityCurrencyForEntry) {
            meta.activityCurrency = activityCurrencyForEntry;
          }
        }
      }
    }
  }

  const accountNumber = account.number || account.accountNumber || account.id;

  const closingHoldings = new Map();
  const closingCashByCurrency = new Map();

  if (perAccountCombinedBalances && perAccountCombinedBalances[accountKey]) {
    const balanceSummary = perAccountCombinedBalances[accountKey];
    const combinedBalances =
      balanceSummary && balanceSummary.combined && typeof balanceSummary.combined === 'object'
        ? balanceSummary.combined
        : balanceSummary;
    if (combinedBalances && typeof combinedBalances === 'object') {
      Object.keys(combinedBalances).forEach((key) => {
        const entry = combinedBalances[key];
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const currency = normalizeCurrency(entry.currency || key);
        const cashValue = Number(entry.cash);
        if (!currency || !Number.isFinite(cashValue) || Math.abs(cashValue) < 0.00001) {
          return;
        }
        const current = closingCashByCurrency.has(currency) ? closingCashByCurrency.get(currency) : 0;
        closingCashByCurrency.set(currency, current + cashValue);
      });
    }
  }

  let closingPositions = [];
  const canFetchPositions =
    login && typeof login === 'object' && (login.refreshToken || login.accessToken || login.sessionToken);
  // Prefer caller-provided positions to avoid duplicate provider requests within the same flow
  if (Array.isArray(options.providedPositions)) {
    closingPositions = options.providedPositions;
  } else if (canFetchPositions && accountNumber) {
    try {
      closingPositions = await fetchPositions(login, accountNumber);
    } catch (positionError) {
      closingPositions = [];
    }
  }

  if (Array.isArray(closingPositions)) {
    closingPositions.forEach((position) => {
      if (!position || typeof position !== 'object') {
        return;
      }
      const symbol = normalizeSymbol(position.symbol);
      if (!symbol) {
        return;
      }
      const quantity = Number(position.openQuantity);
      if (Number.isFinite(quantity) && Math.abs(quantity) >= LEDGER_QUANTITY_EPSILON) {
        const existingQuantity = closingHoldings.has(symbol) ? closingHoldings.get(symbol) : 0;
        closingHoldings.set(symbol, existingQuantity + quantity);
      }
      const symbolId = Number(position.symbolId);
      if (Number.isFinite(symbolId) && symbolId > 0) {
        symbolIds.add(symbolId);
      }
      if (!symbolMeta.has(symbol)) {
        symbolMeta.set(symbol, {
          symbolId: Number.isFinite(symbolId) && symbolId > 0 ? symbolId : null,
          currency: inferSymbolCurrency(symbol),
        });
      } else {
        const meta = symbolMeta.get(symbol);
        if (meta) {
          if ((!meta.symbolId || meta.symbolId <= 0) && Number.isFinite(symbolId) && symbolId > 0) {
            meta.symbolId = symbolId;
          }
          if (!meta.currency) {
            meta.currency = inferSymbolCurrency(symbol);
          }
        }
      }
    });
  }

  let seededHoldings = null;
  let seededCash = null;
  const hasPreStartPositionActivity = processedActivities.some((entry) => {
    if (!entry || !(entry.timestamp instanceof Date) || entry.timestamp >= startDate) {
      return false;
    }
    const qty = Number(entry.activity && entry.activity.quantity);
    return Number.isFinite(qty) && Math.abs(qty) >= LEDGER_QUANTITY_EPSILON;
  });
  if ((closingHoldings.size || closingCashByCurrency.size) && hasPreStartPositionActivity) {
    seededHoldings = closingHoldings.size ? new Map(closingHoldings) : new Map();
    seededCash = closingCashByCurrency.size ? new Map(closingCashByCurrency) : new Map();
    if (processedActivities.length) {
      const endTimestamp =
        endDate instanceof Date && !Number.isNaN(endDate.getTime()) ? endDate.getTime() + DAY_IN_MS : null;
      const reversed = processedActivities
        .filter((entry) => {
          if (!entry || !(entry.timestamp instanceof Date) || Number.isNaN(entry.timestamp.getTime())) {
            return false;
          }
          if (endTimestamp !== null && entry.timestamp.getTime() > endTimestamp) {
            return false;
          }
          return true;
        })
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp);
      for (const entry of reversed) {
        if (!entry || !entry.activity) {
          continue;
        }
        const activity = entry.activity;
        const symbol = entry.symbol || resolveActivitySymbol(activity) || null;
        const quantity = Number(activity.quantity);
        if (
          symbol &&
          seededHoldings &&
          Number.isFinite(quantity) &&
          Math.abs(quantity) >= LEDGER_QUANTITY_EPSILON
        ) {
          adjustHolding(seededHoldings, symbol, -quantity);
        }
        const currency = normalizeCurrency(activity.currency);
        const netAmount = Number(activity.netAmount);
        if (
          seededCash &&
          currency &&
          Number.isFinite(netAmount) &&
          Math.abs(netAmount) >= CASH_FLOW_EPSILON / 10
        ) {
          adjustCash(seededCash, currency, -netAmount);
        }
      }
    }
  } else {
    // No activity precedes the period start; avoid seeding phantom holdings/cash.
    seededHoldings = new Map();
    seededCash = new Map();
  }

  // symbolDetails may already be fetched above; if not, fetch now
  if ((!symbolDetails || Object.keys(symbolDetails).length === 0) && symbolIds.size > 0) {
    try {
      symbolDetails = await fetchSymbolsDetails(login, Array.from(symbolIds));
    } catch (symbolError) {
      symbolDetails = {};
    }
  }

  for (const [symbol, meta] of symbolMeta.entries()) {
    if (!meta || typeof meta !== 'object') {
      continue;
    }
    const detailCurrency =
      meta.symbolId && symbolDetails && symbolDetails[meta.symbolId]
        ? normalizeCurrency(symbolDetails[meta.symbolId].currency)
        : null;
    if (detailCurrency) {
      meta.currency = detailCurrency;
    }
    if (!meta.currency) {
      const inferredCurrency = inferSymbolCurrency(symbol);
      if (inferredCurrency) {
        meta.currency = inferredCurrency;
      } else if (meta.activityCurrency) {
        meta.currency = meta.activityCurrency;
      } else {
        meta.currency = 'CAD';
      }
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
          const meta = symbolMeta.get(symbol) || {};
          const rawSymbolId =
            typeof meta.symbolId === 'number' ? meta.symbolId : Number(meta.symbolId);
          const normalizedSymbolId = Number.isFinite(rawSymbolId) && rawSymbolId > 0 ? rawSymbolId : null;
          history = await fetchSymbolPriceHistory(symbol, startKey, endKey, {
            login,
            symbolId: normalizedSymbolId,
            accountKey,
          });
        } catch (priceError) {
          history = null;
        }
        if (Array.isArray(history) && cacheKey) {
          setCachedPriceHistory(cacheKey, history);
        }
      }
      if (Array.isArray(history)) {
        priceSeriesMap.set(symbol, buildDailyPriceSeries(history, dateKeys));
      } else {
        priceSeriesMap.set(symbol, new Map());
        missingPriceSymbols.add(symbol);
      }
    });
  }

  

  const { perDay: dailyNetDepositsMap, conversionIncomplete } = await computeDailyNetDeposits(
    activityContext,
    account,
    accountKey,
    { ignoreAccountAdjustments: netDepositOptions.ignoreAccountAdjustments }
  );

  const holdings = seededHoldings || new Map();
  const cashByCurrency = seededCash || new Map();
  const usdRateCache = new Map();
  const points = [];
  const issues = new Set();
  let cumulativeNetDeposits = 0;
  const effectiveNetDepositsCad =
    netDepositsSummary.netDeposits && Number.isFinite(netDepositsSummary.netDeposits.combinedCad)
      ? netDepositsSummary.netDeposits.combinedCad
      : null;
  const allTimeNetDepositsCad =
    netDepositsSummary.netDeposits && Number.isFinite(netDepositsSummary.netDeposits.allTimeCad)
      ? netDepositsSummary.netDeposits.allTimeCad
      : null;
  if (allTimeNetDepositsCad !== null && effectiveNetDepositsCad !== null) {
    let baselineNetDeposits = allTimeNetDepositsCad - effectiveNetDepositsCad;
    if (Math.abs(baselineNetDeposits) < CASH_FLOW_EPSILON / 10) {
      baselineNetDeposits = 0;
    }
    cumulativeNetDeposits = baselineNetDeposits;
  } else if (dailyNetDepositsMap.size && dateKeys.length) {
    const firstDateKey = dateKeys[0];
    let rolledNetDeposits = 0;
    for (const [dateKey, value] of dailyNetDepositsMap.entries()) {
      if (typeof dateKey !== 'string' || !Number.isFinite(value)) {
        continue;
      }
      if (dateKey < firstDateKey && Math.abs(value) >= CASH_FLOW_EPSILON / 10) {
        rolledNetDeposits += value;
      }
    }
    if (Math.abs(rolledNetDeposits) < CASH_FLOW_EPSILON / 10) {
      rolledNetDeposits = 0;
    }
    cumulativeNetDeposits = rolledNetDeposits;
  }
  let activityIndex = 0;

  for (const dateKey of dateKeys) {
    while (activityIndex < processedActivities.length && processedActivities[activityIndex].dateKey <= dateKey) {
      const entry = processedActivities[activityIndex];
      const { activity } = entry;
      const currency = normalizeCurrency(activity.currency);
      const netAmount = Number(activity.netAmount);
      const quantity = Number(activity.quantity);
      const symbol = entry && entry.symbol ? entry.symbol : resolveActivitySymbol(activity) || null;

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

    const series = priceSeriesMap.get(targetSymbol) || new Map();
    const nativePrice = series.get(dateKey);
    let priceCad = null;
    if (Number.isFinite(nativePrice)) {
      const priceCurrency = (symbolMeta.get(targetSymbol) && symbolMeta.get(targetSymbol).currency) || 'CAD';
      if (priceCurrency === 'USD') {
        priceCad = Number.isFinite(usdRate) && usdRate > 0 ? nativePrice * usdRate : null;
      } else {
        priceCad = nativePrice;
      }
    }

    const snapshot = computeLedgerEquitySnapshot(
      dateKey,
      holdings,
      cashByCurrency,
      symbolMeta,
      priceSeriesMap,
      usdRate,
      { reserveSymbols }
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

    const reserveValueCad = Number.isFinite(snapshot.reserveValueCad) ? snapshot.reserveValueCad : null;
    const deployedValueCad = Number.isFinite(snapshot.deployedValueCad) ? snapshot.deployedValueCad : null;
    let deployedPercent = null;
    if (Number.isFinite(deployedValueCad) && Number.isFinite(equityCad) && Math.abs(equityCad) > 0.00001) {
      deployedPercent = (deployedValueCad / equityCad) * 100;
    }
    let reservePercent = null;
    if (Number.isFinite(reserveValueCad) && Number.isFinite(equityCad) && Math.abs(equityCad) > 0.00001) {
      reservePercent = (reserveValueCad / equityCad) * 100;
    }

    points.push({
      date: dateKey,
      equityCad,
      cumulativeNetDepositsCad,
      totalPnlCad,
      usdToCadRate: Number.isFinite(usdRate) ? usdRate : undefined,
      reserveValueCad,
      reserveSecurityValueCad: Number.isFinite(snapshot.reserveSecurityValueCad)
        ? snapshot.reserveSecurityValueCad
        : undefined,
      deployedValueCad,
      deployedSecurityValueCad: Number.isFinite(snapshot.deployedSecurityValueCad)
        ? snapshot.deployedSecurityValueCad
        : undefined,
      deployedPercent: Number.isFinite(deployedPercent) ? deployedPercent : undefined,
      reservePercent: Number.isFinite(reservePercent) ? reservePercent : undefined,
    });
  }

  const rawFirstPnl = points.length ? points[0].totalPnlCad : null;
  const rawLastPnl = points.length ? points[points.length - 1].totalPnlCad : null;
  const rawFirstPointTotals = points.length
    ? {
        totalPnlCad: Number.isFinite(points[0].totalPnlCad) ? points[0].totalPnlCad : null,
        equityCad: Number.isFinite(points[0].equityCad) ? points[0].equityCad : null,
        cumulativeNetDepositsCad: Number.isFinite(points[0].cumulativeNetDepositsCad)
          ? points[0].cumulativeNetDepositsCad
          : null,
      }
    : {
        totalPnlCad: null,
        equityCad: null,
        cumulativeNetDepositsCad: null,
      };

  const applyCagrStart = options.applyAccountCagrStartDate !== false;
  const shouldScalePnl = false; // disable P&L scaling to avoid distorting shape
  const targetStartPnl = Number.isFinite(rawFirstPnl) ? rawFirstPnl : 0;
  const targetEndPnlCandidate =
    netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.allTimeCad)
      ? netDepositsSummary.totalPnl.allTimeCad
      : netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.combinedCad)
        ? netDepositsSummary.totalPnl.combinedCad
        : null;

  if (
    applyCagrStart && shouldScalePnl &&
    Number.isFinite(rawFirstPnl) &&
    Number.isFinite(rawLastPnl) &&
    Number.isFinite(targetEndPnlCandidate) &&
    Math.abs(rawLastPnl - rawFirstPnl) >= CASH_FLOW_EPSILON
  ) {
    const scale = (targetEndPnlCandidate - targetStartPnl) / (rawLastPnl - rawFirstPnl);
    points.forEach((point) => {
      if (!point) {
        return;
      }
      const rawPnl = Number(point.totalPnlCad);
      if (!Number.isFinite(rawPnl)) {
        return;
      }
      const adjusted = targetStartPnl + (rawPnl - rawFirstPnl) * scale;
      point.totalPnlCad = Math.abs(adjusted) < CASH_FLOW_EPSILON ? 0 : adjusted;
      if (Number.isFinite(point.cumulativeNetDepositsCad)) {
        const adjustedEquity = point.cumulativeNetDepositsCad + point.totalPnlCad;
        point.equityCad = Math.abs(adjustedEquity) < CASH_FLOW_EPSILON ? 0 : adjustedEquity;
      }
    });
  }

  const summaryTotalPnlCombined =
    netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.combinedCad)
      ? netDepositsSummary.totalPnl.combinedCad
      : null;
  let summaryTotalPnlAllTime =
    netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.allTimeCad)
      ? netDepositsSummary.totalPnl.allTimeCad
      : null;
  let summaryTotalPnl = summaryTotalPnlCombined;
  if (summaryTotalPnl === null && Number.isFinite(summaryTotalPnlAllTime)) {
    summaryTotalPnl = summaryTotalPnlAllTime;
  }
  if (summaryTotalPnlAllTime === null && Number.isFinite(summaryTotalPnl)) {
    summaryTotalPnlAllTime = summaryTotalPnl;
  }
  const summaryNetDeposits =
    netDepositsSummary.netDeposits && Number.isFinite(netDepositsSummary.netDeposits.combinedCad)
      ? netDepositsSummary.netDeposits.combinedCad
      : null;
  const summaryNetDepositsAllTime =
    netDepositsSummary.netDeposits && Number.isFinite(netDepositsSummary.netDeposits.allTimeCad)
      ? netDepositsSummary.netDeposits.allTimeCad
      : summaryNetDeposits;
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
      const effectiveSummaryPnl = Number.isFinite(summaryTotalPnlAllTime)
        ? summaryTotalPnlAllTime
        : Number.isFinite(summaryTotalPnl)
          ? summaryTotalPnl
          : null;
      if (Number.isFinite(summaryEquity)) {
        last.equityCad = summaryEquity;
        if (Number.isFinite(last.cumulativeNetDepositsCad)) {
          last.totalPnlCad = summaryEquity - last.cumulativeNetDepositsCad;
        } else if (effectiveSummaryPnl !== null) {
          last.totalPnlCad = effectiveSummaryPnl;
        }
      } else if (effectiveSummaryPnl !== null) {
        last.totalPnlCad = effectiveSummaryPnl;
        if (Number.isFinite(last.cumulativeNetDepositsCad)) {
          last.equityCad = effectiveSummaryPnl + last.cumulativeNetDepositsCad;
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

  const normalizedPoints = filteredPoints.map((point) => ({ ...point }));

  const displayStartPoint = normalizedPoints.length ? normalizedPoints[0] : null;
  let displayStartTotals = displayStartPoint
    ? {
        totalPnlCad: Number.isFinite(displayStartPoint.totalPnlCad) ? displayStartPoint.totalPnlCad : null,
        equityCad: Number.isFinite(displayStartPoint.equityCad) ? displayStartPoint.equityCad : null,
        cumulativeNetDepositsCad: Number.isFinite(displayStartPoint.cumulativeNetDepositsCad)
          ? displayStartPoint.cumulativeNetDepositsCad
          : null,
      }
    : null;

  // Establish baseline totals for since-start deltas. To exclude P&L strictly before the display start,
  // use the absolute totals from the day immediately prior to the display start when available; otherwise
  // fall back to the first displayed point's absolute totals.
  let baselineTotals = null;
  if (normalizedPoints.length) {
    let prevDayTotals = null;
    if (displayStartDate && Array.isArray(points) && points.length > 0) {
      const displayStartKey = formatDateOnly(displayStartDate);
      const startIndex = points.findIndex((p) => p && p.date === displayStartKey);
      if (startIndex > 0) {
        const prev = points[startIndex - 1];
        prevDayTotals = {
          totalPnlCad: Number.isFinite(prev.totalPnlCad) ? prev.totalPnlCad : null,
          equityCad: Number.isFinite(prev.equityCad) ? prev.equityCad : null,
          cumulativeNetDepositsCad: Number.isFinite(prev.cumulativeNetDepositsCad)
            ? prev.cumulativeNetDepositsCad
            : null,
        };
      }
    }

    const sourceTotals = prevDayTotals || displayStartTotals || rawFirstPointTotals;
    baselineTotals = {
      equityCad:
        sourceTotals && Number.isFinite(sourceTotals.equityCad)
          ? sourceTotals.equityCad
          : Number.isFinite(rawFirstPointTotals.equityCad)
            ? rawFirstPointTotals.equityCad
            : null,
      cumulativeNetDepositsCad:
        sourceTotals && Number.isFinite(sourceTotals.cumulativeNetDepositsCad)
          ? sourceTotals.cumulativeNetDepositsCad
          : Number.isFinite(rawFirstPointTotals.cumulativeNetDepositsCad)
            ? rawFirstPointTotals.cumulativeNetDepositsCad
            : null,
      totalPnlCad:
        sourceTotals && Number.isFinite(sourceTotals.totalPnlCad)
          ? sourceTotals.totalPnlCad
          : Number.isFinite(rawFirstPointTotals.totalPnlCad)
            ? rawFirstPointTotals.totalPnlCad
            : null,
    };

    normalizedPoints.forEach((entry, index) => {
      if (baselineTotals.totalPnlCad !== null && Number.isFinite(entry.totalPnlCad)) {
        const relativePnl = entry.totalPnlCad - baselineTotals.totalPnlCad;
        entry.totalPnlSinceDisplayStartCad =
          Math.abs(relativePnl) < CASH_FLOW_EPSILON ? 0 : relativePnl;
      }
      if (baselineTotals.equityCad !== null && Number.isFinite(entry.equityCad)) {
        const relativeEquity = entry.equityCad - baselineTotals.equityCad;
        entry.equitySinceDisplayStartCad =
          Math.abs(relativeEquity) < CASH_FLOW_EPSILON ? 0 : relativeEquity;
      }
      if (
        baselineTotals.cumulativeNetDepositsCad !== null &&
        Number.isFinite(entry.cumulativeNetDepositsCad)
      ) {
        const relativeDeposits = entry.cumulativeNetDepositsCad - baselineTotals.cumulativeNetDepositsCad;
        entry.cumulativeNetDepositsSinceDisplayStartCad =
          Math.abs(relativeDeposits) < CASH_FLOW_EPSILON ? 0 : relativeDeposits;
      }
      if (index === 0) {
        if (Number.isFinite(entry.totalPnlSinceDisplayStartCad)) {
          entry.totalPnlSinceDisplayStartCad = 0;
        }
        if (Number.isFinite(entry.equitySinceDisplayStartCad)) {
          entry.equitySinceDisplayStartCad = 0;
        }
        if (Number.isFinite(entry.cumulativeNetDepositsSinceDisplayStartCad)) {
          entry.cumulativeNetDepositsSinceDisplayStartCad = 0;
        }
      }
    });
  }

  let summaryTotalPnlSinceDisplayStart = null;
  // Prefer the series' last since-start value when available to avoid mismatches with funding summaries
  const lastNormalized = normalizedPoints.length ? normalizedPoints[normalizedPoints.length - 1] : null;
  if (lastNormalized && Number.isFinite(lastNormalized.totalPnlSinceDisplayStartCad)) {
    summaryTotalPnlSinceDisplayStart = lastNormalized.totalPnlSinceDisplayStartCad;
  } else {
    const baselinePnlForSummary =
      baselineTotals && Number.isFinite(baselineTotals.totalPnlCad)
        ? baselineTotals.totalPnlCad
        : Number.isFinite(rawFirstPointTotals.totalPnlCad)
          ? rawFirstPointTotals.totalPnlCad
          : null;
    if (Number.isFinite(summaryTotalPnlAllTime) && baselinePnlForSummary !== null) {
      const delta = summaryTotalPnlAllTime - baselinePnlForSummary;
      summaryTotalPnlSinceDisplayStart = Math.abs(delta) < CASH_FLOW_EPSILON ? 0 : delta;
    } else if (
      netDepositsSummary.totalPnl &&
      Number.isFinite(netDepositsSummary.totalPnl.combinedCad)
    ) {
      summaryTotalPnlSinceDisplayStart = netDepositsSummary.totalPnl.combinedCad;
    }
  }

  let summaryEquitySinceDisplayStart = null;
  const baselineEquityForSummary =
    baselineTotals && Number.isFinite(baselineTotals.equityCad)
      ? baselineTotals.equityCad
      : Number.isFinite(rawFirstPointTotals.equityCad)
        ? rawFirstPointTotals.equityCad
        : null;
  if (lastNormalized && Number.isFinite(lastNormalized.equitySinceDisplayStartCad)) {
    summaryEquitySinceDisplayStart = lastNormalized.equitySinceDisplayStartCad;
  } else {
    if (Number.isFinite(summaryEquity) && baselineEquityForSummary !== null) {
      const deltaEquity = summaryEquity - baselineEquityForSummary;
      summaryEquitySinceDisplayStart = Math.abs(deltaEquity) < CASH_FLOW_EPSILON ? 0 : deltaEquity;
    }
  }

  const effectivePeriodStart = normalizedPoints.length ? normalizedPoints[0].date : dateKeys[0];
  const effectivePeriodEnd = normalizedPoints.length
    ? normalizedPoints[normalizedPoints.length - 1].date
    : dateKeys[dateKeys.length - 1];

  const summaryReserveValue = lastNormalized && Number.isFinite(lastNormalized.reserveValueCad)
    ? lastNormalized.reserveValueCad
    : null;
  const summaryDeployedValue = lastNormalized && Number.isFinite(lastNormalized.deployedValueCad)
    ? lastNormalized.deployedValueCad
    : null;
  let summaryDeployedPercent = null;
  if (lastNormalized && Number.isFinite(lastNormalized.deployedPercent)) {
    summaryDeployedPercent = lastNormalized.deployedPercent;
  } else if (
    Number.isFinite(summaryDeployedValue) &&
    Number.isFinite(summaryEquity) &&
    Math.abs(summaryEquity) > 0.00001
  ) {
    summaryDeployedPercent = (summaryDeployedValue / summaryEquity) * 100;
  }

  return {
    accountId: accountKey,
    periodStartDate: effectivePeriodStart,
    displayStartDate: displayStartDate ? formatDateOnly(displayStartDate) : undefined,
    periodEndDate: effectivePeriodEnd,
    points: normalizedPoints,
    summary: {
      totalPnlCad: summaryTotalPnl,
      totalPnlAllTimeCad: summaryTotalPnlAllTime,
      totalPnlSinceDisplayStartCad: Number.isFinite(summaryTotalPnlSinceDisplayStart)
        ? summaryTotalPnlSinceDisplayStart
        : undefined,
      totalEquityCad: summaryEquity,
      totalEquitySinceDisplayStartCad: Number.isFinite(summaryEquitySinceDisplayStart)
        ? summaryEquitySinceDisplayStart
        : undefined,
      netDepositsCad: summaryNetDeposits,
      netDepositsAllTimeCad: summaryNetDepositsAllTime,
      reserveValueCad: Number.isFinite(summaryReserveValue) ? summaryReserveValue : undefined,
      deployedValueCad: Number.isFinite(summaryDeployedValue) ? summaryDeployedValue : undefined,
      deployedPercent: Number.isFinite(summaryDeployedPercent) ? summaryDeployedPercent : undefined,
      displayStartTotals: displayStartTotals || baselineTotals || undefined,
      seriesStartTotals:
        displayStartTotals &&
        (displayStartTotals.totalPnlCad !== rawFirstPointTotals.totalPnlCad ||
          displayStartTotals.equityCad !== rawFirstPointTotals.equityCad ||
          displayStartTotals.cumulativeNetDepositsCad !== rawFirstPointTotals.cumulativeNetDepositsCad)
          ? rawFirstPointTotals
          : undefined,
    },
    issues: issues.size ? Array.from(issues) : undefined,
    missingPriceSymbols: missingPriceSymbols.size ? Array.from(missingPriceSymbols) : undefined,
  };
}

// Compute a per-symbol daily Total P&L series (in CAD) for the given account.
// This mirrors computeTotalPnlSeries but restricts holdings and cash flows to a single symbol,
// and treats cumulative net deposits as invested trade cash into that symbol (buys positive, sells negative).
async function computeTotalPnlSeriesForSymbol(login, account, perAccountCombinedBalances, options = {}) {
  if (!account || !account.id) {
    return null;
  }
  const rawSymbol = typeof options.symbol === 'string' ? options.symbol.trim() : '';
  const targetSymbol = normalizeSymbol(rawSymbol);
  if (!targetSymbol) {
    return null;
  }

  const accountKey = account.id;
  const activityContext = await resolveAccountActivityContext(login, account, options.activityContext);
  if (!activityContext) {
    return null;
  }

  // Determine date range (align with account-level computation for consistency)
  const netDepositsSummary = await computeNetDepositsCore(
    account,
    perAccountCombinedBalances,
    { applyAccountCagrStartDate: options.applyAccountCagrStartDate !== false },
    activityContext
  );
  if (!netDepositsSummary) {
    return null;
  }

  const startDateIso = (function resolveStart() {
    const candidates = [];
    if (typeof options.startDate === 'string' && options.startDate.trim()) candidates.push(options.startDate.trim());
    if (typeof netDepositsSummary.periodStartDate === 'string' && netDepositsSummary.periodStartDate.trim()) {
      candidates.push(netDepositsSummary.periodStartDate.trim());
    }
    const crawlStartIso = formatDateOnly(activityContext.crawlStart) || null;
    if (crawlStartIso) candidates.push(crawlStartIso);
    const nowIso = formatDateOnly(activityContext.now) || null;
    if (nowIso) candidates.push(nowIso);
    const valid = candidates
      .map((d) => ({ d, t: Date.parse(d + 'T00:00:00Z') }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
    return valid.length ? valid[0].d : netDepositsSummary.periodStartDate || crawlStartIso || nowIso;
  })();
  const displayStartIso = options.applyAccountCagrStartDate !== false && typeof account.cagrStartDate === 'string'
    ? account.cagrStartDate.trim()
    : startDateIso;
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

  // Build symbol metadata and activity list for this symbol only
  const processedActivities = [];
  const symbolIds = new Set();
  const symbolMeta = new Map();
  const nonTradeQtyByDate = new Map();
  const rawActivities = Array.isArray(activityContext.activities) ? activityContext.activities : [];
  rawActivities.forEach((activity) => {
    const timestamp = resolveActivityTimestamp(activity);
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) return;
    const dateKey = formatDateOnly(timestamp);
    if (!dateKey) return;
    const directSymbol = normalizeSymbol(activity.symbol);
    const resolved = directSymbol || resolveActivitySymbol(activity) || null;
    if (!resolved || normalizeSymbol(resolved) !== targetSymbol) return;
    processedActivities.push({ activity, timestamp, dateKey, symbol: targetSymbol });
    const symbolId = Number(activity.symbolId);
    if (Number.isFinite(symbolId) && symbolId > 0) symbolIds.add(symbolId);
    const activityCurrency = normalizeCurrency(activity.currency) || null;
    if (!symbolMeta.has(targetSymbol)) {
      symbolMeta.set(targetSymbol, {
        symbolId: Number.isFinite(symbolId) && symbolId > 0 ? symbolId : null,
        currency: inferSymbolCurrency(targetSymbol) || activityCurrency || null,
      });
    }

    // Track non-trade quantity deltas (journals/transfers) so we can treat their value as invested cash
    const qty = Number(activity.quantity);
    const isTradeLike = isOrderLikeActivity(activity);
    if (!isTradeLike && Number.isFinite(qty) && Math.abs(qty) >= LEDGER_QUANTITY_EPSILON) {
      adjustNumericMap(nonTradeQtyByDate, dateKey, qty, LEDGER_QUANTITY_EPSILON);
    }
  });
  // If we have symbolIds but missing currency, try details
  if (symbolIds.size > 0) {
    try {
      const details = await fetchSymbolsDetails(login, Array.from(symbolIds));
      const one = Object.values(details)[0];
      if (one) {
        const meta = symbolMeta.get(targetSymbol) || {};
        if ((!meta.symbolId || meta.symbolId <= 0) && Number.isFinite(one.symbolId)) meta.symbolId = one.symbolId;
        if (!meta.currency && one.currency) meta.currency = normalizeCurrency(one.currency);
        symbolMeta.set(targetSymbol, meta);
      }
    } catch (e) {
      // ignore
    }
  }

  // Price series
  const priceSeriesMap = new Map();
  const startKey = dateKeys[0];
  const endKey = dateKeys[dateKeys.length - 1];
  try {
    const meta = symbolMeta.get(targetSymbol) || {};
    const rawId = typeof meta.symbolId === 'number' ? meta.symbolId : Number(meta.symbolId);
    const symbolId = Number.isFinite(rawId) && rawId > 0 ? rawId : null;
    const history = await fetchSymbolPriceHistory(targetSymbol, startKey, endKey, { login, symbolId, accountKey });
    priceSeriesMap.set(targetSymbol, buildDailyPriceSeries(history || [], dateKeys));
  } catch (e) {
    priceSeriesMap.set(targetSymbol, new Map());
  }

  // Build daily invested cash map for this symbol: trades only (buys positive, sells negative)
  const dailyInvestedCad = new Map();
  for (const entry of processedActivities) {
    const { activity, timestamp, dateKey } = entry;
    const action = (activity.action || '').toString().toLowerCase();
    const type = (activity.type || '').toString().toLowerCase();
    const desc = [activity.type || '', activity.action || '', activity.description || ''].join(' ');
    const isDividend = INCOME_ACTIVITY_REGEX.test(desc);
    const isTradeLike = isOrderLikeActivity(activity);
    // For invested baseline we only consider trade-like cash flows; income like dividends should
    // not change the invested baseline (they are profit). Equity will reflect them via cash.
    if (!isTradeLike) continue;
    const netAmount = Number(activity.netAmount);
    const currency = normalizeCurrency(activity.currency);
    const { cadAmount } = await convertAmountToCad(netAmount, currency, timestamp, accountKey);
    if (!Number.isFinite(cadAmount) || Math.abs(cadAmount) < CASH_FLOW_EPSILON / 10) continue;
    // Buys: netAmount negative -> invested positive; Sells: netAmount positive -> invested negative.
    const investedDelta = -cadAmount;
    adjustNumericMap(dailyInvestedCad, dateKey, investedDelta, CASH_FLOW_EPSILON);
  }

  // Iterate days computing symbol equity and P&L
  const holdings = new Map();
  // Track symbol-linked cash so equity includes dividends, coupon payments, and trade cash effects.
  const cashByCurrency = new Map();
  const usdRateCache = new Map();
  const points = [];
  let cumulativeInvested = 0;
  for (const dateKey of dateKeys) {
    // apply all activity up to this day for this symbol
    for (const entry of processedActivities) {
      if (entry.dateKey !== dateKey) continue;
      const qty = Number(entry.activity.quantity);
      if (Number.isFinite(qty) && Math.abs(qty) >= LEDGER_QUANTITY_EPSILON) {
        adjustHolding(holdings, targetSymbol, qty);
      }
      // Apply cash effects for income (dividends/interest) only — exclude trade cash to
      // avoid cancelling out invested principal in symbol-scope equity.
      const activityDesc = [entry.activity.type || '', entry.activity.action || '', entry.activity.description || ''].join(' ');
      const isIncome = INCOME_ACTIVITY_REGEX.test(activityDesc);
      const isTradeLike = isOrderLikeActivity(entry.activity);
      if (isIncome && !isTradeLike) {
        const rawAmount = Number(entry.activity.netAmount);
        const cashCurrency = normalizeCurrency(entry.activity.currency);
        if (cashCurrency && Number.isFinite(rawAmount) && Math.abs(rawAmount) >= CASH_FLOW_EPSILON / 10) {
          adjustCash(cashByCurrency, cashCurrency, rawAmount);
        }
      }
    }
    const daily = dailyInvestedCad.has(dateKey) ? dailyInvestedCad.get(dateKey) : 0;
    if (Number.isFinite(daily) && Math.abs(daily) >= CASH_FLOW_EPSILON / 10) {
      cumulativeInvested += daily;
    }
    const usdRate = await resolveUsdRateForDate(dateKey, accountKey, usdRateCache);

    const series = priceSeriesMap.get(targetSymbol) || new Map();
    const nativePrice = series.get(dateKey);
    let priceCad = null;
    if (Number.isFinite(nativePrice)) {
      const priceCurrency = (symbolMeta.get(targetSymbol) && symbolMeta.get(targetSymbol).currency) || 'CAD';
      if (priceCurrency === 'USD') {
        priceCad = Number.isFinite(usdRate) && usdRate > 0 ? nativePrice * usdRate : null;
      } else {
        priceCad = nativePrice;
      }
    }

    // Treat non-trade share transfers as deposits/withdrawals at the day's price
    const qtyDelta = nonTradeQtyByDate.has(dateKey) ? nonTradeQtyByDate.get(dateKey) : 0;
    if (Number.isFinite(qtyDelta) && Math.abs(qtyDelta) >= LEDGER_QUANTITY_EPSILON) {
      if (Number.isFinite(priceCad) && Math.abs(priceCad) > 0) {
        const deltaInvested = qtyDelta * priceCad;
        if (Math.abs(deltaInvested) >= CASH_FLOW_EPSILON / 10) {
          cumulativeInvested += deltaInvested;
        }
      }
    }
    const snapshot = computeLedgerEquitySnapshot(
      dateKey,
      holdings,
      cashByCurrency,
      symbolMeta,
      priceSeriesMap,
      usdRate,
      { reserveSymbols: new Set() }
    );
    const equityCad = Number.isFinite(snapshot.equityCad) ? snapshot.equityCad : 0;
    const totalPnlCad = Number.isFinite(cumulativeInvested) ? equityCad - cumulativeInvested : null;
    points.push({
      date: dateKey,
      equityCad,
      cumulativeNetDepositsCad: Number.isFinite(cumulativeInvested) ? cumulativeInvested : null,
      totalPnlCad,
      priceCad: Number.isFinite(priceCad) ? priceCad : null,
      priceNative: Number.isFinite(nativePrice) ? nativePrice : null,
    });
  }

  const summary = (function buildSummary() {
    const last = points[points.length - 1] || {};
    const first = points[0] || {};
    return {
      netDepositsCad: Number.isFinite(last.cumulativeNetDepositsCad) ? last.cumulativeNetDepositsCad : null,
      totalPnlCad: Number.isFinite(last.totalPnlCad) ? last.totalPnlCad : null,
      totalPnlAllTimeCad: Number.isFinite(last.totalPnlCad) ? last.totalPnlCad : null,
      totalEquityCad: Number.isFinite(last.equityCad) ? last.equityCad : null,
      priceCad: Number.isFinite(last.priceCad) ? last.priceCad : null,
      seriesStartTotals: {
        cumulativeNetDepositsCad: Number.isFinite(first.cumulativeNetDepositsCad) ? first.cumulativeNetDepositsCad : null,
        equityCad: Number.isFinite(first.equityCad) ? first.equityCad : null,
        totalPnlCad: Number.isFinite(first.totalPnlCad) ? first.totalPnlCad : null,
        priceCad: Number.isFinite(first.priceCad) ? first.priceCad : null,
      },
      displayStartTotals: undefined,
    };
  })();

  return {
    accountId: accountKey,
    periodStartDate: formatDateOnly(startDate),
    periodEndDate: formatDateOnly(endDate),
    displayStartDate: formatDateOnly(displayStartDate),
    points,
    summary,
  };
}

// Compute total P&L by symbol (in CAD) using the same activity context and pricing used
// for the account-level Total P&L series. Result entries include closed symbols.
async function computeTotalPnlBySymbol(login, account, options = {}) {
  if (!account || !account.id) {
    return null;
  }

  const accountKey = account.id;
  const activityContext = await resolveAccountActivityContext(login, account, options.activityContext);
  if (!activityContext) {
    return null;
  }

  // Build ordered activity list with resolved symbols and capture symbol metadata
  const processedActivities = [];
  const symbolIds = new Set();
  const symbolMeta = new Map();

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
    const directSymbol = normalizeSymbol(activity.symbol);
    const fallbackSymbol = resolveActivitySymbol(activity);
    const resolvedSymbol = directSymbol || fallbackSymbol || null;
    processedActivities.push({ activity, timestamp, dateKey, symbol: resolvedSymbol });

    const symbolId = Number(activity.symbolId);
    const activityCurrency = normalizeCurrency(activity.currency) || null;

    if (Number.isFinite(symbolId) && symbolId > 0) {
      symbolIds.add(symbolId);
    }

    if (!resolvedSymbol) {
      return;
    }
    if (!symbolMeta.has(resolvedSymbol)) {
      symbolMeta.set(resolvedSymbol, {
        symbolId: Number.isFinite(symbolId) && symbolId > 0 ? symbolId : null,
        currency: inferSymbolCurrency(resolvedSymbol) || null,
        activityCurrency,
      });
    } else {
      const meta = symbolMeta.get(resolvedSymbol);
      if (meta) {
        if ((!meta.symbolId || meta.symbolId <= 0) && Number.isFinite(symbolId) && symbolId > 0) {
          meta.symbolId = symbolId;
        }
        if (!meta.currency) {
          meta.currency = inferSymbolCurrency(resolvedSymbol) || activityCurrency || null;
        }
        if (!meta.activityCurrency && activityCurrency) {
          meta.activityCurrency = activityCurrency;
        }
      }
    }
  });

  processedActivities.sort((a, b) => a.timestamp - b.timestamp);

  // Detect bases that participate in journaling so we can safely
  // consolidate share-class variants (e.g., DLR and DLR.U, ENB and ENB.TO)
  const JOURNAL_REGEX = /journal/i;
  const journalBases = new Set();
  const stripToSuffix = (s) => (typeof s === 'string' && s.toUpperCase().endsWith('.TO') ? s.slice(0, -3) : s);
  const baseOf = (s) => {
    if (!s || typeof s !== 'string') return null;
    const up = stripToSuffix(s.toUpperCase());
    return up.endsWith('.U') ? up.slice(0, -2) : up;
  };
  for (const entry of processedActivities) {
    const activity = entry && entry.activity;
    if (!activity) continue;
    const fields = [activity.type || '', activity.action || '', activity.description || ''];
    const combined = fields.join(' ');
    if (!JOURNAL_REGEX.test(combined)) continue;
    const key = baseOf(entry.symbol || '');
    if (key) {
      journalBases.add(key);
    }
  }

  // If we have symbolIds but missing symbols, try to backfill via symbol details
  let symbolDetails = {};
  if (symbolIds.size > 0) {
    try {
      symbolDetails = await fetchSymbolsDetails(login, Array.from(symbolIds));
    } catch (symbolError) {
      symbolDetails = {};
    }
  }
  if (processedActivities.length && symbolDetails && typeof symbolDetails === 'object') {
    for (const entry of processedActivities) {
      if (!entry || entry.symbol) {
        continue;
      }
      const id = Number(entry.activity && entry.activity.symbolId);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }
      const detail = symbolDetails[id];
      const detailSymbol = detail && typeof detail.symbol === 'string' ? detail.symbol : null;
      const normalized = detailSymbol ? normalizeSymbol(detailSymbol) : null;
      if (!normalized) {
        continue;
      }
      entry.symbol = normalized;
      if (!symbolMeta.has(normalized)) {
        symbolMeta.set(normalized, {
          symbolId: id,
          currency: (detail && normalizeCurrency(detail.currency)) || inferSymbolCurrency(normalized) || null,
          activityCurrency: normalizeCurrency(entry.activity && entry.activity.currency) || null,
        });
      } else {
        const meta = symbolMeta.get(normalized);
        if (meta) {
          if ((!meta.symbolId || meta.symbolId <= 0)) {
            meta.symbolId = id;
          }
          if (!meta.currency && detail && detail.currency) {
            meta.currency = normalizeCurrency(detail.currency) || meta.currency || null;
          }
          if (!meta.activityCurrency && entry.activity && entry.activity.currency) {
            meta.activityCurrency = normalizeCurrency(entry.activity.currency);
          }
        }
      }
    }
  }

  // Determine date window for price fetching
  const startDate =
    (activityContext.crawlStart instanceof Date && !Number.isNaN(activityContext.crawlStart.getTime())
      ? activityContext.crawlStart
      : activityContext.now) || new Date();
  const endDate =
    (activityContext.now instanceof Date && !Number.isNaN(activityContext.now.getTime())
      ? activityContext.now
      : new Date());
  let dateKeys = enumerateDateKeys(startDate, endDate);
  if (!dateKeys.length) {
    return { entries: [] };
  }

  // Align per-symbol totals with display start when enabled (e.g. CAGR start)
  const applyCagrStart =
    Object.prototype.hasOwnProperty.call(options || {}, 'applyAccountCagrStartDate')
      ? !!options.applyAccountCagrStartDate
      : true;
  const rawDisplayStart =
    (typeof options.displayStartKey === 'string' && options.displayStartKey.trim())
      ? options.displayStartKey.trim()
      : (applyCagrStart && typeof account?.cagrStartDate === 'string' && account.cagrStartDate.trim()
          ? account.cagrStartDate.trim()
          : null);
  const rawDisplayEnd =
    typeof options.displayEndKey === 'string' && options.displayEndKey.trim()
      ? options.displayEndKey.trim()
      : null;
  if (rawDisplayStart && rawDisplayEnd && rawDisplayStart > rawDisplayEnd) {
    return { entries: [] };
  }
  const effectiveEndKey = rawDisplayEnd
    ? (function () {
        for (let i = dateKeys.length - 1; i >= 0; i -= 1) {
          const key = dateKeys[i];
          if (key <= rawDisplayEnd) {
            return key;
          }
        }
        return null;
      })()
    : dateKeys[dateKeys.length - 1];
  if (!effectiveEndKey) {
    return { entries: [] };
  }
  dateKeys = dateKeys.filter((key) => key <= effectiveEndKey);
  if (!dateKeys.length) {
    return { entries: [] };
  }
  const effectiveStartKey = rawDisplayStart
    ? (function () {
        for (const k of dateKeys) {
          if (k >= rawDisplayStart) return k;
        }
        return dateKeys[0];
      })()
    : dateKeys[0];

  // Fetch price series per symbol (allow test override)
  const symbols = Array.from(symbolMeta.keys());
  const priceSeriesMap = new Map();
  const overrideSeries = options && options.priceSeriesBySymbol instanceof Map ? options.priceSeriesBySymbol : null;
  if (symbols.length) {
    const startKey = dateKeys[0];
    const endKey = dateKeys[dateKeys.length - 1];
    await mapWithConcurrency(symbols, Math.min(4, symbols.length), async function (symbol) {
      if (overrideSeries && overrideSeries.has(symbol)) {
        priceSeriesMap.set(symbol, new Map(overrideSeries.get(symbol)));
        return;
      }
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
          const meta = symbolMeta.get(symbol) || {};
          const rawSymbolId = typeof meta.symbolId === 'number' ? meta.symbolId : Number(meta.symbolId);
          const normalizedSymbolId = Number.isFinite(rawSymbolId) && rawSymbolId > 0 ? rawSymbolId : null;
          history = await fetchSymbolPriceHistory(symbol, startKey, endKey, {
            login,
            symbolId: normalizedSymbolId,
            accountKey,
          });
        } catch (priceError) {
          history = null;
        }
        if (Array.isArray(history) && cacheKey) {
          setCachedPriceHistory(cacheKey, history);
        }
      }
      if (Array.isArray(history)) {
        priceSeriesMap.set(symbol, buildDailyPriceSeries(history, dateKeys));
      } else {
        priceSeriesMap.set(symbol, new Map());
      }
    });
  }

  const cashCadBySymbol = new Map(); // since effective start
  // Track USD-currency cash flows in native USD so we can recompute a no-FX variant.
  // Also track the CAD that originated from USD conversions to separate CAD-native flows.
  const cashUsdBySymbol = new Map(); // since effective start (USD only)
  const cashCadFromUsdBySymbol = new Map(); // portion of CAD cash originating from USD flows
  const investedOutflowCadBySymbol = new Map(); // since effective start
  const holdings = new Map(); // trade deltas on/after effective start
  const baselineHoldings = new Map(); // trade deltas before effective start
  const nonTradeDeltaSinceStart = new Map(); // non-trade deltas on/after effective start
  const qtyDeltaSinceStart = new Map(); // all quantity deltas on/after start (trade + non-trade)
  const qtyDeltaBeforeStart = new Map(); // all quantity deltas before start
  const usdRateCache = new Map();

  for (const entry of processedActivities) {
    if (!entry || !entry.activity) {
      continue;
    }
    const { activity, symbol, dateKey } = entry;
    if (dateKey > effectiveEndKey) {
      continue;
    }
    const rawQty = Number(activity.quantity);
    // Only order-like activities affect holdings; split into baseline (before start)
    // and current (on/after start) so we can derive starting MV correctly.
    if (isOrderLikeActivity(activity) && symbol && Number.isFinite(rawQty) && Math.abs(rawQty) >= LEDGER_QUANTITY_EPSILON) {
      const target = dateKey < effectiveStartKey ? baselineHoldings : holdings;
      const current = target.has(symbol) ? target.get(symbol) : 0;
      const next = current + rawQty;
      const base = baseOf(symbol) || symbol;
      // Allow negatives for symbols that participate in journaling so sells
      // in one share-class can offset buys in another when merged.
      const allowNegative = journalBases.has(base);
      const adjusted = Math.abs(next) < LEDGER_QUANTITY_EPSILON ? 0 : allowNegative ? next : Math.max(0, next);
      target.set(symbol, adjusted);
    }

    // Track non-trade quantity changes since start (journals/transfers)
    if (
      !isOrderLikeActivity(activity) &&
      symbol &&
      dateKey >= effectiveStartKey &&
      dateKey <= effectiveEndKey &&
      Number.isFinite(rawQty) &&
      Math.abs(rawQty) >= LEDGER_QUANTITY_EPSILON
    ) {
      const cur = nonTradeDeltaSinceStart.has(symbol) ? nonTradeDeltaSinceStart.get(symbol) : 0;
      nonTradeDeltaSinceStart.set(symbol, cur + rawQty);
    }

    // Track total quantity deltas regardless of classification
    if (symbol && Number.isFinite(rawQty) && Math.abs(rawQty) >= LEDGER_QUANTITY_EPSILON) {
      const bucket =
        dateKey < effectiveStartKey
          ? qtyDeltaBeforeStart
          : dateKey <= effectiveEndKey
            ? qtyDeltaSinceStart
            : null;
      if (!bucket) {
        continue;
      }
      const cur = bucket.has(symbol) ? bucket.get(symbol) : 0;
      bucket.set(symbol, cur + rawQty);
    }

    // Non-trade quantity before start contributes to baseline holdings
    if (
      !isOrderLikeActivity(activity) &&
      symbol &&
      dateKey < effectiveStartKey &&
      Number.isFinite(rawQty) &&
      Math.abs(rawQty) >= LEDGER_QUANTITY_EPSILON
    ) {
      const current = baselineHoldings.has(symbol) ? baselineHoldings.get(symbol) : 0;
      const next = current + rawQty;
      baselineHoldings.set(symbol, Math.abs(next) < LEDGER_QUANTITY_EPSILON ? 0 : next);
    }

    // Count non-trade quantity moves since start so we exclude them from start MV
    if (
      !isOrderLikeActivity(activity) &&
      symbol &&
      dateKey >= effectiveStartKey &&
      dateKey <= effectiveEndKey &&
      Number.isFinite(rawQty) &&
      Math.abs(rawQty) >= LEDGER_QUANTITY_EPSILON
    ) {
      const cur = nonTradeDeltaSinceStart.has(symbol) ? nonTradeDeltaSinceStart.get(symbol) : 0;
      nonTradeDeltaSinceStart.set(symbol, cur + rawQty);
    }

    const currency = normalizeCurrency(activity.currency);
    const netAmount = Number(activity.netAmount);
    // Only treat cash as P&L-affecting when it is trade-like (buy/sell/etc)
    // or a dividend/distribution. Exclude journals/transfers and other
    // bookkeeping entries that can be large and distort per-symbol totals.
    const desc = [activity.type || '', activity.action || '', activity.description || ''].join(' ');
    const isTradeCash = isOrderLikeActivity(activity);
    const isDividendCash = INCOME_ACTIVITY_REGEX.test(desc);
    if (
      symbol &&
      currency &&
      (isTradeCash || isDividendCash) &&
      dateKey >= effectiveStartKey &&
      dateKey <= effectiveEndKey &&
      Number.isFinite(netAmount) &&
      Math.abs(netAmount) >= CASH_FLOW_EPSILON / 10
    ) {
      let amountCad = null;
      if (currency === 'CAD') {
        amountCad = netAmount;
      } else if (currency === 'USD') {
        const overrideMap = options && options.usdRatesByDate instanceof Map ? options.usdRatesByDate : null;
        let usdRate = null;
        if (overrideMap && overrideMap.has(dateKey)) {
          usdRate = overrideMap.get(dateKey);
        } else {
          usdRate = await resolveUsdRateForDate(dateKey, accountKey, usdRateCache);
        }
        amountCad = Number.isFinite(usdRate) && usdRate > 0 ? netAmount * usdRate : null;
        // Track USD-native amount and its CAD-converted counterpart for no-FX variant.
        const curUsd = cashUsdBySymbol.has(symbol) ? cashUsdBySymbol.get(symbol) : 0;
        cashUsdBySymbol.set(symbol, curUsd + (Number.isFinite(netAmount) ? netAmount : 0));
        if (Number.isFinite(amountCad)) {
          const curCadFromUsd = cashCadFromUsdBySymbol.has(symbol) ? cashCadFromUsdBySymbol.get(symbol) : 0;
          cashCadFromUsdBySymbol.set(symbol, curCadFromUsd + amountCad);
        }
      }
      if (Number.isFinite(amountCad)) {
        const current = cashCadBySymbol.has(symbol) ? cashCadBySymbol.get(symbol) : 0;
        cashCadBySymbol.set(symbol, current + amountCad);
        if (amountCad < 0) {
          const invested = investedOutflowCadBySymbol.has(symbol) ? investedOutflowCadBySymbol.get(symbol) : 0;
          investedOutflowCadBySymbol.set(symbol, invested + Math.abs(amountCad));
        }
      }
    }
  }

  const endKey = dateKeys[dateKeys.length - 1];
  // Resolve FX rate for end day; if missing (e.g., weekend/holiday),
  // fall back to the most recent prior available rate so MV in CAD is not zero.
  const usdRateOverride = options && options.usdRatesByDate instanceof Map ? options.usdRatesByDate : null;
  async function lookupUsdRate(dateKey) {
    if (usdRateOverride && usdRateOverride.has(dateKey)) {
      const r = usdRateOverride.get(dateKey);
      return Number.isFinite(r) && r > 0 ? r : null;
    }
    return resolveUsdRateForDate(dateKey, accountKey, usdRateCache);
  }

  let endUsdRate = await lookupUsdRate(endKey);
  if (!(Number.isFinite(endUsdRate) && endUsdRate > 0)) {
    for (let i = dateKeys.length - 2; i >= 0; i -= 1) {
      const alt = await lookupUsdRate(dateKeys[i]);
      if (Number.isFinite(alt) && alt > 0) {
        endUsdRate = alt;
        break;
      }
    }
  }

  // FX at start for USD holdings baseline
  let startUsdRate = await lookupUsdRate(effectiveStartKey);
  if (!(Number.isFinite(startUsdRate) && startUsdRate > 0)) {
    for (let i = dateKeys.indexOf(effectiveStartKey) - 1; i >= 0; i -= 1) {
      const alt = await lookupUsdRate(dateKeys[i]);
      if (Number.isFinite(alt) && alt > 0) {
        startUsdRate = alt;
        break;
      }
    }
  }

  // Apply book-value cash for non-trade quantity movements since the display start
  // so that transfers/journals do not create artificial P&L within this account.
  if (processedActivities.length && priceSeriesMap.size) {
    for (const entry of processedActivities) {
      if (!entry || !entry.activity) {
        continue;
      }
      const { activity, symbol, dateKey } = entry;
      if (!symbol || !dateKey || dateKey < effectiveStartKey || dateKey > effectiveEndKey) {
        continue;
      }
      const qty = Number(activity.quantity);
      if (!Number.isFinite(qty) || Math.abs(qty) < LEDGER_QUANTITY_EPSILON) {
        continue;
      }
      // Skip trades and stock splits/consolidations; splits should not
      // create artificial cash adjustments in per-symbol P&L.
      if (isOrderLikeActivity(activity) || isSplitLikeActivity(activity)) {
        continue;
      }
      const series = priceSeriesMap.get(symbol);
      const price = series && series.size ? series.get(dateKey) : null;
      if (!(Number.isFinite(price) && price > 0)) {
        continue;
      }
      const meta = symbolMeta.get(symbol) || {};
      const bookCurrency = normalizeCurrency(activity.currency) || meta.activityCurrency || meta.currency || 'CAD';
      let valueCad = qty * price;
      if (bookCurrency === 'USD') {
        const r = await lookupUsdRate(dateKey);
        if (!(Number.isFinite(r) && r > 0)) {
          continue;
        }
        valueCad = qty * price * r;
        // Track USD-native book-value cash so we can recompute at a constant end rate.
        const bookCashUsd = -(qty * price); // Transfer out (−qty) => inflow (+)
        const curUsd = cashUsdBySymbol.has(symbol) ? cashUsdBySymbol.get(symbol) : 0;
        cashUsdBySymbol.set(symbol, curUsd + bookCashUsd);
        const curCadFromUsd = cashCadFromUsdBySymbol.has(symbol) ? cashCadFromUsdBySymbol.get(symbol) : 0;
        // Track the exact CAD cash increment we applied due to USD-sourced book cash
        // so we can back it out when building a no-FX variant.
        cashCadFromUsdBySymbol.set(symbol, curCadFromUsd + (-valueCad));
      }
      const bookCashCad = -valueCad; // Transfer out (−qty) => inflow (+)
      const current = cashCadBySymbol.has(symbol) ? cashCadBySymbol.get(symbol) : 0;
      cashCadBySymbol.set(symbol, current + bookCashCad);
    }
  }

  let result = [];
  let resultNoFx = [];
  let fxEffectCadTotal = 0;
  const allSymbols = new Set([
    ...Array.from(symbolMeta.keys()),
    ...Array.from(cashCadBySymbol.keys()),
    ...Array.from(holdings.keys()),
    ...Array.from(baselineHoldings.keys()),
  ]);
  const providedEndHoldings = options && options.endHoldingsBySymbol instanceof Map ? options.endHoldingsBySymbol : null;
  for (const symbol of allSymbols.values()) {
    const changeQty = qtyDeltaSinceStart.has(symbol) ? qtyDeltaSinceStart.get(symbol) : 0; // total deltas since start
    const normalizedKey = normalizeSymbol(symbol) || symbol;
    const finalQtyOverride = providedEndHoldings && providedEndHoldings.has(normalizedKey)
      ? Number(providedEndHoldings.get(normalizedKey))
      : null;
    let endQty = Number.isFinite(finalQtyOverride)
      ? finalQtyOverride
      : (qtyDeltaBeforeStart.get(symbol) || 0) + changeQty;
    const baseForClamp = (typeof symbol === 'string' ? stripToSuffix(symbol.toUpperCase()) : '')
      .replace(/\.U$/,'');
    const allowNegativeEnd = journalBases.has(baseForClamp);
    if (!allowNegativeEnd && Number.isFinite(endQty) && endQty < 0) {
      endQty = 0;
    }
    let startQty = Number.isFinite(endQty) ? endQty - changeQty : 0;
    if (Number.isFinite(startQty) && startQty < 0) {
      startQty = 0;
    }
    const series = priceSeriesMap.get(symbol);
    const price = series && series.size ? series.get(endKey) : null;
    const startPrice = series && series.size ? series.get(effectiveStartKey) : null;
    const meta = symbolMeta.get(symbol) || {};
    const isUsd = meta.currency === 'USD';
    let marketValueCad = 0;
    let marketValueStartCad = 0;
    if (Number.isFinite(endQty) && Math.abs(endQty) >= LEDGER_QUANTITY_EPSILON && Number.isFinite(price) && price > 0) {
      const rawValue = endQty * price;
      marketValueCad = isUsd && Number.isFinite(endUsdRate) && endUsdRate > 0 ? rawValue * endUsdRate : rawValue;
    }
    if (Number.isFinite(startQty) && Math.abs(startQty) >= LEDGER_QUANTITY_EPSILON && Number.isFinite(startPrice) && startPrice > 0) {
      const rawStart = startQty * startPrice;
      marketValueStartCad = isUsd && Number.isFinite(startUsdRate) && startUsdRate > 0 ? rawStart * startUsdRate : rawStart;
    }
    const cashCad = cashCadBySymbol.has(symbol) ? cashCadBySymbol.get(symbol) : 0;
    const totalPnlCad = (marketValueCad - marketValueStartCad) + cashCad;
    const investedCad = investedOutflowCadBySymbol.has(symbol) ? investedOutflowCadBySymbol.get(symbol) : 0;
    const entry = {
      symbol,
      symbolId: Number.isFinite(meta.symbolId) ? meta.symbolId : null,
      totalPnlCad: Number.isFinite(totalPnlCad) ? totalPnlCad : null,
      investedCad: Number.isFinite(investedCad) ? investedCad : null,
      openQuantity: Number.isFinite(endQty) ? endQty : null,
      marketValueCad: Number.isFinite(marketValueCad) ? marketValueCad : null,
      currency: isUsd ? 'USD' : 'CAD',
    };
    // Build no-FX variant: convert all USD cash and USD MV deltas at end rate; keep CAD-native parts as-is.
    let totalPnlNoFxCad = null;
    if (isUsd && Number.isFinite(endUsdRate) && endUsdRate > 0) {
      const usdEndValue = Number.isFinite(endQty) && Number.isFinite(price) ? endQty * price : 0;
      const usdStartValue = Number.isFinite(startQty) && Number.isFinite(startPrice) ? startQty * startPrice : 0;
      const usdDelta = usdEndValue - usdStartValue;
      const mvNoFxCad = usdDelta * endUsdRate;
      const usdCash = cashUsdBySymbol.has(symbol) ? cashUsdBySymbol.get(symbol) : 0;
      const cadFromUsd = cashCadFromUsdBySymbol.has(symbol) ? cashCadFromUsdBySymbol.get(symbol) : 0;
      const cadTotalCash = cashCadBySymbol.has(symbol) ? cashCadBySymbol.get(symbol) : 0;
      const cadNativeCash = cadTotalCash - cadFromUsd;
      const cashNoFxCad = usdCash * endUsdRate + cadNativeCash;
      totalPnlNoFxCad = mvNoFxCad + cashNoFxCad;
    } else {
      // Non-USD symbols are unaffected by FX; keep original P&L.
      if (Number.isFinite(totalPnlCad)) {
        totalPnlNoFxCad = totalPnlCad;
      }
    }
    const entryNoFx = {
      symbol,
      symbolId: Number.isFinite(meta.symbolId) ? meta.symbolId : null,
      totalPnlCad: Number.isFinite(totalPnlNoFxCad) ? totalPnlNoFxCad : Number.isFinite(totalPnlCad) ? totalPnlCad : null,
      investedCad: Number.isFinite(investedCad) ? investedCad : null,
      openQuantity: Number.isFinite(endQty) ? endQty : null,
      marketValueCad: Number.isFinite(marketValueCad) ? marketValueCad : null,
      currency: isUsd ? 'USD' : 'CAD',
    };
    const actualPnl = Number.isFinite(entry.totalPnlCad) ? entry.totalPnlCad : 0;
    const noFxPnl = Number.isFinite(entryNoFx.totalPnlCad) ? entryNoFx.totalPnlCad : actualPnl;
    const investedComponent = Number.isFinite(entry.investedCad) ? entry.investedCad : 0;
    const openQtyComponent = Number.isFinite(entry.openQuantity) ? entry.openQuantity : 0;
    const marketValueComponent = Number.isFinite(entry.marketValueCad) ? entry.marketValueCad : 0;
    const component = {
      symbol,
      totalPnlCad: actualPnl,
      totalPnlWithFxCad: actualPnl,
      totalPnlNoFxCad: noFxPnl,
      investedCad: investedComponent,
      openQuantity: openQtyComponent,
      marketValueCad: marketValueComponent,
    };
    entry.components = [component];
    entryNoFx.components = [
      {
        ...component,
        totalPnlCad: noFxPnl,
      },
    ];
    // Include if we have any signal (P&L, market value, or invested),
    // or if there was a non-trade quantity movement since start (e.g., book-value transfer out).
    const nonTradeDelta = nonTradeDeltaSinceStart.has(symbol) ? nonTradeDeltaSinceStart.get(symbol) : 0;
    const hadNonTradeMove = Number.isFinite(nonTradeDelta) && Math.abs(nonTradeDelta) >= LEDGER_QUANTITY_EPSILON;
    if (
      (Number.isFinite(entry.totalPnlCad) && Math.abs(entry.totalPnlCad) >= CASH_FLOW_EPSILON / 10) ||
      (Number.isFinite(entry.marketValueCad) && Math.abs(entry.marketValueCad) >= 0.01) ||
      (Number.isFinite(entry.investedCad) && Math.abs(entry.investedCad) >= 0.01) ||
      hadNonTradeMove
    ) {
      result.push(entry);
      resultNoFx.push(entryNoFx);
      if (Number.isFinite(entry.totalPnlCad) && Number.isFinite(entryNoFx.totalPnlCad)) {
        fxEffectCadTotal += entry.totalPnlCad - entryNoFx.totalPnlCad;
      }
    }
  }

  // If we saw journaling for a base symbol, fold share-class variants into the base.
  if (journalBases.size > 0 && result.length > 0) {
    const merged = new Map();
    const mergedNoFx = new Map();
    const toKey = (sym) => {
      if (!sym) return sym;
      const noTo = stripToSuffix(String(sym).toUpperCase());
      const base = noTo.endsWith('.U') ? noTo.slice(0, -2) : noTo;
      return journalBases.has(base) ? base : noTo;
    };
    const mergeComponents = (targetComponents, sourceComponents) => {
      if (!Array.isArray(sourceComponents) || sourceComponents.length === 0) {
        return Array.isArray(targetComponents) ? targetComponents : [];
      }
      const map = new Map();
      if (Array.isArray(targetComponents)) {
        targetComponents.forEach((existingComponent) => {
          if (!existingComponent) {
            return;
          }
          const key = existingComponent.symbol ? String(existingComponent.symbol).toUpperCase() : '';
          if (!key) {
            return;
          }
          map.set(key, { ...existingComponent });
        });
      }
      sourceComponents.forEach((componentEntry) => {
        if (!componentEntry) {
          return;
        }
        const key = componentEntry.symbol ? String(componentEntry.symbol).toUpperCase() : '';
        if (!key) {
          return;
        }
        const addComponentValue = (value) => (Number.isFinite(value) ? value : 0);
        if (!map.has(key)) {
          map.set(key, {
            symbol: componentEntry.symbol || null,
            totalPnlCad: addComponentValue(componentEntry.totalPnlCad),
            totalPnlWithFxCad: addComponentValue(componentEntry.totalPnlWithFxCad),
            totalPnlNoFxCad: addComponentValue(componentEntry.totalPnlNoFxCad),
            investedCad: addComponentValue(componentEntry.investedCad),
            openQuantity: addComponentValue(componentEntry.openQuantity),
            marketValueCad: addComponentValue(componentEntry.marketValueCad),
          });
        } else {
          const existingComponent = map.get(key);
          existingComponent.totalPnlCad += addComponentValue(componentEntry.totalPnlCad);
          existingComponent.totalPnlWithFxCad += addComponentValue(componentEntry.totalPnlWithFxCad);
          existingComponent.totalPnlNoFxCad += addComponentValue(componentEntry.totalPnlNoFxCad);
          existingComponent.investedCad += addComponentValue(componentEntry.investedCad);
          existingComponent.openQuantity += addComponentValue(componentEntry.openQuantity);
          existingComponent.marketValueCad += addComponentValue(componentEntry.marketValueCad);
          if (!existingComponent.symbol && componentEntry.symbol) {
            existingComponent.symbol = componentEntry.symbol;
          }
        }
      });
      return Array.from(map.values());
    };
    for (const entry of result) {
      const key = toKey(entry.symbol);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          symbol: key,
          symbolId: Number.isFinite(entry.symbolId) ? entry.symbolId : null,
          totalPnlCad: Number(entry.totalPnlCad) || 0,
          investedCad: Number(entry.investedCad) || 0,
          openQuantity: Number(entry.openQuantity) || 0,
          marketValueCad: Number(entry.marketValueCad) || 0,
          currency: entry.currency || null,
          components: Array.isArray(entry.components)
            ? entry.components.map((componentEntry) => ({ ...componentEntry }))
            : [],
        });
      } else {
        const add = (v) => (Number.isFinite(v) ? v : 0);
        existing.totalPnlCad += add(entry.totalPnlCad);
        existing.investedCad += add(entry.investedCad);
        existing.openQuantity += add(entry.openQuantity);
        existing.marketValueCad += add(entry.marketValueCad);
        if (!existing.symbolId && Number.isFinite(entry.symbolId)) {
          existing.symbolId = entry.symbolId;
        }
        if (!existing.currency && entry.currency) {
          existing.currency = entry.currency;
        }
        existing.components = mergeComponents(existing.components, entry.components);
      }
    }
    for (const entry of resultNoFx) {
      const key = toKey(entry.symbol);
      const existing = mergedNoFx.get(key);
      if (!existing) {
        mergedNoFx.set(key, {
          symbol: key,
          symbolId: Number.isFinite(entry.symbolId) ? entry.symbolId : null,
          totalPnlCad: Number(entry.totalPnlCad) || 0,
          investedCad: Number(entry.investedCad) || 0,
          openQuantity: Number(entry.openQuantity) || 0,
          marketValueCad: Number(entry.marketValueCad) || 0,
          currency: entry.currency || null,
          components: Array.isArray(entry.components)
            ? entry.components.map((componentEntry) => ({ ...componentEntry }))
            : [],
        });
      } else {
        const add = (v) => (Number.isFinite(v) ? v : 0);
        existing.totalPnlCad += add(entry.totalPnlCad);
        existing.investedCad += add(entry.investedCad);
        existing.openQuantity += add(entry.openQuantity);
        existing.marketValueCad += add(entry.marketValueCad);
        if (!existing.symbolId && Number.isFinite(entry.symbolId)) {
          existing.symbolId = entry.symbolId;
        }
        if (!existing.currency && entry.currency) {
          existing.currency = entry.currency;
        }
        existing.components = mergeComponents(existing.components, entry.components);
      }
    }
    result = Array.from(merged.values());
    resultNoFx = Array.from(mergedNoFx.values());
  }

  // Sort by magnitude of contribution
  result.sort((a, b) => {
    const aMag = Math.abs(Number(a.totalPnlCad) || 0);
    const bMag = Math.abs(Number(b.totalPnlCad) || 0);
    if (aMag !== bMag) return bMag - aMag;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
  // Maintain the same order for the no-FX variant by re-sorting independent of FX.
  resultNoFx.sort((a, b) => {
    const aMag = Math.abs(Number(a.totalPnlCad) || 0);
    const bMag = Math.abs(Number(b.totalPnlCad) || 0);
    if (aMag !== bMag) return bMag - aMag;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });

  return { entries: result, entriesNoFx: resultNoFx, fxEffectCad: fxEffectCadTotal, endDate: endKey };
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

  const results = {};
  const toFetch = [];
  // Fill from cache and track which to fetch
  for (const idRaw of symbolIds) {
    const id = Number(idRaw);
    if (!Number.isFinite(id)) continue;
    const cacheKey = getSymbolDetailsCacheKey(login.id, id);
    if (cacheKey && symbolDetailsCache.has(cacheKey)) {
      results[id] = symbolDetailsCache.get(cacheKey);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) {
    return results;
  }

  const BATCH_SIZE = 50;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const idsParam = batch.join(',');
    const data = await questradeRequest(login, '/v1/symbols', { params: { ids: idsParam } });
    (data.symbols || []).forEach(function (symbol) {
      results[symbol.symbolId] = symbol;
      const cacheKey = getSymbolDetailsCacheKey(login.id, Number(symbol.symbolId));
      if (cacheKey) {
        symbolDetailsCache.set(cacheKey, symbol);
      }
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

const MAX_ORDER_HISTORY_CONCURRENCY = 3;
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

function decoratePositions(positions, symbolsMap, accountsMap, dividendYieldMap) {
  return positions.map(function (position) {
    const symbolInfo = symbolsMap[position.symbolId];
    const accountInfo = accountsMap[position.accountId] || accountsMap[position.accountNumber] || null;
    const symbolKey =
      typeof position.symbol === 'string' && position.symbol.trim()
        ? position.symbol.trim().toUpperCase()
        : null;
    let targetProportion = null;
    let symbolNote = null;
    if (symbolKey && accountInfo) {
      if (accountInfo.symbolSettings && typeof accountInfo.symbolSettings === 'object') {
        const entry = accountInfo.symbolSettings[symbolKey];
        if (entry && typeof entry === 'object') {
          const numeric = Number(entry.targetProportion);
          if (Number.isFinite(numeric)) {
            targetProportion = numeric;
          }
          if (typeof entry.notes === 'string') {
            const trimmedNote = entry.notes.trim();
            if (trimmedNote) {
              symbolNote = trimmedNote;
            }
          }
        }
      }
      if (!symbolNote && accountInfo.symbolNotes && typeof accountInfo.symbolNotes === 'object') {
        const candidateNote = accountInfo.symbolNotes[symbolKey];
        if (typeof candidateNote === 'string') {
          const trimmedNote = candidateNote.trim();
          if (trimmedNote) {
            symbolNote = trimmedNote;
          }
        }
      }
    }

    const accountDisplayName = accountInfo ? accountInfo.displayName || null : null;
    const normalizedTargetProportion = Number.isFinite(targetProportion) ? targetProportion : null;
    const resolvedNote = symbolNote || null;
    let dividendYieldPercent = null;
    if (symbolKey && dividendYieldMap) {
      if (dividendYieldMap instanceof Map) {
        const candidate = dividendYieldMap.get(symbolKey) ?? null;
        if (Number.isFinite(candidate) && candidate > 0) {
          dividendYieldPercent = candidate;
        }
      } else if (typeof dividendYieldMap === 'object') {
        const candidate = dividendYieldMap[symbolKey];
        const numericCandidate = Number(candidate);
        if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
          dividendYieldPercent = numericCandidate;
        }
      }
    }
    const accountNotesEntry = {
      accountId: accountInfo ? accountInfo.id || position.accountId || null : position.accountId || null,
      accountNumber: accountInfo ? accountInfo.number || position.accountNumber || null : position.accountNumber || null,
      accountDisplayName,
      accountOwnerLabel:
        accountInfo && accountInfo.ownerLabel
          ? accountInfo.ownerLabel
          : accountInfo && accountInfo.loginLabel
            ? accountInfo.loginLabel
            : null,
      notes: resolvedNote || '',
      targetProportion: normalizedTargetProportion,
    };
    const accountNotes = accountNotesEntry.accountId || accountNotesEntry.accountNumber ? [accountNotesEntry] : [];
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
      targetProportion: normalizedTargetProportion,
      notes: resolvedNote,
      accountDisplayName,
      accountNotes,
      dividendYieldPercent,
    };
  });
}

function decorateOrders(orders, symbolsMap, accountsMap) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return [];
  }

  return orders.map(function (order) {
    const symbolInfo = order && order.symbolId ? symbolsMap[order.symbolId] : null;
    const accountInfo = order ? accountsMap[order.accountId] || accountsMap[order.accountNumber] || null : null;
    const normalizeString = function (value) {
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
      }
      return null;
    };

    return {
      id: order?.id ?? null,
      orderId: order?.orderId ?? order?.id ?? null,
      accountId: order?.accountId || (accountInfo ? accountInfo.id : null),
      accountNumber: order?.accountNumber || (accountInfo ? accountInfo.number : null),
      accountOwnerLabel:
        accountInfo && normalizeString(accountInfo.ownerLabel)
          ? normalizeString(accountInfo.ownerLabel)
          : accountInfo && normalizeString(accountInfo.loginLabel)
            ? normalizeString(accountInfo.loginLabel)
            : null,
      displayName:
        accountInfo && normalizeString(accountInfo.displayName)
          ? normalizeString(accountInfo.displayName)
          : null,
      loginId: order?.loginId || (accountInfo ? accountInfo.loginId : null),
      symbol: normalizeString(order?.symbol) || normalizeString(symbolInfo?.symbol) || null,
      symbolId: order?.symbolId ?? symbolInfo?.symbolId ?? null,
      description: normalizeString(symbolInfo?.description),
      currency: normalizeString(order?.currency) || normalizeString(symbolInfo?.currency) || null,
      status: normalizeString(order?.state) || normalizeString(order?.status) || null,
      action: normalizeString(order?.side) || normalizeString(order?.action) || null,
      type: normalizeString(order?.type) || null,
      timeInForce: normalizeString(order?.timeInForce) || null,
      totalQuantity: toFiniteNumber(order?.totalQuantity),
      openQuantity: toFiniteNumber(order?.openQuantity),
      filledQuantity: toFiniteNumber(order?.filledQuantity),
      limitPrice: toFiniteNumber(order?.limitPrice),
      stopPrice: toFiniteNumber(order?.stopPrice),
      avgExecPrice: toFiniteNumber(order?.avgExecPrice),
      lastExecPrice: toFiniteNumber(order?.lastExecPrice),
      commission: toFiniteNumber(order?.commission),
      commissionCharged: toFiniteNumber(order?.commissionCharged),
      venue: normalizeString(order?.venue),
      notes: normalizeString(order?.notes),
      source: normalizeString(order?.source),
      activityIndex: toFiniteNumber(order?.activityIndex),
      creationTime: normalizeString(order?.creationTime) || normalizeString(order?.createdTime) || null,
      updateTime: normalizeString(order?.updateTime) || normalizeString(order?.updatedTime) || null,
      gtdDate: normalizeString(order?.gtdDate) || null,
    };
  });
}

function dedupeOrdersByIdentifier(orders) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return [];
  }

  const uniqueMap = new Map();
  const fallback = [];

  orders.forEach(function (order) {
    if (!order || typeof order !== 'object') {
      return;
    }
    const identifier = resolveOrderIdentifier(order);
    if (identifier) {
      const existing = uniqueMap.get(identifier) || null;
      const chosen = pickMoreRecentOrder(existing, order) || order;
      uniqueMap.set(identifier, chosen);
    } else {
      fallback.push(order);
    }
  });

  const deduped = Array.from(uniqueMap.values());
  if (fallback.length === 0) {
    return deduped;
  }

  const fallbackMap = new Map();
  fallback.forEach(function (order, index) {
    if (!order || typeof order !== 'object') {
      return;
    }
    const accountKey =
      order.accountId != null
        ? 'acct:' + String(order.accountId)
        : order.accountNumber != null
          ? 'acct:' + String(order.accountNumber)
          : 'acct:' + index;
    const symbol = order.symbol != null ? String(order.symbol) : '';
    const timestamp =
      order.creationTime || order.createdTime || order.updateTime || order.updatedTime || String(index);
    const side = order.side || order.action || '';
    const quantityValue =
      Number.isFinite(Number(order.totalQuantity))
        ? 'qty:' + String(Number(order.totalQuantity))
        : Number.isFinite(Number(order.openQuantity))
          ? 'qty:' + String(Number(order.openQuantity))
          : Number.isFinite(Number(order.filledQuantity))
            ? 'qty:' + String(Number(order.filledQuantity))
            : '';
    const fallbackKey = ['fb', accountKey, symbol, timestamp, side, quantityValue].filter(Boolean).join('|');
    const existing = fallbackMap.get(fallbackKey) || null;
    const chosen = pickMoreRecentOrder(existing, order) || order;
    fallbackMap.set(fallbackKey, chosen);
  });

  fallbackMap.forEach(function (order) {
    deduped.push(order);
  });

  return deduped;
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

app.post('/api/news', async function (req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  const accountLabel = typeof body.accountLabel === 'string' ? body.accountLabel.trim() : '';
  const symbols = normalizeNewsSymbols(body.symbols);
  const accountKey = accountId || accountLabel || 'portfolio';
  const cacheKey = buildNewsCacheKey(accountKey, symbols);

  if (!symbols.length) {
    const emptyPayload = {
      articles: [],
      symbols,
      generatedAt: new Date().toISOString(),
    };
    if (accountLabel) {
      emptyPayload.accountLabel = accountLabel;
    }
    portfolioNewsCache.set(cacheKey, emptyPayload);
    return res.json(emptyPayload);
  }

  const cached = portfolioNewsCache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  // Initialize OpenAI and hard-require it for this endpoint.
  let openAi = null;
  try {
    openAi = ensureOpenAiClient();
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to initialize OpenAI client';
    console.error('Failed to initialize OpenAI client for portfolio news:', message);
    return res.status(503).json({ message: 'Portfolio news is unavailable', details: message });
  }

  try {
    const result = await fetchPortfolioNewsFromOpenAi({
      accountLabel: accountLabel || accountId || 'Portfolio',
      symbols,
      client: openAi,
    });

    const payload = {
      articles: result.articles,
      symbols,
      generatedAt: new Date().toISOString(),
      prompt: typeof result.prompt === 'string' ? result.prompt : null,
      rawOutput: typeof result.rawOutput === 'string' ? result.rawOutput : null,
      usage: result.usage || null,
      pricing: result.pricing || null,
      cost: result.cost || null,
    };
    if (accountLabel) {
      payload.accountLabel = accountLabel;
    }
    if (result.disclaimer) {
      payload.disclaimer = result.disclaimer;
    }

    portfolioNewsCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (error) {
    if (error && (error.code === 'OPENAI_NOT_CONFIGURED' || error.code === 'OPENAI_UNAUTHORIZED')) {
      return res.status(503).json({ message: 'Portfolio news is unavailable', details: error.message });
    }
    if (error && error.code === 'OPENAI_RATE_LIMIT') {
      return res.status(503).json({ message: 'Portfolio news temporarily unavailable', details: error.message });
    }
    const message = error && error.message ? error.message : 'Unknown error';
    console.error('Failed to load portfolio news:', message);
    return res.status(500).json({ message: 'Failed to load portfolio news', details: message });
  }
});

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
    if (!cached || typeof cached !== 'object' || cached.pegDiagnostics === undefined) {
      quoteCache.delete(cacheKey);
    } else {
      logPegDebug(normalizedSymbol, 'cache-hit', () => ({
        pegRatio: Number.isFinite(cached.pegRatio) ? cached.pegRatio : null,
      }));
      return res.json(cached);
    }
  }

  try {
    const lookupSymbol = trimmedSymbol || normalizedSymbol;
    const quote = await fetchYahooQuote(lookupSymbol);
    let quoteSummaryPromise = null;
    const loadQuoteSummary = () => {
      if (!quoteSummaryPromise) {
        quoteSummaryPromise = fetchYahooQuoteSummary(lookupSymbol);
      }
      return quoteSummaryPromise;
    };
    if (!quote) {
      return res.status(404).json({ message: `Quote unavailable for ${normalizedSymbol}` });
    }
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
    const changePercent = coerceQuoteNumber(quote.regularMarketChangePercent);
    const previousClose = coerceQuoteNumber(
      quote.regularMarketPreviousClose !== undefined && quote.regularMarketPreviousClose !== null
        ? quote.regularMarketPreviousClose
        : quote.previousClose
    );
    const trailingPe = coerceQuoteNumber(quote.trailingPE);
    const forwardPe = coerceQuoteNumber(quote.forwardPE);
    const peRatio = Number.isFinite(trailingPe) && trailingPe > 0
      ? trailingPe
      : Number.isFinite(forwardPe) && forwardPe > 0
        ? forwardPe
        : null;
    const initialPegDiagnostics = collectPegRatioDiagnostics(quote, null);
    const pegDiagnosticStages = [
      {
        stage: 'quote',
        accepted: initialPegDiagnostics.accepted,
        rejected: initialPegDiagnostics.rejected,
      },
    ];
    let pegRatio = initialPegDiagnostics.accepted.length > 0 ? initialPegDiagnostics.accepted[0].value : null;
    logPegDebug(normalizedSymbol, 'quote', () => ({
      price,
      trailingPe: Number.isFinite(trailingPe) && trailingPe > 0 ? trailingPe : null,
      forwardPe: Number.isFinite(forwardPe) && forwardPe > 0 ? forwardPe : null,
      pegCandidates: initialPegDiagnostics.accepted,
      rejectedCandidates: initialPegDiagnostics.rejected,
    }));
    if (initialPegDiagnostics.accepted.length === 0) {
      try {
        const quoteSummary = await loadQuoteSummary();
        const summaryDiagnostics = collectPegRatioDiagnostics(quote, quoteSummary);
        if (summaryDiagnostics.accepted.length > 0) {
          pegRatio = summaryDiagnostics.accepted[0].value;
        }
        pegDiagnosticStages.push({
          stage: 'quote-summary',
          accepted: summaryDiagnostics.accepted,
          rejected: summaryDiagnostics.rejected,
        });
        logPegDebug(normalizedSymbol, 'quote-summary', () => ({
          requestedModules: YAHOO_QUOTE_SUMMARY_MODULES,
          availableModules:
            quoteSummary && typeof quoteSummary === 'object'
              ? Object.keys(quoteSummary).filter((key) =>
                  quoteSummary[key] && typeof quoteSummary[key] === 'object'
                )
              : [],
          pegCandidates: summaryDiagnostics.accepted,
          rejectedCandidates: summaryDiagnostics.rejected,
        }));
      } catch (summaryError) {
        if (summaryError instanceof MissingYahooDependencyError || summaryError?.code === 'MISSING_DEPENDENCY') {
          throw summaryError;
        }
        const message = summaryError && summaryError.message ? summaryError.message : String(summaryError);
        console.warn('Failed to fetch quote summary from Yahoo Finance:', normalizedSymbol, message);
        logPegDebug(normalizedSymbol, 'quote-summary-error', () => ({
          requestedModules: YAHOO_QUOTE_SUMMARY_MODULES,
          error: message,
        }));
        pegDiagnosticStages.push({
          stage: 'quote-summary',
          accepted: [],
          rejected: [],
          error: message,
        });
      }
    }
    const marketCap = coerceQuoteNumber(quote.marketCap);
    const dividendContext = {};
    let dividendYieldPercent = resolveDividendYieldPercentFromQuote(quote, { context: dividendContext });
    if (shouldRefineDividendYieldWithSummary(dividendYieldPercent, dividendContext)) {
      try {
        const quoteSummary = await loadQuoteSummary();
        const summaryDetail =
          quoteSummary && typeof quoteSummary.summaryDetail === 'object' ? quoteSummary.summaryDetail : null;
        if (summaryDetail) {
          dividendYieldPercent = resolveDividendYieldPercentFromQuote(quote, { summaryDetail });
        }
      } catch (summaryError) {
        if (!(summaryError instanceof MissingYahooDependencyError) && summaryError?.code !== 'MISSING_DEPENDENCY') {
          const message = summaryError?.message || String(summaryError);
          console.warn('Failed to refine dividend yield from Yahoo summary:', normalizedSymbol, message);
        }
      }
    }
    const pegDiagnostics = buildPegDiagnosticsPayload(pegDiagnosticStages, {
      trailingPe: Number.isFinite(trailingPe) ? trailingPe : null,
      trailingPeSource: Number.isFinite(trailingPe) ? 'quote.trailingPE' : null,
      forwardPe: Number.isFinite(forwardPe) ? forwardPe : null,
      forwardPeSource: Number.isFinite(forwardPe) ? 'quote.forwardPE' : null,
    });

    const payload = {
      symbol: normalizedSymbol,
      price,
      currency,
      name,
      source: 'yahoo-finance2',
      asOf: resolveQuoteTimestamp(quote),
      changePercent: Number.isFinite(changePercent) ? changePercent : null,
      previousClose:
        Number.isFinite(previousClose) && previousClose > 0 ? previousClose : null,
      peRatio: Number.isFinite(peRatio) && peRatio > 0 ? peRatio : null,
      pegRatio: Number.isFinite(pegRatio) && pegRatio > 0 ? pegRatio : null,
      marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
      dividendYieldPercent:
        Number.isFinite(dividendYieldPercent) && dividendYieldPercent > 0
          ? dividendYieldPercent
          : null,
      pegDiagnostics: pegDiagnostics || null,
    };
    logPegDebug(normalizedSymbol, 'response', () => ({
      pegRatio: payload.pegRatio,
      dividendYieldPercent: payload.dividendYieldPercent,
      marketCap: payload.marketCap,
    }));
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

app.post('/api/accounts/:accountKey/target-proportions', function (req, res) {
  const rawAccountKey = typeof req.params.accountKey === 'string' ? req.params.accountKey : '';
  const accountKey = rawAccountKey.trim();
  if (!accountKey) {
    return res.status(400).json({ message: 'Account identifier is required' });
  }

  const rawProportions =
    req.body && Object.prototype.hasOwnProperty.call(req.body, 'proportions')
      ? req.body.proportions
      : req.body;

  try {
    const result = updateAccountTargetProportions(accountKey, rawProportions);
    return res.json({
      symbols: result.symbols,
      updated: result.updated,
      updatedCount: result.updatedCount,
    });
  } catch (error) {
    if (error && error.code === 'INVALID_ACCOUNT') {
      return res.status(400).json({ message: error.message });
    }
    if (error && error.code === 'INVALID_PROPORTIONS') {
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
    console.error('Failed to update target proportions:', error);
    return res.status(500).json({ message: 'Failed to update target proportions' });
  }
});

app.post('/api/accounts/:accountKey/symbol-notes', function (req, res) {
  const rawAccountKey = typeof req.params.accountKey === 'string' ? req.params.accountKey : '';
  const accountKey = rawAccountKey.trim();
  if (!accountKey) {
    return res.status(400).json({ message: 'Account identifier is required' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const rawSymbol = typeof payload.symbol === 'string' ? payload.symbol : '';
  const symbol = rawSymbol.trim();
  if (!symbol) {
    return res.status(400).json({ message: 'Symbol is required' });
  }

  const notesValue = Object.prototype.hasOwnProperty.call(payload, 'notes') ? payload.notes : payload.note;

  try {
    const result = updateAccountSymbolNote(accountKey, symbol, notesValue);
    return res.json({ symbol: result.symbol, notes: result.note, updated: result.updated });
  } catch (error) {
    if (error && error.code === 'INVALID_ACCOUNT') {
      return res.status(400).json({ message: error.message });
    }
    if (error && error.code === 'INVALID_SYMBOL') {
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
    console.error('Failed to update symbol note:', error);
    return res.status(500).json({ message: 'Failed to update symbol note' });
  }
});

app.post('/api/accounts/:accountKey/planning-context', function (req, res) {
  const rawAccountKey = typeof req.params.accountKey === 'string' ? req.params.accountKey : '';
  const accountKey = rawAccountKey.trim();
  if (!accountKey) {
    return res.status(400).json({ message: 'Account identifier is required' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const contextValue = Object.prototype.hasOwnProperty.call(payload, 'planningContext')
    ? payload.planningContext
    : payload.context ?? payload.note ?? payload.value ?? payload.text ?? null;

  try {
    const result = updateAccountPlanningContext(accountKey, contextValue);
    return res.json({ planningContext: result.planningContext, updated: result.updated });
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
    console.error('Failed to update planning context:', error);
    return res.status(500).json({ message: 'Failed to update planning context' });
  }
});

app.post('/api/accounts/:accountKey/metadata', function (req, res) {
  const rawAccountKey = typeof req.params.accountKey === 'string' ? req.params.accountKey : '';
  const accountKey = rawAccountKey.trim();
  if (!accountKey) {
    return res.status(400).json({ message: 'Account identifier is required' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    const result = updateAccountMetadata(accountKey, payload);
    return res.json({ updated: result.updated, updatedCount: result.updatedCount, metadata: result.payload });
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
    console.error('Failed to update account metadata:', error);
    return res.status(500).json({ message: 'Failed to update account metadata' });
  }
});

app.get('/api/summary', async function (req, res) {
  const requestedAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
  const includeAllAccounts = !requestedAccountId || requestedAccountId === 'all';
  const isDefaultRequested = requestedAccountId === 'default';
  const configuredDefaultKey = getDefaultAccountId();
  let normalizedSelection = normalizeSummaryRequestKey(requestedAccountId);
  let supersetEntry = null;
  const forceRefresh = req.query.force === 'true' || req.query.force === '1';
  const refreshKeyParam = typeof req.query.refreshKey === 'string' && req.query.refreshKey.trim() ? req.query.refreshKey.trim() : '';

  // When the client increments refreshKey, treat as manual cache invalidation
  if (refreshKeyParam && refreshKeyParam !== activeRefreshKey) {
    activeRefreshKey = refreshKeyParam;
    try {
      summaryCacheStore.clear();
      totalPnlSeriesCacheStore.clear();
      supersetSummaryCache = null;
      debugSummaryCache('manual refreshKey changed; caches cleared', activeRefreshKey);
    } catch (_) {
      // ignore cleanup errors
    }
  }

  // Scope cache keys to the provided refreshKey (if any)
  const cacheKeyPrefix = refreshKeyParam ? `rk:${refreshKeyParam}::` : 'rk:0::';
  normalizedSelection.cacheKey = `${cacheKeyPrefix}${normalizedSelection.cacheKey}`;

  try {
    if (!forceRefresh) {
      let cached = getSummaryCacheEntry(normalizedSelection.cacheKey);
      if (cached && cached.payload) {
        debugSummaryCache('cache hit', normalizedSelection.cacheKey, {
          requestedId: normalizedSelection.requestedId,
        });
        return res.json(cached.payload);
      }

    if (normalizedSelection.cacheKey !== 'all') {
      supersetEntry = getSupersetCacheEntry();
      if (supersetEntry) {
        const reinterpretedSelection = reinterpretSelectionWithSuperset(normalizedSelection, supersetEntry);
        if (reinterpretedSelection && reinterpretedSelection.cacheKey !== normalizedSelection.cacheKey) {
          debugSummaryCache('selection reinterpreted via superset metadata', normalizedSelection.cacheKey, {
            requestedId: normalizedSelection.requestedId,
            reinterpretedKey: reinterpretedSelection.cacheKey,
            reinterpretedId: reinterpretedSelection.requestedId,
          });
          normalizedSelection = reinterpretedSelection;
          // Re-scope the cache key with the current refreshKey prefix
          normalizedSelection.cacheKey = `${cacheKeyPrefix}${normalizedSelection.cacheKey}`;
          cached = getSummaryCacheEntry(normalizedSelection.cacheKey);
          if (cached && cached.payload) {
            debugSummaryCache('cache hit', normalizedSelection.cacheKey, {
              requestedId: normalizedSelection.requestedId,
            });
            return res.json(cached.payload);
          }
        }
      }

      if (supersetEntry && supersetEntry.payload) {
        const derivationDetails = DEBUG_SUMMARY_CACHE ? {} : null;
        const derived = deriveSummaryFromSuperset(supersetEntry, normalizedSelection, derivationDetails);
        if (derived) {
          setSummaryCacheEntry(normalizedSelection.cacheKey, derived, {
            requestedId: normalizedSelection.requestedId,
            source: 'superset',
            originalRequestedId: normalizedSelection.originalRequestedId || null,
            cacheScope: refreshKeyParam ? { refreshKey: refreshKeyParam, pinned: true } : undefined,
          });
          debugSummaryCache('served from superset cache', normalizedSelection.cacheKey, {
            requestedId: normalizedSelection.requestedId,
            originalRequestedId: normalizedSelection.originalRequestedId || null,
          });
          return res.json(derived);
        }
        if (derivationDetails) {
          debugSummaryCache('superset derivation unavailable', normalizedSelection.cacheKey, {
            requestedId: normalizedSelection.requestedId,
            originalRequestedId: normalizedSelection.originalRequestedId || null,
            reason: derivationDetails.reason || 'no-account-ids',
            accountIdsResolved: derivationDetails.accountIdsResolved || [],
            totalAccountIds: derivationDetails.totalAccountIds || 0,
            availableGroupKeys: derivationDetails.availableGroupKeys || [],
          });
        }
      }
      }
    }
  } catch (cacheError) {
    debugSummaryCache('cache lookup failed', normalizedSelection.cacheKey, cacheError?.message || cacheError);
  }

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
          applyAccountSettingsOverrideToAccount(normalizedAccount, accountSettingsOverride);
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

    const groupRelations = getAccountGroupRelations();
    const groupMetadata = getAccountGroupMetadata();
    const { accountGroups, accountGroupsById } = assignAccountGroups(allAccounts, {
      groupRelations,
      groupMetadata,
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
    const viewingAllAccountsRequest = includeAllAccounts || (isDefaultRequested && !defaultAccount);
    let viewingAccountGroup = false;
    let selectedAccountGroup = null;

    if (isDefaultRequested) {
      if (defaultAccount) {
        selectedAccounts = [defaultAccount];
      }
    } else if (!includeAllAccounts) {
      const groupMatch = accountGroupsById.get(requestedAccountId);
      if (groupMatch) {
        viewingAccountGroup = true;
        selectedAccountGroup = groupMatch;
        selectedAccounts = groupMatch.accounts.slice();
        if (!selectedAccounts.length) {
          return res.status(404).json({ message: 'No accounts found for the provided filter.' });
        }
      } else {
        selectedAccounts = allAccounts.filter(function (account) {
          return account.id === requestedAccountId || account.number === requestedAccountId;
        });
        if (!selectedAccounts.length) {
          return res.status(404).json({ message: 'No accounts found for the provided filter.' });
        }
      }
    }

    const viewingAggregateAccounts = viewingAllAccountsRequest || viewingAccountGroup;

    if (viewingAccountGroup) {
      resolvedAccountId = selectedAccountGroup.id;
    } else if (viewingAllAccountsRequest) {
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

    const positionsPromise = Promise.all(
      selectedContexts.map(function (context) {
        return fetchPositions(context.login, context.account.number);
      })
    );
    const balancesPromise = Promise.all(
      selectedContexts.map(function (context) {
        return fetchBalances(context.login, context.account.number);
      })
    );

    const [positionsResults, balancesResults] = await Promise.all([
      positionsPromise,
      balancesPromise,
    ]);
    const positionsByAccountId = {};
    try {
      selectedContexts.forEach(function (context, index) {
        if (!context || !context.account || !context.account.id) {
          return;
        }
        const arr = Array.isArray(positionsResults && positionsResults[index])
          ? positionsResults[index]
          : [];
        positionsByAccountId[context.account.id] = arr;
      });
    } catch (_) {
      // non-fatal; proceed without explicit mapping
    }
    const perAccountCombinedBalances = {};
    selectedContexts.forEach(function (context, index) {
      const summary = summarizeAccountBalances(balancesResults[index]);
      if (summary) {
        perAccountCombinedBalances[context.account.id] = summary;
      }
    });

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

    const orderFetchResults = selectedContexts.length
      ? await mapWithConcurrency(
          selectedContexts,
          Math.min(MAX_ORDER_HISTORY_CONCURRENCY, selectedContexts.length),
          async function (context) {
            let activityContext = null;
            try {
              activityContext = await ensureAccountActivityContext(context);
            } catch (activityError) {
              const activityMessage =
                activityError && activityError.message ? activityError.message : String(activityError);
              console.warn(
                'Failed to prepare activity history for order lookup for account ' + context.account.id + ':',
                activityMessage
              );
            }

            const now = new Date();
            const recentStartCandidate = new Date(now.getTime() - RECENT_ORDERS_LOOKBACK_DAYS * DAY_IN_MS);
            const normalizedRecentStart =
              clampDate(recentStartCandidate, MIN_ACTIVITY_DATE) || recentStartCandidate || now;

            let orders = [];
            try {
              orders = await fetchOrdersHistory(context.login, context.account.number, {
                startDate: normalizedRecentStart,
                endDate: now,
                stateFilter: 'All',
                maxPages: 200,
              });
            } catch (ordersError) {
              const message = ordersError && ordersError.message ? ordersError.message : String(ordersError);
              console.warn(
                'Failed to fetch orders for account ' + context.account.id + ':',
                message
              );
              orders = [];
            }

            // Prefer to include activity-derived orders up to the earliest real order
            // so we can fill gaps when the /orders API returns a truncated window.
            const earliestRealOrderIso = findEarliestOrderTimestamp(orders);
            const earliestRealOrderDate =
              typeof earliestRealOrderIso === 'string' && earliestRealOrderIso.trim()
                ? new Date(earliestRealOrderIso)
                : null;
            const cutoffDate =
              earliestRealOrderDate instanceof Date && !Number.isNaN(earliestRealOrderDate.getTime())
                ? earliestRealOrderDate
                : now; // if no real orders returned, include all activity orders before now

            const activityOrders = buildOrdersFromActivities(activityContext, context, cutoffDate);
            const startCandidates = [];
            if (normalizedRecentStart instanceof Date && !Number.isNaN(normalizedRecentStart.getTime())) {
              startCandidates.push(normalizedRecentStart.toISOString());
            }
            const activityStart = findEarliestOrderTimestamp(activityOrders);
            if (activityStart) {
              startCandidates.push(activityStart);
            }
            const startIso = startCandidates.length ? startCandidates.sort()[0] : null;

            return {
              context,
              orders,
              activityOrders,
              start: startIso,
              end: now.toISOString(),
            };
          }
        )
      : [];

    const flattenedOrders = orderFetchResults
      .map(function (result) {
        if (!result || !result.context) {
          return [];
        }
        const { context, orders, activityOrders } = result;
        const combined = [];
        if (Array.isArray(orders)) {
          orders.forEach(function (order) {
            if (!order || typeof order !== 'object') {
              return;
            }
            combined.push(
              Object.assign({}, order, {
                accountId: context.account.id,
                accountNumber: context.account.number,
                loginId: context.login.id,
              })
            );
          });
        }
        if (Array.isArray(activityOrders)) {
          activityOrders.forEach(function (order) {
            if (!order || typeof order !== 'object') {
              return;
            }
            combined.push(
              Object.assign({}, order, {
                accountId: order.accountId || context.account.id,
                accountNumber: order.accountNumber || context.account.number,
                loginId: order.loginId || context.login.id,
              })
            );
          });
        }
        return combined;
      })
      .flat();

    let orderWindowStartIso = null;
    let orderWindowEndIso = new Date().toISOString();

    orderFetchResults.forEach(function (result) {
      if (!result) {
        return;
      }
      if (result.start && (!orderWindowStartIso || result.start < orderWindowStartIso)) {
        orderWindowStartIso = result.start;
      }
      if (result.end && result.end > orderWindowEndIso) {
        orderWindowEndIso = result.end;
      }
    });

    const dedupedOrders = dedupeOrdersByIdentifier(flattenedOrders);

    dedupedOrders.forEach(function (order) {
      if (!order || typeof order !== 'object') {
        return;
      }
      const creation = typeof order.creationTime === 'string' ? order.creationTime : null;
      const update = typeof order.updateTime === 'string' ? order.updateTime : null;
      if (creation && (!orderWindowStartIso || creation < orderWindowStartIso)) {
        orderWindowStartIso = creation;
      }
      if (update && update > orderWindowEndIso) {
        orderWindowEndIso = update;
      }
    });

    if (!orderWindowStartIso) {
      orderWindowStartIso = orderWindowEndIso;
    }

    const symbolIdsByLogin = new Map();
    flattenedPositions.forEach(function (position) {
      if (!position.symbolId) {
        return;
      }
      const loginBucket = symbolIdsByLogin.get(position.loginId) || new Set();
      loginBucket.add(position.symbolId);
      symbolIdsByLogin.set(position.loginId, loginBucket);
    });
    dedupedOrders.forEach(function (order) {
      if (!order || !order.symbolId) {
        return;
      }
      const loginBucket = symbolIdsByLogin.get(order.loginId) || new Set();
      loginBucket.add(order.symbolId);
      symbolIdsByLogin.set(order.loginId, loginBucket);
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

    const dividendSymbolEntriesMap = new Map();
    flattenedPositions.forEach(function (position) {
      if (!position) {
        return;
      }
      const normalizedSymbol = normalizeSymbol(position.symbol);
      if (!normalizedSymbol) {
        return;
      }
      if (!dividendSymbolEntriesMap.has(normalizedSymbol)) {
        const rawSymbol =
          typeof position.symbol === 'string' && position.symbol.trim()
            ? position.symbol.trim()
            : normalizedSymbol;
        dividendSymbolEntriesMap.set(normalizedSymbol, rawSymbol);
      }
    });
    const dividendSymbolEntries = Array.from(dividendSymbolEntriesMap.entries()).map(function ([normalizedSymbol, rawSymbol]) {
      return { normalizedSymbol, rawSymbol };
    });
    const dividendYieldMap = await fetchDividendYieldMap(dividendSymbolEntries);

    const decoratedPositions = decoratePositions(
      flattenedPositions,
      symbolsMap,
      accountsMap,
      dividendYieldMap
    );
    const decoratedOrders = decorateOrders(dedupedOrders, symbolsMap, accountsMap);
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
    const accountTotalPnlBySymbol = {};
    const accountTotalPnlBySymbolAll = {};
    const accountTotalPnlSeries = {};
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

      let totalPnlSeries = null;
      if (accountFundingSummaries[context.account.id]) {
        try {
          totalPnlSeries = await computeTotalPnlSeries(
            context.login,
            context.account,
            perAccountCombinedBalances,
            { applyAccountCagrStartDate: true, activityContext: sharedActivityContext }
          );
        } catch (seriesError) {
          const message =
            seriesError && seriesError.message ? seriesError.message : String(seriesError);
          console.warn(
            'Failed to compute total P&L series for account ' + context.account.id + ':',
            message
          );
        }

        if (totalPnlSeries && totalPnlSeries.summary) {
          const summary = totalPnlSeries.summary;
          const fundingSummary = accountFundingSummaries[context.account.id];
          if (fundingSummary) {
            if (!fundingSummary.totalPnl || typeof fundingSummary.totalPnl !== 'object') {
              fundingSummary.totalPnl = {};
            }
            if (Number.isFinite(summary.totalPnlCad)) {
              fundingSummary.totalPnl.combinedCad = summary.totalPnlCad;
            }
            if (Number.isFinite(summary.totalPnlAllTimeCad)) {
              fundingSummary.totalPnl.allTimeCad = summary.totalPnlAllTimeCad;
            }
            if (Number.isFinite(summary.totalPnlSinceDisplayStartCad)) {
              fundingSummary.totalPnlSinceDisplayStartCad = summary.totalPnlSinceDisplayStartCad;
            }
            if (Number.isFinite(summary.netDepositsCad)) {
              fundingSummary.netDeposits = fundingSummary.netDeposits || {};
              if (!Number.isFinite(fundingSummary.netDeposits.combinedCad)) {
                fundingSummary.netDeposits.combinedCad = summary.netDepositsCad;
              }
            }
            if (Number.isFinite(summary.netDepositsAllTimeCad)) {
              fundingSummary.netDeposits = fundingSummary.netDeposits || {};
              if (!Number.isFinite(fundingSummary.netDeposits.allTimeCad)) {
                fundingSummary.netDeposits.allTimeCad = summary.netDepositsAllTimeCad;
              }
            }
            if (Number.isFinite(summary.totalEquityCad) && !Number.isFinite(fundingSummary.totalEquityCad)) {
              fundingSummary.totalEquityCad = summary.totalEquityCad;
            }
            if (Number.isFinite(summary.totalEquitySinceDisplayStartCad)) {
              fundingSummary.totalEquitySinceDisplayStartCad = summary.totalEquitySinceDisplayStartCad;
            }
            if (summary.displayStartTotals) {
              fundingSummary.displayStartTotals = summary.displayStartTotals;
            }
          }
        }
        if (totalPnlSeries) {
          const cacheKey = buildTotalPnlSeriesCacheKey(context.account.id, { applyAccountCagrStartDate: true });
          if (cacheKey) {
            setTotalPnlSeriesCacheEntry(cacheKey, totalPnlSeries);
          }
          setAccountTotalPnlSeries(accountTotalPnlSeries, context.account.id, 'cagr', totalPnlSeries);
        }
      }

      // Compute per-symbol Total P&L using the same activity/history context
      try {
        // Build end-of-period holdings snapshot by symbol for this account (from positions)
        const endHoldingsBySymbol = new Map();
        flattenedPositions.forEach(function (p) {
          if (!p || p.accountId !== context.account.id) return;
          const sym = typeof p.symbol === 'string' ? p.symbol : null;
          const qty = Number(p.openQuantity);
          if (!sym || !Number.isFinite(qty)) return;
          const key = normalizeSymbol(sym);
          if (!key) return;
          const current = endHoldingsBySymbol.has(key) ? endHoldingsBySymbol.get(key) : 0;
          endHoldingsBySymbol.set(key, current + qty);
        });
        // Align with CLI: rely on activity history only. Do not override final
        // quantities with positions here, as that can distort closed symbols' P&L
        // when history already captures the round trip accurately.
        const symbolTotals = await computeTotalPnlBySymbol(context.login, context.account, {
          activityContext: sharedActivityContext,
        });
        if (symbolTotals && Array.isArray(symbolTotals.entries)) {
          accountTotalPnlBySymbol[context.account.id] = {
            entries: symbolTotals.entries,
            entriesNoFx: Array.isArray(symbolTotals.entriesNoFx) ? symbolTotals.entriesNoFx : undefined,
            fxEffectCad: Number.isFinite(symbolTotals.fxEffectCad) ? symbolTotals.fxEffectCad : undefined,
            asOf: symbolTotals.endDate || null,
          };
        }
        // Also compute a from-start variant (ignore account CAGR start)
        const symbolTotalsAll = await computeTotalPnlBySymbol(context.login, context.account, {
          activityContext: sharedActivityContext,
          applyAccountCagrStartDate: false,
        });
        if (symbolTotalsAll && Array.isArray(symbolTotalsAll.entries)) {
          accountTotalPnlBySymbolAll[context.account.id] = {
            entries: symbolTotalsAll.entries,
            entriesNoFx: Array.isArray(symbolTotalsAll.entriesNoFx) ? symbolTotalsAll.entriesNoFx : undefined,
            fxEffectCad: Number.isFinite(symbolTotalsAll.fxEffectCad) ? symbolTotalsAll.fxEffectCad : undefined,
            asOf: symbolTotalsAll.endDate || null,
          };
        }
      } catch (pnlBySymbolError) {
        const message = pnlBySymbolError && pnlBySymbolError.message ? pnlBySymbolError.message : String(pnlBySymbolError);
        console.warn('Failed to compute per-symbol Total P&L for account ' + context.account.id + ':', message);
      }

      try {
        const dividendSummary = await computeDividendSummaries(context.login, context.account, {
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
    } else if (viewingAggregateAccounts && selectedContexts.length > 1) {
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

          let fundingSummaryAllTime = null;
          let fundingSummaryWithCagr = null;
          try {
            fundingSummaryAllTime = await computeNetDeposits(
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

          const hasCagrOverride =
            context &&
            context.account &&
            typeof context.account.cagrStartDate === 'string' &&
            context.account.cagrStartDate.trim();

          if (hasCagrOverride) {
            try {
              fundingSummaryWithCagr = await computeNetDeposits(
                context.login,
                context.account,
                perAccountCombinedBalances,
                activityContext
                  ? { applyAccountCagrStartDate: true, activityContext }
                  : { applyAccountCagrStartDate: true }
              );
            } catch (fundingErrorCagr) {
              const message =
                fundingErrorCagr && fundingErrorCagr.message ? fundingErrorCagr.message : String(fundingErrorCagr);
              console.warn(
                'Failed to compute CAGR-aligned net deposits for account ' + context.account.id + ':',
                message
              );
            }
          } else {
            fundingSummaryWithCagr = fundingSummaryAllTime;
          }

          return { context, fundingSummaryAllTime, fundingSummaryWithCagr };
        }
      );

      perAccountFunding.forEach(function (result) {
        const context = result && result.context;
        if (!context) {
          return;
        }

        const fundingSummaryAllTime = result && result.fundingSummaryAllTime ? result.fundingSummaryAllTime : null;
        const fundingSummaryWithCagr = result ? result.fundingSummaryWithCagr || null : null;
        const fundingSummaryForAccount = fundingSummaryWithCagr || fundingSummaryAllTime;
        const fundingSummaryForAggregate = fundingSummaryAllTime || fundingSummaryWithCagr;

        if (fundingSummaryForAccount) {
          accountFundingSummaries[context.account.id] = fundingSummaryForAccount;
        }

        if (!fundingSummaryForAggregate) {
          return;
        }

        const netDepositsCad =
          fundingSummaryForAggregate && fundingSummaryForAggregate.netDeposits
            ? fundingSummaryForAggregate.netDeposits.combinedCad
            : null;
        if (Number.isFinite(netDepositsCad)) {
          aggregateTotals.netDepositsCad += netDepositsCad;
          aggregateTotals.netDepositsCount += 1;
        }

        const totalPnlCad =
          fundingSummaryForAggregate && fundingSummaryForAggregate.totalPnl
            ? fundingSummaryForAggregate.totalPnl.combinedCad
            : null;
        if (Number.isFinite(totalPnlCad)) {
          aggregateTotals.totalPnlCad += totalPnlCad;
          aggregateTotals.totalPnlCount += 1;
        }

        const totalEquityCad = fundingSummaryForAggregate ? fundingSummaryForAggregate.totalEquityCad : null;
        if (Number.isFinite(totalEquityCad)) {
          aggregateTotals.totalEquityCad += totalEquityCad;
          aggregateTotals.totalEquityCount += 1;
        }

        if (Array.isArray(fundingSummaryForAggregate.cashFlowsCad)) {
          fundingSummaryForAggregate.cashFlowsCad.forEach((entry) => {
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

        if (
          fundingSummaryForAggregate.annualizedReturn &&
          fundingSummaryForAggregate.annualizedReturn.incomplete
        ) {
          aggregateTotals.incomplete = true;
        }
        if (
          fundingSummaryForAggregate.annualizedReturnAllTime &&
          fundingSummaryForAggregate.annualizedReturnAllTime.incomplete
        ) {
          aggregateTotals.incomplete = true;
        }
      });

      // Best-effort: for accounts with a CAGR start date, align funding summary using
      // the computed Total P&L series summary (handles since-display deltas accurately).
      const accountsNeedingCagrSeries = selectedContexts.filter(function (context) {
        const hasCagr = context && context.account && typeof context.account.cagrStartDate === 'string' && context.account.cagrStartDate.trim();
        return Boolean(hasCagr && accountFundingSummaries[context.account.id]);
      });
      if (accountsNeedingCagrSeries.length > 0) {
        const cagrSeriesOptions = { applyAccountCagrStartDate: true };
        await mapWithConcurrency(
          accountsNeedingCagrSeries,
          Math.min(PREHEAT_MAX_CONCURRENCY, accountsNeedingCagrSeries.length),
          async function (context) {
            let activityContext = null;
            try {
              activityContext = await ensureAccountActivityContext(context);
            } catch (activityError) {
              // Non-fatal
            }
            const cacheKey = buildTotalPnlSeriesCacheKey(context.account.id, cagrSeriesOptions);
            let series = cacheKey ? getTotalPnlSeriesCacheEntry(cacheKey) : null;
            if (!series) {
              try {
                const providedPositions = positionsByAccountId && positionsByAccountId[context.account.id];
                const computedOptions = activityContext
                  ? { ...cagrSeriesOptions, activityContext }
                  : { ...cagrSeriesOptions };
                if (Array.isArray(providedPositions)) {
                  computedOptions.providedPositions = providedPositions;
                }
                series = await computeTotalPnlSeries(
                  context.login,
                  context.account,
                  perAccountCombinedBalances,
                  computedOptions
                );
                if (series && cacheKey) {
                  setTotalPnlSeriesCacheEntry(cacheKey, series);
                }
              } catch (err) {
                series = null;
              }
            }
            if (!series || !series.summary) {
              return;
            }
            const fundingSummary = accountFundingSummaries[context.account.id];
            if (!fundingSummary || typeof fundingSummary !== 'object') {
              return;
            }
            const summary = series.summary;
            // Mirror the single-account augmentation logic
            if (!fundingSummary.totalPnl || typeof fundingSummary.totalPnl !== 'object') {
              fundingSummary.totalPnl = {};
            }
            if (Number.isFinite(summary.totalPnlCad)) {
              fundingSummary.totalPnl.combinedCad = summary.totalPnlCad;
            }
            if (Number.isFinite(summary.totalPnlAllTimeCad)) {
              fundingSummary.totalPnl.allTimeCad = summary.totalPnlAllTimeCad;
            }
            if (Number.isFinite(summary.totalPnlSinceDisplayStartCad)) {
              fundingSummary.totalPnlSinceDisplayStartCad = summary.totalPnlSinceDisplayStartCad;
            }
            if (Number.isFinite(summary.netDepositsCad)) {
              fundingSummary.netDeposits = fundingSummary.netDeposits || {};
              if (!Number.isFinite(fundingSummary.netDeposits.combinedCad)) {
                fundingSummary.netDeposits.combinedCad = summary.netDepositsCad;
              }
            }
            if (Number.isFinite(summary.netDepositsAllTimeCad)) {
              fundingSummary.netDeposits = fundingSummary.netDeposits || {};
              if (!Number.isFinite(fundingSummary.netDeposits.allTimeCad)) {
                fundingSummary.netDeposits.allTimeCad = summary.netDepositsAllTimeCad;
              }
            }
            if (Number.isFinite(summary.totalEquityCad) && !Number.isFinite(fundingSummary.totalEquityCad)) {
              fundingSummary.totalEquityCad = summary.totalEquityCad;
            }
            if (Number.isFinite(summary.totalEquitySinceDisplayStartCad)) {
              fundingSummary.totalEquitySinceDisplayStartCad = summary.totalEquitySinceDisplayStartCad;
            }
            if (summary.displayStartTotals) {
              fundingSummary.displayStartTotals = summary.displayStartTotals;
            }
          }
        );
      }

      // Aggregate per-symbol totals across accounts in this view
      const perAccountSymbolTotals = await mapWithConcurrency(
        selectedContexts,
        Math.min(MAX_AGGREGATE_FUNDING_CONCURRENCY, selectedContexts.length),
        async function (context) {
          let activityContext = null;
          try {
            activityContext = await ensureAccountActivityContext(context);
          } catch (activityError) {
            const activityMessage = activityError && activityError.message ? activityError.message : String(activityError);
            console.warn('Failed to prepare activity history for account ' + context.account.id + ' (per-symbol):', activityMessage);
          }
          try {
            // Compute both variants for aggregation
            const resultCagr = await computeTotalPnlBySymbol(context.login, context.account, {
              activityContext,
            });
            const resultAll = await computeTotalPnlBySymbol(context.login, context.account, {
              activityContext,
              applyAccountCagrStartDate: false,
            });
            return { context, result: resultCagr, resultAll };
          } catch (symbolError) {
            const message = symbolError && symbolError.message ? symbolError.message : String(symbolError);
            console.warn('Failed to compute per-symbol Total P&L for account ' + context.account.id + ' in aggregate view:', message);
            return { context, result: null, resultAll: null };
          }
        }
      );

      const symbolAggregateMap = new Map();
      const symbolAggregateMapAll = new Map();
      const symbolAggregateNoFxMap = new Map();
      const symbolAggregateNoFxMapAll = new Map();
      let aggregateAsOf = null;
      let aggregateAsOfAll = null;
      let aggregateFxEffectCad = 0;
      let aggregateFxEffectCadAll = 0;
      const cloneSymbolEntries = function cloneSymbolEntries(list) {
        if (!Array.isArray(list) || list.length === 0) {
          return [];
        }
        return list
          .map(function (symbolEntry) {
            if (!symbolEntry || typeof symbolEntry !== 'object') {
              return null;
            }
            const clone = { ...symbolEntry };
            if (Array.isArray(symbolEntry.components)) {
              clone.components = symbolEntry.components
                .map(function (component) {
                  return component && typeof component === 'object' ? { ...component } : null;
                })
                .filter(Boolean);
            }
            return clone;
          })
          .filter(Boolean);
      };

      const storePerAccountSymbolTotals = function storePerAccountSymbolTotals(target, accountId, source) {
        if (!target || !accountId || !source || typeof source !== 'object') {
          return;
        }
        const entries = cloneSymbolEntries(source.entries);
        const entriesNoFx = cloneSymbolEntries(source.entriesNoFx);
        const payload = {};
        if (entries.length) {
          payload.entries = entries;
        }
        if (entriesNoFx.length) {
          payload.entriesNoFx = entriesNoFx;
        }
        if (Number.isFinite(source.fxEffectCad)) {
          payload.fxEffectCad = source.fxEffectCad;
        }
        const asOf = typeof source.endDate === 'string' && source.endDate ? source.endDate : null;
        if (asOf) {
          payload.asOf = asOf;
        }
        if (Object.keys(payload).length === 0) {
          return;
        }
        target[accountId] = payload;
      };

      perAccountSymbolTotals.forEach(function (entry) {
        const accountId = entry && entry.context && entry.context.account && entry.context.account.id;
        if (accountId) {
          if (entry && entry.result) {
            storePerAccountSymbolTotals(accountTotalPnlBySymbol, accountId, entry.result);
          }
          if (entry && entry.resultAll) {
            storePerAccountSymbolTotals(accountTotalPnlBySymbolAll, accountId, entry.resultAll);
          }
        }
        if (!entry || !entry.result || !Array.isArray(entry.result.entries)) {
          // keep going; maybe resultAll is present
        } else {
          if (typeof entry.result.endDate === 'string' && entry.result.endDate) {
            if (!aggregateAsOf || entry.result.endDate > aggregateAsOf) {
              aggregateAsOf = entry.result.endDate;
            }
          }
          if (Number.isFinite(entry.result.fxEffectCad)) {
            aggregateFxEffectCad += entry.result.fxEffectCad;
          }
          entry.result.entries.forEach(function (symbolEntry) {
            const key = symbolEntry && typeof symbolEntry.symbol === 'string' ? symbolEntry.symbol.trim().toUpperCase() : null;
            if (!key) return;
            const existing = symbolAggregateMap.get(key) || {
              symbol: symbolEntry.symbol,
              symbolId: symbolEntry.symbolId || null,
              totalPnlCad: 0,
              investedCad: 0,
              openQuantity: 0,
              marketValueCad: 0,
              currency: symbolEntry.currency || null,
            };
            const add = (v) => (Number.isFinite(v) ? v : 0);
            existing.totalPnlCad += add(symbolEntry.totalPnlCad);
            existing.investedCad += add(symbolEntry.investedCad);
            existing.openQuantity += add(symbolEntry.openQuantity);
            existing.marketValueCad += add(symbolEntry.marketValueCad);
            if (!existing.symbolId && Number.isFinite(symbolEntry.symbolId)) {
              existing.symbolId = symbolEntry.symbolId;
            }
            if (!existing.currency && symbolEntry.currency) {
              existing.currency = symbolEntry.currency;
            }
            symbolAggregateMap.set(key, existing);
          });
          if (Array.isArray(entry.result.entriesNoFx)) {
            entry.result.entriesNoFx.forEach(function (symbolEntry) {
              const key = symbolEntry && typeof symbolEntry.symbol === 'string' ? symbolEntry.symbol.trim().toUpperCase() : null;
              if (!key) return;
              const existing = symbolAggregateNoFxMap.get(key) || {
                symbol: symbolEntry.symbol,
                symbolId: symbolEntry.symbolId || null,
                totalPnlCad: 0,
                investedCad: 0,
                openQuantity: 0,
                marketValueCad: 0,
                currency: symbolEntry.currency || null,
              };
              const add = (v) => (Number.isFinite(v) ? v : 0);
              existing.totalPnlCad += add(symbolEntry.totalPnlCad);
              existing.investedCad += add(symbolEntry.investedCad);
              existing.openQuantity += add(symbolEntry.openQuantity);
              existing.marketValueCad += add(symbolEntry.marketValueCad);
              if (!existing.symbolId && Number.isFinite(symbolEntry.symbolId)) {
                existing.symbolId = symbolEntry.symbolId;
              }
              if (!existing.currency && symbolEntry.currency) {
                existing.currency = symbolEntry.currency;
              }
              symbolAggregateNoFxMap.set(key, existing);
            });
          }
        }
        if (entry && entry.resultAll && Array.isArray(entry.resultAll.entries)) {
          if (typeof entry.resultAll.endDate === 'string' && entry.resultAll.endDate) {
            if (!aggregateAsOfAll || entry.resultAll.endDate > aggregateAsOfAll) {
              aggregateAsOfAll = entry.resultAll.endDate;
            }
          }
          if (Number.isFinite(entry.resultAll.fxEffectCad)) {
            aggregateFxEffectCadAll += entry.resultAll.fxEffectCad;
          }
          entry.resultAll.entries.forEach(function (symbolEntry) {
            const key = symbolEntry && typeof symbolEntry.symbol === 'string' ? symbolEntry.symbol.trim().toUpperCase() : null;
            if (!key) return;
            const existing = symbolAggregateMapAll.get(key) || {
              symbol: symbolEntry.symbol,
              symbolId: symbolEntry.symbolId || null,
              totalPnlCad: 0,
              investedCad: 0,
              openQuantity: 0,
              marketValueCad: 0,
              currency: symbolEntry.currency || null,
            };
            const add = (v) => (Number.isFinite(v) ? v : 0);
            existing.totalPnlCad += add(symbolEntry.totalPnlCad);
            existing.investedCad += add(symbolEntry.investedCad);
            existing.openQuantity += add(symbolEntry.openQuantity);
            existing.marketValueCad += add(symbolEntry.marketValueCad);
            if (!existing.symbolId && Number.isFinite(symbolEntry.symbolId)) {
              existing.symbolId = symbolEntry.symbolId;
            }
            if (!existing.currency && symbolEntry.currency) {
              existing.currency = symbolEntry.currency;
            }
            symbolAggregateMapAll.set(key, existing);
          });
          if (Array.isArray(entry.resultAll.entriesNoFx)) {
            entry.resultAll.entriesNoFx.forEach(function (symbolEntry) {
              const key = symbolEntry && typeof symbolEntry.symbol === 'string' ? symbolEntry.symbol.trim().toUpperCase() : null;
              if (!key) return;
              const existing = symbolAggregateNoFxMapAll.get(key) || {
                symbol: symbolEntry.symbol,
                symbolId: symbolEntry.symbolId || null,
                totalPnlCad: 0,
                investedCad: 0,
                openQuantity: 0,
                marketValueCad: 0,
                currency: symbolEntry.currency || null,
              };
              const add = (v) => (Number.isFinite(v) ? v : 0);
              existing.totalPnlCad += add(symbolEntry.totalPnlCad);
              existing.investedCad += add(symbolEntry.investedCad);
              existing.openQuantity += add(symbolEntry.openQuantity);
              existing.marketValueCad += add(symbolEntry.marketValueCad);
              if (!existing.symbolId && Number.isFinite(symbolEntry.symbolId)) {
                existing.symbolId = symbolEntry.symbolId;
              }
              if (!existing.currency && symbolEntry.currency) {
                existing.currency = symbolEntry.currency;
              }
              symbolAggregateNoFxMapAll.set(key, existing);
            });
          }
        }
      });

      const aggregateEntries = Array.from(symbolAggregateMap.values())
        .filter((e) => Number.isFinite(e.totalPnlCad) || Number.isFinite(e.marketValueCad))
        .sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));
      const aggregateEntriesAll = Array.from(symbolAggregateMapAll.values())
        .filter((e) => Number.isFinite(e.totalPnlCad) || Number.isFinite(e.marketValueCad))
        .sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));
      const aggregateEntriesNoFx = Array.from(symbolAggregateNoFxMap.values())
        .filter((e) => Number.isFinite(e.totalPnlCad) || Number.isFinite(e.marketValueCad))
        .sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));
      const aggregateEntriesNoFxAll = Array.from(symbolAggregateNoFxMapAll.values())
        .filter((e) => Number.isFinite(e.totalPnlCad) || Number.isFinite(e.marketValueCad))
        .sort((a, b) => Math.abs(b.totalPnlCad || 0) - Math.abs(a.totalPnlCad || 0));

      if (viewingAccountGroup && selectedAccountGroup && selectedAccountGroup.id) {
        accountTotalPnlBySymbol[selectedAccountGroup.id] = {
          entries: aggregateEntries,
          entriesNoFx: aggregateEntriesNoFx.length ? aggregateEntriesNoFx : undefined,
          fxEffectCad: Number.isFinite(aggregateFxEffectCad) ? aggregateFxEffectCad : undefined,
          asOf: aggregateAsOf || null,
        };
        accountTotalPnlBySymbolAll[selectedAccountGroup.id] = {
          entries: aggregateEntriesAll,
          entriesNoFx: aggregateEntriesNoFxAll.length ? aggregateEntriesNoFxAll : undefined,
          fxEffectCad: Number.isFinite(aggregateFxEffectCadAll) ? aggregateFxEffectCadAll : undefined,
          asOf: aggregateAsOfAll || aggregateAsOf || null,
        };
      } else {
        accountTotalPnlBySymbol['all'] = {
          entries: aggregateEntries,
          entriesNoFx: aggregateEntriesNoFx.length ? aggregateEntriesNoFx : undefined,
          fxEffectCad: Number.isFinite(aggregateFxEffectCad) ? aggregateFxEffectCad : undefined,
          asOf: aggregateAsOf || null,
        };
        accountTotalPnlBySymbolAll['all'] = {
          entries: aggregateEntriesAll,
          entriesNoFx: aggregateEntriesNoFxAll.length ? aggregateEntriesNoFxAll : undefined,
          fxEffectCad: Number.isFinite(aggregateFxEffectCadAll) ? aggregateFxEffectCadAll : undefined,
          asOf: aggregateAsOfAll || aggregateAsOf || null,
        };
      }

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
        // Compute an aggregate rate whenever we have usable cash flows, even if
        // some member accounts had incomplete data. We still mark the result
        // as incomplete to signal caution, but a rate is more useful than none.
        if (Array.isArray(aggregateTotals.cashFlowsCad) && aggregateTotals.cashFlowsCad.length > 0) {
          const computedRate = computeAccountAnnualizedReturn(aggregateTotals.cashFlowsCad, 'all');
          if (Number.isFinite(computedRate)) {
            aggregateRate = computedRate;
          }
        }
        if (Number.isFinite(aggregateRate)) {
          const aggregateAnnualized = {
            rate: aggregateRate,
            method: 'xirr',
            cashFlowCount: aggregateTotals.cashFlowsCad.length,
            asOf: aggregateAsOf,
            incomplete: aggregateTotals.incomplete || undefined,
          };
          aggregateEntry.annualizedReturn = aggregateAnnualized;
          aggregateEntry.annualizedReturnAllTime = Object.assign({}, aggregateAnnualized);
        } else if (aggregateTotals.incomplete) {
          const incompleteAnnualized = {
            method: 'xirr',
            cashFlowCount: aggregateTotals.cashFlowsCad.length,
            asOf: aggregateAsOf,
            incomplete: true,
          };
          aggregateEntry.annualizedReturn = incompleteAnnualized;
          aggregateEntry.annualizedReturnAllTime = Object.assign({}, incompleteAnnualized);
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
        if (viewingAccountGroup && selectedAccountGroup) {
          accountFundingSummaries[selectedAccountGroup.id] = aggregateEntry;
        }
        if (viewingAllAccountsRequest) {
          accountFundingSummaries.all = aggregateEntry;
        }
      }

          const aggregateSelectionKey = viewingAccountGroup && selectedAccountGroup
            ? selectedAccountGroup.id
            : viewingAllAccountsRequest
              ? 'all'
              : null;
          if (aggregateSelectionKey) {
            try {
          const aggregateSeriesOptions = { applyAccountCagrStartDate: false, positionsByAccountId };
          const aggregatedSeries = await computeAggregateTotalPnlSeriesForContexts(
            selectedContexts,
            perAccountCombinedBalances,
            aggregateSeriesOptions,
            aggregateSelectionKey,
            false,
            async (ctx) => {
              try {
                return await ensureAccountActivityContext(ctx);
              } catch (e) {
                return null;
              }
            }
          );
          if (aggregatedSeries) {
            setAccountTotalPnlSeries(accountTotalPnlSeries, aggregateSelectionKey, 'all', aggregatedSeries);
            const aggregateCacheKey = buildTotalPnlSeriesCacheKey(aggregateSelectionKey, aggregateSeriesOptions);
            if (aggregateCacheKey) {
              setTotalPnlSeriesCacheEntry(aggregateCacheKey, aggregatedSeries);
            }
          }
        } catch (seriesError) {
          const message =
            seriesError && seriesError.message ? seriesError.message : String(seriesError);
          console.warn('Failed to compute aggregate total P&L series for summary cache:', message);
        }
      }
      // Precompute group funding + per-group series when viewing all accounts so group views are instant
      if (viewingAllAccountsRequest && accountGroupsById instanceof Map) {
        // 1) Build group-level funding summaries (including annualized) from per-account funding
        for (const [groupKey, group] of accountGroupsById.entries()) {
          if (!group || !group.id || !Array.isArray(group.accounts) || !group.accounts.length) {
            continue;
          }
          const accountIds = group.accounts.map((a) => a && a.id).filter(Boolean);
          const aggregateFunding = aggregateFundingSummariesForAccounts(accountFundingSummaries, accountIds);
          if (!aggregateFunding) {
            continue;
          }
          // Compute annualized using merged cash flows (no extra API calls)
          const cashFlows = [];
          accountIds.forEach((id) => {
            const f = accountFundingSummaries[id];
            if (f && Array.isArray(f.cashFlowsCad)) {
              f.cashFlowsCad.forEach((entry) => {
                if (entry && typeof entry === 'object' && Number.isFinite(Number(entry.amount)) && entry.date) {
                  cashFlows.push({ amount: Number(entry.amount), date: entry.date });
                }
              });
            }
          });
          if (cashFlows.length > 0) {
            const asOf = new Date().toISOString();
            const rate = computeAccountAnnualizedReturn(cashFlows, group.id);
            if (Number.isFinite(rate)) {
              const annualized = {
                rate,
                method: 'xirr',
                cashFlowCount: cashFlows.length,
                asOf,
              };
              aggregateFunding.annualizedReturn = annualized;
              aggregateFunding.annualizedReturnAllTime = Object.assign({}, annualized);
            } else {
              aggregateFunding.annualizedReturn = { method: 'xirr', cashFlowCount: cashFlows.length, asOf, incomplete: true };
              aggregateFunding.annualizedReturnAllTime = Object.assign({}, aggregateFunding.annualizedReturn);
            }
          }
          accountFundingSummaries[group.id] = aggregateFunding;
        }

        // 2) Precompute group Total P&L series (all-time). Use cached per-account series and activity contexts.
        for (const [groupKey, group] of accountGroupsById.entries()) {
          if (!group || !group.id || !Array.isArray(group.accounts) || !group.accounts.length) {
            continue;
          }
          const allowed = new Set(group.accounts.map((a) => a && a.id).filter(Boolean));
          const groupContexts = selectedContexts.filter((ctx) => allowed.has(ctx.account.id));
          if (!groupContexts.length) {
            continue;
          }
          try {
            const options = { applyAccountCagrStartDate: false, positionsByAccountId };
            const series = await computeAggregateTotalPnlSeriesForContexts(
              groupContexts,
              perAccountCombinedBalances,
              options,
              group.id,
              false,
              async (ctx) => {
                try {
                  return await ensureAccountActivityContext(ctx);
                } catch (e) {
                  return null;
                }
              }
            );
            if (series) {
              setAccountTotalPnlSeries(accountTotalPnlSeries, group.id, 'all', series);
              const cacheKey = buildTotalPnlSeriesCacheKey(group.id, options);
              if (cacheKey) {
                setTotalPnlSeriesCacheEntry(cacheKey, series);
              }
              // Ensure group funding has period window and all-time totals aligned with series
              const merged = Object.assign({}, accountFundingSummaries[group.id] || {});
              const s = series.summary || {};
              if (Number.isFinite(s.netDepositsAllTimeCad)) {
                merged.netDeposits = Object.assign({}, merged.netDeposits || {}, { allTimeCad: s.netDepositsAllTimeCad });
              }
              if (Number.isFinite(s.totalPnlAllTimeCad)) {
                merged.totalPnl = Object.assign({}, merged.totalPnl || {}, { allTimeCad: s.totalPnlAllTimeCad });
              }
              if (Number.isFinite(s.totalEquityCad)) {
                merged.totalEquityCad = s.totalEquityCad;
              }
              if (series.periodStartDate && !merged.periodStartDate) {
                merged.periodStartDate = series.periodStartDate;
              }
              if (series.periodEndDate && !merged.periodEndDate) {
                merged.periodEndDate = series.periodEndDate;
              }
              accountFundingSummaries[group.id] = merged;
              }
          } catch (groupSeriesError) {
            const message = groupSeriesError && groupSeriesError.message ? groupSeriesError.message : String(groupSeriesError);
            console.warn('Failed to compute preheated group Total P&L series for', group.id, message);
          }
        }
      }

      // Populate per-account series map without requiring PREHEAT
      // We prefer cached series generated during aggregate computation; as a fallback,
      // we will derive a minimal "cagr" view by attaching displayStartDate to the
      // existing all-time series. This avoids new external API calls.
      if (viewingAllAccountsRequest) {
        const contextById = new Map();
        selectedContexts.forEach((ctx) => {
          if (ctx && ctx.account && ctx.account.id) {
            contextById.set(ctx.account.id, ctx);
          }
        });

        selectedContexts.forEach((ctx) => {
          const accountId = ctx && ctx.account && ctx.account.id;
          if (!accountId) return;

          const entry = ensureAccountTotalPnlSeriesEntry(accountTotalPnlSeries, accountId);

          // Attach per-account all-time series from cache, if available
          if (!entry.all) {
            const allKey = buildTotalPnlSeriesCacheKey(accountId, { applyAccountCagrStartDate: false });
            const allSeries = allKey ? getTotalPnlSeriesCacheEntry(allKey) : null;
            if (allSeries) {
              entry.all = allSeries;
            }
          }

          // If a CAGR start date exists, expose a "cagr" view without recomputing
          const funding = accountFundingSummaries[accountId] || {};
          const cagrStart = (typeof funding.cagrStartDate === 'string' && funding.cagrStartDate.trim())
            ? funding.cagrStartDate.trim()
            : (typeof ctx.account.cagrStartDate === 'string' && ctx.account.cagrStartDate.trim())
              ? ctx.account.cagrStartDate.trim()
              : null;

          if (cagrStart && !entry.cagr) {
            // Prefer cached CAGR series if present
            const cagrKey = buildTotalPnlSeriesCacheKey(accountId, { applyAccountCagrStartDate: true });
            const cachedCagr = cagrKey ? getTotalPnlSeriesCacheEntry(cagrKey) : null;
            if (cachedCagr) {
              entry.cagr = cachedCagr;
            } else if (entry.all) {
              // Derive a minimal CAGR variant by annotating the all-time series
              // with a displayStartDate. Points are reused as-is which is sufficient
              // for the deployment chart in the UI and avoids any new API calls.
              entry.cagr = Object.assign({}, entry.all, { displayStartDate: cagrStart });
            }
          }
        });
      }

      // Precompute per-account series for performance if enabled
      if (PREHEAT_ACCOUNT_TOTAL_PNL && viewingAllAccountsRequest) {
        await mapWithConcurrency(
          selectedContexts,
          Math.min(PREHEAT_MAX_CONCURRENCY, selectedContexts.length),
          async function (context) {
            let activityContext = null;
            try {
              activityContext = await ensureAccountActivityContext(context);
            } catch (activityError) {
              const msg = activityError && activityError.message ? activityError.message : String(activityError);
              console.warn('Failed to prepare activity for per-account series', context.account.id, msg);
            }
            try {
              const series = await computeTotalPnlSeries(
                context.login,
                context.account,
                perAccountCombinedBalances,
                activityContext ? { applyAccountCagrStartDate: true, activityContext } : { applyAccountCagrStartDate: true }
              );
              if (series) {
                setAccountTotalPnlSeries(accountTotalPnlSeries, context.account.id, 'cagr', series);
                const cacheKey = buildTotalPnlSeriesCacheKey(context.account.id, { applyAccountCagrStartDate: true });
                if (cacheKey) {
                  setTotalPnlSeriesCacheEntry(cacheKey, series);
                }
              }
            } catch (seriesError) {
              const message = seriesError && seriesError.message ? seriesError.message : String(seriesError);
              console.warn('Failed to compute per-account Total P&L series for', context.account.id, message);
            }
          }
        );
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
          const dividendSummary = await computeDividendSummaries(
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
      const symbolSettings =
        account.symbolSettings && typeof account.symbolSettings === 'object' && !Array.isArray(account.symbolSettings)
          ? account.symbolSettings
          : null;

      let symbolConfigurations = null;
      let symbolNotesMap = null;

      if (symbolSettings) {
        Object.entries(symbolSettings).forEach(([symbol, entry]) => {
          const trimmedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : null;
          if (!trimmedSymbol || !entry || typeof entry !== 'object') {
            return;
          }

          const sanitizedEntry = {};
          if (Object.prototype.hasOwnProperty.call(entry, 'targetProportion')) {
            const numeric = Number(entry.targetProportion);
            if (Number.isFinite(numeric)) {
              sanitizedEntry.targetProportion = numeric;
            }
          }
          if (Object.prototype.hasOwnProperty.call(entry, 'notes')) {
            const note = typeof entry.notes === 'string' ? entry.notes.trim() : '';
            if (note) {
              sanitizedEntry.notes = note;
              if (!symbolNotesMap) {
                symbolNotesMap = {};
              }
              symbolNotesMap[trimmedSymbol] = note;
            }
          }

          if (Object.keys(sanitizedEntry).length) {
            if (!symbolConfigurations) {
              symbolConfigurations = {};
            }
            symbolConfigurations[trimmedSymbol] = sanitizedEntry;
          }
        });
      }

      if (account.symbolNotes && typeof account.symbolNotes === 'object') {
        Object.entries(account.symbolNotes).forEach(([symbol, note]) => {
          const trimmedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : null;
          const normalizedNote = typeof note === 'string' ? note.trim() : '';
          if (!trimmedSymbol || !normalizedNote) {
            return;
          }
          if (!symbolNotesMap) {
            symbolNotesMap = {};
          }
          symbolNotesMap[trimmedSymbol] = normalizedNote;
          if (!symbolConfigurations) {
            symbolConfigurations = {};
          }
          const existing = symbolConfigurations[trimmedSymbol] || {};
          symbolConfigurations[trimmedSymbol] = Object.assign({}, existing, { notes: normalizedNote });
        });
      }

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
        symbols: symbolConfigurations,
        symbolNotes: symbolNotesMap,
        planningContext:
          typeof account.planningContext === 'string' && account.planningContext.trim()
            ? account.planningContext.trim()
            : null,
        cagrStartDate:
          typeof account.cagrStartDate === 'string' && account.cagrStartDate.trim()
            ? account.cagrStartDate.trim()
            : null,
        projectionGrowthPercent: (function () {
          const raw = account.projectionGrowthPercent;
          const num = typeof raw === 'string' ? Number(raw.trim()) : raw;
          return Number.isFinite(num) ? num : null;
        })(),
        accountGroup: account.accountGroup || null,
        accountGroupId: account.accountGroupId || null,
        mainRetirementAccount: account.mainRetirementAccount === true,
        retirementAge:
          Number.isFinite(account.retirementAge) && account.retirementAge > 0
            ? Math.round(account.retirementAge)
            : null,
        retirementYear: Number.isFinite(account.retirementYear) ? Math.round(account.retirementYear) : null,
        retirementIncome:
          Number.isFinite(account.retirementIncome) && account.retirementIncome >= 0
            ? Math.round(account.retirementIncome * 100) / 100
            : null,
        retirementLivingExpenses:
          Number.isFinite(account.retirementLivingExpenses) && account.retirementLivingExpenses >= 0
            ? Math.round(account.retirementLivingExpenses * 100) / 100
            : null,
        retirementBirthDate:
          typeof account.retirementBirthDate === 'string' && account.retirementBirthDate.trim()
            ? account.retirementBirthDate.trim()
            : null,
        retirementHouseholdType:
          typeof account.retirementHouseholdType === 'string' && account.retirementHouseholdType.trim()
            ? account.retirementHouseholdType.trim()
            : null,
        retirementBirthDate1:
          typeof account.retirementBirthDate1 === 'string' && account.retirementBirthDate1.trim()
            ? account.retirementBirthDate1.trim()
            : null,
        retirementBirthDate2:
          typeof account.retirementBirthDate2 === 'string' && account.retirementBirthDate2.trim()
            ? account.retirementBirthDate2.trim()
            : null,
        retirementCppYearsContributed1: Number.isFinite(account.retirementCppYearsContributed1)
          ? Math.max(0, Math.round(account.retirementCppYearsContributed1))
          : null,
        retirementCppAvgEarningsPctOfYMPE1: Number.isFinite(account.retirementCppAvgEarningsPctOfYMPE1)
          ? Math.max(0, Math.round(account.retirementCppAvgEarningsPctOfYMPE1 * 100) / 100)
          : null,
        retirementCppStartAge1: Number.isFinite(account.retirementCppStartAge1)
          ? Math.max(0, Math.round(account.retirementCppStartAge1))
          : null,
        retirementOasYearsResident1: Number.isFinite(account.retirementOasYearsResident1)
          ? Math.max(0, Math.round(account.retirementOasYearsResident1))
          : null,
        retirementOasStartAge1: Number.isFinite(account.retirementOasStartAge1)
          ? Math.max(0, Math.round(account.retirementOasStartAge1))
          : null,
        retirementCppYearsContributed2: Number.isFinite(account.retirementCppYearsContributed2)
          ? Math.max(0, Math.round(account.retirementCppYearsContributed2))
          : null,
        retirementCppAvgEarningsPctOfYMPE2: Number.isFinite(account.retirementCppAvgEarningsPctOfYMPE2)
          ? Math.max(0, Math.round(account.retirementCppAvgEarningsPctOfYMPE2 * 100) / 100)
          : null,
        retirementCppStartAge2: Number.isFinite(account.retirementCppStartAge2)
          ? Math.max(0, Math.round(account.retirementCppStartAge2))
          : null,
        retirementOasYearsResident2: Number.isFinite(account.retirementOasYearsResident2)
          ? Math.max(0, Math.round(account.retirementOasYearsResident2))
          : null,
        retirementOasStartAge2: Number.isFinite(account.retirementOasStartAge2)
          ? Math.max(0, Math.round(account.retirementOasStartAge2))
          : null,
        retirementCppMaxAt65Annual: Number.isFinite(account.retirementCppMaxAt65Annual)
          ? Math.max(0, Math.round(account.retirementCppMaxAt65Annual))
          : null,
        retirementOasFullAt65Annual: Number.isFinite(account.retirementOasFullAt65Annual)
          ? Math.max(0, Math.round(account.retirementOasFullAt65Annual))
          : null,
        isDefault: defaultAccountId ? account.id === defaultAccountId : false,
      };
    });

    const responseAccountGroups = accountGroups.map(function (group) {
      const accountIds = Array.isArray(group.accountIds)
        ? group.accountIds.map((id) => String(id))
        : group.accounts.map((account) => account.id);
      const accountNumbers = Array.isArray(group.accountNumbers)
        ? group.accountNumbers.map((number) => String(number))
        : group.accounts
            .map((account) =>
              account.number !== undefined && account.number !== null
                ? String(account.number).trim()
                : null
            )
            .filter(Boolean);
      const ownerLabels = Array.isArray(group.ownerLabels)
        ? group.ownerLabels
        : group.accounts
            .map((account) =>
              typeof account.ownerLabel === 'string' ? account.ownerLabel.trim() : ''
            )
            .filter(Boolean);
      const uniqueAccountNumbers = Array.from(new Set(accountNumbers));
      const uniqueOwnerLabels = Array.from(new Set(ownerLabels));
      const retirementAge =
        Number.isFinite(group.retirementAge) && group.retirementAge > 0
          ? Math.round(group.retirementAge)
          : null;
      const retirementYear = Number.isFinite(group.retirementYear) ? Math.round(group.retirementYear) : null;
      const retirementIncome =
        Number.isFinite(group.retirementIncome) && group.retirementIncome >= 0
          ? Math.round(group.retirementIncome * 100) / 100
          : null;
      const retirementLivingExpenses =
        Number.isFinite(group.retirementLivingExpenses) && group.retirementLivingExpenses >= 0
          ? Math.round(group.retirementLivingExpenses * 100) / 100
          : null;
      const retirementBirthDate =
        typeof group.retirementBirthDate === 'string' && group.retirementBirthDate
          ? group.retirementBirthDate
          : null;
      const retirementHouseholdType =
        typeof group.retirementHouseholdType === 'string' && group.retirementHouseholdType
          ? group.retirementHouseholdType
          : null;
      const retirementBirthDate1 =
        typeof group.retirementBirthDate1 === 'string' && group.retirementBirthDate1
          ? group.retirementBirthDate1
          : null;
      const retirementBirthDate2 =
        typeof group.retirementBirthDate2 === 'string' && group.retirementBirthDate2
          ? group.retirementBirthDate2
          : null;
      const retirementCppYearsContributed1 = Number.isFinite(group.retirementCppYearsContributed1)
        ? Math.max(0, Math.round(group.retirementCppYearsContributed1))
        : null;
      const retirementCppYearsContributed2 = Number.isFinite(group.retirementCppYearsContributed2)
        ? Math.max(0, Math.round(group.retirementCppYearsContributed2))
        : null;
      const retirementCppAvgEarningsPctOfYMPE1 = Number.isFinite(group.retirementCppAvgEarningsPctOfYMPE1)
        ? Math.max(0, Math.round(group.retirementCppAvgEarningsPctOfYMPE1 * 100) / 100)
        : null;
      const retirementCppAvgEarningsPctOfYMPE2 = Number.isFinite(group.retirementCppAvgEarningsPctOfYMPE2)
        ? Math.max(0, Math.round(group.retirementCppAvgEarningsPctOfYMPE2 * 100) / 100)
        : null;
      const retirementOasYearsResident1 = Number.isFinite(group.retirementOasYearsResident1)
        ? Math.max(0, Math.round(group.retirementOasYearsResident1))
        : null;
      const retirementOasYearsResident2 = Number.isFinite(group.retirementOasYearsResident2)
        ? Math.max(0, Math.round(group.retirementOasYearsResident2))
        : null;
      const retirementCppMaxAt65Annual = Number.isFinite(group.retirementCppMaxAt65Annual)
        ? Math.max(0, Math.round(group.retirementCppMaxAt65Annual))
        : null;
      const retirementOasFullAt65Annual = Number.isFinite(group.retirementOasFullAt65Annual)
        ? Math.max(0, Math.round(group.retirementOasFullAt65Annual))
        : null;
      return {
        id: group.id,
        name: group.name,
        memberCount: Number.isFinite(group.memberCount) ? group.memberCount : accountIds.length,
        accountIds,
        accountNumbers: uniqueAccountNumbers,
        ownerLabels: uniqueOwnerLabels,
        mainRetirementAccount: group.mainRetirementAccount === true,
        retirementAge,
        retirementYear,
        retirementIncome,
        retirementLivingExpenses,
        retirementBirthDate,
        retirementHouseholdType,
        retirementBirthDate1,
        retirementBirthDate2,
        retirementCppYearsContributed1,
        retirementCppAvgEarningsPctOfYMPE1,
        retirementOasYearsResident1,
        retirementCppYearsContributed2,
        retirementCppAvgEarningsPctOfYMPE2,
        retirementOasYearsResident2,
        retirementCppMaxAt65Annual,
        retirementOasFullAt65Annual,
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

    const responsePayload = {
      accounts: responseAccounts,
      accountGroups: responseAccountGroups,
      // Debug aid: shows inferred group-of-group relations from config
      groupRelations,
      accountNamesFilePath: accountNamesModule.accountNamesFilePath,
      filteredAccountIds: selectedContexts.map(function (context) {
        return context.account.id;
      }),
      defaultAccountId,
      defaultAccountNumber: defaultAccount ? defaultAccount.number : null,
      resolvedAccountId,
      resolvedAccountNumber,
      requestedAccountId: requestedAccountId || null,
      positions: decoratedPositions,
      orders: decoratedOrders,
      ordersWindow: { start: orderWindowStartIso, end: orderWindowEndIso },
      pnl: pnl,
      balances: balancesSummary,
      accountBalances: perAccountCombinedBalances,
      investmentModelEvaluations,
      accountFunding: accountFundingSummaries,
      accountDividends: accountDividendSummaries,
      accountTotalPnlBySymbol,
      accountTotalPnlBySymbolAll,
      accountTotalPnlSeries,
      asOf: new Date().toISOString(),
      usdToCadRate: latestUsdToCadRate,
    };

    if (includeAllAccounts) {
      clearSummaryCache();
    }

    setSummaryCacheEntry(normalizedSelection.cacheKey, responsePayload, {
      requestedId: normalizedSelection.requestedId,
      source: 'live',
      originalRequestedId: normalizedSelection.originalRequestedId || null,
      cacheScope: refreshKeyParam ? { refreshKey: refreshKeyParam, pinned: true } : undefined,
    });

    if (includeAllAccounts) {
      const balancesRawByAccountId = new Map();
      selectedContexts.forEach(function (context, index) {
        if (context && context.account && context.account.id) {
          balancesRawByAccountId.set(context.account.id, balancesResults[index]);
        }
      });

      const orderWindowsByAccountId = new Map();
      orderFetchResults.forEach(function (result) {
        const accountId = result && result.context && result.context.account && result.context.account.id;
        if (!accountId) {
          return;
        }
        orderWindowsByAccountId.set(accountId, {
          start: result.start || null,
          end: result.end || null,
        });
      });

      const accountsById = new Map();
      const accountsByNumber = new Map();
      responseAccounts.forEach(function (account) {
        if (!account || !account.id) {
          return;
        }
        accountsById.set(account.id, account);
        const numberKey =
          account.number !== undefined && account.number !== null
            ? String(account.number).trim()
            : '';
        if (numberKey) {
          accountsByNumber.set(numberKey, account.id);
        }
      });

      const groupAccountIds = new Map();
      if (accountGroupsById && typeof accountGroupsById.forEach === 'function') {
        accountGroupsById.forEach(function (group, key) {
          if (!group || !group.id) {
            return;
          }
          const ids = Array.isArray(group.accounts)
            ? group.accounts
                .map(function (acc) {
                  return acc && acc.id ? acc.id : null;
                })
                .filter(Boolean)
            : [];
          const normalizedKey = typeof group.id === 'string' ? group.id.toLowerCase() : String(group.id || '');
          if (normalizedKey) {
            groupAccountIds.set(normalizedKey, ids);
          }
          groupAccountIds.set(group.id, ids);
          if (typeof key === 'string' && key) {
            groupAccountIds.set(key.toLowerCase(), ids);
          }
        });
      }

      const groupLookup = buildGroupLookupMap(accountGroupsById);

    const supersetTimestamp = nowMs();
    const supersetEntry = {
      cacheKey: normalizedSelection.cacheKey,
      payload: responsePayload,
      timestamp: supersetTimestamp,
    expiresAt: refreshKeyParam ? PINNED_EXPIRY_MS : supersetTimestamp + SUMMARY_CACHE_TTL_MS,
      accounts: responseAccounts,
      accountGroups: responseAccountGroups,
      accountsById,
      accountsByNumber,
        groupAccountIds,
        groupLookup,
        groupRelations,
        accountNamesFilePath: accountNamesModule.accountNamesFilePath,
        perAccountCombinedBalances,
        accountFundingSummaries,
        accountDividendSummaries,
        accountTotalPnlBySymbol,
        accountTotalPnlBySymbolAll,
        accountTotalPnlSeries,
        investmentModelEvaluations,
        decoratedPositions,
        decoratedOrders,
        flattenedPositions,
        balancesRawByAccountId,
        orderWindowsByAccountId,
        allAccountIds: selectedContexts.map(function (context) {
          return context.account.id;
        }),
        defaultAccountId,
        defaultAccountNumber: defaultAccount ? defaultAccount.number : null,
        usdToCadRate: latestUsdToCadRate,
        asOf: responsePayload.asOf,
        filteredAccountIds: responsePayload.filteredAccountIds,
      };

      setSupersetCacheEntry(supersetEntry);
    }

    // Build a superset cache entry to allow subsequent symbol-series requests to avoid
    // re-fetching activities from providers. We persist resolved activity contexts
    // and the per-account balance summaries alongside the payload we already cache.
    try {
      const resolvedActivityContexts = {};
      for (const [accountId, promise] of accountActivityContextCache.entries()) {
        try {
          const ctx = await Promise.resolve(promise);
          if (ctx && ctx.accountId) {
            resolvedActivityContexts[accountId] = ctx;
          }
        } catch (e) {
          // Ignore individual context failures
        }
      }
      // Merge with any existing superset entry so fields like `accounts` remain available.
      const previous = getSupersetCacheEntry() || {};
      const supersetEntry = Object.assign({}, previous, {
        payload: responsePayload,
        perAccountCombinedBalances,
        activityContextsByAccountId: resolvedActivityContexts,
        asOf: responsePayload.asOf,
      });
      setSupersetCacheEntry(supersetEntry);
    } catch (cacheError) {
      // If we fail to persist the superset cache, continue with the response
      debugSummaryCache('failed to persist superset extras', cacheError?.message || cacheError);
    }

    res.json(responsePayload);
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

  const normalizedKey = rawAccountKey.toLowerCase();
  const isGroupKey = normalizedKey.startsWith('group:');
  const refreshKeyParam = typeof req.query.refreshKey === 'string' && req.query.refreshKey.trim() ? req.query.refreshKey.trim() : '';
  const symbolParam =
    typeof req.query.symbol === 'string' && req.query.symbol.trim() ? req.query.symbol.trim() : null;
  const startDateParam =
    typeof req.query.startDate === 'string' && req.query.startDate.trim() ? req.query.startDate.trim() : null;
  const endDateParam =
    typeof req.query.endDate === 'string' && req.query.endDate.trim() ? req.query.endDate.trim() : null;
  let applyAccountCagrStartDate = true;
  if (req.query.applyAccountCagrStartDate === 'false' || req.query.applyAccountCagrStartDate === '0') {
    applyAccountCagrStartDate = false;
  }
  const isAggregateRequest = normalizedKey === 'all' || isGroupKey;
  if (isAggregateRequest) {
    applyAccountCagrStartDate = false;
  }
  const queryOptions = {
    startDate: startDateParam,
    endDate: endDateParam,
    applyAccountCagrStartDate,
    symbol: symbolParam,
    refreshKey: refreshKeyParam,
  };
  const cacheKey = buildTotalPnlSeriesCacheKey(normalizedKey, queryOptions);
  const cachedSeries = cacheKey ? getTotalPnlSeriesCacheEntry(cacheKey) : null;
  if (cachedSeries) {
    return res.json(cachedSeries);
  }

  if (isAggregateRequest) {
    try {
      const aggregateOptions = { ...queryOptions };
      let contexts = [];
      let hadAccountFetchFailure = false;

      const superset = getSupersetCacheEntry();
      if (symbolParam && superset && Array.isArray(superset.accounts) && superset.accounts.length) {
        // Build contexts from superset (no provider calls)
        contexts = superset.accounts
          .map((acc) => {
            const login = getLoginById(acc.loginId);
            if (!login) return null;
            const normalizedAccount = Object.assign({}, acc, {
              id: acc.id,
              number: acc.number,
              accountNumber: acc.number,
              loginId: login.id,
            });
            const accountWithOverrides = applyAccountSettingsOverrides(normalizedAccount, login);
            const effectiveAccount = Object.assign({}, accountWithOverrides, {
              id: acc.id,
              number: accountWithOverrides.number || acc.number,
            });
            return { login, account: effectiveAccount };
          })
          .filter(Boolean);
      } else {
        // Fallback: fetch from provider
        for (const login of allLogins) {
          let fetchedAccounts = [];
          try {
            fetchedAccounts = await fetchAccounts(login);
          } catch (error) {
            const message = error && error.message ? error.message : String(error);
            console.warn('Failed to fetch accounts for aggregate Total P&L:', message);
            hadAccountFetchFailure = true;
            continue;
          }
          fetchedAccounts.forEach((account, index) => {
            if (!account) {
              return;
            }
            const rawNumber =
              account.number != null
                ? account.number
                : account.accountNumber != null
                  ? account.accountNumber
                  : account.id != null
                    ? account.id
                    : index;
            const normalizedNumber = rawNumber != null ? String(rawNumber).trim() : String(index);
            const number = normalizedNumber || String(index);
            const compositeId = `${login.id}:${number}`;
            const normalizedAccount = Object.assign({}, account, {
              id: compositeId,
              number,
              accountNumber: number,
              loginId: login.id,
            });
            const accountWithOverrides = applyAccountSettingsOverrides(normalizedAccount, login);
            const effectiveAccount = Object.assign({}, accountWithOverrides, {
              id: compositeId,
              number: accountWithOverrides.number || number,
            });
            contexts.push({ login, account: effectiveAccount });
          });
        }
        if (!contexts.length) {
          return res.status(404).json({ message: 'No accounts available for aggregation' });
        }
      }

      const groupRelations = getAccountGroupRelations();
      const groupMetadata = getAccountGroupMetadata();
      const { accountGroupsById } = assignAccountGroups(
        contexts.map((context) => context.account),
        { groupRelations, groupMetadata }
      );

      let targetContexts = contexts;
      if (isGroupKey) {
        const groupEntry = accountGroupsById.get(rawAccountKey);
        if (!groupEntry || !groupEntry.accounts.length) {
          return res.status(404).json({ message: 'No accounts available for aggregation' });
        }
        const allowedIds = new Set(groupEntry.accounts.map((account) => account.id));
        targetContexts = contexts.filter((context) => allowedIds.has(context.account.id));
        if (!targetContexts.length) {
          return res.status(404).json({ message: 'No accounts available for aggregation' });
        }
      }

      // Per-account balances: reuse superset cache when available for symbol queries; otherwise fetch as before
      let perAccountCombinedBalances = {};
      if (symbolParam && superset && superset.perAccountCombinedBalances) {
        perAccountCombinedBalances = superset.perAccountCombinedBalances || {};
      } else {
        const aggregateOptionsForCache = { ...aggregateOptions };
        const cacheStatuses = targetContexts.map((context) => {
          const key = buildTotalPnlSeriesCacheKey(context.account.id, aggregateOptionsForCache);
          const hit = key ? getTotalPnlSeriesCacheEntry(key) : null;
          return { context, key, hit };
        });
        const missing = cacheStatuses.filter((e) => !e.hit).map((e) => e.context);
        if (missing.length > 0) {
          const balancesResults = await Promise.all(
            missing.map((context) => fetchBalances(context.login, context.account.number))
          );
          balancesResults.forEach((balancesRaw, index) => {
            const context = missing[index];
            if (!context) {
              return;
            }
            const summary = summarizeAccountBalances(balancesRaw) || balancesRaw;
            if (summary) {
              perAccountCombinedBalances[context.account.id] = summary;
            }
          });
        }
      }

      const aggregateKey = isGroupKey ? rawAccountKey : 'all';

      // Prefer using prewarmed activity contexts from the superset cache to avoid
      // additional provider API calls when computing symbol-specific series.
      const activityContextMap =
        superset && superset.activityContextsByAccountId && typeof superset.activityContextsByAccountId === 'object'
          ? superset.activityContextsByAccountId
          : null;
      const resolver = async (ctx) => {
        try {
          const key = ctx && ctx.account && ctx.account.id;
          if (!key || !activityContextMap) return null;
          return activityContextMap[key] || null;
        } catch (_) {
          return null;
        }
      };

      // Reuse superset-cached positions (from the last summary response) to avoid refetching
      let positionsByAccountIdForAgg = null;
      try {
        const superset = getSupersetCacheEntry();
        const flattened = superset && superset.payload && Array.isArray(superset.payload.flattenedPositions)
          ? superset.payload.flattenedPositions
          : null;
        if (flattened) {
          const map = {};
          flattened.forEach((p) => {
            if (!p || !p.accountId) return;
            if (!Array.isArray(map[p.accountId])) map[p.accountId] = [];
            map[p.accountId].push(p);
          });
          positionsByAccountIdForAgg = map;
        }
      } catch (_) {
        positionsByAccountIdForAgg = null;
      }

      const aggregateOptionsWithPositions = positionsByAccountIdForAgg
        ? { ...aggregateOptions, positionsByAccountId: positionsByAccountIdForAgg }
        : aggregateOptions;

      const aggregatedSeries = await computeAggregateTotalPnlSeriesForContexts(
        targetContexts,
        perAccountCombinedBalances,
        aggregateOptionsWithPositions,
        aggregateKey,
        hadAccountFetchFailure,
        resolver
      );
      if (!aggregatedSeries) {
        return res.status(503).json({ message: 'Total P&L series unavailable' });
      }

      if (cacheKey) {
        setTotalPnlSeriesCacheEntry(cacheKey, aggregatedSeries);
      }
      return res.json(aggregatedSeries);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error('Failed to compute aggregate total P&L series:', message);
      return res
        .status(500)
        .json({ message: 'Failed to compute total P&L series', details: message });
    }
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

    const accountWithOverrides = applyAccountSettingsOverrides(normalizedAccount, login);
    const effectiveAccount = Object.assign({}, accountWithOverrides, {
      id: accountId,
      number: accountWithOverrides.number || normalizedAccount.number || rawAccountKey,
    });

    let perAccountCombinedBalances = {};
    // For symbol series, reuse superset balances if available to avoid provider calls
    if (symbolParam) {
      const superset = getSupersetCacheEntry();
      if (superset && superset.perAccountCombinedBalances) {
        perAccountCombinedBalances = superset.perAccountCombinedBalances;
      }
    }
    if (!symbolParam) {
      const balancesRaw = await fetchBalances(login, effectiveAccount.number);
      const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
      perAccountCombinedBalances = { [accountId]: balanceSummary };
    }

    const options = {};
    if (queryOptions.startDate) {
      options.startDate = queryOptions.startDate;
    }
    if (queryOptions.endDate) {
      options.endDate = queryOptions.endDate;
    }
    if (queryOptions.applyAccountCagrStartDate === false) {
      options.applyAccountCagrStartDate = false;
    }

    let series = null;
    if (symbolParam) {
      // If the superset cache contains a prepared activity context for this account,
      // reuse it to avoid hitting provider APIs again while rendering the chart.
      const superset = getSupersetCacheEntry();
      const activityCtx =
        superset && superset.activityContextsByAccountId && typeof superset.activityContextsByAccountId === 'object'
          ? superset.activityContextsByAccountId[accountId]
          : null;
      const computedOptions = activityCtx ? { ...options, activityContext: activityCtx, symbol: symbolParam } : { ...options, symbol: symbolParam };
      series = await computeTotalPnlSeriesForSymbol(
        login,
        effectiveAccount,
        perAccountCombinedBalances,
        computedOptions
      );
    } else {
      series = await computeTotalPnlSeries(login, effectiveAccount, perAccountCombinedBalances, options);
    }
    if (!series) {
      return res.status(503).json({ message: 'Total P&L series unavailable' });
    }

    if (cacheKey) {
      setTotalPnlSeriesCacheEntry(cacheKey, series);
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

app.get('/api/pnl-breakdown/range', async function (req, res) {
  const scopeParam = typeof req.query.scope === 'string' && req.query.scope.trim() ? req.query.scope.trim() : 'all';
  const startKey = normalizeDateOnly(req.query.startDate);
  const endKey = normalizeDateOnly(req.query.endDate);
  if (!startKey || !endKey) {
    return res.status(400).json({ message: 'startDate and endDate are required (YYYY-MM-DD).' });
  }
  if (startKey > endKey) {
    return res.status(400).json({ message: 'startDate must be before endDate.' });
  }

  const cacheKey = buildRangeBreakdownCacheKey(scopeParam, startKey, endKey);
  if (cacheKey) {
    const cached = getRangeBreakdownCacheEntry(cacheKey);
    if (cached) {
      return res.json(Object.assign({}, cached, { cached: true }));
    }
  }

  const superset = getSupersetCacheEntry();
  if (!superset) {
    return res.status(409).json({ message: 'Summary data unavailable. Refresh and try again.' });
  }

  const normalizedSelection = normalizeSummaryRequestKey(scopeParam);
  const accountIds = resolveAccountIdsForSelection(superset, normalizedSelection);
  if (!accountIds.length) {
    return res.status(404).json({ message: 'Requested scope is unavailable.' });
  }
  const contexts = accountIds
    .map((accountId) => buildContextFromSupersetAccount(superset, accountId))
    .filter(Boolean);
  if (!contexts.length) {
    return res.status(404).json({ message: 'Accounts unavailable for requested scope.' });
  }

  const activityContextStore =
    (superset.activityContextsByAccountId && typeof superset.activityContextsByAccountId === 'object'
      ? superset.activityContextsByAccountId
      : (superset.activityContextsByAccountId = {}));

  const perAccountResults = [];
  let failureCount = 0;
  await mapWithConcurrency(
    contexts,
    Math.min(4, contexts.length),
    async function (context) {
      if (!context || !context.account || !context.account.id) {
        failureCount += 1;
        return;
      }
      const accountId = context.account.id;
      let activityContext = activityContextStore[accountId];
      if (!activityContext) {
        try {
          activityContext = await buildAccountActivityContext(context.login, context.account);
          if (activityContext) {
            activityContextStore[accountId] = activityContext;
          }
        } catch (activityError) {
          const message = activityError && activityError.message ? activityError.message : String(activityError);
          console.warn('Failed to prepare activity history for range breakdown account ' + accountId + ':', message);
          failureCount += 1;
          return;
        }
      }
      if (!activityContext) {
        failureCount += 1;
        return;
      }
      try {
        const breakdown = await computeTotalPnlBySymbol(context.login, context.account, {
          applyAccountCagrStartDate: false,
          displayStartKey: startKey,
          displayEndKey: endKey,
          activityContext,
        });
        if (breakdown) {
          perAccountResults.push({ accountId, breakdown });
        }
      } catch (breakdownError) {
        const message = breakdownError && breakdownError.message ? breakdownError.message : String(breakdownError);
        console.warn('Failed to compute range Total P&L for account ' + accountId + ':', message);
        failureCount += 1;
      }
    }
  );

  if (!perAccountResults.length) {
    const statusCode = failureCount ? 503 : 404;
    return res
      .status(statusCode)
      .json({ message: failureCount ? 'Unable to compute range breakdown.' : 'No Total P&L data available for range.' });
  }

  const perAccountPayload = {};
  perAccountResults.forEach(({ accountId, breakdown }) => {
    if (!accountId || !breakdown) {
      return;
    }
    perAccountPayload[accountId] = {
      entries: Array.isArray(breakdown.entries) ? breakdown.entries : [],
      entriesNoFx: Array.isArray(breakdown.entriesNoFx) ? breakdown.entriesNoFx : undefined,
      fxEffectCad: Number.isFinite(breakdown.fxEffectCad) ? breakdown.fxEffectCad : undefined,
      asOf: breakdown.endDate || endKey,
    };
  });

  const isAggregate = normalizedSelection.type !== 'account' && normalizedSelection.type !== 'default';
  let payload;
  if (isAggregate) {
    const aggregate = aggregateSymbolBreakdowns(perAccountResults.map((entry) => entry.breakdown));
    payload = {
      scope: scopeParam,
      startDate: startKey,
      endDate: endKey,
      accountCount: contexts.length,
      partial: failureCount > 0,
      entries: aggregate.entries || [],
      entriesNoFx: Array.isArray(aggregate.entriesNoFx) ? aggregate.entriesNoFx : undefined,
      fxEffectCad: Number.isFinite(aggregate.fxEffectCad) ? aggregate.fxEffectCad : undefined,
      asOf: aggregate.asOf || endKey,
      perAccount: perAccountPayload,
    };
  } else {
    const single = perAccountResults[0].breakdown || {};
    payload = {
      scope: scopeParam,
      startDate: startKey,
      endDate: endKey,
      accountCount: 1,
      partial: failureCount > 0,
      entries: Array.isArray(single.entries) ? single.entries : [],
      entriesNoFx: Array.isArray(single.entriesNoFx) ? single.entriesNoFx : undefined,
      fxEffectCad: Number.isFinite(single.fxEffectCad) ? single.fxEffectCad : undefined,
      asOf: single.endDate || endKey,
      perAccount: perAccountPayload,
    };
  }

  if (cacheKey) {
    setRangeBreakdownCacheEntry(cacheKey, payload);
  }

  res.json(payload);
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

module.exports = {
  app,
  computeTotalPnlSeries,
  computeTotalPnlBySymbol,
  computeNetDeposits,
  computeNetDepositsCore,
  buildAccountActivityContext,
  resolveAccountActivityContext,
  filterFundingActivities,
  dedupeActivities,
  resolveActivityTimestamp,
  resolveActivityAmountDetails,
  convertAmountToCad,
  resolveUsdToCadRate,
  buildDailyPriceSeries,
  computeLedgerEquitySnapshot,
  __setBookValueTransferPriceFetcher: setBookValueTransferPriceFetcher,
  fetchAccounts,
  fetchBalances,
  fetchPositions,
  fetchOrders,
  summarizeAccountBalances,
  getAllLogins,
  getLoginById,
  applyAccountSettingsOverrides,
};
