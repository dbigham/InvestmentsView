const test = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('../src/index.js');
const { computeReturnBreakdownFromSeries, rebuildAggregateAnnualizedReturnFromSeries } = __test__;
const point = (date, equityCad, cumulativeNetDepositsCad) => ({ date, equityCad, cumulativeNetDepositsCad });
const twelveMonth = (points) => computeReturnBreakdownFromSeries(points, 'test').find((entry) => entry.months === 12);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('12 month return uses historical equity independently of earlier performance', () => {
  const points = [point('2024-01-01', 1000, 1000), point('2025-01-01', 100, 1000), point('2026-01-01', 110, 1000)];
  const funding = {};
  rebuildAggregateAnnualizedReturnFromSeries(funding, { points }, 'all');
  const result = funding.returnBreakdown.find((entry) => entry.months === 12);
  assert.ok(funding.annualizedReturn.rate < 0);
  close(result.annualizedRate, 0.1);
  close(result.periodReturnRate, 0.1);
  assert.equal(result.startValueCad, 100);
  assert.equal(result.totalReturnCad, 10);
  assert.equal(result.startDate, '2025-01-01');
});

for (const deposit of [100, -50]) {
  test(`dated ${deposit > 0 ? 'deposit' : 'withdrawal'} is included in period XIRR`, () => {
    const ending = 121 + deposit * Math.pow(1.21, 183 / 365);
    const result = twelveMonth([
      point('2025-01-01', 100, 100),
      point('2025-07-02', 110 + deposit, 100 + deposit),
      point('2026-01-01', ending, 100 + deposit),
    ]);
    close(result.annualizedRate, 0.21);
    close(result.periodReturnRate, 0.21);
    close(result.totalReturnCad, ending - 100 - deposit);
  });
}

test('six month and leap-year periods use actual elapsed days to deannualize XIRR', () => {
  for (const [start, end, months, days] of [
    ['2025-07-01', '2026-01-01', 6, 184],
    ['2024-01-01', '2025-01-01', 12, 366],
  ]) {
    const growth = Math.pow(1.21, days / 365);
    const result = computeReturnBreakdownFromSeries([
      point(start, 100, 100), point(end, 100 * growth, 100),
    ], 'test').find((entry) => entry.months === months);
    close(result.annualizedRate, 0.21);
    close(result.periodReturnRate, growth - 1);
  }
});

test('missing boundary valuation or unknown funding does not fabricate a return', () => {
  assert.equal(twelveMonth([point('2024-12-31', 100, 100), point('2026-01-01', 110, 100)]), undefined);
  assert.equal(twelveMonth([point('2025-01-01', 100, 100), point('2025-07-01', 100, null), point('2026-01-01', 110, 100)]), undefined);
  assert.equal(twelveMonth([point('2025-01-01', null, 100), point('2026-01-01', 110, 100)]), undefined);
});

test('opening-date deposits are already included in opening equity', () => {
  const result = twelveMonth([point('2024-12-31', 0, 0), point('2025-01-01', 100, 100), point('2026-01-01', 110, 100)]);
  close(result.annualizedRate, 0.1);
  assert.equal(result.totalReturnCad, 10);
});

test('unfunded period has no numeric percentage', () => {
  const result = twelveMonth([point('2025-01-01', 0, 0), point('2026-01-01', 0, 0)]);
  assert.equal(result.annualizedRate, null);
  assert.equal(result.periodReturnRate, null);
});
