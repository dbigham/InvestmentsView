#!/usr/bin/env node
/*
  Prints group relations inferred from accounts.json and, optionally,
  synthesizes aggregate accountGroups from a provided accounts payload.

  Usage:
    node src/scripts/debug-groups.js                # only prints groupRelations
    node src/scripts/debug-groups.js path/to/accounts.json

  For the second form, the file should contain an array or an object with an
  `accounts` array. Each account should at least have: id, number, accountGroup, ownerLabel.
*/

const fs = require('fs');
const path = require('path');

const accountNames = require('../accountNames');
const { assignAccountGroups } = require('../grouping');

function readJson(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

function main() {
  const [, , maybeAccountsPath] = process.argv;

  const filePath = accountNames.accountNamesFilePath;
  console.log('Accounts file path:', filePath);
  const relations = accountNames.getAccountGroupRelations();
  console.log('Inferred groupRelations:');
  console.log(JSON.stringify(relations, null, 2));

  if (maybeAccountsPath) {
    const fullPath = path.isAbsolute(maybeAccountsPath)
      ? maybeAccountsPath
      : path.join(process.cwd(), maybeAccountsPath);
    if (!fs.existsSync(fullPath)) {
      console.error('Accounts payload not found at', fullPath);
      process.exit(2);
    }
    const raw = readJson(fullPath);
    const accounts = Array.isArray(raw) ? raw : Array.isArray(raw.accounts) ? raw.accounts : [];
    console.log(`\nLoaded ${accounts.length} accounts from ${fullPath}`);
    const { accountGroups } = assignAccountGroups(accounts, { groupRelations: relations });
    console.log('\nSynthesized accountGroups (name, id, memberCount):');
    console.log(
      JSON.stringify(
        accountGroups.map((g) => ({ name: g.name, id: g.id, memberCount: g.memberCount })),
        null,
        2
      )
    );
  }
}

main();
