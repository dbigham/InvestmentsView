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

function normalizeLabel(value) {
  if (!value) return '';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toFriendlyCase(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return '';
  return normalized
    .split(' ')
    .map((word) => {
      if (word.length <= 3 && word === word.toUpperCase()) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function formatAccountChip(account) {
  if (!account) return '';
  const pieces = [];
  if (account.isPrimary) {
    pieces.push('Main');
  }
  const typeLabel = toFriendlyCase(account.clientAccountType || account.type);
  if (typeLabel) {
    pieces.push(typeLabel);
  }
  return pieces.join(' ');
}

function formatAccountSubtitle(account) {
  if (!account) return '';
  const segments = [];
  const descriptor = toFriendlyCase(account.type) || toFriendlyCase(account.clientAccountType);
  if (descriptor) {
    segments.push(descriptor);
  }
  if (account.number) {
    segments.push(`#${account.number}`);
  }
  return segments.join(' \\u2022 ');
}

export default function App() {
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [currencyView, setCurrencyView] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { loading, data, error } = useSummaryData(selectedAccount, refreshKey);

  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const positions = useMemo(() => data?.positions ?? [], [data?.positions]);
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

  const accountChipLabel = useMemo(() => {
    const label = formatAccountChip(selectedAccountMeta);
    return label || null;
  }, [selectedAccountMeta]);

  const headerMeta = useMemo(() => {
    if (selectedAccountMeta) {
      const subtitle = formatAccountSubtitle(selectedAccountMeta);
      return subtitle || null;
    }
    if (accounts.length > 1) {
      return `Combined across ${accounts.length} accounts`;
    }
    if (accounts.length === 1) {
      const subtitle = formatAccountSubtitle(accounts[0]);
      return subtitle || 'Account overview';
    }
    return loading ? 'Loading accounts...' : 'Account overview';
  }, [accounts, loading, selectedAccountMeta]);

  const showContent = !loading && !error && data;

  return (
    <div className="summary-page">
      <main className="summary-main">
        <header className="summary-header">
          <div className="summary-header__left">
            <div className="summary-header__title-row">
              <h1>Summary</h1>
              {accountChipLabel && <span className="summary-header__chip">{accountChipLabel}</span>}
            </div>
            {headerMeta && <p className="summary-header__meta">{headerMeta}</p>}
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

