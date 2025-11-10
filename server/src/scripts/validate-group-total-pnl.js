#!/usr/bin/env node

/*
  Validate group-level Total P&L aggregation.

  - Resolves a group by id or name via accounts.json settings
  - Fetches all accounts across all logins and applies settings
  - Computes an aggregated "all-time" Total P&L series by summing per-account series
  - Also aggregates per-account funding summaries (all-time) as a cross-check
  - Compares the final series point vs the aggregated funding P&L and exits non-zero on mismatch

  Usage:
    cd server
    node src/scripts/validate-group-total-pnl.js --group RRSP [--threshold 0.05]
    node src/scripts/validate-group-total-pnl.js --group group:rrsp [--threshold 0.05]
*/

require('dotenv').config();

const path = require('path');
const { pathToFileURL } = require('url');

const accountNames = require('../accountNames');
const { assignAccountGroups } = require('../grouping');

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  fetchBalances,
  summarizeAccountBalances,
  applyAccountSettingsOverrides,
  computeTotalPnlSeries,
  computeNetDeposits,
} = require('../index.js');

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=');
        options[k] = v;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { options, positional };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value >= 0 ? '' : '-';
  const abs = Math.abs(value);
  return sign + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function normalizeGroupKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

async function loadAllAccountsWithSettings() {
  const logins = getAllLogins();
  if (!logins || !logins.length) {
    throw new Error('No Questrade logins available. Seed server/token-store.json first.');
  }

  const accounts = [];
  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let list = [];
    try {
      list = await fetchAccounts(login);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[validate-group] Failed to fetch accounts for login', login.id, msg);
      continue;
    }
    for (const acc of list) {
      const number = acc.number || acc.accountNumber || acc.id;
      const normalized = Object.assign({}, acc, { id: acc.id || number, number, loginId: login.id });
      const withSettings = applyAccountSettingsOverrides(normalized, login);
      accounts.push({ login, account: withSettings });
    }
  }
  return accounts;
}

function resolveGroupFromAccounts(allAccounts, groupKeyOrName) {
  const plainAccounts = allAccounts.map(({ account }) => account);
  const relations = accountNames.getAccountGroupRelations();
  const { accountGroups } = assignAccountGroups(plainAccounts, { groupRelations: relations });
  const target = groupKeyOrName.toLowerCase();
  let group = accountGroups.find((g) => g.id.toLowerCase() === target);
  if (!group) {
    group = accountGroups.find((g) => g.name && g.name.toLowerCase() === target);
  }
  return { group, accountGroups };
}

