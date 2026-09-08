const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSplitHistory, supplementMissingSplits } = require('../src/corporateActions');
const { computeTotalPnlSeries } = require('../src/index');

// A split changes share units, not wealth. Yahoo's historical close is itself
// split-adjusted, including the final trading day before the split takes effect.
test('confirmed split restores contemporaneous closes, including the day before the split', () => {
  const timestamp = (date) => new Date(date).getTime() / 1000;
  const history = normalizeSplitHistory({ chart: { result: [{
    timestamp: ['2026-09-01', '2026-09-02', '2026-09-03'].map(timestamp),
    indicators: { quote: [{ close: [81.59, 80.04, 82.07] }] },
    events: { splits: { split: { date: timestamp('2026-09-03'), numerator: 2, denominator: 1 } } },
  }] } });
  assert.deepEqual(history.prices.map((point) => point.price), [163.18, 160.08, 82.07]);
});

const position = { symbol: 'TEST', currency: 'CAD', openQuantity: 24 };
const histories = { TEST: { splits: [{ date: '2026-09-03', ratio: 2 }] } };
const trade = (date, quantity) => ({ symbol: 'TEST', type: 'BUY', tradeDate: date, quantity });

// Reversing a post-split purchase must happen before inferring the shares
// credited by the split; pre-split purchases must remain in their original units.
test('missing split is inferred from closing shares after reversing later trades', () => {
  const activities = [trade('2026-08-19', 3), trade('2026-09-04', 4)];
  const result = supplementMissingSplits(activities, [position], histories);
  assert.equal(result.at(-1).quantity, 10);
  assert.equal(result.at(-1).netAmount, 0);
  assert.equal(activities.length, 2);
});

// Split-day trades occur after the opening split, and are in the new units.
test('split-day purchases are reversed before reconstructing the split', () => {
  const result = supplementMissingSplits([trade('2026-09-03T15:00:00Z', 4)], [position], histories);
  assert.equal(result.at(-1).quantity, 10);
});

// Once the broker reports its own corporate action, adding another would double
// the share change. A delayed posting date must not defeat this protection.
test('broker split activity suppresses a supplemental split', () => {
  const activities = [{ symbol: 'TEST', type: 'Stock split', tradeDate: '2026-09-04', quantity: 12 }];
  assert.deepEqual(supplementMissingSplits(activities, [position], histories), activities);
});

// Prices alone are insufficient evidence: a genuine market crash is not a split.
test('no confirmed event leaves activities unchanged', () => {
  const activities = [trade('2026-09-01', 12)];
  assert.deepEqual(supplementMissingSplits(activities, [position], {}), activities);
});

// Reverse splits remove shares without withdrawing capital.
test('reverse split produces a negative share adjustment and zero cash flow', () => {
  const result = supplementMissingSplits([], [{ ...position, openQuantity: 2 }],
    { TEST: { splits: [{ date: '2026-09-03', ratio: 0.1 }] } });
  assert.equal(result[0].quantity, -18);
  assert.equal(result[0].netAmount, 0);
});

// The full portfolio reconstruction must value ten old shares at $100 and
// twenty new shares at $50 equally, with no change to invested capital or P&L.
test('SnapTrade reconstruction remains continuous across a supplemental split', async () => {
  const account = { id: 'split-account', historyStartDate: '2026-09-01' };
  const positions = [{ symbol: 'TEST.TO', currency: 'CAD', openQuantity: 20, currentPrice: 51 }];
  const now = new Date('2026-09-04T18:00:00Z');
  const activities = supplementMissingSplits([], positions, { 'TEST.TO': histories.TEST });
  const context = { accountId: account.id, accountKey: account.id, accountNumber: account.id,
    earliestFunding: new Date('2026-09-01'), crawlStart: new Date('2026-09-01'),
    now, nowIsoString: now.toISOString(), offlineOnly: true, activities,
    corporateActionPriceHistory: { 'TEST.TO': [
      { date: '2026-09-01', price: 100 }, { date: '2026-09-02', price: 100 },
      { date: '2026-09-03', price: 50 }, { date: '2026-09-04', price: 51 },
    ] },
  };
  const result = await computeTotalPnlSeries({ id: 'split-login', provider: 'snaptrade' }, account,
    { [account.id]: { combined: { CAD: { totalEquity: 1020, cash: 0 } }, perCurrency: { CAD: { cash: 0 } } } },
    { activityContext: context, providedPositions: positions, applyAccountCagrStartDate: false });
  assert.deepEqual(result.points.map((point) => Math.round(point.equityCad)), [1000, 1000, 1000, 1020]);
  assert.deepEqual(result.points.map((point) => Math.round(point.totalPnlCad)), [0, 0, 0, 20]);
});
