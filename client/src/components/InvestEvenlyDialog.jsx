import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';

function formatCopyNumber(value, decimals = 2, { trimTrailingZeros = false } = {}) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const precision = Math.max(0, Math.min(6, decimals));
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  const fixed = normalized.toFixed(precision);
  if (!trimTrailingZeros || precision === 0) {
    return fixed;
  }
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function formatCurrencyLabel(value, currency) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const code = currency || 'CAD';
  return `${formatMoney(value)} ${code}`;
}

function formatWeight(weight) {
  if (!Number.isFinite(weight)) {
    return '—';
  }
  return `${formatNumber(weight * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function formatShareDisplay(shares, precision) {
  if (!Number.isFinite(shares) || shares <= 0) {
    return '—';
  }
  const digits = Math.max(0, Number.isFinite(precision) ? precision : 0);
  return formatNumber(shares, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default function InvestEvenlyDialog({ plan, onClose, copyToClipboard }) {
  const [copyStatus, setCopyStatus] = useState(null);

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
    if (!copyStatus) {
      return undefined;
    }
    if (typeof window === 'undefined') {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setCopyStatus(null);
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

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
    if (!plan?.summaryText) {
      return;
    }
    copyValue(plan.summaryText, 'Plan summary');
  }, [plan?.summaryText, copyValue]);

  const purchaseRows = useMemo(() => {
    if (!plan?.purchases?.length) {
      return [];
    }
    return plan.purchases.map((purchase) => {
      const amountCopy = Number.isFinite(purchase.amount) && purchase.amount > 0
        ? formatCopyNumber(purchase.amount, 2)
        : null;
      const shareCopy = Number.isFinite(purchase.shares) && purchase.shares > 0
        ? formatCopyNumber(purchase.shares, purchase.sharePrecision ?? 0, { trimTrailingZeros: true })
        : null;
      const weightPercent = Number.isFinite(purchase.weight) ? purchase.weight : null;
      return {
        ...purchase,
        amountCopy,
        shareCopy,
        weightPercent,
      };
    });
  }, [plan?.purchases]);

  const conversionRows = useMemo(() => {
    if (!plan?.conversions?.length) {
      return [];
    }
    return plan.conversions.map((conversion) => {
      const spendCurrency = conversion.currency || (conversion.type === 'CAD_TO_USD' ? 'CAD' : 'USD');
      const spendAmount = Number.isFinite(conversion.spendAmount)
        ? conversion.spendAmount
        : spendCurrency === 'CAD'
        ? conversion.cadAmount
        : conversion.usdAmount;
      const amountCopy = Number.isFinite(spendAmount) && spendAmount > 0
        ? formatCopyNumber(spendAmount, 2)
        : null;
      const shareCopy = Number.isFinite(conversion.shares) && conversion.shares > 0
        ? formatCopyNumber(conversion.shares, conversion.sharePrecision ?? 0, { trimTrailingZeros: true })
        : null;
      return {
        ...conversion,
        spendCurrency,
        spendAmount,
        amountCopy,
        shareCopy,
      };
    });
  }, [plan?.conversions]);

  const totals = plan?.totals || {};
  const cash = plan?.cash || {};
  const accountLabel = plan?.accountLabel || plan?.accountName || plan?.accountNumber || null;

  return (
    <div className="invest-plan-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="invest-plan-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invest-plan-title"
      >
        <header className="invest-plan-dialog__header">
          <div className="invest-plan-dialog__heading">
            <h2 id="invest-plan-title" className="invest-plan-dialog__title">
              Invest cash evenly
            </h2>
            {accountLabel && <p className="invest-plan-dialog__account">{accountLabel}</p>}
            {plan?.accountUrl && (
              <a
                className="invest-plan-dialog__account-link"
                href={plan.accountUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open account in Questrade
              </a>
            )}
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

          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Available cash</h3>
            <dl className="invest-plan-cash">
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">CAD</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(cash.cad, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">USD</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(cash.usd, 'USD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">Total (CAD)</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(cash.totalCad, plan?.baseCurrency || 'CAD')}</dd>
              </div>
            </dl>
          </section>

          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Planned purchases</h3>
            {purchaseRows.length ? (
              <div className="invest-plan-purchases-wrapper">
                <table className="invest-plan-purchases">
                  <thead>
                    <tr>
                      <th scope="col">Symbol</th>
                      <th scope="col">Allocation</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Shares</th>
                      <th scope="col">Price</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseRows.map((purchase) => {
                      const hasAmountCopy = Boolean(purchase.amountCopy);
                      const hasShareCopy = Boolean(purchase.shareCopy);
                      const priceLabel = Number.isFinite(purchase.price)
                        ? `${formatMoney(purchase.price)} ${purchase.currency}`
                        : '—';
                      return (
                        <tr key={purchase.symbol}>
                          <th scope="row">
                            <div className="invest-plan-symbol">
                              <span className="invest-plan-symbol__ticker">{purchase.symbol}</span>
                              {purchase.description && (
                                <span className="invest-plan-symbol__name">{purchase.description}</span>
                              )}
                            </div>
                          </th>
                          <td>{formatWeight(purchase.weightPercent)}</td>
                          <td>
                            {hasAmountCopy ? (
                              <button
                                type="button"
                                className="invest-plan-copy-button"
                                onClick={() => copyValue(purchase.amountCopy, `${purchase.symbol} amount`)}
                              >
                                {formatCurrencyLabel(purchase.amount, purchase.currency)}
                              </button>
                            ) : (
                              <span className="invest-plan-copy-button invest-plan-copy-button--disabled">
                                {formatCurrencyLabel(purchase.amount, purchase.currency)}
                              </span>
                            )}
                          </td>
                          <td>
                            {hasShareCopy ? (
                              <button
                                type="button"
                                className="invest-plan-copy-button"
                                onClick={() => copyValue(purchase.shareCopy, `${purchase.symbol} shares`)}
                              >
                                {formatShareDisplay(purchase.shares, purchase.sharePrecision)}
                              </button>
                            ) : (
                              <span className="invest-plan-copy-button invest-plan-copy-button--disabled">
                                {formatShareDisplay(purchase.shares, purchase.sharePrecision)}
                              </span>
                            )}
                          </td>
                          <td>{priceLabel}</td>
                          <td>{purchase.note || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="invest-plan-empty">No eligible positions were found.</p>
            )}
          </section>

          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Totals</h3>
            <dl className="invest-plan-cash">
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">CAD purchases</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(totals.cadNeeded, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">USD purchases</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(totals.usdNeeded, 'USD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">Remaining CAD</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(totals.cadRemaining, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">Remaining USD</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(totals.usdRemaining, 'USD')}</dd>
              </div>
            </dl>
          </section>

          {conversionRows.length > 0 && (
            <section className="invest-plan-section">
              <h3 className="invest-plan-section__title">FX conversions</h3>
              <ul className="invest-plan-conversions">
                {conversionRows.map((conversion) => {
                  const amountLabel = formatCurrencyLabel(conversion.spendAmount, conversion.spendCurrency);
                  const targetLabel = conversion.targetCurrency
                    ? formatCurrencyLabel(
                        conversion.targetCurrency === 'CAD' ? conversion.cadAmount : conversion.usdAmount,
                        conversion.targetCurrency
                      )
                    : null;
                  const directionLabel =
                    conversion.type === 'CAD_TO_USD' ? 'Convert CAD → USD' : 'Convert USD → CAD';
                  return (
                    <li
                      key={`${conversion.type}-${conversion.symbol}`}
                      className="invest-plan-conversions__item"
                    >
                      <div className="invest-plan-conversion__header">
                        <div className="invest-plan-symbol">
                          <span className="invest-plan-symbol__ticker">{conversion.symbol}</span>
                          {conversion.description && (
                            <span className="invest-plan-symbol__name">{conversion.description}</span>
                          )}
                        </div>
                        <span className="invest-plan-conversion__direction">{directionLabel}</span>
                      </div>
                      <div className="invest-plan-conversion__actions">
                        {conversion.amountCopy ? (
                          <button
                            type="button"
                            className="invest-plan-copy-button"
                            onClick={() => copyValue(conversion.amountCopy, `${conversion.symbol} amount`)}
                          >
                            Spend {amountLabel}
                          </button>
                        ) : (
                          <span className="invest-plan-copy-button invest-plan-copy-button--disabled">
                            Spend {amountLabel}
                          </span>
                        )}
                        {conversion.shareCopy && (
                          <button
                            type="button"
                            className="invest-plan-copy-button"
                            onClick={() => copyValue(conversion.shareCopy, `${conversion.symbol} shares`)}
                          >
                            Buy {formatShareDisplay(conversion.shares, conversion.sharePrecision)} shares
                          </button>
                        )}
                      </div>
                      <div className="invest-plan-conversion__details">
                        {targetLabel && <span className="invest-plan-conversion__detail">Target: {targetLabel}</span>}
                        {conversion.sharePrice && (
                          <span className="invest-plan-conversion__detail">
                            Price: {formatCurrencyLabel(conversion.sharePrice, conversion.spendCurrency)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
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

const purchaseShape = PropTypes.shape({
  symbol: PropTypes.string.isRequired,
  description: PropTypes.string,
  currency: PropTypes.string,
  amount: PropTypes.number,
  targetAmount: PropTypes.number,
  shares: PropTypes.number,
  sharePrecision: PropTypes.number,
  price: PropTypes.number,
  note: PropTypes.string,
  weight: PropTypes.number,
});

const conversionShape = PropTypes.shape({
  type: PropTypes.oneOf(['CAD_TO_USD', 'USD_TO_CAD']).isRequired,
  symbol: PropTypes.string.isRequired,
  description: PropTypes.string,
  cadAmount: PropTypes.number,
  usdAmount: PropTypes.number,
  sharePrice: PropTypes.number,
  shares: PropTypes.number,
  sharePrecision: PropTypes.number,
  spendAmount: PropTypes.number,
  currency: PropTypes.string,
  targetCurrency: PropTypes.string,
});

InvestEvenlyDialog.propTypes = {
  plan: PropTypes.shape({
    summaryText: PropTypes.string,
    baseCurrency: PropTypes.string,
    cash: PropTypes.shape({
      cad: PropTypes.number,
      usd: PropTypes.number,
      totalCad: PropTypes.number,
    }),
    purchases: PropTypes.arrayOf(purchaseShape),
    totals: PropTypes.shape({
      cadNeeded: PropTypes.number,
      usdNeeded: PropTypes.number,
      cadRemaining: PropTypes.number,
      usdRemaining: PropTypes.number,
    }),
    conversions: PropTypes.arrayOf(conversionShape),
    accountName: PropTypes.string,
    accountNumber: PropTypes.string,
    accountLabel: PropTypes.string,
    accountUrl: PropTypes.string,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  copyToClipboard: PropTypes.func,
};

InvestEvenlyDialog.defaultProps = {
  copyToClipboard: null,
};
