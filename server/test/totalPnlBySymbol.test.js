// Node test for computeTotalPnlBySymbol
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/index.js');
const {
  computeTotalPnlBySymbol,
} = mod;

function makeContext(accountId, start, end, activities) {
  return {
    accountId,
    accountNumber: accountId,
    accountKey: accountId,
    earliestFunding: new Date(start),
    crawlStart: new Date(start),
    activities,
    now: new Date(end),
    nowIsoString: new Date(end).toISOString(),
    fingerprint: 'test',
    fetchBookValueTransferPrice: async () => null,
  };
}

function d(s) { return new Date(s).toISOString().slice(0,10); }

test('journaling pair nets to ~0', async () => {
  const account = { id: 'test:1', number: 'test:1', cagrStartDate: '2025-10-01' };
  const login = { id: 'login' };
  const start = '2025-10-01';
  const end = '2025-10-31';
  const activities = [
    { type: 'Trades', action: 'Buy', symbol: 'DLR.TO', quantity: 100, netAmount: -1000, currency: 'CAD', tradeDate: start },
    { type: 'Transfers', action: 'Journal', symbol: 'DLR.TO', quantity: -100, netAmount: 0, currency: 'CAD', description: 'journal to DLR.U.TO', tradeDate: '2025-10-10' },
    { type: 'Transfers', action: 'Journal', symbol: 'DLR.U.TO', quantity: 100, netAmount: 0, currency: 'CAD', description: 'journal from DLR.TO', tradeDate: '2025-10-10' },
    { type: 'Trades', action: 'Sell', symbol: 'DLR.U.TO', quantity: -100, netAmount: 1000, currency: 'CAD', tradeDate: end },
  ];
  const ctx = makeContext(account.id, start, end, activities);
  const priceSeries = new Map([
    ['DLR.TO', new Map([[d('2025-10-01'), 10],[d('2025-10-10'),10],[d('2025-10-31'),10]])],
    ['DLR.U.TO', new Map([[d('2025-10-01'), 10],[d('2025-10-10'),10],[d('2025-10-31'),10]])],
  ]);
  const endHoldings = new Map([['DLR', 0]]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries,
    endHoldingsBySymbol: endHoldings,
  });
  const dlr = result.entries.find(e => e.symbol === 'DLR') || result.entries.find(e => e.symbol === 'DLR.TO');
  assert.ok(dlr, 'DLR entry present');
  assert.ok(Math.abs(dlr.totalPnlCad) < 1e-6, 'DLR journaling ~0 P&L');
});

test('transfer out after start nets ~0 for SGOV', async () => {
  const account = { id: 'test:2', number: 'test:2', cagrStartDate: '2025-10-01' };
  const login = { id: 'login' };
  const start = '2025-10-01';
  const end = '2025-10-31';
  const activities = [
    // Pre-start buy to seed baseline
    { type: 'Trades', action: 'Buy', symbol: 'SGOV', quantity: 100, netAmount: -10000, currency: 'USD', tradeDate: '2025-09-25' },
    // After start: transfer out all shares
    { type: 'Transfers', action: 'TFO', symbol: 'SGOV', quantity: -100, netAmount: 0, currency: 'USD', description: 'TRANSFER BOOK VALUE', tradeDate: '2025-10-10' },
  ];
  const ctx = makeContext(account.id, start, end, activities);
  const priceSeries = new Map([
    ['SGOV', new Map([[d('2025-10-01'), 100],[d('2025-10-10'),100],[d('2025-10-31'),100]])],
  ]);
  const usdRates = new Map([[d('2025-10-01'), 1.3],[d('2025-10-10'),1.3],[d('2025-10-31'),1.3]]);
  const endHoldings = new Map([['SGOV', 0]]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries,
    usdRatesByDate: usdRates,
    endHoldingsBySymbol: endHoldings,
  });
  const sgov = result.entries.find(e => e.symbol === 'SGOV');
  assert.ok(sgov, 'SGOV entry present');
  assert.ok(Math.abs(sgov.totalPnlCad) < 1e-6, 'SGOV transfer out ~0 P&L');
});

test('UNH small gain since start', async () => {
  const account = { id: 'test:3', number: 'test:3', cagrStartDate: '2025-10-01' };
  const login = { id: 'login' };
  const start = '2025-10-01';
  const end = '2025-10-31';
  const activities = [
    { type: 'Trades', action: 'Buy', symbol: 'UNH', quantity: 5, netAmount: -500, currency: 'USD', tradeDate: '2025-10-05' },
    { type: 'Trades', action: 'Sell', symbol: 'UNH', quantity: -5, netAmount: 505, currency: 'USD', tradeDate: '2025-10-20' },
  ];
  const ctx = makeContext(account.id, start, end, activities);
  const priceSeries = new Map([
    ['UNH', new Map([[d('2025-10-01'), 100],[d('2025-10-05'),100],[d('2025-10-20'),101],[d('2025-10-31'),101]])],
  ]);
  const usdRates = new Map([[d('2025-10-01'), 1.3],[d('2025-10-05'),1.3],[d('2025-10-20'),1.3],[d('2025-10-31'),1.3]]);
  const endHoldings = new Map([['UNH', 0]]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries,
    usdRatesByDate: usdRates,
    endHoldingsBySymbol: endHoldings,
  });
  const unh = result.entries.find(e => e.symbol === 'UNH');
  assert.ok(unh, 'UNH present');
  // 5 shares * $1 * 1.3 = 6.5 CAD approx
  assert.ok(Math.abs(unh.totalPnlCad - 6.5) < 1e-6, 'UNH ~6.5 CAD');
});

