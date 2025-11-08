import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDate, formatMoney, formatNumber } from '../utils/formatters';
import { getTotalPnlSeries } from '../api/questrade';
import deploymentDisplay from '../../../shared/deploymentDisplay.js';

const {
  DEPLOYMENT_TIMEFRAME_OPTIONS: TIMEFRAME_OPTIONS,
  buildDeploymentDisplaySeries,
  parseDateOnly,
} = deploymentDisplay;

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
    return { minDomain, maxDomain, ticks: [] };
  }
  const rawRange = maxDomain - minDomain;
  if (rawRange === 0) {
    return { minDomain, maxDomain, ticks: [minDomain] };
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
  return { minDomain: niceMin, maxDomain: niceMax, ticks };
}

function buildChartMetrics(series, mode) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }

  const values = series.map((entry) => (mode === 'percent' ? entry.deployedPercent : entry.deployedValueCad));
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  const parsedDates = series.map((entry) => parseDateOnly(entry?.date));
  const finiteDates = parsedDates.filter((date) => date instanceof Date && !Number.isNaN(date.getTime()));

  let rangeStartDate = finiteDates.length
    ? new Date(Math.min(...finiteDates.map((date) => date.getTime())))
    : null;
  let rangeEndDate = finiteDates.length
    ? new Date(Math.max(...finiteDates.map((date) => date.getTime())))
    : null;
  if (rangeStartDate && rangeEndDate && rangeStartDate.getTime() > rangeEndDate.getTime()) {
    rangeEndDate = new Date(rangeStartDate.getTime());
  }

  const domainDuration =
    rangeStartDate && rangeEndDate ? Math.max(0, rangeEndDate.getTime() - rangeStartDate.getTime()) : 0;

  const minValue = Math.min(...finiteValues);
  const maxValue = Math.max(...finiteValues);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(1, Math.abs(maxValue) * 0.1 || 1) : Math.max(1, range * 0.1);
  const rawMinDomain = minValue - padding;
  const rawMaxDomain = maxValue + padding;
  const { minDomain, maxDomain, ticks } = buildAxisScale(rawMinDomain, rawMaxDomain);
  const domainRange = maxDomain - minDomain || 1;
  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const points = series.map((entry, index) => {
    const chartValue = mode === 'percent' ? entry.deployedPercent : entry.deployedValueCad;
    const safeValue = Number.isFinite(chartValue) ? chartValue : null;
    const entryDate = parsedDates[index];
    let ratio;
    if (rangeStartDate && rangeEndDate && domainDuration > 0 && entryDate instanceof Date) {
      ratio = (entryDate.getTime() - rangeStartDate.getTime()) / domainDuration;
    } else if (series.length === 1) {
      ratio = 0;
    } else {
      ratio = index / (series.length - 1);
    }
    const clampedRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const normalized = Number.isFinite(safeValue) ? (safeValue - minDomain) / domainRange : null;
    const clamped = normalized !== null ? Math.max(0, Math.min(1, normalized)) : null;
    const y = clamped !== null ? PADDING.top + innerHeight * (1 - clamped) : null;
    const previousValue = index > 0 ? values[index - 1] : chartValue;
    const trend =
      Number.isFinite(chartValue) && Number.isFinite(previousValue) ? chartValue - previousValue : 0;
    return {
      ...entry,
      x: PADDING.left + innerWidth * clampedRatio,
      y,
      chartValue: safeValue,
      trend,
    };
  });

  const yFor = (value) => {
    if (!Number.isFinite(value)) {
      return null;
    }
    const normalized = (value - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    return PADDING.top + innerHeight * (1 - clamped);
  };

  return {
    points,
    yFor,
    rangeStart: rangeStartDate ? rangeStartDate.toISOString().slice(0, 10) : series[0].date,
    rangeEnd: rangeEndDate ? rangeEndDate.toISOString().slice(0, 10) : series[series.length - 1].date,
    minDomain,
    maxDomain,
    ticks,
    innerWidth,
    innerHeight,
  };
}

