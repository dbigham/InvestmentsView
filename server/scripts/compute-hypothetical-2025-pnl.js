#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  fetchPositions,
  buildAccountActivityContext,
  resolveUsdToCadRate,
} = require('../src/index.js');

const DEFAULT_START_DATE = '2025-01-01';
const DEFAULT_INVESTMENT = 890000;
const DEFAULT_TARGET_ACCOUNT_NAME = 'The Long Invest December 2025';

const PRICE_CACHE_DIR = path.join(__dirname, '..', '.cache', 'prices');
const YAHOO_SYMBOL_ALIASES = new Map([
  ['cbit.vn', 'CBIT.V'],
]);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(digits);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const pct = value * 100;
  const prefix = pct >= 0 ? '+' : '';
  return `${prefix}${pct.toFixed(2)}%`;
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}`;
}

function getDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseDateKey(dateValue) {
  if (!dateValue || typeof dateValue !== 'string') {
    return null;
  }
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return getDateKey(parsed);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadPriceSeries(symbol) {
  if (!symbol) {
    return null;
  }
  const filePath = path.join(PRICE_CACHE_DIR, `${symbol}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const payload = readJson(filePath);
  if (!payload || !Array.isArray(payload.points) || payload.points.length === 0) {
    return null;
  }
  return payload;
}

function resolveYahooSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }
  const trimmed = symbol.trim();
  if (!trimmed) {
    return null;
  }
  let normalized = trimmed;
  const alias = YAHOO_SYMBOL_ALIASES.get(normalized.toLowerCase());
  if (alias) {
    normalized = alias;
  }
  if (/\.U\./i.test(normalized)) {
    normalized = normalized.replace(/\.U\./gi, '-U.');
  }
  if (/\.[A-Z]\.TO$/i.test(normalized)) {
    normalized = normalized.replace(/\.([A-Z])\.TO$/i, '-$1.TO');
  }
  if (/\.[A-Z]\.V$/i.test(normalized)) {
    normalized = normalized.replace(/\.([A-Z])\.V$/i, '-$1.V');
  }
  if (/\.VN$/i.test(normalized)) {
    normalized = normalized.replace(/\.VN$/i, '.TO');
  }
  return normalized;
}

function inferCurrencyFromSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return 'USD';
  }
  const upper = symbol.toUpperCase();
  if (upper.endsWith('.TO') || upper.endsWith('.V') || upper.endsWith('.VN') || upper.endsWith('.NE')) {
    return 'CAD';
  }
  return 'USD';
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

async function ensurePriceSeries(symbol, startKey, endKey) {
  const cached = loadPriceSeries(symbol);
  if (cached) {
    return cached;
  }
  const yahooSymbol = resolveYahooSymbol(symbol);
  if (!yahooSymbol) {
    return null;
  }
  const startDate = new Date(`${startKey}T00:00:00Z`);
  const endDate = new Date(`${endKey}T00:00:00Z`);
  const endExclusive = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
  let history = null;
  try {
    history = await yahooFinance.historical(yahooSymbol, {
      period1: startDate,
      period2: endExclusive,
      interval: '1d',
    });
  } catch (_) {
    history = null;
  }
  const normalized = normalizeYahooHistoricalEntries(history);
  if (!normalized.length) {
    return null;
  }
  const points = normalized.map((entry) => ({
    date: getDateKey(entry.date),
    price: entry.price,
  }));
  const payload = {
    symbol,
    currency: inferCurrencyFromSymbol(symbol),
    points,
  };
  try {
    fs.writeFileSync(path.join(PRICE_CACHE_DIR, `${symbol}.json`), JSON.stringify(payload));
  } catch (_) {
    // ignore cache write errors
  }
  return payload;
}

function findPointOnOrAfter(points, startKey) {
  if (!startKey) {
    return null;
  }
  for (const point of points) {
    if (point && point.date >= startKey && Number.isFinite(point.price) && point.price > 0) {
      return point;
    }
  }
  return null;
}

function findPointOnOrBefore(points, endKey) {
  if (!endKey) {
    return null;
  }
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (point && point.date <= endKey && Number.isFinite(point.price) && point.price > 0) {
      return point;
    }
  }
  return null;
}

function extractQuantity(position) {
  const candidates = [position.openQuantity, position.quantity, position.openQty, position.qty];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value !== 0) {
      return value;
    }
  }
  return 0;
}

