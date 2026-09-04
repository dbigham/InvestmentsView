import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';
import { formatCurrencyLabel } from './investPlanUtils';

function formatAmount(value, currency) {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return formatCurrencyLabel(value, currency);
}

function formatHoldingQuantity(value) {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

function formatTradePrice(value, currency) {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${formatMoney(value)} ${currency || ''}`.trim();
}

function collectReserveSales(account) {
  if (!account || !Array.isArray(account.cashCoverage)) {
    return [];
  }
  return account.cashCoverage.flatMap((coverage) =>
    Array.isArray(coverage.reserveSales) ? coverage.reserveSales : []
  );
}

function countAccountTrades(account) {
  if (!account) {
    return 0;
  }
  return (
    (Array.isArray(account.sells) ? account.sells.length : 0) +
    (Array.isArray(account.buys) ? account.buys.length : 0) +
    collectReserveSales(account).length
  );
}

function buildAccountSummaryText(plan) {
  if (!plan || !Array.isArray(plan.accounts)) {
    return '';
  }

  const lines = ['Fractional share rounding plan', ''];
  plan.accounts.forEach((account) => {
    lines.push(account.accountLabel || account.accountNumber || 'Account');
    if (account.accountNumber) {
      lines.push(`  Account number: ${account.accountNumber}`);
    }

    if (Array.isArray(account.sells) && account.sells.length > 0) {
      lines.push('  Sells');
      account.sells.forEach((trade) => {
        lines.push(`    SELL ${trade.symbol}: ${trade.sharesCopy} shares`);
      });
    }

    const reserveSales = collectReserveSales(account);
    if (reserveSales.length > 0) {
      lines.push('  Reserve sells before buys');
      reserveSales.forEach((trade) => {
        lines.push(`    SELL ${trade.symbol}: ${trade.sharesCopy} shares`);
      });
    }

    if (Array.isArray(account.buys) && account.buys.length > 0) {
      lines.push('  Buys');
      account.buys.forEach((trade) => {
        lines.push(`    BUY ${trade.symbol}: ${trade.sharesCopy} shares`);
      });
    }
    lines.push('');
  });

  lines.push(`Fractional sells: ${plan.sellCount || 0}`);
  lines.push(`Fractional buys: ${plan.buyCount || 0}`);
  if (plan.reserveTradeCount > 0) {
    lines.push(`Reserve sells first: ${plan.reserveTradeCount}`);
  }
  lines.push(`Total trades: ${plan.tradeCount || 0}`);
  return lines.join('\n').trim();
}

export default function SellFractionalSharesDialog({ plan, onClose, copyToClipboard, onOpenAccount }) {
  const [copyStatus, setCopyStatus] = useState(null);
  const [completedTrades, setCompletedTrades] = useState(() => new Set());
  const [selectedAccountKey, setSelectedAccountKey] = useState(() => plan?.accounts?.[0]?.accountKey || '');

  const accounts = useMemo(() => (Array.isArray(plan?.accounts) ? plan.accounts : []), [plan?.accounts]);
  const summaryText = useMemo(() => buildAccountSummaryText(plan), [plan]);

  useEffect(() => {
    setCompletedTrades(new Set());
    setSelectedAccountKey(plan?.accounts?.[0]?.accountKey || '');
  }, [plan]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!copyStatus || typeof window === 'undefined') {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setCopyStatus(null);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const selectedAccount = useMemo(() => {
    if (!accounts.length) {
      return null;
    }
    return accounts.find((account) => account.accountKey === selectedAccountKey) || accounts[0];
  }, [accounts, selectedAccountKey]);

  const selectedSells = useMemo(
    () => (Array.isArray(selectedAccount?.sells) ? selectedAccount.sells : []),
    [selectedAccount]
  );
  const selectedBuys = useMemo(
    () => (Array.isArray(selectedAccount?.buys) ? selectedAccount.buys : []),
    [selectedAccount]
  );
  const selectedReserveSales = useMemo(() => collectReserveSales(selectedAccount), [selectedAccount]);
  const selectedTrades = useMemo(
    () => [...selectedSells, ...selectedReserveSales, ...selectedBuys],
    [selectedBuys, selectedReserveSales, selectedSells]
  );
  const completedForSelected = selectedTrades.reduce(
    (count, trade) => (completedTrades.has(trade.tradeKey) ? count + 1 : count),
    0
  );

  const copyValue = useCallback(
    async (value, label) => {
      if (!value || typeof copyToClipboard !== 'function') {
        return;
      }
      try {
        await copyToClipboard(value);
        setCopyStatus({ message: `${label || 'Value'} copied to clipboard.`, tone: 'success' });
      } catch (error) {
        console.error('Failed to copy value', error);
        setCopyStatus({ message: 'Unable to copy value. Copy manually if needed.', tone: 'error' });
      }
    },
    [copyToClipboard]
  );

  const handleCopySummary = useCallback(() => {
    if (!summaryText) {
      return;
    }
    copyValue(summaryText, 'Fractional share plan');
  }, [copyValue, summaryText]);

  const handleToggleTrade = useCallback((tradeKey) => {
    setCompletedTrades((prev) => {
      const next = new Set(prev);
      if (next.has(tradeKey)) {
        next.delete(tradeKey);
      } else {
        next.add(tradeKey);
      }
      return next;
    });
  }, []);

  const handleOverlayClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleOpenAccount = useCallback(() => {
    if (!selectedAccount || typeof onOpenAccount !== 'function') {
      return;
    }
    onOpenAccount(selectedAccount);
  }, [onOpenAccount, selectedAccount]);

  const renderTradeTable = ({ title, trades, emptyMessage, shareColumn, amountColumn, completeVerb }) => (
    <section className="invest-plan-section sell-fractional-trade-section">
      <div className="invest-plan-section__header">
        <h3 className="invest-plan-section__title">{title}</h3>
        <span className="sell-fractional-progress">{trades.length} trades</span>
      </div>
      {trades.length > 0 ? (
        <div className="invest-plan-purchases-wrapper sell-fractional-table-wrapper">
          <table className="invest-plan-purchases sell-fractional-table">
            <thead>
              <tr>
                <th scope="col" className="invest-plan-purchases__checkbox-header">
                  Done
                </th>
                <th scope="col">Symbol</th>
                <th scope="col">{shareColumn}</th>
                <th scope="col">Full position</th>
                <th scope="col">Price</th>
                <th scope="col">{amountColumn}</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                const isCompleted = completedTrades.has(trade.tradeKey);
                const rowClassName = isCompleted
                  ? 'invest-plan-purchases__row invest-plan-purchases__row--completed'
                  : 'invest-plan-purchases__row';
                return (
                  <tr key={trade.tradeKey} className={rowClassName}>
                    <td className="invest-plan-purchases__checkbox-cell">
                      <input
                        type="checkbox"
                        className="invest-plan-purchases__checkbox"
                        checked={isCompleted}
                        onChange={() => handleToggleTrade(trade.tradeKey)}
                        aria-label={`Mark ${trade.symbol} ${completeVerb} as ${
                          isCompleted ? 'not completed' : 'completed'
                        }`}
                      />
                    </td>
                    <th scope="row">
                      <div className="invest-plan-symbol">
                        <button
                          type="button"
                          className="invest-plan-symbol__ticker"
                          onClick={() => copyValue(trade.symbol, `${trade.symbol} symbol`)}
                          title="Copy symbol"
                          aria-label={`Copy ${trade.symbol} symbol`}
                        >
                          {trade.symbol}
                        </button>
                        {trade.displayDescription && (
                          <span className="invest-plan-symbol__name" title={trade.description || undefined}>
                            {trade.displayDescription}
                          </span>
                        )}
                      </div>
                    </th>
                    <td>
                      <button
                        type="button"
                        className="invest-plan-copy-button"
                        onClick={() => copyValue(trade.sharesCopy, `${trade.symbol} shares`)}
                      >
                        {trade.sharesCopy}
                      </button>
                    </td>
                    <td>{formatHoldingQuantity(trade.openQuantity)}</td>
                    <td>{formatTradePrice(trade.price, trade.currency)}</td>
                    <td>{formatAmount(trade.estimatedAmount, trade.currency)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="invest-plan-empty sell-fractional-empty">{emptyMessage}</p>
      )}
    </section>
  );

  return (
    <div className="invest-plan-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="invest-plan-dialog sell-fractional-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sell-fractional-title"
      >
        <header className="invest-plan-dialog__header">
          <div className="invest-plan-dialog__heading">
            <h2 id="sell-fractional-title" className="invest-plan-dialog__title">
              Resolve fractional shares
            </h2>
            <p className="invest-plan-dialog__account">
              {plan?.sellCount || 0} sells, {plan?.buyCount || 0} buys across {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}
              {plan?.reserveTradeCount > 0 ? `, plus ${plan.reserveTradeCount} reserve sells first` : ''}
            </p>
          </div>
          <button type="button" className="invest-plan-dialog__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>

        <div className="invest-plan-dialog__body">
          {copyStatus && (
            <div
              className={`invest-plan-dialog__status invest-plan-dialog__status--${copyStatus.tone}`}
              role="status"
            >
              {copyStatus.message}
            </div>
          )}

          {accounts.length > 0 ? (
            <>
              <section className="invest-plan-section sell-fractional-account-bar">
                <label className="sell-fractional-account-bar__label" htmlFor="sell-fractional-account">
                  Account
                </label>
                <div className="sell-fractional-account-bar__controls">
                  <select
                    id="sell-fractional-account"
                    className="sell-fractional-account-bar__select"
                    value={selectedAccount?.accountKey || ''}
                    onChange={(event) => setSelectedAccountKey(event.target.value)}
                  >
                    {accounts.map((account) => (
                      <option key={account.accountKey} value={account.accountKey}>
                        {account.accountLabel} ({account.sells.length} sells, {account.buys.length} buys)
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="invest-plan-footer__button"
                    onClick={handleOpenAccount}
                    disabled={!selectedAccount?.accountUrl}
                  >
                    Open account in Questrade
                  </button>
                </div>
                {selectedAccount?.accountNumber && (
                  <p className="sell-fractional-account-bar__meta">
                    Account number: <strong>{selectedAccount.accountNumber}</strong>
                  </p>
                )}
              </section>

              <div className="sell-fractional-overall-progress">
                <span>
                  {completedForSelected} of {selectedTrades.length} account trades complete
                </span>
                <span>{countAccountTrades(selectedAccount)} total for selected account</span>
              </div>

              {renderTradeTable({
                title: 'Sells',
                trades: selectedSells,
                emptyMessage: 'No fractional sells are needed for this account.',
                shareColumn: 'Sell shares',
                amountColumn: 'Est. proceeds',
                completeVerb: 'sell',
              })}

              {selectedAccount?.cashCoverage?.some((coverage) => coverage.shortfall > 0) && (
                <section className="invest-plan-section sell-fractional-coverage">
                  <div className="invest-plan-section__header">
                    <h3 className="invest-plan-section__title">Cash needed before buys</h3>
                  </div>
                  <div className="sell-fractional-coverage__list">
                    {selectedAccount.cashCoverage
                      .filter((coverage) => coverage.shortfall > 0)
                      .map((coverage) => (
                        <div key={coverage.currency} className="sell-fractional-coverage__item">
                          <div className="sell-fractional-coverage__summary">
                            <strong>{coverage.currency}</strong>
                            <span>
                              Buys need {formatAmount(coverage.buyCost, coverage.currency)}; cash plus sells cover{' '}
                              {formatAmount(coverage.available, coverage.currency)}.
                            </span>
                            <span>Shortfall: {formatAmount(coverage.shortfall, coverage.currency)}</span>
                          </div>
                          {coverage.reserveSales.length > 0 ? (
                            <div className="sell-fractional-coverage__reserve">
                              <p>Sell reserve holding first:</p>
                              <div className="sell-fractional-reserve-table">
                                {renderTradeTable({
                                  title: 'Reserve sells first',
                                  trades: coverage.reserveSales,
                                  emptyMessage: '',
                                  shareColumn: 'Sell shares',
                                  amountColumn: 'Est. proceeds',
                                  completeVerb: 'reserve sell',
                                })}
                              </div>
                            </div>
                          ) : (
                            <p className="sell-fractional-coverage__warning">
                              No VBIL, SGOV, or similar reserve holding was found in this account for{' '}
                              {coverage.currency}.
                            </p>
                          )}
                          {coverage.reserveShortfall > 0 && (
                            <p className="sell-fractional-coverage__warning">
                              Reserve sales still leave an estimated shortfall of{' '}
                              {formatAmount(coverage.reserveShortfall, coverage.currency)}.
                            </p>
                          )}
                        </div>
                      ))}
                  </div>
                </section>
              )}

              {renderTradeTable({
                title: 'Buys',
                trades: selectedBuys,
                emptyMessage: 'No fractional buys are needed for this account.',
                shareColumn: 'Buy shares',
                amountColumn: 'Est. cost',
                completeVerb: 'buy',
              })}
            </>
          ) : (
            <p className="invest-plan-empty">No fractional share positions were found.</p>
          )}
        </div>

        <footer className="invest-plan-dialog__footer">
          <button type="button" className="invest-plan-footer__button" onClick={handleCopySummary}>
            Copy plan summary
          </button>
          <button type="button" className="invest-plan-footer__button invest-plan-footer__button--primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

const tradeShape = PropTypes.shape({
  tradeKey: PropTypes.string.isRequired,
  side: PropTypes.string,
  scope: PropTypes.string,
  symbol: PropTypes.string.isRequired,
  description: PropTypes.string,
  displayDescription: PropTypes.string,
  currency: PropTypes.string,
  openQuantity: PropTypes.number,
  targetQuantity: PropTypes.number,
  shares: PropTypes.number,
  sharesToSell: PropTypes.number,
  sharesToBuy: PropTypes.number,
  sharesCopy: PropTypes.string,
  sharePrecision: PropTypes.number,
  price: PropTypes.number,
  estimatedAmount: PropTypes.number,
  estimatedProceeds: PropTypes.number,
  estimatedCost: PropTypes.number,
});

const coverageShape = PropTypes.shape({
  currency: PropTypes.string.isRequired,
  cash: PropTypes.number,
  sellProceeds: PropTypes.number,
  buyCost: PropTypes.number,
  available: PropTypes.number,
  shortfall: PropTypes.number,
  reserveSales: PropTypes.arrayOf(tradeShape),
  reserveShortfall: PropTypes.number,
});

SellFractionalSharesDialog.propTypes = {
  plan: PropTypes.shape({
    sellCount: PropTypes.number,
    buyCount: PropTypes.number,
    reserveTradeCount: PropTypes.number,
    tradeCount: PropTypes.number,
    fractionalTradeCount: PropTypes.number,
    accounts: PropTypes.arrayOf(
      PropTypes.shape({
        accountKey: PropTypes.string.isRequired,
        accountLabel: PropTypes.string.isRequired,
        accountNumber: PropTypes.string,
        accountUrl: PropTypes.string,
        sells: PropTypes.arrayOf(tradeShape).isRequired,
        buys: PropTypes.arrayOf(tradeShape).isRequired,
        cashCoverage: PropTypes.arrayOf(coverageShape),
      })
    ),
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  copyToClipboard: PropTypes.func,
  onOpenAccount: PropTypes.func,
};

SellFractionalSharesDialog.defaultProps = {
  copyToClipboard: null,
  onOpenAccount: null,
};
