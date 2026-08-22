const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

const resolveWindow = __test__.resolveRangeBreakdownWindowForAccount;
const getPositions = __test__.getPositionsForAccountFromSuperset;

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
