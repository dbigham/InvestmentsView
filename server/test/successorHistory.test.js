const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('historical successor mapping follows explicit closed-account links only', () => {
  const source = { id: 'q:source', closed: true, migratedTo: 'ws:successor' };
  const secondSource = { id: 'q:source-2', closed: true, migratedTo: 'ws:successor' };
  const openAccount = { id: 'q:open', closed: false, migratedTo: 'ws:successor' };
  const unrelated = { id: 'q:other', closed: true, migratedTo: 'ws:other' };

  assert.deepEqual(
    __test__.resolveHistoricalAccountIdsForSuccessor(
      [source, secondSource, openAccount, unrelated],
      'ws:successor'
    ),
    ['q:source', 'q:source-2']
  );
  assert.deepEqual(
    __test__.buildHistoricalAccountIdsBySuccessor([source, secondSource, unrelated]),
    {
      'ws:successor': ['q:source', 'q:source-2'],
      'ws:other': ['q:other'],
    }
  );
});

test('successor series carries historical P&L and deposited-capital basis across the handoff', () => {
  const destinationResult = {
    context: {
      account: {
        id: 'ws:successor',
        historyStartDate: '2026-07-13',
      },
    },
    series: {
      points: [
        { date: '2026-07-12', equityCad: 800, cumulativeNetDepositsCad: 800, totalPnlCad: 0 },
        { date: '2026-07-13', equityCad: 1000, cumulativeNetDepositsCad: 1000, totalPnlCad: 0 },
        { date: '2026-07-14', equityCad: 1100, cumulativeNetDepositsCad: 1000, totalPnlCad: 100 },
      ],
      summary: {
        totalPnlCad: 100,
        totalPnlAllTimeCad: 100,
        netDepositsCad: 1000,
        netDepositsAllTimeCad: 1000,
      },
    },
  };
  const historicalResult = {
    context: { account: { id: 'q:source', closed: true } },
    series: {
      points: [
        { date: '2026-07-12', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
      ],
    },
  };

  const stitched = __test__.stitchSuccessorSeriesResult(destinationResult, [historicalResult]);

  assert.equal(stitched.series.points[0].totalPnlCad, 0, 'pre-handoff points stay untouched');
  assert.equal(stitched.series.points[1].totalPnlCad, 100);
  assert.equal(stitched.series.points[1].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.points[2].totalPnlCad, 200);
  assert.equal(stitched.series.points[2].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.summary.totalPnlCad, 200);
  assert.equal(stitched.series.summary.netDepositsCad, 900);
});

test('stitched successor metadata uses the reconstructed series start', () => {
  const marked = __test__.markStitchedSuccessorSeries({
    periodStartDate: '2025-01-23',
    points: [{ date: '2025-01-23', equityCad: 100 }],
  });

  assert.equal(marked.historyStartDate, '2025-01-23');
  assert.equal(marked.historyStartDateEstimated, true);
  assert.equal(marked.stitchedFromHistorical, true);
});
