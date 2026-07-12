const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('rebuildAnnualizedReturnFromSeries closes archived returns with reconstructed equity', () => {
  const fundingSummary = {
    totalEquityCad: 0,
    annualizedReturn: { method: 'xirr', incomplete: true },
  };
  const series = {
    points: [
      {
        date: '2025-01-01',
        equityCad: 10000,
        cumulativeNetDepositsCad: 10000,
      },
      {
        date: '2025-07-01',
        equityCad: 15500,
        cumulativeNetDepositsCad: 15000,
      },
      {
        date: '2026-01-01',
        equityCad: 16500,
        cumulativeNetDepositsCad: 15000,
      },
    ],
  };

  __test__.rebuildAnnualizedReturnFromSeries(fundingSummary, series, 'archived-account');

  assert.ok(Number.isFinite(fundingSummary.annualizedReturn.rate));
  assert.ok(fundingSummary.annualizedReturn.rate > 0);
  assert.equal(fundingSummary.annualizedReturn.incomplete, undefined);
  assert.equal(fundingSummary.annualizedReturn.startDate, '2025-01-01');
  assert.equal(fundingSummary.annualizedReturn.asOf, '2026-01-01');
  assert.equal(fundingSummary.annualizedReturn.cashFlowCount, 3);
  assert.ok(Array.isArray(fundingSummary.returnBreakdown));
});
