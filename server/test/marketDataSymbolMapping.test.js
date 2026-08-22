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