test('PSA trade with "INTEREST" in description is treated as trade (not income)', async () => {
  const account = { id: 'test:4', number: 'test:4', cagrStartDate: '2025-10-01' };
  const login = { id: 'login' };
  const start = '2025-10-01';
  const end = '2025-10-31';
  const activities = [
    {
      type: 'Trades',
      action: 'Buy',
      symbol: 'PSA.TO',
      quantity: 36,
      netAmount: -1803.6,
      currency: 'CAD',
      description: 'PURPOSE HIGH INTEREST SAVINGS FUND UNITS WE ACTED AS AGENT',
      tradeDate: '2025-10-05',
    },
    { type: 'Dividends', symbol: 'PSA.TO', netAmount: 3.77, currency: 'CAD', tradeDate: '2025-10-03' },
    { type: 'Dividends', symbol: 'PSA.TO', netAmount: 3.68, currency: 'CAD', tradeDate: '2025-10-25' },
  ];
  const ctx = makeContext(account.id, start, end, activities);
  // Keep price flat so MV contribution is neutral beyond quantity*price
  const priceSeries = new Map([
    ['PSA.TO', new Map([[d('2025-10-01'), 50],[d('2025-10-05'),50],[d('2025-10-31'),50]])],
  ]);
  const endHoldings = new Map([['PSA.TO', 36]]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries,
    endHoldingsBySymbol: endHoldings,
  });
  const psa = result.entries.find((e) => e.symbol === 'PSA.TO') || result.entries.find((e) => e.symbol === 'PSA');
  assert.ok(psa, 'PSA entry present');
  // MV (36*50=1800) - buy 1803.6 + dividends (7.45) = ~4. - rounding
  assert.ok(Math.abs(psa.totalPnlCad - 3.85) < 0.75, 'PSA ~small positive P&L');
});

test('displayEndKey clamps series end', async () => {
  const account = { id: 'test:5', number: 'test:5' };
  const login = { id: 'login' };
  const start = '2025-10-01';
  const end = '2025-10-31';
  const clampEnd = '2025-10-15';
  const activities = [
    { type: 'Trades', action: 'Buy', symbol: 'SHOP.TO', quantity: 10, netAmount: -1000, currency: 'CAD', tradeDate: start },
  ];
  const ctx = makeContext(account.id, start, end, activities);
  const priceSeries = new Map([
    ['SHOP.TO', new Map([[d(start), 100], [d(clampEnd), 150], [d(end), 200]])],
  ]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: false,
    displayStartKey: d(start),
    displayEndKey: d(clampEnd),
    priceSeriesBySymbol: priceSeries,
  });
  assert.equal(result.endDate, d(clampEnd), 'end date respects clamp');
  const shop = result.entries.find((e) => e.symbol === 'SHOP.TO');
  assert.ok(shop, 'SHOP entry present');
  assert.ok(Math.abs(shop.totalPnlCad - 500) < 1e-6, 'P&L reflects price at clamp date');
});

test('symbols closed before range are excluded', async () => {
  const account = { id: 'test:6', number: 'test:6' };
  const login = { id: 'login' };
  const buyDate = '2025-01-05';
  const sellDate = '2025-01-15';
  const start = '2025-02-01';
  const end = '2025-02-28';
  const activities = [
    { type: 'Trades', action: 'Buy', symbol: 'MSFT', quantity: 10, netAmount: -1000, currency: 'USD', tradeDate: buyDate },
    { type: 'Trades', action: 'Sell', symbol: 'MSFT', quantity: -10, netAmount: 1100, currency: 'USD', tradeDate: sellDate },
  ];
  const ctx = makeContext(account.id, buyDate, end, activities);
  const priceSeries = new Map([
    ['MSFT', new Map([[d(buyDate), 100], [d(sellDate), 110], [d(start), 120], [d(end), 130]])],
  ]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: false,
    displayStartKey: d(start),
    displayEndKey: d(end),
    priceSeriesBySymbol: priceSeries,
  });
  assert.equal(result.entries.length, 0, 'No entries when symbol closed before range');
});

test('annualizedReturn is computed from symbol cash flows', async () => {
  const account = { id: 'test:7', number: 'test:7', cagrStartDate: '2025-01-01' };
  const login = { id: 'login' };
  const start = '2025-01-01';
  const end = '2026-01-01';
  const activities = [
    { type: 'Trades', action: 'Buy', symbol: 'ABC', quantity: 1, netAmount: -100, currency: 'CAD', tradeDate: start },
  ];
  const ctx = makeContext(account.id, start, end, activities);
  const priceSeries = new Map([
    ['ABC', new Map([[d(start), 100], [d(end), 110]])],
  ]);
  const endHoldings = new Map([['ABC', 1]]);
  const usdRates = new Map([[d(start), 1], [d(end), 1]]);
  const result = await computeTotalPnlBySymbol(login, account, {
    activityContext: ctx,
    applyAccountCagrStartDate: false,
    displayStartKey: d(start),
    displayEndKey: d(end),
    priceSeriesBySymbol: priceSeries,
    endHoldingsBySymbol: endHoldings,
    usdRatesByDate: usdRates,
  });
  const abc = result.entries.find((e) => e.symbol === 'ABC');
  assert.ok(abc, 'ABC entry present');
  assert.ok(abc.annualizedReturn, 'annualized return populated');
  assert.equal(abc.annualizedReturn.cashFlowCount, 2);
  assert.equal(abc.annualizedReturn.startDate, d(start));
  assert.ok(Math.abs(abc.annualizedReturn.rate - 0.1) < 1e-6, 'XIRR close to 10%');
  assert.ok(abc.annualizedReturnNoFx, 'no-FX annualized present');
  assert.ok(Math.abs(abc.annualizedReturnNoFx.rate - 0.1) < 1e-6, 'no-FX XIRR close to 10%');
});
