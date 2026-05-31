'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  __test__: {
    QQQ_TEMPERATURE_FIT_END_DATE,
    applyLiveQuoteToSummary,
    buildTemperatureSummaryFromSeries,
    buildTemperatureSummaryFromQqqSeries,
  },
} = require('../src/qqqTemperature');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

function assertApprox(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`
  );
}

function buildSyntheticQqqSeries() {
  const start = new Date('2024-12-27T00:00:00Z');
  return [
    '2024-12-27',
    '2024-12-30',
    '2024-12-31',
    '2025-01-02',
    '2025-01-03',
    '2025-01-06',
    '2025-01-07',
  ].map((dateKey) => {
    const time = new Date(`${dateKey}T00:00:00Z`).getTime();
    const t = (time - start.getTime()) / MS_PER_DAY / DAYS_PER_YEAR;
    const baseline = 100 * Math.pow(1.1, t);
    return {
      date: dateKey,
      close: dateKey > QQQ_TEMPERATURE_FIT_END_DATE ? baseline * 2 : baseline,
    };
  });
}

test('QQQ temperature fits only through the frozen cutoff date', () => {
  const summary = buildTemperatureSummaryFromQqqSeries(buildSyntheticQqqSeries(), {
    updated: '2025-01-07T12:00:00.000Z',
  });

  assert.equal(QQQ_TEMPERATURE_FIT_END_DATE, '2025-01-01');
  assert.equal(summary.growthCurve.fitSource, 'QQQ');
  assert.equal(summary.growthCurve.fitEndDate, '2024-12-31');
  assertApprox(summary.growthCurve.A, 100, 1e-8, 'fit intercept');
  assertApprox(summary.growthCurve.r, 0.1, 1e-10, 'fit annual growth');

  const postCutoff = summary.series.find((entry) => entry.date === '2025-01-02');
  assertApprox(postCutoff.temperature, 2, 1e-6, 'post-cutoff temperature');
});

test('live QQQ temperature uses the frozen fit curve', () => {
  const source = buildSyntheticQqqSeries();
  const summary = buildTemperatureSummaryFromQqqSeries(source, {
    updated: '2025-01-07T12:00:00.000Z',
  });
  const liveBaseline = source.find((entry) => entry.date === '2025-01-07').close / 2;

  const augmented = applyLiveQuoteToSummary(summary, {
    price: liveBaseline * 1.5,
    asOf: '2025-01-07T15:00:00.000Z',
    source: 'test-live',
  });

  assert.equal(augmented.latest.date, '2025-01-07');
  assert.equal(augmented.livePrice.source, 'test-live');
  assertApprox(augmented.latest.temperature, 1.5, 1e-6, 'live temperature');
});

test('QQQ temperature can use the long proxy series for both display and fit', () => {
  const qqqSeries = buildSyntheticQqqSeries();
  const displaySeries = [
    { date: '1971-02-05', close: 1 },
    { date: '1971-02-08', close: 1.1 },
    ...qqqSeries,
  ];

  const summary = buildTemperatureSummaryFromSeries(displaySeries, displaySeries, {
    updated: '2025-01-07T12:00:00.000Z',
    fitSource: 'IXIC_NDX_QQQ',
    displaySource: 'IXIC_NDX_QQQ',
  });

  assert.equal(summary.rangeStart, '1971-02-05');
  assert.equal(summary.growthCurve.fitStartDate, '1971-02-05');
  assert.equal(summary.growthCurve.fitEndDate, '2024-12-31');
  assert.equal(summary.growthCurve.fitSource, 'IXIC_NDX_QQQ');
  assert.equal(summary.growthCurve.displaySource, 'IXIC_NDX_QQQ');

  const preQqqEntry = summary.series.find((entry) => entry.date === '1971-02-05');
  assert.ok(preQqqEntry && Number.isFinite(preQqqEntry.temperature));
});
