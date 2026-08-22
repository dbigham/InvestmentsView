const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeTotalPnlSeries,
  computeTotalPnlSeriesForSymbol,
  computeAggregateTotalPnlSeriesForContexts,
  buildDailyPriceSeries,
  __test__,
} = require('../src/index.js');

test('aggregate funding follows the reconstructed series summary', () => {
  const fundingSummary = {
    netDeposits: { combinedCad: 1003071.10 },
    totalPnl: { combinedCad: 669510.64 },
    totalEquityCad: 1672581.75,
  };

  __test__.applyTotalPnlSeriesSummaryToFundingSummary(
    fundingSummary,
    {
      summary: {
        totalPnlCad: 167461.07,
        totalPnlAllTimeCad: 245750.85,
        netDepositsCad: 1502127.70,
        netDepositsAllTimeCad: 1426841.00,
        totalEquityCad: 1672591.86,
      },
    },
    { id: 'all' }
  );

  assert.equal(fundingSummary.totalPnl.combinedCad, 167461.07);
  assert.equal(fundingSummary.totalPnl.allTimeCad, 245750.85);
  assert.equal(fundingSummary.netDeposits.combinedCad, 1502127.70);
  assert.equal(fundingSummary.netDeposits.allTimeCad, 1426841.00);
  // Preserve the live balance snapshot; the series reconciliation is for
  // funding/P&L, not a replacement for the current balance endpoint.
  assert.equal(fundingSummary.totalEquityCad, 1672581.75);
});

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

test('computeTotalPnlSeries can rebase a provider-observed historical P&L boundary', async () => {
  const account = {
    id: 'HISTORICAL-REBASE-ACCOUNT',
    historyPnlRebaseDates: { '2026-07-16': '2026-07-15' },
  };
  const now = new Date('2026-07-17T00:00:00Z');
  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2026-07-15T00:00:00Z'),
    crawlStart: new Date('2026-07-15T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2026-07-15T00:00:00Z',
        transactionDate: '2026-07-15T00:00:00Z',
        settlementDate: '2026-07-15T00:00:00Z',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
      },
      {
        tradeDate: '2026-07-15T00:00:00Z',
        transactionDate: '2026-07-15T00:00:00Z',
        settlementDate: '2026-07-15T00:00:00Z',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -1000,
        grossAmount: -1000,
        quantity: 10,
        price: 100,
        symbol: 'XYZ.TO',
      },
    ],
    fingerprint: 'historical-rebase',
  };
  const balances = {
    [account.id]: {
      combined: { CAD: { totalEquity: 700, cash: 0, marketValue: 700 } },
      perCurrency: { CAD: { totalEquity: 700, cash: 0, marketValue: 700 } },
    },
  };
  const series = await computeTotalPnlSeries(
    { id: 'questrade-login', provider: 'questrade' },
    account,
    balances,
    {
      activityContext,
      applyAccountCagrStartDate: false,
      providedPositions: [
        {
          accountId: account.id,
          symbol: 'XYZ.TO',
          currency: 'CAD',
          openQuantity: 10,
        },
      ],
      priceSeriesBySymbol: new Map([
        ['XYZ.TO', new Map([
          ['2026-07-15', 100],
          ['2026-07-16', 80],
          ['2026-07-17', 70],
        ])],
      ]),
    }
  );

  assert.ok(series, 'Expected a P&L series');
  assert.equal(series.points[0].totalPnlCad, 0);
  assert.equal(series.points[1].totalPnlCad, 0);
  assert.equal(series.points[2].totalPnlCad, -100);
  assert.ok(series.issues.includes('history-pnl-rebased'));
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

