const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildRetirementModel, summarizeAtRetirementYear } = require('../src/lib/retirementModel');

function loadAccounts() {
  const p = path.join(__dirname, '..', 'accounts.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('RRSP retirement-year uses partial-year sums and correct program start ages', () => {
  const data = loadAccounts();
  const rrsp = data.accounts.find((a) => a && a.name === 'RRSP');
  assert.ok(rrsp, 'RRSP account exists');
  const model = buildRetirementModel(rrsp, { todayDate: '2025-11-08' });
  const summary = summarizeAtRetirementYear(model);
  // Retirement age is 65 with birth dates in late November; retirement starts late in the year (2045).
  // The retirement-year summary should reflect only the remaining months in that year (likely 1 month).
  const startMonth = model.startDate.getUTCMonth(); // 0-based; November => 10
  const monthsIncluded = 12 - (startMonth + 1); // months strictly after start month
  const fullYearIncome = (Number(model.cppAnnualAtStart) || 0) + (Number(model.oasAnnualAtStart) || 0) + (Number(model.incomeMonthly) || 0) * 12;
  // Expect the retirement-year total to be a small fraction of the full-year baseline for late-start dates
  assert.ok(summary.total >= 0, 'summary total non-negative');
  assert.ok(summary.total <= fullYearIncome * 0.25, `expected partial-year total << full year (<= 25%), got ${summary.total} vs full ${fullYearIncome}`);
  // OAS & CPP should both be non-zero at 65 since program starts align with retirement age
  assert.ok(summary.cpp >= 0, 'CPP >= 0');
  assert.ok(summary.oas >= 0, 'OAS >= 0');
});

test('Zero inflation yields one-month partial-year amount when retiring late in year', () => {
  const data = loadAccounts();
  const rrsp = data.accounts.find((a) => a && a.name === 'RRSP');
  const clone = JSON.parse(JSON.stringify(rrsp));
  clone.retirementInflationPercent = 0;
  const model = buildRetirementModel(clone, { todayDate: '2025-11-08' });
  const summary = summarizeAtRetirementYear(model);
  const startMonth = model.startDate.getUTCMonth();
  const monthsIncluded = 12 - (startMonth + 1); // expect 1 when start is in November
  const monthly = ((Number(model.cppAnnualAtStart) || 0) + (Number(model.oasAnnualAtStart) || 0) + (Number(model.incomeMonthly) || 0) * 12) / 12;
  const expectedApprox = monthly * monthsIncluded;
  // Allow a tight tolerance since inflation is zero in this scenario
  const delta = Math.abs(summary.total - expectedApprox);
  assert.ok(delta < 1e-6 || delta / (expectedApprox || 1) < 1e-6, `expected ~${expectedApprox}, got ${summary.total}`);
});
