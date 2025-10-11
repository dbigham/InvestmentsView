const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.FRED_API_KEY = process.env.FRED_API_KEY || 'dummy-test-key';

const MOCK_FX_OBSERVATIONS = [
  { date: '2025-01-02', value: '1.34' },
  { date: '2025-01-03', value: '1.34' },
  { date: '2025-01-10', value: '1.34' },
  { date: '2025-01-15', value: '1.34' },
  { date: '2025-01-16', value: '1.34' },
  { date: '2025-05-18', value: '1.33' },
  { date: '2025-05-19', value: '1.33' },
  { date: '2025-05-20', value: '1.33' },
  { date: '2025-05-21', value: '1.33' },
];

function mockFxRequests() {
  return test.mock.method(axios, 'get', async (url) => {
    if (typeof url === 'string' && url.includes('stlouisfed')) {
      return { data: { observations: MOCK_FX_OBSERVATIONS } };
    }
    return { data: {} };
  });
}

const {
  computeTotalPnlSeries,
  __setPriceHistoryFetcherForTests,
} = require('../src/index.js');

test('computeTotalPnlSeries handles cash-only activities', async () => {
  const axiosMock = mockFxRequests();

  try {
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
  } finally {
    axiosMock.mock.restore();
  }
});

test('computeTotalPnlSeries uses activity price hints when history is unavailable', async () => {
  __setPriceHistoryFetcherForTests(() => []);
  const axiosMock = mockFxRequests();

  try {
    const account = {
      id: 'TEST-HINTS',
      number: 'TEST-HINTS',
    };

    const now = new Date('2025-05-21T00:00:00Z');

    const activityContext = {
      accountId: account.id,
      accountKey: account.id,
      accountNumber: account.id,
      earliestFunding: new Date('2025-05-18T00:00:00Z'),
      crawlStart: new Date('2025-05-18T00:00:00Z'),
      now,
      nowIsoString: now.toISOString(),
      activities: [
        {
          tradeDate: '2025-05-18T09:00:00.000000-04:00',
          transactionDate: '2025-05-18T09:00:00.000000-04:00',
          settlementDate: '2025-05-18T09:00:00.000000-04:00',
          type: 'Deposits',
          action: 'DEP',
          currency: 'CAD',
          netAmount: 4000,
          grossAmount: 4000,
          symbol: '',
          symbolId: 0,
        },
        {
          tradeDate: '2025-05-19T13:30:00.000000-04:00',
          transactionDate: '2025-05-19T13:30:00.000000-04:00',
          settlementDate: '2025-05-21T00:00:00.000000-04:00',
          type: 'Trades',
          action: 'BUY',
          currency: 'CAD',
          netAmount: -4000,
          grossAmount: -4000,
          quantity: 100,
          price: 40,
          symbol: 'PRIVATECO',
          symbolId: 987654,
        },
      ],
      fingerprint: 'hints-fingerprint',
    };

    const balances = {
      [account.id]: {
        combined: {
          CAD: {
            totalEquity: 4050,
          },
        },
      },
    };

    const result = await computeTotalPnlSeries(
      { id: 'login-hints' },
      account,
      balances,
      { activityContext }
    );

    assert.ok(result, 'Expected series result');
    assert.equal(result.accountId, account.id);
    assert.ok(Array.isArray(result.points) && result.points.length > 0, 'Expected daily points');

    const buyPoint = result.points.find((point) => point.date === '2025-05-19');
    assert.ok(buyPoint, 'Expected entry for trade date');
    assert.ok(
      Math.abs(buyPoint.totalPnlCad) < 1e-4,
      'Activity price hint should keep P&L near zero after the trade'
    );

    assert.ok(result.summary);
    assert.ok(
      Math.abs(result.summary.totalPnlCad - 50) < 1e-3,
      'Expected summary total P&L to reflect balance-derived gain'
    );

    assert.ok(!result.missingPriceSymbols, 'Expected price hints to avoid missing symbol flag');
  } finally {
    axiosMock.mock.restore();
    __setPriceHistoryFetcherForTests(null);
  }
});