test('aggregate Total P&L drops dates missing a post-start account point', async () => {
  const makeActivityContext = ({ accountId, now, amount }) => ({
    accountId,
    accountKey: accountId,
    accountNumber: accountId,
    earliestFunding: new Date('2026-06-15T00:00:00Z'),
    crawlStart: new Date('2026-06-15T00:00:00Z'),
    now: new Date(now),
    nowIsoString: new Date(now).toISOString(),
    activities: [
      {
        tradeDate: '2026-06-16T00:00:00Z',
        transactionDate: '2026-06-16T00:00:00Z',
        settlementDate: '2026-06-16T00:00:00Z',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: amount,
        grossAmount: amount,
        symbol: '',
        symbolId: 0,
      },
    ],
    fingerprint: `${accountId}-coverage-test`,
  });

  const contexts = [
    {
      login: { id: 'login-1' },
      account: { id: 'A', number: 'A' },
    },
    {
      login: { id: 'login-1' },
      account: { id: 'B', number: 'B' },
    },
  ];
  const activityContexts = {
    A: makeActivityContext({
      accountId: 'A',
      now: '2026-06-17T00:00:00Z',
      amount: 100,
    }),
    B: makeActivityContext({
      accountId: 'B',
      now: '2026-06-16T00:00:00Z',
      amount: 500,
    }),
  };

  const balances = {
    A: {
      combined: {
        CAD: {
          totalEquity: 110,
        },
      },
    },
    B: {
      combined: {
        CAD: {
          totalEquity: 500,
        },
      },
    },
  };

  const result = await computeAggregateTotalPnlSeriesForContexts(
    contexts,
    balances,
    { applyAccountCagrStartDate: false },
    'all',
    false,
    (context) => activityContexts[context.account.id]
  );

  assert.ok(result, 'Expected aggregate series');
  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2026-06-16');
  assert.equal(lastPoint.equityCad, 600);
  assert.equal(lastPoint.cumulativeNetDepositsCad, 600);
  assert.equal(lastPoint.totalPnlCad, 0);
  assert.equal(result.summary.totalEquityCad, 600);
  assert.equal(result.summary.netDepositsCad, 600);
  assert.equal(result.summary.totalPnlCad, 0);
  assert.ok(result.issues.includes('aggregate-partial-date-coverage'));
  assert.ok(result.issues.includes('aggregate-partial-summary-coverage'));
});

test('aggregate Total P&L carries archived account results through the aggregate end date', async () => {
  const contexts = [
    { login: { id: 'login-1' }, account: { id: 'LIVE', number: 'LIVE' } },
    { login: { id: 'login-1' }, account: { id: 'ARCHIVED', number: 'ARCHIVED', archived: true } },
  ];
  const makeContext = (accountId, now, amount, gain = 0) => ({
    accountId,
    accountKey: accountId,
    accountNumber: accountId,
    earliestFunding: new Date('2026-06-15T00:00:00Z'),
    crawlStart: new Date('2026-06-15T00:00:00Z'),
    now: new Date(now),
    nowIsoString: new Date(now).toISOString(),
    activities: [
      {
        tradeDate: '2026-06-15T00:00:00Z',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: amount,
        grossAmount: amount,
      },
      ...(gain ? [{
        tradeDate: '2026-06-16T00:00:00Z',
        type: 'Other',
        action: 'GAIN',
        currency: 'CAD',
        netAmount: gain,
        grossAmount: gain,
      }] : []),
    ],
    fingerprint: `${accountId}-archived-coverage-test`,
  });
  const activityContexts = {
    LIVE: makeContext('LIVE', '2026-06-17T00:00:00Z', 100, 10),
    ARCHIVED: makeContext('ARCHIVED', '2026-06-16T00:00:00Z', 500, 50),
  };
  const balances = {
    LIVE: { combined: { CAD: { totalEquity: 110 } } },
    ARCHIVED: { combined: { CAD: { totalEquity: 550 } } },
  };

  const result = await computeAggregateTotalPnlSeriesForContexts(
    contexts,
    balances,
    { applyAccountCagrStartDate: false },
    'all',
    false,
    (context) => activityContexts[context.account.id]
  );

  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2026-06-17');
  assert.equal(lastPoint.totalPnlCad, 60);
  assert.equal(lastPoint.equityCad, 660);
  assert.equal(lastPoint.cumulativeNetDepositsCad, 600);
});

