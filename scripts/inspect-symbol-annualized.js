#!/usr/bin/env node

/**
 * Inspect symbol-level Total P&L and annualized return for a single
 * Questrade account, using the same formulas as the symbol header in
 * the client.
 *
 * It computes:
 *   - Total P&L % = totalPnlCad / costBasisCad
 *   - Annualized (symbol start) = CAGR using the first active date in
 *     the symbol's Total P&L series.
 *   - Annualized (account start) = CAGR using the account-level
 *     funding period start (mirrors the buggy behaviour in the UI
 *     before this fix).
 *
 * Usage:
 *   node scripts/inspect-symbol-annualized.js --account 29514036 --symbol QQQ
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
  fetchBalances,
  summarizeAccountBalances,
  computeNetDeposits,
} = require('../server/src/index.js');

const { normalizeSymbolKey } = require('../shared/symbolGroups.cjs');

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

function normalizeIdentifier(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

async function resolveAccountContext(identifier) {
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json first.');
  }
  const needle = normalizeIdentifier(identifier);
  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts = [];
    try {
      accounts = await fetchAccounts(login);
    } catch {
      // ignore and move to next login
    }
    for (const account of accounts) {
      const overridden = applyAccountSettingsOverrides(account, login);
      const candidates = [
        overridden.id,
        overridden.number,
        overridden.accountNumber,
        overridden.name,
        overridden.displayName,
      ]
        .map((v) => (v == null ? '' : String(v)))
        .filter(Boolean)
        .map((v) => v.toLowerCase());

      if (!needle && accounts.length === 1) {
        const number = overridden.number || overridden.accountNumber || overridden.id;
        return {
          login,
          account: Object.assign({}, overridden, {
            id: overridden.id || number,
            number,
            loginId: login.id,
          }),
        };
      }

      if (needle && candidates.some((c) => c.includes(needle))) {
        const number = overridden.number || overridden.accountNumber || overridden.id;
        return {
          login,
          account: Object.assign({}, overridden, {
            id: overridden.id || number,
            number,
            loginId: login.id,
          }),
        };
      }
    }
  }
  throw new Error('Unable to resolve account for identifier: ' + (identifier || '<none>'));
}

function computeElapsedYears(startIso, endIso) {
  if (!startIso || !endIso) {
    return null;
  }
  const normalizedStart = /^\d{4}-\d{2}-\d{2}$/.test(startIso) ? `${startIso}T00:00:00Z` : startIso;
  const normalizedEnd = /^\d{4}-\d{2}-\d{2}$/.test(endIso) ? `${endIso}T00:00:00Z` : endIso;
  const start = new Date(normalizedStart);
  const end = new Date(normalizedEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  const diffMs = end.getTime() - start.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null;
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const DAYS_PER_YEAR = 365.25;
  return diffMs / MS_PER_DAY / DAYS_PER_YEAR;
}

function findFirstActiveIndex(points) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i] || {};
    const e = Number(p.equityCad);
    const n = Number(p.cumulativeNetDepositsCad);
    const t = Number(p.totalPnlCad);
    const hasActivity =
      (Number.isFinite(e) && Math.abs(e) > 1e-6) ||
      (Number.isFinite(n) && Math.abs(n) > 1e-6) ||
      (Number.isFinite(t) && Math.abs(t) > 1e-6);
    if (hasActivity && typeof p.date === 'string' && p.date) {
      return i;
    }
  }
  return null;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const percent = value * 100;
  const prefix = percent > 0 ? '+' : '';
  return `${prefix}${percent.toFixed(2)}%`;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)} CAD`;
}

async function main() {
  const args = parseArgs(process.argv);
  const accountIdent = typeof args.account === 'string' ? args.account : args.id;
  const rawSymbol = typeof args.symbol === 'string' ? args.symbol : null;

  if (!accountIdent || !rawSymbol) {
    console.error('Usage: node scripts/inspect-symbol-annualized.js --account <id-or-name> --symbol QQQ');
    process.exit(1);
  }

  const symbolKey = normalizeSymbolKey(rawSymbol);
  if (!symbolKey) {
    console.error('Invalid symbol:', rawSymbol);
    process.exit(1);
  }

  const { login, account } = await resolveAccountContext(accountIdent);

  const activityContext = await buildAccountActivityContext(login, account);
  const balancesRaw = await fetchBalances(login, account.number);
  const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
  const perAccountCombinedBalances = { [account.id]: balanceSummary };

  const series = await computeTotalPnlSeriesForSymbol(
    login,
    account,
    perAccountCombinedBalances,
    {
      activityContext,
      symbol: symbolKey,
      applyAccountCagrStartDate: false,
    }
  );

  if (!series || !Array.isArray(series.points) || !series.points.length) {
    console.error('No Total P&L series available for symbol', symbolKey, 'on account', accountIdent);
    process.exit(2);
  }

  const points = series.points;
  const last = points[points.length - 1] || {};
  const lastDate = typeof last.date === 'string' && last.date ? last.date : series.periodEndDate;

  const firstIndex = findFirstActiveIndex(points);
  const symbolStartDate =
    firstIndex !== null && firstIndex >= 0 && firstIndex < points.length
      ? points[firstIndex].date
      : series.periodStartDate;

  const equityCad = Number(last.equityCad);
  const pnlCad = Number(last.totalPnlCad);
  const costCad =
    Number.isFinite(equityCad) && Number.isFinite(pnlCad) ? equityCad - pnlCad : null;

  const totalReturn =
    Number.isFinite(costCad) && costCad > 0 && Number.isFinite(pnlCad)
      ? pnlCad / costCad
      : null;

  const yearsSymbol = computeElapsedYears(symbolStartDate, lastDate);
  const annualizedSymbol =
    Number.isFinite(totalReturn) && Number.isFinite(yearsSymbol) && yearsSymbol > 0
      ? Math.pow(1 + totalReturn, 1 / yearsSymbol) - 1
      : null;

  // Reproduce the pre-fix behaviour: reuse account-level funding start
  // for symbol-level CAGR, which can significantly understate the rate
  // when the symbol has been held for a shorter window.
  let annualizedAccount = null;
  let accountStartDate = null;
  let accountPeriodEnd = null;
  try {
    const fundingSummary = await computeNetDeposits(
      login,
      account,
      perAccountCombinedBalances,
      { applyAccountCagrStartDate: true }
    );
    if (fundingSummary) {
      const annual = fundingSummary.annualizedReturn;
      const annualStart =
        annual && typeof annual.startDate === 'string' && annual.startDate.trim()
          ? annual.startDate.trim()
          : null;
      const periodStart =
        typeof fundingSummary.periodStartDate === 'string' &&
        fundingSummary.periodStartDate.trim()
          ? fundingSummary.periodStartDate.trim()
          : null;
      accountStartDate = annualStart || periodStart || symbolStartDate;
      accountPeriodEnd =
        typeof fundingSummary.periodEndDate === 'string' && fundingSummary.periodEndDate.trim()
          ? fundingSummary.periodEndDate.trim()
          : lastDate;
      const yearsAccount = computeElapsedYears(accountStartDate, accountPeriodEnd);
      if (Number.isFinite(totalReturn) && Number.isFinite(yearsAccount) && yearsAccount > 0) {
        annualizedAccount = Math.pow(1 + totalReturn, 1 / yearsAccount) - 1;
      }
    }
  } catch (err) {
    // Funding summary is best-effort; ignore failures and just print symbol metrics.
  }

  const payload = {
    accountId: account.id,
    accountNumber: account.number,
    symbol: symbolKey,
    symbolStartDate,
    symbolEndDate: lastDate,
    equityCad: Number.isFinite(equityCad) ? equityCad : null,
    pnlCad: Number.isFinite(pnlCad) ? pnlCad : null,
    costBasisCad: Number.isFinite(costCad) ? costCad : null,
    totalReturnPercent: Number.isFinite(totalReturn) ? totalReturn * 100 : null,
    annualizedUsingSymbolStartPercent: Number.isFinite(annualizedSymbol)
      ? annualizedSymbol * 100
      : null,
    annualizedUsingAccountStartPercent: Number.isFinite(annualizedAccount)
      ? annualizedAccount * 100
      : null,
    accountStartDate,
    accountPeriodEnd,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error('[inspect-symbol-annualized] Error:', message);
  process.exit(1);
});

