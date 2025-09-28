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

function buildCurrencyOptions(balances) {
  if (!balances) return [];
  const options = [];

  if (balances.combined) {
    Object.keys(balances.combined).forEach((currency) => {
      options.push({
        value: 'combined_' + currency,
        label: `Combined (${currency})`,
        currency,
        scope: 'combined',
      });
    });
  }

  if (balances.perCurrency) {
    Object.keys(balances.perCurrency).forEach((currency) => {
      options.push({ value: currency, label: currency, currency, scope: 'perCurrency' });
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
      if (a.accountNumber === b.accountNumber) {
        return a.symbol.localeCompare(b.symbol);
      }
      return String(a.accountNumber).localeCompare(String(b.accountNumber));
    });
  }, [positions]);

  useEffect(() => {
    if (!currencyOptions.length) {
      setCurrencyView(null);
      return;
    }
    if (!currencyOptions.some((option) => option.value === currencyView)) {
      setCurrencyView(currencyOptions[0].value);
    }
  }, [currencyOptions, currencyView]);

  const activeCurrency = currencyOptions.find((option) => option.value === currencyView) || null;
  const activeBalances = activeCurrency && balances ? balances[activeCurrency.scope]?.[activeCurrency.currency] : null;
  const activePnl = activeCurrency ? pnlByCurrency[activeCurrency.currency] : { dayPnl: 0, openPnl: 0 };

  const totalMarketValue = useMemo(() => {
    return orderedPositions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);
  }, [orderedPositions]);

  const selectedAccountMeta = useMemo(() => {
    if (selectedAccount === 'all') return null;
    return accounts.find((account) => account.number === selectedAccount) || null;
  }, [accounts, selectedAccount]);

  const showContent = !loading && !error && data;

  return (
    <div className="summary-page">
      <main className="summary-main">
        <header className="summary-header">
          <div className="summary-header__titles">
            <h1>Summary</h1>
            <p>
              {selectedAccountMeta
                ? `${selectedAccountMeta.type || ''} · ${selectedAccountMeta.number}`
                : `${accounts.length} accounts`}
            </p>
          </div>
          <button
            type="button"
            className="summary-header__refresh"
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            Refresh
          </button>
        </header>

        <section className="summary-controls">
          <AccountSelector accounts={accounts} selected={selectedAccount} onChange={setSelectedAccount} />
        </section>

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
            asOf={data.asOf}
          />
        )}

        {showContent && <PositionsTable positions={orderedPositions} totalMarketValue={totalMarketValue} />}
      </main>
    </div>
  );
}
