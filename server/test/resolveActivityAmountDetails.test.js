const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActivityAmountDetails } = require('../src/index.js');

test('book value transfer without USD hint uses inferred symbol currency', () => {
  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'TSLA',
    description:
      'TESLA INC COMMON STOCK INTL ADVISORY SERV GROUP 146.16 TRANSFER BOOK VALUE           37537.50',
    currency: 'CAD',
    quantity: 139,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const details = resolveActivityAmountDetails(activity);
  assert.ok(details, 'Expected amount details to be resolved');
  assert.equal(details.currency, 'USD');
  assert.equal(details.amount, 37537.5);
});

test('book value transfer with USD hint infers USD currency', () => {
  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'TSLA',
    description:
      'TESLA INC COMMON STOCK INTL ADVISORY SERV GROUP 146.16 TRANSFER BOOK VALUE           37537.50 USD',
    currency: 'CAD',
    quantity: 139,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const details = resolveActivityAmountDetails(activity);
  assert.ok(details, 'Expected amount details to be resolved');
  assert.equal(details.currency, 'USD');
  assert.equal(details.amount, 37537.5);
});

test('book value transfer keeps CAD when symbol is TSX listed', () => {
  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'SHOP.TO',
    description:
      'SHOPIFY INC SUBORDINATE VOTING SHARES INTL ADVISORY SERV GROUP 146.16 TRANSFER BOOK VALUE           25000.00',
    currency: 'CAD',
    quantity: 100,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const details = resolveActivityAmountDetails(activity);
  assert.ok(details, 'Expected amount details to be resolved');
  assert.equal(details.currency, 'CAD');
  assert.equal(details.amount, 25000);
});

test('book value transfer infers USD for TSX USD listings', () => {
  const activity = {
    tradeDate: '2025-10-09T00:00:00.000000-04:00',
    transactionDate: '2025-10-09T00:00:00.000000-04:00',
    settlementDate: '2025-10-09T00:00:00.000000-04:00',
    type: 'Other',
    action: 'BRW',
    symbol: 'DLR.U.TO',
    description:
      'GLOBAL X US DLR CURRENCY ETF UNIT CL A JOURNAL POSITION FROM CAD BOOK VALUE            232990.29 CNV@ 1.3953',
    currency: 'CAD',
    quantity: 22901,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const details = resolveActivityAmountDetails(activity);
  assert.ok(details, 'Expected amount details to be resolved');
  assert.equal(details.currency, 'USD');
  assert.equal(details.amount, 232990.29);
});

test('book value transfer respects explicit CAD hints in description', () => {
  const activity = {
    tradeDate: '2025-06-17T00:00:00.000000-04:00',
    transactionDate: '2025-06-17T00:00:00.000000-04:00',
    settlementDate: '2025-06-17T00:00:00.000000-04:00',
    type: 'Transfers',
    action: 'TF6',
    symbol: 'TSLA',
    description:
      'TESLA INC COMMON STOCK INTL ADVISORY SERV GROUP 146.16 TRANSFER BOOK VALUE           37537.50 CAD',
    currency: 'CAD',
    quantity: 139,
    price: 0,
    netAmount: 0,
    grossAmount: 0,
  };

  const details = resolveActivityAmountDetails(activity);
  assert.ok(details, 'Expected amount details to be resolved');
  assert.equal(details.currency, 'CAD');
  assert.equal(details.amount, 37537.5);
});

