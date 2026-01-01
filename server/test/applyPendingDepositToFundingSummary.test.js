'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('applyPendingDepositToFundingSummary updates net deposits and cash flows', () => {
  // Pending deposits should be treated as a cash inflow on the end date
  // so funding cash flows align with the series adjustments.
  const fundingSummary = {
    netDeposits: { combinedCad: 100, allTimeCad: 200 },
    cashFlowsCad: [{ amount: -50, date: '2025-09-10T00:00:00Z' }],
  };

  const applied = __test__.applyPendingDepositToFundingSummary(
    fundingSummary,
    1000,
    '2025-09-18'
  );

  assert.equal(applied, true);
  assert.equal(fundingSummary.netDeposits.combinedCad, 1100);
  assert.equal(fundingSummary.netDeposits.allTimeCad, 1200);
  assert.equal(fundingSummary.cashFlowsCad.length, 2);
  assert.equal(fundingSummary.cashFlowsCad[1].amount, -1000);
  assert.equal(fundingSummary.cashFlowsCad[1].date, '2025-09-18T00:00:00Z');
});

test('applyPendingDepositToFundingSummary avoids duplicate cash flows', () => {
  const fundingSummary = {
    netDeposits: { combinedCad: 0 },
    cashFlowsCad: [{ amount: -500, date: '2025-09-18T00:00:00Z' }],
  };

  const applied = __test__.applyPendingDepositToFundingSummary(
    fundingSummary,
    500,
    '2025-09-18'
  );

  assert.equal(applied, true);
  assert.equal(fundingSummary.cashFlowsCad.length, 1);
});
