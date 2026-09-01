import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccountSummaryUrl,
  isWealthsimpleAccount,
  resolveAccountPortalName,
} from './questrade.js';

test('buildAccountSummaryUrl preserves Questrade account deep links', () => {
  const account = { provider: 'questrade', portalAccountId: 'account id' };

  assert.equal(
    buildAccountSummaryUrl(account),
    'https://myportal.questrade.com/investing/summary/accounts/account%20id'
  );
  assert.equal(resolveAccountPortalName(account), 'Questrade');
});

test('buildAccountSummaryUrl opens Wealthsimple for a Wealthsimple SnapTrade account', () => {
  const account = {
    provider: 'snaptrade',
    platformLabel: 'Wealthsimple Trade',
    providerAccountId: '35ec51ff-cc7a-4ed7-abee-34ae7d8ef46d',
  };

  assert.equal(isWealthsimpleAccount(account), true);
  assert.equal(buildAccountSummaryUrl(account), 'https://my.wealthsimple.com/app');
  assert.equal(resolveAccountPortalName(account), 'Wealthsimple');
});

test('generic SnapTrade accounts are not treated as Wealthsimple accounts', () => {
  const account = { provider: 'snaptrade', platformLabel: 'Another brokerage' };

  assert.equal(isWealthsimpleAccount(account), false);
  assert.equal(buildAccountSummaryUrl(account), null);
  assert.equal(resolveAccountPortalName(account), null);
});
