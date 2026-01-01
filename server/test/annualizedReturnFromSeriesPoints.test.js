const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

const { buildAnnualizedReturnFromSeriesPoints } = __test__;

test('buildAnnualizedReturnFromSeriesPoints returns expected rate for a simple two-point series', () => {
  // When equity grows from 100 to 110 over exactly one year with no deposits or withdrawals,
  // the only cash flows are -100 at the start and +110 at the end, yielding a 10% XIRR.
  const points = [
    {
      date: '2023-01-01',
      equityCad: 100,
      cumulativeNetDepositsCad: 100,
      totalPnlCad: 0,
    },
    {
      date: '2024-01-01',
      equityCad: 110,
      cumulativeNetDepositsCad: 100,
      totalPnlCad: 10,
    },
  ];

  const annualized = buildAnnualizedReturnFromSeriesPoints(points, 'TEST-ACCOUNT');

  assert.ok(annualized, 'Expected annualized return payload');
  assert.ok(Math.abs(annualized.rate - 0.1) < 1e-6, 'Expected a 10% annualized return');
  assert.equal(annualized.startDate, '2023-01-01');
  assert.equal(annualized.asOf, '2024-01-01');
  assert.equal(annualized.cashFlowCount, 2);
});
