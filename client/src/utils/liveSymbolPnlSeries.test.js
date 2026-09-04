import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLivePortfolioSnapshotToPnlSeries,
  applyLivePriceToSymbolPnlSeries,
  computeAccountSeriesExternalFlowCad,
  computeLivePositionValueDeltaCad,
  computeSeriesEquityBasisAdjustmentCad,
  resolveLatestMarketDateKey,
  shouldApplyLivePortfolioSnapshotToSeries,
  shouldApplyLiveSeriesToFundingSummary,
} from './liveSymbolPnlSeries.js';

// All accounts Net invested is an accounting basis supplied by the server.
// A live chart continuity estimate must not back-solve and replace that basis.
test('does not apply a live aggregate series estimate to the funding card', () => {
  assert.equal(
    shouldApplyLiveSeriesToFundingSummary({
      isAggregateSelection: true,
      symbolExclusionActive: false,
    }),
    false
  );
  assert.equal(
    shouldApplyLiveSeriesToFundingSummary({
      isAggregateSelection: true,
      symbolExclusionActive: true,
    }),
    true
  );
  assert.equal(
    shouldApplyLiveSeriesToFundingSummary({
      isAggregateSelection: false,
      symbolExclusionActive: false,
    }),
    true
  );
});

test('does not re-anchor an authoritative aggregate series from delayed live P&L', () => {
  assert.equal(
    shouldApplyLivePortfolioSnapshotToSeries({
      isAggregateSelection: true,
      symbolExclusionActive: false,
    }),
    false
  );
  assert.equal(
    shouldApplyLivePortfolioSnapshotToSeries({
      isAggregateSelection: false,
      symbolExclusionActive: false,
    }),
    true
  );
});

test('uses the latest quote market date after midnight instead of the refresh date', () => {
  assert.equal(resolveLatestMarketDateKey(
    [{ priceAsOf: '2026-08-27T02:30:00Z' }],
    '2026-08-27T04:41:47Z'
  ), '2026-08-26');
});

test('updates the final symbol P&L point from a same-day live quote', () => {
  const series = {
    points: [
      { date: '2026-08-25', equityCad: 1084, totalPnlCad: 285, priceNative: 6.685 },
      {
        date: '2026-08-26',
        equityCad: 1088.85,
        totalPnlCad: 290.07,
        usdSecurityValue: 785.07,
        priceNative: 6.71,
        priceCad: 9.31,
      },
    ],
    summary: {
      totalEquityCad: 1088.85,
      totalPnlCad: 290.07,
      totalPnlAllTimeCad: 290.07,
      priceNative: 6.71,
      priceCad: 9.31,
    },
  };

  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      currency: 'USD',
      openQuantity: 117,
      currentPrice: 8.4017,
      priceAsOf: '2026-08-26T22:09:43Z',
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.38695]]),
  });

  const expectedDeltaNative = (8.4017 - 6.71) * 117;
  const expectedDeltaCad = expectedDeltaNative * 1.38695;
  assert.ok(Math.abs(updated.points.at(-1).totalPnlCad - (290.07 + expectedDeltaCad)) < 1e-9);
  assert.ok(Math.abs(updated.summary.totalEquityCad - (1088.85 + expectedDeltaCad)) < 1e-9);
  assert.equal(updated.points.at(-1).priceNative, 8.4017);
  assert.equal(updated.points[0], series.points[0]);
  assert.notEqual(updated, series);
});

test('does not apply a quote from a different market date', () => {
  const series = {
    points: [{ date: '2026-08-25', equityCad: 100, totalPnlCad: 5, priceNative: 10 }],
    summary: { totalEquityCad: 100, totalPnlCad: 5 },
  };
  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      currency: 'USD',
      openQuantity: 10,
      currentPrice: 12,
      priceAsOf: '2026-08-26T12:00:00Z',
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.4]]),
  });

  assert.equal(updated, series);
});

