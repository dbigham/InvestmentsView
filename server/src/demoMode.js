const fs = require('fs');
const path = require('path');

const DEMO_DIR = path.join(__dirname, '..', 'demo');
const FIXTURE_CACHE = new Map();

function parseBoolean(value, defaultValue = false) {
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

const DEMO_ENV_ENABLED = parseBoolean(process.env.INVESTMENTSVIEW_DEMO, false);

function readFixture(name) {
  if (FIXTURE_CACHE.has(name)) {
    return FIXTURE_CACHE.get(name);
  }
  const filePath = path.join(DEMO_DIR, name);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  FIXTURE_CACHE.set(name, parsed);
  return parsed;
}

function clone(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function isDemoRequest(req) {
  if (DEMO_ENV_ENABLED) {
    return true;
  }
  const header = req.get('x-investmentsview-demo');
  if (parseBoolean(header, false)) {
    return true;
  }
  const query = req?.query || {};
  if (parseBoolean(query.demo, false) || parseBoolean(query.demoMode, false)) {
    return true;
  }
  return false;
}

function respondDemo(res, payload) {
  res.set('x-investmentsview-demo', '1');
  res.json(payload);
}

function getSummaryPayload(source) {
  const payload = clone(readFixture('summary.demo.json'));
  payload.demoMode = true;
  if (source) {
    payload.demoModeSource = source;
  }
  return payload;
}

function getQuotePayload(symbol) {
  const key = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  const quotes = readFixture('quotes.demo.json');
  if (key && quotes && quotes[key]) {
    return clone(quotes[key]);
  }
  return {
    symbol: key || 'UNKNOWN',
    name: key || 'Unknown',
    currency: 'USD',
    price: 0,
    changePercent: 0,
    marketCap: null,
    peRatio: null,
    pegRatio: null,
    dividendYieldPercent: null,
  };
}

function getPriceHistoryPayload(symbol) {
  const key = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  const history = readFixture('symbol-price-history.demo.json');
  if (key && history && history[key]) {
    return clone(history[key]);
  }
  return {
    symbol: key || 'UNKNOWN',
    startDate: '2024-01-01',
    endDate: '2025-12-31',
    points: [],
  };
}

function getTotalPnlSeriesPayload(accountKey, applyCagr) {
  const summary = readFixture('summary.demo.json');
  const seriesMap = summary && summary.accountTotalPnlSeries ? summary.accountTotalPnlSeries : {};
  const entry = seriesMap[accountKey] || seriesMap.all;
  if (!entry) {
    return {
      accountId: accountKey,
      points: [],
      summary: {},
    };
  }
  if (applyCagr && entry.cagr) {
    return clone(entry.cagr);
  }
  if (entry.all) {
    return clone(entry.all);
  }
  return clone(entry);
}

function demoMiddleware(req, res, next) {
  if (!isDemoRequest(req)) {
    return next();
  }

  const method = req.method ? req.method.toUpperCase() : 'GET';
  const pathName = req.path || '/';
  const segments = pathName.split('/').filter(Boolean);
  const source = DEMO_ENV_ENABLED ? 'env' : 'request';

  if (method === 'GET' && pathName === '/summary') {
    return respondDemo(res, getSummaryPayload(source));
  }
  if (method === 'GET' && pathName === '/qqq-temperature') {
    return respondDemo(res, clone(readFixture('qqq-temperature.demo.json')));
  }
  if (method === 'GET' && pathName === '/investment-model-temperature') {
    return respondDemo(res, clone(readFixture('investment-model-temperature.demo.json')));
  }
  if (method === 'GET' && pathName === '/benchmark-returns') {
    const payload = clone(readFixture('benchmark-returns.demo.json'));
    if (typeof req.query.startDate === 'string' && req.query.startDate.trim()) {
      payload.startDate = req.query.startDate.trim();
    }
    if (typeof req.query.endDate === 'string' && req.query.endDate.trim()) {
      payload.endDate = req.query.endDate.trim();
    }
    return respondDemo(res, payload);
  }
  if (method === 'GET' && pathName === '/quote') {
    const symbol = req.query && typeof req.query.symbol === 'string' ? req.query.symbol : '';
    return respondDemo(res, getQuotePayload(symbol));
  }
  if (method === 'GET' && segments[0] === 'symbols' && segments[2] === 'price-history') {
    const symbol = decodeURIComponent(segments[1] || '');
    return respondDemo(res, getPriceHistoryPayload(symbol));
  }
  if (method === 'GET' && segments[0] === 'accounts' && segments[2] === 'total-pnl-series') {
    const accountKey = decodeURIComponent(segments[1] || '');
    const applyCagr =
      req.query.applyAccountCagrStartDate !== 'false' && req.query.applyAccountCagrStartDate !== '0';
    return respondDemo(res, getTotalPnlSeriesPayload(accountKey || 'all', applyCagr));
  }
  if (method === 'GET' && pathName === '/pnl-breakdown/range') {
    return respondDemo(res, clone(readFixture('pnl-breakdown-range.demo.json')));
  }
  if (method === 'POST' && pathName === '/news') {
    return respondDemo(res, clone(readFixture('news.demo.json')));
  }
  if (pathName === '/logins') {
    if (method === 'GET') {
      return respondDemo(res, clone(readFixture('logins.demo.json')));
    }
    if (method === 'POST') {
      return respondDemo(res, { ok: true, message: 'Demo mode: login saved locally only.' });
    }
  }
  if (pathName === '/accounts') {
    return respondDemo(res, clone(readFixture('accounts.demo.json')));
  }
  if (pathName === '/account-overrides') {
    if (method === 'GET') {
      return respondDemo(res, clone(readFixture('account-overrides.demo.json')));
    }
    if (method === 'POST') {
      return respondDemo(res, { ok: true, message: 'Demo mode: overrides not persisted.' });
    }
  }
  if (method === 'POST' && pathName === '/app-settings/other-assets') {
    return respondDemo(res, { ok: true, message: 'Demo mode: changes not persisted.' });
  }
  if (method === 'POST' && segments[0] === 'accounts') {
    return respondDemo(res, { ok: true, message: 'Demo mode: changes not persisted.' });
  }

  res.status(404).json({ message: 'Demo mode: endpoint not available.' });
  return undefined;
}

module.exports = {
  demoMiddleware,
  isDemoRequest,
};
