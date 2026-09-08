import test from 'node:test';
import assert from 'node:assert/strict';
import { stitchConcreteSuccessorSeries } from './successorSeries.js';

// All accounts can seed the browser cache with unstitched account history.
// Selecting that account must keep its actual equity while carrying old P&L.
test('browser cache stitching preserves observed equity and historical return', () => {
  const destination = { points: [
    { date: '2026-07-01', equityCad: 25000, cumulativeNetDepositsCad: 25000, totalPnlCad: 0 },
    { date: '2026-07-02', equityCad: 25100, cumulativeNetDepositsCad: 25000, totalPnlCad: 100 },
  ], summary: { totalEquityCad: 25100, netDepositsCad: 25000, totalPnlCad: 100 } };
  const historical = [{ points: [
    { date: '2026-06-30', equityCad: 19000, cumulativeNetDepositsCad: 17000, totalPnlCad: 2000 },
  ] }];
  const result = stitchConcreteSuccessorSeries(destination, historical, '2026-07-01');
  assert.equal(result.points.at(-1).equityCad, 25100);
  assert.equal(result.points.at(-1).totalPnlCad, 2100);
  assert.equal(result.summary.netDepositsCad, 23000);
  assert.equal(result.summary.totalEquityCad, 25100);
  assert.equal(destination.points.at(-1).totalPnlCad, 100);
});
