const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('Toronto market date does not roll forward at midnight UTC', () => {
  assert.equal(
    __test__.getTorontoDateKey(new Date('2026-08-27T00:41:47Z')),
    '2026-08-26'
  );
});

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
    reconciliationStartDate: '2026-06-29',
  });
});

test('migration-aware aggregate history rejects a discontinuous opening-capital adjustment', () => {
  const result = __test__.applyMigrationReconciledCapitalBasisToSeries({
    aggregateSeries: {
      points: [
        { date: '2026-06-28', equityCad: 1300, cumulativeNetDepositsCad: 1200, totalPnlCad: 100 },
        { date: '2026-06-29', equityCad: 1325, cumulativeNetDepositsCad: 1200, totalPnlCad: 125 },
        { date: '2026-08-22', equityCad: 2050, cumulativeNetDepositsCad: 1700, totalPnlCad: 350 },
      ],
      summary: {
        totalEquityCad: 2050,
        netDepositsCad: 1700,
        netDepositsAllTimeCad: 1700,
        totalPnlCad: 350,
        totalPnlAllTimeCad: 350,
      },
    },
    fundingMap: {
      wsCore: { netDeposits: { allTimeCad: 1500 } },
      wsUnpaired: { netDeposits: { allTimeCad: 250 } },
    },
    seriesMap: {
      qCore: {
        all: {
          points: [
            { date: '2026-06-28', equityCad: 1000, cumulativeNetDepositsCad: 1000 },
            { date: '2026-06-29', equityCad: 0, cumulativeNetDepositsCad: 0 },
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
      wsUnpaired: {
        all: {
          points: [
            { date: '2026-06-01', equityCad: 200, cumulativeNetDepositsCad: 200 },
            { date: '2026-08-22', equityCad: 250, cumulativeNetDepositsCad: 200 },
          ],
        },
      },
    },
    accounts: [
      { id: 'qCore', migratedTo: 'wsCore', closed: true },
      { id: 'wsCore', historyStartDate: '2026-06-29' },
      { id: 'wsUnpaired', historyStartDate: '2026-06-01' },
    ],
    accountIds: ['wsCore', 'wsUnpaired'],
  });

  assert.deepEqual(
    result.points.map((point) => ({
      date: point.date,
      cumulativeNetDepositsCad: point.cumulativeNetDepositsCad,
      totalPnlCad: point.totalPnlCad,
    })),
    [
      { date: '2026-06-28', cumulativeNetDepositsCad: 1200, totalPnlCad: 100 },
      { date: '2026-06-29', cumulativeNetDepositsCad: 1200, totalPnlCad: 125 },
      { date: '2026-08-22', cumulativeNetDepositsCad: 1700, totalPnlCad: 350 },
    ]
  );
  assert.equal(result.summary.netDepositsAllTimeCad, 1700);
  assert.equal(result.summary.totalPnlAllTimeCad, 350);
  assert.ok(result.issues.includes('migration-capital-reconciliation-skipped-discontinuity'));
  assert.ok(!result.issues.includes('migration-reconciled-opening-capital'));
});

test('migration-aware aggregate history does not create the June-to-July P&L cliff', () => {
  const result = __test__.applyMigrationReconciledCapitalBasisToSeries({
    aggregateSeries: {
      points: [
        {
          date: '2026-06-21',
          equityCad: 1011215.96,
          cumulativeNetDepositsCad: 829243.71,
          totalPnlCad: 181972.25,
        },
        {
          date: '2026-07-10',
          equityCad: 1076256.33,
          cumulativeNetDepositsCad: 895346.04,
          totalPnlCad: 180910.29,
        },
        {
          date: '2026-09-02',
          equityCad: 1068491.76,
          cumulativeNetDepositsCad: 898806.33,
          totalPnlCad: 169685.43,
        },
      ],
      summary: {
        totalEquityCad: 1068491.76,
        netDepositsCad: 898806.33,
        netDepositsAllTimeCad: 898806.33,
        totalPnlCad: 169685.43,
        totalPnlAllTimeCad: 169685.43,
      },
    },
    fundingMap: {
      wsCore: { netDeposits: { allTimeCad: 1028859.24 } },
    },
    seriesMap: {
      qCore: {
        all: {
          points: [
            { date: '2026-06-28', equityCad: 1028859.24, cumulativeNetDepositsCad: 1028859.24 },
            { date: '2026-06-29', equityCad: 0, cumulativeNetDepositsCad: 0 },
          ],
        },
      },
      wsCore: {
        all: {
          points: [
            { date: '2026-06-29', equityCad: 1028859.24, cumulativeNetDepositsCad: 1028859.24 },
            { date: '2026-09-02', equityCad: 1068491.76, cumulativeNetDepositsCad: 1028859.24 },
          ],
        },
      },
    },
    accounts: [
      { id: 'qCore', migratedTo: 'wsCore', closed: true },
      { id: 'wsCore', historyStartDate: '2026-06-29' },
    ],
    accountIds: ['wsCore'],
  });

  assert.deepEqual(
    result.points.map((point) => ({ date: point.date, totalPnlCad: point.totalPnlCad })),
    [
      { date: '2026-06-21', totalPnlCad: 181972.25 },
      { date: '2026-07-10', totalPnlCad: 180910.29 },
      { date: '2026-09-02', totalPnlCad: 169685.43 },
    ]
  );
  assert.ok(result.issues.includes('migration-capital-reconciliation-skipped-discontinuity'));
});

test('migration-aware aggregate history removes a false final-day capital jump', () => {
  const result = __test__.applyMigrationReconciledCapitalBasisToSeries({
    aggregateSeries: {
      points: [
        { date: '2026-08-24', equityCad: 1900, cumulativeNetDepositsCad: 1600, totalPnlCad: 300 },
        { date: '2026-08-25', equityCad: 2000, cumulativeNetDepositsCad: 1700, totalPnlCad: 300 },
        { date: '2026-08-26', equityCad: 2050, cumulativeNetDepositsCad: 1750, totalPnlCad: 300 },
      ],
      summary: {},
    },
    fundingMap: {
      wsCore: { netDeposits: { allTimeCad: 1500 } },
      wsUnpaired: { netDeposits: { allTimeCad: 250 } },
    },
    seriesMap: {
      qCore: { all: { points: [
        { date: '2026-06-28', equityCad: 1500, cumulativeNetDepositsCad: 1500 },
        { date: '2026-06-29', equityCad: 0, cumulativeNetDepositsCad: 0 },
      ] } },
      wsCore: { all: { points: [
        { date: '2026-08-25', cumulativeNetDepositsCad: 1500 },
        { date: '2026-08-26', cumulativeNetDepositsCad: 1500 },
      ] } },
      wsUnpaired: { all: { points: [
        { date: '2026-08-25', cumulativeNetDepositsCad: 250 },
        { date: '2026-08-26', cumulativeNetDepositsCad: 250 },
      ] } },
    },
    accounts: [
      { id: 'qCore', migratedTo: 'wsCore', closed: true },
      { id: 'wsCore', historyStartDate: '2026-06-29' },
      { id: 'wsUnpaired', historyStartDate: '2026-06-01' },
    ],
    accountIds: ['wsCore', 'wsUnpaired'],
  });

  assert.deepEqual(
    result.points.map((point) => point.cumulativeNetDepositsCad),
    [1650, 1750, 1750]
  );
  assert.deepEqual(result.points.map((point) => point.totalPnlCad), [250, 250, 300]);
  assert.equal(result.summary.netDepositsAllTimeCad, 1750);
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
