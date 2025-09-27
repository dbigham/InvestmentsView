import { useEffect, useMemo, useState } from 'react';
import AccountSelector from './components/AccountSelector';
import CurrencyToggle from './components/CurrencyToggle';
import SummaryMetrics from './components/SummaryMetrics';
import PositionsTable from './components/PositionsTable';
import { getSummary } from './api/questrade';
import './App.css';

function useSummaryData(accountId, refreshKey) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: null });

    getSummary(accountId)
      .then((data) => {
        if (!cancelled) {
          setState({ loading: false, data, error: null });
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
  }, [accountId, refreshKey]);

  return state;
}

function buildCurrencyOptions(balances) {
  if (!balances) return [];
  const options = [];
  if (balances.combined) {
    Object.keys(balances.combined).forEach((currency) => {
      options.push({
        value: 'combined_' + currency,
        label: 'Combined (' + currency + ')',
        currency,
        scope: 'combined',
      });
    });
  }
  if (balances.perCurrency) {
    Object.keys(balances.perCurrency).forEach((currency) => {
      options.push({
        value: currency,
        label: currency,
        currency,
        scope: 'perCurrency',
      });
    });
  }
  return options;
}

function groupPnlByCurrency(positions) {
  return positions.reduce((acc, position) => {
    const currency = position.currency || 'CAD';
    if (!acc[currency]) {
      acc[currency] = { dayPnl: 0, openPnl: 0 };
    }
    acc[currency].dayPnl += position.dayPnl || 0;
    acc[currency].openPnl += position.openPnl || 0;
    return acc;
  }, {});
}

export default function App() {
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [currencyView, setCurrencyView] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { loading, data, error } = useSummaryData(selectedAccount, refreshKey);

  const accounts = data?.accounts || [];
  const positions = data?.positions || [];
  const balances = data?.balances;
  const pnlByCurrency = useMemo(() => groupPnlByCurrency(positions), [positions]);
  const currencyOptions = useMemo(() => buildCurrencyOptions(balances), [balances]);
  const orderedPositions = useMemo(() => {
    return positions.slice().sort((a, b) => {
      if (a.symbol === b.symbol) {
        return String(a.accountNumber).localeCompare(String(b.accountNumber || ''));
      }
      return a.symbol.localeCompare(b.symbol);
    });
  }, [positions]);

  useEffect(() => {
    if (!currencyOptions.length) {
      setCurrencyView(null);
      return;
    }
    const currentHasMatch = currencyOptions.some((option) => option.value === currencyView);
    if (!currentHasMatch) {
      setCurrencyView(currencyOptions[0].value);
    }
  }, [currencyOptions, currencyView]);

  const activeCurrency = currencyOptions.find((option) => option.value === currencyView);

  const activeBalances = activeCurrency && balances ? balances[activeCurrency.scope]?.[activeCurrency.currency] : null;
  const activePnl = activeCurrency ? pnlByCurrency[activeCurrency.currency] : { dayPnl: 0, openPnl: 0 };

  const showContent = !loading && !error && data;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <h1>Summary</h1>
          <AccountSelector accounts={accounts} selected={selectedAccount} onChange={setSelectedAccount} />
        </div>
        <div className="header-right">
          {currencyOptions.length > 0 && (
            <CurrencyToggle options={currencyOptions} selected={currencyView || ''} onChange={setCurrencyView} />
          )}
          <button type="button" className="refresh" onClick={() => setRefreshKey((value) => value + 1)}>
            Refresh
          </button>
        </div>
      </header>

      {loading && <div className="status-message">Loading latest account data...</div>}
      {error && (
        <div className="status-message error">
          <strong>Unable to load data.</strong>
          <p>{error.message}</p>
        </div>
      )}

      {showContent && activeCurrency && (
        <SummaryMetrics
          currencyCode={activeCurrency.currency}
          balances={activeBalances}
          pnl={activePnl}
          asOf={data.asOf}
        />
      )}

      {showContent && <PositionsTable positions={orderedPositions} />}
    </div>
  );
}
