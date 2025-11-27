const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeAggregateTotalPnlSeriesForContexts,
} = require('../src/index.js');

function buildActivityContext(accountId, activities, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date('2025-06-30T00:00:00Z');
  const earliestFunding =
    options.earliestFunding instanceof Date ? options.earliestFunding : new Date('2025-02-01T00:00:00Z');
  const crawlStart = options.crawlStart instanceof Date ? options.crawlStart : earliestFunding;
  return {
    accountId,
    accountKey: accountId,
    accountNumber: accountId,
    earliestFunding,
    crawlStart,
    activities: Array.isArray(activities) ? activities : [],
    now,
    nowIsoString: now.toISOString(),
    fingerprint: `${accountId}:fingerprint`,
  };
}

test('aggregate Total P&L trims member activity before each account cagrStartDate', async () => {
  const accountA = { id: 'acc:A', number: 'A-1', cagrStartDate: '2025-05-18' };
  const accountB = { id: 'acc:B', number: 'B-1' };

  const accountAActivities = [
    {
      tradeDate: '2025-02-01T00:00:00.000Z',
      transactionDate: '2025-02-01T00:00:00.000Z',
      settlementDate: '2025-02-01T00:00:00.000Z',
      type: 'Deposits',
      action: 'CON',
      currency: 'CAD',
      netAmount: 100,
      grossAmount: 100,
    },
    {
      tradeDate: '2025-06-01T00:00:00.000Z',
      transactionDate: '2025-06-01T00:00:00.000Z',
      settlementDate: '2025-06-01T00:00:00.000Z',
      type: 'Deposits',
      action: 'CON',
      currency: 'CAD',
      netAmount: 50,
      grossAmount: 50,
    },
  ];

  const accountBActivities = [
    {
      tradeDate: '2025-06-15T00:00:00.000Z',
      transactionDate: '2025-06-15T00:00:00.000Z',
      settlementDate: '2025-06-15T00:00:00.000Z',
      type: 'Deposits',
      action: 'CON',
      currency: 'CAD',
      netAmount: 200,
      grossAmount: 200,
    },
  ];

  const activityContextsById = {
    [accountA.id]: buildActivityContext(accountA.id, accountAActivities),
    [accountB.id]: buildActivityContext(accountB.id, accountBActivities, {
      earliestFunding: new Date('2025-06-15T00:00:00Z'),
      crawlStart: new Date('2025-06-15T00:00:00Z'),
    }),
  };

  const contexts = [
    { login: {}, account: accountA },
    { login: {}, account: accountB },
  ];

  const perAccountCombinedBalances = {
    [accountA.id]: { combined: { CAD: { cash: 150, totalEquity: 150 } } },
    [accountB.id]: { combined: { CAD: { cash: 200, totalEquity: 200 } } },
  };

  const resolveActivityContext = (ctx) => activityContextsById[ctx.account.id];

  const aggregateSeries = await computeAggregateTotalPnlSeriesForContexts(
    contexts,
    perAccountCombinedBalances,
    { applyAccountCagrStartDate: false },
    'group:test',
    false,
    resolveActivityContext
  );

  assert.ok(aggregateSeries && Array.isArray(aggregateSeries.points) && aggregateSeries.points.length > 0);
  const firstDate = aggregateSeries.points[0]?.date;
  assert.equal(
    firstDate,
    accountA.cagrStartDate,
    'aggregate series must not include dates before any member cagrStartDate'
  );
});
