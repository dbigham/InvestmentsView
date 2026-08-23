const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

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
