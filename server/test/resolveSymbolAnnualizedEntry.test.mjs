import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSymbolAnnualizedEntry } from '../../client/src/utils/annualized.js';

test('resolveSymbolAnnualizedEntry prefers account-specific entries', () => {
  const accountMap = new Map([['TSLA', { rate: 0.5 }]]);
  const byAccount = new Map([['123', accountMap]]);
  const fallback = new Map([['TSLA', { rate: 0.1 }]]);

  const result = resolveSymbolAnnualizedEntry('TSLA', 123, byAccount, fallback);

  assert.equal(result.rate, 0.5);
});

test('resolveSymbolAnnualizedEntry does not borrow aggregate entry for an account row', () => {
  const allMap = new Map([['TSLA', { rate: 0.2 }]]);
  const byAccount = new Map([['all', allMap]]);

  const result = resolveSymbolAnnualizedEntry('TSLA', '456', byAccount, null);

  assert.equal(result, null);
});

test('resolveSymbolAnnualizedEntry uses aggregate entry when the row has no account', () => {
  const allMap = new Map([['TSLA', { rate: 0.2 }]]);
  const byAccount = new Map([['all', allMap]]);

  const result = resolveSymbolAnnualizedEntry('TSLA', '', byAccount, null);

  assert.equal(result.rate, 0.2);
});

test('resolveSymbolAnnualizedEntry falls back to generic symbol map', () => {
  const byAccount = new Map([['999', new Map()]]);
  const fallback = new Map([['TSLA', { rate: 0.3 }]]);

  const result = resolveSymbolAnnualizedEntry('TSLA', '', byAccount, fallback);

  assert.equal(result.rate, 0.3);
});

test('resolveSymbolAnnualizedEntry can use a scoped fallback for a single-account row', () => {
  const byAccount = new Map([['456', new Map()]]);
  const scopedFallback = new Map([['TSLA', { rate: 0.4 }]]);

  const result = resolveSymbolAnnualizedEntry('TSLA', '456', byAccount, scopedFallback, true);

  assert.equal(result.rate, 0.4);
});

test('resolveSymbolAnnualizedEntry does not use a scoped fallback by default', () => {
  const byAccount = new Map([['456', new Map()]]);
  const fallback = new Map([['TSLA', { rate: 0.4 }]]);

  const result = resolveSymbolAnnualizedEntry('TSLA', '456', byAccount, fallback);

  assert.equal(result, null);
});

test('resolveSymbolAnnualizedEntry returns null when symbol is missing', () => {
  const result = resolveSymbolAnnualizedEntry('', '123', new Map(), new Map());

  assert.equal(result, null);
});
