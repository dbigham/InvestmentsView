#!/usr/bin/env node

require('dotenv').config();

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  applyAccountSettingsOverrides,
  computeTotalPnlBySymbol,
  buildAccountActivityContext,
} = require('../index.js');

function maskTokenForLog(token) {
  if (!token || typeof token !== 'string') {
    return '<missing>';
  }
  if (token.length <= 8) {
    return token;
  }
  return token.slice(0, 4) + '…' + token.slice(-4);
}

function normalizeIdentifier(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'");
}

async function resolveAccountContext(identifier) {
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json before running this script.');
  }

  console.log('[print-total-pnl-by-symbol] Loaded logins:',
    logins.map((login) => `${login.id}:${maskTokenForLog(login.refreshToken)}`));

  const needle = normalizeIdentifier(identifier);

  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    console.log('[print-total-pnl-by-symbol] Fetching accounts for login', login.id, {
      label: login.label || null,
      email: login.email || null,
      refreshToken: maskTokenForLog(login.refreshToken),
    });

    let accounts;
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error('Failed to fetch accounts for login', login.id + ':', message);
      continue;
    }

    for (const account of accounts) {
      const overridden = applyAccountSettingsOverrides(account, login);
      const candidates = [];
      if (overridden.id) candidates.push(String(overridden.id));
      if (overridden.number) candidates.push(String(overridden.number));
      if (overridden.accountNumber) candidates.push(String(overridden.accountNumber));
      if (overridden.name) candidates.push(String(overridden.name));
      if (overridden.displayName) candidates.push(String(overridden.displayName));

      const matched = candidates.some((c) => {
        if (!c) return false;
        const norm = normalizeIdentifier(c);
        if (!norm || !needle) return false;
        return norm === needle || norm.includes(needle);
      });
      if (matched || (!needle && accounts.length === 1)) {
        const accountNumber = overridden.number || overridden.accountNumber || overridden.id;
        const normalizedAccount = Object.assign({}, overridden, {
          id: overridden.id || accountNumber,
          loginId: login.id,
          number: accountNumber,
        });
        return { login, account: normalizedAccount };
      }
    }
  }

  console.error('Available accounts:');
  for (const loginInfo of getAllLogins()) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts = [];
    try { accounts = await fetchAccounts(login); } catch {}
    accounts.forEach((a) => {
      const o = applyAccountSettingsOverrides(a, login);
      console.error('-', o.id || a.id, '|', o.number || a.number, '|', o.displayName || o.name || a.name);
    });
  }
  throw new Error('Unable to find account for identifier: ' + (identifier || '<none>'));
}

function formatMoney(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)} CAD`;
}

async function main() {
  const identifier = process.argv[2] || '';
  if (!identifier) {
    console.error('Usage: node server/src/scripts/print-total-pnl-by-symbol.js <account-id-or-name>');
    process.exit(1);
  }

  const context = await resolveAccountContext(identifier);
  const accountWithOverrides = applyAccountSettingsOverrides(context.account, context.login);
  const effectiveAccount = Object.assign({}, accountWithOverrides, {
    id: context.account.id,
    number: context.account.number,
    loginId: context.login.id,
  });

  const activityContext = await buildAccountActivityContext(context.login, effectiveAccount);
  console.log('Activities:', Array.isArray(activityContext.activities) ? activityContext.activities.length : 0);
  console.log('Crawl start:', activityContext.crawlStart ? activityContext.crawlStart.toISOString().slice(0,10) : 'n/a');

  const totals = await computeTotalPnlBySymbol(context.login, effectiveAccount, { activityContext });
  const entries = Array.isArray(totals?.entries) ? totals.entries : [];
  console.log('As of date:', totals?.endDate || 'n/a');
  console.log('Symbols:', entries.length);
  if (!entries.length) {
    console.log('(no per-symbol totals available)');
    return;
  }
  const preview = entries.slice(0, 25);
  preview.forEach((e) => {
    console.log('-', e.symbol, '| PnL:', formatMoney(e.totalPnlCad || 0), '| MV:', formatMoney(e.marketValueCad || 0), '| Invested:', formatMoney(e.investedCad || 0));
  });
}

main().catch((err) => {
  console.error('Error:', err && err.message ? err.message : String(err));
  process.exit(2);
});
