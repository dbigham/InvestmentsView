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
const { getProxyForUrl } = require('proxy-from-env');
require('dotenv').config();
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
  extractSymbolSettingsFromOverride,
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
const DEBUG_QUESTRADE_API = process.env.DEBUG_QUESTRADE_API === 'true';
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
const OPENAI_NEWS_MODEL = process.env.OPENAI_NEWS_MODEL || 'gpt-5.0';
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

function resolveYahooSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }
  const trimmed = symbol.trim();
  if (!trimmed) {
    return null;
  }
  let normalized = trimmed;
  if (/\.U\./i.test(normalized)) {
    normalized = normalized.replace(/\.U\./gi, '-U.');
  }
  return normalized;
}

async function fetchYahooHistorical(symbol, queryOptions) {
  const finance = ensureYahooFinanceClient();
  const yahooSymbol = resolveYahooSymbol(symbol);
  if (!yahooSymbol) {
    return null;
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
  const { dispatcher } = getDispatcherForUrl(YAHOO_QUOTE_BASE_URL, { reuse: true });
  return finance.quote(yahooSymbol, undefined, {
    fetchOptions: { dispatcher },
  });
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
        if (typeof contentEntry.output_text === 'string' && contentEntry.output_text.trim()) {
          return contentEntry.output_text;
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
  let response;
  try {
    response = await client.responses.create({
      model: OPENAI_NEWS_MODEL,
      temperature: 0.3,
      max_output_tokens: 1100,
      tools: [{ type: 'web_search' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
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
                  required: ['title', 'url'],
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' },
                    summary: { type: 'string' },
                    source: { type: 'string' },
                    published_at: { type: 'string' },
                    publishedAt: { type: 'string' },
                  },
                },
              },
              disclaimer: { type: 'string' },
            },
            required: ['articles'],
          },
        },
      },
      instructions:
        'You are a portfolio research assistant. Use the web_search tool when helpful to gather the most recent, reputable news articles or posts about the provided securities. Respond with concise JSON summaries.',
      input: [
        `Account label: ${trimmedLabel || 'Portfolio'}`,
        `Stock symbols: ${symbols.join(', ')}`,
        'Task: Find up to eight relevant and timely news articles or notable posts published within the past 14 days that mention these tickers. Prioritize reputable financial publications, company announcements, and influential analysis.',
        'For each article provide the title, a direct URL, the publisher/source when available, the publication date (ISO 8601 preferred), and a concise summary under 60 words.',
      ].join('\n'),
    });
  } catch (error) {
    if (error && typeof error === 'object') {
      const status = error.status || error.code;
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
    throw error instanceof Error ? error : new Error(String(error));
  }

  const outputText = extractOpenAiResponseText(response);
  if (!outputText) {
    throw new Error('OpenAI response did not contain any text output');
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (parseError) {
    const error = new Error('Failed to parse OpenAI news response as JSON');
    error.cause = parseError instanceof Error ? parseError : new Error(String(parseError));
    throw error;
  }

  const rawArticles = Array.isArray(parsed.articles) ? parsed.articles : [];
  const articles = rawArticles.map(normalizeNewsArticle).filter(Boolean);
  const disclaimer = typeof parsed.disclaimer === 'string' ? parsed.disclaimer.trim() : '';

  return {
    articles,
    disclaimer: disclaimer || null,
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

  const {
    symbolSettings: resolvedSymbolSettings,
    targetProportions: resolvedTargetProportions,
    symbolNotes: resolvedSymbolNotes,
  } = extractSymbolSettingsFromOverride(override);

  if (resolvedSymbolSettings) {
    target.symbolSettings = resolvedSymbolSettings;
  } else if (Object.prototype.hasOwnProperty.call(target, 'symbolSettings')) {
    delete target.symbolSettings;
  }
  if (resolvedTargetProportions) {
    target.targetProportions = resolvedTargetProportions;
  } else if (Object.prototype.hasOwnProperty.call(target, 'targetProportions')) {
    delete target.targetProportions;
  }
  if (resolvedSymbolNotes) {
    target.symbolNotes = resolvedSymbolNotes;
  } else if (Object.prototype.hasOwnProperty.call(target, 'symbolNotes')) {
    delete target.symbolNotes;
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

  console.log('[Questrade][refresh] Starting refresh for login', resolveLoginDisplay(login), {
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

      console.log('[Questrade][refresh]', {
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
        });
      } catch (error) {
        console.error('[Questrade][refresh] Network error during refresh', {
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
          console.warn('[Questrade][refresh] Failed to parse JSON response', {
            message: parseError.message,
          });
        }
      }

      const status = rawResponse.statusCode;
      const setCookieHeader = headersObject['set-cookie'];
      const inboundCookieNames = summarizeCookieHeader(setCookieHeader);

      console.log('[Questrade][refresh]', {
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
          console.warn('[Questrade][refresh] Failed to persist response cookie', {
            message: cookieError.message,
          });
        }
      }

      if (status >= 300 && status < 400 && headersObject.location) {
        const nextUrl = new URL(headersObject.location, requestUrl).toString();
        console.log('[Questrade][refresh]', {
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
        console.warn('[Questrade][refresh] Failed to close dispatcher', { message: closeError.message });
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

  console.log('[Questrade][refresh] Completed refresh for login', resolveLoginDisplay(login), {
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
      console.log('[Questrade][token-cache] Using cached access token for login', resolveLoginDisplay(login), {
        acquiredAt: new Date(cached.acquiredAt).toISOString(),
        expiresIn: cached.expiresIn,
        apiServer: cached.apiServer,
      });
    }
    return cached;
  }
  if (DEBUG_QUESTRADE_API) {
    console.log('[Questrade][token-cache] Cache miss for login', resolveLoginDisplay(login));
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

    let rawResponse;
    try {
      rawResponse = await undiciRequest(currentUrl, {
        method,
        headers,
        body,
        dispatcher,
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
const MAX_ORDER_HISTORY_PAGES = 5;

async function fetchOrders(login, accountId, options = {}) {
  const now = new Date();
  const startTime =
    typeof options.startTime === 'string' && options.startTime
      ? options.startTime
      : new Date(now.getTime() - RECENT_ORDERS_LOOKBACK_DAYS * DAY_IN_MS).toISOString();
  const endTime =
    typeof options.endTime === 'string' && options.endTime ? options.endTime : now.toISOString();
  const stateFilter = typeof options.stateFilter === 'string' && options.stateFilter ? options.stateFilter : 'All';

  const params = { stateFilter, startTime, endTime };
  let path = '/v1/accounts/' + accountId + '/orders';
  let requestOptions = { params };
  const orders = [];
  let page = 0;

  while (path && page < MAX_ORDER_HISTORY_PAGES) {
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
  return normalizeQuestradeCandles(candles);
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

  let history = null;
  try {
    history = await fetchYahooHistorical(symbol, {
      period1: startDate,
      period2: exclusiveEnd,
      interval: '1d',
    });
  } catch (error) {
    history = null;
  }

  let normalized = normalizeYahooHistoricalEntries(history);

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
    ignoreAccountAdjustments:
      options && Object.prototype.hasOwnProperty.call(options, 'ignoreAccountAdjustments')
        ? !!options.ignoreAccountAdjustments
        : false,
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
    const resolvedSymbol = resolveActivitySymbol(activity);
    processedActivities.push({ activity, timestamp, dateKey, symbol: resolvedSymbol || null });

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
  if (canFetchPositions && accountNumber) {
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
  if (closingHoldings.size || closingCashByCurrency.size) {
    seededHoldings = closingHoldings.size ? new Map(closingHoldings) : new Map();
    seededCash = closingCashByCurrency.size ? new Map(closingCashByCurrency) : new Map();
    if (processedActivities.length) {
      const endTimestamp = endDate instanceof Date && !Number.isNaN(endDate.getTime()) ? endDate.getTime() + DAY_IN_MS : null;
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
  }

  let symbolDetails = {};
  if (symbolIds.size > 0) {
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
  const targetStartPnl = Number.isFinite(rawFirstPnl) ? rawFirstPnl : 0;
  const targetEndPnlCandidate =
    netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.allTimeCad)
      ? netDepositsSummary.totalPnl.allTimeCad
      : netDepositsSummary.totalPnl && Number.isFinite(netDepositsSummary.totalPnl.combinedCad)
        ? netDepositsSummary.totalPnl.combinedCad
        : null;

  if (
    applyCagrStart &&
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
  const displayStartTotals = displayStartPoint
    ? {
        totalPnlCad: Number.isFinite(displayStartPoint.totalPnlCad) ? displayStartPoint.totalPnlCad : null,
        equityCad: Number.isFinite(displayStartPoint.equityCad) ? displayStartPoint.equityCad : null,
        cumulativeNetDepositsCad: Number.isFinite(displayStartPoint.cumulativeNetDepositsCad)
          ? displayStartPoint.cumulativeNetDepositsCad
          : null,
      }
    : null;

  let baselineTotals = null;
  if (normalizedPoints.length) {
    baselineTotals = {
      equityCad:
        displayStartTotals && Number.isFinite(displayStartTotals.equityCad)
          ? displayStartTotals.equityCad
          : Number.isFinite(rawFirstPointTotals.equityCad)
            ? rawFirstPointTotals.equityCad
            : null,
      cumulativeNetDepositsCad:
        displayStartTotals && Number.isFinite(displayStartTotals.cumulativeNetDepositsCad)
          ? displayStartTotals.cumulativeNetDepositsCad
          : Number.isFinite(rawFirstPointTotals.cumulativeNetDepositsCad)
            ? rawFirstPointTotals.cumulativeNetDepositsCad
            : null,
      totalPnlCad:
        displayStartTotals && Number.isFinite(displayStartTotals.totalPnlCad)
          ? displayStartTotals.totalPnlCad
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

  let summaryEquitySinceDisplayStart = null;
  const baselineEquityForSummary =
    baselineTotals && Number.isFinite(baselineTotals.equityCad)
      ? baselineTotals.equityCad
      : Number.isFinite(rawFirstPointTotals.equityCad)
        ? rawFirstPointTotals.equityCad
        : null;
  if (Number.isFinite(summaryEquity) && baselineEquityForSummary !== null) {
    const deltaEquity = summaryEquity - baselineEquityForSummary;
    summaryEquitySinceDisplayStart = Math.abs(deltaEquity) < CASH_FLOW_EPSILON ? 0 : deltaEquity;
  }

  const effectivePeriodStart = normalizedPoints.length ? normalizedPoints[0].date : dateKeys[0];
  const effectivePeriodEnd = normalizedPoints.length
    ? normalizedPoints[normalizedPoints.length - 1].date
    : dateKeys[dateKeys.length - 1];

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
      if (targetProportion === null && accountInfo.targetProportions && typeof accountInfo.targetProportions === 'object') {
        const candidate = accountInfo.targetProportions[symbolKey];
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) {
          targetProportion = numeric;
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
      status: normalizeString(order?.state) || null,
      action: normalizeString(order?.side) || null,
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
      creationTime: normalizeString(order?.creationTime) || normalizeString(order?.createdTime) || null,
      updateTime: normalizeString(order?.updateTime) || normalizeString(order?.updatedTime) || null,
      gtdDate: normalizeString(order?.gtdDate) || null,
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

  let openAi;
  try {
    openAi = ensureOpenAiClient();
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to initialize OpenAI client';
    console.error('Failed to initialize OpenAI client for portfolio news:', message);
    return res.status(500).json({ message: 'Failed to initialize portfolio news client', details: message });
  }

  if (!openAi) {
    return res
      .status(503)
      .json({ message: 'Portfolio news is unavailable: OpenAI API key not configured' });
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
      return res
        .status(503)
        .json({ message: 'Portfolio news is unavailable', details: error.message });
    }
    if (error && error.code === 'OPENAI_RATE_LIMIT') {
      return res
        .status(503)
        .json({ message: 'Portfolio news temporarily unavailable', details: error.message });
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
    return res.json(cached);
  }

  try {
    const quote = await fetchYahooQuote(trimmedSymbol || normalizedSymbol);
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
      targetProportions: result.targetProportions,
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
    const orderWindowEnd = new Date();
    const orderWindowStart = new Date(orderWindowEnd.getTime() - RECENT_ORDERS_LOOKBACK_DAYS * DAY_IN_MS);
    const orderWindowStartIso = orderWindowStart.toISOString();
    const orderWindowEndIso = orderWindowEnd.toISOString();
    const ordersPromise = Promise.all(
      selectedContexts.map(async function (context) {
        try {
          return await fetchOrders(context.login, context.account.number, {
            startTime: orderWindowStartIso,
            endTime: orderWindowEndIso,
            stateFilter: 'All',
          });
        } catch (ordersError) {
          const message = ordersError && ordersError.message ? ordersError.message : String(ordersError);
          console.warn(
            'Failed to fetch orders for account ' + context.account.id + ':',
            message
          );
          return [];
        }
      })
    );

    const [positionsResults, balancesResults, ordersResults] = await Promise.all([
      positionsPromise,
      balancesPromise,
      ordersPromise,
    ]);
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
    const flattenedOrders = ordersResults
      .map(function (orders, index) {
        const context = selectedContexts[index];
        if (!Array.isArray(orders)) {
          return [];
        }
        return orders.map(function (order) {
          return Object.assign({}, order, {
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
    flattenedOrders.forEach(function (order) {
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

    const decoratedPositions = decoratePositions(flattenedPositions, symbolsMap, accountsMap);
    const decoratedOrders = decorateOrders(flattenedOrders, symbolsMap, accountsMap);
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
        if (
          fundingSummary.annualizedReturnAllTime &&
          fundingSummary.annualizedReturnAllTime.incomplete
        ) {
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
      const symbolSettings =
        account.symbolSettings && typeof account.symbolSettings === 'object' && !Array.isArray(account.symbolSettings)
          ? account.symbolSettings
          : null;

      let targetProportionMap = null;
      let symbolNotesMap = null;

      if (symbolSettings) {
        Object.entries(symbolSettings).forEach(([symbol, entry]) => {
          const trimmedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : null;
          if (!trimmedSymbol) {
            return;
          }
          if (entry && typeof entry === 'object') {
            if (Object.prototype.hasOwnProperty.call(entry, 'targetProportion')) {
              const numeric = Number(entry.targetProportion);
              if (Number.isFinite(numeric)) {
                if (!targetProportionMap) {
                  targetProportionMap = {};
                }
                targetProportionMap[trimmedSymbol] = numeric;
              }
            }
            if (Object.prototype.hasOwnProperty.call(entry, 'notes')) {
              const note = typeof entry.notes === 'string' ? entry.notes.trim() : '';
              if (note) {
                if (!symbolNotesMap) {
                  symbolNotesMap = {};
                }
                symbolNotesMap[trimmedSymbol] = note;
              }
            }
          }
        });
      }

      if (!targetProportionMap && account.targetProportions && typeof account.targetProportions === 'object') {
        const source = account.targetProportions;
        if (Object.keys(source).length) {
          targetProportionMap = Object.entries(source).reduce((acc, [symbol, percent]) => {
            const trimmedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : null;
            if (trimmedSymbol) {
              const numeric = Number(percent);
              if (Number.isFinite(numeric)) {
                acc[trimmedSymbol] = numeric;
              }
            }
            return acc;
          }, {});
          if (Object.keys(targetProportionMap).length === 0) {
            targetProportionMap = null;
          }
        }
      }

      if (!symbolNotesMap && account.symbolNotes && typeof account.symbolNotes === 'object') {
        const entries = Object.entries(account.symbolNotes).reduce((acc, [symbol, note]) => {
          const trimmedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : null;
          const normalizedNote = typeof note === 'string' ? note.trim() : '';
          if (trimmedSymbol && normalizedNote) {
            acc[trimmedSymbol] = normalizedNote;
          }
          return acc;
        }, {});
        if (Object.keys(entries).length) {
          symbolNotesMap = entries;
        }
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
        targetProportions: targetProportionMap,
        symbolNotes: symbolNotesMap,
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
      orders: decoratedOrders,
      ordersWindow: { start: orderWindowStartIso, end: orderWindowEndIso },
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

  const normalizedKey = rawAccountKey.toLowerCase();
  if (normalizedKey === 'all') {
    try {
      const aggregateOptions = {};
      if (typeof req.query.startDate === 'string' && req.query.startDate.trim()) {
        aggregateOptions.startDate = req.query.startDate.trim();
      }
      if (typeof req.query.endDate === 'string' && req.query.endDate.trim()) {
        aggregateOptions.endDate = req.query.endDate.trim();
      }
      aggregateOptions.applyAccountCagrStartDate = false;

      const contexts = [];
      let hadAccountFetchFailure = false;
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

      const balancesResults = await Promise.all(
        contexts.map((context) => fetchBalances(context.login, context.account.number))
      );
      const perAccountCombinedBalances = {};
      balancesResults.forEach((balancesRaw, index) => {
        const context = contexts[index];
        if (!context) {
          return;
        }
        const summary = summarizeAccountBalances(balancesRaw) || balancesRaw;
        if (summary) {
          perAccountCombinedBalances[context.account.id] = summary;
        }
      });

      const seriesResults = await mapWithConcurrency(
        contexts,
        MAX_AGGREGATE_FUNDING_CONCURRENCY,
        async function (context) {
          try {
            const series = await computeTotalPnlSeries(
              context.login,
              context.account,
              perAccountCombinedBalances,
              aggregateOptions
            );
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
        return res.status(503).json({ message: 'Total P&L series unavailable' });
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
      };
      const summaryCounts = {
        totalPnlCad: 0,
        totalPnlAllTimeCad: 0,
        netDepositsCad: 0,
        netDepositsAllTimeCad: 0,
        totalEquityCad: 0,
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
        }
      });

      if (successfulSeries.length !== contexts.length || hadAccountFetchFailure) {
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
          };
        })
        .filter((point) => point && Number.isFinite(point.totalPnlCad));

      if (!combinedPoints.length) {
        return res.status(503).json({ message: 'Total P&L series unavailable' });
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
      };

      const payload = {
        accountId: 'all',
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

      return res.json(payload);
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

    const balancesRaw = await fetchBalances(login, effectiveAccount.number);
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

    const series = await computeTotalPnlSeries(login, effectiveAccount, perAccountCombinedBalances, options);
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

module.exports = {
  app,
  computeTotalPnlSeries,
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
