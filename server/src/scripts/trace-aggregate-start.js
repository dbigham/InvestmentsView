require('dotenv').config();

const {
  getAllLogins,
  getLoginById,
  fetchAccounts,
  fetchBalances,
  summarizeAccountBalances,
  applyAccountSettingsOverrides,
  computeNetDeposits,
  buildAccountActivityContext,
} = require('../index.js');

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=');
        options[k] = v;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { options, positional };
}

function normalizeKey(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

function findEarliestCashFlow(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length === 0) {
    return null;
  }
  let earliest = null;
  cashFlows.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const date = toIsoDate(entry.date || entry.timestamp);
    if (!date) {
      return;
    }
    if (!earliest || date < earliest.date) {
      earliest = { date, amount: entry.amount };
    }
  });
  return earliest;
}

async function loadAccounts() {
  const logins = getAllLogins();
  if (!logins || !logins.length) {
    throw new Error('No Questrade logins available. Seed server/token-store.json first.');
  }
  const result = [];
  for (const loginInfo of logins) {
    const login = getLoginById(loginInfo.id) || loginInfo;
    let list = [];
    try {
      list = await fetchAccounts(login);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[trace-aggregate] Failed to fetch accounts for login', login.id, msg);
      continue;
    }
    for (const acc of list) {
      const number = acc.number || acc.accountNumber || acc.id;
      const normalized = Object.assign({}, acc, { id: acc.id || number, number, loginId: login.id });
      const withSettings = applyAccountSettingsOverrides(normalized, login);
      result.push({ login, account: withSettings });
    }
  }
  return result;
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const accountFilter = normalizeKey(options.account || options.id || positional[0] || null);

  const contexts = await loadAccounts();
  const filtered = accountFilter
    ? contexts.filter(({ account }) => {
        const id = normalizeKey(account.id);
        const number = normalizeKey(account.number || account.accountNumber);
        return accountFilter === id || accountFilter === number;
      })
    : contexts;

  if (!filtered.length) {
    console.log('[trace-aggregate] No matching accounts found.');
    return;
  }

  const perAccountCombinedBalances = {};
  for (const { login, account } of filtered) {
    let balancesRaw = {};
    try {
      balancesRaw = await fetchBalances(login, account.number || account.id);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn('[trace-aggregate] Failed to fetch balances for account', account.id, msg);
      balancesRaw = {};
    }
    const balanceSummary = summarizeAccountBalances(balancesRaw) || balancesRaw;
    perAccountCombinedBalances[account.id] = balanceSummary;
  }

  let aggregateEarliest = null;
  console.log('[trace-aggregate] Checking funding summary start dates:');
  for (const { login, account } of filtered) {
    const activityContext = await buildAccountActivityContext(login, account);
    const summaryAllTime = await computeNetDeposits(
      login,
      account,
      perAccountCombinedBalances,
      { applyAccountCagrStartDate: false, activityContext }
    );
    const earliestFlow = findEarliestCashFlow(summaryAllTime?.cashFlowsCad);
    if (earliestFlow && (!aggregateEarliest || earliestFlow.date < aggregateEarliest.date)) {
      aggregateEarliest = { ...earliestFlow, accountId: account.id, accountNumber: account.number };
    }

    const earliestFunding = toIsoDate(activityContext?.earliestFunding);
    const crawlStart = toIsoDate(activityContext?.crawlStart);
    const periodStart = summaryAllTime?.periodStartDate || null;
    const originalStart = summaryAllTime?.originalPeriodStartDate || null;
    const adjustment = Number(account.netDepositAdjustment);
    const hasAdjustment = Number.isFinite(adjustment) && adjustment !== 0;
    const adjustmentHint =
      hasAdjustment && earliestFlow && crawlStart && earliestFlow.date === crawlStart
        ? ' (adjustment likely anchored to crawlStart)'
        : '';

    console.log([
      `- account=${account.id} number=${account.number}`,
      `cagrStart=${account.cagrStartDate || 'n/a'}`,
      `earliestFunding=${earliestFunding || 'n/a'}`,
      `crawlStart=${crawlStart || 'n/a'}`,
      `periodStart=${periodStart || 'n/a'}`,
      `originalStart=${originalStart || 'n/a'}`,
      `earliestCashFlow=${earliestFlow ? earliestFlow.date : 'n/a'}${adjustmentHint}`,
    ].join(' | '));
  }

  if (aggregateEarliest) {
    console.log();
    console.log('[trace-aggregate] Aggregate earliest cash flow:');
    console.log(
      `- date=${aggregateEarliest.date} amount=${aggregateEarliest.amount} account=${aggregateEarliest.accountId} number=${aggregateEarliest.accountNumber}`
    );
  } else {
    console.log();
    console.log('[trace-aggregate] No cash flows found across accounts.');
  }
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error('[trace-aggregate] Failed:', message);
  process.exit(1);
});
