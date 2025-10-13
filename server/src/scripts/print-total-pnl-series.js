#!/usr/bin/env node

require('dotenv').config();

const path = require('path');

const {
  computeTotalPnlSeries,
  computeNetDeposits,
  getAllLogins,
  getLoginById,
  fetchAccounts,
  fetchBalances,
  summarizeAccountBalances,
  applyAccountSettingsOverrides,
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

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const percent = value * 100;
  const prefix = percent > 0 ? '+' : '';
  return `${prefix}${percent.toFixed(2)}%`;
}

function formatSignedCurrency(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}`;
}

function parseDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function computeElapsedYears(startDate, endDate) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return null;
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    return null;
  }
  const diffMs = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null;
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const DAYS_PER_YEAR = 365.25;
  return diffMs / MS_PER_DAY / DAYS_PER_YEAR;
}

function computeDeAnnualizedReturn(rate, startDateRaw, endDateRaw) {
  if (!Number.isFinite(rate)) {
    return null;
  }
  const startDate = startDateRaw instanceof Date ? startDateRaw : parseDate(startDateRaw);
  const endDate = endDateRaw instanceof Date ? endDateRaw : parseDate(endDateRaw);
  const elapsedYears = computeElapsedYears(startDate, endDate);
  if (!Number.isFinite(elapsedYears) || elapsedYears <= 0) {
    return null;
  }
  const growthBase = 1 + rate;
  if (growthBase <= 0) {
    return rate <= -1 ? -1 : null;
  }
  const growthFactor = Math.pow(growthBase, elapsedYears);
  if (!Number.isFinite(growthFactor)) {
    return null;
  }
  return growthFactor - 1;
}

async function resolveAccountContext(identifier) {
  const logins = getAllLogins();
  if (!logins.length) {
    throw new Error('No Questrade logins available. Seed token-store.json before running this script.');
  }

  console.log('[print-total-pnl] Loaded logins:',
    logins.map((login) => `${login.id}:${maskTokenForLog(login.refreshToken)}`));

  const normalizedIdentifier = identifier ? identifier.toLowerCase() : null;

  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    console.log('[print-total-pnl] Fetching accounts for login', login.id, {
      label: login.label || null,
      email: login.email || null,
      refreshToken: maskTokenForLog(login.refreshToken),
    });
    let accounts;
    try {
      accounts = await fetchAccounts(login);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const status = error && error.response ? error.response.status : null;
      const headers = error && error.response ? error.response.headers : null;
      const body = error && error.response ? error.response.data : null;
      let bodyPreview = body;
      if (typeof body === 'string') {
        bodyPreview = body.slice(0, 500);
      } else if (body && typeof body === 'object') {
        try {
          bodyPreview = JSON.stringify(body).slice(0, 500);
        } catch (serializationError) {
          bodyPreview = '[unable to serialize body]';
        }
      }
      console.error('Failed to fetch accounts for login', login.id + ':', message, {
        status,
        headers,
        bodyPreview,
      });
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
        console.log('[print-total-pnl] Matched account', normalizedAccount.number, {
          accountId: normalizedAccount.id,
          loginId: login.id,
          type: normalizedAccount.type || normalizedAccount.clientAccountType || null,
          name: normalizedAccount.name || null,
        });
        return { login, account: normalizedAccount };
      }
    }
  }

  throw new Error('Unable to locate account with identifier: ' + (identifier || '<none provided>'));
}

function printSeriesPreview(points, count, { useDisplayStartRelative } = {}) {
  if (!Array.isArray(points) || !points.length) {
    console.log('No data points available.');
    return;
  }
  const normalizedCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : points.length;
  const preview = points.slice(0, normalizedCount);
  const netDepositsLabel = useDisplayStartRelative ? 'Δ Net Deposits' : 'Net Deposits';
  const equityLabel = useDisplayStartRelative ? 'Δ Equity CAD' : 'Equity CAD';
  const pnlLabel = useDisplayStartRelative ? 'Δ Total P&L' : 'Total P&L';
  console.log(`Date       | ${netDepositsLabel.padStart(12)} | ${equityLabel.padStart(10)} | ${pnlLabel.padStart(9)}`);
  console.log('-----------+--------------+------------+-----------');
  preview.forEach((point) => {
    const date = point.date || 'unknown';
    const netDepositsValue = useDisplayStartRelative && Number.isFinite(point.cumulativeNetDepositsSinceDisplayStartCad)
      ? point.cumulativeNetDepositsSinceDisplayStartCad
      : point.cumulativeNetDepositsCad;
    const equityValue = useDisplayStartRelative && Number.isFinite(point.equitySinceDisplayStartCad)
      ? point.equitySinceDisplayStartCad
      : point.equityCad;
    const pnlValue = useDisplayStartRelative && Number.isFinite(point.totalPnlSinceDisplayStartCad)
      ? point.totalPnlSinceDisplayStartCad
      : point.totalPnlCad;
    const netDeposits = formatNumber(netDepositsValue);
    const equity = formatNumber(equityValue);
    const pnl = formatNumber(pnlValue);
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
  const debugFunding = options['debug-funding'] ? true : false;

  const context = await resolveAccountContext(identifier);
  const { login, account: baseAccount } = context;
  const account = applyAccountSettingsOverrides(baseAccount, login);

  console.log('[print-total-pnl] Using login/account combination', {
    loginId: login.id,
    loginLabel: login.label || null,
    loginEmail: login.email || null,
    accountId: account.id,
    accountNumber: account.number,
    refreshToken: maskTokenForLog(login.refreshToken),
  });

  let balancesRaw;
  try {
    console.log('[print-total-pnl] Fetching balances for account', account.number || account.id);
    balancesRaw = await fetchBalances(login, account.number || account.id);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.warn('Failed to fetch balances for account', account.id + ':', message);
    balancesRaw = {};
  }

  const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
  const perAccountCombinedBalances = { [account.id]: balanceSummary };

  console.log('[print-total-pnl] Computing total P&L series', {
    startDate,
    endDate,
    applyAccountCagrStartDate: keepCagrStart,
    balanceKeys: Object.keys(balanceSummary || {}),
  });

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

  let baselinePoint = null;
  if (keepCagrStart && series.displayStartDate) {
    try {
      const baselineOptions = Object.assign({}, seriesOptions, {
        applyAccountCagrStartDate: false,
      });
      const baselineSeries = await computeTotalPnlSeries(login, account, perAccountCombinedBalances, baselineOptions);
      if (baselineSeries && Array.isArray(baselineSeries.points)) {
        baselinePoint = baselineSeries.points.find((point) => point && point.date === series.displayStartDate);
      }
    } catch (baselineError) {
      const message = baselineError && baselineError.message ? baselineError.message : String(baselineError);
      console.warn('Unable to compute baseline (no-CAGR) series for comparison:', message);
    }
  }

  let fundingSummary = null;
  try {
    const fundingOptions = {
      applyAccountCagrStartDate: keepCagrStart,
    };
    if (startDate) {
      fundingOptions.startDate = startDate;
    }
    if (endDate) {
      fundingOptions.endDate = endDate;
    }
    fundingSummary = await computeNetDeposits(login, account, perAccountCombinedBalances, fundingOptions);
  } catch (summaryError) {
    const message = summaryError && summaryError.message ? summaryError.message : String(summaryError);
    console.warn('Failed to compute funding summary for account', identifier + ':', message);
  }

  const lastPoint = series.points && series.points.length ? series.points[series.points.length - 1] : null;

  console.log('Account:', account.number || account.id, '-', account.name || account.type || '');
  console.log('Period :', series.periodStartDate, '→', series.periodEndDate);
  console.log('Points :', Array.isArray(series.points) ? series.points.length : 0);
  const hasRelativeSeries = Array.isArray(series.points)
    && series.points.some((point) => Number.isFinite(point && point.totalPnlSinceDisplayStartCad));
  const useDisplayStartRelative = !keepCagrStart && hasRelativeSeries;

  console.log('Summary:');
  console.log('  Net deposits CAD:', formatNumber(series.summary.netDepositsCad));
  console.log('  Total equity CAD :', formatNumber(series.summary.totalEquityCad));

  const summaryPnlDisplay = useDisplayStartRelative
    && Number.isFinite(series.summary.totalPnlSinceDisplayStartCad)
    ? series.summary.totalPnlSinceDisplayStartCad
    : series.summary.totalPnlCad;
  console.log('  Total P&L CAD    :', formatNumber(summaryPnlDisplay));
  if (useDisplayStartRelative && Number.isFinite(series.summary.totalPnlCad)) {
    console.log('  Total P&L (all-time) CAD :', formatNumber(series.summary.totalPnlCad));
  }

  const baselineEquity =
    Number.isFinite(series.summary.totalEquityCad) &&
    Number.isFinite(series.summary.netDepositsCad) &&
    Number.isFinite(series.summary.totalPnlCad)
      ? series.summary.totalEquityCad - (series.summary.netDepositsCad + series.summary.totalPnlCad)
      : null;
  if (baselineEquity !== null) {
    console.log('  Start equity CAD :', formatNumber(baselineEquity));
  }

  if (baselinePoint) {
    console.log('  Pre-period (rolled) net deposits:', formatNumber(baselinePoint.cumulativeNetDepositsCad));
    console.log('  Pre-period (rolled) equity CAD  :', formatNumber(baselinePoint.equityCad));
    console.log('  Pre-period (rolled) total P&L   :', formatNumber(baselinePoint.totalPnlCad));
  }

  if (fundingSummary) {
    const allTimeNetDeposits =
      fundingSummary.netDeposits && Number.isFinite(fundingSummary.netDeposits.allTimeCad)
        ? fundingSummary.netDeposits.allTimeCad
        : null;
    const allTimePnl =
      fundingSummary.totalPnl && Number.isFinite(fundingSummary.totalPnl.allTimeCad)
        ? fundingSummary.totalPnl.allTimeCad
        : null;
    if (allTimeNetDeposits !== null || allTimePnl !== null) {
      console.log('  All-time deposits:', formatNumber(allTimeNetDeposits));
      console.log('  All-time P&L     :', formatNumber(allTimePnl));
    }
  }
  if (lastPoint) {
    const diff = Math.abs(lastPoint.totalPnlCad - series.summary.totalPnlCad);
    console.log('  Last point P&L   :', formatNumber(lastPoint.totalPnlCad), diff < 0.05 ? '(matches summary)' : '(diff ' + formatNumber(diff) + ')');
  }

  if (fundingSummary && fundingSummary.annualizedReturn) {
    const rate = Number.isFinite(fundingSummary.annualizedReturn.rate)
      ? fundingSummary.annualizedReturn.rate
      : null;
    const asOf = fundingSummary.annualizedReturn.asOf || fundingSummary.periodEndDate;
    const startDate =
      fundingSummary.annualizedReturn.startDate ||
      fundingSummary.periodStartDate ||
      series.displayStartDate ||
      series.periodStartDate;
    const deAnnualized = computeDeAnnualizedReturn(rate, startDate, asOf);
    const suffix = fundingSummary.annualizedReturn.incomplete ? ' (incomplete)' : '';
    console.log('  Annualized XIRR  :', rate !== null ? formatSignedPercent(rate) : 'n/a', suffix);
    console.log('  De-annualized    :', deAnnualized !== null ? formatSignedPercent(deAnnualized) : 'n/a');
  } else {
    console.log('  Annualized XIRR  : n/a');
    console.log('  De-annualized    : n/a');
  }

  if (debugFunding && fundingSummary) {
    console.log('Funding cash flows (CAD):');
    if (Array.isArray(fundingSummary.cashFlowsCad) && fundingSummary.cashFlowsCad.length) {
      fundingSummary.cashFlowsCad
        .slice()
        .sort((a, b) => {
          const aTime = new Date(a.date).getTime();
          const bTime = new Date(b.date).getTime();
          return aTime - bTime;
        })
        .forEach((entry) => {
          const amount = Number(entry.amount);
          const label = `${entry.date || 'n/a'}`;
          console.log('   ', label, formatSignedCurrency(amount));
        });
    } else {
      console.log('   <none>');
    }
  }

  if (series.issues && series.issues.length) {
    console.log('Warnings:', series.issues.join(', '));
  }
  if (series.missingPriceSymbols && series.missingPriceSymbols.length) {
    console.log('Missing price symbols:', series.missingPriceSymbols.join(', '));
  }

  const previewCount = Number.isFinite(Number(options.preview)) ? Number(options.preview) : series.points.length;
  if (useDisplayStartRelative) {
    console.log();
    console.log('Δ values represent changes since the first displayed date.');
  }

  printSeriesPreview(series.points, previewCount, { useDisplayStartRelative });
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  const status = error && error.response ? error.response.status : null;
  const headers = error && error.response ? error.response.headers : null;
  const request = error && error.request ? error.request : null;
  console.error(message, { status, headers, request });
  process.exit(1);
});