export default function DeploymentGraphDialog({ accountKey, accountLabel, baseCurrency = 'CAD', onClose }) {
  const headingId = useId();
  const chartRef = useRef(null);
  const [timeframe, setTimeframe] = useState('1Y');
  const [mode, setMode] = useState('percent');
  const [seriesState, setSeriesState] = useState({ status: 'idle', data: null, error: null, accountKey: null });
  const [hoverIndex, setHoverIndex] = useState(null);

  useEffect(() => {
    if (!accountKey) {
      setSeriesState({
        status: 'error',
        data: null,
        error: new Error('Account identifier is required'),
        accountKey: null,
      });
      return;
    }
    let cancelled = false;
    setSeriesState((prev) => ({
      status: 'loading',
      data: prev.accountKey === accountKey ? prev.data : null,
      error: null,
      accountKey,
    }));
    getTotalPnlSeries(accountKey, { applyAccountCagrStartDate: false })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setSeriesState({ status: 'success', data: payload, error: null, accountKey });
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const normalized = err instanceof Error ? err : new Error('Failed to load deployment series');
        setSeriesState({ status: 'error', data: null, error: normalized, accountKey });
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey]);

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

  const loading = seriesState.status === 'loading';
  const error = seriesState.status === 'error' ? seriesState.error : null;
  const data = seriesState.accountKey === accountKey ? seriesState.data : null;

  const rawSeries = Array.isArray(data?.points) ? data.points : [];
  const displaySeries = useMemo(
    () => buildDeploymentDisplaySeries(rawSeries, timeframe),
    [rawSeries, timeframe]
  );

  const chartMetrics = useMemo(() => buildChartMetrics(displaySeries, mode), [displaySeries, mode]);

  const formattedAxis = useMemo(() => {
    if (!chartMetrics) {
      return [];
    }
    return chartMetrics.ticks
      .map((tick) => ({ value: tick, y: chartMetrics.yFor(tick) }))
      .filter((entry) => Number.isFinite(entry.y));
  }, [chartMetrics]);

  const pathD = useMemo(() => {
    if (!chartMetrics) {
      return null;
    }
    const validPoints = chartMetrics.points.filter(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.chartValue)
    );
    if (!validPoints.length) {
      return null;
    }
    return validPoints
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
  }, [chartMetrics]);

  const latestPoint = useMemo(() => {
    if (!chartMetrics) {
      return null;
    }
    for (let i = chartMetrics.points.length - 1; i >= 0; i -= 1) {
      const point = chartMetrics.points[i];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.chartValue)) {
        return point;
      }
    }
    return null;
  }, [chartMetrics]);

  const activePoint = hoverIndex !== null && chartMetrics
    ? chartMetrics.points[hoverIndex] || latestPoint
    : latestPoint;

  const zeroLine = useMemo(() => {
    if (!chartMetrics) {
      return null;
    }
    if (0 >= chartMetrics.minDomain && 0 <= chartMetrics.maxDomain) {
      return chartMetrics.yFor(0);
    }
    return null;
  }, [chartMetrics]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleMouseMove = useCallback(
    (event) => {
      if (!chartMetrics || !chartRef.current) {
        return;
      }
      const rect = chartRef.current.getBoundingClientRect();
      const relativeX = event.clientX - rect.left;
      let nearestIndex = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      chartMetrics.points.forEach((point, index) => {
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !Number.isFinite(point?.chartValue)) {
          return;
        }
        const distance = Math.abs(point.x - relativeX);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      setHoverIndex(nearestIndex);
    },
    [chartMetrics]
  );

  const handleMouseLeave = useCallback(() => {
    setHoverIndex(null);
  }, []);

  const hasChart = Boolean(chartMetrics && pathD);

  const latestEntry = displaySeries.length ? displaySeries[displaySeries.length - 1] : null;
  const latestDeployedValue = Number.isFinite(latestEntry?.deployedValueCad) ? latestEntry.deployedValueCad : null;
  const latestDeployedPercent = Number.isFinite(latestEntry?.deployedPercent) ? latestEntry.deployedPercent : null;
  const latestReserveValue = Number.isFinite(latestEntry?.reserveValueCad)
    ? latestEntry.reserveValueCad
    : Number.isFinite(latestEntry?.equityCad) && Number.isFinite(latestDeployedValue)
      ? latestEntry.equityCad - latestDeployedValue
      : null;
  const latestReservePercent = Number.isFinite(latestEntry?.reservePercent)
    ? latestEntry.reservePercent
    : Number.isFinite(latestDeployedPercent)
      ? 100 - latestDeployedPercent
      : null;
  const latestEquity = Number.isFinite(latestEntry?.equityCad)
    ? latestEntry.equityCad
    : Number.isFinite(latestDeployedValue) && Number.isFinite(latestReserveValue)
      ? latestDeployedValue + latestReserveValue
      : null;

  const tooltipDate = activePoint?.date ? formatDate(activePoint.date) : null;
  const tooltipDeployedValue = Number.isFinite(activePoint?.deployedValueCad)
    ? formatMoney(activePoint.deployedValueCad)
    : '—';
  const tooltipDeployedPercent = Number.isFinite(activePoint?.deployedPercent)
    ? `${formatNumber(activePoint.deployedPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
    : null;
  const tooltipReserveValue = Number.isFinite(activePoint?.reserveValueCad)
    ? formatMoney(activePoint.reserveValueCad)
    : '—';
  const tooltipReservePercent = Number.isFinite(activePoint?.reservePercent)
    ? `${formatNumber(activePoint.reservePercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
    : null;

  const markerPoint = hoverIndex !== null && chartMetrics
    ? chartMetrics.points[hoverIndex]
    : latestPoint;

  const toggleMode = (nextMode) => {
    setMode(nextMode === 'absolute' ? 'absolute' : 'percent');
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
              <h2 id={headingId}>Deployment over time</h2>
              {accountLabel && <span className="pnl-dialog__account">{accountLabel}</span>}
            </div>

            {loading ? (
              <div className="pnl-dialog__loading" role="status" aria-live="polite">
                <span className="pnl-dialog__spinner" aria-hidden="true" />
                <span className="visually-hidden">Loading deployment history…</span>
              </div>
            ) : (
              <>
                <div className="pnl-dialog__summary">
                  <div className="pnl-dialog__summary-item">
                    <span className="pnl-dialog__summary-label">Deployed</span>
                    <span className="pnl-dialog__summary-value">
                      {Number.isFinite(latestDeployedValue) ? formatMoney(latestDeployedValue) : '—'}
                      {Number.isFinite(latestDeployedPercent)
                        ? ` (${formatNumber(latestDeployedPercent, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}%)`
                        : ''}
                    </span>
                  </div>
                  <div className="pnl-dialog__summary-item">
                    <span className="pnl-dialog__summary-label">Reserve</span>
                    <span className="pnl-dialog__summary-value">
                      {Number.isFinite(latestReserveValue) ? formatMoney(latestReserveValue) : '—'}
                      {Number.isFinite(latestReservePercent)
                        ? ` (${formatNumber(latestReservePercent, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}%)`
                        : ''}
                    </span>
                  </div>
                  <div className="pnl-dialog__summary-item">
                    <span className="pnl-dialog__summary-label">Total equity</span>
                    <span className="pnl-dialog__summary-value">
                      {Number.isFinite(latestEquity) ? formatMoney(latestEquity) : '—'}
                    </span>
                  </div>
                </div>

                <div className="pnl-dialog__controls">
                  <label className="pnl-dialog__control-label" htmlFor="deployment-timeframe">
                    Show
                  </label>
                  <div className="select-control">
                    <button
                      id="deployment-timeframe"
                      type="button"
                      className="select-control__button"
                      onClick={(event) => {
                        const menu = event.currentTarget.nextSibling;
                        if (menu) {
                          menu.classList.toggle('select-control__list--open');
                        }
                      }}
                      disabled={loading || !data}
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
                              const menu = document.getElementById('deployment-timeframe')?.nextSibling;
                              if (menu) {
                                menu.classList.remove('select-control__list--open');
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

                <div className="pnl-dialog__toggle-group" role="group" aria-label="Value mode">
                  <button
                    type="button"
                    className={mode === 'percent' ? 'pnl-dialog__toggle-button active' : 'pnl-dialog__toggle-button'}
                    onClick={() => toggleMode('percent')}
                  >
                    Percent deployed
                  </button>
                  <button
                    type="button"
                    className={mode === 'absolute' ? 'pnl-dialog__toggle-button active' : 'pnl-dialog__toggle-button'}
                    onClick={() => toggleMode('absolute')}
                  >
                    Absolute ({baseCurrency})
                  </button>
                </div>

                {error && (
                  <div className="qqq-section__status qqq-section__status--error" role="alert">
                    <span>{error.message || 'Failed to load deployment series.'}</span>
                  </div>
                )}

                {!error && hasChart && (
                  <div className="qqq-section__chart-container">
                    <svg
                      ref={chartRef}
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
                            {mode === 'percent'
                              ? `${formatNumber(tick.value, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}%`
                              : formatMoney(tick.value, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}
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
                      {markerPoint && Number.isFinite(markerPoint.x) && Number.isFinite(markerPoint.y) && (
                        <circle className="qqq-section__marker" cx={markerPoint.x} cy={markerPoint.y} r="5" />
                      )}
                    </svg>
                    {activePoint && (
                      <div className="pnl-dialog__chart-summary">
                        <div className="pnl-dialog__chart-summary-date">{tooltipDate}</div>
                        <div className="pnl-dialog__chart-summary-metric">
                          <span className="pnl-dialog__chart-summary-label">Deployed</span>
                          <span className="pnl-dialog__chart-summary-value">
                            {mode === 'percent' ? tooltipDeployedPercent || '—' : tooltipDeployedValue}
                          </span>
                          {mode === 'percent' && tooltipDeployedPercent && (
                            <span className="pnl-dialog__chart-summary-secondary">{tooltipDeployedValue}</span>
                          )}
                        </div>
                        <div className="pnl-dialog__chart-summary-metric">
                          <span className="pnl-dialog__chart-summary-label">Reserve</span>
                          <span className="pnl-dialog__chart-summary-value">
                            {mode === 'percent' ? tooltipReservePercent || '—' : tooltipReserveValue}
                          </span>
                          {mode === 'percent' && tooltipReservePercent && (
                            <span className="pnl-dialog__chart-summary-secondary">{tooltipReserveValue}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {!error && !hasChart && (
                  <div className="qqq-section__status" role="status">
                    No deployment data available for the selected range.
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

DeploymentGraphDialog.propTypes = {
  accountKey: PropTypes.string,
  accountLabel: PropTypes.string,
  baseCurrency: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};

DeploymentGraphDialog.defaultProps = {
  accountKey: null,
  accountLabel: null,
  baseCurrency: 'CAD',
};
