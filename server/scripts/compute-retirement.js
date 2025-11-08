#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { buildRetirementModel, summarizeAtRetirementYear } = require('../src/lib/retirementModel');

function loadAccounts(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--today' && args[i + 1]) { opts.today = args[++i]; }
    else if (a === '--age' && args[i + 1]) { opts.age = Number(args[++i]); }
    else if (!opts.name) { opts.name = a; }
  }
  const root = path.resolve(__dirname, '..');
  const accountsPath = path.join(root, 'accounts.json');
  const data = loadAccounts(accountsPath);
  const name = opts.name || 'RRSP';
  const account = (data.accounts || []).find((a) => a && a.name === name) || (data.accounts || [])[0];
  if (!account) {
    console.error('No account found');
    process.exit(2);
  }
  if (account.mainRetirementAccount !== true) {
    console.error('Selected account is not marked as mainRetirementAccount');
  }
  const model = buildRetirementModel(account, { todayDate: opts.today || null, overrideRetirementAge: opts.age || null });
  const summary = summarizeAtRetirementYear(model);
  console.log(JSON.stringify({ model: {
    startDate: model.startDate ? model.startDate.toISOString().slice(0,10) : null,
    factor: model.factor,
    cppAnnualAtStart: Math.round(model.cppAnnualAtStart),
    oasAnnualAtStart: Math.round(model.oasAnnualAtStart),
  }, summary }, null, 2));
}

if (require.main === module) {
  main();
}

