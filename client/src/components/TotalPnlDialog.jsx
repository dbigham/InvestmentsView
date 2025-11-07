import { useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { classifyPnL, formatDate, formatMoney, formatSignedMoney } from '../utils/formatters';
import {
  TOTAL_PNL_TIMEFRAME_OPTIONS as TIMEFRAME_OPTIONS,
  buildTotalPnlDisplaySeries,
  parseDateOnly,
  subtractInterval,
} from '../../../shared/totalPnlDisplay.js';

const CHART_WIDTH = 680;
const CHART_HEIGHT = 260;
const PADDING = { top: 6, right: 48, bottom: 30, left: 0 };
const AXIS_TARGET_INTERVALS = 4;

function niceNumber(value, round) {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const fraction = Math.abs(value) / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) {
      niceFraction = 1;
    } else if (fraction < 3) {
      niceFraction = 2;
    } else if (fraction < 7) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
  } else if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  return Math.sign(value) * niceFraction * 10 ** exponent;
}

function buildAxisScale(minDomain, maxDomain) {
  if (!Number.isFinite(minDomain) || !Number.isFinite(maxDomain)) {
    return { minDomain, maxDomain, tickSpacing: 0, ticks: [] };
  }
  const rawRange = maxDomain - minDomain;
  if (rawRange === 0) {
    return { minDomain, maxDomain, tickSpacing: 0, ticks: [minDomain] };
  }
  const niceRange = niceNumber(rawRange, false) || rawRange;
  const spacing = niceNumber(niceRange / AXIS_TARGET_INTERVALS, true) || rawRange / AXIS_TARGET_INTERVALS;
  const niceMin = Math.floor(minDomain / spacing) * spacing;
  const niceMax = Math.ceil(maxDomain / spacing) * spacing;
  const ticks = [];
  for (let value = niceMin; value <= niceMax + spacing * 0.5; value += spacing) {
    const rounded = Math.abs(value) < spacing * 1e-6 ? 0 : Number(value.toFixed(6));
    if (!ticks.length || Math.abs(ticks[ticks.length - 1] - rounded) > spacing * 1e-6) {
      ticks.push(rounded);
    }
  }
  return {
    minDomain: niceMin,
    maxDomain: niceMax,
    tickSpacing: spacing,
    ticks,
  };
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = parseDateOnly(value);
  if (parsed) {
    return parsed;
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function toPlainDateString(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function buildChartMetrics(series, { useDisplayStartDelta = false, rangeStartDate, rangeEndDate } = {}) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }
  const resolveValue = (entry) => {
    if (!entry) {
      return null;
    }
    if (useDisplayStartDelta && Number.isFinite(entry.totalPnlDelta)) {
      return entry.totalPnlDelta;
    }
    return entry.totalPnl;
  };

  const rawValues = series.map((entry) => resolveValue(entry));
  const finiteValues = rawValues.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  const parsedDates = series.map((entry) => normalizeDate(entry?.date));
  const finiteDates = parsedDates.filter((date) => date instanceof Date && !Number.isNaN(date.getTime()));

  let resolvedRangeStartDate = normalizeDate(rangeStartDate);
  let resolvedRangeEndDate = normalizeDate(rangeEndDate);

  if (!resolvedRangeStartDate && finiteDates.length) {
    resolvedRangeStartDate = new Date(Math.min(...finiteDates.map((date) => date.getTime())));
  }
  if (!resolvedRangeEndDate && finiteDates.length) {
    resolvedRangeEndDate = new Date(Math.max(...finiteDates.map((date) => date.getTime())));
  }
  if (!resolvedRangeStartDate && resolvedRangeEndDate) {
    resolvedRangeStartDate = new Date(resolvedRangeEndDate.getTime());
  }
  if (resolvedRangeStartDate && !resolvedRangeEndDate) {
    resolvedRangeEndDate = new Date(resolvedRangeStartDate.getTime());
  }

  if (
    resolvedRangeStartDate &&
    resolvedRangeEndDate &&
    resolvedRangeStartDate.getTime() > resolvedRangeEndDate.getTime()
  ) {
    resolvedRangeEndDate = new Date(resolvedRangeStartDate.getTime());
  }

  const domainDuration =
    resolvedRangeStartDate && resolvedRangeEndDate
      ? Math.max(0, resolvedRangeEndDate.getTime() - resolvedRangeStartDate.getTime())
      : 0;

  const minValue = Math.min(...finiteValues, 0);
  const maxValue = Math.max(...finiteValues, 0);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(10, Math.abs(maxValue) * 0.1 || 10) : Math.max(10, range * 0.1);
  const rawMinDomain = minValue - padding;
  const rawMaxDomain = maxValue + padding;
  const { minDomain, maxDomain, ticks } = buildAxisScale(rawMinDomain, rawMaxDomain);
  const domainRange = maxDomain - minDomain || 1;
  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const points = series.map((entry, index) => {
    const totalValue = resolveValue(entry);
    const safeValue = Number.isFinite(totalValue) ? totalValue : 0;
    let ratio;
    const entryDate = parsedDates[index];
    if (resolvedRangeStartDate && resolvedRangeEndDate && domainDuration > 0 && entryDate) {
      ratio = (entryDate.getTime() - resolvedRangeStartDate.getTime()) / domainDuration;
    } else if (series.length === 1) {
      ratio = 0;
    } else {
      ratio = index / (series.length - 1);
    }
    const clampedRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const normalized = (safeValue - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    const y = PADDING.top + innerHeight * (1 - clamped);
    const previousValue = index > 0 ? resolveValue(series[index - 1]) : totalValue;
    const safePrevious = Number.isFinite(previousValue) ? previousValue : safeValue;
    const trend = safeValue - safePrevious;
    return { ...entry, x: PADDING.left + innerWidth * clampedRatio, y, trend, chartValue: safeValue };
  });

  const yFor = (value) => {
    const normalized = (value - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    return PADDING.top + innerHeight * (1 - clamped);
  };

  return {
    points,
    yFor,
    rangeStart: toPlainDateString(resolvedRangeStartDate) ?? series[0].date,
    rangeEnd: toPlainDateString(resolvedRangeEndDate) ?? series[series.length - 1].date,
    minDomain,
    maxDomain,
    domainRange,
    innerWidth,
    innerHeight,
    axisTicks: ticks,
  };
}

function formatIssues(issues, missingPriceSymbols) {
  if (!Array.isArray(issues) || !issues.length) {
    return [];
  }
  return issues.map((issue) => {
    if (!issue || typeof issue !== 'string') {
      return null;
    }
    if (issue === 'missing-price-data') {
      const symbols = Array.isArray(missingPriceSymbols) ? missingPriceSymbols.filter(Boolean) : [];
      if (symbols.length) {
        const unique = Array.from(new Set(symbols.map((s) => String(s).trim()))).filter(Boolean);
        unique.sort((a, b) => a.localeCompare(b));
        return `Missing price data for: ${unique.join(', ')}`;
      }
      return 'Missing price data for one or more symbols.';
    }
    if (issue.startsWith('missing-usd-rate')) {
      return 'Missing USD→CAD rate for part of the series.';
    }
    if (issue === 'funding-conversion-incomplete') {
      return 'Some funding activities could not be converted to CAD.';
    }
    if (issue.startsWith('unsupported-currency')) {
      return 'Unsupported currency detected while computing equity.';
    }
    if (issue === 'aggregate-partial-data') {
      return 'Some accounts could not be included because their Total P&L data was unavailable.';
    }
    return issue;
  }).filter(Boolean);
}

export default function TotalPnlDialog({
  onClose,
  data,
  loading,
  error,
  onRetry,
  accountLabel,
  supportsCagrToggle,
  mode,
  onModeChange,
  cagrStartDate,
  onShowBreakdown,
}) {
  const headingId = useId();
  const [timeframe, setTimeframe] = useState('ALL');
  const [hover, setHover] = useState(null);
  const selectRef = useRef(null);
  const isCagrMode = mode !== 'all';
  const formattedCagrStart = cagrStartDate ? formatDate(cagrStartDate) : null;
  const cagrToggleLabel = formattedCagrStart ? `From ${formattedCagrStart.replace(',', '')}` : null;
  const showRangeToggle = supportsCagrToggle && typeof onModeChange === 'function' && cagrToggleLabel;

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
    setTimeframe('ALL');
  }, [data?.accountId, mode]);

  useEffect(() => {
    function handleDocumentClick(event) {
      if (!selectRef.current) {
        return;
      }
      if (!selectRef.current.contains(event.target)) {
        selectRef.current.querySelector('.select-control__list')?.classList.remove('select-control__list--open');
      }
    }
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  }, []);

  const handleRangeToggle = (event) => {
    if (typeof onModeChange !== 'function') {
      return;
    }
    const nextMode = event.target.checked ? 'cagr' : 'all';
    if (nextMode !== mode) {
      onModeChange(nextMode);
    }
  };

  const filteredSeries = useMemo(
    () =>
      buildTotalPnlDisplaySeries(data?.points, timeframe, {
        displayStartDate: data?.displayStartDate,
        displayStartTotals: data?.summary?.displayStartTotals,
      }),
    [data?.points, timeframe, data?.displayStartDate, data?.summary?.displayStartTotals]
  );
  const seriesHasDisplayDelta = useMemo(
    () => filteredSeries.some((entry) => Number.isFinite(entry?.totalPnlDelta)),
    [filteredSeries]
  );
  const summaryHasDisplayDelta = Number.isFinite(data?.summary?.totalPnlSinceDisplayStartCad);
  // Only use display-start deltas when in CAGR mode; otherwise show absolute all-time values
  const useDisplayStartDelta = isCagrMode && (summaryHasDisplayDelta || seriesHasDisplayDelta);
  const { start: chartRangeStart, end: chartRangeEnd } = useMemo(() => {
    const endCandidates = [];
    if (filteredSeries.length) {
      const lastFiltered = filteredSeries[filteredSeries.length - 1];
      const parsedLastFiltered = parseDateOnly(lastFiltered?.date);
      if (parsedLastFiltered) {
        endCandidates.push(parsedLastFiltered);
      }
    }
    if (Array.isArray(data?.points) && data.points.length) {
      const lastRawPoint = data.points[data.points.length - 1];
      const parsedLastRaw = parseDateOnly(lastRawPoint?.date);
      if (parsedLastRaw) {
        endCandidates.push(parsedLastRaw);
      }
    }
    const parsedPeriodEnd = parseDateOnly(data?.periodEndDate);
    if (parsedPeriodEnd) {
      endCandidates.push(parsedPeriodEnd);
    }

    const resolvedEnd = endCandidates.length
      ? new Date(Math.max(...endCandidates.map((date) => date.getTime())))
      : null;

    if (!resolvedEnd) {
      return { start: null, end: null };
    }

    if (timeframe && timeframe !== 'ALL') {
      const resolvedStart = subtractInterval(resolvedEnd, timeframe);
      return { start: resolvedStart ?? null, end: resolvedEnd };
    }

    const startCandidates = [];
    if (filteredSeries.length) {
      const firstFiltered = filteredSeries[0];
      const parsedFirstFiltered = parseDateOnly(firstFiltered?.date);
      if (parsedFirstFiltered) {
        startCandidates.push(parsedFirstFiltered);
      }
    }
    const parsedPeriodStart = parseDateOnly(data?.periodStartDate);
    if (parsedPeriodStart) {
      startCandidates.push(parsedPeriodStart);
    }

    const resolvedStart = startCandidates.length
      ? new Date(Math.min(...startCandidates.map((date) => date.getTime())))
      : null;

    return { start: resolvedStart, end: resolvedEnd };
  }, [filteredSeries, timeframe, data?.points, data?.periodEndDate, data?.periodStartDate]);
  const chartMetrics = useMemo(
    () => buildChartMetrics(filteredSeries, { useDisplayStartDelta, rangeStartDate: chartRangeStart, rangeEndDate: chartRangeEnd }),
    [filteredSeries, useDisplayStartDelta, chartRangeStart, chartRangeEnd]
  );
  const hasChart = Boolean(chartMetrics && chartMetrics.points.length);
  const canShowBreakdown = typeof onShowBreakdown === 'function';
  const pathD = useMemo(() => {
    if (!hasChart) {
      return null;
    }
    if (chartMetrics.points.length === 1) {
      const point = chartMetrics.points[0];
      return `M${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }
    return chartMetrics.points
      .map((point, index) => {
        const prefix = index === 0 ? 'M' : 'L';
        return `${prefix}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
      })
      .join(' ');
  }, [chartMetrics, hasChart]);

  const zeroLine = useMemo(() => {
    if (!hasChart) {
      return null;
    }
    if (chartMetrics.minDomain > 0 || chartMetrics.maxDomain < 0) {
      return null;
    }
    return chartMetrics.yFor(0);
  }, [chartMetrics, hasChart]);

  const hoverPoint = useMemo(() => {
    if (!hover || !hasChart || !chartMetrics.innerWidth) {
      return null;
    }
    const clampedX = Math.max(PADDING.left, Math.min(CHART_WIDTH - PADDING.right, hover.x));
    const ratio = (clampedX - PADDING.left) / chartMetrics.innerWidth;
    const targetIndex = ratio * (chartMetrics.points.length - 1);
    const lowerIndex = Math.max(0, Math.floor(targetIndex));
    const upperIndex = Math.min(chartMetrics.points.length - 1, lowerIndex + 1);
    const t = targetIndex - lowerIndex;
    const lower = chartMetrics.points[lowerIndex];
    const upper = chartMetrics.points[upperIndex];
    const base = lower || upper;
    if (!lower || !upper || !base) {
      return base || null;
    }
    const interpX = lower.x + (upper.x - lower.x) * t;
    const clampedInterpX = Math.max(PADDING.left, Math.min(CHART_WIDTH - PADDING.right, interpX));
    const interpolate = (lowerValue, upperValue) => {
      const lowerFinite = Number.isFinite(lowerValue);
      const upperFinite = Number.isFinite(upperValue);
      if (lowerFinite && upperFinite) {
        return lowerValue + (upperValue - lowerValue) * t;
      }
      if (lowerFinite) {
        return lowerValue;
      }
      if (upperFinite) {
        return upperValue;
      }
      return undefined;
    };
    const interpolatedChartValue = interpolate(lower.chartValue, upper.chartValue);
    const interpolatedTotalPnl = interpolate(lower.totalPnl, upper.totalPnl);
    return {
      date: t < 0.5 ? lower.date : upper.date,
      totalPnl: interpolatedTotalPnl,
      chartValue: Number.isFinite(interpolatedChartValue) ? interpolatedChartValue : interpolatedTotalPnl,
      equity: lower.equity + (upper.equity - lower.equity) * t,
      netDeposits: lower.netDeposits + (upper.netDeposits - lower.netDeposits) * t,
      totalPnlDelta: interpolate(lower.totalPnlDelta, upper.totalPnlDelta),
      equityDelta: interpolate(lower.equityDelta, upper.equityDelta),
      netDepositsDelta: interpolate(lower.netDepositsDelta, upper.netDepositsDelta),
      x: clampedInterpX,
      y: lower.y + (upper.y - lower.y) * t,
      trend:
        Number.isFinite(upper.chartValue) && Number.isFinite(lower.chartValue)
          ? upper.chartValue - lower.chartValue
          : interpolate(lower.trend, upper.trend),
    };
  }, [hover, chartMetrics, hasChart]);

  const marker = hasChart ? chartMetrics.points[chartMetrics.points.length - 1] : null;
  const markerValue =
    marker && Number.isFinite(marker.chartValue) ? marker.chartValue : marker && Number.isFinite(marker.totalPnl)
      ? marker.totalPnl
      : null;
  const markerLabel = Number.isFinite(markerValue) ? formatMoney(markerValue) : null;
  const displayRangeStart = chartMetrics ? chartMetrics.rangeStart : data?.periodStartDate;
  const displayRangeEnd = chartMetrics ? chartMetrics.rangeEnd : data?.periodEndDate;
  const labelPosition = useMemo(() => {
    const point = hoverPoint || marker;
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
  }, [marker, hoverPoint]);

  const hoverLabel = hoverPoint
    ? {
        amount: formatMoney(
          useDisplayStartDelta && Number.isFinite(hoverPoint.chartValue) ? hoverPoint.chartValue : hoverPoint.totalPnl
        ),
        date: formatDate(hoverPoint.date),
      }
    : null;

  const formattedAxis = useMemo(() => {
    if (!hasChart) {
      return [];
    }
    return chartMetrics.axisTicks.map((value) => ({ value, y: chartMetrics.yFor(value) }));
  }, [chartMetrics, hasChart]);

  const handleMouseMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const scaleX = CHART_WIDTH / rect.width;
    const scaleY = CHART_HEIGHT / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    setHover({ x, y });
  };

  const handleMouseLeave = () => {
    setHover(null);
  };

  const summary = data?.summary || {};
  const totalPnlAllTime = Number.isFinite(summary.totalPnlAllTimeCad)
    ? summary.totalPnlAllTimeCad
    : null;
  const totalPnlCombined = Number.isFinite(summary.totalPnlCad) ? summary.totalPnlCad : null;
  const totalPnlSinceDisplayStart = Number.isFinite(summary.totalPnlSinceDisplayStartCad)
    ? summary.totalPnlSinceDisplayStartCad
    : null;
  const totalPnl = isCagrMode
    ? totalPnlSinceDisplayStart ?? totalPnlCombined ?? totalPnlAllTime
    : totalPnlAllTime ?? totalPnlCombined ?? totalPnlSinceDisplayStart;
  const totalPnlTone = Number.isFinite(totalPnl) ? classifyPnL(totalPnl) : null;
  const totalPnlClassNames = ['pnl-dialog__summary-value'];
  if (totalPnlTone === 'positive') {
    totalPnlClassNames.push('pnl-dialog__summary-value--positive');
  } else if (totalPnlTone === 'negative') {
    totalPnlClassNames.push('pnl-dialog__summary-value--negative');
  } else if (totalPnlTone === 'neutral') {
    totalPnlClassNames.push('pnl-dialog__summary-value--neutral');
  }
  const netDepositsCombined = Number.isFinite(summary.netDepositsCad) ? summary.netDepositsCad : null;
  const netDepositsAllTime = Number.isFinite(summary.netDepositsAllTimeCad)
    ? summary.netDepositsAllTimeCad
    : null;
  const netDeposits = isCagrMode
    ? netDepositsCombined ?? netDepositsAllTime
    : netDepositsAllTime ?? netDepositsCombined;

  const totalEquity = Number.isFinite(summary.totalEquityCad) ? summary.totalEquityCad : null;

  const normalizedIssues = useMemo(
    () => formatIssues(data?.issues, data?.missingPriceSymbols),
    [data?.issues, data?.missingPriceSymbols]
  );

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="qqq-dialog-overlay" role="presentation" onClick={handleOverlayClick}>
      <div className="qqq-dialog pnl-dialog__container" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <button type="button" className="qqq-dialog__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="qqq-dialog__content pnl-dialog__content">
          <section className="pnl-dialog" aria-labelledby={headingId}>
            <div className="pnl-dialog__header">
              <h2 id={headingId}>Total P&amp;L</h2>
              {accountLabel && <span className="pnl-dialog__account">{accountLabel}</span>}
            </div>

            {loading ? (
              <div className="pnl-dialog__loading" role="status" aria-live="polite">
                <span className="pnl-dialog__spinner" aria-hidden="true" />
                <span className="visually-hidden">Loading Total P&amp;L…</span>
              </div>
            ) : (
              <>
                <div className="pnl-dialog__summary">
                  <div className="pnl-dialog__summary-item">
                    <span className="pnl-dialog__summary-label">Total P&amp;L</span>
                    <span className={totalPnlClassNames.join(' ')}>
                      {Number.isFinite(totalPnl) ? formatSignedMoney(totalPnl) : '—'}
                    </span>
                  </div>
                  <div className="pnl-dialog__summary-item">
                    <span className="pnl-dialog__summary-label">Net deposits</span>
                    <span className="pnl-dialog__summary-value">
                      {Number.isFinite(netDeposits) ? formatMoney(netDeposits) : '—'}
                    </span>
                  </div>
                  <div className="pnl-dialog__summary-item">
                    <span className="pnl-dialog__summary-label">Total equity</span>
                    <span className="pnl-dialog__summary-value">
                      {Number.isFinite(totalEquity) ? formatMoney(totalEquity) : '—'}
                    </span>
                  </div>
                </div>

                <div className="pnl-dialog__controls">
                  <label className="pnl-dialog__control-label" htmlFor="total-pnl-timeframe">
                    Show
                  </label>
                  <div className="select-control" ref={selectRef}>
                    <button
                      id="total-pnl-timeframe"
                      type="button"
                      className="select-control__button"
                      onClick={(event) => {
                        const menu = event.currentTarget.nextSibling;
                        if (menu) {
                          menu.classList.toggle('select-control__list--open');
                        }
                      }}
                      disabled={!data || loading}
                    >
                      {TIMEFRAME_OPTIONS.find((option) => option.value === timeframe)?.label || 'Select'}
                      <span aria-hidden="true" className="select-control__chevron" />
                    </button>
                    <ul className="select-control__list" role="listbox">
                      {TIMEFRAME_OPTIONS.map((option) => (
                        <li key={option.value}>
                          <button
                            type="button"
                            className={
                              option.value === timeframe
                                ? 'select-control__option select-control__option--selected'
                                : 'select-control__option'
                            }
                            onClick={() => {
                              setTimeframe(option.value);
                              const container = document.getElementById('total-pnl-timeframe')?.nextSibling;
                              if (container) {
                                container.classList.remove('select-control__list--open');
                              }
                            }}
                            role="option"
                            aria-selected={option.value === timeframe}
                          >
                            {option.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {showRangeToggle ? (
                  <div className="pnl-dialog__range-toggle-row">
                    <label className="pnl-dialog__range-toggle">
                      <input
                        type="checkbox"
                        checked={isCagrMode}
                        onChange={handleRangeToggle}
                        disabled={loading}
                      />
                      <span>{cagrToggleLabel}</span>
                    </label>
                  </div>
                ) : null}

                {error && (
                  <div className="qqq-section__status qqq-section__status--error" role="alert">
                    <span>{error.message || 'Failed to load Total P&L series.'}</span>
                    {onRetry && (
                      <button type="button" className="qqq-section__retry" onClick={onRetry}>
                        Retry
                      </button>
                    )}
                  </div>
                )}

                {!error && hasChart && (
                  <div className="qqq-section__chart-container">
                    <svg
                      className="qqq-section__chart pnl-dialog__chart"
                      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                      role="img"
                      aria-hidden="true"
                      onMouseMove={handleMouseMove}
                      onMouseLeave={handleMouseLeave}
                    >
                      <rect className="qqq-section__chart-surface" x="0" y="0" width={CHART_WIDTH} height={CHART_HEIGHT} rx="16" />
                      {Number.isFinite(zeroLine) && (
                        <line
                          className="qqq-section__line qqq-section__line--base"
                          x1={PADDING.left}
                          x2={CHART_WIDTH - PADDING.right}
                          y1={zeroLine}
                          y2={zeroLine}
                        />
                      )}
                      {formattedAxis.map((tick) => (
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
                      {pathD && <path className="qqq-section__series-path" d={pathD} />}
                      {marker && <circle className="qqq-section__marker" cx={marker.x} cy={marker.y} r="5" />}
                      {hoverPoint && (
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
                    </svg>
                    {(hoverLabel || markerLabel) && (
                      <div className="qqq-section__chart-label" style={labelPosition}>
                        <span className="pnl-dialog__label-amount">{hoverLabel ? hoverLabel.amount : markerLabel}</span>
                        <span className="pnl-dialog__label-date">
                          {hoverLabel ? hoverLabel.date : formatDate(marker?.date)}
                        </span>
                      </div>
                    )}
                    <div className="qqq-section__chart-footer">
                      <span>{formatDate(displayRangeStart)}</span>
                      <span>{formatDate(displayRangeEnd)}</span>
                    </div>
                  </div>
                )}

                {!error && !hasChart && (
                  <div className="qqq-section__status">No Total P&amp;L data available.</div>
                )}

                {!error && normalizedIssues.length > 0 && (
                  <div className="pnl-dialog__issues" role="note">
                    <h3>Notes</h3>
                    <ul>
                      {normalizedIssues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {canShowBreakdown ? (
                  <div className="pnl-dialog__footer">
                    <button type="button" className="pnl-dialog__link-button" onClick={onShowBreakdown}>
                      See breakdown
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

TotalPnlDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
  data: PropTypes.shape({
    accountId: PropTypes.string,
    periodStartDate: PropTypes.string,
    periodEndDate: PropTypes.string,
    displayStartDate: PropTypes.string,
    points: PropTypes.arrayOf(
      PropTypes.shape({
        date: PropTypes.string,
        equityCad: PropTypes.number,
        cumulativeNetDepositsCad: PropTypes.number,
        totalPnlCad: PropTypes.number,
      })
    ),
    summary: PropTypes.shape({
      netDepositsCad: PropTypes.number,
      netDepositsAllTimeCad: PropTypes.number,
      totalEquityCad: PropTypes.number,
      totalEquitySinceDisplayStartCad: PropTypes.number,
      totalPnlCad: PropTypes.number,
      totalPnlAllTimeCad: PropTypes.number,
      totalPnlSinceDisplayStartCad: PropTypes.number,
      displayStartTotals: PropTypes.shape({
        cumulativeNetDepositsCad: PropTypes.number,
        equityCad: PropTypes.number,
        totalPnlCad: PropTypes.number,
      }),
      seriesStartTotals: PropTypes.shape({
        cumulativeNetDepositsCad: PropTypes.number,
        equityCad: PropTypes.number,
        totalPnlCad: PropTypes.number,
      }),
    }),
    issues: PropTypes.arrayOf(PropTypes.string),
  }),
  loading: PropTypes.bool,
  error: PropTypes.instanceOf(Error),
  onRetry: PropTypes.func,
  accountLabel: PropTypes.string,
  supportsCagrToggle: PropTypes.bool,
  mode: PropTypes.oneOf(['cagr', 'all']),
  onModeChange: PropTypes.func,
  cagrStartDate: PropTypes.string,
  onShowBreakdown: PropTypes.func,
};

TotalPnlDialog.defaultProps = {
  data: null,
  loading: false,
  error: null,
  onRetry: null,
  accountLabel: null,
  supportsCagrToggle: false,
  mode: 'cagr',
  onModeChange: null,
  cagrStartDate: null,
  onShowBreakdown: null,
};
