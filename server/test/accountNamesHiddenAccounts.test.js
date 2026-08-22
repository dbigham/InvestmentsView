const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '../src/accountNames.js');

function withTempAccountsConfig(config, fn) {
  const tempFilePath = path.join(
    os.tmpdir(),
    `account-names-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(tempFilePath, JSON.stringify(config, null, 2));

  const originalEnvValue = process.env.ACCOUNT_NAMES_FILE;
  process.env.ACCOUNT_NAMES_FILE = tempFilePath;

  delete require.cache[MODULE_PATH];
  try {
    const accountNames = require(MODULE_PATH);
    return fn(accountNames);
  } finally {
    process.env.ACCOUNT_NAMES_FILE = originalEnvValue;
    delete require.cache[MODULE_PATH];
    try {
      fs.unlinkSync(tempFilePath);
    } catch {}
  }
}

test('accounts can be hidden from provider-backed account lists', () => {
  const config = {
    accounts: [
      {
        id: 'snaptrade-user:duplicate-account',
        name: 'WS: Duplicate',
        accountGroup: 'Main RRSP',
        hidden: true,
      },
      {
        id: 'snaptrade-user:visible-account',
        name: 'WS: Visible',
        accountGroup: 'Main RRSP',
      },
    ],
  };

  const settings = withTempAccountsConfig(config, (mod) => mod.getAccountSettings());

  assert.equal(settings['snaptrade-user:duplicate-account'].hidden, true);
  assert.equal(settings['snaptrade-user:duplicate-account'].accountGroup, 'Main RRSP');
  assert.equal(Object.prototype.hasOwnProperty.call(settings['snaptrade-user:visible-account'], 'hidden'), false);
});

test('closed account metadata preserves lifecycle state and closure date', () => {
  const config = {
    accounts: [
      {
        id: 'questrade-user:closed-account',
        name: 'Legacy RRSP',
        closed: true,
        closedDate: '2026-07-15T12:00:00Z',
      },
    ],
  };

  const settings = withTempAccountsConfig(config, (mod) => mod.getAccountSettings());

  assert.deepEqual(settings['questrade-user:closed-account'], {
    closed: true,
    closedDate: '2026-07-15',
  });
});

test('investmentAccount metadata can mark visible accounts as non-investment accounts', () => {
  const config = {
    accounts: [
      {
        id: 'snaptrade-user:cash-account',
        name: 'WS: Cash',
      },
    ],
  };

  withTempAccountsConfig(config, (mod) => {
    const disabled = mod.updateAccountMetadata('snaptrade-user:cash-account', {
      investmentAccount: false,
    });
    assert.equal(disabled.updated, true);
    assert.equal(disabled.payload.investmentAccount, false);
    assert.equal(mod.getAccountSettings()['snaptrade-user:cash-account'].investmentAccount, false);

    const restored = mod.updateAccountMetadata('snaptrade-user:cash-account', {
      investmentAccount: true,
    });
    assert.equal(restored.updated, true);
    assert.equal(restored.payload.investmentAccount, true);
    const restoredSettings = mod.getAccountSettings()['snaptrade-user:cash-account'] || {};
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        restoredSettings,
        'investmentAccount'
      ),
      false
    );
  });
});
