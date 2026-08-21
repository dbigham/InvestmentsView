import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCombinedCashAcrossCurrencies,
  computeReserveValueAcrossCurrencies,
  mergeAuthoritativeUsdToCadRate,
} from './currencyRates.js';

test('authoritative USD/CAD rate fills a missing balance-derived USD rate', () => {
  const original = new Map([['CAD', 1]]);
  const rates = mergeAuthoritativeUsdToCadRate(original, 1.4, 'CAD');

  assert.equal(rates.get('CAD'), 1);
  assert.equal(rates.get('USD'), 1.4);
  assert.equal(original.has('USD'), false);
});

test('balance-derived USD rate is not overwritten', () => {
  const rates = mergeAuthoritativeUsdToCadRate(new Map([['CAD', 1], ['USD', 1.35]]), 1.4, 'CAD');
  assert.equal(rates.get('USD'), 1.35);
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