function buildHoldingsMapFromPositions(positions) {
  const map = new Map();
  if (!Array.isArray(positions)) {
    return map;
  }
  positions.forEach((position) => {
    if (!position || !position.symbol) {
      return;
    }
    const quantity = extractQuantity(position);
    if (!Number.isFinite(quantity) || quantity === 0) {
      return;
    }
    map.set(position.symbol, (map.get(position.symbol) || 0) + quantity);
  });
  return map;
}

function applyTradeAdjustments(holdings, activities, todayKey) {
  if (!holdings || !activities || !todayKey) {
    return;
  }
  activities.forEach((activity) => {
    if (!activity || !activity.symbol) {
      return;
    }
    const dateKey = parseDateKey(activity.tradeDate || activity.transactionDate || activity.settlementDate);
    if (!dateKey || dateKey !== todayKey) {
      return;
    }
    const action = String(activity.action || '').toLowerCase();
    const type = String(activity.type || '').toLowerCase();
    if (type && type !== 'trades') {
      return;
    }
    const rawQty = Number(activity.quantity);
    if (!Number.isFinite(rawQty) || rawQty === 0) {
      return;
    }
    let delta = 0;
    if (action.includes('buy')) {
      delta = -Math.abs(rawQty);
    } else if (action.includes('sell')) {
      delta = Math.abs(rawQty);
    } else {
      return;
    }
    const next = (holdings.get(activity.symbol) || 0) + delta;
    holdings.set(activity.symbol, next);
  });
}

