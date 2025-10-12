const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeTotalPnlSeries,
  computeNetDeposits,
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

test('computeNetDeposits respects CAGR start baseline equity', async () => {
  const account = {
    id: 'TEST-ACCOUNT',
    number: 'TEST-ACCOUNT',
    cagrStartDate: '2025-01-15',
  };

  const now = new Date('2025-01-31T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.number,
    earliestFunding: new Date('2025-01-01T00:00:00Z'),
    crawlStart: new Date('2025-01-01T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2025-01-01T00:00:00.000000-05:00',
        transactionDate: '2025-01-01T00:00:00.000000-05:00',
        settlementDate: '2025-01-01T00:00:00.000000-05:00',
        type: 'Deposits',
        action: 'DEP',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
        symbol: '',
        symbolId: 0,
      },
      {
        tradeDate: '2025-01-20T00:00:00.000000-05:00',
        transactionDate: '2025-01-20T00:00:00.000000-05:00',
        settlementDate: '2025-01-20T00:00:00.000000-05:00',
        type: 'Deposits',
        action: 'DEP',
        currency: 'CAD',
        netAmount: 300,
        grossAmount: 300,
        symbol: '',
        symbolId: 0,
      },
    ],
    fingerprint: 'test-fingerprint-cagr',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1600,
        },
      },
    },
  };

  const result = await computeNetDeposits(
    { id: 'login-1' },
    account,
    balances,
    { applyAccountCagrStartDate: true, activityContext }
  );

  assert.ok(result, 'Expected funding summary result');
  assert.ok(result.netDeposits, 'Expected net deposits block');
  assert.ok(Math.abs(result.netDeposits.combinedCad - 1600) < 1e-6, 'Net deposits should include baseline equity before CAGR start');
  assert.ok(result.totalPnl, 'Expected total P&L block');
  assert.ok(Math.abs(result.totalPnl.combinedCad - 0) < 1e-6, 'Total P&L should exclude pre-start equity');
});
