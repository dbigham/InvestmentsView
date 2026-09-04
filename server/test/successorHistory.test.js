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

test('cached successor summaries are rebuilt when their series omits linked history', () => {
  const selection = { type: 'account', requestedId: 'ws:successor' };
  const base = {
    resolvedAccountId: 'ws:successor',
    historicalAccountIdsBySuccessor: { 'ws:successor': ['q:source'] },
    accountTotalPnlSeries: {
      'ws:successor': { all: { points: [{ date: '2026-07-02' }] } },
    },
  };

  assert.equal(__test__.summaryNeedsSuccessorHistoryRebuild(base, selection), true);
  assert.equal(__test__.supersetHasSuccessorHistory(base, selection), true);
  base.accountTotalPnlSeries['ws:successor'].all.stitchedFromHistorical = true;
  assert.equal(__test__.summaryNeedsSuccessorHistoryRebuild(base, selection), false);
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
        {
          date: '2026-07-13',
          equityCad: 1000,
          cumulativeNetDepositsCad: 1000,
          totalPnlCad: 0,
          totalPnlSinceDisplayStartCad: 0,
          equitySinceDisplayStartCad: 0,
          cumulativeNetDepositsSinceDisplayStartCad: 0,
        },
        {
          date: '2026-07-14',
          equityCad: 1100,
          cumulativeNetDepositsCad: 1000,
          totalPnlCad: 100,
          totalPnlSinceDisplayStartCad: 100,
          equitySinceDisplayStartCad: 100,
          cumulativeNetDepositsSinceDisplayStartCad: 0,
        },
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

  assert.equal(stitched.series.points[0].totalPnlCad, 100, 'historical points are preserved before the handoff');
  assert.equal(stitched.series.points[0].equityCad, 1000);
  assert.equal(stitched.series.points[0].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.points[1].totalPnlCad, 100);
  assert.equal(stitched.series.points[1].totalPnlSinceDisplayStartCad, undefined);
  assert.equal(stitched.series.points[1].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.points[2].totalPnlCad, 200);
  assert.equal(stitched.series.points[2].totalPnlSinceDisplayStartCad, undefined);
  assert.equal(stitched.series.points[2].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.summary.totalPnlCad, 200);
  assert.equal(stitched.series.summary.totalPnlAllTimeCad, 200);
  assert.equal(stitched.series.summary.netDepositsCad, 900);
  assert.equal(stitched.series.summary.netDepositsAllTimeCad, 900);
  assert.equal(stitched.series.summary.totalPnlSinceDisplayStartCad, 100);
  assert.equal(stitched.series.summary.totalEquitySinceDisplayStartCad, 100);
  assert.equal(stitched.series.summary.netDepositsSinceDisplayStartCad, 0);
});

test('current snapshots are not applied to an older market-day point', () => {
  assert.equal(__test__.isCurrentSnapshotDate('2026-08-23', '2026-08-23'), true);
  assert.equal(__test__.isCurrentSnapshotDate('2026-08-21', '2026-08-23'), false);
  assert.equal(__test__.isWeekendDateKey('2026-08-23'), true);
  assert.equal(__test__.isWeekendDateKey('2026-08-21'), false);
});

test('successor points are rebased to the historical boundary when transfer snapshots differ', () => {
  const stitched = __test__.stitchSuccessorSeriesResult(
    {
      context: { account: { id: 'ws:successor', historyStartDate: '2026-07-13' } },
      series: {
        points: [
          { date: '2026-07-13', equityCad: 1000, cumulativeNetDepositsCad: 1000, totalPnlCad: 0 },
          { date: '2026-07-14', equityCad: 1100, cumulativeNetDepositsCad: 1000, totalPnlCad: 100 },
        ],
        summary: { totalPnlCad: 100, totalPnlAllTimeCad: 100, netDepositsCad: 1000 },
      },
    },
    [
      {
        context: { account: { id: 'q:source', closed: true } },
        series: {
          points: [{ date: '2026-07-13', equityCad: 1200, cumulativeNetDepositsCad: 900, totalPnlCad: 300 }],
        },
      },
    ]
  );

  assert.equal(stitched.series.points[0].equityCad, 1200);
  assert.equal(stitched.series.points[0].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.points[0].totalPnlCad, 300);
  assert.equal(stitched.series.points[1].equityCad, 1300);
  assert.equal(stitched.series.points[1].cumulativeNetDepositsCad, 900);
  assert.equal(stitched.series.points[1].totalPnlCad, 400);
  assert.equal(stitched.series.summary.totalPnlCad, 400);
  assert.equal(stitched.series.summary.netDepositsCad, 900);
});

