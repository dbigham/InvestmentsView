'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../src/index.js');

test('filterCashFlowsAfterDisplayStart drops same-day flows to avoid double-counting start equity', () => {
  // The display-start equity snapshot already reflects same-day funding,
  // so those cash flows should not be replayed in the XIRR schedule.
  const startDate = new Date('2025-09-18T00:00:00Z');
  const flows = [
    { amount: -100, date: '2025-09-18T00:00:00Z' },
    { amount: -200, date: '2025-09-18T05:00:00Z' },
    { amount: -50, date: '2025-09-19T00:00:00Z' },
  ];

  const filtered = __test__.filterCashFlowsAfterDisplayStart(flows, startDate);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].amount, -50);
  assert.equal(filtered[0].date.toISOString(), '2025-09-19T00:00:00.000Z');
});
