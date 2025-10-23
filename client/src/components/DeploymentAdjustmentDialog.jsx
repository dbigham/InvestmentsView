import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';
import {
  formatCopyNumber,
  formatCurrencyLabel,
  formatShareDisplay,
  JOURNALLING_URL,
  truncateDescription,
} from './investPlanUtils';

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
  const [completedTransactions, setCompletedTransactions] = useState(() => new Set());

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

  useEffect(() => {
    setCompletedTransactions(new Set());
  }, [plan?.transactions]);

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

  const handleToggleTransaction = useCallback((rowKey) => {
    setCompletedTransactions((prev) => {
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

  const transactionRows = useMemo(() => {
    if (!Array.isArray(plan?.transactions) || !plan.transactions.length) {
      return [];
    }
    return plan.transactions.map((transaction, index) => {
      const currency = transaction.currency || 'CAD';
      const amountValue = Number.isFinite(transaction.amount) ? Math.abs(transaction.amount) : null;
      const amountLabel = Number.isFinite(amountValue)
        ? formatCurrencyLabel(amountValue, currency)
        : '—';
      const amountCopy = Number.isFinite(amountValue) && amountValue > 0
        ? formatCopyNumber(amountValue, 2)
        : null;
      const sharesValue = Number.isFinite(transaction.shares) ? Math.abs(transaction.shares) : null;
      const shareLabel = Number.isFinite(sharesValue) && sharesValue > 0
        ? formatShareDisplay(sharesValue, transaction.sharePrecision)
        : '—';
      const shareCopy = Number.isFinite(sharesValue) && sharesValue > 0
        ? formatCopyNumber(sharesValue, transaction.sharePrecision ?? 0, { trimTrailingZeros: true })
        : null;
      const priceLabel = Number.isFinite(transaction.price)
        ? `${formatMoney(transaction.price)} ${currency}`
        : '—';

      const symbol = transaction.symbol ? transaction.symbol : '—';
      return {
        rowKey: `${transaction.symbol || index}:${index}`,
        scope: normalizeTransactionScope(transaction.scope),
        side: transaction.side === 'SELL' ? 'Sell' : 'Buy',
        symbol,
        canCopySymbol: symbol !== '—',
        description: transaction.description || null,
        displayDescription: truncateDescription(transaction.description),
        amountLabel,
        amountCopy,
        shareLabel,
        shareCopy,
        priceLabel,
      };
    });
  }, [plan?.transactions]);

  const conversionRows = useMemo(() => {
    if (!Array.isArray(plan?.conversions) || !plan.conversions.length) {
      return [];
    }
    return plan.conversions.map((conversion, index) => {
      const symbol = conversion.symbol || (conversion.type === 'CAD_TO_USD' ? 'DLR.TO' : 'DLR.U.TO');
      const spendCurrency = conversion.currency || (conversion.type === 'CAD_TO_USD' ? 'CAD' : 'USD');
      const targetCurrency = conversion.targetCurrency || (conversion.type === 'CAD_TO_USD' ? 'USD' : 'CAD');
      const spendAmount = Number.isFinite(conversion.spendAmount)
        ? conversion.spendAmount
        : spendCurrency === 'CAD'
        ? conversion.cadAmount
        : conversion.usdAmount;
      const spendValue = Number.isFinite(spendAmount) ? spendAmount : null;
      const amountLabel = Number.isFinite(spendValue)
        ? formatCurrencyLabel(spendValue, spendCurrency)
        : '—';
      const amountCopy = Number.isFinite(spendValue) && spendValue > 0
        ? formatCopyNumber(spendValue, 2)
        : null;
      const targetAmount = Number.isFinite(conversion.actualReceiveAmount)
        ? conversion.actualReceiveAmount
        : targetCurrency === 'CAD'
        ? conversion.cadAmount
        : conversion.usdAmount;
      const targetValue = Number.isFinite(targetAmount) ? targetAmount : null;
      const targetLabel = Number.isFinite(targetValue)
        ? formatCurrencyLabel(targetValue, targetCurrency)
        : null;
      const shareValue = Number.isFinite(conversion.shares) && conversion.shares > 0 ? conversion.shares : null;
      const shareLabel = shareValue !== null
        ? formatShareDisplay(shareValue, conversion.sharePrecision)
        : '—';
      const shareCopy = shareValue !== null
        ? formatCopyNumber(shareValue, conversion.sharePrecision ?? 0, { trimTrailingZeros: true })
        : null;
      const priceLabel = Number.isFinite(conversion.sharePrice)
        ? formatCurrencyLabel(conversion.sharePrice, spendCurrency)
        : null;

      return {
        key: `${symbol}:${index}`,
        symbol,
        description: conversion.description || null,
        displayDescription: truncateDescription(conversion.description),
        direction: conversion.type === 'CAD_TO_USD' ? 'Convert CAD → USD' : 'Convert USD → CAD',
        amountLabel,
        amountCopy,
        targetLabel,
        shareLabel,
        shareCopy,
        priceLabel,
      };
    });
  }, [plan?.conversions]);

  const accountLabel = plan?.accountLabel || plan?.accountName || plan?.accountNumber || null;
  const accountNumber = plan?.accountNumber ? String(plan.accountNumber) : null;
  const accountUrl = plan?.accountUrl || null;
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
            {accountUrl && (
              <a
                className="invest-plan-dialog__account-link"
                href={accountUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open account in Questrade
              </a>
            )}
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
                {conversionRows.map((conversion) => (
                  <li key={conversion.key} className="invest-plan-conversions__item">
                    <div className="invest-plan-conversion__header">
                      <div className="invest-plan-symbol">
                        <button
                          type="button"
                          className="invest-plan-symbol__ticker"
                          onClick={() => copyValue(conversion.symbol, `${conversion.symbol} symbol`)}
                          title="Copy symbol"
                          aria-label={`Copy ${conversion.symbol} symbol`}
                        >
                          {conversion.symbol}
                        </button>
                        {conversion.displayDescription && (
                          <span
                            className="invest-plan-symbol__name"
                            title={conversion.description || undefined}
                          >
                            {conversion.displayDescription}
                          </span>
                        )}
                      </div>
                      <span className="invest-plan-conversion__direction">{conversion.direction}</span>
                    </div>
                    <div className="invest-plan-conversion__actions">
                      {conversion.amountCopy ? (
                        <button
                          type="button"
                          className="invest-plan-copy-button"
                          onClick={() => copyValue(conversion.amountCopy, `${conversion.symbol} amount`)}
                        >
                          Spend {conversion.amountLabel}
                        </button>
                      ) : (
                        <span className="invest-plan-copy-button invest-plan-copy-button--disabled">
                          Spend {conversion.amountLabel}
                        </span>
                      )}
                      {conversion.shareCopy && conversion.shareLabel !== '—' && (
                        <button
                          type="button"
                          className="invest-plan-copy-button"
                          onClick={() => copyValue(conversion.shareCopy, `${conversion.symbol} shares`)}
                        >
                          Buy {conversion.shareLabel}
                        </button>
                      )}
                    </div>
                    <div className="invest-plan-conversion__details">
                      {conversion.targetLabel && (
                        <span className="invest-plan-conversion__detail">
                          Target: {conversion.targetLabel}
                        </span>
                      )}
                      {conversion.priceLabel && (
                        <span className="invest-plan-conversion__detail">
                          Price: {conversion.priceLabel}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="invest-plan-section">
            <h3 className="invest-plan-section__title">Trades</h3>
            {transactionRows.length ? (
              <div className="invest-plan-purchases-wrapper">
                <table className="invest-plan-purchases">
                  <thead>
                    <tr>
                      <th scope="col" className="invest-plan-purchases__checkbox-header">Done</th>
                      <th scope="col">Area</th>
                      <th scope="col">Action</th>
                      <th scope="col">Symbol</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Shares</th>
                      <th scope="col">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactionRows.map((row) => {
                      const isCompleted = completedTransactions.has(row.rowKey);
                      const rowClassName = isCompleted
                        ? 'invest-plan-purchases__row invest-plan-purchases__row--completed'
                        : 'invest-plan-purchases__row';
                      return (
                        <tr key={row.rowKey} className={rowClassName}>
                          <td className="invest-plan-purchases__checkbox-cell">
                            <input
                              type="checkbox"
                              className="invest-plan-purchases__checkbox"
                              checked={isCompleted}
                              onChange={() => handleToggleTransaction(row.rowKey)}
                              aria-label={`Mark ${row.symbol} ${row.side.toLowerCase()} as ${
                                isCompleted ? 'not completed' : 'completed'
                              }`}
                            />
                          </td>
                          <td>{row.scope}</td>
                          <td>{row.side}</td>
                          <th scope="row">
                            <div className="invest-plan-symbol">
                              {row.canCopySymbol ? (
                                <button
                                  type="button"
                                  className="invest-plan-symbol__ticker"
                                  onClick={() => copyValue(row.symbol, `${row.symbol} symbol`)}
                                  title="Copy symbol"
                                  aria-label={`Copy ${row.symbol} symbol`}
                                >
                                  {row.symbol}
                                </button>
                              ) : (
                                <span className="invest-plan-symbol__ticker">{row.symbol}</span>
                              )}
                              {row.displayDescription && (
                                <span className="invest-plan-symbol__name" title={row.description || undefined}>
                                  {row.displayDescription}
                                </span>
                              )}
                            </div>
                          </th>
                          <td>
                            {row.amountCopy ? (
                              <button
                                type="button"
                                className="invest-plan-copy-button"
                                onClick={() => copyValue(row.amountCopy, `${row.symbol} amount`)}
                              >
                                {row.amountLabel}
                              </button>
                            ) : (
                              <span className="invest-plan-copy-button invest-plan-copy-button--disabled">
                                {row.amountLabel}
                              </span>
                            )}
                          </td>
                          <td>
                            {row.shareCopy ? (
                              <button
                                type="button"
                                className="invest-plan-copy-button"
                                onClick={() => copyValue(row.shareCopy, `${row.symbol} shares`)}
                              >
                                {row.shareLabel}
                              </button>
                            ) : (
                              <span className="invest-plan-copy-button invest-plan-copy-button--disabled">
                                {row.shareLabel}
                              </span>
                            )}
                          </td>
                          <td>{row.priceLabel}</td>
                        </tr>
                      );
                    })}
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
    accountUrl: PropTypes.string,
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