test('computeTotalPnlSeries keeps reconstructed equity when current snapshot is empty', async () => {
  const account = {
    id: 'MISSING-SNAPSHOT-ACCOUNT',
  };

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2026-06-16T00:00:00Z'),
    crawlStart: new Date('2026-06-16T00:00:00Z'),
    now: new Date('2026-06-17T00:00:00Z'),
    nowIsoString: '2026-06-17T00:00:00.000Z',
    activities: [
      {
        tradeDate: '2026-06-16T00:00:00Z',
        transactionDate: '2026-06-16T00:00:00Z',
        settlementDate: '2026-06-16T00:00:00Z',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 500,
        grossAmount: 500,
        symbol: '',
        symbolId: 0,
      },
    ],
    fingerprint: 'missing-current-snapshot-test',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 0,
        },
      },
    },
  };

  const result = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: false, providedPositions: [] }
  );

  assert.ok(result, 'Expected account series');
  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2026-06-17');
  assert.equal(lastPoint.equityCad, 500);
  assert.equal(lastPoint.cumulativeNetDepositsCad, 500);
  assert.equal(lastPoint.totalPnlCad, 0);
  assert.equal(result.summary.totalEquityCad, 500);
  assert.equal(result.summary.totalPnlCad, 0);
  assert.ok(result.issues.includes('current-balance-snapshot-missing'));
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

test('computeTotalPnlSeries applies opted-in pending deposit fix to the final point', async () => {
  const account = {
    id: 'PENDING-DEPOSIT-AUTO-FIX-ACCOUNT',
    autoFixPendingWithdrawls: true,
  };

  const now = new Date('2025-01-03T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: null,
    crawlStart: now,
    now,
    nowIsoString: now.toISOString(),
    activities: [],
    fingerprint: 'pending-deposit-auto-fix-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1500,
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
  assert.ok(Math.abs(result.summary.totalPnlSinceDisplayStartCad || 0) < 1e-6);
});

test('computeTotalPnlSeries ignores internal share journal cash amounts', async () => {
  const account = {
    id: 'INTERNAL-JOURNAL-ACCOUNT',
  };

  const now = new Date('2026-06-16T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2026-06-15T00:00:00Z'),
    crawlStart: new Date('2026-06-15T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2026-06-15T10:00:00Z',
        transactionDate: '2026-06-15T10:00:00Z',
        settlementDate: '2026-06-15T10:00:00Z',
        type: 'CONTRIBUTION',
        action: 'CONTRIBUTION',
        description: 'Deposit of $1000.00',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
      },
      {
        tradeDate: '2026-06-15T11:00:00Z',
        transactionDate: '2026-06-15T11:00:00Z',
        settlementDate: '2026-06-15T11:00:00Z',
        type: 'JOURNAL_SHARES',
        action: 'JOURNAL_SHARES',
        description: 'JOURNAL_SHARES',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
      },
    ],
    fingerprint: 'internal-journal-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1000,
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
  const journalDay = result.points.find((point) => point.date === '2026-06-15');
  assert.ok(journalDay, 'Expected journal date point');
  assert.ok(Math.abs(journalDay.equityCad - 1000) < 1e-6);
  assert.ok(Math.abs(journalDay.cumulativeNetDepositsCad - 1000) < 1e-6);
  assert.ok(Math.abs(journalDay.totalPnlCad) < 1e-6);
  assert.ok(Math.abs(result.summary.netDepositsCad - 1000) < 1e-6);
  assert.ok(Math.abs(result.summary.totalPnlCad) < 1e-6);
});

test('computeTotalPnlSeries skips pending-deposit auto-fix for historical end dates', async () => {
  const account = {
    id: 'PENDING-DEPOSIT-HISTORICAL-END',
  };

  const now = new Date('2025-01-03T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
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
        action: 'CON',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
        symbol: '',
        symbolId: 0,
      },
    ],
    fingerprint: 'pending-deposit-historical-end-fingerprint',
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
    {
      activityContext,
      applyAccountCagrStartDate: false,
      endDate: '2025-01-02',
    }
  );

  assert.ok(result, 'Expected series result');
  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2025-01-02');
  assert.ok(Math.abs(lastPoint.cumulativeNetDepositsCad - 1000) < 1e-6);
  assert.ok(Math.abs(lastPoint.totalPnlCad - 500) < 1e-6);
  assert.ok(Math.abs(lastPoint.equityCad - 1500) < 1e-6);

  assert.ok(Math.abs(result.summary.netDepositsCad - 1000) < 1e-6);
  assert.ok(Math.abs(result.summary.totalPnlCad - 500) < 1e-6);
  assert.ok(Math.abs(result.summary.totalPnlAllTimeCad - 500) < 1e-6);
});

