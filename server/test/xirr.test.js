'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CASH_FLOW_EPSILON,
  DAY_IN_MS,
  normalizeCashFlowsForXirr,
  yearFraction,
  xirr,
  computeAnnualizedReturnFromCashFlows,
} = require('../src/xirr');

function almostEqual(actual, expected, tolerance = 1e-10) {
  assert.ok(Number.isFinite(actual), 'actual should be finite');
  assert.ok(Number.isFinite(expected), 'expected should be finite');
  const delta = Math.abs(actual - expected);
  assert.ok(
    delta <= tolerance,
    `expected ${expected} got ${actual} (|Δ|=${delta}) within tolerance ${tolerance}`
  );
}

test('normalizeCashFlowsForXirr filters invalid entries and sorts by date', () => {
  const flows = [
    { amount: '1000', date: '2022-03-01T00:00:00Z' },
    { amount: '0.00000000001', date: '2022-03-02T00:00:00Z' },
    { amount: '-500', timestamp: '2022-01-15T12:00:00Z' },
    { amount: 200, date: new Date('2022-02-01T00:00:00Z') },
    { amount: 'not-a-number', date: '2022-04-01T00:00:00Z' },
    null,
    {},
  ];

  const normalized = normalizeCashFlowsForXirr(flows);
  assert.equal(normalized.length, 3);
  assert.ok(normalized[0].date < normalized[1].date && normalized[1].date < normalized[2].date);
  assert.equal(normalized[0].amount, -500);
  assert.equal(normalized[1].amount, 200);
  assert.equal(normalized[2].amount, 1000);
});

test('yearFraction uses actual/365 day count', () => {
  const start = new Date('2020-01-01T00:00:00Z');
  const nextDay = new Date('2020-01-02T00:00:00Z');
  almostEqual(yearFraction(start, nextDay), 1 / 365, 1e-12);

  const mid = new Date(start.getTime() + 45 * DAY_IN_MS);
  almostEqual(yearFraction(start, mid), 45 / 365, 1e-12);
});

test('xirr matches Microsoft Excel documentation example', () => {
  // Example from https://support.microsoft.com/office/xirr-function
  const flows = [
    { date: new Date('2008-01-01T00:00:00Z'), amount: -10000 },
    { date: new Date('2008-03-01T00:00:00Z'), amount: 2750 },
    { date: new Date('2008-10-30T00:00:00Z'), amount: 4250 },
    { date: new Date('2009-02-15T00:00:00Z'), amount: 3250 },
    { date: new Date('2009-04-01T00:00:00Z'), amount: 2750 },
  ];
  const result = xirr(flows);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(result, 0.3733625335095556, 1e-9);
});

test('xirr handles negative annualized returns', () => {
  const flows = [
    { date: new Date('2018-01-15T00:00:00Z'), amount: -25000 },
    { date: new Date('2018-04-15T00:00:00Z'), amount: 1000 },
    { date: new Date('2019-04-15T00:00:00Z'), amount: 2000 },
    { date: new Date('2020-04-15T00:00:00Z'), amount: 3000 },
    { date: new Date('2021-04-15T00:00:00Z'), amount: 4000 },
    { date: new Date('2022-04-15T00:00:00Z'), amount: 5000 },
  ];
  const result = xirr(flows);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(result, -0.1546472326957911, 1e-9);
});

test('xirr can converge to negative rates near -100%', () => {
  const flows = [
    { date: new Date('2020-01-01T00:00:00Z'), amount: -1000 },
    { date: new Date('2021-01-01T00:00:00Z'), amount: 150 },
  ];
  const result = xirr(flows);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(result, -0.8492204732600506, 1e-9);
});

test('xirr succeeds for very large positive returns by expanding the bracket', () => {
  const flows = [
    { date: new Date('2019-01-01T00:00:00Z'), amount: -1000 },
    { date: new Date('2022-01-01T00:00:00Z'), amount: 2500 },
  ];
  const result = xirr(flows);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(result, 0.3568306378025747, 1e-9);
});

test('xirr expands brackets enough to handle multi-thousand percent annualized gains', () => {
  const flows = [
    { date: new Date('2025-09-25T00:00:00Z'), amount: -6354.888806000001 },
    { date: new Date('2025-10-03T21:54:30.308Z'), amount: 6906.791947 },
  ];
  const result = xirr(flows);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(result, 29.28118369919632, 1e-6);
});