test('uses the current summary date when the provider position has no quote timestamp', () => {
  const series = {
    points: [{ date: '2026-08-26', equityCad: 100, totalPnlCad: 5, priceNative: 10 }],
    summary: { totalEquityCad: 100, totalPnlCad: 5 },
  };
  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      currency: 'USD',
      openQuantity: 10,
      currentPrice: 12,
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.4]]),
    asOf: '2026-08-26T22:03:14Z',
  });

  assert.equal(updated.points.at(-1).totalPnlCad, 33);
  assert.equal(updated.points.at(-1).priceNative, 12);
});

test('updates an aggregate position whose refreshed quote timestamp is preserved', () => {
  const series = {
    points: [{ date: '2026-08-26', equityCad: 1371.42, totalPnlCad: -905.42, priceNative: 6.71 }],
    summary: { totalEquityCad: 1371.42, totalPnlCad: -905.42 },
  };
  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      accountId: 'all',
      currency: 'USD',
      openQuantity: 117,
      currentPrice: 8.42,
      priceAsOf: '2026-08-26T22:20:00Z',
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.388]]),
  });

  const expectedDeltaCad = (8.42 - 6.71) * 117 * 1.388;
  assert.notEqual(updated, series);
  assert.ok(Math.abs(updated.points.at(-1).totalPnlCad - (-905.42 + expectedDeltaCad)) < 1e-9);
  assert.equal(updated.points.at(-1).priceNative, 8.42);
});

test('reconciles today\'s aggregate point from live equity and verified flows', () => {
  const series = {
    points: [
      { date: '2026-08-25', equityCad: 200000, cumulativeNetDepositsCad: 150000, totalPnlCad: 50000 },
      {
        date: '2026-08-26',
        equityCad: 199000,
        cumulativeNetDepositsCad: 150000,
        totalPnlCad: 49000,
        equitySinceDisplayStartCad: 99000,
        totalPnlSinceDisplayStartCad: 24000,
      },
    ],
    summary: {
      totalEquityCad: 199000,
      netDepositsCad: 160000,
      netDepositsAllTimeCad: 150000,
      totalPnlCad: 49000,
      totalPnlAllTimeCad: 49000,
      totalEquitySinceDisplayStartCad: 99000,
      totalPnlSinceDisplayStartCad: 24000,
    },
  };
  const updated = applyLivePortfolioSnapshotToPnlSeries(series, {
    totalEquityCad: 205264,
    externalFlowCad: 0,
    positions: [{ priceAsOf: '2026-08-26T22:30:00Z' }],
  });

  assert.equal(updated.points.at(-1).equityCad, 205264);
  assert.equal(updated.points.at(-1).totalPnlCad, 55264);
  assert.equal(updated.summary.totalPnlAllTimeCad, 55264);
  assert.equal(updated.summary.netDepositsCad, 160000);
  assert.equal(updated.summary.netDepositsAllTimeCad, 150000);
  assert.equal(updated.points.at(-1).totalPnlCad - updated.points[0].totalPnlCad, 5264);
});

test('does not treat a null authoritative capital as zero for an individual account', () => {
  const series = {
    displayStartDate: '2025-04-30',
    points: [
      { date: '2026-08-25', equityCad: 140922, cumulativeNetDepositsCad: 134437, totalPnlCad: 6485 },
      { date: '2026-08-26', equityCad: 140150, cumulativeNetDepositsCad: 134437, totalPnlCad: 5713 },
    ],
    summary: {
      totalEquityCad: 140150,
      totalPnlCad: 5713,
      totalPnlAllTimeCad: 5713,
      totalPnlSinceDisplayStartCad: -8362,
      displayStartTotals: {
        equityCad: 38170,
        cumulativeNetDepositsCad: 44167,
        totalPnlCad: -5997,
      },
    },
  };
  const updated = applyLivePortfolioSnapshotToPnlSeries(series, {
    totalEquityCad: 141986,
    externalFlowCad: 0,
    currentCapitalCad: null,
    asOf: '2026-08-26T22:30:00Z',
  });

  assert.deepEqual(updated.points.map((point) => point.cumulativeNetDepositsCad), [134437, 134437]);
  assert.equal(updated.points.at(-1).totalPnlCad, 7549);
  assert.equal(updated.points.at(-1).totalPnlCad - updated.points[0].totalPnlCad, 1064);
  assert.equal(updated.points.at(-1).totalPnlSinceDisplayStartCad, 13546);
  assert.equal(updated.summary.totalPnlSinceDisplayStartCad, 13546);
  assert.equal(updated.summary.totalEquitySinceDisplayStartCad, 103816);
});

