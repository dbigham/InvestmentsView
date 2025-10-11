#!/usr/bin/env node

require('dotenv').config();

const {
  getLoginById,
  getAllLogins,
  fetchAccounts,
  fetchBalances,
  summarizeAccountBalances,
  computeTotalPnlSeries,
  computeNetDeposits,
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

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const sign = value >= 0 ? '' : '-';
  const abs = Math.abs(value);
  return sign + abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function resolveLogin(loginId) {
  if (loginId) {
    const login = getLoginById(loginId);
    if (login) {
      return login;
    }
    throw new Error('Unknown login id: ' + loginId);
  }
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available.');
  }
  return getLoginById(logins[0].id) || logins[0];
}

async function resolveAccount(login, accountNumberOrId) {
  const accounts = await fetchAccounts(login);
  if (!accounts || !accounts.length) {
    throw new Error('No accounts returned for login ' + login.id);
  }
  const normalizedTarget = accountNumberOrId ? String(accountNumberOrId).trim() : null;
  if (!normalizedTarget) {
    if (accounts.length === 1) {
      const single = accounts[0];
      return Object.assign({}, single, {
        id: single.id || single.number,
        number: single.number || single.accountNumber || single.id,
      });
    }
    throw new Error('Account identifier is required; available accounts: ' + accounts.map((acc) => acc.number || acc.id).join(', '));
  }
  const matched = accounts.find((account) => {
    const candidates = [account.id, account.number, account.accountNumber, account.name];
    return candidates.some((candidate) => candidate && String(candidate).trim() === normalizedTarget);
  });
  if (!matched) {
    throw new Error(
      'Unable to locate account ' + normalizedTarget + ' for login ' + login.id + '. Available: ' + accounts.map((acc) => acc.number || acc.id).join(', ')
    );
  }
  return Object.assign({}, matched, {
    id: matched.id || matched.number || matched.accountNumber,
    number: matched.number || matched.accountNumber || matched.id,
  });
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const targetAccount = options.account || options.id || positional[0] || null;
  if (!targetAccount) {
    console.error('Usage: node src/scripts/validate-total-pnl.js --account <accountNumber|id> [--login <loginId>] [--threshold <cad>]');
    process.exit(1);
    return;
  }

  const loginId = options.login || null;
  const login = await resolveLogin(loginId);
  const account = await resolveAccount(login, targetAccount);

  const balancesRaw = await fetchBalances(login, account.number);
  const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
  const perAccountCombinedBalances = { [account.id]: balanceSummary };

  const series = await computeTotalPnlSeries(login, account, perAccountCombinedBalances, {
    applyAccountCagrStartDate: options['no-cagr-start'] ? false : true,
  });

  if (!series || !Array.isArray(series.points) || !series.points.length) {
    throw new Error('Unable to compute Total P&L series for account ' + account.number);
  }

  const netDepositsSummary = await computeNetDeposits(login, account, perAccountCombinedBalances, {
    applyAccountCagrStartDate: options['no-cagr-start'] ? false : true,
  });

  const lastPoint = series.points[series.points.length - 1];
  const summaryTotalPnl = netDepositsSummary && netDepositsSummary.totalPnl && netDepositsSummary.totalPnl.combinedCad;
  const diff = Number.isFinite(summaryTotalPnl) && Number.isFinite(lastPoint.totalPnlCad)
    ? lastPoint.totalPnlCad - summaryTotalPnl
    : Number.NaN;

  const threshold = Number.isFinite(Number(options.threshold)) ? Math.abs(Number(options.threshold)) : 0.01;
  const withinThreshold = Number.isFinite(diff) ? Math.abs(diff) <= threshold : false;

  console.log('Account:', account.number, '-', account.name || account.type || '');
  console.log('Period :', series.periodStartDate, '→', series.periodEndDate);
  console.log('Points :', series.points.length);
  console.log('Summary total P&L (CAD):', formatNumber(summaryTotalPnl));
  console.log('Series final P&L  (CAD):', formatNumber(lastPoint.totalPnlCad));
  console.log('Difference          (CAD):', formatNumber(diff));
  console.log('Threshold           (CAD):', threshold);
  console.log('Within threshold:', withinThreshold ? 'yes' : 'no');

  if (!withinThreshold) {
    console.log('\nRecent points:');
    series.points.slice(-5).forEach((point) => {
      console.log(
        `${point.date} | equity=${formatNumber(point.equityCad)} | netDeposits=${formatNumber(point.cumulativeNetDepositsCad)} | totalPnl=${formatNumber(point.totalPnlCad)}`
      );
    });
    process.exitCode = 1;
    return;
  }

  console.log('\nValidation succeeded.');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
