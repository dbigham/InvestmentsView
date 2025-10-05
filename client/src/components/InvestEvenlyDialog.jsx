import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';

const DESCRIPTION_CHAR_LIMIT = 21;
const JOURNALLING_URL = 'https://my.questrade.com/clients/en/my_requests/journalling.aspx';

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

function truncateDescription(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value);
  if (normalized.length <= DESCRIPTION_CHAR_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, DESCRIPTION_CHAR_LIMIT).trimEnd()}...`;
}

export default function InvestEvenlyDialog({ plan, onClose, copyToClipboard, onAdjustPlan }) {
  const [copyStatus, setCopyStatus] = useState(null);
  const [completedPurchases, setCompletedPurchases] = useState(() => new Set());

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

  useEffect(() => {
    setCompletedPurchases(new Set());
  }, [plan?.purchases]);

  const handleTogglePurchase = useCallback((rowKey) => {
    setCompletedPurchases((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }, []);

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
      const rowKey = `${purchase.symbol || ''}|${purchase.currency || ''}`;
      const amountCopy = Number.isFinite(purchase.amount) && purchase.amount > 0
        ? formatCopyNumber(purchase.amount, 2)
        : null;
      const shareCopy = Number.isFinite(purchase.shares) && purchase.shares > 0
        ? formatCopyNumber(purchase.shares, purchase.sharePrecision ?? 0, { trimTrailingZeros: true })
        : null;
      const weightPercent = Number.isFinite(purchase.weight) ? purchase.weight : null;
      const displayDescription = truncateDescription(purchase.description);
      return {
        ...purchase,
        amountCopy,
        shareCopy,
        weightPercent,
        rowKey,
        displayDescription,
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
      const targetAmount = Number.isFinite(conversion.actualReceiveAmount)
        ? conversion.actualReceiveAmount
        : conversion.targetCurrency === 'CAD'
        ? conversion.cadAmount
        : conversion.usdAmount;
      const amountCopy = Number.isFinite(spendAmount) && spendAmount > 0
        ? formatCopyNumber(spendAmount, 2)
        : null;
      const shareCopy = Number.isFinite(conversion.shares) && conversion.shares > 0
        ? formatCopyNumber(conversion.shares, conversion.sharePrecision ?? 0, { trimTrailingZeros: true })
        : null;
      const displayDescription = truncateDescription(conversion.description);
      return {
        ...conversion,
        spendCurrency,
        spendAmount,
        targetAmount,
        amountCopy,
        shareCopy,
        displayDescription,
      };
    });
  }, [plan?.conversions]);

  const totals = plan?.totals || {};
  const cash = plan?.cash || {};
  const accountLabel = plan?.accountLabel || plan?.accountName || plan?.accountNumber || null;
  const accountNumber = plan?.accountNumber ? String(plan.accountNumber) : null;
  const skipCadPurchases = Boolean(plan?.skipCadPurchases);
  const skipUsdPurchases = Boolean(plan?.skipUsdPurchases);
  const canToggleCadPurchases =
    Boolean(onAdjustPlan) && (plan?.supportsCadPurchaseToggle || skipCadPurchases);
  const canToggleUsdPurchases =
    Boolean(onAdjustPlan) && (plan?.supportsUsdPurchaseToggle || skipUsdPurchases);
  const toggleGroupVisible = canToggleCadPurchases || canToggleUsdPurchases;

  const handleToggleCadPurchases = useCallback(() => {
    if (typeof onAdjustPlan !== 'function') {
      return;
    }
    onAdjustPlan({ skipCadPurchases: !skipCadPurchases, skipUsdPurchases: false });
  }, [onAdjustPlan, skipCadPurchases]);

  const handleToggleUsdPurchases = useCallback(() => {
    if (typeof onAdjustPlan !== 'function') {
      return;
    }
    onAdjustPlan({ skipUsdPurchases: !skipUsdPurchases, skipCadPurchases: false });
  }, [onAdjustPlan, skipUsdPurchases]);

  const cadToggleClassName = skipCadPurchases
    ? 'invest-plan-toggle-button invest-plan-toggle-button--active'
    : 'invest-plan-toggle-button';
  const usdToggleClassName = skipUsdPurchases
    ? 'invest-plan-toggle-button invest-plan-toggle-button--active'
    : 'invest-plan-toggle-button';

  const normalizedInvestableCurrency = cash?.investableCurrency
    ? String(cash.investableCurrency).trim().toUpperCase()
    : null;
  const showInvestableRow =
    (skipCadPurchases || skipUsdPurchases) && Number.isFinite(cash?.investableCad);
  const investableRowLabel = normalizedInvestableCurrency
    ? `Investable ${normalizedInvestableCurrency} funds (CAD)`
    : 'Investable funds (CAD)';

  const activeToggleNote = skipCadPurchases
    ? 'CAD purchases are hidden. USD cash is allocated across USD positions.'
    : skipUsdPurchases
    ? 'USD purchases are hidden. CAD cash is allocated across CAD positions.'
    : null;

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
              {showInvestableRow && (
                <div className="invest-plan-cash__row">
                  <dt className="invest-plan-cash__label">{investableRowLabel}</dt>
                  <dd className="invest-plan-cash__value">
                    {formatCurrencyLabel(cash.investableCad, plan?.baseCurrency || 'CAD')}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {conversionRows.length > 0 && (
            <section className="invest-plan-section">
              <h3 className="invest-plan-section__title">FX conversions</h3>
              <div className="invest-plan-conversions__extras">
                <a
                  className="invest-plan-conversions__journal-link"
                  href={JOURNALLING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Journal shares in Questrade
                </a>
                {accountNumber && (
                  <span className="invest-plan-conversions__account-number">
                    Account number: <strong>{accountNumber}</strong>
                  </span>
                )}
              </div>
              <ul className="invest-plan-conversions">
                {conversionRows.map((conversion) => {
                  const amountLabel = formatCurrencyLabel(conversion.spendAmount, conversion.spendCurrency);
                  const targetLabel =
                    conversion.targetCurrency && Number.isFinite(conversion.targetAmount)
                      ? formatCurrencyLabel(conversion.targetAmount, conversion.targetCurrency)
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
                          {conversion.displayDescription && (
                            <span
                              className="invest-plan-symbol__name"
                              title={conversion.description || undefined}
                            >
                              {conversion.displayDescription}
                            </span>
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

          <section className="invest-plan-section">
            <div className="invest-plan-section__header">
              <h3 className="invest-plan-section__title">Planned purchases</h3>
              {toggleGroupVisible && (
                <div className="invest-plan-toggle-group">
                  {canToggleCadPurchases && (
                    <button
                      type="button"
                      className={cadToggleClassName}
                      onClick={handleToggleCadPurchases}
                    >
                      {skipCadPurchases ? 'Include CAD purchases' : 'CAD purchases already made'}
                    </button>
                  )}
                  {canToggleUsdPurchases && (
                    <button
                      type="button"
                      className={usdToggleClassName}
                      onClick={handleToggleUsdPurchases}
                    >
                      {skipUsdPurchases ? 'Include USD purchases' : 'USD purchases already made'}
                    </button>
                  )}
                </div>
              )}
            </div>
            {activeToggleNote && <p className="invest-plan-toggle-note">{activeToggleNote}</p>}
            {purchaseRows.length ? (
              <div className="invest-plan-purchases-wrapper">
                <table className="invest-plan-purchases">
                  <thead>
                    <tr>
                      <th scope="col" className="invest-plan-purchases__checkbox-header">Done</th>
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
                      const isCompleted = completedPurchases.has(purchase.rowKey);
                      const rowClassName = isCompleted
                        ? 'invest-plan-purchases__row invest-plan-purchases__row--completed'
                        : 'invest-plan-purchases__row';
                      return (
                        <tr key={purchase.rowKey} className={rowClassName}>
                          <td className="invest-plan-purchases__checkbox-cell">
                            <input
                              type="checkbox"
                              className="invest-plan-purchases__checkbox"
                              checked={isCompleted}
                              onChange={() => handleTogglePurchase(purchase.rowKey)}
                              aria-label={`Mark ${purchase.symbol} purchase as ${
                                isCompleted ? 'not completed' : 'completed'
                              }`}
                            />
                          </td>
                          <th scope="row">
                            <div className="invest-plan-symbol">
                              <span className="invest-plan-symbol__ticker">{purchase.symbol}</span>
                              {purchase.displayDescription && (
                                <span
                                  className="invest-plan-symbol__name"
                                  title={purchase.description || undefined}
                                >
                                  {purchase.displayDescription}
                                </span>
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
            </dl>
          </section>
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
  actualSpendAmount: PropTypes.number,
  actualReceiveAmount: PropTypes.number,
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
      investableCad: PropTypes.number,
      investableCurrency: PropTypes.string,
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
    accountNumber: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    accountLabel: PropTypes.string,
    accountUrl: PropTypes.string,
    skipCadPurchases: PropTypes.bool,
    skipUsdPurchases: PropTypes.bool,
    supportsCadPurchaseToggle: PropTypes.bool,
    supportsUsdPurchaseToggle: PropTypes.bool,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  copyToClipboard: PropTypes.func,
  onAdjustPlan: PropTypes.func,
};

InvestEvenlyDialog.defaultProps = {
  copyToClipboard: null,
  onAdjustPlan: null,
};
