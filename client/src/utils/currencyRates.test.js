import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCombinedCashAcrossCurrencies,
  computePortfolioValue,
  computeReserveValueAcrossCurrencies,
  mergeAuthoritativeUsdToCadRate,
} from './currencyRates.js';

// Uninvested USD cash belongs to the portfolio even though it has no position row.
test('portfolio weight includes converted cash once, not just securities', () => {
  const value = computePortfolioValue({
    marketValue: 10808 + 26495,
    balances: {
      perCurrency: { CAD: { cash: 0 }, USD: { cash: 22490.25 / 1.4 } },
      combined: { CAD: { cash: 22490.25 } },
    },
    currencyRates: new Map([['CAD', 1], ['USD', 1.4]]),
  });
  assert.equal((10808 / value * 100).toFixed(2), '18.08');
  assert.equal((26495 / value * 100).toFixed(2), '44.31');
});

// Some providers only supply combined balances; borrowing must reduce net value.
test('portfolio value supports combined cash and negative cash', () => {
  assert.equal(computePortfolioValue({ marketValue: 1000, balances: { combined: { CAD: { cash: 250 } } } }), 1250);
  assert.equal(computePortfolioValue({ marketValue: 1000, balances: { perCurrency: { CAD: { cash: -200 } } } }), 800);
});

// Fully invested portfolios and missing balance data preserve the existing weights.
test('portfolio value preserves securities-only value when cash is zero or unavailable', () => {
  assert.equal(computePortfolioValue({ marketValue: 1000, balances: null }), 1000);
  assert.equal(computePortfolioValue({ marketValue: 1000, balances: { perCurrency: { CAD: { cash: 0 } } } }), 1000);
});

test('authoritative USD/CAD rate fills a missing balance-derived USD rate', () => {
  const original = new Map([['CAD', 1]]);
  const rates = mergeAuthoritativeUsdToCadRate(original, 1.4, 'CAD');

  assert.equal(rates.get('CAD'), 1);
  assert.equal(rates.get('USD'), 1.4);
  assert.equal(original.has('USD'), false);
});

test('authoritative USD/CAD rate replaces a misleading balance-derived rate', () => {
  const rates = mergeAuthoritativeUsdToCadRate(new Map([['CAD', 1], ['USD', 1.35]]), 1.4, 'CAD');
  assert.equal(rates.get('USD'), 1.4);
});

test('authoritative USD/CAD rate wins over combined-currency balance ratios', () => {
  const rates = mergeAuthoritativeUsdToCadRate(
    new Map([['CAD', 1], ['USD', 362.1]]),
    1.376,
    'CAD'
  );

  assert.equal(rates.get('USD'), 1.376);
});

test('combined CAD reserve includes USD VBIL and USD cash without a USD equity balance', () => {
  const rates = mergeAuthoritativeUsdToCadRate(new Map([['CAD', 1]]), 1.4, 'CAD');
  const reserve = computeReserveValueAcrossCurrencies({
    cashByCurrency: new Map([['CAD', -100], ['USD', 300]]),
    reservePositionsByCurrency: new Map([['USD', 500]]),
    targetCurrency: 'CAD',
    currencyRates: rates,
    baseCurrency: 'CAD',
  });

  assert.equal(reserve, 1020);
});

test('combined CAD cash includes USD-only cash without a USD combined balance', () => {
  const rates = mergeAuthoritativeUsdToCadRate(new Map([['CAD', 1]]), 1.4, 'CAD');
  const cash = computeCombinedCashAcrossCurrencies({
    balances: {
      combined: { CAD: { currency: 'CAD', cash: 0 } },
      perCurrency: {
        CAD: { currency: 'CAD', cash: 0 },
        USD: { currency: 'USD', cash: 0.23 },
      },
    },
    targetCurrency: 'CAD',
    currencyRates: rates,
    baseCurrency: 'CAD',
  });

  assert.equal(cash, 0.322);
});
