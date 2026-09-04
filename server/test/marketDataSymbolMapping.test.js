const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('maps SnapTrade Topicus symbols to Yahoo and CAD', () => {
  assert.equal(__test__.resolveYahooSymbol('TOI.VN'), 'TOI.V');
  assert.equal(__test__.resolveYahooSymbol('TOI.V'), 'TOI.V');
  assert.equal(__test__.inferSymbolCurrency('TOI.VN'), 'CAD');
});

test('uses executed trade price without inventing a current-price end jump', () => {
  const history = __test__.buildActivityPriceHistoryFallback(
    [
      {
        symbol: 'TOI.VN',
        dateKey: '2026-07-13',
        activity: {
          type: 'BUY',
          action: 'BUY',
          quantity: 19.3705,
          price: 92.1499,
          netAmount: -1784.99,
        },
      },
    ],
    'TOI.VN',
    '2026-06-29',
    '2026-08-21'
  );

  assert.equal(history[0].date.toISOString().slice(0, 10), '2026-07-13');
  assert.equal(history[0].price, 92.1499);
  assert.equal(history.at(-1).date.toISOString().slice(0, 10), '2026-08-21');
  assert.equal(history.at(-1).price, 92.1499);
  assert.equal(history.some((point) => point.price === 102.09), false);
});

test('normalizes Yahoo chart candles for direct historical fallback', () => {
  const history = __test__.normalizeYahooChartResponse({
    chart: {
      result: [{
        timestamp: [1783900800],
        indicators: {
          quote: [{ close: [92.3] }],
          adjclose: [{ adjclose: [92.3] }],
        },
      }],
    },
  });

  assert.deepEqual(history.map((point) => ({
    date: point.date.toISOString().slice(0, 10),
    price: point.adjClose,
  })), [{ date: '2026-07-13', price: 92.3 }]);
});

// A broker ledger contains the number of shares actually held on each date.
// Around a pending stock split, Yahoo may retroactively halve adjusted closes
// before the broker has posted the extra shares, so ledger valuation must use
// the unadjusted close to avoid inventing a large loss and later recovery.
test('uses unadjusted Yahoo closes for account P&L history around a stock split', () => {
  const history = __test__.normalizeYahooHistoricalEntries([
    {
      date: new Date('2026-07-24T00:00:00Z'),
      close: 152.67,
      adjClose: 76.335,
    },
    {
      date: new Date('2026-08-24T00:00:00Z'),
      close: 155.55,
      adjClose: 77.775,
    },
  ]);

  assert.deepEqual(history.map((point) => ({
    date: point.date.toISOString().slice(0, 10),
    price: point.price,
  })), [
    { date: '2026-07-24', price: 152.67 },
    { date: '2026-08-24', price: 155.55 },
  ]);
});

// Yahoo can revise an already-cached pre-split close onto a post-split basis.
// The observed point-in-time close remains the correct match for the broker's
// pre-split share count, while newly available dates can still come from Yahoo.
test('prefers observed closes when Yahoo later rewrites split history', () => {
  const merged = __test__.mergeObservedPriceHistory(
    [
      { date: new Date('2026-08-19T00:00:00Z'), price: 78.02 },
      { date: new Date('2026-09-02T00:00:00Z'), price: 160.08 },
    ],
    [
      { date: '2026-08-19', price: 156.04 },
      { date: '2026-09-01', price: 163.18 },
    ],
    new Date('2026-08-19T00:00:00Z'),
    new Date('2026-09-03T00:00:00Z')
  );

  assert.deepEqual(merged.map((point) => ({
    date: point.date.toISOString().slice(0, 10),
    price: point.price,
  })), [
    { date: '2026-08-19', price: 156.04 },
    { date: '2026-09-01', price: 163.18 },
    { date: '2026-09-02', price: 160.08 },
  ]);
});
