#!/usr/bin/env node

require('dotenv').config();

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  applyAccountSettingsOverrides,
  buildAccountActivityContext,
} = require('../index.js');

function usage() {
  console.error('Usage: node server/src/scripts/print-activities.js <account-id-or-name> [symbol] [--grep <regex>]');
}

function norm(v) { return (v==null?'':String(v)).trim(); }

async function resolveAccount(identifier) {
  const needle = norm(identifier).toLowerCase();
  for (const l of getAllLogins()) {
    const login = getLoginById(l.id) || l;
    let accounts = [];
    try { accounts = await fetchAccounts(login); } catch {}
    for (const a of accounts) {
      const o = applyAccountSettingsOverrides(a, login);
      const cands = [o.id,o.number,o.accountNumber,o.displayName,o.name].map(norm).map(s=>s.toLowerCase()).filter(Boolean);
      if (!needle || cands.some(c => c.includes(needle))) {
        const number = o.number || o.accountNumber || o.id;
        return { login, account: Object.assign({}, o, { id: o.id || number, number, loginId: login.id }) };
      }
    }
  }
  throw new Error('Account not found for: ' + (identifier||'<none>'));
}

async function main() {
  const accountIdent = process.argv[2];
  const filterSymbol = process.argv[3] ? String(process.argv[3]).toUpperCase() : null;
  let grepIdx = process.argv.indexOf('--grep');
  const grep = grepIdx>=0 && process.argv[grepIdx+1] ? new RegExp(process.argv[grepIdx+1], 'i') : null;
  if (!accountIdent) { usage(); process.exit(1); }

  const { login, account } = await resolveAccount(accountIdent);
  const ctx = await buildAccountActivityContext(login, account);
  const acts = Array.isArray(ctx.activities) ? ctx.activities : [];
  const rows = acts.map(a => ({
    date: (a.tradeDate || a.transactionDate || a.settlementDate || a.date) ? new Date(a.tradeDate || a.transactionDate || a.settlementDate || a.date).toISOString().slice(0,10) : null,
    type: a.type || '',
    action: a.action || '',
    symbol: a.symbol || '',
    quantity: a.quantity,
    netAmount: a.netAmount,
    currency: a.currency,
    description: a.description || '',
  }))
  .filter(r => !filterSymbol || String(r.symbol).toUpperCase()===filterSymbol)
  .filter(r => !grep || grep.test(r.type) || grep.test(r.action) || grep.test(r.description));

  rows.sort((a,b)=> String(a.date).localeCompare(String(b.date)));
  rows.forEach(r => {
    console.log(`${r.date} | ${r.type} | ${r.action} | ${r.symbol} | qty=${r.quantity} | net=${r.netAmount} ${r.currency} | ${r.description}`);
  });
}

main().catch(err => { console.error('Error:', err?.message || String(err)); process.exit(2); });

