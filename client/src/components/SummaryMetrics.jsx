import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

function MetricRow({
  label,
  value,
  extra,
  tone,
  className,
  onActivate,
  tooltip,
  extraTooltip,
  onContextMenuRequest,
  contextMenuOpen,
}) {
  const rowClass = className ? `equity-card__metric-row ${className}` : 'equity-card__metric-row';
  const interactive = typeof onActivate === 'function';
  const supportsContextMenu = typeof onContextMenuRequest === 'function';

  const handleKeyDown = (event) => {
    if (supportsContextMenu && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget?.getBoundingClientRect();
      let x = rect ? rect.left + rect.width / 2 : 0;
      let y = rect ? rect.top + rect.height : 0;
      if (!rect && typeof window !== 'undefined') {
        x = window.innerWidth / 2;
        y = window.innerHeight / 2;
      }
      onContextMenuRequest(x, y, { viaKeyboard: true, event });
      return;
    }
    if (interactive && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onActivate();
    }
  };

  const interactiveProps = {};
  if (interactive) {
    interactiveProps.role = 'button';
    interactiveProps.onClick = onActivate;
    interactiveProps['data-interactive'] = 'true';
  }
  if (interactive || supportsContextMenu) {
    interactiveProps.tabIndex = 0;
    interactiveProps.onKeyDown = handleKeyDown;
  }
  if (supportsContextMenu) {
    interactiveProps.onContextMenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const x = event.clientX ?? 0;
      const y = event.clientY ?? 0;
      onContextMenuRequest(x, y, { viaKeyboard: false, event });
    };
    interactiveProps['aria-haspopup'] = 'menu';
    if (typeof contextMenuOpen === 'boolean') {
      interactiveProps['aria-expanded'] = contextMenuOpen ? 'true' : 'false';
    }
  }

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
  label: PropTypes.node.isRequired,
  value: PropTypes.string.isRequired,
  extra: PropTypes.node,
  tone: PropTypes.oneOf(['positive', 'negative', 'neutral']).isRequired,
  className: PropTypes.string,
  onActivate: PropTypes.func,
  tooltip: PropTypes.string,
  extraTooltip: PropTypes.string,
  onContextMenuRequest: PropTypes.func,
  contextMenuOpen: PropTypes.bool,
};

MetricRow.defaultProps = {
  extra: null,
  className: '',
  onActivate: null,
  tooltip: null,
  extraTooltip: null,
  onContextMenuRequest: null,
  contextMenuOpen: undefined,
};

function ActionMenu({
  onCopySummary,
  onShowProjections,
  onEstimateCagr,
  onPlanInvestEvenly,
  onMarkRebalanced,
  onSetPlanningContext,
  onEditTargetProportions,
  onEditAccountDetails,
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
  const hasProjectionsAction = typeof onShowProjections === 'function';
  const hasEstimateAction = typeof onEstimateCagr === 'function';
  const hasInvestEvenlyAction = typeof onPlanInvestEvenly === 'function';
  const hasMarkRebalancedAction = typeof onMarkRebalanced === 'function';
  const hasPlanningContextAction = typeof onSetPlanningContext === 'function';
  const hasTargetProportionAction = typeof onEditTargetProportions === 'function';
  const hasEditAccountDetailsAction = typeof onEditAccountDetails === 'function';

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

  const handleShowProjections = async () => {
    if (!onShowProjections || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onShowProjections();
    } catch (error) {
      console.error('Failed to open Projections dialog', error);
    } finally {
      setBusy(false);
      setOpen(false);
    }
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

  const handleSetPlanningContext = async () => {
    if (!onSetPlanningContext || disabled || busy) {
      return;
    }
    setBusy(true);
    try {
      await onSetPlanningContext();
    } catch (error) {
      console.error('Failed to update planning context', error);
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

  const handleEditTargetProportions = () => {
    if (!onEditTargetProportions || disabled || busy) {
      return;
    }
    setOpen(false);
    onEditTargetProportions();
  };

  const handleEditAccountDetails = () => {
    if (!onEditAccountDetails || disabled || busy) {
      return;
    }
    setOpen(false);
    onEditAccountDetails();
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
          {hasPlanningContextAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleSetPlanningContext}
                disabled={busy}
              >
                Set planning context
              </button>
            </li>
          )}
          {hasProjectionsAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleShowProjections}
                disabled={busy}
              >
                Projections
              </button>
            </li>
          )}
          {hasEditAccountDetailsAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleEditAccountDetails}
                disabled={busy}
              >
                Edit account details
              </button>
            </li>
          )}
          {hasTargetProportionAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleEditTargetProportions}
                disabled={busy}
              >
                Manage target proportions
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
  onShowProjections: PropTypes.func,
  onEstimateCagr: PropTypes.func,
  onPlanInvestEvenly: PropTypes.func,
  onMarkRebalanced: PropTypes.func,
  onSetPlanningContext: PropTypes.func,
  onEditTargetProportions: PropTypes.func,
  onEditAccountDetails: PropTypes.func,
  disabled: PropTypes.bool,
  chatUrl: PropTypes.string,
};

