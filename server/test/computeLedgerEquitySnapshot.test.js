const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const tokenStorePath = path.join(__dirname, '..', 'token-store.json');
if (!fs.existsSync(tokenStorePath)) {
  const seedPayload = {
    logins: [
      {
        id: 'test-login',
        label: 'Test Login',
        email: 'test@example.com',
        refreshToken: 'dummy-refresh-token',
        updatedAt: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(tokenStorePath, JSON.stringify(seedPayload, null, 2));
}

const { computeLedgerEquitySnapshot } = require('../src/index.js');
const { RESERVE_SYMBOLS } = require('../../shared/deploymentDisplay.js');

function makePriceSeries(entries) {
  return new Map(entries.map(([symbol, price]) => [symbol, new Map([["2025-01-15", price]])]));
}

test('computeLedgerEquitySnapshot separates reserve and deployed values', () => {
  const holdings = new Map([
    ['SGOV', 10],
    ['AAPL', 5],
  ]);
  const cashByCurrency = new Map([
    ['CAD', 100],
    ['USD', 50],
  ]);
  const symbolMeta = new Map([
    ['SGOV', { currency: 'USD' }],
    ['AAPL', { currency: 'USD' }],
  ]);
  const priceSeriesMap = makePriceSeries([
    ['SGOV', 100],
    ['AAPL', 200],
  ]);

  const snapshot = computeLedgerEquitySnapshot(
    '2025-01-15',
    holdings,
    cashByCurrency,
    symbolMeta,
    priceSeriesMap,
    1.3,
    { reserveSymbols: new Set(RESERVE_SYMBOLS) }
  );

  assert.ok(snapshot, 'Expected snapshot result');
  assert.equal(snapshot.missingPrices.length, 0, 'Prices should be resolved for all holdings');
  assert.equal(snapshot.unsupportedCurrencies.length, 0, 'No unsupported currencies expected');

  // CAD equity: 100 cash + (USD holdings 2050 + USD cash 50) * 1.3
  assert.ok(Math.abs(snapshot.equityCad - 2765) < 1e-6, 'Equity should include converted USD values');
  assert.ok(Math.abs(snapshot.reserveValueCad - 1465) < 1e-6, 'Reserve should include cash and reserve holdings');
  assert.ok(Math.abs(snapshot.reserveSecurityValueCad - 1300) < 1e-6, 'Reserve securities should reflect SGOV position');
  assert.ok(Math.abs(snapshot.deployedValueCad - 1300) < 1e-6, 'Deployed should only include non-reserve holdings');
  assert.ok(
    Math.abs(snapshot.deployedSecurityValueCad - 1300) < 1e-6,
    'Deployed securities should exclude reserve holdings'
  );
});

test('computeLedgerEquitySnapshot nulls deployment metrics when USD rate missing', () => {
  const holdings = new Map([
    ['PSA.TO', 20],
  ]);
  const cashByCurrency = new Map([
    ['USD', 25],
  ]);
  const symbolMeta = new Map([
    ['PSA.TO', { currency: 'USD' }],
  ]);
  const priceSeriesMap = makePriceSeries([
    ['PSA.TO', 50],
  ]);

  const snapshot = computeLedgerEquitySnapshot(
    '2025-01-15',
    holdings,
    cashByCurrency,
    symbolMeta,
    priceSeriesMap,
    null,
    { reserveSymbols: new Set(RESERVE_SYMBOLS) }
  );

  assert.ok(snapshot, 'Expected snapshot result without USD conversion');
  assert.equal(snapshot.unsupportedCurrencies.includes('USD'), true, 'USD should be marked as unsupported');
  assert.equal(snapshot.reserveValueCad, null, 'Reserve value is null when USD rate missing');
  assert.equal(snapshot.deployedValueCad, null, 'Deployed value is null when USD rate missing');
  assert.equal(snapshot.reserveSecurityValueCad, null, 'Reserve securities null without conversion');
  assert.equal(snapshot.deployedSecurityValueCad, null, 'Deployed securities null without conversion');
});
