#!/usr/bin/env node

/**
 * Compare two sources of symbol-level Total P&L for the current dataset:
 *   1. The aggregated series produced by computeTotalPnlSeriesForSymbol
 *      (matches the chart / /api/accounts/.../total-pnl-series?symbol=XYZ).
 *   2. The sum of per-account totals from computeTotalPnlBySymbol, along with
 *      the net dividends captured in account activity (matches the Summary widget).
 *
 * Usage:
 *   node scripts/compare-symbol-pnl.js --symbol ENB
 */

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
  computeTotalPnlBySymbol,
  convertAmountToCad,
  resolveActivityTimestamp,
  fetchBalances,
  summarizeAccountBalances,
} = require('../server/src/index.js');
const {
  getSymbolGroupMembers,
  normalizeSymbolKey,
} = require('../shared/symbolGroups.cjs');

const INCOME_ACTIVITY_REGEX = /(dividend|distribution|interest|coupon)/i;

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

function normalizeSymbol(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed || '';
}

function buildActivitySymbolChecker(targetSymbols) {
  const targetList = Array.from(targetSymbols);
  return function activityMatchesSymbol(activity) {
    if (!activity) return false;
    const directSymbol = normalizeSymbol(activity.symbol);
    if (directSymbol && targetSymbols.has(directSymbol)) {
      return true;
    }
    const displaySymbol = normalizeSymbol(activity.displaySymbol);
    if (displaySymbol && targetSymbols.has(displaySymbol)) {
      return true;
    }
    const rawSymbols = Array.isArray(activity.rawSymbols)
      ? activity.rawSymbols.map(normalizeSymbol)
      : [];
    if (rawSymbols.some((sym) => sym && targetSymbols.has(sym))) {
      return true;
    }
    const desc = [activity.type || '', activity.action || '', activity.description || '']
      .join(' ')
      .toUpperCase();
    return targetList.some((sym) => sym && desc.includes(sym));
  };
}

