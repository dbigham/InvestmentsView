const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('SnapTrade reset headers are interpreted as seconds until reset', () => {
  assert.equal(__test__.resolveRetryAfterMs({ 'x-ratelimit-reset': '7' }), 7000);
  assert.equal(__test__.resolveRetryAfterMs({ 'x-ratelimit-account-reset': '12' }), 12000);
});

test('SnapTrade throttling detail provides a retry delay when headers are absent', () => {
  assert.equal(
    __test__.resolveRetryAfterMs(null, { detail: 'Request was throttled. Expected available in 3 seconds.' }),
    3000
  );
});

test('SnapTrade response cache uses the recommended holdings and activity windows', () => {
  assert.equal(__test__.resolveSnapTradeResponseCacheTtl('/accounts/example/balances', 'GET'), 10 * 60 * 1000);
  assert.equal(__test__.resolveSnapTradeResponseCacheTtl('/accounts/example/activities', 'GET'), 24 * 60 * 60 * 1000);
  assert.equal(__test__.resolveSnapTradeResponseCacheTtl('/accounts/example/balances', 'POST'), 0);
});

test('completed empty SnapTrade accounts skip activity-history discovery', () => {
  const emptyAccount = {
    provider: 'snaptrade',
    fundingDate: null,
    syncStatus: {
      transactions: {
        initial_sync_completed: true,
        first_transaction_date: null,
      },
    },
  };

  assert.equal(__test__.shouldSkipSnapTradeActivityHistory(emptyAccount), true);
  assert.equal(
    __test__.shouldSkipSnapTradeActivityHistory({
      ...emptyAccount,
      fundingDate: '2026-08-31',
    }),
    false
  );
  assert.equal(
    __test__.shouldSkipSnapTradeActivityHistory({
      ...emptyAccount,
      syncStatus: {
        transactions: {
          initial_sync_completed: true,
          first_transaction_date: '2026-08-31',
        },
      },
    }),
    false
  );
  assert.equal(
    __test__.shouldSkipSnapTradeActivityHistory({
      ...emptyAccount,
      syncStatus: {
        transactions: {
          initial_sync_completed: false,
          first_transaction_date: null,
        },
      },
    }),
    false
  );
  assert.equal(
    __test__.shouldSkipSnapTradeActivityHistory({ ...emptyAccount, provider: 'questrade' }),
    false
  );
});

test('only closed empty SnapTrade accounts are omitted from live aggregates', () => {
  const emptyAccount = {
    provider: 'snaptrade',
    fundingDate: null,
    syncStatus: {
      transactions: {
        initial_sync_completed: true,
        first_transaction_date: null,
      },
    },
  };

  assert.equal(__test__.isClosedEmptySnapTradeAccount({ ...emptyAccount, status: 'closed' }), true);
  assert.equal(__test__.isClosedEmptySnapTradeAccount({ ...emptyAccount, status: 'open' }), false);
  assert.equal(
    __test__.isClosedEmptySnapTradeAccount({
      ...emptyAccount,
      status: 'closed',
      syncStatus: {
        transactions: {
          initial_sync_completed: true,
          first_transaction_date: '2026-08-31',
        },
      },
    }),
    false
  );
});

test('SnapTrade cash refunds accept currency-qualified cash symbols', () => {
  const refund = {
    source: 'snaptrade',
    type: 'REFUND',
    action: 'REFUND',
    symbol: 'CAD.VN',
    quantity: 0,
    netAmount: 172.5,
    currency: 'CAD',
  };

  assert.equal(__test__.isSnapTradeCashRefundActivity(refund), true);
  assert.equal(__test__.isFundingActivity(refund), true);
  assert.equal(
    __test__.isSnapTradeCashRefundActivity({ ...refund, symbol: 'SHOP' }),
    false
  );
});
