import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function formatPercentInput(value) {
  if (!Number.isFinite(value)) {
    return '';
  }
  return value.toFixed(2);
}

function formatPercentLabel(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return `${formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function formatCurrencyLabel(value, currency) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return `${formatMoney(value)} ${currency}`;
}

function formatSignedCurrencyLabel(value, currency) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const formatted = formatMoney(Math.abs(value));
  if (value < -0.0001) {
    return `-${formatted} ${currency}`;
  }
  if (value > 0.0001) {
    return `+${formatted} ${currency}`;
  }
  return `${formatted} ${currency}`;
}

function formatShareChange(value, precision) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-6) {
    return '—';
  }
  const digits = Math.max(0, Number.isFinite(precision) ? precision : 0);
  return formatNumber(Math.abs(value), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function normalizeTransactionScope(scope) {
  if (!scope) {
    return 'Portfolio';
  }
  if (scope === 'DEPLOYED') {
    return 'Deployed';
  }
  if (scope === 'RESERVE') {
    return 'Reserve';
  }
  return scope;
}

export default function DeploymentAdjustmentDialog({ plan, onClose, onAdjustTarget, copyToClipboard }) {
  const sliderId = useId();
  const inputId = useId();
  const [sliderValue, setSliderValue] = useState(() => clampPercent(plan?.targetDeployedPercent ?? 0));
  const [inputValue, setInputValue] = useState(() => formatPercentInput(plan?.targetDeployedPercent));
  const [copyStatus, setCopyStatus] = useState(null);

  useEffect(() => {
    const percent = clampPercent(plan?.targetDeployedPercent ?? 0);
    setSliderValue(percent);
    setInputValue(formatPercentInput(percent));
  }, [plan?.targetDeployedPercent]);

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

  const handleSliderChange = (event) => {
    const nextValue = clampPercent(Number(event.target.value));
    setSliderValue(nextValue);
    setInputValue(formatPercentInput(nextValue));
    if (typeof onAdjustTarget === 'function') {
      onAdjustTarget(nextValue);
    }
  };

  const commitInputValue = useCallback(() => {
    const parsed = Number(inputValue);
    if (!Number.isFinite(parsed)) {
      const percent = clampPercent(plan?.targetDeployedPercent ?? 0);
      setInputValue(formatPercentInput(percent));
      setSliderValue(percent);
      return;
    }
    const clamped = clampPercent(parsed);
    setSliderValue(clamped);
    setInputValue(formatPercentInput(clamped));
    if (typeof onAdjustTarget === 'function') {
      onAdjustTarget(clamped);
    }
  }, [inputValue, onAdjustTarget, plan?.targetDeployedPercent]);

  const handleInputChange = (event) => {
    setInputValue(event.target.value);
  };

  const handleInputBlur = () => {
    commitInputValue();
  };

  const handleInputKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitInputValue();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      const percent = clampPercent(plan?.targetDeployedPercent ?? 0);
      setInputValue(formatPercentInput(percent));
      setSliderValue(percent);
      event.currentTarget.blur();
    }
  };

  const handleCopySummary = useCallback(async () => {
    if (!plan?.summaryText || typeof copyToClipboard !== 'function') {
      return;
    }
    try {
      await copyToClipboard(plan.summaryText);
      setCopyStatus({ message: 'Plan summary copied to clipboard.', tone: 'success' });
    } catch (error) {
      console.error('Failed to copy deployment plan summary', error);
      setCopyStatus({ message: 'Unable to copy plan summary. Copy manually if needed.', tone: 'error' });
    }
  }, [plan?.summaryText, copyToClipboard]);

  const transactionRows = useMemo(() => {
    if (!Array.isArray(plan?.transactions) || !plan.transactions.length) {
      return [];
    }
    return plan.transactions.map((transaction, index) => {
      const amountLabel = formatCurrencyLabel(Math.abs(transaction.amount), transaction.currency || 'CAD');
      const priceLabel = Number.isFinite(transaction.price)
        ? `${formatMoney(transaction.price)} ${transaction.currency || 'CAD'}`
        : '—';
      const sharesLabel = formatShareChange(transaction.shares, transaction.sharePrecision);
      return {
        key: `${transaction.symbol || index}:${index}`,
        scope: normalizeTransactionScope(transaction.scope),
        side: transaction.side === 'SELL' ? 'Sell' : 'Buy',
        symbol: transaction.symbol || '—',
        description: transaction.description || null,
        amountLabel,
        sharesLabel,
        priceLabel,
        currency: transaction.currency || 'CAD',
      };
    });
  }, [plan?.transactions]);

  const conversionRows = useMemo(() => {
    if (!Array.isArray(plan?.conversions) || !plan.conversions.length) {
      return [];
    }
    return plan.conversions.map((conversion, index) => {
      const direction = conversion.type === 'CAD_TO_USD' ? 'CAD → USD' : 'USD → CAD';
      const spendLabel = Number.isFinite(conversion.spendAmount)
        ? `${formatMoney(conversion.spendAmount)} ${conversion.currency || 'CAD'}`
        : '—';
      const receiveLabel = Number.isFinite(conversion.actualReceiveAmount)
        ? `${formatMoney(conversion.actualReceiveAmount)} ${conversion.targetCurrency || 'USD'}`
        : '—';
      const shareLabel = Number.isFinite(conversion.shares)
        ? formatNumber(conversion.shares, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
        : '—';
      const priceLabel = Number.isFinite(conversion.sharePrice)
        ? `${formatMoney(conversion.sharePrice)} ${conversion.currency || 'CAD'}`
        : '—';
      return {
        key: `${conversion.symbol || index}:${index}`,
        symbol: conversion.symbol || 'DLR',
        description: conversion.description || null,
        direction,
        spendLabel,
        receiveLabel,
        shareLabel,
        priceLabel,
      };
    });
  }, [plan?.conversions]);

  const accountLabel = plan?.accountLabel || plan?.accountName || plan?.accountNumber || null;
  const summaryDetails = [
    {
      label: 'Current deployed',
      value: formatCurrencyLabel(plan?.currentDeployedValue ?? null, plan?.baseCurrency || 'CAD'),
      extra: formatPercentLabel(plan?.currentDeployedPercent),
    },
    {
      label: 'Target deployed',
      value: formatCurrencyLabel(plan?.targetDeployedValue ?? null, plan?.baseCurrency || 'CAD'),
      extra: formatPercentLabel(plan?.targetDeployedPercent),
    },
    {
      label: 'Target reserve',
      value: formatCurrencyLabel(plan?.targetReserveValue ?? null, plan?.baseCurrency || 'CAD'),
      extra: formatPercentLabel(plan?.targetReservePercent),
    },
  ];

  return (
    <div className="invest-plan-overlay" role="presentation" onClick={handleOverlayClick}>
      <div className="invest-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="deployment-plan-title">
        <header className="invest-plan-dialog__header">
          <div className="invest-plan-dialog__heading">
            <h2 id="deployment-plan-title" className="invest-plan-dialog__title">
              Adjust deployment
            </h2>
            {accountLabel && <p className="invest-plan-dialog__account">{accountLabel}</p>}
          </div>
          <button
            type="button"
            className="invest-plan-dialog__close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="invest-plan-dialog__body">
          {copyStatus && (
            <div className={`invest-plan-dialog__status invest-plan-dialog__status--${copyStatus.tone}`}>
              {copyStatus.message}
            </div>
          )}
          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Target deployment</h3>
            <div className="deployment-plan-controls">
              <label htmlFor={sliderId} className="deployment-plan-controls__label">
                Deployed percentage
              </label>
              <div className="deployment-plan-controls__inputs">
                <input
                  id={sliderId}
                  type="range"
                  min="0"
                  max="100"
                  step="0.25"
                  value={sliderValue}
                  onChange={handleSliderChange}
                  className="deployment-plan-controls__slider"
                />
                <div className="deployment-plan-controls__number">
                  <label htmlFor={inputId} className="deployment-plan-controls__number-label">
                    %
                  </label>
                  <input
                    id={inputId}
                    type="number"
                    step="0.25"
                    min="0"
                    max="100"
                    value={inputValue}
                    onChange={handleInputChange}
                    onBlur={handleInputBlur}
                    onKeyDown={handleInputKeyDown}
                    className="deployment-plan-controls__number-input"
                  />
                </div>
              </div>
            </div>
            <dl className="deployment-plan-summary">
              {summaryDetails.map((entry) => (
                <div key={entry.label} className="deployment-plan-summary__row">
                  <dt className="deployment-plan-summary__label">{entry.label}</dt>
                  <dd className="deployment-plan-summary__value">
                    <span>{entry.value}</span>
                    <span className="deployment-plan-summary__percent">{entry.extra}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {conversionRows.length > 0 && (
            <section className="invest-plan-section">
              <h3 className="invest-plan-section__title">FX conversions</h3>
              <div className="deployment-plan-conversions">
                {conversionRows.map((conversion) => (
                  <div key={conversion.key} className="deployment-plan-conversions__item">
                    <div className="deployment-plan-conversions__symbol">
                      <span className="deployment-plan-conversions__ticker">{conversion.symbol}</span>
                      {conversion.description && (
                        <span className="deployment-plan-conversions__name">{conversion.description}</span>
                      )}
                    </div>
                    <div className="deployment-plan-conversions__details">
                      <span>{conversion.direction}</span>
                      <span>Spend: {conversion.spendLabel}</span>
                      <span>Receive: {conversion.receiveLabel}</span>
                      <span>Shares: {conversion.shareLabel}</span>
                      <span>Price: {conversion.priceLabel}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Trades</h3>
            {transactionRows.length ? (
              <div className="invest-plan-purchases-wrapper">
                <table className="invest-plan-purchases">
                  <thead>
                    <tr>
                      <th scope="col">Area</th>
                      <th scope="col">Action</th>
                      <th scope="col">Symbol</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Shares</th>
                      <th scope="col">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactionRows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.scope}</td>
                        <td>{row.side}</td>
                        <th scope="row">
                          <div className="invest-plan-symbol">
                            <span className="invest-plan-symbol__ticker">{row.symbol}</span>
                            {row.description && (
                              <span className="invest-plan-symbol__name">{row.description}</span>
                            )}
                          </div>
                        </th>
                        <td>{row.amountLabel}</td>
                        <td>{row.sharesLabel}</td>
                        <td>{row.priceLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="invest-plan-empty">No trades are required for this target.</p>
            )}
          </section>

          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Totals</h3>
            <dl className="invest-plan-cash">
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">CAD buys</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(plan?.totals?.cadBuys ?? null, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">CAD sells</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(plan?.totals?.cadSells ?? null, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">USD buys</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(plan?.totals?.usdBuys ?? null, 'USD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">USD sells</dt>
                <dd className="invest-plan-cash__value">{formatCurrencyLabel(plan?.totals?.usdSells ?? null, 'USD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">CAD cash delta</dt>
                <dd className="invest-plan-cash__value">{formatSignedCurrencyLabel(plan?.cashDeltas?.CAD ?? 0, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">USD cash delta</dt>
                <dd className="invest-plan-cash__value">{formatSignedCurrencyLabel(plan?.cashDeltas?.USD ?? 0, 'USD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">Remaining CAD</dt>
                <dd className="invest-plan-cash__value">{formatSignedCurrencyLabel(plan?.totals?.cadNet ?? 0, 'CAD')}</dd>
              </div>
              <div className="invest-plan-cash__row">
                <dt className="invest-plan-cash__label">Remaining USD</dt>
                <dd className="invest-plan-cash__value">{formatSignedCurrencyLabel(plan?.totals?.usdNet ?? 0, 'USD')}</dd>
              </div>
            </dl>
          </section>
        </div>
        <footer className="invest-plan-dialog__footer">
          <button type="button" className="invest-plan-footer__button" onClick={handleCopySummary}>
            Copy plan summary
          </button>
          <button
            type="button"
            className="invest-plan-footer__button invest-plan-footer__button--primary"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

DeploymentAdjustmentDialog.propTypes = {
  plan: PropTypes.shape({
    targetDeployedPercent: PropTypes.number,
    targetReservePercent: PropTypes.number,
    currentDeployedPercent: PropTypes.number,
    currentReservePercent: PropTypes.number,
    currentDeployedValue: PropTypes.number,
    currentReserveValue: PropTypes.number,
    targetDeployedValue: PropTypes.number,
    targetReserveValue: PropTypes.number,
    baseCurrency: PropTypes.string,
    accountLabel: PropTypes.string,
    accountName: PropTypes.string,
    accountNumber: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    summaryText: PropTypes.string,
    transactions: PropTypes.arrayOf(
      PropTypes.shape({
        symbol: PropTypes.string,
        description: PropTypes.string,
        currency: PropTypes.string,
        amount: PropTypes.number,
        shares: PropTypes.number,
        sharePrecision: PropTypes.number,
        price: PropTypes.number,
        side: PropTypes.oneOf(['BUY', 'SELL']),
        scope: PropTypes.string,
      })
    ),
    conversions: PropTypes.arrayOf(
      PropTypes.shape({
        type: PropTypes.oneOf(['CAD_TO_USD', 'USD_TO_CAD']),
        symbol: PropTypes.string,
        description: PropTypes.string,
        cadAmount: PropTypes.number,
        usdAmount: PropTypes.number,
        sharePrice: PropTypes.number,
        shares: PropTypes.number,
        spendAmount: PropTypes.number,
        currency: PropTypes.string,
        targetCurrency: PropTypes.string,
        actualSpendAmount: PropTypes.number,
        actualReceiveAmount: PropTypes.number,
      })
    ),
    totals: PropTypes.shape({
      cadBuys: PropTypes.number,
      cadSells: PropTypes.number,
      usdBuys: PropTypes.number,
      usdSells: PropTypes.number,
      cadNet: PropTypes.number,
      usdNet: PropTypes.number,
    }),
    cashDeltas: PropTypes.shape({
      CAD: PropTypes.number,
      USD: PropTypes.number,
    }),
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  onAdjustTarget: PropTypes.func,
  copyToClipboard: PropTypes.func,
};

DeploymentAdjustmentDialog.defaultProps = {
  onAdjustTarget: null,
  copyToClipboard: null,
};
