const test = require('node:test');
const assert = require('node:assert/strict');
const { supplementSnapTradeExecutions } = require('../src/snapTradeExecutions');
const { computeTotalPnlSeries, __test__ } = require('../src/index');

const window = { startDate: '2026-09-20', endDate: '2026-09-22' };
function order(overrides = {}) {
  return { id: 'sale', orderId: 'sale', symbol: 'XYZ.TO', currency: 'CAD',
    state: 'EXECUTED', action: 'SELL', filledQuantity: 3, openQuantity: 0,
    avgExecPrice: 110, executionTime: '2026-09-21T18:00:00Z', ...overrides };
}

// SnapTrade's symbol field may be a brokerage UUID; the universal instrument
// and actual execution price identify the trade, not that UUID or a limit price.
test('normalizes provider execution fields', () => {
  const normalized = __test__.normalizeSnapTradeOrder({
    brokerage_order_id: 'sale', symbol: 'brokerage-uuid',
    universal_symbol: { symbol: 'XYZ.TO', currency: { code: 'CAD' } },
    action: 'SELL', status: 'EXECUTED', filled_quantity: '3',
    execution_price: '110', time_executed: '2026-09-21T18:00:00Z',
  });
  assert.equal(normalized.symbol, 'XYZ.TO');
  assert.equal(normalized.avgExecPrice, 110);
  assert.equal(normalized.executionTime, '2026-09-21T18:00:00Z');
});

// A posted transaction is authoritative, including its actual fees. Repeating
// refreshes or receiving that transaction later must not duplicate a fill.
test('bridges a missing execution exactly once and yields to posted activities', () => {
  const bridged = supplementSnapTradeExecutions([], [order(), order()], window);
  assert.equal(bridged.length, 1);
  assert.equal(bridged[0].quantity, -3);
  assert.equal(bridged[0].netAmount, 330);
  assert.deepEqual(supplementSnapTradeExecutions(bridged, [order()], window), bridged);
  const posted = { ...bridged[0], id: 'transaction', source: 'snaptrade', netAmount: 329 };
  assert.deepEqual(supplementSnapTradeExecutions([...bridged, posted], [order()], window), [posted]);
});

// Same-day round trips need both cash and quantity legs. Matching a sale must
// not suppress a later purchase or another sale of the same share count.
test('preserves separate same-day executions and deducts known commissions', () => {
  const orders = [order(), order({ id: 'buy', orderId: 'buy', action: 'BUY', commission: 1,
    executionTime: '2026-09-21T19:00:00Z' })];
  const result = supplementSnapTradeExecutions([], orders, window);
  assert.equal(result.length, 2);
  assert.equal(result.reduce((sum, activity) => sum + activity.quantity, 0), 0);
  assert.equal(result.reduce((sum, activity) => sum + activity.netAmount, 0), -1);
});

// Canceled orders, partial fills, undated executions, and old orders are not
// evidence of another completed trade in the unsynced transaction window.
test('does not invent fills from incomplete or out-of-window orders', () => {
  for (const overrides of [{ state: 'CANCELED' }, { state: 'PARTIALLY_FILLED' },
    { executionTime: null }, { executionTime: '2026-09-01' }, { avgExecPrice: null },
    { openQuantity: 1 }, { action: 'SELL_SHORT' }, { filledQuantity: 0 }]) {
    assert.deepEqual(supplementSnapTradeExecutions([], [order(overrides)], window), []);
  }
});

// Brokers can consolidate fills or use dates that don't identify individual
// executions. In those cases no additional order is safer than double counting.
test('consolidated or ambiguous activity matches are not supplemented', () => {
  const posted = { symbol: 'XYZ.TO', currency: 'CAD', action: 'SELL', quantity: -6,
    tradeDate: '2026-09-21T00:00:00Z' };
  const orders = [order(), order({ id: 'sale2', orderId: 'sale2', executionTime: '2026-09-21T19:00:00Z' })];
  assert.deepEqual(supplementSnapTradeExecutions([posted], orders, window), [posted]);
  const partial = { ...posted, quantity: -1 };
  assert.deepEqual(supplementSnapTradeExecutions([partial], orders, window), [partial]);
  const previousSupplements = supplementSnapTradeExecutions([], orders, window);
  assert.deepEqual(supplementSnapTradeExecutions([...previousSupplements, posted], orders, window), [posted]);
});

// Two identical-size sales can be distinct executions. Match each posted row
// only once, otherwise one transaction could incorrectly hide the second sale.
test('matches posted executions one to one within a same-day group', () => {
  const orders = [order(), order({ id: 'sale2', orderId: 'sale2', executionTime: '2026-09-21T19:00:00Z' })];
  const first = { symbol: 'XYZ.TO', currency: 'CAD', action: 'SELL', quantity: -3,
    tradeDate: '2026-09-21T18:00:00Z', netAmount: 330 };
  const result = supplementSnapTradeExecutions([first], orders, window);
  assert.equal(result.length, 2);
  assert.equal(result[1].orderId, 'sale2');
});

// Selling in September cannot generate profit from a July price fall before
// the shares were bought. Complete executions must restore the same historical
// equity and cash as a complete transaction ledger, including realized profit.
test('late sale reporting cannot create a historical short or July P&L spike', async () => {
  const buy = { id: 'buy', symbol: 'XYZ.TO', currency: 'CAD', type: 'BUY', action: 'BUY',
    quantity: 3, netAmount: -300, price: 100, tradeDate: '2026-07-24T14:00:00Z' };
  const activities = supplementSnapTradeExecutions([buy], [order()], window);
  const account = { id: 'execution-test', historyStartDate: '2026-07-22' };
  const now = new Date('2026-09-21T20:00:00Z');
  const result = await computeTotalPnlSeries({ id: 'snap', provider: 'snaptrade' }, account,
    { [account.id]: { combined: { CAD: { totalEquity: 1030, cash: 1030 } },
      perCurrency: { CAD: { totalEquity: 1030, cash: 1030 } } } },
    { applyAccountCagrStartDate: false, providedPositions: [],
      activityContext: { accountId: account.id, accountKey: account.id, accountNumber: account.id,
        crawlStart: new Date('2026-07-22'), earliestFunding: new Date('2026-07-22'),
        now, nowIsoString: now.toISOString(), offlineOnly: true, activities, fingerprint: 'executions' },
      priceSeriesBySymbol: new Map([['XYZ.TO', new Map([
        ['2026-07-22', 150], ['2026-07-23', 100], ['2026-07-24', 100], ['2026-09-21', 110],
      ])]]) });
  assert.equal(result.points.find(point => point.date === '2026-07-22').equityCad, 1000);
  assert.equal(result.points.find(point => point.date === '2026-07-23').equityCad, 1000);
  assert.equal(result.points.at(-1).equityCad, 1030);
  assert.equal(result.points.at(-1).totalPnlCad, 30);
});