test('xirr returns NaN when cash flows lack sign diversity or sufficient entries', () => {
  assert.ok(Number.isNaN(xirr([{ date: new Date('2020-01-01T00:00:00Z'), amount: 100 }])));
  assert.ok(Number.isNaN(xirr([{ date: new Date('2020-01-01T00:00:00Z'), amount: -100 }])));
  assert.ok(Number.isNaN(xirr([{ date: new Date('2020-01-01T00:00:00Z'), amount: -100 }, { date: new Date('2020-02-01T00:00:00Z'), amount: -50 }])));
});

test('xirr accepts already-normalized cash flows without double-normalizing', () => {
  const normalized = normalizeCashFlowsForXirr([
    { amount: -1000, date: '2019-01-01' },
    { amount: 200, date: '2019-02-01' },
    { amount: 200, date: '2019-03-01' },
    { amount: 200, date: '2019-04-01' },
    { amount: 200, date: '2019-05-01' },
    { amount: 200, date: '2019-06-01' },
  ]);
  const result = xirr(normalized);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(result, 0, 1e-12);
});

test('computeAnnualizedReturnFromCashFlows returns null when insufficient data', () => {
  let failure;
  const result = computeAnnualizedReturnFromCashFlows(
    [{ amount: -1000, date: '2022-01-01' }],
    {
      onFailure(details) {
        failure = details;
      },
    }
  );
  assert.equal(result, null);
  assert.ok(failure);
  assert.equal(failure.reason, 'insufficient_data');
  assert.ok(Array.isArray(failure.normalized));
  assert.equal(failure.normalized.length, 1);
});

test('computeAnnualizedReturnFromCashFlows propagates convergence failures with context', () => {
  const flows = [
    { amount: -1000, date: '2020-01-01' },
    { amount: 100, date: '2020-01-01' },
  ];
  let failure;
  const result = computeAnnualizedReturnFromCashFlows(flows, {
    onFailure(details) {
      failure = details;
    },
  });
  assert.equal(result, null);
  assert.ok(failure);
  assert.equal(failure.reason, 'no_convergence');
  assert.equal(failure.hasPositive, true);
  assert.equal(failure.hasNegative, true);
});

test('computeAnnualizedReturnFromCashFlows ignores minuscule cash flows via epsilon threshold', () => {
  const flows = [
    { amount: -5000, date: '2021-01-01' },
    { amount: 0.5 * CASH_FLOW_EPSILON, date: '2021-02-01' },
    { amount: 6000, date: '2022-01-01' },
  ];
  const rate = computeAnnualizedReturnFromCashFlows(flows);
  assert.ok(Number.isFinite(rate));
  assert.ok(rate > 0.18 && rate < 0.20);
});

test('computeAnnualizedReturnFromCashFlows handles ISO strings and Date instances interchangeably', () => {
  const flows = [
    { amount: -1000, date: '2019-01-01T00:00:00Z' },
    { amount: 500, timestamp: new Date('2020-01-01T00:00:00Z') },
    { amount: 800, date: '2021-07-01T00:00:00Z' },
  ];
  const rate = computeAnnualizedReturnFromCashFlows(flows);
  // Cross-checked with https://github.com/pyxirr/pyxirr (v0.10.7)
  almostEqual(rate, 0.14936255214275568, 1e-9);
});

test('computeAnnualizedReturnFromCashFlows accepts pre-normalized cash flows when requested', () => {
  const normalized = normalizeCashFlowsForXirr([
    { amount: -7500, date: '2020-01-01' },
    { amount: 1000, date: '2020-06-01' },
    { amount: 1200, date: '2020-09-01' },
    { amount: 1300, date: '2021-01-01' },
    { amount: 1400, date: '2021-06-01' },
    { amount: 1500, date: '2022-01-01' },
  ]);
  const rate = computeAnnualizedReturnFromCashFlows(normalized, { preNormalized: true });
  const baseline = computeAnnualizedReturnFromCashFlows(normalized);
  almostEqual(rate, baseline, 1e-12);
});
