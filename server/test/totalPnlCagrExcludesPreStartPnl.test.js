const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTotalPnlSeries } = require('../src/index.js');

/*
First-principles description
============================

What we’re testing
------------------
When a CAGR start date is applied for an account, the Total P&L shown should exclude any P&L that occurred strictly before that date. Equivalently:

since-start P&L (final) = all-time P&L (final) − absolute P&L at the display start date.

Why this is correct
-------------------
Total P&L is equity minus cumulative net deposits (cost basis). Choosing a display start date means we care about P&L generated on/after that date. Any loss or gain before that date must not be carried forward into the since-start result.
*/

test('CAGR mode excludes pre-start P&L from series and summary', async () => {
  // Scenario
  // --------
  // Pre-start: 2025-08-01 deposit +1000; 2025-08-15 loss -200 (non-funding)
  // Start    : 2025-09-01 (cagrStartDate) — baseline absolute P&L is -200
  // After    : 2025-09-10 gain +50
  // Final equity = 1000 + (-200 + 50) = 850
  // All-time P&L (final) = 850 - 1000 = -150
  // Since-start P&L (final) = -150 - (-200) = +50 (excludes the -200 pre-start loss)

  const account = { id: 'CAGR-EXCLUDE-PRE-START', cagrStartDate: '2025-09-01' };
  const now = new Date('2025-09-20T00:00:00Z');

  const activityContext = {
    accountId: account.id,
    accountKey: account.id,
    accountNumber: account.id,
    earliestFunding: new Date('2025-08-01T00:00:00Z'),
    crawlStart: new Date('2025-08-01T00:00:00Z'),
    now,
    nowIsoString: now.toISOString(),
    activities: [
      // Pre-start deposit +1000
      {
        tradeDate: '2025-08-01T00:00:00.000000-04:00',
        transactionDate: '2025-08-01T00:00:00.000000-04:00',
        settlementDate: '2025-08-01T00:00:00.000000-04:00',
        type: 'Deposits',
        action: 'CON',
        currency: 'CAD',
        netAmount: 1000,
        grossAmount: 1000,
      },
      // Pre-start non-funding loss -200
      {
        tradeDate: '2025-08-15T00:00:00.000000-04:00',
        transactionDate: '2025-08-15T00:00:00.000000-04:00',
        settlementDate: '2025-08-15T00:00:00.000000-04:00',
        type: 'Other',
        action: 'LOSS',
        currency: 'CAD',
        netAmount: -200,
        grossAmount: -200,
      },
      // Post-start gain +50
      {
        tradeDate: '2025-09-10T00:00:00.000000-04:00',
        transactionDate: '2025-09-10T00:00:00.000000-04:00',
        settlementDate: '2025-09-10T00:00:00.000000-04:00',
        type: 'Other',
        action: 'GAIN',
        currency: 'CAD',
        netAmount: 50,
        grossAmount: 50,
      },
    ],
    fingerprint: 'cagr-exclude-pre-start',
  };

  const balances = {
    [account.id]: {
      combined: {
        CAD: { totalEquity: 850 },
      },
    },
  };

  const cagrSeries = await computeTotalPnlSeries(
    { id: 'login-1' },
    account,
    balances,
    { activityContext, applyAccountCagrStartDate: true }
  );

  assert.ok(cagrSeries && Array.isArray(cagrSeries.points) && cagrSeries.points.length > 0, 'CAGR series expected');

  // Debug: print summary to validate expected numbers during development
  // Remove if this becomes noisy.
  // eslint-disable-next-line no-console
  console.log('DEBUG summary', cagrSeries.summary);

  // Series starts on or after the display start date
  const firstDate = cagrSeries.points[0]?.date;
  assert.equal(firstDate, '2025-09-01', 'series must start at the cagrStartDate');

  // Summary: since-start excludes the -200 pre-start loss, leaving +50
  assert.ok(
    Math.abs(cagrSeries.summary.totalPnlSinceDisplayStartCad - 50) < 1e-6,
    `since-start summary must exclude pre-start P&L (expected +50, got ${cagrSeries.summary.totalPnlSinceDisplayStartCad})`
  );
});