test('preserves today\'s deposits when reconciling live aggregate equity', () => {
  const series = {
    points: [
      { date: '2026-08-25', equityCad: 200000, cumulativeNetDepositsCad: 150000, totalPnlCad: 50000 },
      { date: '2026-08-26', equityCad: 209000, cumulativeNetDepositsCad: 160000, totalPnlCad: 49000 },
    ],
    summary: {
      netDepositsCad: 170000,
      netDepositsAllTimeCad: 160000,
      totalEquityCad: 209000,
      totalPnlAllTimeCad: 49000,
    },
  };
  const updated = applyLivePortfolioSnapshotToPnlSeries(series, {
    totalEquityCad: 215264,
    externalFlowCad: 10000,
    asOf: '2026-08-26T22:30:00Z',
  });

  assert.equal(updated.points.at(-1).cumulativeNetDepositsCad, 160000);
  assert.equal(updated.summary.netDepositsCad, 170000);
  assert.equal(updated.summary.netDepositsAllTimeCad, 160000);
  assert.equal(updated.points.at(-1).totalPnlCad, 55264);
  assert.equal(updated.points.at(-1).totalPnlCad - updated.points[0].totalPnlCad, 5264);
});

test('reconciles current capital without shifting historical P&L', () => {
  const series = {
    points: [
      { date: '2026-08-24', equityCad: 1000, cumulativeNetDepositsCad: 800, totalPnlCad: 200 },
      { date: '2026-08-25', equityCad: 1100, cumulativeNetDepositsCad: 900, totalPnlCad: 200 },
      {
        date: '2026-08-26',
        equityCad: 1200,
        cumulativeNetDepositsCad: 1000,
        totalPnlCad: 200,
        cumulativeNetDepositsSinceDisplayStartCad: 200,
      },
    ],
    summary: {
      totalEquityCad: 1200,
      netDepositsCad: 900,
      netDepositsAllTimeCad: 900,
      totalPnlCad: 300,
      totalPnlAllTimeCad: 300,
    },
  };
  const updated = applyLivePortfolioSnapshotToPnlSeries(series, {
    totalEquityCad: 1250,
    externalFlowCad: 0,
    currentCapitalCad: 1000,
    asOf: '2026-08-26T22:30:00Z',
  });

  assert.deepEqual(
    updated.points.map((point) => point.cumulativeNetDepositsCad),
    [800, 900, 1000]
  );
  assert.equal(
    updated.points[1].cumulativeNetDepositsCad - updated.points[0].cumulativeNetDepositsCad,
    100
  );
  assert.deepEqual(updated.points.map((point) => point.totalPnlCad), [200, 200, 250]);
  assert.equal(updated.summary.totalEquityCad, 1250);
  assert.equal(updated.summary.netDepositsCad, 1000);
  assert.equal(updated.summary.netDepositsAllTimeCad, 1000);
  assert.equal(updated.summary.totalPnlCad, 250);
  assert.equal(updated.summary.totalPnlAllTimeCad, 250);
  assert.equal(updated.summary.totalEquityCad - updated.summary.netDepositsAllTimeCad, 250);
  assert.equal(updated.points.at(-1).totalPnlCad - updated.points[1].totalPnlCad, 50);
  assert.equal(updated.points.at(-1).cumulativeNetDepositsSinceDisplayStartCad, 200);
});

