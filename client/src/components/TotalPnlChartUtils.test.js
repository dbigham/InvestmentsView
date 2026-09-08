import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChartMetrics, clampChartX, CHART_WIDTH, CHART_HEIGHT, PADDING } from './TotalPnlChartUtils.js';

const series = [
  { date: '2026-01-01', totalPnl: -100 },
  { date: '2026-01-02', totalPnl: 50 },
  { date: '2026-01-03', totalPnl: 200 },
];

test('a wider chart extends its time axis without changing values or vertical scale', () => {
  const original = buildChartMetrics(series);
  const wide = buildChartMetrics(series, { width: 1230, height: CHART_HEIGHT });
  assert.equal(original.points.at(-1).x, CHART_WIDTH - PADDING.right);
  assert.equal(wide.points.at(-1).x, 1230 - PADDING.right);
  assert.deepEqual(wide.points.map(({ date, chartValue, y }) => ({ date, chartValue, y })),
    original.points.map(({ date, chartValue, y }) => ({ date, chartValue, y })));
  assert.deepEqual(wide.axisTicks, original.axisTicks);
});

test('compact chart geometry and pointer clamping share the available width', () => {
  const compact = buildChartMetrics(series, { width: 300, height: 180 });
  assert.equal(compact.innerHeight, 180 - PADDING.top - PADDING.bottom);
  assert.equal(compact.points.at(-1).x, clampChartX(9999, 300));
  assert.equal(clampChartX(-10, 300), PADDING.left);
  assert.equal(clampChartX(100, 300), 100);
  for (const point of compact.points) {
    assert.ok(point.y >= PADDING.top && point.y <= 180 - PADDING.bottom);
    assert.equal(compact.yFor(point.chartValue), point.y);
  }
});
