const test = require('node:test');
const assert = require('node:assert/strict');

const { computeNetDepositsCore } = require('../src/index.js');

function buildUsdDepositContext(now) {
  return {
    accountId: 'acct-usd',
    accountNumber: 'acct-usd',
    accountKey: 'acct-usd',
    earliestFunding: now,
    crawlStart: now,
    now,
    nowIsoString: now.toISOString(),
    fingerprint: 'usd-deposit-only',
    fetchBookValueTransferPrice: null,
    activities: [
      {
        tradeDate: now.toISOString(),
        transactionDate: now.toISOString(),
        settlementDate: now.toISOString(),
        action: 'DEP',
        type: 'Deposits',
        currency: 'USD',
        netAmount: 100,
        description: 'Test USD deposit only',
      },
    ],
  };
}

function buildUsdEquityBalances() {
  return {
    combined: {
      CAD: { currency: 'CAD', totalEquity: 0 },
      USD: { currency: 'USD', totalEquity: 100 },
    },
  };
}

test('net deposits use multi-currency equity when only USD cash remains', async () => {
  const now = new Date('2025-11-20T00:00:00Z');
  const account = { id: 'acct-usd', number: 'acct-usd' };
  const perAccountCombinedBalances = { 'acct-usd': buildUsdEquityBalances() };
  const activityContext = buildUsdDepositContext(now);

  const result = await computeNetDepositsCore(account, perAccountCombinedBalances, {}, activityContext);

  assert.ok(result, 'result should be returned');
  assert.ok(
    Number.isFinite(result.netDeposits.allTimeCad) && result.netDeposits.allTimeCad > 0,
    'net deposits convert USD deposit to CAD'
  );
  assert.ok(
    Number.isFinite(result.totalEquityCad) && result.totalEquityCad > 0,
    'equity sums USD balance in CAD terms'
  );
  assert.ok(
    Math.abs(result.totalPnl.allTimeCad || 0) < 1e-6,
    'P&L stays near zero when equity and funding share the same USD cash'
  );
});