ActionMenu.defaultProps = {
  onCopySummary: null,
  onShowProjections: null,
  onEstimateCagr: null,
  onPlanInvestEvenly: null,
  onMarkRebalanced: null,
  onSetPlanningContext: null,
  onEditTargetProportions: null,
  onEditAccountDetails: null,
  disabled: false,
  chatUrl: null,
};

export default function SummaryMetrics({
  currencyOption,
  currencyOptions,
  onCurrencyChange,
  balances,
  deploymentSummary,
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
  onShowProjections,
  onMarkRebalanced,
  onPlanInvestEvenly,
  onSetPlanningContext,
  onEditTargetProportions,
  onEditAccountDetails,
  chatUrl,
  showQqqTemperature,
  qqqSummary,
  onShowInvestmentModel,
  benchmarkComparison,
  totalPnlRangeOptions,
  selectedTotalPnlRange,
  onTotalPnlRangeChange,
  onAdjustDeployment,
  symbolMode = false,
  childAccounts,
  parentGroups,
  onSelectAccount,
  childAccountParentTotal,
  onShowChildPnlBreakdown,
  onShowChildTotalPnl,
}) {
  const totalPnlRangeId = useId();
  const title = 'Total equity (Combined in CAD)';
  const totalEquity = balances?.totalEquity ?? null;
  const marketValue = balances?.marketValue ?? null;
  const cash = balances?.cash ?? null;
  const deploymentAvailable =
    deploymentSummary &&
    (Number.isFinite(deploymentSummary.deployedValue) ||
      Number.isFinite(deploymentSummary.reserveValue) ||
      Number.isFinite(deploymentSummary.deployedPercent) ||
      Number.isFinite(deploymentSummary.reservePercent));
  const isCombinedView =
    currencyOption?.scope === 'combined' &&
    (currencyOption?.currency === 'CAD' || currencyOption?.currency === 'USD');
  const showDeploymentBreakdown = !symbolMode && deploymentAvailable && isCombinedView;
  const deployedValue = Number.isFinite(deploymentSummary?.deployedValue)
    ? deploymentSummary.deployedValue
    : 0;
  const reserveValue = Number.isFinite(deploymentSummary?.reserveValue)
    ? deploymentSummary.reserveValue
    : 0;
  const percentDisplayOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  const deployedPercentLabel = Number.isFinite(deploymentSummary?.deployedPercent)
    ? `(${formatNumber(deploymentSummary.deployedPercent, percentDisplayOptions)}%)`
    : null;
  const reservePercentLabel = Number.isFinite(deploymentSummary?.reservePercent)
    ? `(${formatNumber(deploymentSummary.reservePercent, percentDisplayOptions)}%)`
    : null;

  const totalPnlValue = Number.isFinite(fundingSummary?.totalPnlCad)
    ? fundingSummary.totalPnlCad
    : Number.isFinite(pnl?.totalPnl)
      ? pnl.totalPnl
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
  const formattedNetDeposits = symbolMode ? null : (netDepositsValue !== null ? formatMoney(netDepositsValue) : null);

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

  const normalizedRangeOptions = Array.isArray(totalPnlRangeOptions) ? totalPnlRangeOptions : [];
  const resolvedRangeValue = normalizedRangeOptions.some((option) => option.value === selectedTotalPnlRange)
    ? selectedTotalPnlRange
    : normalizedRangeOptions[0]?.value || 'all';
  const showRangeSelector =
    normalizedRangeOptions.length > 1 && typeof onTotalPnlRangeChange === 'function';
  const handleTotalPnlRangeSelect = (event) => {
    if (typeof onTotalPnlRangeChange === 'function') {
      onTotalPnlRangeChange(event.target.value);
    }
  };
  let totalPnlRangeSelector = null;
  if (normalizedRangeOptions.length > 0) {
    if (showRangeSelector) {
      totalPnlRangeSelector = (
        <select
          id={totalPnlRangeId}
          className="total-pnl-range__select"
          value={resolvedRangeValue}
          onChange={handleTotalPnlRangeSelect}
          aria-label="Select Total P&L range"
        >
          {normalizedRangeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    } else {
      totalPnlRangeSelector = (
        <span className="total-pnl-range__text">{normalizedRangeOptions[0].label}</span>
      );
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

  const totalPnlRangeNode = totalPnlRangeSelector ? (
    <div
      className="total-pnl-range"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {totalPnlRangeSelector}
    </div>
  ) : null;

  const normalizedChildAccounts = Array.isArray(childAccounts)
    ? childAccounts
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const rawId =
            entry.id !== undefined && entry.id !== null ? String(entry.id).trim() : '';
          if (!rawId) {
            return null;
          }
          const label =
            typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : '';
          if (!label) {
            return null;
          }
          const totalCandidate =
            entry.totalEquityCad === undefined || entry.totalEquityCad === null
              ? null
              : Number(entry.totalEquityCad);
          const totalEquityCad = Number.isFinite(totalCandidate) ? totalCandidate : null;
          const dayCandidate =
            entry.dayPnlCad === undefined || entry.dayPnlCad === null
              ? null
              : Number(entry.dayPnlCad);
          const dayPnlCad = Number.isFinite(dayCandidate) ? dayCandidate : null;
          const href =
            typeof entry.href === 'string' && entry.href.trim() ? entry.href.trim() : null;
          const kind = entry.kind === 'group' ? 'group' : 'account';
          const cagrStartDate =
            typeof entry.cagrStartDate === 'string' && entry.cagrStartDate.trim()
              ? entry.cagrStartDate.trim()
              : null;
          const supportsCagrToggle = entry.supportsCagrToggle === true;
          return {
            id: rawId,
            label,
            totalEquityCad,
            dayPnlCad,
            href,
            kind,
            cagrStartDate,
            supportsCagrToggle,
          };
        })
        .filter(Boolean)
    : [];
  const normalizedParentGroups = Array.isArray(parentGroups)
    ? parentGroups
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return null;
          }
          const rawId =
            entry.id !== undefined && entry.id !== null ? String(entry.id).trim() : '';
          if (!rawId) {
            return null;
          }
          const label =
            typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : '';
          if (!label) {
            return null;
          }
          const href =
            typeof entry.href === 'string' && entry.href.trim() ? entry.href.trim() : null;
          return {
            id: rawId,
            label,
            href,
          };
        })
        .filter(Boolean)
    : [];
  const resolvedChildParentTotal = Number.isFinite(childAccountParentTotal)
    ? childAccountParentTotal
    : null;

  const hasTotalMenuActions =
    typeof onShowTotalPnl === 'function' || typeof onShowPnlBreakdown === 'function';

  const [totalMenuState, setTotalMenuState] = useState({ open: false, x: 0, y: 0 });
  const totalMenuRef = useRef(null);

  const closeTotalMenu = useCallback(() => {
    setTotalMenuState((state) => (state.open ? { open: false, x: 0, y: 0 } : state));
  }, []);

  const openTotalMenu = useCallback((x, y) => {
    let targetX = x;
    let targetY = y;
    if (typeof window !== 'undefined') {
      const padding = 12;
      const estimatedWidth = 220;
      const estimatedHeight = 96;
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      targetX = Math.min(Math.max(padding, targetX), Math.max(padding, viewportWidth - estimatedWidth));
      targetY = Math.min(Math.max(padding, targetY), Math.max(padding, viewportHeight - estimatedHeight));
    }
    setTotalMenuState({ open: true, x: targetX, y: targetY });
  }, []);

  useEffect(() => {
    if (!totalMenuState.open) {
      return undefined;
    }
    const handlePointer = (event) => {
      if (totalMenuRef.current && totalMenuRef.current.contains(event.target)) {
        return;
      }
      closeTotalMenu();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTotalMenu();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('contextmenu', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('contextmenu', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [totalMenuState.open, closeTotalMenu]);

  useEffect(() => {
    if (!hasTotalMenuActions) {
      closeTotalMenu();
    }
  }, [hasTotalMenuActions, closeTotalMenu]);

  const [childMenuState, setChildMenuState] = useState({ open: false, x: 0, y: 0, child: null });
  const childMenuRef = useRef(null);

  const closeChildMenu = useCallback(() => {
    setChildMenuState((state) => (state.open ? { open: false, x: 0, y: 0, child: null } : state));
  }, []);

  const childMenuTarget = childMenuState.child;

  const handleTotalContextMenuRequest = useCallback(
    (x, y) => {
      if (!hasTotalMenuActions) {
        return;
      }
      closeChildMenu();
      openTotalMenu(x, y);
    },
    [hasTotalMenuActions, openTotalMenu, closeChildMenu]
  );

  const handleTotalMenuAction = useCallback(
    (action) => {
      closeTotalMenu();
      if (action === 'graph' && typeof onShowTotalPnl === 'function') {
        onShowTotalPnl();
      } else if (action === 'breakdown' && typeof onShowPnlBreakdown === 'function') {
        onShowPnlBreakdown('total');
      }
    },
    [onShowTotalPnl, onShowPnlBreakdown, closeTotalMenu]
  );

  useEffect(() => {
    if (!childMenuState.open) {
      return undefined;
    }
    const handlePointer = (event) => {
      if (childMenuRef.current && childMenuRef.current.contains(event.target)) {
        return;
      }
      closeChildMenu();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeChildMenu();
      }
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('contextmenu', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('contextmenu', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [childMenuState.open, closeChildMenu]);

  const openChildMenu = useCallback((x, y, child) => {
    if (!child) {
      return;
    }
    let targetX = x;
    let targetY = y;
    if (typeof window !== 'undefined') {
      const padding = 12;
      const estimatedWidth = 220;
      const estimatedHeight = 140;
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      targetX = Math.min(Math.max(padding, targetX), Math.max(padding, viewportWidth - estimatedWidth));
      targetY = Math.min(Math.max(padding, targetY), Math.max(padding, viewportHeight - estimatedHeight));
    }
    setChildMenuState({ open: true, x: targetX, y: targetY, child });
  }, []);

  const handleChildContextMenu = useCallback(
    (event, child) => {
      event.preventDefault();
      event.stopPropagation();
      if (!child) {
        return;
      }
      const x = event.clientX ?? 0;
      const y = event.clientY ?? 0;
      openChildMenu(x, y, child);
    },
    [openChildMenu]
  );

  const handleChildKeyDown = useCallback(
    (event, child) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget?.getBoundingClientRect();
        let x = rect ? rect.left + rect.width / 2 : 0;
        let y = rect ? rect.top + rect.height : 0;
        if (!rect && typeof window !== 'undefined') {
          x = window.innerWidth / 2;
          y = window.innerHeight / 2;
        }
        openChildMenu(x, y, child);
      }
    },
    [openChildMenu]
  );

  const handleChildMenuAction = useCallback(
    (action) => {
      if (!childMenuTarget) {
        closeChildMenu();
        return;
      }
      const child = childMenuTarget;
      if ((action === 'day' || action === 'open') && typeof onShowChildPnlBreakdown === 'function') {
        onShowChildPnlBreakdown(child.id, action);
      } else if (action === 'total' && typeof onShowChildTotalPnl === 'function') {
        onShowChildTotalPnl(child.id, child);
      }
      closeChildMenu();
    },
    [childMenuTarget, onShowChildPnlBreakdown, onShowChildTotalPnl, closeChildMenu]
  );

  const formatChildPnlPercent = (change, total) => {
    if (!Number.isFinite(change)) {
      if (change === 0) {
        return formatSignedPercent(0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return null;
    }
    if (change === 0) {
      return formatSignedPercent(0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (!Number.isFinite(change) || !Number.isFinite(total)) {
      return null;
    }
    const baseValue = total - change;
    if (!Number.isFinite(baseValue) || Math.abs(baseValue) < 1e-9) {
      return null;
    }
    const percentValue = (change / baseValue) * 100;
    if (!Number.isFinite(percentValue)) {
      return null;
    }
    return formatSignedPercent(percentValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatChildSharePercent = (value, parentTotal) => {
    if (!Number.isFinite(value)) {
      return null;
    }
    if (!Number.isFinite(parentTotal) || Math.abs(parentTotal) < 1e-9) {
      if (value === 0 && Number.isFinite(parentTotal)) {
        return formatPercent(0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return null;
    }
    const percentValue = (value / parentTotal) * 100;
    if (!Number.isFinite(percentValue)) {
      return null;
    }
    return formatPercent(percentValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const handleChildAccountClick = (event, accountId, href) => {
    if (!accountId) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) {
      return;
    }
    event.preventDefault();
    closeChildMenu();
    if (typeof onSelectAccount === 'function') {
      onSelectAccount(accountId);
    } else if (href && typeof window !== 'undefined') {
      window.location.href = href;
    }
  };

  const handleParentGroupClick = (event, accountId, href) => {
    if (!accountId) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) {
      return;
    }
    event.preventDefault();
    closeChildMenu();
    if (typeof onSelectAccount === 'function') {
      onSelectAccount(accountId);
    } else if (href && typeof window !== 'undefined') {
      window.location.href = href;
    }
  };

  const childAccountList = normalizedChildAccounts.length ? (
    <div className="equity-card__children" aria-live="polite">
      <h3 className="equity-card__children-title">Child accounts</h3>
      <ul className="equity-card__children-list">
        {normalizedChildAccounts.map((child) => {
          const href = child.href || `?accountId=${encodeURIComponent(child.id)}`;
          const tone = Number.isFinite(child.dayPnlCad) ? classifyPnL(child.dayPnlCad) : 'neutral';
          const pnlPercentLabel = formatChildPnlPercent(child.dayPnlCad, child.totalEquityCad);
          const shareLabel = formatChildSharePercent(child.totalEquityCad, resolvedChildParentTotal);
          return (
            <li key={child.id} className="equity-card__children-item">
              <a
                href={href}
                className="equity-card__children-link"
                onClick={(event) => handleChildAccountClick(event, child.id, href)}
                onContextMenu={(event) => handleChildContextMenu(event, child)}
                onKeyDown={(event) => handleChildKeyDown(event, child)}
                aria-haspopup="menu"
                aria-expanded={
                  childMenuState.open && childMenuTarget && childMenuTarget.id === child.id
                    ? 'true'
                    : 'false'
                }
              >
                <span className="equity-card__children-name">{child.label}</span>
                <div className="equity-card__children-meta">
                  <span className="equity-card__children-value">
                    {formatMoney(child.totalEquityCad)}
                    {shareLabel ? (
                      <span className="equity-card__children-share">{` · ${shareLabel}`}</span>
                    ) : null}
                  </span>
                  <span
                    className={`equity-card__children-pnl equity-card__children-pnl--${tone}`}
                    data-kind={child.kind}
                  >
                    <span className="equity-card__children-pnl-label">Today:</span>
                    <span className="equity-card__children-pnl-value">
                      {formatSignedMoney(child.dayPnlCad)}
                      {pnlPercentLabel ? (
                        <span className="equity-card__children-percent">{` (${pnlPercentLabel})`}</span>
                      ) : null}
                    </span>
                  </span>
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  const parentGroupList = normalizedParentGroups.length ? (
    <div className="equity-card__parents" aria-live="polite">
      <h3 className="equity-card__children-title">Parent</h3>
      <ul className="equity-card__parents-list">
        {normalizedParentGroups.map((group) => {
          const href = group.href || `?accountId=${encodeURIComponent(group.id)}`;
          return (
            <li key={group.id} className="equity-card__parents-item">
              <a
                href={href}
                className="equity-card__parents-link"
                onClick={(event) => handleParentGroupClick(event, group.id, href)}
              >
                <span className="equity-card__parents-name">{group.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  const childContextMenu = childMenuState.open ? (
    <div
      ref={childMenuRef}
      className="equity-card__children-menu"
      style={{ top: `${childMenuState.y}px`, left: `${childMenuState.x}px` }}
      role="menu"
      aria-label={
        childMenuTarget
          ? `Actions for ${childMenuTarget.label}`
          : 'Child account actions'
      }
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="equity-card__children-menu-item"
        onClick={() => handleChildMenuAction('day')}
      >
        Today's P&amp;L
      </button>
      <button
        type="button"
        className="equity-card__children-menu-item"
        onClick={() => handleChildMenuAction('open')}
      >
        Open P&amp;L
      </button>
      <button
        type="button"
        className="equity-card__children-menu-item"
        onClick={() => handleChildMenuAction('total')}
      >
        Total P&amp;L
      </button>
    </div>
  ) : null;

  const totalContextMenu = totalMenuState.open ? (
    <div
      ref={totalMenuRef}
      className="equity-card__context-menu"
      style={{ top: `${totalMenuState.y}px`, left: `${totalMenuState.x}px` }}
      role="menu"
      aria-label="Total P&L actions"
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {typeof onShowTotalPnl === 'function' && (
        <button
          type="button"
          className="equity-card__context-menu-item"
          onClick={() => handleTotalMenuAction('graph')}
        >
          Graph
        </button>
      )}
      {typeof onShowPnlBreakdown === 'function' && (
        <button
          type="button"
          className="equity-card__context-menu-item"
          onClick={() => handleTotalMenuAction('breakdown')}
        >
          Breakdown
        </button>
      )}
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
            onShowProjections ||
            onEstimateFutureCagr ||
            onPlanInvestEvenly ||
            onMarkRebalanced ||
            onSetPlanningContext ||
            onEditTargetProportions ||
            onEditAccountDetails ||
            chatUrl) && (
            <ActionMenu
              onCopySummary={onCopySummary}
              onShowProjections={onShowProjections}
              onEstimateCagr={onEstimateFutureCagr}
              onPlanInvestEvenly={onPlanInvestEvenly}
              onMarkRebalanced={onMarkRebalanced}
              onSetPlanningContext={onSetPlanningContext}
              onEditTargetProportions={onEditTargetProportions}
              onEditAccountDetails={onEditAccountDetails}
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

      {currencyOptions.length > 0 && !symbolMode && (
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
            onActivate={symbolMode ? null : (onShowPnlBreakdown ? () => onShowPnlBreakdown('day') : null)}
          />
          <MetricRow
            label="Open P&L"
            value={formattedOpen}
            extra={openPercent ? `(${openPercent})` : null}
            tone={openTone}
            onActivate={symbolMode ? null : (onShowPnlBreakdown ? () => onShowPnlBreakdown('open') : null)}
          />
          <MetricRow
            label="Total P&L"
            value={formattedTotal}
            extra={totalExtraPercent}
            extraTooltip={totalExtraPercentTooltip}
            tone={totalTone}
            className={hasDetailLines ? 'equity-card__metric-row--total-with-details' : ''}
            onActivate={onShowTotalPnl}
            onContextMenuRequest={handleTotalContextMenuRequest}
            contextMenuOpen={totalMenuState.open}
          />
          {!symbolMode && totalPnlRangeNode}
          {!symbolMode && totalDetailBlock}
          <MetricRow
            label="Annualized return"
            tooltip="The equivalent constant yearly rate (with compounding) that gets from start value to today."
            value={formattedCagr}
            tone={cagrTone}
            onActivate={symbolMode ? null : (canShowReturnBreakdown ? onShowAnnualizedReturn : null)}
          />
          {formattedNetDeposits && <MetricRow label="Net deposits" value={formattedNetDeposits} tone="neutral" />}
        </dl>
        <dl className="equity-card__metric-column">
          <MetricRow label="Total equity" value={formatMoney(totalEquity)} tone="neutral" />
          <MetricRow label="Market value" value={formatMoney(marketValue)} tone="neutral" />
          {!symbolMode && (
            <MetricRow
              label="Cash"
              value={formatMoney(cash)}
              tone="neutral"
              onActivate={onShowCashBreakdown || null}
            />
          )}
          {showDeploymentBreakdown && (
            <MetricRow
              label="Deployed"
              value={formatMoney(deployedValue)}
              extra={deployedPercentLabel}
              tone="neutral"
              onActivate={onAdjustDeployment}
            />
          )}
          {showDeploymentBreakdown && (
            <MetricRow
              label="Reserve"
              value={formatMoney(reserveValue)}
              extra={reservePercentLabel}
              tone="neutral"
              onActivate={onAdjustDeployment}
            />
          )}
        </dl>
      </div>

      {parentGroupList}
      {childAccountList}
      {childContextMenu}
      {totalContextMenu}

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
  }),
  deploymentSummary: PropTypes.shape({
    deployedValue: PropTypes.number,
    deployedPercent: PropTypes.number,
    reserveValue: PropTypes.number,
    reservePercent: PropTypes.number,
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
  onShowProjections: PropTypes.func,
  onMarkRebalanced: PropTypes.func,
  onPlanInvestEvenly: PropTypes.func,
  onSetPlanningContext: PropTypes.func,
  onEditTargetProportions: PropTypes.func,
  onEditAccountDetails: PropTypes.func,
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
  totalPnlRangeOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
    })
  ),
  selectedTotalPnlRange: PropTypes.string,
  onTotalPnlRangeChange: PropTypes.func,
  onAdjustDeployment: PropTypes.func,
  symbolMode: PropTypes.bool,
  childAccounts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      totalEquityCad: PropTypes.number,
      dayPnlCad: PropTypes.number,
      href: PropTypes.string,
      kind: PropTypes.oneOf(['account', 'group']),
      cagrStartDate: PropTypes.string,
      supportsCagrToggle: PropTypes.bool,
    })
  ),
  parentGroups: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      href: PropTypes.string,
    })
  ),
  onSelectAccount: PropTypes.func,
  childAccountParentTotal: PropTypes.number,
  onShowChildPnlBreakdown: PropTypes.func,
  onShowChildTotalPnl: PropTypes.func,
};

SummaryMetrics.defaultProps = {
  currencyOption: null,
  balances: null,
  deploymentSummary: null,
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
  onShowProjections: null,
  onMarkRebalanced: null,
  onPlanInvestEvenly: null,
  onSetPlanningContext: null,
  onEditTargetProportions: null,
  onEditAccountDetails: null,
  chatUrl: null,
  showQqqTemperature: false,
  qqqSummary: null,
  fundingSummary: null,
  onShowInvestmentModel: null,
  benchmarkComparison: null,
  totalPnlRangeOptions: [],
  selectedTotalPnlRange: null,
  onTotalPnlRangeChange: null,
  onAdjustDeployment: null,
  symbolMode: false,
  childAccounts: [],
  parentGroups: [],
  onSelectAccount: null,
  childAccountParentTotal: null,
  onShowChildPnlBreakdown: null,
  onShowChildTotalPnl: null,
};
