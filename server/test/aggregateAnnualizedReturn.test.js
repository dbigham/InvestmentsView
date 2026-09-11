const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('cached group selection retains aggregate history and replaces raw-flow return', () => {
  const source = { id: 'q:old', closed: true, migratedTo: 'ws:current' };
  const current = { id: 'ws:current' };
  const group = { id: 'group:retirement', accountIds: [source.id, current.id] };
  const series = {
    periodStartDate: '2023-01-01', periodEndDate: '2024-01-01',
    points: [
      { date: '2023-01-01', equityCad: 100, cumulativeNetDepositsCad: 100, totalPnlCad: 0 },
      { date: '2024-01-01', equityCad: 110, cumulativeNetDepositsCad: 100, totalPnlCad: 10 },
    ],
    summary: { totalEquityCad: 110, netDepositsAllTimeCad: 100, totalPnlAllTimeCad: 10 },
  };
  const originalFunding = {
    totalEquityCad: 110,
    netDeposits: { allTimeCad: 200 },
    totalPnl: { allTimeCad: -90 },
    annualizedReturn: { rate: 1.5 },
  };
  const superset = {
    accounts: [source, current], accountGroups: [group],
    accountFundingSummaries: { [group.id]: originalFunding },
    accountTotalPnlSeries: { [group.id]: { all: series } },
  };
  const result = __test__.deriveSummaryFromSuperset(superset, { type: 'group', requestedId: group.id, groupId: group.id });
  assert.equal(result.accountTotalPnlSeries[group.id].all, series);
  const funding = result.accountFunding[group.id];
  assert.equal(funding.totalEquityCad - funding.netDeposits.allTimeCad, funding.totalPnl.allTimeCad);
  assert.ok(Math.abs(funding.annualizedReturn.rate - 0.1) < 1e-6);
  assert.equal(originalFunding.annualizedReturn.rate, 1.5);
  assert.equal(originalFunding.netDeposits.allTimeCad, 200);
});

test('incomplete aggregate opening history publishes a reconstructed estimate', () => {
  const funding = { annualizedReturn: { rate: 1.5 }, annualizedReturnAllTime: { rate: 1.5 }, returnBreakdown: [{}] };
  __test__.rebuildAggregateAnnualizedReturnFromSeries(funding, {
    issues: ['opening-funding-reconciliation-incomplete'],
    periodStartDate: '2025-01-01', periodEndDate: '2026-01-01',
    points: [
      { date: '2025-01-01', equityCad: 100, totalPnlCad: 0 },
      { date: '2026-01-01', equityCad: 110, totalPnlCad: 10 },
    ],
  }, 'group:retirement');
  assert.ok(Math.abs(funding.annualizedReturn.rate - 0.1) < 1e-6);
  assert.equal(funding.annualizedReturn.estimated, true);
  assert.notEqual(funding.annualizedReturn.incomplete, true);
  assert.deepEqual(funding.annualizedReturnAllTime, funding.annualizedReturn);
});

test('aggregate annualized return follows the reconstructed aggregate series', () => {
  const fundingSummary = {
    annualizedReturn: { rate: 5.6317, method: 'xirr' },
    annualizedReturnAllTime: { rate: 5.6317, method: 'xirr' },
  };
  const series = {
    points: [
      { date: '2023-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
      { date: '2024-01-01', equityCad: 110, cumulativeNetDepositsCad: 100 },
    ],
  };

  __test__.rebuildAggregateAnnualizedReturnFromSeries(fundingSummary, series, 'all');

  assert.ok(Math.abs(fundingSummary.annualizedReturn.rate - 0.1) < 1e-6);
  assert.deepEqual(
    fundingSummary.annualizedReturnAllTime,
    fundingSummary.annualizedReturn
  );
  assert.equal(fundingSummary.annualizedReturn.startDate, '2023-01-01');
  assert.equal(fundingSummary.annualizedReturn.asOf, '2024-01-01');
});

test('All accounts retains a numeric estimate when account coverage is partial', () => {
  const funding = {};
  __test__.rebuildAggregateAnnualizedReturnFromSeries(funding, {
    issues: ['aggregate-partial-data'],
    points: [
      { date: '2023-01-01', equityCad: 100, totalPnlCad: 0 },
      { date: '2024-01-01', equityCad: 120, totalPnlCad: 20 },
    ],
  }, 'all');
  assert.ok(Math.abs(funding.annualizedReturn.rate - 0.2) < 1e-6);
  assert.equal(funding.annualizedReturn.estimated, true);
  assert.notEqual(funding.annualizedReturn.incomplete, true);
});

test('aggregate annualized return uses the chart-implied basis after P&L carry-forward', () => {
  const fundingSummary = {};
  const series = {
    points: [
      { date: '2023-01-01', equityCad: 100, cumulativeNetDepositsCad: 100, totalPnlCad: 0 },
      { date: '2024-01-01', equityCad: 130, cumulativeNetDepositsCad: 120, totalPnlCad: 30 },
    ],
  };

  __test__.rebuildAggregateAnnualizedReturnFromSeries(fundingSummary, series, 'all');

  assert.ok(Math.abs(fundingSummary.annualizedReturn.rate - 0.3) < 1e-6);
  assert.equal(fundingSummary.annualizedReturn.startDate, '2023-01-01');
});
