const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDeploymentDisplaySeries,
  DEPLOYMENT_TIMEFRAME_OPTIONS,
} = require('../../shared/deploymentDisplay.js');

test('buildDeploymentDisplaySeries sorts data and fills derived percentages', () => {
  const points = [
    {
      date: '2025-01-10',
      deployedValueCad: 500,
      reserveValueCad: 500,
      equityCad: 1000,
    },
    {
      date: '2025-01-05',
      deployedValueCad: 200,
      reserveValueCad: 800,
      equityCad: 1000,
    },
  ];

  const result = buildDeploymentDisplaySeries(points);
  assert.ok(Array.isArray(result) && result.length === 2, 'Expected two entries in sorted series');
  assert.equal(result[0].date, '2025-01-05');
  assert.equal(result[1].date, '2025-01-10');

  const first = result[0];
  assert.ok(Math.abs(first.deployedPercent - 20) < 1e-6, 'Deployed percent derived from values');
  assert.ok(Math.abs(first.reservePercent - 80) < 1e-6, 'Reserve percent derived from values');

  const second = result[1];
  assert.ok(Math.abs(second.deployedPercent - 50) < 1e-6, 'Deployed percent derived from values');
  assert.ok(Math.abs(second.reservePercent - 50) < 1e-6, 'Reserve percent derived from values');
});

test('buildDeploymentDisplaySeries enforces timeframe filters', () => {
  const points = [
    { date: '2024-01-01', deployedValueCad: 100, reserveValueCad: 400, equityCad: 500 },
    { date: '2024-12-15', deployedValueCad: 150, reserveValueCad: 350, equityCad: 500 },
    { date: '2025-01-15', deployedValueCad: 200, reserveValueCad: 300, equityCad: 500 },
  ];

  const timeframeOption = DEPLOYMENT_TIMEFRAME_OPTIONS.find((option) => option.value === '1M');
  assert.ok(timeframeOption, 'Expected to find 1M timeframe option');

  const result = buildDeploymentDisplaySeries(points, timeframeOption.value);
  assert.ok(Array.isArray(result) && result.length === 2, 'Expected timeframe filter to trim entries');
  assert.equal(result[0].date, '2024-12-15');
  assert.equal(result[1].date, '2025-01-15');
});
