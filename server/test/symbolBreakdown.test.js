'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DIVIDEND_SYMBOL_OVERRIDES,
  normalizeBreakdownSymbol,
  resolveActivitySymbolForBreakdown,
  classifyActivityForSymbolBreakdown,
  accumulateSymbolBreakdown,
  finalizeSymbolBreakdown,
} = require('../src/symbolBreakdown');

test('normalizeBreakdownSymbol applies overrides, aliases, and normalization', () => {
  assert.equal(normalizeBreakdownSymbol('N003056'), 'NVDA');
  assert.equal(normalizeBreakdownSymbol('.ENB'), 'ENB');
  assert.equal(normalizeBreakdownSymbol('enb.to'), 'ENB');
  assert.equal(normalizeBreakdownSymbol('qqqm'), 'QQQ');
  assert.equal(normalizeBreakdownSymbol('  '), null);
  assert.equal(normalizeBreakdownSymbol(null), null);
});

test('DIVIDEND_SYMBOL_OVERRIDES captures known Questrade dividend aliases', () => {
  const expected = new Map([
    ['N003056', 'NVDA'],
    ['A033916', 'ASML'],
    ['H082968', 'QQQ'],
  ]);
  for (const [alias, symbol] of expected.entries()) {
    assert.equal(DIVIDEND_SYMBOL_OVERRIDES.get(alias), symbol);
  }
});

test('resolveActivitySymbolForBreakdown prefers explicit symbol data and trims descriptions', () => {
  const activity = {
    symbol: 'n003056',
    symbolId: 12345,
    symbolDescription: '  Nvidia Corp ',
    description: ' Dividend '
  };
  const resolved = resolveActivitySymbolForBreakdown(activity);
  assert.deepEqual(resolved, {
    symbol: 'NVDA',
    symbolId: '12345',
    description: 'Nvidia Corp',
  });

  const fallback = resolveActivitySymbolForBreakdown({
    symbol: '',
    symbolId: 'QQQM',
    description: 'Trailing description',
  });
  assert.deepEqual(fallback, {
    symbol: 'QQQ',
    symbolId: 'QQQM',
    description: 'Trailing description',
  });
});

test('classifyActivityForSymbolBreakdown distinguishes funding, income, and trades', () => {
  const income = classifyActivityForSymbolBreakdown({ description: 'Dividend paid' });
  assert.equal(income, 'income');

  const trade = classifyActivityForSymbolBreakdown({ type: 'Trade', action: 'Buy' });
  assert.equal(trade, 'trade');

  const funding = classifyActivityForSymbolBreakdown({ type: 'Deposit' });
  assert.equal(funding, null);

  const unknown = classifyActivityForSymbolBreakdown({ description: 'Service fee' });
  assert.equal(unknown, null);
});

test('accumulateSymbolBreakdown merges entries and finalize filters insignificant buckets', () => {
  const map = new Map();
  accumulateSymbolBreakdown(map, [
    { symbol: 'NVDA', netCashFlowCad: 100, incomeCad: 80, tradeCad: 20, investedCad: 0, activityCount: 1 },
    { symbol: 'nvda', netCashFlowCad: -40, incomeCad: 0, tradeCad: -40, investedCad: 40, activityCount: 1 },
    { symbol: 'QQQM', netCashFlowCad: 0.005, incomeCad: 0, tradeCad: 0, investedCad: 0, activityCount: 1 },
    { symbol: 'TSM', netCashFlowCad: 50, incomeCad: 50, tradeCad: 0, investedCad: 0, activityCount: 1 },
    null,
    {},
  ]);

  const results = finalizeSymbolBreakdown(map);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    symbol: 'NVDA',
    symbolId: null,
    description: null,
    netCashFlowCad: 60,
    incomeCad: 80,
    tradeCad: -20,
    investedCad: 40,
    activityCount: 2,
  });
  assert.deepEqual(results[1], {
    symbol: 'TSM',
    symbolId: null,
    description: null,
    netCashFlowCad: 50,
    incomeCad: 50,
    tradeCad: 0,
    investedCad: 0,
    activityCount: 1,
  });
  assert.ok(results.every((entry) => entry.symbol !== 'QQQM'));
});

describe('finalizeSymbolBreakdown sorting behaviour', () => {
  test('sorts by absolute net cash flow descending', () => {
    const map = new Map();
    accumulateSymbolBreakdown(map, [
      { symbol: 'A', netCashFlowCad: -10, incomeCad: 0, tradeCad: -10, investedCad: 10, activityCount: 1 },
      { symbol: 'B', netCashFlowCad: 200, incomeCad: 0, tradeCad: 200, investedCad: 0, activityCount: 1 },
      { symbol: 'C', netCashFlowCad: -50, incomeCad: 0, tradeCad: -50, investedCad: 50, activityCount: 1 },
    ]);
    const results = finalizeSymbolBreakdown(map);
    assert.deepEqual(
      results.map((entry) => entry.symbol),
      ['B', 'C', 'A']
    );
  });
});
