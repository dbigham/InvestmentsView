const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const summaryPath = path.join(__dirname, '../demo/summary.demo.json');
const priceHistoryPath = path.join(__dirname, '../demo/symbol-price-history.demo.json');

test('demo summary fixture matches expected shape', () => {
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  assert.equal(summary.demoMode, true);
  assert.ok(Array.isArray(summary.accounts) && summary.accounts.length >= 2);
  assert.ok(Array.isArray(summary.positions) && summary.positions.length >= 4);
  assert.ok(summary.accountFunding && typeof summary.accountFunding === 'object');
  assert.ok(summary.accountDividends && typeof summary.accountDividends === 'object');

  const seriesContainer = summary.accountTotalPnlSeries?.all?.all;
  assert.ok(seriesContainer && Array.isArray(seriesContainer.points));
  assert.ok(seriesContainer.points.length >= 2);
  seriesContainer.points.forEach((point) => {
    assert.equal(typeof point.date, 'string');
    assert.equal(typeof point.totalPnlCad, 'number');
  });
});

test('demo price history fixture provides symbol points', () => {
  const history = JSON.parse(fs.readFileSync(priceHistoryPath, 'utf-8'));
  const qqq = history.QQQ;
  assert.ok(qqq);
  assert.ok(Array.isArray(qqq.points) && qqq.points.length > 0);
  qqq.points.forEach((point) => {
    assert.equal(typeof point.date, 'string');
    assert.equal(typeof point.close, 'number');
  });
});
