import { useEffect, useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  classifyPnL,
  formatDate,
  formatDateTime,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

const PERIOD_ORDER = ['ten_year', 'five_year', 'twelve_month', 'six_month', 'one_month'];
const PERIOD_LABELS = {
  ten_year: '10 year return',
  five_year: '5 year return',
  twelve_month: '12 month return',
  six_month: '6 month return',
  one_month: '1 month return',
};

export default function AnnualizedReturnDialog({
  annualizedRate,
  breakdown,
  asOf,
  incomplete,
  startDate,
  onClose,
}) {
  const resolveRateTone = (rate) => {
    if (typeof rate !== 'number' || Number.isNaN(rate)) {
      return 'neutral';
    }
    if (rate > 0) {
      return 'positive';
    }
    if (rate < 0) {
      return 'negative';
    }
    return 'neutral';
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const orderedBreakdown = useMemo(() => {
    if (!Array.isArray(breakdown)) {
      return [];
    }
    const normalized = breakdown
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const periodKey = typeof entry.period === 'string' ? entry.period : null;
        const months = typeof entry.months === 'number' && Number.isFinite(entry.months) ? entry.months : null;
        return {
          period: periodKey,
          label: periodKey && PERIOD_LABELS[periodKey] ? PERIOD_LABELS[periodKey] : null,
          months,
          startDate: entry.startDate || null,
          totalReturnCad: typeof entry.totalReturnCad === 'number' && Number.isFinite(entry.totalReturnCad)
            ? entry.totalReturnCad
            : entry.totalReturnCad === 0
              ? 0
              : null,
          annualizedRate:
            typeof entry.annualizedRate === 'number' && Number.isFinite(entry.annualizedRate)
              ? entry.annualizedRate
              : null,
        };
      })
      .filter(Boolean);

    const lookup = new Map();
    normalized.forEach((entry) => {
      if (entry.period) {
        lookup.set(entry.period, entry);
      }
    });

    const ordered = PERIOD_ORDER.map((key) => lookup.get(key)).filter(Boolean);
    const usedKeys = new Set(ordered.map((entry) => entry.period).filter(Boolean));

    const remaining = normalized.filter((entry) => {
      if (!entry.period) {
        return true;
      }
      return !usedKeys.has(entry.period);
    });
    return ordered.concat(remaining);
  }, [breakdown]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const annualizedPercent = Number.isFinite(annualizedRate)
    ? formatSignedPercent(annualizedRate * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
  const annualizedTone = resolveRateTone(annualizedRate);
  const hasBreakdown = orderedBreakdown.length > 0;
  const sinceDisplay = startDate ? `Since ${formatDate(startDate)}` : null;

  return (
    <div className="return-breakdown-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="return-breakdown-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-breakdown-title"
      >
        <header className="return-breakdown-dialog__header">
          <div className="return-breakdown-dialog__heading">
            <h2 id="return-breakdown-title">Return breakdown</h2>
            {asOf && <p className="return-breakdown-dialog__timestamp">As of {formatDateTime(asOf)}</p>}
            {sinceDisplay && <p className="return-breakdown-dialog__subtitle">{sinceDisplay}</p>}
            {incomplete && (
              <p className="return-breakdown-dialog__notice">
                Cash flow history is incomplete. Rates may be understated.
              </p>
            )}
          </div>
          <button type="button" className="return-breakdown-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="return-breakdown-dialog__body">
          <dl className="return-breakdown-list">
            <div className="return-breakdown-list__row">
              <dt className="return-breakdown-list__label">Annualized return</dt>
              <dd className="return-breakdown-list__values">
                <span className={`return-breakdown-list__percent return-breakdown-list__percent--${annualizedTone}`}>
                  {annualizedPercent}
                </span>
              </dd>
            </div>

            {hasBreakdown ? (
              orderedBreakdown.map((entry) => {
                const tone = classifyPnL(entry.totalReturnCad);
                const moneyDisplay = formatSignedMoney(entry.totalReturnCad);
                const percentDisplay = entry.annualizedRate === null
                  ? '—'
                  : formatSignedPercent(entry.annualizedRate * 100, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    });
                const percentTone = resolveRateTone(entry.annualizedRate);
                const label = entry.label || 'Return';
                const since = entry.startDate ? formatDate(entry.startDate) : null;

                return (
                  <div key={`${entry.period || label}-${entry.startDate || 'na'}`} className="return-breakdown-list__row">
                    <dt className="return-breakdown-list__label">
                      <span>{label}</span>
                      {since && <span className="return-breakdown-list__since">Since {since}</span>}
                    </dt>
                    <dd className="return-breakdown-list__values">
                      <span className={`return-breakdown-list__value return-breakdown-list__value--${tone}`}>
                        {moneyDisplay}
                      </span>
                      <span className={`return-breakdown-list__percent return-breakdown-list__percent--${percentTone}`}>
                        {percentDisplay}
                      </span>
                    </dd>
                  </div>
                );
              })
            ) : (
              <div className="return-breakdown-list__row return-breakdown-list__row--empty">
                <dt className="return-breakdown-list__label">Additional periods</dt>
                <dd className="return-breakdown-list__values">Not enough history yet.</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  );
}

AnnualizedReturnDialog.propTypes = {
  annualizedRate: PropTypes.number,
  breakdown: PropTypes.arrayOf(
    PropTypes.shape({
      period: PropTypes.string,
      months: PropTypes.number,
      startDate: PropTypes.string,
      totalReturnCad: PropTypes.number,
      annualizedRate: PropTypes.number,
    })
  ),
  asOf: PropTypes.string,
  incomplete: PropTypes.bool,
  startDate: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};

AnnualizedReturnDialog.defaultProps = {
  annualizedRate: null,
  breakdown: [],
  asOf: null,
  incomplete: false,
  startDate: null,
};