async function buildAggregatedHoldings(targetAccountNumber, todayKey) {
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available.');
  }

  const aggregate = new Map();
  const targetAdjustments = [];

  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    const accounts = await fetchAccounts(login);

    for (const account of accounts) {
      const accountNumber = String(account.number || account.accountNumber || account.id || '').trim();
      if (!accountNumber) {
        continue;
      }
      const normalizedAccount = Object.assign({}, account, {
        id: accountNumber,
        number: accountNumber,
      });

      const positions = await fetchPositions(login, accountNumber);
      const holdings = buildHoldingsMapFromPositions(positions);

      if (targetAccountNumber && accountNumber === targetAccountNumber) {
        const activityContext = await buildAccountActivityContext(login, normalizedAccount);
        if (activityContext && Array.isArray(activityContext.activities)) {
          applyTradeAdjustments(holdings, activityContext.activities, todayKey);
          targetAdjustments.push({ accountNumber, adjusted: true, activities: activityContext.activities.length });
        } else {
          targetAdjustments.push({ accountNumber, adjusted: false, activities: 0 });
        }
      }

      for (const [symbol, quantity] of holdings.entries()) {
        if (!Number.isFinite(quantity) || quantity === 0) {
          continue;
        }
        aggregate.set(symbol, (aggregate.get(symbol) || 0) + quantity);
      }
    }
  }

  return { holdings: aggregate, targetAdjustments };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startDate = typeof options.start === 'string' ? options.start : DEFAULT_START_DATE;
  const investment = Number.isFinite(Number(options.investment)) ? Number(options.investment) : DEFAULT_INVESTMENT;
  const targetAccountName = typeof options.account === 'string' ? options.account : DEFAULT_TARGET_ACCOUNT_NAME;

  const accountsConfigPath = path.join(__dirname, '..', 'accounts.json');
  const accountsConfig = readJson(accountsConfigPath) || {};
  const configuredAccounts = Array.isArray(accountsConfig.accounts) ? accountsConfig.accounts : [];
  const targetAccount = configuredAccounts.find((entry) => entry && entry.name === targetAccountName);
  const targetAccountNumber = targetAccount && targetAccount.number ? String(targetAccount.number) : null;

  const todayKey = getDateKey(new Date());
  const { holdings, targetAdjustments } = await buildAggregatedHoldings(targetAccountNumber, todayKey);

  const holdingsEntries = Array.from(holdings.entries())
    .map(([symbol, quantity]) => ({ symbol, quantity }))
    .filter((entry) => Number.isFinite(entry.quantity) && entry.quantity !== 0)
    .sort((a, b) => Math.abs(b.quantity) - Math.abs(a.quantity));

  if (!holdingsEntries.length) {
    console.log('No holdings detected.');
    return;
  }

  const fxCache = new Map();
  async function getUsdCadRate(dateKey) {
    if (!dateKey) {
      return null;
    }
    if (fxCache.has(dateKey)) {
      return fxCache.get(dateKey);
    }
    const date = new Date(`${dateKey}T12:00:00Z`);
    const rate = await resolveUsdToCadRate(date, 'hypothetical');
    fxCache.set(dateKey, rate);
    return rate;
  }

  const missingPrices = [];
  const breakdown = [];
  let totalEndValueCad = 0;

  for (const entry of holdingsEntries) {
    const priceSeries = await ensurePriceSeries(entry.symbol, startDate, todayKey);
    if (!priceSeries) {
      missingPrices.push(entry.symbol);
      continue;
    }
    const points = priceSeries.points || [];
    if (!points.length) {
      missingPrices.push(entry.symbol);
      continue;
    }
    const startPoint = findPointOnOrAfter(points, startDate);
    const endPoint = findPointOnOrBefore(points, todayKey) || points[points.length - 1];
    if (!startPoint || !endPoint) {
      missingPrices.push(entry.symbol);
      continue;
    }
    const currency = priceSeries.currency || 'USD';
    let fxStart = 1;
    let fxEnd = 1;
    if (currency === 'USD') {
      fxStart = await getUsdCadRate(startPoint.date);
      fxEnd = await getUsdCadRate(endPoint.date);
    }
    if ((currency === 'USD') && (!Number.isFinite(fxStart) || !Number.isFinite(fxEnd))) {
      missingPrices.push(entry.symbol);
      continue;
    }

    const startCad = startPoint.price * fxStart;
    const endCad = endPoint.price * fxEnd;
    const returnRate = startCad > 0 ? endCad / startCad - 1 : null;
    if (!Number.isFinite(returnRate)) {
      missingPrices.push(entry.symbol);
      continue;
    }

    const endValueCad = entry.quantity * endCad;
    breakdown.push({
      symbol: entry.symbol,
      quantity: entry.quantity,
      currency,
      startDate: startPoint.date,
      endDate: endPoint.date,
      startPrice: startPoint.price,
      endPrice: endPoint.price,
      fxStart,
      fxEnd,
      endValueCad,
      returnRate,
    });
    totalEndValueCad += endValueCad;
  }

  const validBreakdown = breakdown.filter((entry) => Number.isFinite(entry.endValueCad));
  if (!validBreakdown.length || !Number.isFinite(totalEndValueCad) || totalEndValueCad === 0) {
    console.log('Unable to compute returns (missing price series).');
    if (missingPrices.length) {
      console.log('Missing price series for:', missingPrices.sort().join(', '));
    }
    return;
  }

  let portfolioReturn = 0;
  validBreakdown.forEach((entry) => {
    const weight = entry.endValueCad / totalEndValueCad;
    entry.weight = weight;
    entry.weightedReturn = weight * entry.returnRate;
    portfolioReturn += entry.weightedReturn;
  });

  const pnlCad = investment * portfolioReturn;

  const sortedByContribution = validBreakdown
    .map((entry) => ({
      ...entry,
      contributionCad: investment * entry.weightedReturn,
    }))
    .sort((a, b) => Math.abs(b.contributionCad) - Math.abs(a.contributionCad));

  console.log('Hypothetical portfolio return based on current holdings');
  console.log('Start date           :', startDate);
  console.log('End date             :', todayKey);
  console.log('Holdings covered     :', validBreakdown.length);
  console.log('Total end value (CAD):', formatNumber(totalEndValueCad));
  console.log('Portfolio return     :', formatPercent(portfolioReturn));
  console.log('Investment amount    :', formatNumber(investment));
  console.log('Hypothetical P&L CAD  :', formatCurrency(pnlCad));
  console.log('');

  if (targetAccountNumber) {
    console.log('Target account adjustments:', targetAccountNumber, targetAccountName);
    if (targetAdjustments.length) {
      targetAdjustments.forEach((entry) => {
        console.log(`  - ${entry.accountNumber}: adjusted=${entry.adjusted} activities=${entry.activities}`);
      });
    } else {
      console.log('  - none');
    }
    console.log('');
  }

  console.log('Top symbol contributions (CAD):');
  sortedByContribution.slice(0, 15).forEach((entry) => {
    console.log(
      `${entry.symbol.padEnd(10)} | weight ${formatPercent(entry.weight).padStart(8)} | return ${formatPercent(entry.returnRate).padStart(8)} | contrib ${formatCurrency(entry.contributionCad).padStart(10)}`
    );
  });

  if (missingPrices.length) {
    console.log('');
    console.log('Missing price series for:', missingPrices.sort().join(', '));
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
