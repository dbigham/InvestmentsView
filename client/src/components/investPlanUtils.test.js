import test from 'node:test';
import assert from 'node:assert/strict';
import { computePurchaseAllocation } from './investPlanUtils.js';

test('Questrade-style CAD allocation uses whole shares', () => {
  assert.deepEqual(computePurchaseAllocation(100, 30, 0), {
    shares: 3,
    spentCurrency: 90,
    note: '',
  });
});

test('Wealthsimple CAD allocation supports four-decimal fractional shares', () => {
  assert.deepEqual(computePurchaseAllocation(100, 30, 4), {
    shares: 3.3333,
    spentCurrency: 99.999,
    note: '',
  });
});

test('fractional allocation reports an amount below the minimum precision', () => {
  assert.deepEqual(computePurchaseAllocation(0.001, 100, 4), {
    shares: 0,
    spentCurrency: 0,
    note: 'Insufficient for minimum fractional share',
  });
});