test('successor stitch ignores a predecessor transfer-out snapshot at the handoff', () => {
  const stitched = __test__.stitchSuccessorSeriesResult(
    {
      context: { account: { id: 'ws:successor', historyStartDate: '2026-07-02' } },
      series: {
        points: [
          { date: '2026-07-02', equityCad: 300, cumulativeNetDepositsCad: -1600, totalPnlCad: 1900 },
          { date: '2026-07-03', equityCad: 350, cumulativeNetDepositsCad: -1600, totalPnlCad: 1950 },
        ],
        summary: { totalPnlCad: 1950, totalPnlAllTimeCad: 1950, netDepositsCad: -1600 },
      },
    },
    [
      {
        context: { account: { id: 'q:source', closed: true } },
        series: {
          points: [
            { date: '2026-07-01', equityCad: 18000, cumulativeNetDepositsCad: 16000, totalPnlCad: 2000 },
            { date: '2026-07-02', equityCad: 300, cumulativeNetDepositsCad: -1600, totalPnlCad: 1900 },
          ],
        },
      },
    ]
  );

  assert.equal(stitched.series.points[0].date, '2026-07-01');
  assert.equal(stitched.series.points[1].date, '2026-07-02');
  assert.equal(stitched.series.points[1].equityCad, 18000);
  assert.equal(stitched.series.points[1].cumulativeNetDepositsCad, 16000);
  assert.equal(stitched.series.points[1].totalPnlCad, 2000);
  assert.equal(stitched.series.points[2].equityCad, 18050);
  assert.equal(stitched.series.points[2].cumulativeNetDepositsCad, 16000);
  assert.equal(stitched.series.points[2].totalPnlCad, 2050);
  assert.equal(stitched.series.summary.netDepositsCad, 16000);
});

test('successor stitch clips a sustained predecessor collapse before the handoff', () => {
  const stitched = __test__.stitchSuccessorSeriesResult(
    {
      context: { account: { id: 'ws:successor', historyStartDate: '2026-07-10' } },
      series: {
        points: [
          { date: '2026-07-10', equityCad: 4100, cumulativeNetDepositsCad: 4090, totalPnlCad: 10 },
          { date: '2026-07-11', equityCad: 4200, cumulativeNetDepositsCad: 4090, totalPnlCad: 110 },
        ],
        summary: { totalPnlCad: 110, totalPnlAllTimeCad: 110, netDepositsCad: 4090 },
      },
    },
    [
      {
        context: { account: { id: 'q:source', closed: true } },
        series: {
          points: [
            { date: '2026-06-20', equityCad: 4300, cumulativeNetDepositsCad: 2800, totalPnlCad: 1500 },
            { date: '2026-06-21', equityCad: 4292, cumulativeNetDepositsCad: 2793.51, totalPnlCad: 1498.49 },
            { date: '2026-06-22', equityCad: 0, cumulativeNetDepositsCad: -1488.70, totalPnlCad: 1488.70 },
            { date: '2026-07-10', equityCad: 1.39, cumulativeNetDepositsCad: -1488.70, totalPnlCad: 1490.09 },
          ],
        },
      },
    ]
  );

  assert.deepEqual(
    stitched.series.points.map((point) => point.date),
    ['2026-06-20', '2026-06-21', '2026-07-10', '2026-07-11']
  );
  assert.equal(stitched.series.points[2].equityCad, 4292);
  assert.equal(stitched.series.points[2].cumulativeNetDepositsCad, 2793.51);
  assert.ok(Math.abs(stitched.series.points[2].totalPnlCad - 1498.49) < 1e-9);
  assert.ok(Math.abs(stitched.series.summary.netDepositsCad - 2793.51) < 1e-9);
});

