const test = require('node:test');
const assert = require('node:assert/strict');

const { detectNorbertJournalCompletion } = require('../src/index.js');

test('detects completed DLR journaling pair', () => {
  const activities = [
    { type: 'Trades', action: 'Buy', symbol: 'DLR.TO', quantity: 100, tradeDate: '2025-10-01' },
    {
      type: 'Transfers',
      action: 'Journal',
      symbol: 'DLR.TO',
      quantity: -100,
      description: 'Journal to DLR.U.TO',
      tradeDate: '2025-10-05',
    },
    {
      type: 'Transfers',
      action: 'Journal',
      symbol: 'DLR.U.TO',
      quantity: 100,
      description: 'Journal from DLR.TO',
      tradeDate: '2025-10-05',
    },
  ];

  const result = detectNorbertJournalCompletion(activities);

  assert.ok(result, 'Expected journaling detection to succeed');
  assert.equal(result.toSymbol, 'DLR.U.TO');
  assert.equal(result.fromSymbol, 'DLR.TO');
  assert.equal(result.quantity, 100);
  assert.equal(result.journalDate, '2025-10-05');
  assert.equal(result.direction, 'to_usd');
  assert.ok(result.journalTimestamp);
});

test('ignores stale journal when later buy occurs', () => {
  const activities = [
    { type: 'Transfers', action: 'Journal', symbol: 'DLR.U.TO', quantity: 50, description: 'Journal from DLR.TO', tradeDate: '2025-09-15' },
    { type: 'Transfers', action: 'Journal', symbol: 'DLR.TO', quantity: -50, description: 'Journal to DLR.U.TO', tradeDate: '2025-09-15' },
    { type: 'Trades', action: 'Buy', symbol: 'DLR.U.TO', quantity: 10, tradeDate: '2025-10-01' },
  ];

  const result = detectNorbertJournalCompletion(activities);
  assert.equal(result, null);
});
