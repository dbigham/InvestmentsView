const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTotalPnlSeries } = require('../src/index.js');

/*
First‑principles description
============================

What we’re testing
------------------
When a CAGR start date is applied, the series should anchor the start day so that:
- P&L since start is exactly 0 on the start day; and
- Equity since start equals net deposits since start (the cost basis at the start), so the baseline is purely cost basis.

Why this is the correct behavior
--------------------------------
Total P&L by definition is (equity − cumulative net deposits). Anchoring the start date to a since‑start view means we reset the baseline so that P&L since start is 0 at the start, and any subsequent changes in P&L come only from market moves (or realized gains/losses), not from deposits/withdrawals. Deposits should change equity and cost basis equally, producing no P&L jump.

Scenario
--------
Pre‑start: 2025‑08‑31 deposit +10
Start   : 2025‑09‑02 (cagrStartDate)
After   : 2025‑09‑03 deposit +1000 (funding — should not change P&L since start)
          2025‑09‑04 gain +7 (non‑funding — should increase P&L by +7)
          2025‑09‑05 loss −2 (non‑funding — P&L since start becomes +5)

Final equity = total deposits (10 + 1000) + net gains (+5) = 1015.
*/

test('CAGR baseline anchors P&L to 0 and uses cost basis at start', async () => {
  const account = {
    id: 'CAGR-BASELINE-ACCOUNT',
    cagrStartDate: '2025-09-02',
  };

  const now = new Date('2025-09-06T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-08-31T00:00:00Z'),
    crawlStart: new Date('2025-08-31T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      // Pre‑start deposit
      {
        tradeDate: '2025-08-31T00:00:00.000000-04:00',
        transactionDate: '2025-08-31T00:00:00.000000-04:00',
        settlementDate: '2025-08-31T00:00:00.000000-04:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 10,
        grossAmount: 10,
      },
      // Start day (no activity on start itself)
      // Deposit after start (must not change P&L since start)
      {
        tradeDate: '2025-09-03T00:00:00.000000-04:00',
        transactionDate: '2025-09-03T00:00:00.000000-04:00',
        settlementDate: '2025-09-03T00:00:00.000000-04:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
      },
      // Non‑funding market moves
      {
        tradeDate: '2025-09-04T00:00:00.000000-04:00',
        transactionDate: '2025-09-04T00:00:00.000000-04:00',
        settlementDate: '2025-09-04T00:00:00.000000-04:00',
        type: 'Other',
        action: 'GAIN',
        currency: 'CAD',
        netAmount: 7,
        grossAmount: 7,
      },
      {
        tradeDate: '2025-09-05T00:00:00.000000-04:00',
        transactionDate: '2025-09-05T00:00:00.000000-04:00',
        settlementDate: '2025-09-05T00:00:00.000000-04:00',
        type: 'Other',
        action: 'LOSS',
        currency: 'CAD',
        netAmount: -2,
        grossAmount: -2,
      },
    ],
    fingerprint: 'cagr-baseline-fingerprint',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1015, // deposits (10 + 1000) + net gains (7 - 2) = 1015
        },
      },
    },
  };

  const series = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: true }
  );

  assert.ok(series && Array.isArray(series.points) && series.points.length > 0, 'series expected');

  const byDate = new Map(series.points.map((p) => [p.date, p]));
  const startPoint = byDate.get('2025-09-02');
  assert.ok(startPoint, 'start date must be present');
  // Baseline P&L must be 0
  assert.ok(Math.abs((startPoint.totalPnlSinceDisplayStartCad ?? 0) - 0) < 1e-6, 'baseline P&L must be 0');
  // At baseline, equity since start must equal deposits since start
  assert.ok(
    Math.abs((startPoint.equitySinceDisplayStartCad ?? 0) - (startPoint.cumulativeNetDepositsSinceDisplayStartCad ?? 0)) < 1e-6,
    'baseline equity since start must equal net deposits since start'
  );

  // Deposit after start: no P&L jump
  const afterDeposit = byDate.get('2025-09-03');
  assert.ok(afterDeposit, 'post-deposit date must be present');
  assert.ok(Math.abs((afterDeposit.totalPnlSinceDisplayStartCad ?? 0) - 0) < 1e-6, 'deposit must not change P&L since start');

  // Gains/losses after start affect P&L since start
  const gainDay = byDate.get('2025-09-04');
  const lossDay = byDate.get('2025-09-05');
  assert.ok(Math.abs((gainDay.totalPnlSinceDisplayStartCad ?? 0) - 7) < 1e-6, 'gain should increase P&L since start');
  assert.ok(Math.abs((lossDay.totalPnlSinceDisplayStartCad ?? 0) - 5) < 1e-6, 'subsequent loss should reduce P&L since start');

  // Summary sanity:
  // - All-time P&L equals final equity minus all-time deposits
  assert.ok(Math.abs(series.summary.totalPnlAllTimeCad - (1015 - (10 + 1000))) < 1e-6, 'all-time P&L should match equity minus cost basis');
  // - Since-start P&L equals net gains since start (+7 − 2 = +5)
  assert.ok(Math.abs(series.summary.totalPnlSinceDisplayStartCad - 5) < 1e-6, 'since-start P&L should reflect only post-start gains');
});
