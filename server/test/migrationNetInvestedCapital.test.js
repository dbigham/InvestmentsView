const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('migration-spliced household basis follows an explicit Questrade-to-Wealthsimple link', () => {
  const result = __test__.computeMigrationReconciledNetInvestedCapital({
    fundingMap: {
      wsCore: { netDeposits: { allTimeCad: 1500 } },
      wsUnpaired: { netDeposits: { allTimeCad: 200 } },
    },
    seriesMap: {
      qCore: {
        all: {
          points: [
            { date: '2026-06-28', equityCad: 1000, cumulativeNetDepositsCad: 999 },
            { date: '2026-06-29', equityCad: 0, cumulativeNetDepositsCad: -1 },
          ],
        },
      },
      wsCore: {
        all: {
          points: [
            { date: '2026-06-29', equityCad: 1000, cumulativeNetDepositsCad: 1000 },
            { date: '2026-08-22', equityCad: 1500, cumulativeNetDepositsCad: 1500 },
          ],
        },
      },
    },
    accounts: [
      { id: 'qCore', displayName: 'Q: Historical Core', migratedTo: 'wsCore', closed: true },
      { id: 'wsCore', displayName: 'Destination Account', historyStartDate: '2026-06-29' },
      { id: 'wsUnpaired', displayName: 'Unpaired', historyStartDate: '2026-07-01' },
    ],
    accountIds: ['wsCore', 'wsUnpaired'],
  });

  assert.deepEqual(result, {
    combinedCad: 1699,
    allTimeCad: 1699,
    method: 'migration-spliced-household-basis',
    migrationPairCount: 1,
    reconciledAccountCount: 1,
    fallbackAccountCount: 1,
  });
});

test('zero-only historical source does not turn a Wealthsimple opening transfer into a household withdrawal', () => {
  const result = __test__.computeMigrationReconciledNetInvestedCapital({
    fundingMap: {
      ws: { netDeposits: { allTimeCad: 2000 } },
    },
    seriesMap: {
      q: {
        all: {
          points: [{ date: '2026-06-28', equityCad: 0, cumulativeNetDepositsCad: 0 }],
        },
      },
      ws: {
        all: {
          points: [{ date: '2026-06-29', equityCad: 2000, cumulativeNetDepositsCad: 2000 }],
        },
      },
    },
    accounts: [
      { id: 'q', displayName: 'Q: Empty', migratedTo: 'ws', closed: true },
      { id: 'ws', displayName: 'Destination', historyStartDate: '2026-06-29' },
    ],
    accountIds: ['ws'],
  });

  assert.equal(result, null);
});

test('matching names without an explicit migration link does not create a pair', () => {
  const result = __test__.computeMigrationReconciledNetInvestedCapital({
    fundingMap: {
      ws: { netDeposits: { allTimeCad: 2000 } },
    },
    seriesMap: {
      ws: {
        all: {
          points: [{ date: '2026-06-29', equityCad: 2000, cumulativeNetDepositsCad: 2000 }],
        },
      },
    },
    accounts: [
      { id: 'q', displayName: 'Q: Same Name', closed: true },
      { id: 'ws', displayName: 'Same Name', historyStartDate: '2026-06-29' },
    ],
    accountIds: ['ws'],
  });

  assert.equal(result, null);
});

test('stale or duplicate migration links do not silently create a pair', () => {
  const baseInput = {
    fundingMap: {
      ws: { netDeposits: { allTimeCad: 2000 } },
    },
    seriesMap: {
      ws: {
        all: {
          points: [
            { date: '2026-06-29', equityCad: 2000, cumulativeNetDepositsCad: 2000 },
            { date: '2026-08-22', equityCad: 2000, cumulativeNetDepositsCad: 2000 },
          ],
        },
      },
    },
    accounts: [{ id: 'ws', displayName: 'Destination', historyStartDate: '2026-06-29' }],
    accountIds: ['ws'],
  };

  assert.equal(
    __test__.computeMigrationReconciledNetInvestedCapital({
      ...baseInput,
      accounts: [
        ...baseInput.accounts,
        { id: 'q', displayName: 'Q: Stale', migratedTo: 'missing', closed: true },
      ],
    }),
    null
  );

  assert.equal(
    __test__.computeMigrationReconciledNetInvestedCapital({
      ...baseInput,
      accounts: [
        ...baseInput.accounts,
        { id: 'q1', displayName: 'Q: First', migratedTo: 'ws', closed: true },
        { id: 'q2', displayName: 'Q: Second', migratedTo: 'ws', closed: true },
      ],
    }),
    null
  );
});
