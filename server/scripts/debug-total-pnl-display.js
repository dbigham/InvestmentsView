#!/usr/bin/env node

/* eslint-disable no-console */

require('dotenv').config();

const path = require('path');
const { pathToFileURL } = require('url');

const {
  computeTotalPnlSeries,
  getAllLogins,
  getLoginById,
  fetchAccounts,
  fetchBalances,
  summarizeAccountBalances,
  applyAccountSettingsOverrides,
} = require('../src/index.js');

function normalizeIdentifier(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed || null;
}

async function resolveAccountContext(identifier) {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json before running this script.');
  }

  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts = [];
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn('Failed to fetch accounts for login', login.id + ':', message);
      continue;
    }

    for (const account of accounts) {
      const candidates = [];
      if (account.id) candidates.push(String(account.id));
      if (account.number) candidates.push(String(account.number));
      if (account.accountNumber) candidates.push(String(account.accountNumber));
      if (account.name) candidates.push(String(account.name));

      const matched = candidates.some((candidate) => {
        if (!candidate || !normalizedIdentifier) {
          return false;
        }
        return candidate.trim().toLowerCase() === normalizedIdentifier.toLowerCase();
      });

      if (matched) {
        const accountNumber = account.number || account.accountNumber || account.id;
        const normalizedAccount = Object.assign({}, account, {
          id: account.id || accountNumber,
          loginId: login.id,
          number: accountNumber,
        });
        return { login, account: normalizedAccount };
      }
    }
  }

  throw new Error('Unable to locate account with identifier: ' + (identifier || '<none provided>'));
}

async function main() {
  const rawIdentifier = process.argv[2];
  const identifier = normalizeIdentifier(rawIdentifier);
  if (!identifier) {
    console.error('Usage: node server/scripts/debug-total-pnl-display.js <accountNumber|id|name>');
    process.exit(1);
    return;
  }

  const { login, account: baseAccount } = await resolveAccountContext(identifier);
  const account = applyAccountSettingsOverrides(baseAccount, login);

  console.log('Account:', account.number || account.id, '-', account.name || account.type || '');

  let balancesRaw;
  try {
    balancesRaw = await fetchBalances(login, account.number || account.id);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn('Failed to fetch balances for account', account.id + ':', message);
    balancesRaw = {};
  }

  const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
  const perAccountCombinedBalances = { [account.id]: balanceSummary };

  const series = await computeTotalPnlSeries(login, account, perAccountCombinedBalances, {
    applyAccountCagrStartDate: true,
  });
  if (!series || !Array.isArray(series.points) || !series.points.length) {
    console.error('No Total P&L series available for account', identifier);
    process.exit(1);
    return;
  }

  const sharedModule = await import(
    pathToFileURL(path.join(__dirname, '../../shared/totalPnlDisplay.js')).href
  );
  const { buildTotalPnlDisplaySeries } = sharedModule;

  const displaySeries = buildTotalPnlDisplaySeries(series.points, 'ALL', {
    displayStartDate: series.displayStartDate,
    displayStartTotals: series.summary && series.summary.displayStartTotals,
  });
  if (!Array.isArray(displaySeries) || !displaySeries.length) {
    console.error('Display series is empty for account', identifier);
    process.exit(1);
    return;
  }

  const targetTotal = Number.isFinite(series.summary?.totalPnlSinceDisplayStartCad)
    ? series.summary.totalPnlSinceDisplayStartCad
    : series.summary?.totalPnlCad ?? null;

  const first = displaySeries[0];
  const last = displaySeries[displaySeries.length - 1];
  const baseline =
    first && Number.isFinite(first.totalPnl)
      ? Number.isFinite(first.totalPnlDelta)
        ? first.totalPnl - first.totalPnlDelta
        : first.totalPnl
      : null;

  const absoluteLast = Number.isFinite(last.totalPnl) ? last.totalPnl : null;
  const deltaLast = Number.isFinite(last.totalPnlDelta) ? last.totalPnlDelta : null;

  const buggyDelta =
    deltaLast !== null && absoluteLast !== null && targetTotal !== null
      ? deltaLast + (targetTotal - absoluteLast)
      : null;

  const fixedDelta = targetTotal;
  const fixedAbsolute = baseline !== null && targetTotal !== null ? baseline + targetTotal : null;

  console.log('Display start date :', series.displayStartDate || '<none>');
  console.log('Baseline P&L (P0)  :', baseline);
  console.log('Last P&L absolute  :', absoluteLast);
  console.log('Last P&L delta     :', deltaLast);
  console.log('Target header P&L  :', targetTotal);
  console.log('Buggy chart delta  :', buggyDelta);
  console.log('Fixed chart delta  :', fixedDelta);
  console.log('Fixed chart P&L abs:', fixedAbsolute);
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error('debug-total-pnl-display failed:', message);
  process.exit(1);
});
