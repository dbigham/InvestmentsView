const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeTotalPnlSeries,
  buildDailyPriceSeries,
} = require('../src/index.js');

test('buildDailyPriceSeries uses same-day closing prices for late timestamps', () => {
  const history = [
    { date: new Date('2025-10-09T00:00:00Z'), price: 100 },
    { date: new Date('2025-10-10T04:00:00Z'), price: 91 },
  ];
  const dateKeys = ['2025-10-09', '2025-10-10', '2025-10-11'];
  const series = buildDailyPriceSeries(history, dateKeys);

  assert.ok(series instanceof Map, 'Expected map result');
  assert.equal(series.get('2025-10-09'), 100);
  assert.equal(series.get('2025-10-10'), 91);
  assert.equal(series.get('2025-10-11'), 91);
});

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
  assert.ok(Math.abs(firstPoint.totalPnlSinceDisplayStartCad || 0) < 1e-6);

  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2025-01-16');
  assert.ok(Math.abs(lastPoint.cumulativeNetDepositsCad - 975) < 1e-6);
  assert.ok(Math.abs(lastPoint.totalPnlCad - 75) < 1e-6);
  assert.ok(Math.abs(lastPoint.equityCad - 1050) < 1e-6);
  assert.ok(Math.abs(lastPoint.totalPnlSinceDisplayStartCad - 75) < 1e-6);

  const profitPoint = result.points.find((point) => point.date === '2025-01-10');
  assert.ok(profitPoint, 'Expected profit date entry');
  assert.ok(Math.abs(profitPoint.totalPnlCad - 75) < 1e-6);

  assert.ok(Math.abs(result.summary.totalPnlCad - 75) < 1e-6);
  assert.ok(Math.abs(result.summary.totalPnlSinceDisplayStartCad - 75) < 1e-6);
  assert.ok(Math.abs(result.summary.totalEquityCad - 1050) < 1e-6);
  assert.ok(Math.abs(result.summary.netDepositsCad - 975) < 1e-6);
  assert.ok(result.summary.displayStartTotals);
  assert.ok(Math.abs(result.summary.displayStartTotals.totalPnlCad || 0) < 1e-6);

  assert.ok(!result.issues, 'Expected no issues for cash-only scenario');
});

test('computeTotalPnlSeries treats unexplained equity jumps as pending deposits', async () => {
  const account = {
    id: 'PENDING-DEPOSIT-ACCOUNT',
  };

  const now = new Date('2025-01-03T00:00:00Z');

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
    ],
    fingerprint: 'pending-deposit-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1500,
          dayPnl: 0,
        },
      },
    },
  };

  const result = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: false }
  );

  assert.ok(result, 'Expected series result');
  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2025-01-03');
  assert.ok(Math.abs(lastPoint.cumulativeNetDepositsCad - 1500) < 1e-6);
  assert.ok(Math.abs(lastPoint.totalPnlCad - 0) < 1e-6);
  assert.ok(Math.abs(lastPoint.equityCad - 1500) < 1e-6);

  assert.ok(Math.abs(result.summary.netDepositsCad - 1500) < 1e-6);
  assert.ok(Math.abs(result.summary.totalPnlCad - 0) < 1e-6);
  assert.ok(Math.abs(result.summary.totalPnlAllTimeCad - 0) < 1e-6);
});

test('computeTotalPnlSeries can ignore manual net deposit adjustments', async () => {
  const account = {
    id: 'ADJUSTED-ACCOUNT',
    netDepositAdjustment: 5000,
  };

  const now = new Date('2025-08-21T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-08-04T00:00:00Z'),
    crawlStart: new Date('2025-08-04T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2025-08-04T00:00:00.000000-04:00',
        transactionDate: '2025-08-04T00:00:00.000000-04:00',
        settlementDate: '2025-08-04T00:00:00.000000-04:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 10,
        grossAmount: 10,
      },
    ],
    fingerprint: 'adjusted-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 8,
        },
      },
    },
  };

  const defaultSeries = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: false }
  );

  assert.ok(defaultSeries, 'Expected series with adjustments applied');
  assert.ok(
    Math.abs(defaultSeries.summary.netDepositsCad - 5010) < 1e-6,
    'Expected adjustments to inflate net deposits when applied'
  );
  const defaultFirstPoint = defaultSeries.points[0];
  assert.ok(defaultFirstPoint, 'Expected first point');
  assert.ok(
    Math.abs(defaultFirstPoint.cumulativeNetDepositsCad - 5010) < 1e-6,
    'Expected first point to include manual adjustment when applied'
  );

  const ignoredSeries = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: false, ignoreAccountAdjustments: true }
  );

  assert.ok(ignoredSeries, 'Expected series when adjustments are ignored');
  assert.ok(
    Math.abs(ignoredSeries.summary.netDepositsCad - 10) < 1e-6,
    'Expected manual adjustment to be excluded when ignoreAccountAdjustments is set'
  );
  const firstIgnoredPoint = ignoredSeries.points[0];
  assert.ok(firstIgnoredPoint, 'Expected first point when ignoring adjustments');
  assert.ok(
    Math.abs(firstIgnoredPoint.cumulativeNetDepositsCad - 10) < 1e-6,
    'Expected baseline deposits to reflect actual funding when adjustments are ignored'
  );
});