async function computeAggregateAllSeries(contexts, perAccountCombinedBalances) {
  const totalsByDate = new Map();
  const summaries = [];
  let minStart = null;
  let maxEnd = null;

  for (const ctx of contexts) {
    const options = { applyAccountCagrStartDate: false };
    let series = null;
    try {
      series = await computeTotalPnlSeries(ctx.login, ctx.account, perAccountCombinedBalances, options);
      if (!series) continue;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[validate-group] Failed per-account series for', ctx.account.id, msg);
      continue;
    }
    summaries.push(series.summary || {});
    if (typeof series.periodStartDate === 'string' && series.periodStartDate) {
      if (!minStart || series.periodStartDate < minStart) minStart = series.periodStartDate;
    }
    if (typeof series.periodEndDate === 'string' && series.periodEndDate) {
      if (!maxEnd || series.periodEndDate > maxEnd) maxEnd = series.periodEndDate;
    }
    if (Array.isArray(series.points)) {
      for (const p of series.points) {
        const date = p && p.date;
        if (!date) continue;
        let bucket = totalsByDate.get(date);
        if (!bucket) {
          bucket = { date, equity: 0, equityCount: 0, deposits: 0, depositsCount: 0, pnl: 0, pnlCount: 0 };
          totalsByDate.set(date, bucket);
        }
        const eq = Number(p.equityCad);
        const dep = Number(p.cumulativeNetDepositsCad);
        const pnl = Number(p.totalPnlCad);
        if (Number.isFinite(eq)) { bucket.equity += eq; bucket.equityCount += 1; }
        if (Number.isFinite(dep)) { bucket.deposits += dep; bucket.depositsCount += 1; }
        if (Number.isFinite(pnl)) { bucket.pnl += pnl; bucket.pnlCount += 1; }
      }
    }
  }

  const dates = Array.from(totalsByDate.keys()).sort();
  const points = dates.map((d) => {
    const b = totalsByDate.get(d);
    return {
      date: d,
      equityCad: b && b.equityCount > 0 ? b.equity : undefined,
      cumulativeNetDepositsCad: b && b.depositsCount > 0 ? b.deposits : undefined,
      totalPnlCad: b && b.pnlCount > 0 ? b.pnl : undefined,
    };
  }).filter((p) => p && Number.isFinite(p.totalPnlCad));

  if (!points.length) return null;

  const summary = { totalPnlAllTimeCad: 0, netDepositsAllTimeCad: 0, totalEquityCad: 0 };
  let sCount = { pnl: 0, dep: 0, eq: 0 };
  for (const s of summaries) {
    const tp = Number(s.totalPnlAllTimeCad);
    const nd = Number(s.netDepositsAllTimeCad || s.netDepositsCad);
    const eq = Number(s.totalEquityCad);
    if (Number.isFinite(tp)) { summary.totalPnlAllTimeCad += tp; sCount.pnl += 1; }
    if (Number.isFinite(nd)) { summary.netDepositsAllTimeCad += nd; sCount.dep += 1; }
    if (Number.isFinite(eq)) { summary.totalEquityCad += eq; sCount.eq += 1; }
  }
  if (sCount.pnl === 0) summary.totalPnlAllTimeCad = null;
  if (sCount.dep === 0) summary.netDepositsAllTimeCad = null;
  if (sCount.eq === 0) summary.totalEquityCad = null;

  return {
    periodStartDate: minStart || points[0].date,
    periodEndDate: maxEnd || points[points.length - 1].date,
    points,
    summary,
  };
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const groupIdOrName = normalizeGroupKey(options.group || options.id || options.name || null);
  if (!groupIdOrName) {
    console.error('Usage: node src/scripts/validate-group-total-pnl.js --group <name|group:id> [--threshold <cad>]');
    process.exit(1);
    return;
  }

  const threshold = Number.isFinite(Number(options.threshold)) ? Math.abs(Number(options.threshold)) : 0.05;

  const contexts = await loadAllAccountsWithSettings();
  const { group } = resolveGroupFromAccounts(contexts, groupIdOrName);
  if (!group || !Array.isArray(group.accounts) || !group.accounts.length) {
    console.error('Group not found or empty:', groupIdOrName);
    process.exit(2);
    return;
  }

  const allowed = new Set(group.accounts.map((a) => a && a.id).filter(Boolean));
  const groupContexts = contexts.filter((ctx) => allowed.has(ctx.account.id));

  // Per-account balances summary for equity computation
  const perAccountCombinedBalances = {};
  for (const ctx of groupContexts) {
    try {
      const balancesRaw = await fetchBalances(ctx.login, ctx.account.number);
      const summary = summarizeAccountBalances(balancesRaw) || balancesRaw;
      perAccountCombinedBalances[ctx.account.id] = summary;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[validate-group] Failed to fetch balances for', ctx.account.number, msg);
    }
  }

  // 1) Aggregate all-time series
  const aggregateSeries = await computeAggregateAllSeries(groupContexts, perAccountCombinedBalances);
  if (!aggregateSeries || !Array.isArray(aggregateSeries.points) || !aggregateSeries.points.length) {
    console.error('Unable to compute aggregate series for group', group.name || group.id);
    process.exit(1);
    return;
  }
  const last = aggregateSeries.points[aggregateSeries.points.length - 1];

  // 2) Aggregate funding summaries (all-time) as a cross-check
  let totalPnlFromFunding = 0;
  let fundingCount = 0;
  for (const ctx of groupContexts) {
    try {
      const fs = await computeNetDeposits(ctx.login, ctx.account, perAccountCombinedBalances, { applyAccountCagrStartDate: false });
      const pnl = fs && fs.totalPnl && fs.totalPnl.allTimeCad;
      if (Number.isFinite(pnl)) {
        totalPnlFromFunding += pnl;
        fundingCount += 1;
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[validate-group] Failed funding summary for', ctx.account.id, msg);
    }
  }

  const diff = Number.isFinite(last.totalPnlCad) && Number.isFinite(totalPnlFromFunding)
    ? last.totalPnlCad - totalPnlFromFunding
    : Number.NaN;
  const within = Number.isFinite(diff) ? Math.abs(diff) <= threshold : false;

  console.log('Group  :', group.id, '-', group.name);
  console.log('Members:', group.memberCount);
  console.log('Period :', aggregateSeries.periodStartDate, 'to', aggregateSeries.periodEndDate);
  console.log('Points :', aggregateSeries.points.length);
  console.log('Series final P&L  (CAD):', formatNumber(last.totalPnlCad));
  console.log('Funding sum P&L  (CAD):', formatNumber(totalPnlFromFunding));
  console.log('Difference        (CAD):', formatNumber(diff));
  console.log('Threshold         (CAD):', threshold);
  console.log('Within threshold:', within ? 'yes' : 'no');

  if (!within) {
    console.log('\nRecent aggregate points:');
    aggregateSeries.points.slice(-5).forEach((p) => {
      console.log(`${p.date} | equity=${formatNumber(p.equityCad)} | netDeposits=${formatNumber(p.cumulativeNetDepositsCad)} | totalPnl=${formatNumber(p.totalPnlCad)}`);
    });
    process.exitCode = 1;
  } else {
    console.log('\nValidation succeeded.');
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});

