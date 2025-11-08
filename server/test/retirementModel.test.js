const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildRetirementModel, summarizeAtRetirementYear } = require('../src/lib/retirementModel');

function loadAccounts() {
  const p = path.join(__dirname, '..', 'accounts.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('RRSP retirement-year CPP+OAS aligns with expected inflation', () => {
  const data = loadAccounts();
  const rrsp = data.accounts.find((a) => a && a.name === 'RRSP');
  assert.ok(rrsp, 'RRSP account exists');
  // Anchor to a fixed as-of date to stabilize the factor
  const model = buildRetirementModel(rrsp, { todayDate: '2025-11-08' });
  const summary = summarizeAtRetirementYear(model);
  // Expectations from manual calculation (~71,791.78)
  assert.ok(summary.total > 70000 && summary.total < 73000, `expected ~71.8k, got ${summary.total}`);
  // Also validate individual CPP and OAS orders of magnitude
  assert.ok(summary.cpp > 41000 && summary.cpp < 44000, `expected CPP ~42.7k, got ${summary.cpp}`);
  assert.ok(summary.oas > 28000 && summary.oas < 30000, `expected OAS ~29.1k, got ${summary.oas}`);
});

test('Zero inflation yields today-dollar entitlement at start', () => {
  const data = loadAccounts();
  const rrsp = data.accounts.find((a) => a && a.name === 'RRSP');
  const clone = JSON.parse(JSON.stringify(rrsp));
  clone.retirementInflationPercent = 0;
  const model = buildRetirementModel(clone, { todayDate: '2025-11-08' });
  const summary = summarizeAtRetirementYear(model);
  // Expect totals close to ~43,776 in 2025 dollars
  assert.ok(summary.total > 42000 && summary.total < 46000, `expected ~43.8k, got ${summary.total}`);
});

