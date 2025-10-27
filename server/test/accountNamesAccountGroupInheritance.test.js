const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '../src/accountNames.js');

function loadAccountSettingsFromConfig(config) {
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
    return accountNames.getAccountSettings();
  } finally {
    process.env.ACCOUNT_NAMES_FILE = originalEnvValue;
    delete require.cache[MODULE_PATH];
    try {
      fs.unlinkSync(tempFilePath);
    } catch (error) {
      // ignore cleanup errors
    }
  }
}

test('accounts inherit accountGroup from ancestors without overriding explicit settings', () => {
  const config = {
    '53384039': {
      accountGroup: 'Aggressive RRSP',
    },
    accounts: [
      {
        name: 'RRSP',
        accounts: [
          {
            name: 'Aggressive RRSP',
            accountGroup: 'RRSP',
            accounts: [
              {
                number: '53384039',
                name: 'Aggressive RRSP Core',
              },
            ],
          },
        ],
      },
    ],
  };

  const settings = loadAccountSettingsFromConfig(config);
  assert.ok(settings);
  assert.deepEqual(settings['53384039'], { accountGroup: 'Aggressive RRSP' });
});

test('accounts without explicit accountGroup inherit from the nearest ancestor', () => {
  const config = {
    accounts: [
      {
        name: 'Retirement',
        accounts: [
          {
            name: 'Aggressive RRSP',
            accountGroup: 'Aggressive RRSP',
            accounts: [
              { number: '111', name: 'Aggressive RRSP Core' },
              { number: '222', name: 'Aggressive RRSP Growth' },
            ],
          },
        ],
      },
    ],
  };

  const settings = loadAccountSettingsFromConfig(config);
  assert.ok(settings);
  assert.deepEqual(settings['111'], { accountGroup: 'Aggressive RRSP' });
  assert.deepEqual(settings['222'], { accountGroup: 'Aggressive RRSP' });
});
