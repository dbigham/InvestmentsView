const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

const resolveWindow = __test__.resolveRangeBreakdownWindowForAccount;
const getPositions = __test__.getPositionsForAccountFromSuperset;
const shouldUseCurrentEndHoldings = __test__.shouldUseCurrentEndHoldingsForRange;
const getRangePointValue = __test__.getRangePointValueAtDate;
const getRangeDelta = __test__.getRangeTotalPnlDelta;
const sumAccountRangeDeltas = __test__.sumAccountRangeTotalPnlDeltas;
const reconcileRangeBreakdown = __test__.reconcileRangeBreakdown;

test('range breakdown reads current positions from the superset flattened-position cache', () => {
  const superset = {
    flattenedPositions: [
      { accountId: 'account:target', symbol: 'TSLA', openQuantity: 123 },
      { accountId: 'account:other', symbol: 'TSLA', openQuantity: 456 },
    ],
  };

  assert.deepEqual(
    getPositions(superset, 'account:target'),
    [{ accountId: 'account:target', symbol: 'TSLA', openQuantity: 123 }]
  );
});

test('range breakdown clips an account to its cached Total P&L coverage', () => {
  const superset = {
    accountTotalPnlSeries: {
      'account:closed': {
        all: {
          periodStartDate: '2025-01-01',
          periodEndDate: '2026-07-14',
          points: [],
        },
      },
    },
  };

  assert.deepEqual(
    resolveWindow(superset, 'account:closed', '2026-07-11', '2026-07-28'),
    { startDate: '2026-07-11', endDate: '2026-07-14' }
  );
});

test('range breakdown clips the beginning of a newly opened account', () => {
  const superset = {
    accountTotalPnlSeries: {
      'account:new': {
        all: {
          periodStartDate: '2026-07-13',
          periodEndDate: '2026-08-22',
        },
      },
    },
  };

  assert.deepEqual(
    resolveWindow(superset, 'account:new', '2026-07-11', '2026-07-28'),
    { startDate: '2026-07-13', endDate: '2026-07-28' }
  );
});

test('range breakdown skips accounts with no overlap', () => {
  const superset = {
    accountTotalPnlSeries: {
      'account:old': {
        all: {
          points: [
            { date: '2026-07-09' },
            { date: '2026-07-10' },
          ],
        },
      },
    },
  };

  assert.equal(
    resolveWindow(superset, 'account:old', '2026-07-11', '2026-07-28'),
    null
  );
});

test('range breakdown preserves the requested window when coverage is unavailable', () => {
  const superset = { accountTotalPnlSeries: {} };

  assert.deepEqual(
    resolveWindow(superset, 'account:unindexed', '2026-07-11', '2026-07-28'),
    { startDate: '2026-07-11', endDate: '2026-07-28' }
  );
});

test('historical range breakdowns do not use current positions as end holdings', () => {
  const superset = { asOf: '2026-08-22T12:00:00.000Z' };

  assert.equal(shouldUseCurrentEndHoldings(superset, '2026-07-27'), false);
  assert.equal(shouldUseCurrentEndHoldings(superset, '2026-08-22'), true);
});

test('range P&L delta uses the historical series endpoints', () => {
  const series = {
    points: [
      { date: '2026-07-10', totalPnlCad: 100 },
      { date: '2026-07-27', totalPnlCad: -250 },
    ],
  };

  assert.equal(getRangePointValue(series, '2026-07-10'), 100);
  assert.equal(getRangePointValue(series, '2026-07-27'), -250);
  assert.equal(getRangeDelta(series, '2026-07-10', '2026-07-27'), -350);
});

test('range reconciliation sums the same account-level series used by the graph', () => {
  const superset = {
    accountTotalPnlSeries: {
      'account:a': {
        all: {
          points: [
            { date: '2026-07-10', totalPnlCad: 0 },
            { date: '2026-07-27', totalPnlCad: -1200 },
          ],
        },
      },
      'account:b': {
        all: {
          points: [
            { date: '2026-07-10', totalPnlCad: 50 },
            { date: '2026-07-27', totalPnlCad: -300 },
          ],
        },
      },
    },
  };
  const result = sumAccountRangeDeltas(superset, [
    { accountId: 'account:a', accountWindow: { startDate: '2026-07-10', endDate: '2026-07-27' } },
    { accountId: 'account:b', accountWindow: { startDate: '2026-07-10', endDate: '2026-07-27' } },
  ]);

  assert.equal(result.totalPnlCad, -1550);
  assert.equal(result.accountCount, 2);
  assert.deepEqual(result.missingAccountIds, []);
});

test('range breakdown adds an explicit residual to reconcile with the account total', () => {
  const reconciled = reconcileRangeBreakdown(
    {
      entries: [{ symbol: 'TSLA', totalPnlCad: -2400 }],
      entriesNoFx: [{ symbol: 'TSLA', totalPnlCad: -2400 }],
    },
    -3800
  );

  const actualTotal = reconciled.entries.reduce((sum, entry) => sum + entry.totalPnlCad, 0);
  const noFxTotal = reconciled.entriesNoFx.reduce((sum, entry) => sum + entry.totalPnlCad, 0);
  const residual = reconciled.entries.find((entry) => entry.isResidual);
  assert.equal(actualTotal, -3800);
  assert.equal(noFxTotal, -3800);
  assert.equal(residual.symbol, 'OTHER / UNALLOCATED');
  assert.equal(residual.totalPnlCad, -1400);
  assert.equal(reconciled.breakdownReconciled, true);
});
