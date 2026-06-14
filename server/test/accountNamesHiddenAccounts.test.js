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
