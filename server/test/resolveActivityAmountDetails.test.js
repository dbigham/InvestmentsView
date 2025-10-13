const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActivityAmountDetails } = require('../src/index.js');

test('book value transfer without USD hint keeps activity currency', () => {
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
  assert.equal(details.currency, 'CAD');
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

