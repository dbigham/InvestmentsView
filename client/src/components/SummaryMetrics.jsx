import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import TimePill from './TimePill';
import usePersistentState from '../hooks/usePersistentState';
import {
  classifyPnL,
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';
import { buildTotalPnlDisplaySeries, parseDateOnly, subtractInterval } from '../../../shared/totalPnlDisplay.js';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  PADDING, clampChartX, buildChartMetrics, buildHoverLabel,
} from './TotalPnlChartUtils';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;
const DEFAULT_CHART_METRIC = 'total-pnl';
const CHART_METRIC_OPTIONS = [
  { value: DEFAULT_CHART_METRIC, label: 'Total P&L', valueKey: 'totalPnl', deltaKey: 'totalPnlDelta' },
  {
    value: 'total-equity',
    label: 'Total Equity',
    valueKey: 'equity',
    deltaKey: 'equityDelta',
    useDisplayStartDelta: false,
    valueFormatter: (value) => formatMoney(value),
  },
  {
    value: 'price',
    label: 'Price',
    valueKey: 'price',
    deltaKey: 'priceDelta',
    symbolOnly: true,
    useDisplayStartDelta: false,
    valueFormatter: (value) => formatMoney(value),
  },
];
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
  onExplainMovement,
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
  const hasExplainMovementAction = typeof onExplainMovement === 'function';
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

  const handleExplainMovement = async () => {
    if (!onExplainMovement || disabled || busy) {
      return;
    }
    setOpen(false);
    try {
      await onExplainMovement();
    } catch (error) {
      console.error('Failed to launch explain movement prompt', error);
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
          {hasExplainMovementAction && (
            <li role="none">
              <button
                type="button"
                className="equity-card__action-menu-item"
                role="menuitem"
                onClick={handleExplainMovement}
                disabled={busy}
              >
                Explain movement
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
  onExplainMovement: PropTypes.func,
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
  onExplainMovement: null,
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
  onExplainMovement,
  onSetPlanningContext,
  onEditTargetProportions,
  onEditAccountDetails,
  chatUrl,
  showQqqTemperature,
  qqqSummary,
  onRefreshQqqTemperature,
  onShowInvestmentModel,
  benchmarkComparison,
  totalPnlRangeOptions,
  selectedTotalPnlRange,
  onTotalPnlRangeChange,
  totalPnlSeries,
  totalPnlSeriesStatus,
  totalPnlSeriesError,
  symbolPriceSeries,
  symbolPriceSeriesStatus,
  symbolPriceSeriesError,
  symbolPriceSymbol,
  symbolPriceOptions = [],
  onSymbolPriceSymbolChange,
  onAdjustDeployment,
  symbolMode = false,
  childAccounts,
  parentGroups,
  onSelectAccount,
  childAccountParentTotal,
  onShowChildPnlBreakdown,
  onShowChildTotalPnl,
  onShowRangePnlBreakdown,
  totalPnlSelectionResetKey,
  onTotalPnlSelectionCleared,
}) {
  // Local timeframe for the Total P&L chart (Since inception by default)
  const TIMEFRAME_BUTTONS = useMemo(
    () => [
      { value: '15D', label: '15D' },
      { value: '1M', label: '1M' },
      { value: '3M', label: '3M' },
      { value: '6M', label: '6M' },
      { value: '1Y', label: '1Y' },
      { value: '5Y', label: '5Y' },
      { value: '10Y', label: '10Y' },
      { value: 'ALL', label: 'Since inception' },
    ],
    []
  );
  const availableChartMetricOptions = useMemo(
    () => CHART_METRIC_OPTIONS.filter((option) => !option.symbolOnly || symbolMode),
    [symbolMode]
  );
  const [chartTimeframe, setChartTimeframe] = usePersistentState('total-pnl-chart-timeframe', 'ALL');
  const [chartMetric, setChartMetric] = usePersistentState('total-pnl-chart-metric', DEFAULT_CHART_METRIC);
  const normalizedChartMetric = availableChartMetricOptions.some((option) => option.value === chartMetric)
    ? chartMetric
    : DEFAULT_CHART_METRIC;
  const chartMetricConfig =
    availableChartMetricOptions.find((option) => option.value === normalizedChartMetric) ||
    availableChartMetricOptions[0] ||
    CHART_METRIC_OPTIONS[0];
  const isPriceMetric = chartMetricConfig.value === 'price';
  const chartMetricBaseLabel = chartMetricConfig.label;
  const chartMetricLabel = useMemo(() => {
    if (isPriceMetric && symbolMode && symbolPriceSeries?.currency) {
      return `${chartMetricBaseLabel} (${symbolPriceSeries.currency})`;
    }
    return chartMetricBaseLabel;
  }, [chartMetricBaseLabel, isPriceMetric, symbolMode, symbolPriceSeries?.currency]);
  const chartMetricAriaLabel = `${chartMetricLabel} history`;
  const chartMetricValueFormatter = useMemo(() => {
    if (isPriceMetric && symbolMode) {
      const currency = typeof symbolPriceSeries?.currency === 'string' ? symbolPriceSeries.currency : null;
      if (currency) {
        try {
          const formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
            maximumFractionDigits: 4,
          });
          return (value) => (Number.isFinite(value) ? formatter.format(value) : formatMoney(value));
        } catch {
          // ignore formatter errors and fall back to default
        }
      }
    }
    return chartMetricConfig.valueFormatter;
  }, [chartMetricConfig.valueFormatter, isPriceMetric, symbolMode, symbolPriceSeries?.currency]);
  const effectiveChartSeriesStatus =
    isPriceMetric && symbolMode ? symbolPriceSeriesStatus : totalPnlSeriesStatus;
  const effectiveChartSeriesError =
    isPriceMetric && symbolMode ? symbolPriceSeriesError : totalPnlSeriesError;
  const applyDisplayStartDelta =
    chartMetricConfig.useDisplayStartDelta !== undefined
      ? chartMetricConfig.useDisplayStartDelta
      : Boolean(totalPnlSeries?.displayStartDate);
  const isTotalPnlMetric = chartMetricConfig.valueKey === 'totalPnl';
  const totalPnlRangeId = useId();
  const chartMetricSelectId = useId();
  const priceSymbolSelectId = useId();
  useEffect(() => {
    if (!availableChartMetricOptions.some((option) => option.value === chartMetric)) {
      setChartMetric(DEFAULT_CHART_METRIC);
    }
  }, [availableChartMetricOptions, chartMetric, setChartMetric]);
  const title = 'Total equity (Combined in CAD)';
  const totalEquity = balances?.totalEquity ?? null;
  const marketValue = balances?.marketValue ?? null;
  const cash = balances?.cash ?? null;
  const usdCurrencyFormatter = useMemo(
    () => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }),
    []
  );
  const resolvedTotalEquityValue = useMemo(() => {
    const value = displayTotalEquity ?? totalEquity;
    if (value === null || value === undefined) {
      return null;
    }
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }, [displayTotalEquity, totalEquity]);
  const totalEquityUsdTooltip = useMemo(() => {
    if (
      typeof usdToCadRate !== 'number' ||
      !Number.isFinite(usdToCadRate) ||
      usdToCadRate <= 0 ||
      typeof resolvedTotalEquityValue !== 'number' ||
      !Number.isFinite(resolvedTotalEquityValue)
    ) {
      return null;
    }
    const usdValue = resolvedTotalEquityValue / usdToCadRate;
    return `≈ ${usdCurrencyFormatter.format(usdValue)} USD`;
  }, [resolvedTotalEquityValue, usdCurrencyFormatter, usdToCadRate]);
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
  const canRefreshQqqTemperature = typeof onRefreshQqqTemperature === 'function';

  // Delay the header Total P&L chart spinner to avoid brief flicker on fast loads
  const [showChartSpinner, setShowChartSpinner] = useState(false);
  useEffect(() => {
    let timer = null;
    if (effectiveChartSeriesStatus === 'loading') {
      setShowChartSpinner(false);
      timer = setTimeout(() => setShowChartSpinner(true), 750);
    } else {
      setShowChartSpinner(false);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [effectiveChartSeriesStatus]);
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
  const autoFixInfo = fundingSummary?.autoFixPendingWithdrawls;
  const autoFixApplied = autoFixInfo?.applied === true;
  const autoFixAdjustmentCad = Number.isFinite(autoFixInfo?.adjustmentCad)
    ? autoFixInfo.adjustmentCad
    : null;
  const autoFixAmountLabel =
    autoFixAdjustmentCad !== null ? formatMoney(Math.abs(autoFixAdjustmentCad)) : null;
  const autoFixBannerText =
    autoFixInfo?.note ||
    (autoFixAmountLabel
      ? `Adjusted net deposits by ${autoFixAmountLabel} to offset a suspected missing withdrawal; today's Total P&L is treated as zero.`
      : 'Applied an automated fix for a suspected missing withdrawal to keep Total P&L accurate.');

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
  const handleChartMetricChange = (event) => {
    const nextValue = event.target.value;
    if (CHART_METRIC_OPTIONS.some((option) => option.value === nextValue)) {
      setChartMetric(nextValue);
      return;
    }
    setChartMetric(DEFAULT_CHART_METRIC);
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

  const filteredTotalPnlSeries = useMemo(() => {
    if (!totalPnlSeries) {
      return [];
    }
    const baseSeries = buildTotalPnlDisplaySeries(totalPnlSeries.points, chartTimeframe, {
      displayStartDate: totalPnlSeries.displayStartDate,
      displayStartTotals: totalPnlSeries?.summary?.displayStartTotals,
    });
    const targetTotal = Number.isFinite(totalPnlValue) ? totalPnlValue : null;
    if (!baseSeries.length || targetTotal === null) {
      return baseSeries;
    }
    const lastIndex = baseSeries.length - 1;
    const last = baseSeries[lastIndex];
    const adjusted = baseSeries.slice();
    const nextLast = { ...last };

    // When a displayStartDate is present, the chart uses deltas from that
    // baseline. In this mode, interpret totalPnlValue as a since-start P&L
    // and align the last point's delta to that value while keeping the
    // absolute series shape consistent.
    if (totalPnlSeries.displayStartDate) {
      const first = adjusted[0];
      const baseline =
        first && Number.isFinite(first.totalPnl)
          ? (Number.isFinite(first.totalPnlDelta)
              ? first.totalPnl - first.totalPnlDelta
              : first.totalPnl)
          : null;
      nextLast.totalPnlDelta = targetTotal;
      if (Number.isFinite(baseline)) {
        const absoluteTotal = baseline + targetTotal;
        nextLast.totalPnl = Math.abs(absoluteTotal) < 1e-6 ? 0 : absoluteTotal;
      }
    } else {
      // Without a display start date, the chart uses absolute Total P&L.
      // Treat totalPnlValue as an absolute and adjust the last point only.
      const baseTotal = Number.isFinite(last?.totalPnl) ? last.totalPnl : null;
      if (baseTotal === null) {
        return baseSeries;
      }
      const delta = targetTotal - baseTotal;
      if (Math.abs(delta) < 1e-6) {
        return baseSeries;
      }
      nextLast.totalPnl = targetTotal;
      if (Number.isFinite(nextLast.totalPnlDelta)) {
        nextLast.totalPnlDelta += delta;
      } else {
        nextLast.totalPnlDelta = delta;
      }
    }

    adjusted[lastIndex] = nextLast;
    return adjusted;
  }, [totalPnlSeries, chartTimeframe, totalPnlValue]);

  const priceChartSeries = useMemo(() => {
    if (!symbolMode || !Array.isArray(symbolPriceSeries?.points)) {
      return [];
    }
    const normalizedPoints = symbolPriceSeries.points
      .map((point) => {
        const dateKey = typeof point?.date === 'string' ? point.date : null;
        const priceValue = Number(point?.price);
        if (!dateKey || !Number.isFinite(priceValue)) {
          return null;
        }
        return { date: dateKey, price: priceValue };
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!normalizedPoints.length) {
      return [];
    }
    let working = normalizedPoints;
    if (chartTimeframe && chartTimeframe !== 'ALL') {
      const lastEntry = normalizedPoints[normalizedPoints.length - 1];
      const lastDate = parseDateOnly(lastEntry?.date);
      const cutoff = subtractInterval(lastDate, chartTimeframe);
      if (cutoff) {
        const filtered = normalizedPoints.filter((point) => {
          const pointDate = parseDateOnly(point.date);
          if (!pointDate) {
            return false;
          }
          return pointDate >= cutoff;
        });
        if (filtered.length) {
          working = filtered;
        }
      }
    }
    let baseline = null;
    return working
      .map((point, index) => {
        const priceValue = Number(point.price);
        if (!Number.isFinite(priceValue)) {
          return null;
        }
        if (baseline === null) {
          baseline = priceValue;
        }
        const delta = priceValue - baseline;
        const normalizedDelta = Math.abs(delta) < 1e-6 ? 0 : delta;
        return {
          date: point.date,
          totalPnl: priceValue,
          totalPnlDelta: index === 0 ? 0 : normalizedDelta,
          price: priceValue,
          priceNative: priceValue,
          priceDelta: index === 0 ? 0 : normalizedDelta,
        };
      })
      .filter(Boolean);
  }, [symbolMode, symbolPriceSeries?.points, chartTimeframe]);

  const baseChartSeries = useMemo(() => {
    if (isPriceMetric && symbolMode) {
      return priceChartSeries;
    }
    return filteredTotalPnlSeries;
  }, [isPriceMetric, symbolMode, priceChartSeries, filteredTotalPnlSeries]);

  const chartSeries = useMemo(() => {
    if (!baseChartSeries.length) {
      return [];
    }
    if ((isPriceMetric && symbolMode) || isTotalPnlMetric) {
      return baseChartSeries;
    }
    const metricUsesPrice = chartMetricConfig.valueKey === 'price';
    const resolveMetricValue = (entry) => {
      const direct = entry?.[chartMetricConfig.valueKey];
      if (Number.isFinite(direct)) {
        return direct;
      }
      if (metricUsesPrice) {
        const priceCad = entry?.price ?? entry?.priceCad;
        if (Number.isFinite(priceCad)) {
          return priceCad;
        }
        const priceNative = entry?.priceNative;
        if (Number.isFinite(priceNative)) {
          return priceNative;
        }
      }
      return direct;
    };
    const resolveMetricDelta = (entry) => {
      const direct = entry?.[chartMetricConfig.deltaKey];
      if (Number.isFinite(direct)) {
        return direct;
      }
      if (metricUsesPrice) {
        const fallbackDelta = entry?.priceDelta ?? entry?.priceSinceDisplayStartCad;
        if (Number.isFinite(fallbackDelta)) {
          return fallbackDelta;
        }
      }
      return direct;
    };
    return baseChartSeries.map((entry) => {
      const nextValue = resolveMetricValue(entry);
      const nextDelta = resolveMetricDelta(entry);
      const hasNextValue = Number.isFinite(nextValue);
      const hasNextDelta = Number.isFinite(nextDelta);
      if (!hasNextValue && !hasNextDelta) {
        return entry;
      }
      return {
        ...entry,
        totalPnl: hasNextValue ? nextValue : entry.totalPnl ?? null,
        totalPnlDelta: hasNextDelta ? nextDelta : entry.totalPnlDelta ?? null,
      };
    });
  }, [baseChartSeries, chartMetricConfig, isPriceMetric, isTotalPnlMetric, symbolMode]);

  const { start: timeframeRangeStart, end: timeframeRangeEnd } = useMemo(() => {
    const endCandidates = [];
    if (filteredTotalPnlSeries.length) {
      const last = filteredTotalPnlSeries[filteredTotalPnlSeries.length - 1];
      const d = parseDateOnly(last?.date);
      if (d) endCandidates.push(d);
    }
    if (Array.isArray(totalPnlSeries?.points) && totalPnlSeries.points.length) {
      const lastRaw = totalPnlSeries.points[totalPnlSeries.points.length - 1];
      const d = parseDateOnly(lastRaw?.date);
      if (d) endCandidates.push(d);
    }
    const endFromPeriod = parseDateOnly(totalPnlSeries?.periodEndDate);
    if (endFromPeriod) endCandidates.push(endFromPeriod);
    const resolvedEnd = endCandidates.length ? new Date(Math.max(...endCandidates.map((d) => d.getTime()))) : null;
    if (!resolvedEnd) {
      return { start: null, end: null };
    }
    if (chartTimeframe && chartTimeframe !== 'ALL') {
      const start = subtractInterval(resolvedEnd, chartTimeframe);
      return { start: start ?? null, end: resolvedEnd };
    }
    return { start: null, end: null };
  }, [filteredTotalPnlSeries, totalPnlSeries?.points, totalPnlSeries?.periodEndDate, chartTimeframe]);

  const totalPnlChartMetrics = useMemo(() => {
    if (!chartSeries.length) {
      return null;
    }
    // When the series carries a displayStartDate, interpret values as deltas
    // from that baseline so the chart starts at 0 for CAGR views.
    return buildChartMetrics(chartSeries, {
      useDisplayStartDelta: applyDisplayStartDelta,
      rangeStartDate: timeframeRangeStart,
      rangeEndDate: timeframeRangeEnd,
    });
  }, [applyDisplayStartDelta, chartSeries, timeframeRangeStart, timeframeRangeEnd]);

  const totalPnlChartHasSeries = Boolean(totalPnlChartMetrics?.points?.length);
  const totalPnlChartPath = useMemo(() => {
    if (!totalPnlChartHasSeries || !totalPnlChartMetrics) {
      return null;
    }
    if (totalPnlChartMetrics.points.length === 1) {
      const point = totalPnlChartMetrics.points[0];
      return `M${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }
    return totalPnlChartMetrics.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(' ');
  }, [totalPnlChartHasSeries, totalPnlChartMetrics]);

  const totalPnlChartAxis = useMemo(() => {
    if (!totalPnlChartMetrics) {
      return [];
    }
    return totalPnlChartMetrics.axisTicks.map((value) => ({ value, y: totalPnlChartMetrics.yFor(value) }));
  }, [totalPnlChartMetrics]);

  const totalPnlChartZeroLine = useMemo(() => {
    if (!totalPnlChartMetrics) {
      return null;
    }
    if (totalPnlChartMetrics.minDomain > 0 || totalPnlChartMetrics.maxDomain < 0) {
      return null;
    }
    return totalPnlChartMetrics.yFor(0);
  }, [totalPnlChartMetrics]);

  const totalPnlChartMarker =
    totalPnlChartMetrics?.points?.[totalPnlChartMetrics.points.length - 1] ?? null;
  const chartRangeStartLabel = useMemo(() => {
    if (!totalPnlChartMetrics?.rangeStart) {
      return null;
    }
    return formatDate(totalPnlChartMetrics.rangeStart);
  }, [totalPnlChartMetrics?.rangeStart]);
  const chartRef = useRef(null);
  const [hoverX, setHoverX] = useState(null);
  const [selectionState, setSelectionState] = useState({
    anchorX: null,
    currentX: null,
    startX: null,
    endX: null,
    active: false,
  });
  const suppressClickRef = useRef(false);
  const pendingSelectionClearRef = useRef(false);
  const resetSelection = useCallback(
    () => {
      pendingSelectionClearRef.current = false;
      setSelectionState({
        anchorX: null,
        currentX: null,
        startX: null,
        endX: null,
        active: false,
      });
    },
    []
  );
  const clearSelectionAndNotify = useCallback(() => {
    resetSelection();
    if (typeof onTotalPnlSelectionCleared === 'function') {
      onTotalPnlSelectionCleared();
    }
  }, [resetSelection, onTotalPnlSelectionCleared]);
  const getRelativePoint = useCallback(
    (clientX, clientY) => {
      if (!chartRef.current) {
        return null;
      }
      const rect = chartRef.current.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return null;
      }
      const scaleX = CHART_WIDTH / rect.width;
      const scaleY = CHART_HEIGHT / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    },
    []
  );
  const resolvePointAtX = useCallback(
    (x) => {
      if (!totalPnlChartMetrics || !Number.isFinite(x) || !totalPnlChartMetrics.points.length) {
        return null;
      }
      const clampedX = clampChartX(x);
      const points = totalPnlChartMetrics.points;
      if (points.length === 1) {
        return points[0];
      }
      let low = 0;
      let high = points.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const midPoint = points[mid];
        if (!midPoint || !Number.isFinite(midPoint.x)) {
          break;
        }
        if (midPoint.x < clampedX) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      let upperIndex = Math.min(points.length - 1, Math.max(0, low));
      let lowerIndex = Math.max(0, upperIndex - 1);
      if (
        upperIndex === lowerIndex &&
        upperIndex + 1 < points.length &&
        Number.isFinite(points[upperIndex].x) &&
        points[upperIndex].x < clampedX
      ) {
        lowerIndex = upperIndex;
        upperIndex = upperIndex + 1;
      }
      const lower = points[lowerIndex];
      const upper = points[upperIndex];
      if (!lower && !upper) {
        return null;
      }
      if (!upper) {
        return lower;
      }
      if (!lower) {
        return upper;
      }
      const lowerX = Number.isFinite(lower.x) ? lower.x : clampedX;
      const upperX = Number.isFinite(upper.x) ? upper.x : clampedX;
      const span = upperX - lowerX;
      const t = span !== 0 ? Math.max(0, Math.min(1, (clampedX - lowerX) / span)) : 0;
      const interpolate = (lowerValue, upperValue) => {
        const lowerFinite = Number.isFinite(lowerValue);
        const upperFinite = Number.isFinite(upperValue);
        if (!lowerFinite && !upperFinite) {
          return undefined;
        }
        if (!lowerFinite) {
          return upperValue;
        }
        if (!upperFinite) {
          return lowerValue;
        }
        return lowerValue + (upperValue - lowerValue) * t;
      };
      const resolvedX = clampChartX(lowerX + (upperX - lowerX) * t);
      const interpolatedChartValue = interpolate(lower.chartValue, upper.chartValue);
      const interpolatedTotalPnl = interpolate(lower.totalPnl, upper.totalPnl);
      const resolvedY =
        Number.isFinite(lower.y) && Number.isFinite(upper.y)
          ? lower.y + (upper.y - lower.y) * t
          : Number.isFinite(lower.y)
            ? lower.y
            : upper.y;
      return {
        date: t < 0.5 ? lower.date : upper.date,
        totalPnl: interpolatedTotalPnl,
        chartValue: Number.isFinite(interpolatedChartValue) ? interpolatedChartValue : interpolatedTotalPnl,
        x: resolvedX,
        y: resolvedY,
      };
    },
    [totalPnlChartMetrics]
  );

  const hoverPoint = useMemo(() => {
    if (hoverX === null) {
      return null;
    }
    return resolvePointAtX(hoverX);
  }, [hoverX, resolvePointAtX]);

  // Manage mouseup to finalize drag selection
  useEffect(() => {
    if (!selectionState.active) {
      return undefined;
    }
    const handleMouseUp = () => {
      setSelectionState((state) => {
        if (!state.active) {
          return state;
        }
        const anchor = clampChartX(state.anchorX);
        const current = clampChartX(state.currentX ?? state.anchorX);
        if (!Number.isFinite(anchor) || !Number.isFinite(current)) {
          suppressClickRef.current = false;
          pendingSelectionClearRef.current = false;
          return { anchorX: null, currentX: null, startX: null, endX: null, active: false };
        }
        const delta = Math.abs(current - anchor);
        if (delta >= 3) {
          const startX = Math.min(anchor, current);
          const endX = Math.max(anchor, current);
          suppressClickRef.current = true;
          pendingSelectionClearRef.current = false;
          return { anchorX: null, currentX: null, startX, endX, active: false };
        }
        suppressClickRef.current = false;
        return { anchorX: null, currentX: null, startX: null, endX: null, active: false };
      });
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [selectionState.active]);

  // Clear selection when series changes
  useEffect(() => {
    clearSelectionAndNotify();
  }, [filteredTotalPnlSeries, priceChartSeries, symbolMode, isPriceMetric, clearSelectionAndNotify]);

  useEffect(() => {
    if (totalPnlSelectionResetKey === undefined || totalPnlSelectionResetKey === null) {
      return;
    }
    resetSelection();
  }, [totalPnlSelectionResetKey, resetSelection]);

  const selectionRange = useMemo(() => {
    if (selectionState.active) {
      const anchor = clampChartX(selectionState.anchorX);
      const current = clampChartX(selectionState.currentX ?? selectionState.anchorX);
      if (!Number.isFinite(anchor) || !Number.isFinite(current)) {
        return null;
      }
      const startX = Math.min(anchor, current);
      const endX = Math.max(anchor, current);
      const width = Math.max(0, endX - startX);
      if (!(width >= 1)) {
        return null;
      }
      return { startX, endX, width, isActive: true };
    }
    if (Number.isFinite(selectionState.startX) && Number.isFinite(selectionState.endX)) {
      const start = clampChartX(selectionState.startX);
      const end = clampChartX(selectionState.endX);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
      }
      const startX = Math.min(start, end);
      const endX = Math.max(start, end);
      const width = Math.max(0, endX - startX);
      if (!(width >= 1)) {
        return null;
      }
      return { startX, endX, width, isActive: false };
    }
    return null;
  }, [selectionState]);

  const selectionSummary = useMemo(() => {
    if (!selectionRange) {
      return null;
    }
    const startPoint = resolvePointAtX(selectionRange.startX);
    const endPoint = resolvePointAtX(selectionRange.endX);
    if (!startPoint || !endPoint) {
      return null;
    }
    const resolveValue = (point) => {
      if (Number.isFinite(point?.chartValue)) {
        return point.chartValue;
      }
      if (Number.isFinite(point?.totalPnl)) {
        return point.totalPnl;
      }
      return null;
    };
    const startValue = resolveValue(startPoint);
    const endValue = resolveValue(endPoint);
    const deltaValue =
      Number.isFinite(startValue) && Number.isFinite(endValue) ? endValue - startValue : null;
    return {
      ...selectionRange,
      startPoint,
      endPoint,
      startValue,
      endValue,
      deltaValue,
    };
  }, [selectionRange, resolvePointAtX]);

  const selectionTone = Number.isFinite(selectionSummary?.deltaValue)
    ? classifyPnL(selectionSummary.deltaValue)
    : null;
  const formattedSelectionChange = Number.isFinite(selectionSummary?.deltaValue)
    ? formatSignedMoney(selectionSummary.deltaValue)
    : null;
  const selectionLabelStyle = useMemo(() => {
    if (!selectionSummary) {
      return null;
    }
    const center = selectionSummary.startX + selectionSummary.width / 2;
    const margin = 70;
    const clampedCenter = Math.max(margin, Math.min(CHART_WIDTH - margin, center));
    const leftPercent = (clampedCenter / CHART_WIDTH) * 100;
    // Position above the chart so it doesn't obscure the line
    return { left: `${leftPercent}%`, top: '0px', transform: 'translate(-50%, -100%)' };
  }, [selectionSummary]);
  const selectionStartDateLabel = selectionSummary ? formatDate(selectionSummary.startPoint.date) : null;
  const selectionEndDateLabel = selectionSummary ? formatDate(selectionSummary.endPoint.date) : null;
  const selectionStartValueLabel = selectionSummary ? formatMoney(selectionSummary.startValue) : null;
  const selectionEndValueLabel = selectionSummary ? formatMoney(selectionSummary.endValue) : null;
  const selectionSummaryClassNames = ['pnl-dialog__selection-summary'];
  if (selectionSummary?.isActive) {
    selectionSummaryClassNames.push('pnl-dialog__selection-summary--active');
  }
  if (selectionTone) {
    selectionSummaryClassNames.push(`pnl-dialog__selection-summary--${selectionTone}`);
  }

  const hoverLabel = useMemo(() => {
    if (!hoverPoint) {
      return null;
    }
    const label = buildHoverLabel(hoverPoint, { useDisplayStartDelta: applyDisplayStartDelta });
    if (!label) {
      return null;
    }
    const resolved = !isTotalPnlMetric ? { ...label, tone: 'neutral' } : label;
    if (typeof chartMetricValueFormatter === 'function') {
      const rawValue = applyDisplayStartDelta && Number.isFinite(hoverPoint?.chartValue)
        ? hoverPoint.chartValue
        : Number.isFinite(hoverPoint?.totalPnl)
          ? hoverPoint.totalPnl
          : Number.isFinite(hoverPoint?.chartValue)
            ? hoverPoint.chartValue
            : null;
      if (Number.isFinite(rawValue)) {
        return { ...resolved, amount: chartMetricValueFormatter(rawValue) };
      }
    }
    return resolved;
  }, [hoverPoint, applyDisplayStartDelta, chartMetricValueFormatter, isTotalPnlMetric]);

  const markerHoverLabel = useMemo(() => {
    if (!totalPnlChartMarker) {
      return null;
    }
    const label = buildHoverLabel(totalPnlChartMarker, { useDisplayStartDelta: applyDisplayStartDelta });
    if (!label) {
      return null;
    }
    const resolved = !isTotalPnlMetric ? { ...label, tone: 'neutral' } : label;
    if (typeof chartMetricValueFormatter === 'function') {
      const rawValue = applyDisplayStartDelta && Number.isFinite(totalPnlChartMarker?.chartValue)
        ? totalPnlChartMarker.chartValue
        : Number.isFinite(totalPnlChartMarker?.totalPnl)
          ? totalPnlChartMarker.totalPnl
          : Number.isFinite(totalPnlChartMarker?.chartValue)
            ? totalPnlChartMarker.chartValue
            : null;
      if (Number.isFinite(rawValue)) {
        return { ...resolved, amount: chartMetricValueFormatter(rawValue) };
      }
    }
    return resolved;
  }, [applyDisplayStartDelta, chartMetricValueFormatter, isTotalPnlMetric, totalPnlChartMarker]);

  // Default action: open Total P&L breakdown when the chart is activated.
  const chartSupportsBreakdown = isTotalPnlMetric && !symbolMode;
  const selectionSupportsBreakdown = !symbolMode && typeof onShowRangePnlBreakdown === 'function';

  const handleActivateTotalPnl = useCallback(() => {
    if (!chartSupportsBreakdown) {
      return;
    }
    if (typeof onShowPnlBreakdown === 'function') {
      onShowPnlBreakdown('total');
      return;
    }
    if (typeof onShowTotalPnl === 'function') {
      onShowTotalPnl();
    }
  }, [chartSupportsBreakdown, onShowPnlBreakdown, onShowTotalPnl]);
  const markerLabel = markerHoverLabel?.amount || null;
  const labelPosition = useMemo(() => {
    const point = hoverPoint || totalPnlChartMarker;
    if (!point) {
      return null;
    }
    const leftPercent = Math.min(94, Math.max(0, (point.x / CHART_WIDTH) * 100));
    const offset = 40;
    let anchorY = point.y - offset;
    const minAnchor = PADDING.top + 8;
    const maxAnchor = CHART_HEIGHT - PADDING.bottom - 8;
    anchorY = Math.min(maxAnchor, Math.max(minAnchor, anchorY));
    const topPercent = Math.max(4, Math.min(96, (anchorY / CHART_HEIGHT) * 100));
    return { left: `${leftPercent}%`, top: `${topPercent}%`, transform: 'translate(-50%, -100%)' };
  }, [hoverPoint, totalPnlChartMarker]);

  const handleMouseMove = useCallback((event) => {
    const point = getRelativePoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    setHoverX(point.x);
    setSelectionState((state) => (state.active ? { ...state, currentX: point.x } : state));
  }, [getRelativePoint]);

  const handleMouseLeave = useCallback(() => {
    setHoverX(null);
  }, []);

  const selectionActive = selectionState.active;
  const handleMouseDown = useCallback((event) => {
    // Prevent selecting text (axis labels) while dragging
    event.preventDefault();
    if (!totalPnlChartHasSeries) {
      pendingSelectionClearRef.current = false;
      return;
    }
    const point = getRelativePoint(event.clientX, event.clientY);
    if (!point) {
      pendingSelectionClearRef.current = false;
      return;
    }
    const withinChartBounds = point.y >= PADDING.top && point.y <= CHART_HEIGHT - PADDING.bottom;
    const clickedInsideSelection =
      selectionRange &&
      !selectionActive &&
      withinChartBounds &&
      point.x >= selectionRange.startX &&
      point.x <= selectionRange.endX;
    if (
      clickedInsideSelection
    ) {
      pendingSelectionClearRef.current = false;
      setHoverX(point.x);
      suppressClickRef.current = false;
      return;
    }
    if (selectionRange && !selectionActive && withinChartBounds) {
      pendingSelectionClearRef.current = true;
    } else {
      pendingSelectionClearRef.current = false;
    }
    setHoverX(point.x);
    setSelectionState({ anchorX: point.x, currentX: point.x, startX: null, endX: null, active: true });
  }, [totalPnlChartHasSeries, getRelativePoint, selectionRange, selectionActive]);

  const triggerRangeBreakdown = useCallback(() => {
    if (
      !selectionSupportsBreakdown ||
      !selectionSummary ||
      !selectionSummary.startPoint?.date ||
      !selectionSummary.endPoint?.date
    ) {
      return;
    }
    onShowRangePnlBreakdown({
      startDate: selectionSummary.startPoint.date,
      endDate: selectionSummary.endPoint.date,
      startLabel: selectionStartDateLabel,
      endLabel: selectionEndDateLabel,
      startValueLabel: selectionStartValueLabel,
      endValueLabel: selectionEndValueLabel,
      changeLabel: formattedSelectionChange,
      deltaValue: selectionSummary.deltaValue ?? null,
    });
  }, [
    selectionSupportsBreakdown,
    selectionSummary,
    onShowRangePnlBreakdown,
    selectionStartDateLabel,
    selectionEndDateLabel,
    selectionStartValueLabel,
    selectionEndValueLabel,
    formattedSelectionChange,
  ]);

  const handleChartClick = useCallback(
    (event) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        pendingSelectionClearRef.current = false;
        return;
      }
      const hasSelectionRange = Boolean(selectionRange);
      if (hasSelectionRange) {
        const point = getRelativePoint(event.clientX, event.clientY);
        const clickedInsideSelection =
          point &&
          point.x >= (selectionRange?.startX ?? 0) &&
          point.x <= (selectionRange?.endX ?? 0) &&
          point.y >= PADDING.top &&
          point.y <= CHART_HEIGHT - PADDING.bottom;
        const canOpenRangeBreakdown =
          selectionSupportsBreakdown &&
          clickedInsideSelection &&
          selectionSummary &&
          selectionSummary.startPoint?.date &&
          selectionSummary.endPoint?.date;
        if (canOpenRangeBreakdown) {
          triggerRangeBreakdown();
          return;
        }
        if (clickedInsideSelection) {
          return;
        }
        clearSelectionAndNotify();
        return;
      }
      if (pendingSelectionClearRef.current) {
        clearSelectionAndNotify();
        return;
      }
      handleActivateTotalPnl();
    },
    [
      selectionSupportsBreakdown,
      selectionRange,
      selectionSummary,
      getRelativePoint,
      handleActivateTotalPnl,
      triggerRangeBreakdown,
      clearSelectionAndNotify,
    ]
  );

  // Always allow the Total P&L chart to render; caller controls series and status.
  const showTotalPnlChart = true;
  const showPriceSymbolSelector =
    symbolMode &&
    isPriceMetric &&
    Array.isArray(symbolPriceOptions) &&
    symbolPriceOptions.length > 1 &&
    typeof onSymbolPriceSymbolChange === 'function';

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

  const [qqqMenuState, setQqqMenuState] = useState({ open: false, x: 0, y: 0 });
  const qqqMenuRef = useRef(null);

  const closeQqqMenu = useCallback(() => {
    setQqqMenuState((state) => (state.open ? { open: false, x: 0, y: 0 } : state));
  }, []);

  const openQqqMenu = useCallback(
    (x, y) => {
      if (!canRefreshQqqTemperature) {
        return;
      }
      let targetX = x;
      let targetY = y;
      if (typeof window !== 'undefined') {
        const padding = 12;
        const estimatedWidth = 200;
        const estimatedHeight = 60;
        const viewportWidth = window.innerWidth || 0;
        const viewportHeight = window.innerHeight || 0;
        targetX = Math.min(Math.max(padding, targetX), Math.max(padding, viewportWidth - estimatedWidth));
        targetY = Math.min(Math.max(padding, targetY), Math.max(padding, viewportHeight - estimatedHeight));
      }
      closeChildMenu();
      closeTotalMenu();
      setQqqMenuState({ open: true, x: targetX, y: targetY });
    },
    [canRefreshQqqTemperature, closeChildMenu, closeTotalMenu]
  );

  useEffect(() => {
    if (!qqqMenuState.open) {
      return undefined;
    }
    const handlePointer = (event) => {
      if (qqqMenuRef.current && qqqMenuRef.current.contains(event.target)) {
        return;
      }
      closeQqqMenu();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeQqqMenu();
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
  }, [qqqMenuState.open, closeQqqMenu]);

  useEffect(() => {
    if (!canRefreshQqqTemperature) {
      closeQqqMenu();
    }
  }, [canRefreshQqqTemperature, closeQqqMenu]);

  const handleQqqContextMenu = useCallback(
    (event) => {
      if (!canRefreshQqqTemperature) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const x = event.clientX ?? 0;
      const y = event.clientY ?? 0;
      openQqqMenu(x, y);
    },
    [canRefreshQqqTemperature, openQqqMenu]
  );

  const handleQqqKeyDown = useCallback(
    (event) => {
      if (!canRefreshQqqTemperature) {
        return;
      }
      const isContextKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
      const isMenuActivation =
        (event.key === 'Enter' || event.key === ' ') &&
        (event.currentTarget?.tagName || '').toLowerCase() !== 'button';
      if (!isContextKey && !isMenuActivation) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget?.getBoundingClientRect();
      let x = rect ? rect.left + rect.width / 2 : 0;
      let y = rect ? rect.top + rect.height : 0;
      if (!rect && typeof window !== 'undefined') {
        x = window.innerWidth / 2;
        y = window.innerHeight / 2;
      }
      openQqqMenu(x, y);
    },
    [canRefreshQqqTemperature, openQqqMenu]
  );

  const handleRefreshQqqTemperature = useCallback(() => {
    closeQqqMenu();
    if (canRefreshQqqTemperature) {
      onRefreshQqqTemperature();
    }
  }, [canRefreshQqqTemperature, onRefreshQqqTemperature, closeQqqMenu]);

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
      <h3 className="equity-card__children-title">Sub accounts</h3>
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
          : 'Sub account actions'
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

  const qqqContextMenu = qqqMenuState.open ? (
    <div
      ref={qqqMenuRef}
      className="equity-card__context-menu"
      style={{ top: `${qqqMenuState.y}px`, left: `${qqqMenuState.x}px` }}
      role="menu"
      aria-label="QQQ temperature actions"
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="equity-card__context-menu-item"
        onClick={handleRefreshQqqTemperature}
      >
        Refresh
      </button>
    </div>
  ) : null;

  const qqqButtonContextProps = canRefreshQqqTemperature
    ? {
        onContextMenu: handleQqqContextMenu,
        onKeyDown: handleQqqKeyDown,
        'aria-haspopup': 'menu',
        'aria-expanded': qqqMenuState.open ? 'true' : 'false',
      }
    : {};

  const qqqLabelContextProps = canRefreshQqqTemperature
    ? {
        tabIndex: 0,
        onContextMenu: handleQqqContextMenu,
        onKeyDown: handleQqqKeyDown,
        'aria-haspopup': 'menu',
        'aria-expanded': qqqMenuState.open ? 'true' : 'false',
      }
    : {};

  return (
    <section className="equity-card">
      <header className="equity-card__header">
        <div className="equity-card__heading">
          <h2 className="equity-card__title">{title}</h2>
          <p
            className="equity-card__value"
            title={totalEquityUsdTooltip ?? undefined}
          >
            {formatMoney(displayTotalEquity ?? totalEquity)}
          </p>
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
                    maximumFractionDigits: 3,
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
                    {...qqqButtonContextProps}
                  >
                    <span className="equity-card__subtext-value">{qqqLabel}</span>
                  </button>
                  <span className="visually-hidden" role="status" aria-live="polite">
                    {qqqLabel}
                  </span>
                </>
              ) : (
                <span
                  className="equity-card__subtext-value"
                  role="status"
                  aria-live="polite"
                  {...qqqLabelContextProps}
                >
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
            onExplainMovement ||
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
              onExplainMovement={onExplainMovement}
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

      {autoFixApplied && autoFixBannerText && (
        <div className="equity-card__auto-fix-banner" role="status">
          <span className="equity-card__auto-fix-icon" aria-hidden="true">⚙</span>
          <p>{autoFixBannerText}</p>
        </div>
      )}

      {showTotalPnlChart && (
        <div className="equity-card__total-pnl-chart-header">
          <div className="equity-card__total-pnl-chart-selector">
            <select
              id={chartMetricSelectId}
              className="equity-card__total-pnl-chart-select"
              aria-label="Select chart metric"
              value={normalizedChartMetric}
              onChange={handleChartMetricChange}
            >
              {availableChartMetricOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {showPriceSymbolSelector && (
            <div className="equity-card__total-pnl-chart-selector">
              <label className="visually-hidden" htmlFor={priceSymbolSelectId}>
                Select price symbol
              </label>
                <select
                  id={priceSymbolSelectId}
                  className="equity-card__total-pnl-chart-select"
                  aria-label="Select price symbol"
                  title="Select price symbol"
                  value={symbolPriceSymbol || symbolPriceOptions[0]?.value}
                  onChange={(event) => onSymbolPriceSymbolChange(event.target.value)}
                >
                  {symbolPriceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label || option.value}
                    </option>
                  ))}
                </select>
              </div>
            )}
        </div>
      )}
      {showTotalPnlChart && (
        <div className="equity-card__total-pnl-chart" aria-label={chartMetricAriaLabel}>
          <div className="equity-card__total-pnl-chart-body qqq-section__chart-container">
            {effectiveChartSeriesStatus === 'loading' ? (
              <div className="equity-card__total-pnl-chart-loading" role="status" aria-live="polite">
                {showChartSpinner ? <span className="initial-loading__spinner" aria-hidden="true" /> : null}
              </div>
            ) : effectiveChartSeriesError ? (
              <div className="equity-card__total-pnl-chart-message">
                Unable to load {chartMetricLabel} data.
              </div>
            ) : totalPnlChartHasSeries ? (
              <>
                {chartRangeStartLabel && (
                  <div
                    className="equity-card__total-pnl-chart-start-date"
                    aria-hidden="true"
                    style={{ left: `${Math.max(0, PADDING.left) + 12}px` }}
                  >
                    {chartRangeStartLabel}
                  </div>
                )}
                <svg
                  ref={chartRef}
                  className="qqq-section__chart pnl-dialog__chart"
                  viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                  role="img"
                  aria-label={chartMetricAriaLabel}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                  style={{ cursor: chartSupportsBreakdown ? 'pointer' : 'default' }}
                  onClick={handleChartClick}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (!chartSupportsBreakdown) {
                      return;
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleActivateTotalPnl();
                    }
                  }}
                >
                  {/* Removed background surface to avoid visible border/outline on click/drag */}
                  {Number.isFinite(totalPnlChartZeroLine) && (
                    <line
                      className="qqq-section__line qqq-section__line--base"
                      x1={PADDING.left}
                      x2={CHART_WIDTH - PADDING.right}
                      y1={totalPnlChartZeroLine}
                      y2={totalPnlChartZeroLine}
                    />
                  )}
                  {totalPnlChartAxis.map((tick) => (
                    <g key={tick.value}>
                      <line
                        className="qqq-section__line qqq-section__line--guide"
                        x1={CHART_WIDTH - PADDING.right}
                        x2={CHART_WIDTH - PADDING.right + 6}
                        y1={tick.y}
                        y2={tick.y}
                      />
                      <text
                        x={CHART_WIDTH - PADDING.right + 8}
                        y={tick.y + 3}
                        className="pnl-dialog__axis-label"
                        textAnchor="start"
                      >
                        {formatMoney(tick.value, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </text>
                      <line
                        className="qqq-section__line qqq-section__line--guide"
                        x1={PADDING.left}
                        x2={CHART_WIDTH - PADDING.right}
                        y1={tick.y}
                        y2={tick.y}
                        strokeDasharray="2 4"
                      />
                    </g>
                  ))}
                  {selectionRange && (
                    <rect
                      className={
                        selectionRange.isActive
                          ? 'pnl-dialog__selection-rect pnl-dialog__selection-rect--active'
                          : 'pnl-dialog__selection-rect'
                      }
                      x={selectionRange.startX}
                      y={PADDING.top}
                      width={selectionRange.width}
                      height={totalPnlChartMetrics?.innerHeight ?? Math.max(0, CHART_HEIGHT - PADDING.top - PADDING.bottom)}
                      pointerEvents="none"
                    />
                  )}
                  {totalPnlChartPath && (
                    <path className="qqq-section__series-path" d={totalPnlChartPath} />
                  )}
                  {hoverPoint && !selectionRange && (
                    <>
                      <line
                        className="pnl-dialog__hover-line"
                        x1={hoverPoint.x}
                        x2={hoverPoint.x}
                        y1={hoverPoint.y}
                        y2={CHART_HEIGHT - PADDING.bottom}
                      />
                      <circle className="pnl-dialog__hover-marker" cx={hoverPoint.x} cy={hoverPoint.y} r="6" />
                    </>
                  )}
                  {totalPnlChartMarker && (
                    <circle
                      className="qqq-section__marker"
                      cx={totalPnlChartMarker.x}
                      cy={totalPnlChartMarker.y}
                      r="5"
                    />
                  )}
                </svg>
                {selectionSummary && selectionLabelStyle && (
                  <div
                    className={selectionSummaryClassNames.join(' ')}
                    style={selectionLabelStyle}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      triggerRangeBreakdown();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        triggerRangeBreakdown();
                      }
                    }}
                  >
                    <div className="pnl-dialog__selection-header">
                      {formattedSelectionChange && (
                        <div className="pnl-dialog__selection-metrics">
                          <span className="pnl-dialog__selection-change">{formattedSelectionChange}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        className="pnl-dialog__selection-clear"
                        onClick={(event) => {
                          event.stopPropagation();
                          clearSelectionAndNotify();
                        }}
                        aria-label="Clear selection"
                      >
                        x
                      </button>
                    </div>
                    <div className="pnl-dialog__selection-values-alt">
                      <span>
                        {selectionStartValueLabel} → {selectionEndValueLabel}
                      </span>
                    </div>
                    <div className="pnl-dialog__selection-dates">
                      {selectionStartDateLabel && selectionEndDateLabel
                        ? `${selectionStartDateLabel} – ${selectionEndDateLabel}`
                        : selectionStartDateLabel || selectionEndDateLabel}
                    </div>
                    <div className="pnl-dialog__selection-values">
                      <span>
                        {selectionStartValueLabel}  {selectionEndValueLabel}
                      </span>
                    </div>
                  </div>
                )}
                {(hoverLabel || markerLabel) && labelPosition && !selectionSummary && (
                  <div className="qqq-section__chart-label" style={labelPosition}>
                    <span className={(() => {
                      const tone = hoverLabel?.tone || markerHoverLabel?.tone;
                      const classes = ['pnl-dialog__label-amount'];
                      if (tone === 'positive' || tone === 'negative') {
                        classes.push(`pnl-dialog__label-amount--${tone}`);
                      }
                      return classes.join(' ');
                    })()}>
                      {hoverLabel ? hoverLabel.amount : markerLabel}
                    </span>
                    <span className="pnl-dialog__label-date">
                      {hoverLabel ? hoverLabel.date : (markerHoverLabel?.date || (totalPnlChartMarker?.date ? formatDate(totalPnlChartMarker.date) : null))}
                    </span>
                  </div>
                )}
              </>
            ) : effectiveChartSeriesStatus === 'success' ? (
              <div className="equity-card__total-pnl-chart-message">No {chartMetricLabel} data available.</div>
            ) : null}
          </div>
        </div>
      )}

      {/* Timeframe selector for the chart */}
      {showTotalPnlChart && (
        <div
          className="equity-card__chip-row equity-card__chip-row--timeframe"
          role="group"
          aria-label={`${chartMetricLabel} timeframe`}
        >
          {TIMEFRAME_BUTTONS.map((option) => {
            const isActive = chartTimeframe === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={isActive ? 'active' : ''}
                onClick={() => setChartTimeframe(option.value)}
                aria-pressed={isActive}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}

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
            onActivate={symbolMode ? null : (onShowPnlBreakdown ? () => onShowPnlBreakdown('total') : onShowTotalPnl)}
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
      {qqqContextMenu}
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
    autoFixPendingWithdrawls: PropTypes.shape({
      applied: PropTypes.bool,
      adjustmentCad: PropTypes.number,
      appliedAt: PropTypes.string,
      note: PropTypes.string,
    }),
  }),
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  displayTotalEquity: PropTypes.number,
  usdToCadRate: PropTypes.number,
  onShowPeople: PropTypes.func,
  peopleDisabled: PropTypes.bool,
  onShowCashBreakdown: PropTypes.func,
  onShowPnlBreakdown: PropTypes.func,
  onShowRangePnlBreakdown: PropTypes.func,
  onShowTotalPnl: PropTypes.func,
  onShowAnnualizedReturn: PropTypes.func,
  isRefreshing: PropTypes.bool,
  isAutoRefreshing: PropTypes.bool,
  onCopySummary: PropTypes.func,
  onEstimateFutureCagr: PropTypes.func,
  onShowProjections: PropTypes.func,
  onMarkRebalanced: PropTypes.func,
  onPlanInvestEvenly: PropTypes.func,
  onExplainMovement: PropTypes.func,
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
  onRefreshQqqTemperature: PropTypes.func,
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
  totalPnlSeries: PropTypes.shape({
    accountId: PropTypes.string,
    periodStartDate: PropTypes.string,
    periodEndDate: PropTypes.string,
    displayStartDate: PropTypes.string,
    points: PropTypes.arrayOf(
      PropTypes.shape({
        date: PropTypes.string,
        totalPnlCad: PropTypes.number,
        totalPnlSinceDisplayStartCad: PropTypes.number,
        equityCad: PropTypes.number,
        cumulativeNetDepositsCad: PropTypes.number,
        priceCad: PropTypes.number,
        priceSinceDisplayStartCad: PropTypes.number,
        priceNative: PropTypes.number,
      })
    ),
    summary: PropTypes.shape({
      netDepositsCad: PropTypes.number,
      totalPnlCad: PropTypes.number,
      totalPnlSinceDisplayStartCad: PropTypes.number,
      totalPnlAllTimeCad: PropTypes.number,
      priceCad: PropTypes.number,
      displayStartTotals: PropTypes.shape({
        cumulativeNetDepositsCad: PropTypes.number,
        equityCad: PropTypes.number,
        totalPnlCad: PropTypes.number,
        priceCad: PropTypes.number,
      }),
    }),
  }),
  totalPnlSeriesStatus: PropTypes.oneOf(['idle', 'loading', 'success', 'error']),
  totalPnlSeriesError: PropTypes.instanceOf(Error),
  symbolPriceSeries: PropTypes.shape({
    currency: PropTypes.string,
    points: PropTypes.arrayOf(
      PropTypes.shape({
        date: PropTypes.string,
        price: PropTypes.number,
      })
    ),
  }),
  symbolPriceSeriesStatus: PropTypes.oneOf(['idle', 'loading', 'success', 'error']),
  symbolPriceSeriesError: PropTypes.instanceOf(Error),
  symbolPriceSymbol: PropTypes.string,
  symbolPriceOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string,
    })
  ),
  onSymbolPriceSymbolChange: PropTypes.func,
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
  totalPnlSelectionResetKey: PropTypes.number,
  onTotalPnlSelectionCleared: PropTypes.func,
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
  onShowRangePnlBreakdown: null,
  onShowTotalPnl: null,
  onShowAnnualizedReturn: null,
  isRefreshing: false,
  isAutoRefreshing: false,
  onCopySummary: null,
  onEstimateFutureCagr: null,
  onShowProjections: null,
  onMarkRebalanced: null,
  onPlanInvestEvenly: null,
  onExplainMovement: null,
  onSetPlanningContext: null,
  onEditTargetProportions: null,
  onEditAccountDetails: null,
  chatUrl: null,
  showQqqTemperature: false,
  qqqSummary: null,
  onRefreshQqqTemperature: null,
  fundingSummary: null,
  onShowInvestmentModel: null,
  benchmarkComparison: null,
  totalPnlSeries: null,
  totalPnlSeriesStatus: 'idle',
  totalPnlSeriesError: null,
  symbolPriceSeries: null,
  symbolPriceSeriesStatus: 'idle',
  symbolPriceSeriesError: null,
  symbolPriceSymbol: null,
  symbolPriceOptions: [],
  onSymbolPriceSymbolChange: null,
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
  totalPnlSelectionResetKey: 0,
  onTotalPnlSelectionCleared: null,
};