test('SnapTrade reconciles unreported inbound opening assets as funding without changing Questrade seeding', async () => {
  const account = { id: 'MISSING-INBOUND-TRANSFER', number: 'MISSING-INBOUND-TRANSFER' };
  const now = new Date('2026-06-18T00:00:00Z');
  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.number,
    earliestFunding: new Date('2026-06-16T00:00:00Z'),
    crawlStart: new Date('2026-06-16T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    offlineOnly: true,
    providerActivityCoverageComplete: true,
    activities: [
      {
        tradeDate: '2026-06-16T00:00:00Z',
        type: 'CONTRIBUTION',
        action: 'CONTRIBUTION',
        description: 'Deposit of $1000.00',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
      },
      {
        tradeDate: '2026-06-17T00:00:00Z',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -1000,
        grossAmount: -1000,
        quantity: 10,
        symbol: 'XYZ.TO',
      },
    ],
    fingerprint: 'missing-inbound-transfer',
  };
  const balances = {
    [account.id]: {
      combined: { CAD: { totalEquity: 1320 } },
      perCurrency: { CAD: { totalEquity: 1320, marketValue: 1320, cash: 0 } },
    },
  };
  const providedPositions = [
    {
      accountId: account.id,
      symbol: 'XYZ.TO',
      currency: 'CAD',
      openQuantity: 12,
      currentPrice: 110,
      currentMarketValue: 1320,
    },
  ];
  const priceSeriesBySymbol = new Map([
    ['XYZ.TO', new Map([
      ['2026-06-16', 100],
      ['2026-06-17', 100],
      ['2026-06-18', 110],
    ])],
  ]);
  const commonOptions = {
    activityContext,
    applyAccountCagrStartDate: false,
    providedPositions,
    priceSeriesBySymbol,
  };

  const snapTradeSeries = await computeTotalPnlSeries(
    { id: 'snap-login', provider: 'wealthsimple' },
    account,
    balances,
    commonOptions
  );

  assert.equal(snapTradeSeries.summary.openingFundingSource, 'residual-opening-equity');
  assert.equal(snapTradeSeries.summary.openingFundingAdjustmentCad, 200);
  assert.equal(snapTradeSeries.summary.netDepositsCad, 1200);
  assert.equal(snapTradeSeries.summary.netDepositsAllTimeCad, 1200);
  assert.equal(snapTradeSeries.summary.totalPnlCad, 120);
  assert.equal(snapTradeSeries.summary.cashFlowCoverageIncomplete, true);
  assert.ok(snapTradeSeries.issues.includes('opening-funding-estimated-from-market-value'));
  assert.equal(snapTradeSeries.periodStartDate, '2026-06-17');
  assert.equal(snapTradeSeries.displayStartDate, '2026-06-17');
  assert.equal(snapTradeSeries.points[0].date, '2026-06-17');
  assert.equal(snapTradeSeries.points[0].equityCad, 1200);
  assert.equal(snapTradeSeries.points[0].cumulativeNetDepositsCad, 1200);
  assert.equal(snapTradeSeries.points[0].totalPnlCad, 0);
  assert.equal(snapTradeSeries.points.at(-1).equityCad, 1320);
  assert.equal(snapTradeSeries.points.at(-1).totalPnlCad, 120);
  assert.ok(!snapTradeSeries.issues?.includes('current-snapshot-diverges-from-reconstruction'));
  assert.equal(snapTradeSeries.summary.providerObservedReturn.startDate, '2026-06-17');
  assert.equal(snapTradeSeries.summary.providerObservedReturn.activityCoverageComplete, true);
  assert.equal(snapTradeSeries.summary.providerObservedReturn.observedPnlCad, 120);
  assert.equal(snapTradeSeries.summary.totalPnlSinceDisplayStartCad, 120);
  assert.equal(snapTradeSeries.summary.netDepositsCad, 1200);

  const questradeSeries = await computeTotalPnlSeries(
    { id: 'questrade-login', provider: 'questrade' },
    account,
    balances,
    commonOptions
  );
  assert.equal(questradeSeries.summary.openingFundingAdjustmentCad, undefined);
  assert.equal(questradeSeries.summary.netDepositsCad, 1000);
  assert.equal(questradeSeries.summary.totalPnlCad, 320);
  assert.equal(questradeSeries.points.at(-1).equityCad, 1320);
});

