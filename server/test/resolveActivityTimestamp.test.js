const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActivityTimestamp } = require('../src/index.js');

test(
  'prefers the trade date when an activity also has a later transaction timestamp so positions show up on the day the trade actually happened',
  () => {
    const activity = {
      tradeDate: '2025-10-10T00:00:00.000000-04:00',
      transactionDate: '2025-10-14T00:00:00.000000-04:00',
      settlementDate: '2025-10-15T00:00:00.000000-04:00',
      date: '2025-10-16T00:00:00.000000-04:00',
      symbol: 'SPLG',
      action: 'Buy',
      type: 'Trades',
    };

    const timestamp = resolveActivityTimestamp(activity);
    assert.ok(timestamp instanceof Date, 'Expected a valid timestamp for a trade activity');
    const expected = new Date('2025-10-10T00:00:00.000000-04:00');
    assert.equal(
      timestamp.toISOString(),
      expected.toISOString(),
      'The trade date should be chosen so ledger math reflects the execution day'
    );
  }
);

test(
  'falls back to the transaction date when a trade date is absent so cash-only activities still land on a sensible day',
  () => {
    const activity = {
      transactionDate: '2025-09-30T00:00:00.000000-04:00',
      settlementDate: '2025-10-01T00:00:00.000000-04:00',
      type: 'Deposits',
      action: 'DEP',
    };

    const timestamp = resolveActivityTimestamp(activity);
    assert.ok(timestamp instanceof Date, 'Expected a timestamp when transactionDate is present');
    const expected = new Date('2025-09-30T00:00:00.000000-04:00');
    assert.equal(
      timestamp.toISOString(),
      expected.toISOString(),
      'Without a trade date we should fall back to the transaction timestamp'
    );
  }
);
