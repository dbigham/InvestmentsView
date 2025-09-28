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

function groupPnlByCurrency(positions) {
  return positions.reduce((acc, position) => {
    const currency = position.currency || 'CAD';
    if (!acc[currency]) {
      acc[currency] = { dayPnl: 0, openPnl: 0, totalPnl: 0 };
    }
    acc[currency].dayPnl += position.dayPnl || 0;
    acc[currency].openPnl += position.openPnl || 0;

    const marketValue = position.currentMarketValue || 0;
    const totalCost =
      position.totalCost !== undefined && position.totalCost !== null
        ? position.totalCost
        : marketValue - (position.openPnl || 0) - (position.dayPnl || 0);
    acc[currency].totalPnl += marketValue - (totalCost || 0);
    return acc;
  }, {});
}

export default function App() {
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [currencyView, setCurrencyView] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { loading, data, error } = useSummaryData(selectedAccount, refreshKey);

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const positions = useMemo(() => data?.positions ?? [], [data?.positions]);
  const balances = data?.balances || null;
  const asOf = data?.asOf || null;

  const totalMarketValue = useMemo(() => {
    return positions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);
  }, [positions]);

  const positionsWithShare = useMemo(() => {
    if (!positions.length) {
      return [];
    }
    return positions.map((position) => {
      const share = totalMarketValue > 0 ? ((position.currentMarketValue || 0) / totalMarketValue) * 100 : 0;
      return { ...position, portfolioShare: share };
    });
  }, [positions, totalMarketValue]);

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

  const pnlByCurrency = useMemo(() => groupPnlByCurrency(positions), [positions]);
  const activeCurrency = currencyOptions.find((option) => option.value === currencyView) || null;
  const activeBalances =
    activeCurrency && balances ? balances[activeCurrency.scope]?.[activeCurrency.currency] ?? null : null;
  const activePnl = activeCurrency ? pnlByCurrency[activeCurrency.currency] || { dayPnl: 0, openPnl: 0, totalPnl: 0 } : null;

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
            pnl={activePnl || { dayPnl: 0, openPnl: 0, totalPnl: 0 }}
            asOf={asOf}
            onRefresh={handleRefresh}
          />
        )}

        {showContent && (
          <PositionsTable
            positions={orderedPositions}
            totalMarketValue={totalMarketValue}
            asOf={asOf}
            onRefresh={handleRefresh}
            sortColumn="portfolioShare"
            sortDirection="desc"
          />
        )}
      </main>
    </div>
  );
}