async function sumDividendsForAccount(context, activityContext, targetSymbols) {
  if (!activityContext || !Array.isArray(activityContext.activities)) {
    return 0;
  }
  const matchesSymbol = buildActivitySymbolChecker(targetSymbols);
  let total = 0;
  for (const activity of activityContext.activities) {
    const descriptor = [activity.type || '', activity.action || '', activity.description || ''].join(' ');
    if (!INCOME_ACTIVITY_REGEX.test(descriptor)) {
      continue;
    }
    if (!matchesSymbol(activity)) {
      continue;
    }
    const timestamp = resolveActivityTimestamp(activity);
    const currency = typeof activity.currency === 'string' ? activity.currency.trim().toUpperCase() : null;
    const netAmount = Number(activity.netAmount);
    if (!Number.isFinite(netAmount) || !currency) {
      continue;
    }
    try {
      const { cadAmount } = await convertAmountToCad(netAmount, currency, timestamp, context.account.id);
      if (Number.isFinite(cadAmount)) {
        total += cadAmount;
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(
        `[dividends] Failed to convert amount for account ${context.account.id}:`,
        message
      );
    }
  }
  return total;
}

async function buildAccountContexts() {
  const contexts = [];
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json first.');
  }
  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts = [];
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(`[compare-symbol-pnl] Failed to fetch accounts for login ${login.id}:`, message);
      continue;
    }
    accounts.forEach((account, index) => {
      if (!account) {
        return;
      }
      const rawNumber =
        account.number != null
          ? account.number
          : account.accountNumber != null
            ? account.accountNumber
            : account.id != null
              ? account.id
              : index;
      const normalizedNumber = rawNumber != null ? String(rawNumber).trim() : String(index);
      if (!normalizedNumber) {
        return;
      }
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

  const hydratedContexts = [];
  for (const context of contexts) {
    try {
      const activityContext = await buildAccountActivityContext(context.login, context.account);
      hydratedContexts.push({ ...context, activityContext });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(
        `[compare-symbol-pnl] Failed to build activity context for account ${context.account.id}:`,
        message
      );
    }
  }
  return hydratedContexts;
}

async function buildCombinedBalancesMap(contexts) {
  const map = {};
  for (const context of contexts) {
    try {
      const balancesRaw = await fetchBalances(context.login, context.account.number);
      const summary = summarizeAccountBalances(balancesRaw) || balancesRaw;
      map[context.account.id] = summary;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(
        `[compare-symbol-pnl] Failed to fetch balances for account ${context.account.id}:`,
        message
      );
    }
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv);
  const rawSymbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
  if (!rawSymbol) {
    console.error('Usage: node scripts/compare-symbol-pnl.js --symbol ENB');
    process.exit(1);
  }
  const targetSymbolKey = normalizeSymbolKey(rawSymbol);
  const symbolMembers = getSymbolGroupMembers(targetSymbolKey);
  if (!symbolMembers.length) {
    console.error('Unknown symbol:', rawSymbol);
    process.exit(1);
  }
  const targetSymbols = new Set(symbolMembers);

  const contexts = await buildAccountContexts();
  console.log(`[compare-symbol-pnl] Loaded ${contexts.length} account contexts.`);
  const perAccountCombinedBalances = await buildCombinedBalancesMap(contexts);
  let aggregatedSeriesCad = 0;
  const perAccountSeries = [];
  let perAccountTotalsCad = 0;
  let dividendCad = 0;

  for (const context of contexts) {
    try {
      const series = await computeTotalPnlSeriesForSymbol(
        context.login,
        context.account,
        perAccountCombinedBalances,
        {
          activityContext: context.activityContext,
          symbol: targetSymbolKey,
          applyAccountCagrStartDate: false,
        }
      );
      if (series?.summary && Number.isFinite(series.summary.totalPnlCad)) {
        aggregatedSeriesCad += series.summary.totalPnlCad;
        console.log(
          `[series] account ${context.account.id} -> ${series.summary.totalPnlCad.toFixed(2)} CAD`
        );
        perAccountSeries.push(series);
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(
        `[compare-symbol-pnl] Failed to compute series for account ${context.account.id}:`,
        message
      );
    }

    try {
      const perSymbolTotals = await computeTotalPnlBySymbol(
        context.login,
        context.account,
        { activityContext: context.activityContext }
      );
      const entries = Array.isArray(perSymbolTotals?.entries) ? perSymbolTotals.entries : [];
      entries.forEach((entry) => {
        const symbol = normalizeSymbol(entry?.symbol);
        if (symbol && targetSymbols.has(symbol)) {
          const value = Number(entry?.totalPnlCad);
          if (Number.isFinite(value)) {
            perAccountTotalsCad += value;
            console.log(`[by-symbol] account ${context.account.id} -> ${value.toFixed(2)} CAD`);
          }
        }
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.warn(
        `[compare-symbol-pnl] Failed to compute per-symbol totals for account ${context.account.id}:`,
        message
      );
    }

    const dividendsForAccount = await sumDividendsForAccount(
      context,
      context.activityContext,
      targetSymbols
    );
    if (Number.isFinite(dividendsForAccount)) {
      dividendCad += dividendsForAccount;
    }
  }

  const payload = {
    symbol: targetSymbolKey,
    symbolMembers: Array.from(targetSymbols),
    aggregatedSeriesCad,
    perAccountTotalsCad,
    dividendCad,
    perAccountLessDividendsCad: perAccountTotalsCad - dividendCad,
  };

  if (perAccountSeries.length) {
    const totalsByDate = new Map();
    perAccountSeries.forEach((series) => {
      if (!series || !Array.isArray(series.points)) {
        return;
      }
      series.points.forEach((point) => {
        const dateKey = point && typeof point.date === 'string' ? point.date : null;
        if (!dateKey) {
          return;
        }
        const pnl = Number(point.totalPnlCad);
        if (!Number.isFinite(pnl)) {
          return;
        }
        totalsByDate.set(dateKey, (totalsByDate.get(dateKey) || 0) + pnl);
      });
    });
    const sortedDates = Array.from(totalsByDate.keys()).sort();
    if (sortedDates.length) {
      const lastDate = sortedDates[sortedDates.length - 1];
      payload.aggregatedSeriesLastPointCad = totalsByDate.get(lastDate);
      payload.aggregatedSeriesLastDate = lastDate;
    }
  }

  console.log(JSON.stringify(payload, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error('[compare-symbol-pnl] Error:', message);
    process.exit(1);
  });
}
