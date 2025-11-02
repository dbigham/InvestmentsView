#!/usr/bin/env node

require('dotenv').config();

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  applyAccountSettingsOverrides,
  buildAccountActivityContext,
  computeTotalPnlBySymbol,
  resolveActivityTimestamp,
  convertAmountToCad,
} = require('../index.js');

function normalizeIdentifier(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function maskTokenForLog(token) {
  if (!token || typeof token !== 'string') return '<missing>';
  if (token.length <= 8) return token;
  return token.slice(0, 4) + '…' + token.slice(-4);
}

const INCOME_REGEX = /(dividend|distribution|interest|coupon)/i;
const EXCLUDE_TRADE_REGEX = /(dividend|distribution|interest|fee|commission|transfer|journal|tax|withholding)/i;
const TRADE_KEYWORDS = /(buy|sell|short|cover|exercise|assign|assignment|option|trade)/i;

function isOrderLike(activity) {
  const qty = Number(activity?.quantity);
  if (!Number.isFinite(qty) || Math.abs(qty) <= 1e-8) return false;
  const combined = [activity?.type || '', activity?.action || '', activity?.description || ''].join(' ');
  if (EXCLUDE_TRADE_REGEX.test(combined)) return false;
  return TRADE_KEYWORDS.test(combined);
}

async function resolveAccountContext(identifier) {
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json.');
  }
  const needle = normalizeIdentifier(identifier);
  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts = [];
    try { accounts = await fetchAccounts(login); } catch {}
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
      if (!needle || candidates.some((c) => c.includes(needle))) {
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

function toTwo(n) {
  return Number.isFinite(n) ? n.toFixed(2) : 'n/a';
}

async function main() {
  const accountIdent = process.argv[2] || '';
  const rawSymbol = process.argv[3] || '';
  if (!accountIdent || !rawSymbol) {
    console.error('Usage: node server/src/scripts/diagnose-symbol-pnl.js <account-id-or-name> <symbol>');
    process.exit(1);
  }
  const symbol = String(rawSymbol).toUpperCase();
  const { login, account } = await resolveAccountContext(accountIdent);
  const activityContext = await buildAccountActivityContext(login, account);
  const accountKey = account.id;

  // Totals from the calculator
  const totals = await computeTotalPnlBySymbol(login, account, { activityContext });
  const entry = Array.isArray(totals?.entries)
    ? totals.entries.find((e) => e && String(e.symbol).toUpperCase() === symbol)
    : null;

  // Cash flow breakdown
  const breakdown = {
    tradeBuy: 0,
    tradeSell: 0,
    income: 0,
    other: 0,
  };

  const activities = Array.isArray(activityContext?.activities) ? activityContext.activities : [];
  for (const a of activities) {
    const actSym = typeof a.symbol === 'string' ? a.symbol.toUpperCase() : null;
    if (actSym !== symbol) continue;
    const ts = resolveActivityTimestamp(a);
    const amount = Number(a.netAmount);
    const currency = typeof a.currency === 'string' ? a.currency : null;
    const { cadAmount } = await convertAmountToCad(amount, currency, ts, accountKey);
    if (!Number.isFinite(cadAmount) || Math.abs(cadAmount) < 0.005) continue;
    const combined = [a.type || '', a.action || '', a.description || ''].join(' ');
    if (INCOME_REGEX.test(combined)) {
      breakdown.income += cadAmount;
    } else if (isOrderLike(a)) {
      breakdown[cadAmount > 0 ? 'tradeSell' : 'tradeBuy'] += cadAmount;
    } else {
      breakdown.other += cadAmount;
    }
  }

  console.log('Symbol:', symbol);
  console.log('End date:', totals?.endDate || 'n/a');
  if (entry) {
    console.log('Calculator: PnL', toTwo(entry.totalPnlCad), 'Invested', toTwo(entry.investedCad), 'MV', toTwo(entry.marketValueCad));
  } else {
    console.log('Calculator: no entry for this symbol');
  }
  console.log('Breakdown (CAD):');
  console.log('  tradeBuys :', toTwo(breakdown.tradeBuy));
  console.log('  tradeSells:', toTwo(breakdown.tradeSell));
  console.log('  income    :', toTwo(breakdown.income));
  console.log('  other     :', toTwo(breakdown.other));
}

main().catch((err) => {
  console.error('Error:', err?.message || String(err));
  process.exit(2);
});

