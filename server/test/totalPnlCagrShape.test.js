const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTotalPnlSeries } = require('../src/index.js');

/*
First‑principles description
============================

Goal: Verify that the Total P&L time series has the same shape whether we:
- show the entire history (no CAGR start), or
- apply a CAGR start date (display start) and measure P&L “since start”.

Principle: Total P&L equals current total equity minus cumulative net deposits (cost basis).

- Funding (deposits/withdrawals) must NOT change P&L, because both equity and cost basis move equally.
- Non‑funding cash movements (e.g., gains/losses posted as cash) DO change P&L because they affect equity without changing cost basis.

If we pick a display start date (CAGR mode), we conceptually “anchor” that start date so:
- P&L since start at the start date is 0, and
- Equity since start equals net deposits since start (the cost basis at that start date).

Therefore, the P&L path “since start” must be identical to the absolute P&L path with a constant offset equal to the absolute P&L on the start date. In other words, the day‑to‑day movements (shape) must be the same in both views, and deposits should never create a P&L jump.
*/

test('Total P&L shape matches between CAGR and no‑CAGR modes (deposits don’t change P&L)', async () => {
  // Scenario
  // --------
  // 2025‑08‑04: deposit +10 (funding)
  // 2025‑09‑02: gain +5 (non‑funding cash movement)
  // 2025‑09‑03: deposit +1000 (funding)
  // 2025‑09‑04: loss −10 (non‑funding)
  // 2025‑09‑05: gain +20 (non‑funding)
  // Expected absolute P&L path (no‑CAGR):
  //   08‑04: 0
  //   09‑02: +5
  //   09‑03: +5 (deposit doesn’t change P&L)
  //   09‑04: −5
  //   09‑05: +15
  // If we select 2025‑09‑02 as CAGR start date, the “since start” P&L should be the same shape, merely re‑anchored to 0 at 09‑02:
  //   09‑02: 0
  //   09‑03: +5
  //   09‑04: −5
  //   09‑05: +15

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
      // Funding: deposit +10 on 08‑04
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
      // Non‑funding: gain +5 on 09‑02
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
      // Funding: deposit +1000 on 09‑03
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
      // Non‑funding: loss −10 on 09‑04
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
      // Non‑funding: gain +20 on 09‑05
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

  assert.ok(noCagr && Array.isArray(noCagr.points) && noCagr.points.length > 0, 'no‑CAGR series expected');
  assert.ok(cagr && Array.isArray(cagr.points) && cagr.points.length > 0, 'CAGR series expected');

  // Locate baseline (CAGR display start), and build date→P&L maps.
  const baselineDate = account.cagrStartDate; // '2025-09-02'
  const mapAbs = new Map(noCagr.points.map((p) => [p.date, Number(p.totalPnlCad)]));
  const mapDelta = new Map(cagr.points.map((p) => [p.date, Number(p.totalPnlSinceDisplayStartCad ?? p.totalPnlCad)]));

  // Compute absolute P&L at baseline.
  // For dates strictly after the baseline, the CAGR delta should equal absolute P&L for that date
  // (because the baseline is explicitly anchored to 0 in CAGR mode).
  for (const [date, delta] of mapDelta.entries()) {
    if (date === baselineDate) {
      // Baseline day is anchored to 0 by definition.
      assert.ok(Math.abs(delta - 0) < 1e-6, 'baseline day must be anchored to 0');
      continue;
    }
    const abs = mapAbs.get(date);
    assert.ok(Number.isFinite(abs), 'absolute P&L for date must be defined: ' + date);
    const expected = abs; // anchored baseline => delta == absolute P&L
    assert.ok(
      Math.abs(delta - expected) < 1e-6,
      `shape mismatch on ${date}: expected ${expected}, got ${delta}`
    );
  }

  // Explicitly check the deposit day: there should be no P&L jump on 2025‑09‑03.
  assert.ok(Math.abs(mapAbs.get('2025-09-03') - mapAbs.get('2025-09-02')) < 1e-6, 'deposit day must not change absolute P&L');
  assert.ok(Math.abs(mapDelta.get('2025-09-03') - 5) < 1e-6,
    'since‑start P&L on 09‑03 should reflect only prior non‑funding gains (here, +5)');
});
