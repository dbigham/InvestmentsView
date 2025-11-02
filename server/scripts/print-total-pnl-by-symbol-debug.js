// Ad-hoc debug CLI to print per-symbol Total P&L for a synthetic scenario.
// Mirrors the unit-test setup to help diagnose computeTotalPnlBySymbol.
// Usage: npm run debug:pnl-by-symbol
/* eslint-disable node/no-unsupported-features/node-builtins */
const { computeTotalPnlBySymbol } = require('../src/index.js');

function d(s) { return new Date(s).toISOString().slice(0,10); }

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
    fingerprint: 'debug',
    fetchBookValueTransferPrice: async () => null,
  };
}

async function run() {
  const start = '2025-10-01';
  const end = '2025-10-31';

  // Scenario 1: Journaling DLR -> DLR.U flow nets to ~0
  const account1 = { id: 'debug:1', number: 'debug:1', cagrStartDate: start };
  const activities1 = [
    { type: 'Trades', action: 'Buy', symbol: 'DLR.TO', quantity: 100, netAmount: -1000, currency: 'CAD', tradeDate: start },
    { type: 'Transfers', action: 'Journal', symbol: 'DLR.TO', quantity: -100, netAmount: 0, currency: 'CAD', description: 'journal to DLR.U.TO', tradeDate: '2025-10-10' },
    { type: 'Transfers', action: 'Journal', symbol: 'DLR.U.TO', quantity: 100, netAmount: 0, currency: 'CAD', description: 'journal from DLR.TO', tradeDate: '2025-10-10' },
    { type: 'Trades', action: 'Sell', symbol: 'DLR.U.TO', quantity: -100, netAmount: 1000, currency: 'CAD', tradeDate: end },
  ];
  const ctx1 = makeContext(account1.id, start, end, activities1);
  const priceSeries1 = new Map([
    ['DLR.TO', new Map([[d(start), 10],[d('2025-10-10'),10],[d(end),10]])],
    ['DLR.U.TO', new Map([[d(start), 10],[d('2025-10-10'),10],[d(end),10]])],
  ]);
  const endHoldings1 = new Map([['DLR', 0]]);
  const result1 = await computeTotalPnlBySymbol({}, account1, {
    activityContext: ctx1,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries1,
    endHoldingsBySymbol: endHoldings1,
  });
  console.log('DLR journaling scenario:', JSON.stringify(result1, null, 2));

  // Scenario 2: SGOV transfer-out after start nets ~0
  const account2 = { id: 'debug:2', number: 'debug:2', cagrStartDate: start };
  const activities2 = [
    { type: 'Trades', action: 'Buy', symbol: 'SGOV', quantity: 100, netAmount: -10000, currency: 'USD', tradeDate: '2025-09-25' },
    { type: 'Transfers', action: 'TFO', symbol: 'SGOV', quantity: -100, netAmount: 0, currency: 'USD', description: 'TRANSFER BOOK VALUE', tradeDate: '2025-10-10' },
  ];
  const ctx2 = makeContext(account2.id, start, end, activities2);
  const priceSeries2 = new Map([
    ['SGOV', new Map([[d(start), 100],[d('2025-10-10'),100],[d(end),100]])],
  ]);
  const usdRates = new Map([[d(start), 1.3],[d('2025-10-10'),1.3],[d(end),1.3]]);
  const endHoldings2 = new Map([['SGOV', 0]]);
  const result2 = await computeTotalPnlBySymbol({}, account2, {
    activityContext: ctx2,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries2,
    usdRatesByDate: usdRates,
    endHoldingsBySymbol: endHoldings2,
  });
  console.log('SGOV transfer-out scenario:', JSON.stringify(result2, null, 2));

  // Scenario 3: UNH round-trip small gain since start
  const account3 = { id: 'debug:3', number: 'debug:3', cagrStartDate: start };
  const activities3 = [
    { type: 'Trades', action: 'Buy', symbol: 'UNH', quantity: 5, netAmount: -500, currency: 'USD', tradeDate: '2025-10-05' },
    { type: 'Trades', action: 'Sell', symbol: 'UNH', quantity: -5, netAmount: 505, currency: 'USD', tradeDate: '2025-10-20' },
  ];
  const ctx3 = makeContext(account3.id, start, end, activities3);
  const priceSeries3 = new Map([
    ['UNH', new Map([[d('2025-10-01'), 100],[d('2025-10-05'),100],[d('2025-10-20'),101],[d('2025-10-31'),101]])],
  ]);
  const usdRates3 = new Map([[d('2025-10-01'), 1.3],[d('2025-10-05'),1.3],[d('2025-10-20'),1.3],[d('2025-10-31'),1.3]]);
  const endHoldings3 = new Map([['UNH', 0]]);
  const result3 = await computeTotalPnlBySymbol({}, account3, {
    activityContext: ctx3,
    applyAccountCagrStartDate: true,
    displayStartKey: d(start),
    priceSeriesBySymbol: priceSeries3,
    usdRatesByDate: usdRates3,
    endHoldingsBySymbol: endHoldings3,
  });
  console.log('UNH since-start scenario:', JSON.stringify(result3, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