test('uses provider day P&L when a new account prevents flow continuity', () => {
  const series = {
    points: [
      { date: '2026-09-01', equityCad: 1200, cumulativeNetDepositsCad: 1000, totalPnlCad: 200 },
      { date: '2026-09-02', equityCad: 1250, cumulativeNetDepositsCad: 1100, totalPnlCad: 150 },
    ],
    summary: {
      totalEquityCad: 1250,
      netDepositsCad: 1100,
      netDepositsAllTimeCad: 1100,
      totalPnlCad: 150,
      totalPnlAllTimeCad: 150,
    },
  };
  const updated = applyLivePortfolioSnapshotToPnlSeries(series, {
    totalEquityCad: 1250,
    externalFlowCad: null,
    dayPnlCad: 25,
    currentCapitalCad: 1100,
    positions: [{ priceAsOf: '2026-09-02T15:00:00.000Z' }],
    asOf: '2026-09-02T15:00:00.000Z',
  });

  assert.deepEqual(updated.points.map((point) => point.totalPnlCad), [200, 225]);
  assert.deepEqual(
    updated.points.map((point) => point.cumulativeNetDepositsCad),
    [1000, 1025]
  );
  assert.equal(updated.summary.totalPnlCad, 225);
  assert.equal(updated.summary.netDepositsCad, 1025);
});

test('does not reconcile aggregate equity against a stale series date', () => {
  const series = {
    points: [
      { date: '2026-08-24', equityCad: 198000, cumulativeNetDepositsCad: 150000, totalPnlCad: 48000 },
      { date: '2026-08-25', equityCad: 200000, cumulativeNetDepositsCad: 150000, totalPnlCad: 50000 },
    ],
    summary: { totalEquityCad: 200000, totalPnlAllTimeCad: 50000 },
  };
  const updated = applyLivePortfolioSnapshotToPnlSeries(series, {
    totalEquityCad: 205264,
    externalFlowCad: 0,
    asOf: '2026-08-26T22:30:00Z',
  });

  assert.equal(updated, series);
});

test('sums current-day external flows from the underlying account series', () => {
  const seriesMap = {
    accountA: { all: { points: [
      { date: '2026-08-25', totalPnlCad: 1000, cumulativeNetDepositsCad: 5000 },
      { date: '2026-08-26', totalPnlCad: 1120, cumulativeNetDepositsCad: 5200 },
    ] } },
    accountB: { all: { points: [
      { date: '2026-08-25', totalPnlCad: 500, cumulativeNetDepositsCad: 2000 },
      { date: '2026-08-26', totalPnlCad: 470, cumulativeNetDepositsCad: 1950 },
    ] } },
    closedAccount: { all: { points: [
      { date: '2026-08-24', totalPnlCad: 50, cumulativeNetDepositsCad: 100 },
      { date: '2026-08-25', totalPnlCad: 55, cumulativeNetDepositsCad: 100 },
    ] } },
  };

  assert.equal(computeAccountSeriesExternalFlowCad(seriesMap, {
    accountIds: ['accountA', 'accountB', 'closedAccount'],
    requiredAccountIds: ['accountA', 'accountB'],
    marketDateKey: '2026-08-26',
  }), 150);
  assert.equal(computeAccountSeriesExternalFlowCad(seriesMap, {
    accountIds: ['accountA', 'closedAccount'],
    requiredAccountIds: ['accountA', 'accountB'],
    marketDateKey: '2026-08-26',
  }), null);
});

test('adds only the incremental live quote value in CAD', () => {
  const basePositions = [
    { accountId: 'a', symbol: 'USD1', currency: 'USD', currentMarketValue: 1000 },
    { accountId: 'a', symbol: 'CAD1', currency: 'CAD', currentMarketValue: 500 },
  ];
  const livePositions = [
    { accountId: 'a', symbol: 'USD1', currency: 'USD', currentMarketValue: 1010 },
    { accountId: 'a', symbol: 'CAD1', currency: 'CAD', currentMarketValue: 495 },
  ];

  assert.equal(computeLivePositionValueDeltaCad(basePositions, livePositions, {
    currencyRates: new Map([['CAD', 1], ['USD', 1.4]]),
  }), 9);
});

test('recovers a stitched successor equity-basis adjustment from the final series point', () => {
  const series = {
    points: [{
      date: '2026-08-26',
      equityCad: 140150.35366932326,
      cadCash: 3.1600000000034925,
      usdCash: 0.37999999999919964,
      cadSecurityValue: 26.598952242279054,
      usdSecurityValue: 99818.56431404724,
      usdToCadRate: 1.3862,
    }],
  };

  assert.ok(
    Math.abs(computeSeriesEquityBasisAdjustmentCad(series) - 1751.5741089486692) < 1e-9
  );
});
