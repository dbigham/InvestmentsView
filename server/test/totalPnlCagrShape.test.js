const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTotalPnlSeries } = require('../src/index.js');

/*
First-principles description
============================

What we’re verifying
--------------------
- Total P&L equals equity minus cumulative net deposits (cost basis).
- Funding (deposits/withdrawals) must NOT change P&L because both equity and cost basis move equally.
- Non-funding cash movements (realized gains/losses) DO change P&L because they affect equity without changing cost basis.

When a CAGR (display-start) date is applied, the series shows P&L “since start”.
- The start day is anchored to 0 (since-start P&L is 0 on the baseline day).
- For any date D ≥ start, P&L since start on D equals absolute P&L on D minus absolute P&L on the start day. This preserves the shape while excluding any pre-start P&L.
*/

test('Total P&L since start equals absolute minus baseline absolute (deposits don’t change P&L)', async () => {
  // Scenario
  // --------
  // 2025-08-04: deposit +10 (funding)
  // 2025-09-02: gain +5 (non-funding cash movement)
  // 2025-09-03: deposit +1000 (funding)
  // 2025-09-04: loss -10 (non-funding)
  // 2025-09-05: gain +20 (non-funding)
  // Expected absolute P&L path (no-CAGR):
  //   08-04: 0
  //   09-02: +5
  //   09-03: +5 (deposit doesn't change P&L)
  //   09-04: -5
  //   09-05: +15
  // If we select 2025-09-02 as CAGR start date, the “since start” P&L should equal absolute minus the baseline absolute on 09-02, i.e.:
  //   baseline absolute at 09-02 = +5
  //   09-02: 0
  //   09-03: +5 − 5 = 0   (deposit day – no P&L change)
  //   09-04: −5 − 5 = −10
  //   09-05: +15 − 5 = +10

  const account = {
    id: 'CAGR-SHAPE-ACCOUNT',
    cagrStartDate: '2025-09-02',
  };

  const now = new Date('2025-09-06T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-08-04T00:00:00Z'),
    crawlStart: new Date('2025-08-04T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      // Funding: deposit +10 on 08-04
      {
        tradeDate: '2025-08-04T00:00:00.000000-04:00',
        transactionDate: '2025-08-04T00:00:00.000000-04:00',
        settlementDate: '2025-08-04T00:00:00.000000-04:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 10,
        grossAmount: 10,
      },
      // Non-funding: gain +5 on 09-02
      {
        tradeDate: '2025-09-02T00:00:00.000000-04:00',
        transactionDate: '2025-09-02T00:00:00.000000-04:00',
        settlementDate: '2025-09-02T00:00:00.000000-04:00',
        type: 'Other',
        action: 'GAIN',
        currency: 'CAD',
        netAmount: 5,
        grossAmount: 5,
      },
      // Funding: deposit +1000 on 09-03
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
      // Non-funding: loss -10 on 09-04
      {
        tradeDate: '2025-09-04T00:00:00.000000-04:00',
        transactionDate: '2025-09-04T00:00:00.000000-04:00',
        settlementDate: '2025-09-04T00:00:00.000000-04:00',
        type: 'Other',
        action: 'LOSS',
        currency: 'CAD',
        netAmount: -10,
        grossAmount: -10,
      },
      // Non-funding: gain +20 on 09-05
      {
        tradeDate: '2025-09-05T00:00:00.000000-04:00',
        transactionDate: '2025-09-05T00:00:00.000000-04:00',
        settlementDate: '2025-09-05T00:00:00.000000-04:00',
        type: 'Other',
        action: 'GAIN',
        currency: 'CAD',
        netAmount: 20,
        grossAmount: 20,
      },
    ],
    fingerprint: 'cagr-shape-fingerprint',
  };

  // Final equity equals total deposits (10 + 1000) plus cumulative gains (5 - 10 + 20 = +15) = 1025.
  const balances = {
    [account.id]: {
      combined: {
        CAD: {
          totalEquity: 1025,
        },
      },
    },
  };

  const noCagr = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: false }
  );
  const cagr = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: true }
  );

  assert.ok(noCagr && Array.isArray(noCagr.points) && noCagr.points.length > 0, 'no-CAGR series expected');
  assert.ok(cagr && Array.isArray(cagr.points) && cagr.points.length > 0, 'CAGR series expected');

  // Locate baseline (CAGR display start), and build date→P&L maps.
  const baselineDate = account.cagrStartDate; // '2025-09-02'
  const absSeries = noCagr.points.map((p) => ({ date: p.date, abs: Number(p.totalPnlCad) }));
  const deltaSeries = cagr.points.map((p) => ({ date: p.date, delta: Number(p.totalPnlSinceDisplayStartCad ?? p.totalPnlCad) }));
  const dateIndex = new Map(absSeries.map((p, i) => [p.date, i]));
  const baselineIndex = dateIndex.get(baselineDate);
  assert.ok(Number.isInteger(baselineIndex) && baselineIndex >= 0, 'baseline must exist in absolute series');

  const prevIndex = baselineIndex > 0 ? baselineIndex - 1 : 0;
  const prevAbs = absSeries[prevIndex].abs;
  assert.ok(Number.isFinite(prevAbs), 'previous-day absolute P&L must be defined');

  for (const { date, delta } of deltaSeries) {
    const idx = dateIndex.get(date);
    assert.ok(Number.isInteger(idx), 'absolute P&L for date must be defined: ' + date);
    const abs = absSeries[idx].abs;
    const expected = date === baselineDate ? 0 : abs - prevAbs;
    assert.ok(Math.abs(delta - expected) < 1e-6,
      `since-start mismatch on ${date}: expected ${expected}, got ${delta}`);
  }

  // Explicitly check the deposit day: there should be no P&L jump on 2025-09-03.
  // Deposit day should not change absolute P&L, and since-start should reflect prior (09-02) gain (+5)
  assert.ok(Math.abs(absSeries[dateIndex.get('2025-09-03')].abs - absSeries[dateIndex.get('2025-09-02')].abs) < 1e-6,
    'deposit day must not change absolute P&L');
  const mapDelta = new Map(cagr.points.map((p) => [p.date, Number(p.totalPnlSinceDisplayStartCad ?? p.totalPnlCad)]));
  assert.ok(Math.abs(mapDelta.get('2025-09-03') - 5) < 1e-6,
    'since-start P&L on 09-03 should be +5 (carry forward prior gain)');
});
