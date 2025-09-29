import { useEffect, useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  formatMoney,
  formatDateTime,
  formatSignedMoney,
  formatSignedPercent,
  classifyPnL,
} from '../utils/formatters';

function formatAccountCount(covered, total) {
  if (!total && !covered) {
    return '0 accounts';
  }
  const safeTotal = typeof total === 'number' && Number.isFinite(total) ? total : covered;
  const safeCovered = typeof covered === 'number' && Number.isFinite(covered) ? covered : 0;
  const plural = safeTotal === 1 ? 'account' : 'accounts';
  if (safeTotal === safeCovered) {
    return `${safeCovered} ${plural}`;
  }
  return `${safeCovered} of ${safeTotal} ${plural}`;
}

export default function BeneficiariesDialog({
  totals,
  onClose,
  baseCurrency,
  isFilteredView,
  missingAccounts,
  asOf,
}) {
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

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const grandTotal = useMemo(() => {
    return totals.reduce((acc, entry) => acc + (entry.total || 0), 0);
  }, [totals]);

  const percentOptions = useMemo(
    () => ({ minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    []
  );

  const formatPercentChange = (pnlValue, totalValue) => {
    if (typeof pnlValue !== 'number' || Number.isNaN(pnlValue)) {
      return null;
    }
    if (typeof totalValue !== 'number' || totalValue === 0) {
      return null;
    }
    const percent = (pnlValue / totalValue) * 100;
    if (!Number.isFinite(percent)) {
      return null;
    }
    return formatSignedPercent(percent, percentOptions);
  };

  const missingBeneficiaries = useMemo(() => {
    if (!missingAccounts || missingAccounts.length === 0) {
      return [];
    }
    const names = new Set();
    missingAccounts.forEach((account) => {
      if (account?.beneficiary) {
        names.add(account.beneficiary);
      }
    });
    return Array.from(names);
  }, [missingAccounts]);

  const hasMissing = missingBeneficiaries.length > 0;

  const noticeMessage = useMemo(() => {
    if (!hasMissing) {
      return null;
    }
    if (isFilteredView) {
      return 'Totals reflect only the currently selected account(s). Choose “All accounts” to see the full household.';
    }
    if (missingBeneficiaries.length) {
      return `No balance data was returned for: ${missingBeneficiaries.join(', ')}. Try refreshing to include them.`;
    }
    return 'Some accounts did not return balance data in the latest refresh. Try refreshing to include them.';
  }, [hasMissing, isFilteredView, missingBeneficiaries]);

  return (
    <div className="beneficiaries-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="beneficiaries-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="beneficiaries-dialog-title"
      >
        <header className="beneficiaries-dialog__header">
          <div className="beneficiaries-dialog__heading">
            <h2 id="beneficiaries-dialog-title">Beneficiaries</h2>
            <p className="beneficiaries-dialog__subtitle">Totals in {baseCurrency}</p>
            {asOf && <p className="beneficiaries-dialog__timestamp">As of {formatDateTime(asOf)}</p>}
          </div>
          <button type="button" className="beneficiaries-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {totals.length ? (
          <div className="beneficiaries-dialog__body">
            <ul className="beneficiaries-list">
              {totals.map((entry) => {
                const todayTone = classifyPnL(entry.dayPnl);
                const openTone = classifyPnL(entry.openPnl);
                const todayFormatted = formatSignedMoney(entry.dayPnl);
                const openFormatted = formatSignedMoney(entry.openPnl);
                const todayPercent = formatPercentChange(entry.dayPnl, entry.total);
                const openPercent = formatPercentChange(entry.openPnl, entry.total);

                return (
                  <li key={entry.beneficiary} className="beneficiaries-list__item">
                    <div className="beneficiaries-list__info">
                      <span className="beneficiaries-list__name">{entry.beneficiary}</span>
                      <span className="beneficiaries-list__accounts">
                        {formatAccountCount(entry.accountCount, entry.totalAccounts)}
                      </span>
                    </div>
                    <div className="beneficiaries-list__metrics">
                      <span className="beneficiaries-list__value">{formatMoney(entry.total)}</span>
                      <div className="beneficiaries-list__pnl-group">
                        <div className="beneficiaries-list__pnl-row">
                          <span className="beneficiaries-list__pnl-label">Today's P&amp;L</span>
                          <span
                            className={`beneficiaries-list__pnl-value beneficiaries-list__pnl-value--${todayTone}`}
                          >
                            {todayFormatted}
                          </span>
                          {todayPercent && (
                            <span className="beneficiaries-list__pnl-extra">({todayPercent})</span>
                          )}
                        </div>
                        <div className="beneficiaries-list__pnl-row">
                          <span className="beneficiaries-list__pnl-label">Open P&amp;L</span>
                          <span
                            className={`beneficiaries-list__pnl-value beneficiaries-list__pnl-value--${openTone}`}
                          >
                            {openFormatted}
                          </span>
                          {openPercent && (
                            <span className="beneficiaries-list__pnl-extra">({openPercent})</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="beneficiaries-dialog__footer">
              <span className="beneficiaries-dialog__total-label">Household total</span>
              <span className="beneficiaries-dialog__total-value">{formatMoney(grandTotal)}</span>
            </div>

            {noticeMessage && (
              <p className="beneficiaries-dialog__notice" role="note">
                {noticeMessage}
              </p>
            )}
          </div>
        ) : (
          <div className="beneficiaries-dialog__empty">
            No beneficiary totals are available yet. Refresh to pull the latest balances.
          </div>
        )}
      </div>
    </div>
  );
}

const accountShape = PropTypes.shape({
  id: PropTypes.string.isRequired,
  number: PropTypes.string,
  displayName: PropTypes.string,
  beneficiary: PropTypes.string,
});

BeneficiariesDialog.propTypes = {
  totals: PropTypes.arrayOf(
    PropTypes.shape({
      beneficiary: PropTypes.string.isRequired,
      total: PropTypes.number.isRequired,
      dayPnl: PropTypes.number.isRequired,
      openPnl: PropTypes.number.isRequired,
      accountCount: PropTypes.number.isRequired,
      totalAccounts: PropTypes.number.isRequired,
    })
  ).isRequired,
  onClose: PropTypes.func.isRequired,
  baseCurrency: PropTypes.string.isRequired,
  isFilteredView: PropTypes.bool,
  missingAccounts: PropTypes.arrayOf(accountShape),
  asOf: PropTypes.string,
};

BeneficiariesDialog.defaultProps = {
  isFilteredView: false,
  missingAccounts: [],
  asOf: null,
};
