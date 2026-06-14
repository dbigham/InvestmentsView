'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { __test__, computeNetDepositsCore } = require('../src/index.js');

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

test('computeNetDepositsCore treats opted-in positive P&L as a pending deposit', async () => {
  const now = new Date('2026-06-09T12:00:00Z');
  const account = {
    id: 'cash-lag-account',
    number: 'cash-lag-account',
    autoFixPendingWithdrawls: true,
  };
  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 21000,
        },
      },
    },
  };
  const activityContext = {
    accountId: account.id,
    accountNumber: account.number,
    accountKey: account.id,
    earliestFunding: null,
    crawlStart: now,
    now,
    nowIsoString: now.toISOString(),
    fingerprint: 'no-deposit-activity-yet',
    activities: [],
  };

  const result = await computeNetDepositsCore(account, balances, {}, activityContext);

  assert.ok(result, 'Expected funding summary');
  assert.equal(result.autoFixPendingWithdrawls?.applied, true);
  assert.equal(result.autoFixPendingWithdrawls?.kind, 'deposit');
  assert.equal(result.netDeposits.combinedCad, 21000);
  assert.equal(result.netDeposits.allTimeCad, 21000);
  assert.equal(result.totalPnl.combinedCad, 0);
  assert.equal(result.totalPnl.allTimeCad, 0);
  assert.equal(result.cashFlowsCad[0].amount, -21000);
});

test('computeNetDepositsCore leaves positive P&L alone without the auto-fix flag', async () => {
  const now = new Date('2026-06-09T12:00:00Z');
  const account = {
    id: 'ordinary-account',
    number: 'ordinary-account',
  };
  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 21000,
        },
      },
    },
  };
  const activityContext = {
    accountId: account.id,
    accountNumber: account.number,
    accountKey: account.id,
    earliestFunding: null,
    crawlStart: now,
    now,
    nowIsoString: now.toISOString(),
    fingerprint: 'ordinary-positive-pnl',
    activities: [],
  };

  const result = await computeNetDepositsCore(account, balances, {}, activityContext);

  assert.ok(result, 'Expected funding summary');
  assert.equal(result.autoFixPendingWithdrawls, undefined);
  assert.equal(result.netDeposits.combinedCad, 0);
  assert.equal(result.totalPnl.combinedCad, 21000);
});
