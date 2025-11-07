import { useEffect, useMemo } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';

const MINIMUM_DISPLAY_AMOUNT = 5;

export default function CashBreakdownDialog({ currency, total, entries, onClose, onSelectAccount }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const percentOptions = useMemo(
    () => ({ minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    []
  );

  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';

  const sortedEntries = useMemo(() => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.slice();
  }, [entries]);

  const handleAccountClick = (accountId, event) => {
    if (!onSelectAccount) {
      return;
    }
    onSelectAccount(accountId, event);
  };

  return (
    <div className="cash-breakdown-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="cash-breakdown-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-breakdown-title"
      >
        <header className="cash-breakdown-dialog__header">
          <div className="cash-breakdown-dialog__heading">
            <h2 id="cash-breakdown-title">Cash in {normalizedCurrency}</h2>
            <p className="cash-breakdown-dialog__subtitle">
              Showing accounts with at least {formatMoney(MINIMUM_DISPLAY_AMOUNT)} in {normalizedCurrency}.
            </p>
            <p className="cash-breakdown-dialog__hint">Click an account to open it.</p>
          </div>
          <button
            type="button"
            className="cash-breakdown-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="cash-breakdown-dialog__body">
          <ul className="cash-breakdown-list">
            {sortedEntries.map((entry) => {
              const percentLabel = `${formatNumber(entry.percent, percentOptions)}%`;
              return (
                <li key={entry.accountId} className="cash-breakdown-list__item">
                  <button
                    type="button"
                    className="cash-breakdown-list__entry"
                    onClick={(event) => handleAccountClick(entry.accountId, event)}
                  >
                    <div className="cash-breakdown-list__info">
                      <span className="cash-breakdown-list__name">{entry.name}</span>
                      {entry.subtitle && (
                        <span className="cash-breakdown-list__subtitle">{entry.subtitle}</span>
                      )}
                    </div>
                    <div className="cash-breakdown-list__values">
                      <span className="cash-breakdown-list__amount">{formatMoney(entry.amount)}</span>
                      <span className="cash-breakdown-list__percent">{percentLabel}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="cash-breakdown-dialog__footer">
          <span className="cash-breakdown-dialog__total-label">Total cash</span>
          <span className="cash-breakdown-dialog__total-value">{formatMoney(total)}</span>
        </footer>
      </div>
    </div>
  );
}

const entryShape = PropTypes.shape({
  accountId: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  amount: PropTypes.number.isRequired,
  percent: PropTypes.number.isRequired,
});

CashBreakdownDialog.propTypes = {
  currency: PropTypes.string.isRequired,
  total: PropTypes.number.isRequired,
  entries: PropTypes.arrayOf(entryShape).isRequired,
  onClose: PropTypes.func.isRequired,
  onSelectAccount: PropTypes.func,
};

CashBreakdownDialog.defaultProps = {
  onSelectAccount: null,
};
