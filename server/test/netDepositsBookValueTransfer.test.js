const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeNetDepositsCore,
  __setBookValueTransferPriceFetcher,
} = require('../src/index.js');

function buildActivityContext(activity) {
  const now = new Date('2025-06-18T00:00:00Z');
  return {
    accountId: 'acct-1',
    accountNumber: 'acct-1',
    accountKey: 'acct-1',
    earliestFunding: new Date('2025-01-01T00:00:00Z'),
    crawlStart: new Date('2025-01-01T00:00:00Z'),
    activities: [activity],
    now,
    nowIsoString: now.toISOString(),
    fingerprint: 'test-fingerprint',
  };
}

function buildAccount() {
  return { id: 'acct-1', number: 'acct-1' };
}

test('book-value transfers use market value overrides when prices are available', async (t) => {
  t.after(() => __setBookValueTransferPriceFetcher(null));
  __setBookValueTransferPriceFetcher(async () => 300);

  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'SHOP.TO',
    description: 'SHOPIFY INC TRANSFER BOOK VALUE 25000.00',
    currency: 'CAD',
    quantity: 100,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const context = buildActivityContext(activity);
  const result = await computeNetDepositsCore(buildAccount(), null, {}, context);

  assert.ok(result);
  assert.equal(result.netDeposits.allTimeCad, 30000);
  assert.equal(result.netDeposits.perCurrency.CAD, 30000);
});

test('book-value transfers fall back to book value when price lookup fails', async (t) => {
  t.after(() => __setBookValueTransferPriceFetcher(null));
  __setBookValueTransferPriceFetcher(async () => null);

  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'SHOP.TO',
    description: 'SHOPIFY INC TRANSFER BOOK VALUE 25000.00',
    currency: 'CAD',
    quantity: 100,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const context = buildActivityContext(activity);
  const result = await computeNetDepositsCore(buildAccount(), null, {}, context);

  assert.ok(result);
  assert.equal(result.netDeposits.allTimeCad, 25000);
  assert.equal(result.netDeposits.perCurrency.CAD, 25000);
});

test('book-value transfer quantity can be parsed from description when missing', async (t) => {
  t.after(() => __setBookValueTransferPriceFetcher(null));
  __setBookValueTransferPriceFetcher(async () => 200);

  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'SHOP.TO',
    description: 'SHOPIFY INC 45.5 TRANSFER BOOK VALUE 5000.00',
    currency: 'CAD',
    quantity: 0,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const context = buildActivityContext(activity);
  const result = await computeNetDepositsCore(buildAccount(), null, {}, context);

  assert.ok(result);
  assert.equal(result.netDeposits.allTimeCad, 9100);
  assert.equal(result.netDeposits.perCurrency.CAD, 9100);
});
