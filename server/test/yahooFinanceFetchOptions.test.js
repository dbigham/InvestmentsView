'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_YAHOO_FINANCE_USER_AGENT,
  buildYahooFinanceFetchOptions,
} = require('../src/yahooFinanceFetchOptions');

test('buildYahooFinanceFetchOptions uses the Yahoo-compatible user agent', () => {
  const dispatcher = { name: 'dispatcher' };

  const options = buildYahooFinanceFetchOptions({
    dispatcher,
    headers: {
      Accept: 'application/json',
      'user-agent': 'yahoo-finance2/2.13.3',
    },
  });

  assert.equal(options.dispatcher, dispatcher);
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(options.headers['User-Agent'], DEFAULT_YAHOO_FINANCE_USER_AGENT);
  assert.equal(options.headers['user-agent'], undefined);
});
