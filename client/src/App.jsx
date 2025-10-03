import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AccountSelector from './components/AccountSelector';
import SummaryMetrics, { resolveScopedAmount } from './components/SummaryMetrics';
import PositionsTable from './components/PositionsTable';
import { getSummary, getQqqTemperature } from './api/questrade';
import usePersistentState from './hooks/usePersistentState';
import PeopleDialog from './components/PeopleDialog';
import PnlHeatmapDialog from './components/PnlHeatmapDialog';
import QqqTemperatureSection from './components/QqqTemperatureSection';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatSignedMoney,
} from './utils/formatters';
import './App.css';

const DEFAULT_POSITIONS_SORT = { column: 'portfolioShare', direction: 'desc' };
const EMPTY_OBJECT = Object.freeze({});

function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const numeric = Number(value);
  const hasFraction = Math.abs(numeric % 1) > 0.0000001;
  return formatNumber(numeric, {
    minimumFractionDigits: hasFraction ? 4 : 0,
    maximumFractionDigits: hasFraction ? 4 : 0,
  });
}

function formatPortfolioShare(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const numeric = Number(value);
  return `${formatNumber(numeric, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function resolveAccountSummary(selectedAccountId, accounts) {
  if (selectedAccountId && selectedAccountId !== 'all') {
    const account = accounts.find((entry) => entry.id === selectedAccountId || entry.number === selectedAccountId);
    if (account) {
      const owner = account.ownerLabel ? String(account.ownerLabel).trim() : '—';
      const number = account.number ? String(account.number).trim() : '—';
      const nameParts = [];
      if (account.displayName) {
        nameParts.push(String(account.displayName).trim());
      }
      if (!nameParts.length && account.clientAccountType) {
        nameParts.push(String(account.clientAccountType).trim());
      }
      if (!nameParts.length && account.type) {
        nameParts.push(String(account.type).trim());
      }
      if (!nameParts.length && number !== '—') {
        nameParts.push(`Account ${number}`);
      }
      return {
        owner: owner || '—',
        name: nameParts.join(' ') || 'Account',
        number,
      };
    }
  }

  const owners = Array.from(
    new Set(
      accounts
        .map((account) => (account && account.ownerLabel ? String(account.ownerLabel).trim() : null))
        .filter(Boolean)
    )
  );
  let ownerLabel = '—';
  if (owners.length === 1) {
    ownerLabel = owners[0];
  } else if (owners.length > 1) {
    ownerLabel = `All owners (${owners.join(', ')})`;
  }

  return {
    owner: ownerLabel,
    name: 'All accounts',
    number: accounts.length > 1 ? `${accounts.length} accounts combined` : accounts[0]?.number ?? '—',
  };
}

function buildPositionsTable(positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return 'No positions';
  }

  const columns = [
    {
      key: 'symbol',
      label: 'Symbol',
      getValue: (row) => (row.symbol ? String(row.symbol).trim() : '—'),
    },
    {
      key: 'description',
      label: 'Name',
      getValue: (row) => (row.description ? String(row.description).trim() : '—'),
    },
    {
      key: 'openQuantity',
      label: 'Qty',
      getValue: (row) => formatQuantity(row.openQuantity),
    },
    {
      key: 'averageEntryPrice',
      label: 'Avg price',
      getValue: (row) => formatMoney(row.averageEntryPrice),
    },
    {
      key: 'currentPrice',
      label: 'Price',
      getValue: (row) => formatMoney(row.currentPrice),
    },
    {
      key: 'currentMarketValue',
      label: 'Market value',
      getValue: (row) => formatMoney(row.currentMarketValue),
    },
    {
      key: 'dayPnl',
      label: "Today's P&L",
      getValue: (row) => formatSignedMoney(row.dayPnl),
    },
    {
      key: 'openPnl',
      label: 'Open P&L',
      getValue: (row) => formatSignedMoney(row.openPnl),
    },
    {
      key: 'portfolioShare',
      label: '% portfolio',
      getValue: (row) => formatPortfolioShare(row.portfolioShare),
    },
    {
      key: 'currency',
      label: 'Currency',
      getValue: (row) => (row.currency ? String(row.currency).trim().toUpperCase() : '—'),
    },
  ];

  const rows = positions.map((position) => {
    return columns.map((column) => {
      try {
        return column.getValue(position) ?? '—';
      } catch (error) {
        console.error('Failed to format column', column.key, error);
        return '—';
      }
    });
  });

  const header = columns.map((column) => column.label);
  const widths = header.map((label, columnIndex) => {
    const maxRowWidth = rows.reduce((max, row) => {
      const value = row[columnIndex];
      const length = typeof value === 'string' ? value.length : String(value ?? '').length;
      return Math.max(max, length);
    }, 0);
    return Math.max(label.length, maxRowWidth);
  });

  const formatRow = (cells) => {
    return cells
      .map((cell, index) => {
        const value = typeof cell === 'string' ? cell : String(cell ?? '');
        return value.padEnd(widths[index], ' ');
      })
      .join('  ');
  };

  const lines = [];
  lines.push(formatRow(header));
  lines.push(
    widths
      .map((width) => {
        return '-'.repeat(width);
      })
      .join('  ')
  );
  rows.forEach((row) => {
    lines.push(formatRow(row));
  });

  return lines.join('\n');
}

function buildClipboardSummary({
  selectedAccountId,
  accounts,
  balances,
  displayTotalEquity,
  usdToCadRate,
  pnl,
  positions,
  asOf,
  currencyOption,
}) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return null;
  }

  const summary = resolveAccountSummary(selectedAccountId, accounts);
  const lines = [];
  lines.push('Account summary');
  lines.push(`Owner: ${summary.owner}`);
  lines.push(`Account: ${summary.name}`);
  lines.push(`Account number: ${summary.number}`);
  if (currencyOption) {
    lines.push(`View: ${currencyOption.label}`);
  }
  if (asOf) {
    lines.push(`As of: ${formatDateTime(asOf)}`);
  }
  lines.push('');
  lines.push('Totals');
  const totalAmount = displayTotalEquity ?? (balances ? balances.totalEquity : null);
  lines.push(`Total amount: ${formatMoney(totalAmount)}`);
  lines.push(`Today's P&L: ${formatSignedMoney(pnl?.dayPnl)}`);
  lines.push(`Open P&L: ${formatSignedMoney(pnl?.openPnl)}`);
  const totalPnlAmount = resolveScopedAmount(pnl?.totalPnlBreakdown, currencyOption) ?? pnl?.totalPnl ?? null;
  lines.push(`Total P&L: ${formatSignedMoney(totalPnlAmount)}`);
  const netDepositAmount = resolveScopedAmount(pnl?.netDeposits, currencyOption);
  lines.push(`Net deposits: ${formatSignedMoney(netDepositAmount ?? null)}`);
  lines.push(`Total equity: ${formatMoney(balances?.totalEquity)}`);
  lines.push(`Market value: ${formatMoney(balances?.marketValue)}`);
  lines.push(`Cash: ${formatMoney(balances?.cash)}`);
  lines.push(`Buying power: ${formatMoney(balances?.buyingPower)}`);
  if (usdToCadRate !== null && usdToCadRate !== undefined) {
    lines.push(`USD → CAD: ${formatNumber(usdToCadRate, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`);
  }
  lines.push('');
  lines.push('Positions');
  lines.push(buildPositionsTable(positions));

  return lines.join('\n');
}