test('successor stitch leaves the destination unchanged when predecessor history has no usable handoff', () => {
  const destinationSeries = {
    points: [{ date: '2026-06-29', equityCad: 45000, cumulativeNetDepositsCad: 45000, totalPnlCad: 0 }],
    summary: { totalPnlCad: 0, netDepositsCad: 45000 },
  };
  const result = __test__.stitchSuccessorSeriesResult(
    { context: { account: { id: 'ws:successor', historyStartDate: '2026-06-29' } }, series: destinationSeries },
    [
      {
        context: { account: { id: 'q:source', closed: true } },
        series: { points: [{ date: '2026-06-29', equityCad: 0, cumulativeNetDepositsCad: 0, totalPnlCad: 0 }] },
      },
    ]
  );

  assert.equal(result.series, destinationSeries);
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

test('CAGR view rebases a stitched series without changing its all-time history', () => {
  const fullSeries = {
    periodStartDate: '2025-01-23',
    historyStartDate: '2025-01-23',
    points: [
      { date: '2025-01-23', equityCad: 100, cumulativeNetDepositsCad: 90, totalPnlCad: 10 },
      { date: '2025-04-30', equityCad: 200, cumulativeNetDepositsCad: 150, totalPnlCad: 50 },
      { date: '2025-05-01', equityCad: 210, cumulativeNetDepositsCad: 150, totalPnlCad: 60 },
    ],
    summary: { totalPnlCad: 60, netDepositsCad: 150 },
  };

  const cagr = __test__.deriveCagrSeriesView(fullSeries, '2025-04-30');

  assert.equal(cagr.periodStartDate, '2025-01-23');
  assert.equal(cagr.historyStartDate, '2025-01-23');
  assert.equal(cagr.displayStartDate, '2025-04-30');
  assert.equal(cagr.points.length, 3, 'the CAGR view reuses the complete stitched point set');
  assert.deepEqual(cagr.summary.displayStartTotals, {
    totalPnlCad: 50,
    equityCad: 200,
    cumulativeNetDepositsCad: 150,
  });
  assert.equal(cagr.summary.totalPnlSinceDisplayStartCad, 10);
  assert.equal(cagr.summary.totalEquitySinceDisplayStartCad, 10);
  assert.equal(cagr.summary.netDepositsSinceDisplayStartCad, 0);
});

test('CAGR view adds a zero baseline when the configured start predates available points', () => {
  const cagr = __test__.deriveCagrSeriesView(
    {
      periodStartDate: '2026-06-29',
      points: [{ date: '2026-06-29', equityCad: 1000, cumulativeNetDepositsCad: 1000, totalPnlCad: 0 }],
      summary: { totalPnlCad: 0, netDepositsCad: 1000 },
    },
    '2025-06-29'
  );

  assert.equal(cagr.periodStartDate, '2025-06-29');
  assert.equal(cagr.displayStartDate, '2025-06-29');
  assert.equal(cagr.points[0].date, '2025-06-29');
  assert.equal(cagr.points[0].totalPnlCad, 0);
  assert.equal(cagr.summary.displayStartTotals.equityCad, 0);
});

test('aggregate uses one reconstructed series for a migrated account pair', async () => {
  const source = {
    id: 'q:source',
    closed: true,
    migratedTo: 'ws:successor',
  };
  const successor = {
    id: 'ws:successor',
    historyStartDate: '2026-07-13',
  };
  const sourceSeries = {
    periodStartDate: '2026-07-12',
    periodEndDate: '2026-07-13',
    points: [
      { date: '2026-07-12', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
      { date: '2026-07-13', equityCad: 1020, cumulativeNetDepositsCad: 900, totalPnlCad: 120 },
    ],
    summary: { totalPnlCad: 120, netDepositsCad: 900, totalEquityCad: 1020 },
  };
  const successorSeries = {
    periodStartDate: '2026-07-13',
    periodEndDate: '2026-07-14',
    points: [
      { date: '2026-07-13', equityCad: 1020, cumulativeNetDepositsCad: 1020, totalPnlCad: 0 },
      { date: '2026-07-14', equityCad: 1100, cumulativeNetDepositsCad: 1020, totalPnlCad: 80 },
    ],
    summary: { totalPnlCad: 80, netDepositsCad: 1020, totalEquityCad: 1100 },
  };

  const aggregate = await __test__.computeAggregateTotalPnlSeriesForContexts(
    [
      { account: source },
      { account: successor },
    ],
    {},
    {
      applyAccountCagrStartDate: false,
      providedSeriesByAccountId: {
        [source.id]: sourceSeries,
        [successor.id]: successorSeries,
      },
    }
  );

  assert.deepEqual(
    aggregate.points.map((point) => [point.date, point.totalPnlCad]),
    [
      ['2026-07-12', 100],
      ['2026-07-13', 120],
      ['2026-07-14', 200],
    ]
  );
});

test('aggregate keeps a reconstructed weekend point instead of applying a live summary overwrite', async () => {
  const account = { id: 'ws:weekend-check' };
  const series = {
    periodStartDate: '2026-08-22',
    periodEndDate: '2026-08-23',
    points: [
      { date: '2026-08-22', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
      { date: '2026-08-23', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
    ],
    // Deliberately model a live summary that disagrees with the reconstructed
    // weekend point. The aggregate must keep the point's internally consistent
    // equity/P&L basis rather than overwrite only equity.
    summary: { totalPnlCad: 100, netDepositsCad: 900, totalEquityCad: 850 },
  };

  const aggregate = await __test__.computeAggregateTotalPnlSeriesForContexts(
    [{ account }],
    {},
    {
      applyAccountCagrStartDate: false,
      providedSeriesByAccountId: { [account.id]: series },
    }
  );

  const lastPoint = aggregate.points[aggregate.points.length - 1];
  assert.equal(lastPoint.date, '2026-08-23');
  assert.equal(lastPoint.equityCad, 1000);
  assert.equal(lastPoint.totalPnlCad, 100);
  assert.equal(aggregate.summary.totalEquityCad, 1000);
  assert.equal(
    lastPoint.equityCad,
    lastPoint.cumulativeNetDepositsCad + lastPoint.totalPnlCad
  );
});

test('aggregate preserves stitched current P&L and derives its matching net deposits', async () => {
  const account = { id: 'ws:current-invariant' };
  const series = {
    periodStartDate: '2026-09-01',
    periodEndDate: '2026-09-02',
    points: [
      { date: '2026-09-01', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
      { date: '2026-09-02', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
    ],
    summary: {
      totalEquityCad: 850,
      netDepositsCad: 900,
      totalPnlCad: 100,
    },
  };

  const aggregate = await __test__.computeAggregateTotalPnlSeriesForContexts(
    [{ account }],
    {},
    {
      applyAccountCagrStartDate: false,
      providedSeriesByAccountId: { [account.id]: series },
    }
  );

  const lastPoint = aggregate.points[aggregate.points.length - 1];
  assert.equal(lastPoint.equityCad, 850);
  assert.equal(lastPoint.cumulativeNetDepositsCad, 750);
  assert.equal(lastPoint.totalPnlCad, 100);
  assert.equal(aggregate.summary.totalEquityCad, 850);
  assert.equal(aggregate.summary.netDepositsCad, 750);
  assert.equal(aggregate.summary.netDepositsAllTimeCad, 750);
  assert.equal(aggregate.summary.totalPnlCad, 100);
  assert.equal(aggregate.summary.totalPnlAllTimeCad, 100);
  assert.equal(
    lastPoint.equityCad,
    lastPoint.cumulativeNetDepositsCad + lastPoint.totalPnlCad
  );
  assert.ok(aggregate.issues.includes('aggregate-summary-net-deposits-reconciled'));
});

// Current aggregate funding excludes closed accounts. Their historical series
// must use the same population unless an explicit successor carries them, or
// their terminal P&L disappears only at the current endpoint.
test('aggregate excludes an unpaired closed account from both history and current totals', async () => {
  const liveAccount = { id: 'live' };
  const orphanedClosedAccount = { id: 'closed', closed: true };
  const liveSeries = {
    periodStartDate: '2026-09-01',
    periodEndDate: '2026-09-02',
    points: [
      { date: '2026-09-01', equityCad: 1000, cumulativeNetDepositsCad: 900, totalPnlCad: 100 },
      { date: '2026-09-02', equityCad: 1010, cumulativeNetDepositsCad: 900, totalPnlCad: 110 },
    ],
    summary: { totalEquityCad: 1010, netDepositsCad: 900, totalPnlCad: 110 },
  };
  const closedSeries = {
    periodStartDate: '2026-09-01',
    periodEndDate: '2026-09-02',
    points: [
      { date: '2026-09-01', equityCad: 0, cumulativeNetDepositsCad: -25, totalPnlCad: 25 },
      { date: '2026-09-02', equityCad: 0, cumulativeNetDepositsCad: -25, totalPnlCad: 25 },
    ],
    summary: { totalEquityCad: 0, netDepositsCad: -25, totalPnlCad: 25 },
  };

  const aggregate = await __test__.computeAggregateTotalPnlSeriesForContexts(
    [
      { account: liveAccount },
      { account: orphanedClosedAccount },
    ],
    {},
    {
      applyAccountCagrStartDate: false,
      providedSeriesByAccountId: {
        [liveAccount.id]: liveSeries,
        [orphanedClosedAccount.id]: closedSeries,
      },
    }
  );

  assert.deepEqual(
    aggregate.points.map((point) => point.totalPnlCad),
    [100, 110]
  );
  assert.equal(aggregate.summary.totalEquityCad, 1010);
  assert.equal(aggregate.summary.netDepositsCad, 900);
  assert.equal(aggregate.summary.totalPnlCad, 110);
});
