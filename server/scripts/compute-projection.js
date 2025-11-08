#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { buildRetirementModel } = require('../src/lib/retirementModel');
const accountNames = require('../src/accountNames');
const server = require('../src/index.js');

function toDateOnly(date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const years = Math.floor(targetMonth / 12);
  const newMonth = ((targetMonth % 12) + 12) % 12;
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCMonth(newMonth);
  return d;
}

function yearsBetween(from, to) {
  return (to.getTime() - from.getTime()) / (365.2425 * 24 * 60 * 60 * 1000);
}

function loadAccounts(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const opts = { name: 'RRSP', years: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--today') opts.today = argv[++i];
    else if (a === '--age') opts.age = Number(argv[++i]);
    else if (a === '--years') opts.years = Number(argv[++i]);
    else if (a === '--equity') opts.equity = Number(argv[++i]);
    else if (a === '--rate') opts.rate = Number(argv[++i]);
    else if (a === '--inflation') opts.inflation = Number(argv[++i]);
    else if (!opts.name) opts.name = a; else opts.name = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const name = opts.name || 'RRSP';

  // Resolve group metadata (retirement settings)
  const groupMeta = accountNames.getAccountGroupMetadata();
  const targetKey = Object.keys(groupMeta).find((k) => (groupMeta[k]?.name || '').toLowerCase() === name.toLowerCase());
  if (!targetKey) {
    console.error('Group not found in account metadata:', name);
    process.exit(2);
  }
  const acct = { mainRetirementAccount: true, ...groupMeta[targetKey] };
  if (Number.isFinite(opts.inflation)) {
    acct.retirementInflationPercent = opts.inflation;
  }
  const model = buildRetirementModel(acct, { todayDate: opts.today || null, overrideRetirementAge: opts.age || null });

  // Build leaf accounts for this group using accounts.json + live balances
  const settings = accountNames.getAccountSettings();
  const relations = accountNames.getAccountGroupRelations();

  function isDescendant(groupName, ancestorName) {
    if (!groupName) return false;
    if (groupName.toLowerCase() === ancestorName.toLowerCase()) return true;
    const parents = relations[groupName] || [];
    return parents.some((p) => isDescendant(p, ancestorName));
  }

  // Load live accounts to map numbers -> ids and fetch balances
  const logins = server.getAllLogins();
  const accounts = [];
  for (const login of logins) {
    try {
      const list = await server.fetchAccounts(login);
      list.forEach((a) => accounts.push({ login, id: a.id, number: String(a.number) }));
    } catch (e) {
      // continue
    }
  }

  const leaves = [];
  // Settings keys are account identifiers (usually account number strings)
  Object.keys(settings).forEach((key) => {
    const s = settings[key];
    const group = s?.accountGroup;
    if (!group || !isDescendant(group, name)) return;
    // Treat numeric keys as concrete account numbers
    if (!/^\d{6,}$/.test(key)) return;
    const acc = accounts.find((a) => a.number === key);
    if (!acc) return;
    leaves.push({ number: key, id: acc.id, login: acc.login, ratePercent: Number.isFinite(s?.projectionGrowthPercent) ? s.projectionGrowthPercent : null });
  });

  if (!leaves.length) {
    console.error('No leaf accounts resolved under group', name);
    process.exit(2);
  }

  // Fetch balances for leaves
  for (const leaf of leaves) {
    try {
      const raw = await server.fetchBalances(leaf.login, leaf.id);
      const summary = server.summarizeAccountBalances(raw) || raw;
      leaf.equity = Number(summary?.totalEquityCad) || 0;
    } catch (e) {
      leaf.equity = 0;
    }
  }

  // Fallback if no balances available: proportionally split provided equity
  let startingTotal = leaves.reduce((s, l) => s + (l.equity || 0), 0);
  if (!(startingTotal > 0)) {
    const total = Number(opts.equity) || 0;
    const per = total / leaves.length;
    leaves.forEach((l) => { l.equity = per; });
    startingTotal = total;
  }

  const startDate = toDateOnly(new Date(opts.today || new Date()));
  const totalMonths = Math.max(1, Math.round((opts.years || 50) * 12));
  // Per-leaf monthly rates
  const childStates = leaves.map((l) => ({
    value: Number(l.equity) || 0,
    // Match UI behavior: if a leaf rate is missing, treat as 0 (no growth) rather than using a global fallback.
    monthlyRate: Math.pow(1 + ((Number(l.ratePercent) || 0) / 100), 1 / 12) - 1,
  }));
  const monthly = [];

  function computeFlow(date) {
    if (!model.startDate || date < model.startDate) return 0;
    const elapsedYears = yearsBetween(model.startDate, date);
    const expenseMultiplier = elapsedYears > 0 ? Math.pow(1 + model.inflationRate, elapsedYears) : 1;
    const monthlyExpenses = (model.livingExpensesAnnual * expenseMultiplier) / 12;
    let pensionMonthly = 0;
    (model.persons || []).forEach((p) => {
      if (p.cppStartDate && date >= p.cppStartDate) {
        const yrs = yearsBetween(p.cppStartDate, date);
        const factor = yrs > 0 ? Math.pow(1 + model.inflationRate, yrs) : 1;
        pensionMonthly += (p.cppAnnualAtStart * factor) / 12;
      }
      if (p.oasStartDate && date >= p.oasStartDate) {
        const yrs = yearsBetween(p.oasStartDate, date);
        const factor = yrs > 0 ? Math.pow(1 + model.inflationRate, yrs) : 1;
        pensionMonthly += (p.oasAnnualAtStart * factor) / 12;
      }
    });
    return model.incomeMonthly + pensionMonthly - monthlyExpenses;
  }

  for (let i = 0; i <= totalMonths; i += 1) {
    const dateAtI = addMonths(startDate, i);
    if (i > 0) {
      childStates.forEach((s) => { s.value *= 1 + s.monthlyRate; });
      const flow = computeFlow(dateAtI);
      if (Number.isFinite(flow) && flow !== 0) {
        let aggregate = childStates.reduce((sum, s) => sum + s.value, 0);
        if (aggregate <= 0) {
          childStates[0].value += flow;
        } else {
          childStates.forEach((s) => { s.value += (s.value / aggregate) * flow; });
        }
      }
    }
    const totalValue = childStates.reduce((sum, s) => sum + s.value, 0);
    monthly.push({ date: dateAtI.toISOString().slice(0, 10), value: totalValue });
  }

  const result = {
    model: {
      startDate: model.startDate ? model.startDate.toISOString().slice(0, 10) : null,
      inflationRate: model.inflationRate,
      factor: model.factor,
      cppAnnualAtStart: Math.round(model.cppAnnualAtStart),
      oasAnnualAtStart: Math.round(model.oasAnnualAtStart),
    },
    leaves: leaves.map((l) => ({ number: l.number, equity: l.equity, ratePercent: l.ratePercent })),
    startTotal: startingTotal,
    final: monthly[monthly.length - 1],
  };
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}
