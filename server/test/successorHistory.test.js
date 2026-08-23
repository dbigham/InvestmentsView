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
