const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;

if (!process.env.FRED_API_KEY) {
  process.env.FRED_API_KEY = 'TEST_KEY';
}

const {
  computeTotalPnlSeries,
} = require('../src/index.js');

test('computeTotalPnlSeries handles cash-only activities', async () => {
  const account = {
    id: 'TEST-ACCOUNT',
  };

  const now = new Date('2025-01-16T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-01-02T00:00:00Z'),
    crawlStart: new Date('2025-01-02T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2025-01-02T00:00:00.000000-05:00',
        transactionDate: '2025-01-02T00:00:00.000000-05:00',
        settlementDate: '2025-01-02T00:00:00.000000-05:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
        symbol: '',
        symbolId: 0,
      },
      {
        tradeDate: '2025-01-10T00:00:00.000000-05:00',
        transactionDate: '2025-01-10T00:00:00.000000-05:00',
        settlementDate: '2025-01-10T00:00:00.000000-05:00',
        type: 'Other',
        action: 'GAIN',
        currency: 'CAD',
        netAmount: 75,
        grossAmount: 75,
        symbol: '',
        symbolId: 0,
      },
      {
        tradeDate: '2025-01-15T00:00:00.000000-05:00',
        transactionDate: '2025-01-15T00:00:00.000000-05:00',
        settlementDate: '2025-01-15T00:00:00.000000-05:00',
        type: 'Withdrawals',
        action: 'WDL',
        currency: 'CAD',
        netAmount: -25,
        grossAmount: -25,
        symbol: '',
        symbolId: 0,
      },
    ],
    fingerprint: 'test-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1050,
        },
      },
    },
  };

  const result = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext }
  );

  assert.ok(result, 'Expected series result');
  assert.equal(result.accountId, account.id);
  assert.ok(Array.isArray(result.points) && result.points.length > 0, 'Expected daily points');

  const firstPoint = result.points[0];
  assert.equal(firstPoint.date, '2025-01-02');
  assert.ok(Math.abs(firstPoint.cumulativeNetDepositsCad - 1000) < 1e-6);
  assert.ok(Math.abs(firstPoint.totalPnlCad - 0) < 1e-6);

  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2025-01-16');
  assert.ok(Math.abs(lastPoint.cumulativeNetDepositsCad - 975) < 1e-6);
  assert.ok(Math.abs(lastPoint.totalPnlCad - 75) < 1e-6);
  assert.ok(Math.abs(lastPoint.equityCad - 1050) < 1e-6);

  const profitPoint = result.points.find((point) => point.date === '2025-01-10');
  assert.ok(profitPoint, 'Expected profit date entry');
  assert.ok(Math.abs(profitPoint.totalPnlCad - 75) < 1e-6);

  assert.ok(Math.abs(result.summary.totalPnlCad - 75) < 1e-6);
  assert.ok(Math.abs(result.summary.totalEquityCad - 1050) < 1e-6);
  assert.ok(Math.abs(result.summary.netDepositsCad - 975) < 1e-6);

  assert.ok(!result.issues, 'Expected no issues for cash-only scenario');
});

test('computeTotalPnlSeries resolves USD securities when activities report CAD currency', async (t) => {
  const originalFredKey = process.env.FRED_API_KEY;
  process.env.FRED_API_KEY = 'TEST_KEY';

  t.mock.method(axios, 'get', async (url) => {
    if (typeof url === 'string' && url.startsWith('https://api.stlouisfed.org/fred/series/observations')) {
      return {
        data: {
          observations: [
            { date: '2025-09-01', value: '1.35' },
            { date: '2025-09-02', value: '1.35' },
          ],
        },
      };
    }
    if (typeof url === 'string' && url.startsWith('https://login.questrade.com/oauth2/token')) {
      return {
        data: {
          access_token: 'test-access',
          api_server: 'https://mock.api/',
          expires_in: 1800,
          refresh_token: 'test-refresh',
        },
      };
    }
    throw new Error(`Unexpected axios.get url: ${url}`);
  });

  t.mock.method(axios, 'request', async (config) => {
    if (config && typeof config.url === 'string' && config.url.startsWith('https://mock.api/v1/symbols')) {
      const ids = config.params && config.params.ids ? String(config.params.ids) : '';
      const entries = ids.split(',').filter(Boolean).map((id) => ({ symbolId: Number(id), currency: 'USD' }));
      return { data: { symbols: entries }, headers: {} };
    }
    throw new Error(`Unexpected axios.request url: ${config && config.url}`);
  });

  t.mock.method(yahooFinance, 'historical', async () => {
    return [
      { date: new Date('2025-09-01T00:00:00Z'), adjClose: 100 },
    ];
  });

  t.after(() => {
    process.env.FRED_API_KEY = originalFredKey;
    t.mock.restoreAll();
  });

  const account = { id: 'USD-TEST' };
  const now = new Date('2025-09-02T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-09-01T00:00:00Z'),
    crawlStart: new Date('2025-09-01T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2025-09-01T00:00:00.000000-04:00',
        transactionDate: '2025-09-01T00:00:00.000000-04:00',
        settlementDate: '2025-09-01T00:00:00.000000-04:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 1350,
        grossAmount: 1350,
        symbol: '',
        symbolId: 0,
      },
      {
        tradeDate: '2025-09-01T00:00:00.000000-04:00',
        transactionDate: '2025-09-01T00:00:00.000000-04:00',
        settlementDate: '2025-09-01T00:00:00.000000-04:00',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -1350,
        grossAmount: -1350,
        quantity: 10,
        price: 135,
        symbol: 'QQQM',
        symbolId: 32621374,
      },
    ],
    fingerprint: 'usd-test-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1350,
        },
      },
    },
  };

  const result = await computeTotalPnlSeries(
    { id: 'login-1', refreshToken: 'test-refresh' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: false }
  );

  assert.ok(result, 'Expected series result');
  assert.ok(Array.isArray(result.points) && result.points.length > 0, 'Expected daily points');
  assert.ok(Math.abs(result.summary.totalPnlCad || 0) < 1e-6, 'Expected zero P&L when FX adjusted');
  assert.ok(Math.abs(result.summary.netDepositsCad - 1350) < 1e-6, 'Expected deposits to equal 1350 CAD');
  assert.ok(Math.abs(result.summary.totalEquityCad - 1350) < 1e-6, 'Expected equity to equal 1350 CAD');

  const firstPoint = result.points[0];
  assert.equal(firstPoint.date, '2025-09-01');
  assert.ok(Math.abs(firstPoint.totalPnlCad || 0) < 1e-6, 'Expected no loss on first day');
});
