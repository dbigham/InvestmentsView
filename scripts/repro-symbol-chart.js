#!/usr/bin/env node

/**
 * Reproduce the symbol-focused Total P&L chart value from a cached summary
 * response. The implementation mirrors the fallback logic in
 * `client/src/App.jsx` (see the `totalPnlDialogData` useMemo) so that we
 * can debug UI discrepancies straight from the CLI.
 *
 * Usage:
 *   node scripts/repro-symbol-chart.js --symbol ENB \
 *     --summary ../summary_dump.json --mode cagr
 *
 * Options:
 *   --symbol   (required) Symbol ticker typed in the UI (e.g. ENB)
 *   --summary  Path to a summary payload (defaults to summary_dump.json)
 *   --mode     Either "all" or "cagr" matching totalPnlSeriesState.mode
 *   --scope    Account scope (defaults to "all")
 */

const fs = require('fs');
const path = require('path');
const {
  getSymbolGroupMembers,
  normalizeSymbolKey,
} = require('../shared/symbolGroups.cjs');

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

function loadSummary(summaryPath) {
  const resolved = path.resolve(summaryPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw);
}

function sumEntries(entries, targetSymbols) {
  if (!Array.isArray(entries)) {
    return 0;
  }
  return entries.reduce((acc, entry) => {
    const symbol = normalizeSymbolKey(entry && entry.symbol);
    if (!symbol || !targetSymbols.has(symbol)) {
      return acc;
    }
    const value = Number(entry.totalPnlCad);
    return acc + (Number.isFinite(value) ? value : 0);
  }, 0);
}

function collectAccountIds(summary, scopeKey) {
  if (scopeKey && scopeKey !== 'all') {
    return [scopeKey];
  }
  const filtered =
    Array.isArray(summary.filteredAccountIds) && summary.filteredAccountIds.length
      ? summary.filteredAccountIds
      : null;
  if (filtered && filtered.length) {
    return filtered;
  }
  const dividendKeys =
    summary.accountDividends && typeof summary.accountDividends === 'object'
      ? Object.keys(summary.accountDividends)
      : [];
  return dividendKeys;
}

function sumDividends(summary, targetSymbols, accountIds) {
  const dividendsMap = summary.accountDividends;
  if (!dividendsMap || typeof dividendsMap !== 'object' || !accountIds.length) {
    return 0;
  }
  let total = 0;
  accountIds.forEach((accountId) => {
    const payload = dividendsMap[accountId];
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    entries.forEach((entry) => {
      const symbol = normalizeSymbolKey(entry && entry.symbol);
      const rawSymbols = Array.isArray(entry?.rawSymbols)
        ? entry.rawSymbols.map((sym) => normalizeSymbolKey(sym))
        : [];
      const matches =
        (symbol && targetSymbols.has(symbol)) ||
        rawSymbols.some((raw) => raw && targetSymbols.has(raw));
      if (!matches) {
        return;
      }
      const cadAmount = Number(entry?.cadAmount);
      if (Number.isFinite(cadAmount)) {
        total += cadAmount;
      }
    });
  });
  return total;
}

function main() {
  const args = parseArgs(process.argv);
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim().toUpperCase() : '';
  if (!symbol) {
    console.error('Error: --symbol is required (e.g. --symbol ENB)');
    process.exit(1);
  }
  const summaryPath = args.summary || 'summary_dump.json';
  const mode = typeof args.mode === 'string' ? args.mode.trim().toLowerCase() : 'cagr';
  const scopeKey =
    typeof args.scope === 'string' && args.scope.trim() ? args.scope.trim() : 'all';

  const summary = loadSummary(summaryPath);
  const targetSymbols = new Set(getSymbolGroupMembers(symbol));
  if (!targetSymbols.size) {
    targetSymbols.add(symbol);
  }

  let totalCad = 0;
  if (mode === 'all') {
    const container =
      (summary.accountTotalPnlBySymbolAll && summary.accountTotalPnlBySymbolAll[scopeKey]) ||
      (summary.accountTotalPnlBySymbolAll && summary.accountTotalPnlBySymbolAll.all) ||
      null;
    if (!container) {
      console.error('Unable to locate accountTotalPnlBySymbolAll data for scope:', scopeKey);
      process.exit(2);
    }
    totalCad = sumEntries(container.entries, targetSymbols);
  } else {
    const perAccount = summary.accountTotalPnlBySymbol || {};
    const filteredAccountIds =
      (Array.isArray(summary.filteredAccountIds) && summary.filteredAccountIds.length
        ? summary.filteredAccountIds
        : Object.keys(perAccount)) || [];
    if (!filteredAccountIds.length) {
      console.error('No accounts available in summary data.');
      process.exit(3);
    }
    filteredAccountIds.forEach((accountId) => {
      const entry = perAccount[accountId];
      if (!entry || typeof entry !== 'object') {
        return;
      }
      totalCad += sumEntries(entry.entries, targetSymbols);
    });
  }

  const dividendAdjustment = sumDividends(summary, targetSymbols, collectAccountIds(summary, scopeKey));
  if (Number.isFinite(dividendAdjustment) && dividendAdjustment !== 0) {
    totalCad -= dividendAdjustment;
  }

  console.log(
    JSON.stringify(
      {
        symbol,
        mode,
        scope: scopeKey,
        fallbackChartTotalCad: totalCad,
        dividendAdjustmentCad: dividendAdjustment,
      },
      null,
      2
    )
  );
}

main();
