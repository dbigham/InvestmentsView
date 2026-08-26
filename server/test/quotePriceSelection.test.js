const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('selects a newer post-market quote over the regular-market close', () => {
  const quote = {
    regularMarketPrice: 100,
    regularMarketTime: 1_800_000_000,
    postMarketPrice: 103,
    postMarketTime: 1_800_003_600,
  };

  assert.equal(__test__.extractQuotePrice(quote), 103);
  assert.equal(__test__.resolveQuoteTimestamp(quote), new Date(1_800_003_600_000).toISOString());
});

test('selects a newer pre-market quote over the prior regular-market close', () => {
  const quote = {
    regularMarketPrice: 100,
    regularMarketTime: 1_800_000_000,
    preMarketPrice: 101,
    preMarketTime: 1_800_050_000,
  };

  assert.equal(__test__.extractQuotePrice(quote), 101);
  assert.equal(__test__.resolveQuoteTimestamp(quote), new Date(1_800_050_000_000).toISOString());
});

test('does not let a stale extended-hours quote override a newer regular quote', () => {
  const quote = {
    regularMarketPrice: 105,
    regularMarketTime: new Date('2027-01-05T15:00:00Z'),
    postMarketPrice: 102,
    postMarketTime: new Date('2027-01-04T22:00:00Z'),
  };

  assert.equal(__test__.extractQuotePrice(quote), 105);
  assert.equal(__test__.resolveQuoteTimestamp(quote), '2027-01-05T15:00:00.000Z');
});

test('preserves regular-price and fallback behavior when session timestamps are unavailable', () => {
  assert.equal(
    __test__.extractQuotePrice({ regularMarketPrice: 100, postMarketPrice: 103 }),
    100
  );
  assert.equal(__test__.extractQuotePrice({ bid: 99, ask: 101, previousClose: 98 }), 99);
  assert.equal(__test__.resolveQuoteTimestamp({ regularMarketPrice: 100 }), null);
});
