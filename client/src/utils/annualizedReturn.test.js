import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySeriesAnnualizedToFundingSummary,
  computeAnnualizedReturnFromSeriesPoints,
} from './annualizedReturn.js';

test('computeAnnualizedReturnFromSeriesPoints derives annualized return from equity and deposit deltas', () => {
  const result = computeAnnualizedReturnFromSeriesPoints([
    { date: '2025-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
    { date: '2026-01-01', equityCad: 121, cumulativeNetDepositsCad: 100 },
  ]);

  assert.equal(result.startDate, '2025-01-01');
  assert.equal(result.endDate, '2026-01-01');
  assert.equal(result.incomplete, false);
  assert.ok(Number.isFinite(result.rate));
  assert.ok(Math.abs(result.rate - 0.21) < 0.0005);
});

test('applySeriesAnnualizedToFundingSummary replaces stale annualized values with filtered-series values', () => {
  const original = {
    totalPnlCad: 40,
    totalEquityCad: 900,
    annualizedReturnRate: 0.50,
    annualizedReturnStartDate: '2020-01-01',
    annualizedReturnAsOf: '2026-02-15',
    annualizedReturnIncomplete: false,
  };

  const updated = applySeriesAnnualizedToFundingSummary(original, [
    { date: '2025-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
    { date: '2026-01-01', equityCad: 121, cumulativeNetDepositsCad: 100 },
  ]);

  assert.ok(Math.abs(updated.annualizedReturnRate - 0.21) < 0.0005);
  assert.equal(updated.annualizedReturnStartDate, '2025-01-01');
  assert.equal(updated.annualizedReturnAsOf, '2026-01-01');
  assert.equal(updated.periodStartDate, '2025-01-01');
  assert.equal(updated.periodEndDate, '2026-01-01');
  assert.equal(updated.annualizedReturnIncomplete, false);
});

test('applySeriesAnnualizedToFundingSummary clears stale annualized rate when series is insufficient', () => {
  const original = {
    annualizedReturnRate: 0.5,
    annualizedReturnStartDate: '2020-01-01',
    annualizedReturnAsOf: '2026-02-15',
    annualizedReturnIncomplete: false,
  };

  const updated = applySeriesAnnualizedToFundingSummary(original, [
    { date: '2025-01-01', equityCad: 100, cumulativeNetDepositsCad: 100 },
  ]);

  assert.equal(updated.annualizedReturnRate, null);
  assert.equal(updated.annualizedReturnIncomplete, true);
});
