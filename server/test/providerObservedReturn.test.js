const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__, filterFundingActivities } = require('../src/index.js');

test('provider-observed boundary is derived from first real position activity', () => {
  const boundary = __test__.findProviderObservedStartDate([
    {
      dateKey: '2026-06-16',
      symbol: null,
      activity: { type: 'CONTRIBUTION', action: 'CONTRIBUTION', netAmount: 1000 },
    },
    {
      dateKey: '2026-07-14',
      symbol: 'VBIL',
      activity: { type: 'Trades', action: 'Buy', quantity: 10, netAmount: -500 },
    },
  ]);

  assert.equal(boundary, '2026-07-14');
});

test('complete provider period exposes cumulative and annualized money-weighted return', () => {
  const result = __test__.buildProviderObservedReturnFromSeries(
    [
      { date: '2025-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
      { date: '2025-07-01', equityCad: 160, cumulativeNetDepositsCad: 150 },
      { date: '2026-01-01', equityCad: 176, cumulativeNetDepositsCad: 150 },
    ],
    '2025-01-01',
    { activityCoverageComplete: true, accountKey: 'provider-period-test' }
  );

  assert.equal(result.startDate, '2025-01-01');
  assert.equal(result.asOf, '2026-01-01');
  assert.equal(result.observedPnlCad, 26);
  assert.equal(result.activityCoverageComplete, true);
  assert.ok(Number.isFinite(result.annualizedRate));
  assert.ok(Number.isFinite(result.cumulativeRate));
  assert.ok(Math.abs(result.annualizedRate - result.cumulativeRate) < 0.001);
});

test('incomplete provider activity coverage exposes observed P&L without fabricating XIRR', () => {
  const result = __test__.buildProviderObservedReturnFromSeries(
    [
      { date: '2025-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
      { date: '2026-01-01', equityCad: 110, cumulativeNetDepositsCad: 100 },
    ],
    '2025-01-01',
    { activityCoverageComplete: false, accountKey: 'provider-period-incomplete' }
  );

  assert.equal(result.observedPnlCad, 10);
  assert.equal(result.annualizedRate, undefined);
  assert.equal(result.cumulativeRate, undefined);
  assert.equal(result.annualizationUnavailableReason, 'provider-activity-coverage-incomplete');
});

test('bounded provider period can annualize despite incomplete pre-boundary activity coverage', () => {
  const result = __test__.buildProviderObservedReturnFromSeries(
    [
      { date: '2025-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
      { date: '2026-01-01', equityCad: 110, cumulativeNetDepositsCad: 100 },
    ],
    '2025-01-01',
    {
      activityCoverageComplete: false,
      allowIncompleteAnnualization: true,
      accountKey: 'provider-period-bounded-incomplete',
    }
  );

  assert.equal(result.activityCoverageComplete, false);
  assert.ok(Math.abs(result.annualizedRate - 0.1) < 0.000001);
  assert.ok(Math.abs(result.cumulativeRate - 0.1) < 0.000001);
  assert.equal(result.annualizationUnavailableReason, undefined);
});

test('provider headline series trims and rebases P&L from boundary equity and later external flows', () => {
  const points = [
    { date: '2026-06-16', equityCad: 1000, cumulativeNetDepositsCad: 1000, totalPnlCad: 0 },
    { date: '2026-07-14', equityCad: 1200, cumulativeNetDepositsCad: 1000, totalPnlCad: 200 },
    { date: '2026-07-20', equityCad: 1280, cumulativeNetDepositsCad: 1050, totalPnlCad: 230 },
    { date: '2026-08-14', equityCad: 1320, cumulativeNetDepositsCad: 1050, totalPnlCad: 270 },
  ];
  const headline = __test__.buildProviderObservedHeadlineSeries(points, {
    startDate: '2026-07-14',
    activityCoverageComplete: true,
  });

  assert.deepEqual(headline.points.map((point) => point.date), [
    '2026-07-14',
    '2026-07-20',
    '2026-08-14',
  ]);
  assert.equal(headline.points[0].totalPnlCad, 0);
  assert.equal(headline.points[0].cumulativeNetDepositsCad, 1200);
  assert.equal(headline.points[1].totalPnlCad, 30);
  assert.equal(headline.points.at(-1).totalPnlCad, 70);
  assert.equal(headline.netExternalFlowsCad, 50);
  assert.equal(headline.netDepositsCad, 1250);
  assert.equal(headline.totalPnlCad, 70);
});

test('provider headline series requires complete provider activity coverage', () => {
  const headline = __test__.buildProviderObservedHeadlineSeries(
    [{ date: '2026-07-14', equityCad: 1200, cumulativeNetDepositsCad: 1000 }],
    { startDate: '2026-07-14', activityCoverageComplete: false }
  );

  assert.equal(headline, null);
});

test('provider headline series can be displayed with incomplete activity coverage', () => {
  const headline = __test__.buildProviderObservedHeadlineSeries(
    [
      { date: '2026-07-14', equityCad: 1200, cumulativeNetDepositsCad: 1000 },
      { date: '2026-08-21', equityCad: 1120, cumulativeNetDepositsCad: 1000 },
    ],
    { startDate: '2026-07-14', activityCoverageComplete: false },
    { allowIncomplete: true }
  );

  assert.deepEqual(headline.points.map((point) => point.date), ['2026-07-14', '2026-08-21']);
  assert.equal(headline.points[0].totalPnlCad, 0);
  assert.equal(headline.totalPnlCad, -80);
  assert.equal(headline.netDepositsCad, 1200);
});

test('SnapTrade cash refunds become event-date external flows without classifying security refunds', async () => {
  const cashRefund = {
    source: 'snaptrade',
    type: 'REFUND',
    action: 'REFUND',
    symbol: 'USD',
    currency: 'USD',
    quantity: 0,
    netAmount: 172.5,
    grossAmount: 172.5,
    tradeDate: '2026-07-16T20:48:16.668Z',
  };
  const securityRefund = { ...cashRefund, symbol: 'MU', quantity: 0 };
  const nonSnapTradeRefund = { ...cashRefund, source: 'questrade' };

  assert.deepEqual(filterFundingActivities([cashRefund, securityRefund, nonSnapTradeRefund]), [
    cashRefund,
  ]);

  const daily = await __test__.computeDailyNetDeposits(
    { activities: [cashRefund] },
    {},
    'snaptrade-refund-test',
    { usdRatesByDate: new Map([['2026-07-16', 1.4033]]) }
  );
  const refundCad = 172.5 * 1.4033;
  assert.ok(Math.abs(daily.perDay.get('2026-07-16') - refundCad) < 1e-9);

  const headline = __test__.buildProviderObservedHeadlineSeries(
    [
      { date: '2026-07-14', equityCad: 11398.826515, cumulativeNetDepositsCad: 11398.826515 },
      { date: '2026-07-15', equityCad: 10926.412157, cumulativeNetDepositsCad: 11398.826515 },
      {
        date: '2026-07-16',
        equityCad: 10645.186647,
        cumulativeNetDepositsCad: 11398.826515 + refundCad,
      },
      {
        date: '2026-07-23',
        equityCad: 11372.298906,
        cumulativeNetDepositsCad: 11398.826515 + refundCad,
      },
    ],
    { startDate: '2026-07-14', activityCoverageComplete: true }
  );

  assert.equal(headline.points[0].totalPnlCad, 0);
  assert.ok(Math.abs(headline.netExternalFlowsCad - refundCad) < 1e-9);
  assert.ok(Math.abs(headline.points[1].totalPnlCad - -472.414358) < 1e-6);
  assert.ok(Math.abs(headline.points[2].totalPnlCad - -995.709118) < 1e-6);
  assert.ok(Math.abs(headline.totalPnlCad - -268.596859) < 1e-6);
  assert.equal(headline.points.at(-1).equityCad, 11372.298906);
});

test('opening reconciliation preserves canonical deployment and observed-period return while suppressing all-time XIRR', () => {
  const fundingSummary = {
    annualizedReturn: { rate: 0.2, method: 'xirr' },
    annualizedReturnAllTime: { rate: 0.25, method: 'xirr' },
  };
  __test__.applyOpeningFundingReconciliationToSummary(fundingSummary, {
    openingFundingAdjustmentCad: 200,
    cashFlowCoverageIncomplete: true,
    netDepositsCad: 1200,
    netDepositsAllTimeCad: 1200,
    reserveValueCad: 1020,
    deployedValueCad: 300,
    deployedPercent: 22.73,
    providerObservedReturn: {
      startDate: '2026-07-14',
      asOf: '2026-08-14',
      annualizedRate: 0.12,
      cumulativeRate: 0.0097,
      activityCoverageComplete: true,
    },
  });

  assert.equal(fundingSummary.deploymentSummary.reserveValueCad, 1020);
  assert.equal(fundingSummary.deploymentSummary.deployedValueCad, 300);
  assert.equal(fundingSummary.providerObservedReturn.startDate, '2026-07-14');
  assert.equal(fundingSummary.providerObservedReturn.annualizedRate, 0.12);
  assert.equal(fundingSummary.annualizedReturn.rate, undefined);
  assert.equal(fundingSummary.annualizedReturnAllTime.rate, undefined);
  assert.equal(fundingSummary.annualizedReturn.incomplete, true);
});

test('aggregate funding adopts the reconciled per-account series summary', () => {
  const fundingSummary = {
    netDeposits: { combinedCad: 9176.96125, allTimeCad: 9176.96125 },
    totalPnl: { combinedCad: 2108.61758796, allTimeCad: 2108.61758796 },
    totalEquityCad: 11285.57883796,
    annualizedReturn: { rate: 35.66, method: 'xirr' },
    annualizedReturnAllTime: { rate: 35.66, method: 'xirr' },
  };
  __test__.applyTotalPnlSeriesSummaryToFundingSummary(
    fundingSummary,
    {
      summary: {
        netDepositsCad: 12277.831832212096,
        netDepositsAllTimeCad: 12277.831832212096,
        totalPnlCad: -992.252994252096,
        totalPnlAllTimeCad: -992.252994252096,
        totalPnlSinceDisplayStartCad: -992.252994252096,
        totalEquityCad: 11285.57883796,
        openingFundingAdjustmentCad: 3100.8705822120955,
        cashFlowCoverageIncomplete: true,
      },
    },
    { id: 'aggregate-series-test-account', archived: false }
  );

  assert.equal(fundingSummary.netDeposits.combinedCad, 12277.831832212096);
  assert.equal(fundingSummary.netDeposits.allTimeCad, 12277.831832212096);
  assert.equal(fundingSummary.totalPnl.combinedCad, -992.252994252096);
  assert.equal(fundingSummary.openingFundingReconciled, true);
  assert.equal(fundingSummary.openingFundingAdjustmentCad, 3100.8705822120955);
  assert.equal(fundingSummary.annualizedReturn.rate, undefined);
  assert.equal(fundingSummary.annualizedReturnAllTime.rate, undefined);
  assert.equal(fundingSummary.annualizedReturn.incomplete, true);
});

test('incomplete series coverage suppresses stale annualized rates without an opening adjustment', () => {
  const fundingSummary = {
    annualizedReturn: { rate: 35.66, method: 'xirr' },
    annualizedReturnAllTime: { rate: 35.66, method: 'xirr' },
  };

  __test__.applyOpeningFundingReconciliationToSummary(fundingSummary, {
    cashFlowCoverageIncomplete: true,
    historyStartDate: '2026-07-13',
    historyStartDateEstimated: true,
    estimatedHistoryReturn: {
      startDate: '2026-07-13',
      annualizedRate: -0.32,
      estimated: true,
    },
  });

  assert.equal(fundingSummary.annualizedReturn.rate, undefined);
  assert.equal(fundingSummary.annualizedReturnAllTime.rate, undefined);
  assert.equal(fundingSummary.annualizedReturn.incomplete, true);
  assert.equal(fundingSummary.historyStartDate, '2026-07-13');
  assert.equal(fundingSummary.estimatedHistoryReturn.estimated, true);
});
