import test from 'node:test';
import assert from 'node:assert/strict';

import { applyLivePriceToSymbolPnlSeries } from './liveSymbolPnlSeries.js';

test('updates the final symbol P&L point from a same-day live quote', () => {
  const series = {
    points: [
      { date: '2026-08-25', equityCad: 1084, totalPnlCad: 285, priceNative: 6.685 },
      {
        date: '2026-08-26',
        equityCad: 1088.85,
        totalPnlCad: 290.07,
        usdSecurityValue: 785.07,
        priceNative: 6.71,
        priceCad: 9.31,
      },
    ],
    summary: {
      totalEquityCad: 1088.85,
      totalPnlCad: 290.07,
      totalPnlAllTimeCad: 290.07,
      priceNative: 6.71,
      priceCad: 9.31,
    },
  };

  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      currency: 'USD',
      openQuantity: 117,
      currentPrice: 8.4017,
      priceAsOf: '2026-08-26T22:09:43Z',
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.38695]]),
  });

  const expectedDeltaNative = (8.4017 - 6.71) * 117;
  const expectedDeltaCad = expectedDeltaNative * 1.38695;
  assert.ok(Math.abs(updated.points.at(-1).totalPnlCad - (290.07 + expectedDeltaCad)) < 1e-9);
  assert.ok(Math.abs(updated.summary.totalEquityCad - (1088.85 + expectedDeltaCad)) < 1e-9);
  assert.equal(updated.points.at(-1).priceNative, 8.4017);
  assert.equal(updated.points[0], series.points[0]);
  assert.notEqual(updated, series);
});

test('does not apply a quote from a different market date', () => {
  const series = {
    points: [{ date: '2026-08-25', equityCad: 100, totalPnlCad: 5, priceNative: 10 }],
    summary: { totalEquityCad: 100, totalPnlCad: 5 },
  };
  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      currency: 'USD',
      openQuantity: 10,
      currentPrice: 12,
      priceAsOf: '2026-08-26T12:00:00Z',
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.4]]),
  });

  assert.equal(updated, series);
});

test('uses the current summary date when the provider position has no quote timestamp', () => {
  const series = {
    points: [{ date: '2026-08-26', equityCad: 100, totalPnlCad: 5, priceNative: 10 }],
    summary: { totalEquityCad: 100, totalPnlCad: 5 },
  };
  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      currency: 'USD',
      openQuantity: 10,
      currentPrice: 12,
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.4]]),
    asOf: '2026-08-26T22:03:14Z',
  });

  assert.equal(updated.points.at(-1).totalPnlCad, 33);
  assert.equal(updated.points.at(-1).priceNative, 12);
});

test('updates an aggregate position whose refreshed quote timestamp is preserved', () => {
  const series = {
    points: [{ date: '2026-08-26', equityCad: 1371.42, totalPnlCad: -905.42, priceNative: 6.71 }],
    summary: { totalEquityCad: 1371.42, totalPnlCad: -905.42 },
  };
  const updated = applyLivePriceToSymbolPnlSeries(series, {
    symbol: 'CRMG',
    positions: [{
      symbol: 'CRMG',
      accountId: 'all',
      currency: 'USD',
      openQuantity: 117,
      currentPrice: 8.42,
      priceAsOf: '2026-08-26T22:20:00Z',
    }],
    currencyRates: new Map([['CAD', 1], ['USD', 1.388]]),
  });

  const expectedDeltaCad = (8.42 - 6.71) * 117 * 1.388;
  assert.notEqual(updated, series);
  assert.ok(Math.abs(updated.points.at(-1).totalPnlCad - (-905.42 + expectedDeltaCad)) < 1e-9);
  assert.equal(updated.points.at(-1).priceNative, 8.42);
});
