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

test('rebuildAnnualizedReturnFromDisplayStart ignores a nominal opening snapshot', () => {
  const fundingSummary = {
    totalEquityCad: 2314.43,
    displayStartTotals: { equityCad: 10 },
    cashFlowsCad: [{ amount: -10, date: new Date('2025-08-21T00:00:00Z') }],
    annualizedReturn: { rate: 184.1445, method: 'xirr', asOf: '2026-08-23' },
    annualizedReturnAllTime: {
      rate: 0.1701,
      method: 'xirr',
      startDate: '2025-07-23',
      asOf: '2026-08-23',
    },
  };

  __test__.rebuildAnnualizedReturnFromDisplayStart(
    fundingSummary,
    { id: 'hazel-personal', cagrStartDate: '2025-08-21' },
    'hazel-personal'
  );

  assert.equal(fundingSummary.annualizedReturn.rate, 0.1701);
  assert.equal(fundingSummary.annualizedReturn.startDate, '2025-07-23');
});

test('direct CAGR summary uses the configured start instead of a provider-period return', () => {
  const fundingSummary = {
    periodStartDate: '2026-07-06',
    periodEndDate: '2026-08-23',
    historyStartDate: '2026-06-29',
    historyStartDateEstimated: true,
    cashFlowCoverageIncomplete: true,
    providerObservedReturn: {
      startDate: '2026-07-06',
      annualizedRate: -0.30,
    },
    estimatedHistoryReturn: {
      startDate: '2026-06-29',
      annualizedRate: 0.01,
    },
    totalPnlSinceDisplayStartCad: -2200,
    annualizedReturn: { rate: -0.30, startDate: '2026-07-06' },
  };
  const cagrSeries = {
    periodStartDate: '2025-06-29',
    periodEndDate: '2026-08-23',
    points: [
      {
        date: '2025-06-29',
        equityCad: 0,
        cumulativeNetDepositsCad: 0,
        totalPnlCad: 0,
      },
      {
        date: '2026-08-23',
        equityCad: 45371,
        cumulativeNetDepositsCad: 45300,
        totalPnlCad: 71,
      },
    ],
    summary: {
      totalPnlSinceDisplayStartCad: 71,
      displayStartTotals: { totalPnlCad: 0, equityCad: 0, cumulativeNetDepositsCad: 0 },
    },
  };

  __test__.applyDirectCagrSeriesToFundingSummary(
    fundingSummary,
    cagrSeries,
    { id: 'chatgpt-may', cagrStartDate: '2025-06-29' }
  );

  assert.equal(fundingSummary.periodStartDate, '2025-06-29');
  assert.equal(fundingSummary.cagrStartDate, '2025-06-29');
  assert.equal(fundingSummary.totalPnlSinceDisplayStartCad, 71);
  assert.equal(fundingSummary.providerObservedReturn, undefined);
  assert.equal(fundingSummary.estimatedHistoryReturn, undefined);
  assert.equal(fundingSummary.historyStartDate, undefined);
  assert.equal(fundingSummary.cashFlowCoverageIncomplete, undefined);
  assert.equal(fundingSummary.annualizedReturn.startDate, '2025-06-29');
});
