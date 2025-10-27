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

test('derives group-to-parent relations from nested containers', () => {
  const config = {
    accounts: [
      { name: 'RRSP' },
      { name: 'Main RRSP', accountGroup: 'RRSP' },
      { name: 'Aggressive RRSP', accountGroup: 'RRSP' },
      {
        name: 'Aggressive RRSP',
        accountGroup: 'RRSP',
        accounts: [
          { number: '11111', name: 'Aggressive RRSP Core' },
          { number: '22222', name: 'Aggressive RRSP Growth' },
        ],
      },
    ],
  };

  const result = withTempAccountsConfig(config, (mod) => mod.getAccountGroupRelations());
  assert.ok(result && typeof result === 'object');

  // Expect both child groups to point to RRSP
  assert.deepEqual(result['Main RRSP'], ['RRSP']);
  assert.deepEqual(result['Aggressive RRSP'], ['RRSP']);
});

