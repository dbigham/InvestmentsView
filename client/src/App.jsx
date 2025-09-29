import { useEffect, useMemo, useState } from 'react';
import AccountSelector from './components/AccountSelector';
import SummaryMetrics from './components/SummaryMetrics';
import PositionsTable from './components/PositionsTable';
import { getSummary } from './api/questrade';
import './App.css';

function useSummaryData(accountNumber, refreshKey) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });

    getSummary(accountNumber)
      .then((summary) => {
        if (!cancelled) {
          setState({ loading: false, data: summary, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ loading: false, data: null, error });
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
        title: `Total equity (Combined in ${currency})`,
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
        title: `Total equity (${currency})`,
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
      const currency = position.currency || 'CAD';
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
    const normalized = value.replace(/,/g, '').trim();
    if (!normalized) {
      return null;
    }
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric)) {
      return numeric;
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

const ZERO_PNL = Object.freeze({ dayPnl: 0, openPnl: 0, totalPnl: 0 });

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
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

export default function App() {
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [currencyView, setCurrencyView] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { loading, data, error } = useSummaryData(selectedAccount, refreshKey);

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const rawPositions = useMemo(() => data?.positions ?? [], [data?.positions]);
  const balances = data?.balances || null;
  const asOf = data?.asOf || null;

  const baseCurrency = 'CAD';
  const currencyRates = useMemo(() => buildCurrencyRateMap(balances, baseCurrency), [balances]);

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
      return { ...position, portfolioShare: share, normalizedMarketValue: normalizedValue };
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
      return positionPnlSummaries.combined;
    }
    return positionPnlSummaries.perCurrency[activeCurrency.currency] || ZERO_PNL;
  }, [activeCurrency, positionPnlSummaries]);

  const activePnl = useMemo(() => {
    if (!activeCurrency) {
      return ZERO_PNL;
    }
    const balanceEntry = balancePnlSummaries[activeCurrency.scope]?.[activeCurrency.currency] || null;
    if (!balanceEntry) {
      return fallbackPnl;
    }
    return {
      dayPnl: balanceEntry.dayPnl ?? fallbackPnl.dayPnl,
      openPnl: balanceEntry.openPnl ?? fallbackPnl.openPnl,
      totalPnl: balanceEntry.totalPnl ?? fallbackPnl.totalPnl,
    };
  }, [activeCurrency, balancePnlSummaries, fallbackPnl]);

  const showContent = !loading && !error && data;

  const handleRefresh = () => {
    setRefreshKey((value) => value + 1);
  };

  return (
    <div className="summary-page">
      <main className="summary-main">
        <header className="page-header">
          <AccountSelector
            accounts={accounts}
            selected={selectedAccount}
            onChange={setSelectedAccount}
            disabled={loading && !data}
          />
        </header>

        {loading && <div className="status-message">Loading latest account data...</div>}
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
          />
        )}

        {showContent && (
          <PositionsTable
            positions={orderedPositions}
            totalMarketValue={totalMarketValue}
            sortColumn="portfolioShare"
            sortDirection="desc"
          />
        )}
      </main>
    </div>
  );
}






