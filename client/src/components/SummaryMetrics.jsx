import { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import TimePill from './TimePill';
import {
  classifyPnL,
  formatMoney,
  formatNumber,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

function MetricRow({ label, value, extra, tone, className, onActivate }) {
  const rowClass = className ? `equity-card__metric-row ${className}` : 'equity-card__metric-row';
  const interactive = typeof onActivate === 'function';

  const handleKeyDown = (event) => {
    if (!interactive) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate();
    }
  };

  const interactiveProps = interactive
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: onActivate,
        onKeyDown: handleKeyDown,
        'data-interactive': 'true',
      }
    : {};

  return (
    <div className={rowClass} {...interactiveProps}>
      <dt>{label}</dt>
      <dd>
        <span className={`equity-card__metric-value equity-card__metric-value--${tone}`}>{value}</span>
        {extra && <span className="equity-card__metric-extra">{extra}</span>}
      </dd>
    </div>
  );
}

MetricRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  extra: PropTypes.node,
  tone: PropTypes.oneOf(['positive', 'negative', 'neutral']).isRequired,
  className: PropTypes.string,
  onActivate: PropTypes.func,
};

MetricRow.defaultProps = {
  extra: null,
  className: '',
  onActivate: null,
};

function ActionMenu({ onCopySummary, disabled }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef(null);
  const generatedId = useId();

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointer = (event) => {
      if (!containerRef.current) {
        return;
      }
      if (containerRef.current.contains(event.target)) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    if (disabled || busy) {
      return;
    }
    setOpen((value) => !value);
  };

  const handleCopy = async () => {
    if (!onCopySummary || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onCopySummary();
    } catch (error) {
      console.error('Failed to copy summary', error);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const effectiveDisabled = disabled || busy;
  const menuId = generatedId || 'equity-card-action-menu';

  return (
    <div className="equity-card__action-menu" ref={containerRef}>
      <button
        type="button"
        className="equity-card__action-button equity-card__action-button--menu"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={effectiveDisabled}
      >
        {busy ? 'Working…' : 'Actions'}
        <span className="equity-card__action-caret" aria-hidden="true" />
      </button>
      {open && (
        <ul className="equity-card__action-menu-list" role="menu" id={menuId}>
          <li role="none">
            <button
              type="button"
              className="equity-card__action-menu-item"
              role="menuitem"
              onClick={handleCopy}
              disabled={busy}
            >
              Copy to clipboard
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

ActionMenu.propTypes = {
  onCopySummary: PropTypes.func,
  disabled: PropTypes.bool,
};

ActionMenu.defaultProps = {
  onCopySummary: null,
  disabled: false,
};

export default function SummaryMetrics({
  currencyOption,
  currencyOptions,
  onCurrencyChange,
  balances,
  pnl,
  asOf,
  onRefresh,
  displayTotalEquity,
  usdToCadRate,
  onShowPeople,
  peopleDisabled,
  onShowPnlBreakdown,
  isRefreshing,
  isAutoRefreshing,
  onCopySummary,
}) {
  const title = 'Total equity (Combined in CAD)';
  const totalEquity = balances?.totalEquity ?? null;
  const marketValue = balances?.marketValue ?? null;
  const cash = balances?.cash ?? null;
  const buyingPower = balances?.buyingPower ?? null;

  const todayTone = classifyPnL(pnl?.dayPnl);
  const openTone = classifyPnL(pnl?.openPnl);
  const totalTone = classifyPnL(pnl?.totalPnl);

  const formattedToday = formatSignedMoney(pnl?.dayPnl ?? null);
  const formattedOpen = formatSignedMoney(pnl?.openPnl ?? null);
  const formattedTotal = formatSignedMoney(pnl?.totalPnl ?? null);

  const safeTotalEquity = typeof totalEquity === 'number' && totalEquity !== 0 ? totalEquity : null;
  const dayPercentValue = safeTotalEquity ? ((pnl?.dayPnl || 0) / safeTotalEquity) * 100 : null;
  const dayPercent =
    dayPercentValue !== null && Number.isFinite(dayPercentValue)
      ? formatSignedPercent(dayPercentValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;

  return (
    <section className="equity-card">
      <header className="equity-card__header">
        <div className="equity-card__heading">
          <h2 className="equity-card__title">{title}</h2>
          <p className="equity-card__value">{formatMoney(displayTotalEquity ?? totalEquity)}</p>
          {usdToCadRate !== null && (
            <p className="equity-card__subtext">
              <a
                className="equity-card__subtext-label"
                href="https://www.google.ca/search?sourceid=chrome-psyapi2&ion=1&espv=2&ie=UTF-8&q=usd%20=%20?%20cad"
                target="_blank"
                rel="noopener noreferrer"
              >
                USD → CAD
              </a>
              <span className="equity-card__subtext-value">
                {formatNumber(usdToCadRate, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
              </span>
            </p>
          )}
        </div>
        <div className="equity-card__actions">
          {onShowPeople && (
            <button
              type="button"
              className="equity-card__action-button"
              onClick={onShowPeople}
              disabled={peopleDisabled}
            >
              People
            </button>
          )}
          {onCopySummary && <ActionMenu onCopySummary={onCopySummary} />}
          <TimePill
            asOf={asOf}
            onRefresh={onRefresh}
            refreshing={isRefreshing}
            autoRefreshing={isAutoRefreshing}
          />
        </div>
      </header>

      {currencyOptions.length > 0 && (
        <div className="equity-card__chip-row" role="group" aria-label="Currency views">
          {currencyOptions.map((option) => {
            const isActive = currencyOption?.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={isActive ? 'active' : ''}
                onClick={() => onCurrencyChange(option.value)}
                aria-pressed={isActive}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="equity-card__metrics">
        <dl className="equity-card__metric-column">
          <MetricRow
            label="Today's P&L"
            value={formattedToday}
            extra={dayPercent ? `(${dayPercent})` : null}
            tone={todayTone}
            onActivate={onShowPnlBreakdown ? () => onShowPnlBreakdown('day') : null}
          />
          <MetricRow
            label="Open P&L"
            value={formattedOpen}
            tone={openTone}
            onActivate={onShowPnlBreakdown ? () => onShowPnlBreakdown('open') : null}
          />
          <MetricRow label="Total P&L" value={formattedTotal} tone={totalTone} />
        </dl>
        <dl className="equity-card__metric-column">
          <MetricRow label="Total equity" value={formatMoney(totalEquity)} tone="neutral" />
          <MetricRow label="Market value" value={formatMoney(marketValue)} tone="neutral" />
          <MetricRow label="Cash" value={formatMoney(cash)} tone="neutral" />
          <MetricRow label="Buying power" value={formatMoney(buyingPower)} tone="neutral" />
        </dl>
      </div>

    </section>
  );
}

SummaryMetrics.propTypes = {
  currencyOption: PropTypes.shape({
    value: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    scope: PropTypes.string.isRequired,
    currency: PropTypes.string.isRequired,
  }),
  currencyOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      scope: PropTypes.string.isRequired,
      currency: PropTypes.string.isRequired,
    })
  ).isRequired,
  onCurrencyChange: PropTypes.func.isRequired,
  balances: PropTypes.shape({
    totalEquity: PropTypes.number,
    marketValue: PropTypes.number,
    cash: PropTypes.number,
    buyingPower: PropTypes.number,
  }),
  pnl: PropTypes.shape({
    dayPnl: PropTypes.number,
    openPnl: PropTypes.number,
    totalPnl: PropTypes.number,
  }).isRequired,
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  displayTotalEquity: PropTypes.number,
  usdToCadRate: PropTypes.number,
  onShowPeople: PropTypes.func,
  peopleDisabled: PropTypes.bool,
  onShowPnlBreakdown: PropTypes.func,
  isRefreshing: PropTypes.bool,
  isAutoRefreshing: PropTypes.bool,
  onCopySummary: PropTypes.func,
};

SummaryMetrics.defaultProps = {
  currencyOption: null,
  balances: null,
  asOf: null,
  onRefresh: null,
  displayTotalEquity: null,
  usdToCadRate: null,
  onShowPeople: null,
  peopleDisabled: false,
  onShowPnlBreakdown: null,
  isRefreshing: false,
  isAutoRefreshing: false,
  onCopySummary: null,
};
