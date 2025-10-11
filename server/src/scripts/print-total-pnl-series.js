#!/usr/bin/env node

require('dotenv').config();

const path = require('path');

const {
  computeTotalPnlSeries,
  getAllLogins,
  getLoginById,
  fetchAccounts,
  fetchBalances,
  summarizeAccountBalances,
} = require('../index.js');

function parseArgs(argv) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const stripped = token.slice(2);
      if (stripped.includes('=')) {
        const [key, value] = stripped.split('=');
        options[key] = value;
      } else {
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
          options[stripped] = next;
          index += 1;
        } else {
          options[stripped] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }

  return { options, positional };
}

function normalizeIdentifier(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  return raw.trim();
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return value.toFixed(2);
}

async function resolveAccountContext(identifier) {
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json before running this script.');
  }

  const normalizedIdentifier = identifier ? identifier.toLowerCase() : null;

  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let accounts;
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error('Failed to fetch accounts for login', login.id + ':', message);
      continue;
    }

    for (const account of accounts) {
      const candidates = [];
      if (account.id) {
        candidates.push(String(account.id));
      }
      if (account.number) {
        candidates.push(String(account.number));
      }
      if (account.accountNumber) {
        candidates.push(String(account.accountNumber));
      }
      if (account.name) {
        candidates.push(String(account.name));
      }

      const matched = candidates.some((candidate) => {
        if (!candidate) {
          return false;
        }
        if (!normalizedIdentifier) {
          return false;
        }
        return candidate.trim().toLowerCase() === normalizedIdentifier;
      });

      if (matched || (!normalizedIdentifier && accounts.length === 1)) {
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

function printSeriesPreview(points, count) {
  if (!Array.isArray(points) || !points.length) {
    console.log('No data points available.');
    return;
  }
  const preview = points.slice(-count);
  console.log('Date       | Net Deposits | Equity CAD | Total P&L');
  console.log('-----------+--------------+------------+-----------');
  preview.forEach((point) => {
    const date = point.date || 'unknown';
    const netDeposits = formatNumber(point.cumulativeNetDepositsCad);
    const equity = formatNumber(point.equityCad);
    const pnl = formatNumber(point.totalPnlCad);
    console.log(`${date} | ${netDeposits.padStart(12)} | ${equity.padStart(10)} | ${pnl.padStart(9)}`);
  });
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));

  const identifier = normalizeIdentifier(options.account || options.id || positional[0] || null);
  if (!identifier) {
    console.error('Usage: node src/scripts/print-total-pnl-series.js --account <accountIdOrNumber> [--start=YYYY-MM-DD] [--end=YYYY-MM-DD]');
    process.exit(1);
    return;
  }

  const startDate = normalizeIdentifier(options.start || options.from || null);
  const endDate = normalizeIdentifier(options.end || options.to || null);
  const keepCagrStart = options['no-cagr-start'] ? false : true;

  const context = await resolveAccountContext(identifier);
  const { login, account } = context;

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

  const seriesOptions = {
    applyAccountCagrStartDate: keepCagrStart,
  };
  if (startDate) {
    seriesOptions.startDate = startDate;
  }
  if (endDate) {
    seriesOptions.endDate = endDate;
  }

  const series = await computeTotalPnlSeries(login, account, perAccountCombinedBalances, seriesOptions);
  if (!series) {
    console.error('Failed to compute Total P&L series for account', identifier);
    process.exit(1);
    return;
  }

  const lastPoint = series.points && series.points.length ? series.points[series.points.length - 1] : null;

  console.log('Account:', account.number || account.id, '-', account.name || account.type || '');
  console.log('Period :', series.periodStartDate, '→', series.periodEndDate);
  console.log('Points :', Array.isArray(series.points) ? series.points.length : 0);
  console.log('Summary:');
  console.log('  Net deposits CAD:', formatNumber(series.summary.netDepositsCad));
  console.log('  Total equity CAD :', formatNumber(series.summary.totalEquityCad));
  console.log('  Total P&L CAD    :', formatNumber(series.summary.totalPnlCad));
  if (lastPoint) {
    const diff = Math.abs(lastPoint.totalPnlCad - series.summary.totalPnlCad);
    console.log('  Last point P&L   :', formatNumber(lastPoint.totalPnlCad), diff < 0.05 ? '(matches summary)' : '(diff ' + formatNumber(diff) + ')');
  }

  if (series.issues && series.issues.length) {
    console.log('Warnings:', series.issues.join(', '));
  }
  if (series.missingPriceSymbols && series.missingPriceSymbols.length) {
    console.log('Missing price symbols:', series.missingPriceSymbols.join(', '));
  }

  const previewCount = Number.isFinite(Number(options.preview)) ? Number(options.preview) : 10;
  printSeriesPreview(series.points, previewCount);
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