test('explicit history start displays reconstructed opening days without moving the provider boundary', async () => {
  const account = {
    id: 'SNAPTRADE-HISTORY-START',
    historyStartDate: '2026-06-16',
  };
  const now = new Date('2026-06-18T00:00:00Z');
  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2026-06-17T00:00:00Z'),
    crawlStart: new Date('2026-06-16T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2026-06-17T00:00:00Z',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -1000,
        grossAmount: -1000,
        quantity: 10,
        symbol: 'XYZ.TO',
      },
    ],
    fingerprint: 'explicit-history-start',
    providerActivityCoverageComplete: true,
  };
  const balances = {
    [account.id]: {
      combined: { CAD: { totalEquity: 1320, cash: 0, marketValue: 1320 } },
      perCurrency: { CAD: { totalEquity: 1320, cash: 0, marketValue: 1320 } },
    },
  };
  const series = await computeTotalPnlSeries(
    { id: 'snap-login', provider: 'wealthsimple' },
    account,
    balances,
    {
      activityContext,
      applyAccountCagrStartDate: false,
      providedPositions: [
        {
          accountId: account.id,
          symbol: 'XYZ.TO',
          currency: 'CAD',
          openQuantity: 12,
          currentPrice: 110,
          currentMarketValue: 1320,
        },
      ],
      priceSeriesBySymbol: new Map([
        ['XYZ.TO', new Map([
          ['2026-06-16', 100],
          ['2026-06-17', 100],
          ['2026-06-18', 110],
        ])],
      ]),
    }
  );

  assert.equal(series.periodStartDate, '2026-06-16');
  assert.equal(series.displayStartDate, '2026-06-16');
  assert.equal(series.historyStartDate, '2026-06-16');
  assert.equal(series.historyStartDateEstimated, true);
  assert.equal(series.points[0].date, '2026-06-16');
  assert.equal(series.points[0].totalPnlCad, 0);
  assert.equal(series.summary.providerObservedReturn.startDate, '2026-06-17');
  assert.equal(series.summary.estimatedHistoryReturn.startDate, '2026-06-16');
  assert.equal(series.summary.estimatedHistoryReturn.estimated, true);
  assert.equal(series.summary.totalPnlSinceDisplayStartCad, 120);
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

test('computeTotalPnlSeriesForSymbol nets same-day trades before clamping', async () => {
  const account = {
    id: 'SYMBOL-NETTED-ACCOUNT',
  };

  const now = new Date('2025-01-03T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-01-01T00:00:00Z'),
    crawlStart: new Date('2025-01-01T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      {
        tradeDate: '2025-01-01T00:00:00.000000-05:00',
        transactionDate: '2025-01-01T00:00:00.000000-05:00',
        settlementDate: '2025-01-01T00:00:00.000000-05:00',
        type: 'Trades',
        action: 'Sell',
        currency: 'CAD',
        netAmount: 100,
        grossAmount: 100,
        quantity: -1,
        symbol: 'ABC.TO',
        symbolId: 0,
      },
      {
        tradeDate: '2025-01-01T00:00:00.000000-05:00',
        transactionDate: '2025-01-01T00:00:00.000000-05:00',
        settlementDate: '2025-01-01T00:00:00.000000-05:00',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -100,
        grossAmount: -100,
        quantity: 1,
        symbol: 'ABC.TO',
        symbolId: 0,
      },
      {
        tradeDate: '2025-01-02T00:00:00.000000-05:00',
        transactionDate: '2025-01-02T00:00:00.000000-05:00',
        settlementDate: '2025-01-02T00:00:00.000000-05:00',
        type: 'Transfers',
        action: 'TFO',
        currency: 'CAD',
        netAmount: 0,
        quantity: 10,
        symbol: 'ABC.TO',
        symbolId: 0,
        description: 'TRANSFER BOOK VALUE 1000',
      },
    ],
    fingerprint: 'symbol-netted-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 0,
        },
      },
    },
  };

  const dateKeys = ['2025-01-01', '2025-01-02', '2025-01-03'];
  const priceSeries = buildDailyPriceSeries(
    [
      { date: new Date('2025-01-01T00:00:00Z'), price: 100 },
      { date: new Date('2025-01-03T00:00:00Z'), price: 110 },
    ],
    dateKeys
  );

  const result = await computeTotalPnlSeriesForSymbol(
    { id: 'login-1' },
    account,
    balances,
    {
      startDate: '2025-01-01',
      endDate: '2025-01-03',
      symbol: 'ABC.TO',
      applyAccountCagrStartDate: false,
      activityContext,
      priceSeriesBySymbol: new Map([['ABC.TO', priceSeries]]),
    }
  );

  assert.ok(result, 'Expected symbol series result');
  const lastPoint = result.points[result.points.length - 1];
  assert.equal(lastPoint.date, '2025-01-03');
  assert.ok(Math.abs(lastPoint.equityCad - 1100) < 1e-6);
});

