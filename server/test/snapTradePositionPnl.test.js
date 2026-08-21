const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('SnapTrade position derives open P&L only when the provider value is missing', () => {
  const base = {
    instrument: { symbol: { symbol: 'MU', currency: { code: 'USD' } } },
    units: 2.0947,
    price: 963.7,
    average_purchase_price: 703.5306,
  };
  const derived = __test__.normalizeSnapTradePosition(base);
  assert.ok(Math.abs(derived.openPnl - (963.7 - 703.5306) * 2.0947) < 1e-9);
  assert.equal(derived.dayPnl, null);

  const providerZero = __test__.normalizeSnapTradePosition({ ...base, open_pnl: 0 });
  assert.equal(providerZero.openPnl, 0);
});

test('daily P&L backfills from previous close and unavailable aggregates stay null', () => {
  const position = {
    accountId: 'A',
    loginId: 'snap-login',
    symbol: 'MU',
    currency: 'USD',
    openQuantity: 2,
    currentPrice: 105,
    dayPnl: null,
    openPnl: null,
  };
  const decorated = __test__.decoratePositions(
    [position],
    {},
    { A: { id: 'A', loginId: 'snap-login' } },
    null,
    { previousCloseMap: new Map([['MU', 100]]) }
  );
  assert.equal(decorated[0].dayPnl, 10);
  assert.deepEqual(__test__.mergePnL([{ dayPnl: null, openPnl: null }]), {
    dayPnl: null,
    openPnl: null,
  });
});

test('SnapTrade position P&L populates native and combined balance buckets', () => {
  const balances = {
    combined: { CAD: { currency: 'CAD', dayPnl: 0, openPnl: 0 } },
    perCurrency: { USD: { currency: 'USD', dayPnl: 0, openPnl: 0 } },
  };
  __test__.applyPositionPnlToSnapTradeBalances(
    balances,
    [
      { currency: 'USD', dayPnl: 10, openPnl: 25 },
      { currency: 'CAD', dayPnl: -2, openPnl: null },
    ],
    1.4
  );

  assert.equal(balances.perCurrency.USD.dayPnl, 10);
  assert.equal(balances.perCurrency.USD.openPnl, 25);
  assert.equal(balances.combined.CAD.dayPnl, 12);
  assert.equal(balances.combined.CAD.openPnl, 35);
});

test('SnapTrade combined-CAD daily P&L includes USD translation while native P&L stays unchanged', () => {
  const balances = {
    combined: { CAD: { currency: 'CAD' } },
    perCurrency: { USD: { currency: 'USD', cash: 20 } },
  };

  __test__.applyPositionPnlToSnapTradeBalances(
    balances,
    [{ currency: 'USD', currentMarketValue: 100, dayPnl: 10, openPnl: 25 }],
    1.38,
    1.4
  );

  assert.equal(balances.perCurrency.USD.dayPnl, 10);
  assert.ok(Math.abs(balances.combined.CAD.dayPnl - 11.6) < 1e-9);
  assert.equal(balances.combined.CAD.openPnl, 34.5);
});
