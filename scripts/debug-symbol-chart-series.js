#!/usr/bin/env node

const path = require('path');
const dotenv = require(path.join(__dirname, '../server/node_modules/dotenv'));
dotenv.config({ path: path.join(__dirname, '../server/.env') });

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  applyAccountSettingsOverrides,
  buildAccountActivityContext,
  computeTotalPnlSeriesForSymbol,
  fetchBalances,
  summarizeAccountBalances,
} = require('../server/src/index.js');

const { buildTotalPnlDisplaySeries } = require('../shared/totalPnlDisplay.js');
const { getSymbolGroupMembers, normalizeSymbolKey } = require('../shared/symbolGroups.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function buildContexts() {
  const contexts = [];
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins configured');
  }
  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts = [];
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn('[debug-symbol-chart] Failed to fetch accounts for login', login.id + ':', message);
      continue;
    }
    accounts.forEach((account, index) => {
      if (!account) return;
      const rawNumber =
        account.number != null
          ? account.number
          : account.accountNumber != null
            ? account.accountNumber
            : account.id != null
              ? account.id
              : index;
      const normalizedNumber = rawNumber != null ? String(rawNumber).trim() : String(index);
      if (!normalizedNumber) return;
      const compositeId = `${login.id}:${normalizedNumber}`;
      const baseAccount = Object.assign({}, account, {
        id: compositeId,
        number: normalizedNumber,
        accountNumber: normalizedNumber,
        loginId: login.id,
      });
      const accountWithOverrides = applyAccountSettingsOverrides(baseAccount, login);
      const effectiveAccount = Object.assign({}, accountWithOverrides, {
        id: compositeId,
        number: accountWithOverrides.number || normalizedNumber,
      });
      contexts.push({ login, account: effectiveAccount });
    });
  }
  const hydrated = [];
  for (const context of contexts) {
    try {
      const activityContext = await buildAccountActivityContext(context.login, context.account);
      hydrated.push({ ...context, activityContext });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn('[debug-symbol-chart] Failed to build activity context for', context.account.id + ':', message);
    }
  }
  return hydrated;
}

async function buildBalancesMap(contexts) {
  const map = {};
  for (const context of contexts) {
    try {
      const balancesRaw = await fetchBalances(context.login, context.account.number);
      const summary = summarizeAccountBalances(balancesRaw) || balancesRaw;
      map[context.account.id] = summary;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn('[debug-symbol-chart] Failed to fetch balances for', context.account.id + ':', message);
    }
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv);
  const rawSymbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
  if (!rawSymbol) {
    console.error('Usage: node scripts/debug-symbol-chart-series.js --symbol ENB');
    process.exit(1);
  }
  const symbolKey = normalizeSymbolKey(rawSymbol);
  const members = getSymbolGroupMembers(symbolKey);
  if (!members.length) {
    console.error('Unknown symbol:', rawSymbol);
    process.exit(1);
  }

  const contexts = await buildContexts();
  const balancesMap = await buildBalancesMap(contexts);

  // Collect per-account symbol series and aggregate into a single series
  const aggregatedByDate = new Map();
  let aggregatedTotal = 0;

  for (const context of contexts) {
    try {
      const perAccountBalances = { [context.account.id]: balancesMap[context.account.id] };
      const series = await computeTotalPnlSeriesForSymbol(
        context.login,
        context.account,
        perAccountBalances,
        {
          activityContext: context.activityContext,
          symbol: symbolKey,
          applyAccountCagrStartDate: false,
        }
      );
      if (!series || !Array.isArray(series.points)) {
        continue;
      }
      if (series.summary && Number.isFinite(series.summary.totalPnlCad)) {
        aggregatedTotal += series.summary.totalPnlCad;
      }
      series.points.forEach((point) => {
        const dateKey = point && typeof point.date === 'string' ? point.date : null;
        if (!dateKey) return;
        const pnl = Number(point.totalPnlCad);
        if (!Number.isFinite(pnl)) return;
        const existing = aggregatedByDate.get(dateKey) || { date: dateKey, totalPnlCad: 0 };
        existing.totalPnlCad += pnl;
        aggregatedByDate.set(dateKey, existing);
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn('[debug-symbol-chart] Failed series for', context.account.id + ':', message);
    }
  }

  const dates = Array.from(aggregatedByDate.keys()).sort();
  if (!dates.length) {
    console.error('No aggregated series available.');
    process.exit(2);
  }
  const aggregatedSeries = dates.map((d) => aggregatedByDate.get(d));
  const last = aggregatedSeries[aggregatedSeries.length - 1];

  // Emulate old chart behaviour: treat first active date as displayStartDate and
  // show P&L relative to that baseline.
  let firstActiveIndex = 0;
  for (let i = 0; i < aggregatedSeries.length; i += 1) {
    const p = aggregatedSeries[i] || {};
    const t = Number(p.totalPnlCad);
    if (Number.isFinite(t) && Math.abs(t) > 1e-6) {
      firstActiveIndex = i;
      break;
    }
  }

  const firstActiveDate = aggregatedSeries[firstActiveIndex].date;
  const legacyDisplaySeries = buildTotalPnlDisplaySeries(aggregatedSeries, 'ALL', {
    displayStartDate: firstActiveDate,
  });
  const legacyLast = legacyDisplaySeries[legacyDisplaySeries.length - 1];
  const legacyChartValue = Number(legacyLast.totalPnlSinceDisplayStartCad);

  // Emulate new behaviour: trim leading inactive points but keep absolute P&L.
  const trimmedSeries = aggregatedSeries.slice(firstActiveIndex);
  const newDisplaySeries = buildTotalPnlDisplaySeries(trimmedSeries, 'ALL');
  const newLast = newDisplaySeries[newDisplaySeries.length - 1];
  const newChartValue = Number(newLast.totalPnlCad);

  const payload = {
    symbol: symbolKey,
    symbolMembers: members,
    aggregatedSeriesLastTotalCad: Number(last.totalPnlCad),
    aggregatedTotalFromSummariesCad: aggregatedTotal,
    firstActiveDate,
    legacyChartValueCad: legacyChartValue,
    newChartValueCad: newChartValue,
    lastDate: last.date,
  };

  console.log(JSON.stringify(payload, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error('[debug-symbol-chart] Error:', message);
    process.exit(1);
  });
}