test('computeTotalPnlSeriesForSymbol carries opening snapshot holdings through the series', async () => {
  const account = {
    id: 'SYMBOL-OPENING-SNAPSHOT-ACCOUNT',
  };
  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-01-01T00:00:00Z'),
    crawlStart: new Date('2025-01-01T00:00:00Z'),
    now: new Date('2025-01-03T00:00:00Z'),
    nowIsoString: '2025-01-03T00:00:00.000Z',
    activities: [
      {
        tradeDate: '2025-01-02T00:00:00Z',
        transactionDate: '2025-01-02T00:00:00Z',
        settlementDate: '2025-01-02T00:00:00Z',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -100,
        grossAmount: -100,
        quantity: 1,
        price: 100,
        symbol: 'ABC.TO',
      },
    ],
    fingerprint: 'symbol-opening-snapshot-fingerprint',
  };
  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 330,
        },
      },
    },
  };
  const dateKeys = ['2025-01-01', '2025-01-02', '2025-01-03'];
  const priceSeries = buildDailyPriceSeries(
    [
      { date: new Date('2025-01-01T00:00:00Z'), price: 100 },
      { date: new Date('2025-01-03T00:00:00Z'), price: 110 },
    ],
    dateKeys
  );

  const result = await computeTotalPnlSeriesForSymbol(
    { id: 'login-1' },
    account,
    balances,
    {
      startDate: '2025-01-01',
      endDate: '2025-01-03',
      symbol: 'ABC.TO',
      applyAccountCagrStartDate: false,
      activityContext,
      providedPositions: [
        {
          accountId: account.id,
          symbol: 'ABC.TO',
          currency: 'CAD',
          openQuantity: 3,
        },
      ],
      priceSeriesBySymbol: new Map([['ABC.TO', priceSeries]]),
    }
  );

  assert.ok(result, 'Expected symbol series result');
  assert.deepEqual(
    result.points.map((point) => [point.date, point.equityCad, point.cumulativeNetDepositsCad, point.totalPnlCad]),
    [
      ['2025-01-01', 200, 200, 0],
      ['2025-01-02', 300, 300, 0],
      ['2025-01-03', 330, 300, 30],
    ]
  );
});

test('computeTotalPnlSeriesForSymbol ignores accounts without symbol activity or holdings', async () => {
  const account = { id: 'SYMBOL-NO-MATCH-ACCOUNT' };
  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-01-01T00:00:00Z'),
    crawlStart: new Date('2025-01-01T00:00:00Z'),
    now: new Date('2025-01-02T00:00:00Z'),
    nowIsoString: '2025-01-02T00:00:00.000Z',
    activities: [
      {
        tradeDate: '2025-01-01T00:00:00Z',
        transactionDate: '2025-01-01T00:00:00Z',
        settlementDate: '2025-01-01T00:00:00Z',
        type: 'Trades',
        action: 'Buy',
        currency: 'CAD',
        netAmount: -100,
        grossAmount: -100,
        quantity: 1,
        price: 100,
        symbol: 'OTHER.TO',
      },
    ],
    fingerprint: 'symbol-no-match-fingerprint',
  };
  const result = await computeTotalPnlSeriesForSymbol(
    { id: 'login-1' },
    account,
    {
      [account.id]: {
        combined: { CAD: { totalEquity: 100 } },
      },
    },
    {
      startDate: '2025-01-01',
      endDate: '2025-01-02',
      symbol: 'SPCX',
      applyAccountCagrStartDate: false,
      activityContext,
    }
  );

  assert.equal(result, null);
});