function useSummaryData(accountNumber, refreshKey) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const lastAccountRef = useRef();

  useEffect(() => {
    let cancelled = false;
    const previousAccount = lastAccountRef.current;
    const isSameAccount = previousAccount === accountNumber;
    lastAccountRef.current = accountNumber;

    setState((prev) => {
      const nextData = isSameAccount ? prev.data : null;
      return { loading: true, data: nextData, error: null };
    });

    getSummary(accountNumber)
      .then((summary) => {
        if (!cancelled) {
          setState({ loading: false, data: summary, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState((prev) => ({
            loading: false,
            data: isSameAccount ? prev.data : null,
            error,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountNumber, refreshKey]);

  return state;
}

function sortCurrencyKeys(keys) {
  const preferredOrder = { CAD: 0, USD: 1 };
  return keys
    .slice()
    .sort((a, b) => {
      const rankA = preferredOrder[a] ?? 99;
      const rankB = preferredOrder[b] ?? 99;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.localeCompare(b);
    });
}

function buildCurrencyOptions(balances) {
  if (!balances) {
    return [];
  }
  const options = [];

  if (balances.combined) {
    sortCurrencyKeys(Object.keys(balances.combined)).forEach((currency) => {
      options.push({
        value: `combined:${currency}`,
        label: `Combined in ${currency}`,
        scope: 'combined',
        currency,
      });
    });
  }

  if (balances.perCurrency) {
    sortCurrencyKeys(Object.keys(balances.perCurrency)).forEach((currency) => {
      options.push({
        value: `currency:${currency}`,
        label: currency,
        scope: 'perCurrency',
        currency,
      });
    });
  }

  return options;
}

function resolveTotalPnl(position) {
  const marketValue = position.currentMarketValue || 0;
  const totalCost =
    position.totalCost !== undefined && position.totalCost !== null
      ? position.totalCost
      : marketValue - (position.openPnl || 0) - (position.dayPnl || 0);
  return marketValue - (totalCost || 0);
}

function buildPnlSummaries(positions) {
  return positions.reduce(
    (acc, position) => {
      const currency = (position.currency || 'CAD').toUpperCase();
      if (!acc.perCurrency[currency]) {
        acc.perCurrency[currency] = { dayPnl: 0, openPnl: 0, totalPnl: 0 };
      }

      const day = position.dayPnl || 0;
      const open = position.openPnl || 0;
      const total = resolveTotalPnl(position);

      acc.perCurrency[currency].dayPnl += day;
      acc.perCurrency[currency].openPnl += open;
      acc.perCurrency[currency].totalPnl += total;

      acc.combined.dayPnl += day;
      acc.combined.openPnl += open;
      acc.combined.totalPnl += total;

      return acc;
    },
    { combined: { dayPnl: 0, openPnl: 0, totalPnl: 0 }, perCurrency: {} }
  );
}


function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const isParenthesized = /^\(.*\)$/.test(trimmed);
    const normalized = trimmed.replace(/[^0-9.-]/g, '');
    if (!normalized) {
      return null;
    }
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric)) {
      return isParenthesized ? -numeric : numeric;
    }
  }
  return null;
}

function buildBalancePnlMap(balances) {
  const result = { combined: {}, perCurrency: {} };
  if (!balances) {
    return result;
  }
  ['combined', 'perCurrency'].forEach((scope) => {
    const scopeBalances = balances[scope];
    if (!scopeBalances) {
      return;
    }
    Object.entries(scopeBalances).forEach(([currency, data]) => {
      if (!data) {
        return;
      }
      const day = coerceNumber(data.dayPnl ?? data.dayPnL);
      const open = coerceNumber(data.openPnl ?? data.openPnL);
      const total = coerceNumber(
        data.totalPnl ?? data.totalPnL ?? data.unrealizedPnl ?? data.totalReturn ?? data.totalGain
      );
      if (day === null && open === null && total === null) {
        return;
      }
      result[scope][currency] = {
        dayPnl: day,
        openPnl: open,
        totalPnl: total,
      };
    });
  });
  return result;
}

function resolveDisplayTotalEquity(balances) {
  if (!balances || !balances.combined) {
    return null;
  }
  const cadBucket = balances.combined.CAD;
  const cadValue = coerceNumber(cadBucket?.totalEquity);
  if (cadValue !== null) {
    return cadValue;
  }
  const combinedEntries = Object.values(balances.combined);
  for (const entry of combinedEntries) {
    const totalEquity = coerceNumber(entry?.totalEquity);
    if (totalEquity !== null) {
      return totalEquity;
    }
  }
  return null;
}

const ZERO_PNL = Object.freeze({
  dayPnl: 0,
  openPnl: 0,
  totalPnl: 0,
  totalPnlBreakdown: null,
  totalEquityBreakdown: null,
  netDeposits: null,
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function convertAmountToCurrency(value, sourceCurrency, targetCurrency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return 0;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedSource = (sourceCurrency || normalizedBase).toUpperCase();
  const normalizedTarget = (targetCurrency || normalizedBase).toUpperCase();

  const sourceRate = currencyRates?.get(normalizedSource);
  let baseValue = null;
  if (isFiniteNumber(sourceRate) && sourceRate > 0) {
    baseValue = value * sourceRate;
  } else if (normalizedSource === normalizedBase) {
    baseValue = value;
  }

  if (baseValue === null) {
    return 0;
  }

  if (normalizedTarget === normalizedBase) {
    return baseValue;
  }

  const targetRate = currencyRates?.get(normalizedTarget);
  if (isFiniteNumber(targetRate) && targetRate > 0) {
    return baseValue / targetRate;
  }

  return baseValue;
}

function convertCombinedPnl(perCurrencySummary, currencyRates, targetCurrency, baseCurrency = 'CAD') {
  const result = { dayPnl: 0, openPnl: 0, totalPnl: 0 };
  if (!perCurrencySummary) {
    return result;
  }

  Object.entries(perCurrencySummary).forEach(([currency, summary]) => {
    if (!summary) {
      return;
    }
    const normalizedCurrency = (currency || baseCurrency).toUpperCase();
    result.dayPnl += convertAmountToCurrency(
      summary.dayPnl ?? 0,
      normalizedCurrency,
      targetCurrency,
      currencyRates,
      baseCurrency
    );
    result.openPnl += convertAmountToCurrency(
      summary.openPnl ?? 0,
      normalizedCurrency,
      targetCurrency,
      currencyRates,
      baseCurrency
    );
    result.totalPnl += convertAmountToCurrency(
      summary.totalPnl ?? 0,
      normalizedCurrency,
      targetCurrency,
      currencyRates,
      baseCurrency
    );
  });

  return result;
}

function pickBalanceEntry(bucket, currency) {
  if (!bucket || !currency) {
    return null;
  }
  const normalized = currency.toUpperCase();
  return bucket[normalized] || bucket[currency] || bucket[normalized.toLowerCase()] || null;
}

function resolvePositionTotalCost(position) {
  if (position && position.totalCost !== undefined && position.totalCost !== null) {
    return position.totalCost;
  }
  if (position && isFiniteNumber(position.averageEntryPrice) && isFiniteNumber(position.openQuantity)) {
    return position.averageEntryPrice * position.openQuantity;
  }
  return null;
}

function deriveExchangeRate(perEntry, combinedEntry, baseCombinedEntry) {
  if (!perEntry && !combinedEntry) {
    return null;
  }

  const directFields = ['exchangeRate', 'fxRate', 'conversionRate', 'rate'];
  for (const field of directFields) {
    const candidate = (perEntry && perEntry[field]) ?? (combinedEntry && combinedEntry[field]) ?? null;
    if (isFiniteNumber(candidate) && candidate > 0) {
      return candidate;
    }
  }

  if (baseCombinedEntry && combinedEntry) {
    const baseFields = ['totalEquity', 'marketValue', 'cash', 'buyingPower'];
    for (const field of baseFields) {
      const baseValue = baseCombinedEntry[field];
      const currencyValue = combinedEntry[field];
      if (!isFiniteNumber(baseValue) || !isFiniteNumber(currencyValue)) {
        continue;
      }
      if (Math.abs(currencyValue) <= 1e-9) {
        continue;
      }

      const ratio = baseValue / currencyValue;
      if (isFiniteNumber(ratio) && Math.abs(ratio) > 1e-9) {
        return Math.abs(ratio);
      }
    }
  }

  const ratioSources = [
    ['totalEquity', 'totalEquity'],
    ['marketValue', 'marketValue'],
  ];

  for (const [perField, combinedField] of ratioSources) {
    const perValue = perEntry ? perEntry[perField] : null;
    const combinedValue = combinedEntry ? combinedEntry[combinedField] : null;
    if (!isFiniteNumber(perValue) || !isFiniteNumber(combinedValue)) {
      continue;
    }
    if (Math.abs(perValue) <= 1e-9 || Math.abs(combinedValue) <= 1e-9) {
      continue;
    }

    const ratio = combinedValue / perValue;
    if (isFiniteNumber(ratio) && Math.abs(ratio) > 1e-9) {
      return Math.abs(ratio);
    }
  }

  return null;
}

function buildCurrencyRateMap(balances, baseCurrency = 'CAD') {
  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const rates = new Map();
  rates.set(normalizedBase, 1);

  if (!balances) {
    return rates;
  }

  const combined = balances.combined || {};
  const perCurrency = balances.perCurrency || {};
  const baseCombinedEntry = pickBalanceEntry(combined, normalizedBase);
  const allKeys = new Set([
    ...Object.keys(combined || {}),
    ...Object.keys(perCurrency || {}),
  ]);

  allKeys.forEach((key) => {
    if (!key) {
      return;
    }
    const normalizedKey = key.toUpperCase();
    if (rates.has(normalizedKey)) {
      return;
    }

    const perEntry = pickBalanceEntry(perCurrency, key) || pickBalanceEntry(perCurrency, normalizedKey);
    const combinedEntry = pickBalanceEntry(combined, key) || pickBalanceEntry(combined, normalizedKey);

    const derived = deriveExchangeRate(perEntry, combinedEntry, baseCombinedEntry);
    if (derived && derived > 0) {
      rates.set(normalizedKey, derived);
      return;
    }

    if (normalizedKey === normalizedBase) {
      rates.set(normalizedKey, 1);
    }
  });

  return rates;
}

function normalizeCurrencyAmount(value, currency, currencyRates, baseCurrency = 'CAD') {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const normalizedCurrency = (currency || normalizedBase).toUpperCase();
  const rate = currencyRates.get(normalizedCurrency);
  if (isFiniteNumber(rate) && rate > 0) {
    return value * rate;
  }
  if (normalizedCurrency === normalizedBase) {
    return value;
  }
  return value;
}


function resolveAccountTotalInBase(combined, currencyRates, baseCurrency = 'CAD') {
  if (!combined || typeof combined !== 'object') {
    return 0;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();

  const pickBaseTotal = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    if (isFiniteNumber(entry.totalEquityCad)) {
      return entry.totalEquityCad;
    }
    const entryCurrency =
      typeof entry.currency === 'string' && entry.currency.trim()
        ? entry.currency.toUpperCase()
        : null;
    const reference =
      entry.totalEquity ?? entry.marketValue ?? entry.cash ?? entry.buyingPower ?? null;
    if (isFiniteNumber(reference) && entryCurrency === normalizedBase) {
      return reference;
    }
    return null;
  };

  const baseKey = Object.keys(combined).find((key) => key && key.toUpperCase() === normalizedBase);
  if (baseKey) {
    const resolved = pickBaseTotal(combined[baseKey]);
    if (resolved !== null) {
      return resolved;
    }
  }

  for (const entryKey of Object.keys(combined)) {
    const resolved = pickBaseTotal(combined[entryKey]);
    if (resolved !== null) {
      return resolved;
    }
  }

  let fallbackTotal = 0;

  Object.entries(combined).forEach(([currency, values]) => {
    if (!values || typeof values !== 'object') {
      return;
    }
    const reference =
      values.totalEquity ?? values.marketValue ?? values.cash ?? values.buyingPower ?? null;
    if (!isFiniteNumber(reference)) {
      return;
    }
    fallbackTotal += normalizeCurrencyAmount(reference, currency, currencyRates, baseCurrency);
  });

  return fallbackTotal;
}

function resolveAccountPnlInBase(combined, field, currencyRates, baseCurrency = 'CAD') {
  if (!combined || typeof combined !== 'object') {
    return 0;
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();

  let total = 0;
  Object.entries(combined).forEach(([currencyKey, values]) => {
    if (!values || typeof values !== 'object') {
      return;
    }
    const amount = coerceNumber(values[field]);
    if (amount === null) {
      return;
    }
    const entryCurrency =
      typeof values.currency === 'string' && values.currency.trim()
        ? values.currency.toUpperCase()
        : typeof currencyKey === 'string' && currencyKey.trim()
          ? currencyKey.toUpperCase()
          : normalizedBase;
    total += normalizeCurrencyAmount(amount, entryCurrency, currencyRates, baseCurrency);
  });

  return total;
}


function aggregatePositionsBySymbol(positions, { currencyRates, baseCurrency = 'CAD' }) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return [];
  }

  const normalizedBase = (baseCurrency || 'CAD').toUpperCase();
  const convert = (amount, currency) => normalizeCurrencyAmount(amount, currency, currencyRates, normalizedBase);

  const groups = new Map();
  const passthrough = [];

  positions.forEach((position) => {
    const symbolKey = position && position.symbol ? String(position.symbol).trim().toUpperCase() : '';
    if (!symbolKey) {
      if (position) {
        passthrough.push(position);
      }
      return;
    }

    let group = groups.get(symbolKey);
    if (!group) {
      group = {
        symbol: position.symbol,
        symbolId: position.symbolId ?? null,
        description: position.description || null,
        currencyBuckets: new Map(),
        openQuantity: 0,
        marketValueBase: 0,
        dayPnlBase: 0,
        openPnlBase: 0,
        totalCostBase: 0,
        totalCostBaseWeight: 0,
        currentPriceAccumulator: 0,
        currentPriceWeight: 0,
        isRealTime: Boolean(position?.isRealTime),
        rowId: `all:${symbolKey}`,
        key: symbolKey,
      };
      groups.set(symbolKey, group);
    }

    if (!group.symbol && position.symbol) {
      group.symbol = position.symbol;
    }
    if (!group.symbolId && position.symbolId) {
      group.symbolId = position.symbolId;
    }
    if (!group.description && position.description) {
      group.description = position.description;
    }

    const quantity = isFiniteNumber(position.openQuantity) ? position.openQuantity : 0;
    const marketValue = isFiniteNumber(position.currentMarketValue) ? position.currentMarketValue : 0;
    const dayPnl = isFiniteNumber(position.dayPnl) ? position.dayPnl : 0;
    const openPnl = isFiniteNumber(position.openPnl) ? position.openPnl : 0;
    const currency = (position.currency || normalizedBase).toUpperCase();
    const totalCost = resolvePositionTotalCost(position);
    const currentPrice = isFiniteNumber(position.currentPrice) ? position.currentPrice : null;

    group.openQuantity += quantity;
    group.marketValueBase += convert(marketValue, currency);
    group.dayPnlBase += convert(dayPnl, currency);
    group.openPnlBase += convert(openPnl, currency);
    if (totalCost !== null) {
      group.totalCostBase += convert(totalCost, currency);
      group.totalCostBaseWeight += quantity;
    }
    group.isRealTime = group.isRealTime || Boolean(position.isRealTime);

    if (currentPrice !== null && Math.abs(quantity) > 1e-9) {
      const weight = Math.abs(quantity);
      group.currentPriceAccumulator += currentPrice * weight;
      group.currentPriceWeight += weight;
    }

    let bucket = group.currencyBuckets.get(currency);
    if (!bucket) {
      bucket = { marketValue: 0, dayPnl: 0, openPnl: 0, totalCost: 0, costWeight: 0 };
      group.currencyBuckets.set(currency, bucket);
    }
    bucket.marketValue += marketValue;
    bucket.dayPnl += dayPnl;
    bucket.openPnl += openPnl;
    if (totalCost !== null) {
      bucket.totalCost += totalCost;
      bucket.costWeight += quantity;
    }
  });

  const aggregated = Array.from(groups.values()).map((group) => {
    const currencies = Array.from(group.currencyBuckets.keys());
    const hasSingleCurrency = currencies.length === 1;
    const displayCurrency = hasSingleCurrency ? currencies[0] : normalizedBase;
    const bucket = hasSingleCurrency ? group.currencyBuckets.get(displayCurrency) : null;

    let currentMarketValue = hasSingleCurrency && bucket ? bucket.marketValue : group.marketValueBase;
    if (!isFiniteNumber(currentMarketValue)) {
      currentMarketValue = 0;
    }

    let dayPnl = hasSingleCurrency && bucket ? bucket.dayPnl : group.dayPnlBase;
    if (!isFiniteNumber(dayPnl)) {
      dayPnl = 0;
    }

    let openPnl = hasSingleCurrency && bucket ? bucket.openPnl : group.openPnlBase;
    if (!isFiniteNumber(openPnl)) {
      openPnl = 0;
    }

    let totalCost = null;
    let averageEntryPrice = null;
    if (hasSingleCurrency && bucket) {
      if (isFiniteNumber(bucket.totalCost) && Math.abs(bucket.costWeight) > 1e-9) {
        totalCost = bucket.totalCost;
        averageEntryPrice = bucket.totalCost / bucket.costWeight;
      }
    }
    if (totalCost === null && Math.abs(group.totalCostBaseWeight) > 1e-9) {
      totalCost = group.totalCostBase;
      averageEntryPrice = group.totalCostBase / group.totalCostBaseWeight;
      if (!hasSingleCurrency) {
        currentMarketValue = group.marketValueBase;
        dayPnl = group.dayPnlBase;
        openPnl = group.openPnlBase;
      }
    }

    if (!isFiniteNumber(averageEntryPrice)) {
      averageEntryPrice = null;
    }

    const currentPrice =
      group.currentPriceWeight > 0
        ? group.currentPriceAccumulator / group.currentPriceWeight
        : null;

    const resolvedSymbolId = group.symbolId ?? group.key;

    return {
      symbol: group.symbol ?? group.key,
      symbolId: resolvedSymbolId,
      description: group.description ?? null,
      dayPnl,
      openPnl,
      openQuantity: group.openQuantity,
      averageEntryPrice,
      currentPrice,
      currentMarketValue,
      currency: displayCurrency,
      totalCost: totalCost ?? null,
      accountId: 'all',
      accountNumber: 'all',
      isRealTime: group.isRealTime,
      rowId: group.rowId,
      normalizedMarketValue: group.marketValueBase,
    };
  });

  if (!passthrough.length) {
    return aggregated;
  }

  return aggregated.concat(passthrough);
}

function resolveNormalizedMarketValue(position, currencyRates, baseCurrency = 'CAD') {
  if (position && isFiniteNumber(position.normalizedMarketValue)) {
    return position.normalizedMarketValue;
  }
  const value = position?.currentMarketValue ?? 0;
  const currency = position?.currency;
  return normalizeCurrencyAmount(value, currency, currencyRates, baseCurrency);
}

function resolveNormalizedPnl(position, field, currencyRates, baseCurrency = 'CAD') {
  if (!position || !isFiniteNumber(position?.[field])) {
    return 0;
  }
  const currency = position?.currency || baseCurrency;
  return normalizeCurrencyAmount(position[field], currency, currencyRates, baseCurrency);
}

export default function App() {
  const [selectedAccountState, setSelectedAccountState] = useState('all');
  const [activeAccountId, setActiveAccountId] = useState('default');
  const [currencyView, setCurrencyView] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [positionsSort, setPositionsSort] = usePersistentState('positionsTableSort', DEFAULT_POSITIONS_SORT);
  const [positionsPnlMode, setPositionsPnlMode] = usePersistentState('positionsTablePnlMode', 'currency');
  const [showPeople, setShowPeople] = useState(false);
  const [pnlBreakdownMode, setPnlBreakdownMode] = useState(null);
  const [qqqData, setQqqData] = useState(null);
  const [qqqLoading, setQqqLoading] = useState(false);
  const [qqqError, setQqqError] = useState(null);
  const { loading, data, error } = useSummaryData(activeAccountId, refreshKey);

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const selectedAccount = useMemo(() => {
    if (activeAccountId === 'default') {
      const filtered = Array.isArray(data?.filteredAccountIds) ? data.filteredAccountIds : [];
      if (filtered.length === 1) {
        return filtered[0];
      }
      if (filtered.length > 1) {
        return 'all';
      }
    }
    return selectedAccountState;
  }, [activeAccountId, data?.filteredAccountIds, selectedAccountState]);

  useEffect(() => {
    if (activeAccountId !== 'default') {
      return;
    }
    const filtered = Array.isArray(data?.filteredAccountIds) ? data.filteredAccountIds : [];
    if (filtered.length === 1) {
      const resolvedId = filtered[0];
      if (resolvedId && selectedAccountState !== resolvedId) {
        setSelectedAccountState(resolvedId);
      }
      return;
    }
    if (filtered.length > 1 && selectedAccountState !== 'all') {
      setSelectedAccountState('all');
    }
  }, [activeAccountId, data?.filteredAccountIds, selectedAccountState, setSelectedAccountState]);

  const handleAccountChange = useCallback(
    (value) => {
      if (!value) {
        return;
      }
      setSelectedAccountState(value);
      setActiveAccountId(value);
    },
    [setActiveAccountId, setSelectedAccountState]
  );

  const selectedAccountInfo = useMemo(() => {
    if (!selectedAccount || selectedAccount === 'all') {
      return null;
    }
    return (
      accounts.find((account) => {
        if (!account) {
          return false;
        }
        const accountId = typeof account.id === 'string' ? account.id : null;
        const accountNumber = typeof account.number === 'string' ? account.number : null;
        return accountId === selectedAccount || accountNumber === selectedAccount;
      }) || null
    );
  }, [accounts, selectedAccount]);
  const rawPositions = useMemo(() => data?.positions ?? [], [data?.positions]);
  const balances = data?.balances || null;
  const accountBalances = data?.accountBalances ?? EMPTY_OBJECT;
  const investmentModelEvaluations = data?.investmentModelEvaluations ?? EMPTY_OBJECT;
  const asOf = data?.asOf || null;

  const baseCurrency = 'CAD';
  const currencyRates = useMemo(() => buildCurrencyRateMap(balances, baseCurrency), [balances]);

  const usdToCadRate = useMemo(() => {
    const rate = currencyRates.get('USD');
    if (isFiniteNumber(rate) && rate > 0) {
      return rate;
    }
    return null;
  }, [currencyRates]);

  const positions = useMemo(() => {
    if (selectedAccount === 'all') {
      return aggregatePositionsBySymbol(rawPositions, { currencyRates, baseCurrency });
    }
    return rawPositions;
  }, [rawPositions, selectedAccount, currencyRates, baseCurrency]);

  const totalMarketValue = useMemo(() => {
    if (!positions.length) {
      return 0;
    }
    return positions.reduce((acc, position) => {
      return acc + resolveNormalizedMarketValue(position, currencyRates, baseCurrency);
    }, 0);
  }, [positions, currencyRates, baseCurrency]);

  const positionsWithShare = useMemo(() => {
    if (!positions.length) {
      return [];
    }
    return positions.map((position) => {
      const normalizedValue = resolveNormalizedMarketValue(position, currencyRates, baseCurrency);
      const share = totalMarketValue > 0 ? (normalizedValue / totalMarketValue) * 100 : 0;
      const normalizedDayPnl = resolveNormalizedPnl(position, 'dayPnl', currencyRates, baseCurrency);
      const normalizedOpenPnl = resolveNormalizedPnl(position, 'openPnl', currencyRates, baseCurrency);
      return {
        ...position,
        portfolioShare: share,
        normalizedMarketValue: normalizedValue,
        normalizedDayPnl,
        normalizedOpenPnl,
      };
    });
  }, [positions, totalMarketValue, currencyRates, baseCurrency]);

  const orderedPositions = useMemo(() => {
    const list = positionsWithShare.slice();
    list.sort((a, b) => {
      const shareDiff = (b.portfolioShare || 0) - (a.portfolioShare || 0);
      if (Math.abs(shareDiff) > 0.0001) {
        return shareDiff;
      }
      const marketDiff = (b.currentMarketValue || 0) - (a.currentMarketValue || 0);
      if (Math.abs(marketDiff) > 0.01) {
        return marketDiff;
      }
      return a.symbol.localeCompare(b.symbol);
    });
    return list;
  }, [positionsWithShare]);

  const currencyOptions = useMemo(() => buildCurrencyOptions(balances), [balances]);

  useEffect(() => {
    if (!currencyOptions.length) {
      setCurrencyView(null);
      return;
    }
    if (!currencyOptions.some((option) => option.value === currencyView)) {
      setCurrencyView(currencyOptions[0].value);
    }
  }, [currencyOptions, currencyView]);

  const balancePnlSummaries = useMemo(() => buildBalancePnlMap(balances), [balances]);
  const positionPnlSummaries = useMemo(() => buildPnlSummaries(positions), [positions]);

  const normalizedAccountBalances = useMemo(() => {
    if (accountBalances && typeof accountBalances === 'object') {
      return accountBalances;
    }
    return EMPTY_OBJECT;
  }, [accountBalances]);

  const accountPnlTotals = useMemo(() => {
    if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
      return new Map();
    }

    const totals = new Map();

    rawPositions.forEach((position) => {
      const accountId = position?.accountId;
      if (!accountId) {
        return;
      }

      const currency = position?.currency || baseCurrency;
      const day = isFiniteNumber(position?.dayPnl) ? position.dayPnl : 0;
      const open = isFiniteNumber(position?.openPnl) ? position.openPnl : 0;

      const bucket = totals.get(accountId) || { dayPnl: 0, openPnl: 0 };
      if (day) {
        bucket.dayPnl += normalizeCurrencyAmount(day, currency, currencyRates, baseCurrency);
      }
      if (open) {
        bucket.openPnl += normalizeCurrencyAmount(open, currency, currencyRates, baseCurrency);
      }
      totals.set(accountId, bucket);
    });

    return totals;
  }, [rawPositions, currencyRates, baseCurrency]);

  const peopleSummary = useMemo(() => {
    if (!accounts.length) {
      return { totals: [], missingAccounts: [], hasBalances: false };
    }

    const balanceEntries = normalizedAccountBalances;
    const accountMap = new Map();
    accounts.forEach((account) => {
      if (account && account.id) {
        accountMap.set(account.id, account);
      }
    });

    const totalsMap = new Map();
    const allAccountBuckets = new Map();
    const coveredAccountBuckets = new Map();

    const ensureAggregate = (beneficiary) => {
      if (!totalsMap.has(beneficiary)) {
        totalsMap.set(beneficiary, { total: 0, dayPnl: 0, openPnl: 0 });
      }
      return totalsMap.get(beneficiary);
    };

    accountMap.forEach((account) => {
      const beneficiary = account.beneficiary || 'Unassigned';
      ensureAggregate(beneficiary);
      if (!allAccountBuckets.has(beneficiary)) {
        allAccountBuckets.set(beneficiary, new Set());
      }
      allAccountBuckets.get(beneficiary).add(account.id);
      if (!coveredAccountBuckets.has(beneficiary)) {
        coveredAccountBuckets.set(beneficiary, new Set());
      }
    });

    let hasBalanceEntries = false;

    Object.entries(balanceEntries).forEach(([accountId, combined]) => {
      const account = accountMap.get(accountId);
      if (!account) {
        return;
      }
      hasBalanceEntries = true;
      const beneficiary = account.beneficiary || 'Unassigned';
      const accountTotal = resolveAccountTotalInBase(combined, currencyRates, baseCurrency);
      const aggregate = ensureAggregate(beneficiary);
      aggregate.total += accountTotal;
      const accountPnl = accountPnlTotals.get(accountId);
      if (accountPnl) {
        aggregate.dayPnl += accountPnl.dayPnl;
        aggregate.openPnl += accountPnl.openPnl;
      } else {
        aggregate.dayPnl += resolveAccountPnlInBase(combined, 'dayPnl', currencyRates, baseCurrency);
        aggregate.openPnl += resolveAccountPnlInBase(combined, 'openPnl', currencyRates, baseCurrency);
      }
      const coveredSet = coveredAccountBuckets.get(beneficiary) || new Set();
      coveredSet.add(accountId);
      coveredAccountBuckets.set(beneficiary, coveredSet);
    });

    const missingAccounts = [];
    accountMap.forEach((account, accountId) => {
      const beneficiary = account.beneficiary || 'Unassigned';
      const coveredSet = coveredAccountBuckets.get(beneficiary);
      if (!coveredSet || !coveredSet.has(accountId)) {
        missingAccounts.push(account);
      }
    });

    const totals = Array.from(totalsMap.entries())
      .map(([beneficiary, aggregate]) => {
        const coveredSet = coveredAccountBuckets.get(beneficiary);
        const allSet = allAccountBuckets.get(beneficiary);
        return {
          beneficiary,
          total: aggregate.total,
          dayPnl: aggregate.dayPnl,
          openPnl: aggregate.openPnl,
          accountCount: coveredSet ? coveredSet.size : 0,
          totalAccounts: allSet ? allSet.size : coveredSet ? coveredSet.size : 0,
        };
      })
      .sort((a, b) => {
        const diff = (b.total || 0) - (a.total || 0);
        if (Math.abs(diff) > 0.01) {
          return diff;
        }
        return a.beneficiary.localeCompare(b.beneficiary);
      });

    return {
      totals,
      missingAccounts,
      hasBalances: hasBalanceEntries,
    };
  }, [
    accounts,
    normalizedAccountBalances,
    currencyRates,
    baseCurrency,
    accountPnlTotals,
  ]);

  const activeCurrency = currencyOptions.find((option) => option.value === currencyView) || null;
  const activeBalances =
    activeCurrency && balances ? balances[activeCurrency.scope]?.[activeCurrency.currency] ?? null : null;
  const displayTotalEquity = useMemo(() => {
    const canonical = resolveDisplayTotalEquity(balances);
    if (canonical !== null) {
      return canonical;
    }
    return coerceNumber(activeBalances?.totalEquity);
  }, [balances, activeBalances]);

  const fallbackPnl = useMemo(() => {
    if (!activeCurrency) {
      return ZERO_PNL;
    }
    if (activeCurrency.scope === 'combined') {
      return convertCombinedPnl(
        positionPnlSummaries.perCurrency,
        currencyRates,
        activeCurrency.currency,
        baseCurrency
      );
    }
    return positionPnlSummaries.perCurrency[activeCurrency.currency] || ZERO_PNL;
  }, [activeCurrency, positionPnlSummaries, currencyRates, baseCurrency]);

  const rawServerPnl = data?.pnl || null;

  const activePnl = useMemo(() => {
    if (!activeCurrency) {
      return rawServerPnl ? Object.assign({}, ZERO_PNL, rawServerPnl) : ZERO_PNL;
    }

    const balanceEntry = balancePnlSummaries[activeCurrency.scope]?.[activeCurrency.currency] || null;
    const totalFromBalance = balanceEntry ? balanceEntry.totalPnl : null;
    const hasBalanceTotal = isFiniteNumber(totalFromBalance);

    const base = rawServerPnl ? Object.assign({}, ZERO_PNL, rawServerPnl) : { ...ZERO_PNL };

    if (!balanceEntry) {
      base.dayPnl = fallbackPnl.dayPnl;
      base.openPnl = fallbackPnl.openPnl;
      base.totalPnl = hasBalanceTotal ? totalFromBalance : null;
      if (base.totalPnl === null && isFiniteNumber(fallbackPnl.totalPnl)) {
        base.totalPnl = fallbackPnl.totalPnl;
      }
      return base;
    }

    const resolvedDay = balanceEntry.dayPnl ?? fallbackPnl.dayPnl;
    const resolvedOpen = balanceEntry.openPnl ?? fallbackPnl.openPnl;
    base.dayPnl = isFiniteNumber(resolvedDay) ? resolvedDay : fallbackPnl.dayPnl;
    base.openPnl = isFiniteNumber(resolvedOpen) ? resolvedOpen : fallbackPnl.openPnl;

    if (hasBalanceTotal) {
      base.totalPnl = totalFromBalance;
    } else if (isFiniteNumber(fallbackPnl.totalPnl)) {
      base.totalPnl = fallbackPnl.totalPnl;
    } else {
      base.totalPnl = null;
    }

    return base;
  }, [activeCurrency, balancePnlSummaries, fallbackPnl, rawServerPnl]);

  const heatmapMarketValue = useMemo(() => {
    if (activeBalances && typeof activeBalances === 'object') {
      const balanceTotalEquity = coerceNumber(activeBalances.totalEquity);
      const balanceMarketValue = coerceNumber(activeBalances.marketValue);
      const resolvedBalanceValue =
        balanceTotalEquity !== null ? balanceTotalEquity : balanceMarketValue !== null ? balanceMarketValue : null;

      if (resolvedBalanceValue !== null) {
        const balanceCurrency =
          (activeCurrency && typeof activeCurrency.currency === 'string'
            ? activeCurrency.currency
            : baseCurrency) || baseCurrency;
        return normalizeCurrencyAmount(resolvedBalanceValue, balanceCurrency, currencyRates, baseCurrency);
      }
    }
    return totalMarketValue;
  }, [
    activeBalances,
    activeCurrency,
    currencyRates,
    baseCurrency,
    totalMarketValue,
  ]);

  const peopleTotals = peopleSummary.totals;
  const peopleMissingAccounts = peopleSummary.missingAccounts;
  const shouldShowQqqDetails = Boolean(selectedAccountInfo?.showQQQDetails);

  const selectedAccountEvaluation = useMemo(() => {
    if (!selectedAccountInfo) {
      return null;
    }
    if (selectedAccountInfo.id && investmentModelEvaluations[selectedAccountInfo.id]) {
      return investmentModelEvaluations[selectedAccountInfo.id];
    }
    return null;
  }, [selectedAccountInfo, investmentModelEvaluations]);
  const qqqSectionTitle = selectedAccountInfo?.investmentModel ? 'Investment Model' : 'QQQ temperature';

  const showingAllAccounts = selectedAccount === 'all';

  const fetchQqqTemperature = useCallback(() => {
    if (qqqLoading) {
      return;
    }
    setQqqLoading(true);
    setQqqError(null);
    getQqqTemperature()
      .then((result) => {
        setQqqData(result);
      })
      .catch((err) => {
        const normalized = err instanceof Error ? err : new Error('Failed to load QQQ temperature data');
        setQqqError(normalized);
      })
      .finally(() => {
        setQqqLoading(false);
      });
  }, [qqqLoading]);

  useEffect(() => {
    if (!shouldShowQqqDetails && !showingAllAccounts) {
      return;
    }
    if (qqqData || qqqLoading || qqqError) {
      return;
    }
    fetchQqqTemperature();
  }, [
    shouldShowQqqDetails,
    showingAllAccounts,
    qqqData,
    qqqLoading,
    qqqError,
    fetchQqqTemperature,
  ]);
  const qqqSummary = useMemo(() => {
    const latestTemperature = Number(qqqData?.latest?.temperature);
    const latestDate =
      typeof qqqData?.latest?.date === 'string' && qqqData.latest.date.trim()
        ? qqqData.latest.date
        : typeof qqqData?.rangeEnd === 'string'
        ? qqqData.rangeEnd
        : null;

    if (Number.isFinite(latestTemperature)) {
      return {
        status: qqqLoading ? 'refreshing' : 'ready',
        temperature: latestTemperature,
        date: latestDate,
      };
    }

    if (qqqError) {
      return {
        status: 'error',
        message: qqqError.message || 'Unable to load QQQ temperature data',
      };
    }

    if (qqqLoading) {
      return { status: 'loading' };
    }

    if (qqqData) {
      return { status: 'error', message: 'QQQ temperature unavailable' };
    }

    return { status: 'loading' };
  }, [qqqData, qqqLoading, qqqError]);

  const peopleDisabled = !peopleSummary.hasBalances;
  const selectedAccountChatUrl = useMemo(() => {
    if (!selectedAccountInfo || typeof selectedAccountInfo.chatURL !== 'string') {
      return null;
    }
    const trimmed = selectedAccountInfo.chatURL.trim();
    return trimmed || null;
  }, [selectedAccountInfo]);

  const resolvedSortColumn =
    positionsSort && typeof positionsSort.column === 'string' && positionsSort.column.trim()
      ? positionsSort.column
      : DEFAULT_POSITIONS_SORT.column;
  const resolvedSortDirection = (() => {
    if (!positionsSort || typeof positionsSort.direction !== 'string') {
      return DEFAULT_POSITIONS_SORT.direction;
    }
    const normalized = positionsSort.direction.toLowerCase();
    if (normalized === 'asc' || normalized === 'desc') {
      return normalized;
    }
    return DEFAULT_POSITIONS_SORT.direction;
  })();

  const hasData = Boolean(data);
  const isRefreshing = loading && hasData;
  const showContent = hasData;

  const handleCopySummary = useCallback(async () => {
    if (!showContent) {
      return;
    }

    const text = buildClipboardSummary({
      selectedAccountId: selectedAccount,
      accounts,
      balances: activeBalances,
      displayTotalEquity,
      usdToCadRate,
      pnl: activePnl,
      positions: orderedPositions,
      asOf,
      currencyOption: activeCurrency,
    });

    if (!text) {
      return;
    }

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
    } catch (error) {
      console.error('Failed to copy account summary', error);
    }
  }, [
    showContent,
    selectedAccount,
    accounts,
    activeBalances,
    displayTotalEquity,
    usdToCadRate,
    activePnl,
    orderedPositions,
    asOf,
    activeCurrency,
  ]);

  useEffect(() => {
    if (!autoRefreshEnabled) {
      return undefined;
    }

    if (typeof window === 'undefined') {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setRefreshKey((value) => value + 1);
    }, 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [autoRefreshEnabled]);

  useEffect(() => {
    if (!hasData && pnlBreakdownMode) {
      setPnlBreakdownMode(null);
    }
  }, [hasData, pnlBreakdownMode]);

  const handleRetryQqqDetails = useCallback(() => {
    fetchQqqTemperature();
  }, [fetchQqqTemperature]);

  const handleRefresh = (event) => {
    if (event?.ctrlKey) {
      event.preventDefault();
      setAutoRefreshEnabled((value) => !value);
      return;
    }
    setRefreshKey((value) => value + 1);
    if (showingAllAccounts || shouldShowQqqDetails) {
      fetchQqqTemperature();
    }
  };

  const handleShowPnlBreakdown = (mode) => {
    if (!showContent || !orderedPositions.length) {
      return;
    }
    if (mode !== 'day' && mode !== 'open') {
      return;
    }
    setPnlBreakdownMode(mode);
  };

  const handleClosePnlBreakdown = () => {
    setPnlBreakdownMode(null);
  };

  const handleOpenPeople = () => {
    if (!peopleSummary.hasBalances) {
      return;
    }
    setShowPeople(true);
  };

  const handleClosePeople = () => {
    setShowPeople(false);
  };

  if (loading && !data) {
    return (
      <div className="summary-page summary-page--initial-loading">
        <div className="initial-loading" role="status" aria-live="polite">
          <span className="visually-hidden">Loading latest account data…</span>
          <span className="initial-loading__spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="summary-page">
      <main className="summary-main">
        <header className="page-header">
          <AccountSelector
            accounts={accounts}
            selected={selectedAccount}
            onChange={handleAccountChange}
            disabled={loading && !data}
          />
        </header>

        {error && (
          <div className="status-message error">
            <strong>Unable to load data.</strong>
            <p>{error.message}</p>
          </div>
        )}

        {showContent && (
          <SummaryMetrics
            currencyOption={activeCurrency}
            currencyOptions={currencyOptions}
            onCurrencyChange={setCurrencyView}
            balances={activeBalances}
            pnl={activePnl}
            asOf={asOf}
            onRefresh={handleRefresh}
            displayTotalEquity={displayTotalEquity}
            usdToCadRate={usdToCadRate}
            onShowPeople={handleOpenPeople}
            peopleDisabled={peopleDisabled}
            onShowPnlBreakdown={orderedPositions.length ? handleShowPnlBreakdown : null}
            isRefreshing={isRefreshing}
            isAutoRefreshing={autoRefreshEnabled}
            onCopySummary={handleCopySummary}
            chatUrl={selectedAccountChatUrl}
            showQqqTemperature={showingAllAccounts}
            qqqSummary={qqqSummary}
          />
        )}

        {showContent && shouldShowQqqDetails && (
          <QqqTemperatureSection
            data={qqqData}
            loading={qqqLoading}
            error={qqqError}
            onRetry={handleRetryQqqDetails}
            title={qqqSectionTitle}
            modelName={selectedAccountInfo?.investmentModel || null}
            lastRebalance={selectedAccountInfo?.investmentModelLastRebalance || null}
            evaluation={selectedAccountEvaluation}
          />
        )}

        {showContent && (
          <PositionsTable
            positions={orderedPositions}
            totalMarketValue={totalMarketValue}
            sortColumn={resolvedSortColumn}
            sortDirection={resolvedSortDirection}
            onSortChange={setPositionsSort}
            pnlMode={positionsPnlMode}
            onPnlModeChange={setPositionsPnlMode}
          />
        )}
      </main>
      {showPeople && (
        <PeopleDialog
          totals={peopleTotals}
          onClose={handleClosePeople}
          baseCurrency={baseCurrency}
          isFilteredView={!showingAllAccounts}
          missingAccounts={peopleMissingAccounts}
          asOf={asOf}
        />
      )}
      {pnlBreakdownMode && (
        <PnlHeatmapDialog
          positions={orderedPositions}
          mode={pnlBreakdownMode}
          onClose={handleClosePnlBreakdown}
          baseCurrency={baseCurrency}
          asOf={asOf}
          totalMarketValue={heatmapMarketValue}
        />
      )}
    </div>
  );
}






