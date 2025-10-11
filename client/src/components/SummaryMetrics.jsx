import { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import TimePill from './TimePill';
import {
  classifyPnL,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

function parseDateString(value, { assumeDateOnly = false } = {}) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const isoString = assumeDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00Z`
    : trimmed;
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function computeElapsedYears(startDate, endDate) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) {
    return null;
  }
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) {
    return null;
  }
  const diffMs = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null;
  }
  return diffMs / MS_PER_DAY / DAYS_PER_YEAR;
}

function MetricRow({ label, value, extra, tone, className, onActivate, tooltip, extraTooltip }) {
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

  const labelContent = tooltip ? (
    <span title={tooltip}>{label}</span>
  ) : (
    label
  );

  const extraContent =
    extra && extraTooltip ? (
      <span title={extraTooltip}>{extra}</span>
    ) : (
      extra
    );

  return (
    <div className={rowClass} {...interactiveProps}>
      <dt>{labelContent}</dt>
      <dd>
        <span className={`equity-card__metric-value equity-card__metric-value--${tone}`}>{value}</span>
        {extra && <span className="equity-card__metric-extra">{extraContent}</span>}
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
  tooltip: PropTypes.string,
  extraTooltip: PropTypes.string,
};

MetricRow.defaultProps = {
  extra: null,
  className: '',
  onActivate: null,
  tooltip: null,
  extraTooltip: null,
};

function ActionMenu({
  onCopySummary,
  onEstimateCagr,
  onPlanInvestEvenly,
  onMarkRebalanced,
  onCheckTodos,
  disabled,
  chatUrl,
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef(null);
  const generatedId = useId();
  const normalizedChatUrl = typeof chatUrl === 'string' ? chatUrl.trim() : '';
  const hasChatLink = Boolean(normalizedChatUrl);
  const hasCopyAction = typeof onCopySummary === 'function';
  const hasEstimateAction = typeof onEstimateCagr === 'function';
  const hasInvestEvenlyAction = typeof onPlanInvestEvenly === 'function';
  const hasMarkRebalancedAction = typeof onMarkRebalanced === 'function';
  const hasTodoCheckAction = typeof onCheckTodos === 'function';

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

  const handleEstimateCagr = async () => {
    if (!onEstimateCagr || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onEstimateCagr();
    } catch (error) {
      console.error('Failed to prepare CAGR estimate prompt', error);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const handlePlanInvestEvenly = async () => {
    if (!onPlanInvestEvenly || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onPlanInvestEvenly();
    } catch (error) {
      console.error('Failed to prepare invest evenly plan', error);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const handleMarkAsRebalanced = async () => {
    if (!onMarkRebalanced || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onMarkRebalanced();
    } catch (error) {
      console.error('Failed to mark account as rebalanced', error);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const handleCheckTodos = async () => {
    if (!onCheckTodos || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onCheckTodos();
    } catch (error) {
      console.error('Failed to check for TODOs', error);
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
          {hasChatLink && (
            <li role="none">
              <a
                className="equity-card__action-menu-item"
                role="menuitem"
                href={normalizedChatUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                Chat
              </a>
            </li>
          )}
          {hasTodoCheckAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleCheckTodos}
                disabled={busy}
              >
                Check for TODOs
              </button>
            </li>
          )}
          {hasCopyAction && (
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
          )}
          {hasMarkRebalancedAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleMarkAsRebalanced}
                disabled={busy}
              >
                Mark as rebalanced
              </button>
            </li>
          )}
          {hasInvestEvenlyAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handlePlanInvestEvenly}
                disabled={busy}
              >
                Invest cash evenly
              </button>
            </li>
          )}
          {hasEstimateAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleEstimateCagr}
                disabled={busy}
              >
                Estimate future CAGR
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

ActionMenu.propTypes = {
  onCopySummary: PropTypes.func,
  onEstimateCagr: PropTypes.func,
  onPlanInvestEvenly: PropTypes.func,
  onMarkRebalanced: PropTypes.func,
  onCheckTodos: PropTypes.func,
  disabled: PropTypes.bool,
  chatUrl: PropTypes.string,
};

ActionMenu.defaultProps = {
  onCopySummary: null,
  onEstimateCagr: null,
  onPlanInvestEvenly: null,
  onMarkRebalanced: null,
  onCheckTodos: null,
  disabled: false,
  chatUrl: null,
};

export default function SummaryMetrics({
  currencyOption,
  currencyOptions,
  onCurrencyChange,
  balances,
  pnl,
  fundingSummary,
  asOf,
  onRefresh,
  displayTotalEquity,
  usdToCadRate,
  onShowPeople,
  peopleDisabled,
  onShowCashBreakdown,
  onShowPnlBreakdown,
  onShowTotalPnl,
  onShowAnnualizedReturn,
  isRefreshing,
  isAutoRefreshing,
  onCopySummary,
  onEstimateFutureCagr,
  onMarkRebalanced,
  onPlanInvestEvenly,
  onCheckTodos,
  chatUrl,
  showQqqTemperature,
  qqqSummary,
  onShowInvestmentModel,
  benchmarkComparison,
}) {
  const title = 'Total equity (Combined in CAD)';
  const totalEquity = balances?.totalEquity ?? null;
  const marketValue = balances?.marketValue ?? null;
  const cash = balances?.cash ?? null;
  const buyingPower = balances?.buyingPower ?? null;

  const totalPnlValue = Number.isFinite(pnl?.totalPnl)
    ? pnl.totalPnl
    : Number.isFinite(fundingSummary?.totalPnlCad)
      ? fundingSummary.totalPnlCad
      : null;
  const todayTone = classifyPnL(pnl?.dayPnl);
  const openTone = classifyPnL(pnl?.openPnl);
  const totalTone = classifyPnL(totalPnlValue);
  const formattedToday = formatSignedMoney(pnl?.dayPnl ?? null);
  const formattedOpen = formatSignedMoney(pnl?.openPnl ?? null);
  const formattedTotal = formatSignedMoney(totalPnlValue);
  const qqqStatus = qqqSummary?.status || 'loading';
  const hasQqqTemperature = Number.isFinite(qqqSummary?.temperature);
  let qqqLabel = 'QQQ temperature: Loading…';
  if ((qqqStatus === 'ready' || qqqStatus === 'refreshing') && hasQqqTemperature) {
    const formattedTemp = formatNumber(qqqSummary.temperature, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    qqqLabel = `QQQ temperature: ${formattedTemp}`;
  } else if (qqqStatus === 'error') {
    qqqLabel = qqqSummary?.message || 'Unable to load';
  } else if (qqqStatus !== 'loading') {
    qqqLabel = 'QQQ temperature unavailable';
  }
  const netDepositsValue = Number.isFinite(fundingSummary?.netDepositsCad)
    ? fundingSummary.netDepositsCad
    : null;
  const formattedNetDeposits = netDepositsValue !== null ? formatMoney(netDepositsValue) : null;

  const annualizedReturnRate = Number.isFinite(fundingSummary?.annualizedReturnRate)
    ? fundingSummary.annualizedReturnRate
    : null;
  const annualizedPercentDisplay =
    annualizedReturnRate === null
      ? null
      : formatSignedPercent(annualizedReturnRate * 100, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  const formattedCagr = annualizedPercentDisplay ?? '—';
  const cagrTone =
    annualizedReturnRate > 0 ? 'positive' : annualizedReturnRate < 0 ? 'negative' : 'neutral';
  const canShowReturnBreakdown =
    typeof onShowAnnualizedReturn === 'function' &&
    Array.isArray(fundingSummary?.returnBreakdown) &&
    fundingSummary.returnBreakdown.length > 0;

  const safeTotalEquity = Number.isFinite(totalEquity)
    ? totalEquity
    : Number.isFinite(fundingSummary?.totalEquityCad)
      ? fundingSummary.totalEquityCad
      : null;

  const resolvedPeriodStartDate =
    parseDateString(fundingSummary?.periodStartDate, { assumeDateOnly: true }) ||
    parseDateString(fundingSummary?.annualizedReturnStartDate, { assumeDateOnly: true });
  const resolvedPeriodEndDate =
    parseDateString(fundingSummary?.periodEndDate, { assumeDateOnly: true }) ||
    parseDateString(fundingSummary?.annualizedReturnAsOf) ||
    parseDateString(asOf);
  let deAnnualizedReturnRate = null;
  if (Number.isFinite(annualizedReturnRate)) {
    const elapsedYears = computeElapsedYears(resolvedPeriodStartDate, resolvedPeriodEndDate);
    if (Number.isFinite(elapsedYears) && elapsedYears > 0) {
      const growthBase = 1 + annualizedReturnRate;
      if (growthBase > 0) {
        const growthFactor = Math.pow(growthBase, elapsedYears);
        if (Number.isFinite(growthFactor)) {
          deAnnualizedReturnRate = growthFactor - 1;
        }
      } else if (annualizedReturnRate <= -1) {
        deAnnualizedReturnRate = -1;
      }
    }
  }
  const deAnnualizedPercentDisplay =
    deAnnualizedReturnRate === null
      ? null
      : formatSignedPercent(deAnnualizedReturnRate * 100, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

  const formatPnlPercent = (change) => {
    if (!Number.isFinite(change)) {
      if (change === 0) {
        return formatSignedPercent(0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return null;
    }

    if (change === 0) {
      return formatSignedPercent(0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    if (safeTotalEquity === null) {
      return null;
    }

    const baseValue = safeTotalEquity - change;
    if (!Number.isFinite(baseValue) || baseValue === 0) {
      return null;
    }

    const percentValue = (change / baseValue) * 100;
    if (!Number.isFinite(percentValue)) {
      return null;
    }

    return formatSignedPercent(percentValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const dayPercent = formatPnlPercent(pnl?.dayPnl);
  const openPercent = formatPnlPercent(pnl?.openPnl);
  const totalPercent = formatPnlPercent(totalPnlValue);

  const benchmarkStatus = benchmarkComparison?.status || 'idle';
  const benchmarkData = benchmarkComparison?.data || null;

  const describePeriodLength = (startIso, endIso) => {
    if (!startIso) {
      return null;
    }
    const start = new Date(`${startIso}T00:00:00Z`);
    const effectiveEndIso = endIso || startIso;
    const end = new Date(`${effectiveEndIso}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return null;
    }
    const diffMs = end.getTime() - start.getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) {
      return null;
    }
    const totalDays = diffMs / (1000 * 60 * 60 * 24);
    const approxYears = totalDays / 365.25;
    if (approxYears >= 1) {
      const roundedYears = Math.round(approxYears * 10) / 10;
      if (!Number.isFinite(roundedYears) || roundedYears <= 0) {
        return null;
      }
      const formattedYears = roundedYears.toFixed(1).replace(/\.0$/, '');
      if (formattedYears === '1') {
        return '1 year';
      }
      return `${formattedYears} years`;
    }
    const approxMonths = totalDays / (365.25 / 12);
    let roundedMonths = Math.round(approxMonths * 10) / 10;
    if (!Number.isFinite(roundedMonths)) {
      return null;
    }
    if (roundedMonths <= 0 && totalDays > 0) {
      roundedMonths = 0.1;
    }
    if (roundedMonths < 0) {
      return null;
    }
    const formattedMonths = roundedMonths.toFixed(1);
    const isSingular = Math.abs(roundedMonths - 1) < 1e-9;
    return `${formattedMonths} month${isSingular ? '' : 's'}`;
  };

  let totalExtraPercent = null;
  let totalExtraPercentTooltip = null;
  if (deAnnualizedPercentDisplay !== null) {
    totalExtraPercent = `(${deAnnualizedPercentDisplay})`;
    totalExtraPercentTooltip = 'Estimated cumulative total return. (De-annualized XIRR)';
  } else if (totalPercent) {
    totalExtraPercent = `(${totalPercent})`;
    totalExtraPercentTooltip = 'Fallback calculation: Total P&L divided by cost basis.';
  }

  let detailLines = [];
  if (benchmarkStatus === 'loading' || benchmarkStatus === 'refreshing') {
    detailLines = ['Benchmarks: Loading…'];
  } else if (benchmarkStatus === 'error') {
    detailLines = ['Benchmarks: Unavailable'];
  } else if (benchmarkData) {
    const { sp500, qqq, interestRate, startDate, endDate } = benchmarkData;
    const qqqLabel = qqq?.name || 'QQQ';
    const spLabel = sp500?.name || 'S&P 500';
    const qqqValue = Number.isFinite(qqq?.returnRate)
      ? formatSignedPercent(qqq.returnRate * 100, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : '—';
    const spValue = Number.isFinite(sp500?.returnRate)
      ? formatSignedPercent(sp500.returnRate * 100, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : '—';
    const hasPeriodReturn = Number.isFinite(interestRate?.periodReturn);
    const interestBase = hasPeriodReturn
      ? interestRate.periodReturn
      : Number.isFinite(interestRate?.averageRate)
        ? interestRate.averageRate
        : null;
    const interestValue = Number.isFinite(interestBase)
      ? formatPercent(interestBase * 100, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : '—';
    detailLines = [
      `${qqqLabel}: ${qqqValue}`,
      `${spLabel}: ${spValue}`,
      `Interest: ${interestValue}`,
    ];
    const periodLabel = describePeriodLength(startDate, endDate);
    if (periodLabel) {
      detailLines.push(periodLabel);
    }
  }

  const hasDetailLines = detailLines.length > 0;

  const totalDetailBlock = hasDetailLines ? (
    <div className="total-pnl-details">
      {detailLines.map((line, index) => (
        <span key={`total-detail-line-${index}`} className="total-pnl-details__line">
          {line}
        </span>
      ))}
    </div>
  ) : null;

  return (
    <section className="equity-card">
      <header className="equity-card__header">
        <div className="equity-card__heading">
          <h2 className="equity-card__title">{title}</h2>
          <p className="equity-card__value">{formatMoney(displayTotalEquity ?? totalEquity)}</p>
          {usdToCadRate !== null && (
            <p className="equity-card__subtext">
              <a
                className="equity-card__subtext-link"
                href="https://www.google.ca/search?sourceid=chrome-psyapi2&ion=1&espv=2&ie=UTF-8&q=usd%20=%20?%20cad"
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="equity-card__subtext-value">
                  {`USD → CAD: ${formatNumber(usdToCadRate, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`}
                </span>
              </a>
            </p>
          )}
          {showQqqTemperature && (
            <p className="equity-card__subtext">
              {typeof onShowInvestmentModel === 'function' ? (
                <>
                  <button
                    type="button"
                    className="equity-card__subtext-button"
                    onClick={onShowInvestmentModel}
                    disabled={qqqStatus === 'loading'}
                  >
                    <span className="equity-card__subtext-value">{qqqLabel}</span>
                  </button>
                  <span className="visually-hidden" role="status" aria-live="polite">
                    {qqqLabel}
                  </span>
                </>
              ) : (
                <span className="equity-card__subtext-value" role="status" aria-live="polite">
                  {qqqLabel}
                </span>
              )}
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
          {(onCopySummary ||
            onEstimateFutureCagr ||
            onPlanInvestEvenly ||
            onMarkRebalanced ||
            onCheckTodos ||
            chatUrl) && (
            <ActionMenu
              onCopySummary={onCopySummary}
              onEstimateCagr={onEstimateFutureCagr}
              onPlanInvestEvenly={onPlanInvestEvenly}
              onMarkRebalanced={onMarkRebalanced}
              onCheckTodos={onCheckTodos}
              chatUrl={chatUrl}
            />
          )}
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
            extra={openPercent ? `(${openPercent})` : null}
            tone={openTone}
            onActivate={onShowPnlBreakdown ? () => onShowPnlBreakdown('open') : null}
          />
            <MetricRow
              label="Total P&L"
              value={formattedTotal}
              extra={totalExtraPercent}
              extraTooltip={totalExtraPercentTooltip}
              tone={totalTone}
              className={hasDetailLines ? 'equity-card__metric-row--total-with-details' : ''}
              onActivate={onShowTotalPnl}
            />
          {totalDetailBlock}
          <MetricRow
            label="Annualized return"
            tooltip="The equivalent constant yearly rate (with compounding) that gets from start value to today."
            value={formattedCagr}
            tone={cagrTone}
            onActivate={canShowReturnBreakdown ? onShowAnnualizedReturn : null}
          />
          {formattedNetDeposits && <MetricRow label="Net deposits" value={formattedNetDeposits} tone="neutral" />}
        </dl>
        <dl className="equity-card__metric-column">
          <MetricRow label="Total equity" value={formatMoney(totalEquity)} tone="neutral" />
          <MetricRow label="Market value" value={formatMoney(marketValue)} tone="neutral" />
          <MetricRow
            label="Cash"
            value={formatMoney(cash)}
            tone="neutral"
            onActivate={onShowCashBreakdown || null}
          />
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
  fundingSummary: PropTypes.shape({
    netDepositsCad: PropTypes.number,
    totalPnlCad: PropTypes.number,
    totalEquityCad: PropTypes.number,
    annualizedReturnRate: PropTypes.number,
    annualizedReturnAsOf: PropTypes.string,
    annualizedReturnIncomplete: PropTypes.bool,
    annualizedReturnStartDate: PropTypes.string,
    periodStartDate: PropTypes.string,
    periodEndDate: PropTypes.string,
    returnBreakdown: PropTypes.arrayOf(
      PropTypes.shape({
        period: PropTypes.string,
        months: PropTypes.number,
        startDate: PropTypes.string,
        totalReturnCad: PropTypes.number,
        annualizedRate: PropTypes.number,
      })
    ),
  }),
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  displayTotalEquity: PropTypes.number,
  usdToCadRate: PropTypes.number,
  onShowPeople: PropTypes.func,
  peopleDisabled: PropTypes.bool,
  onShowCashBreakdown: PropTypes.func,
  onShowPnlBreakdown: PropTypes.func,
  onShowTotalPnl: PropTypes.func,
  onShowAnnualizedReturn: PropTypes.func,
  isRefreshing: PropTypes.bool,
  isAutoRefreshing: PropTypes.bool,
  onCopySummary: PropTypes.func,
  onEstimateFutureCagr: PropTypes.func,
  onMarkRebalanced: PropTypes.func,
  onPlanInvestEvenly: PropTypes.func,
  onCheckTodos: PropTypes.func,
  chatUrl: PropTypes.string,
  showQqqTemperature: PropTypes.bool,
  qqqSummary: PropTypes.shape({
    status: PropTypes.oneOf(['loading', 'ready', 'refreshing', 'error']),
    temperature: PropTypes.number,
    date: PropTypes.string,
    message: PropTypes.string,
  }),
  onShowInvestmentModel: PropTypes.func,
  benchmarkComparison: PropTypes.shape({
    status: PropTypes.string,
    data: PropTypes.shape({
      startDate: PropTypes.string,
      endDate: PropTypes.string,
      sp500: PropTypes.shape({
        name: PropTypes.string,
        symbol: PropTypes.string,
        startDate: PropTypes.string,
        endDate: PropTypes.string,
        startPrice: PropTypes.number,
        endPrice: PropTypes.number,
        returnRate: PropTypes.number,
        source: PropTypes.string,
      }),
      qqq: PropTypes.shape({
        name: PropTypes.string,
        symbol: PropTypes.string,
        startDate: PropTypes.string,
        endDate: PropTypes.string,
        startPrice: PropTypes.number,
        endPrice: PropTypes.number,
        returnRate: PropTypes.number,
        source: PropTypes.string,
      }),
      interestRate: PropTypes.shape({
        name: PropTypes.string,
        symbol: PropTypes.string,
        startDate: PropTypes.string,
        endDate: PropTypes.string,
        averageRate: PropTypes.number,
        periodReturn: PropTypes.number,
        periodDays: PropTypes.number,
        dataPoints: PropTypes.number,
        source: PropTypes.string,
      }),
    }),
    error: PropTypes.instanceOf(Error),
  }),
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
  onShowCashBreakdown: null,
  onShowPnlBreakdown: null,
  onShowTotalPnl: null,
  onShowAnnualizedReturn: null,
  isRefreshing: false,
  isAutoRefreshing: false,
  onCopySummary: null,
  onEstimateFutureCagr: null,
  onMarkRebalanced: null,
  onPlanInvestEvenly: null,
  onCheckTodos: null,
  chatUrl: null,
  showQqqTemperature: false,
  qqqSummary: null,
  fundingSummary: null,
  onShowInvestmentModel: null,
  benchmarkComparison: null,
};
