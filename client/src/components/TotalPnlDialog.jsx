import { useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDate, formatMoney, formatSignedMoney } from '../utils/formatters';

const CHART_WIDTH = 680;
const CHART_HEIGHT = 260;
const PADDING = { top: 6, right: 48, bottom: 30, left: 0 };
const AXIS_TARGET_INTERVALS = 4;

const TIMEFRAME_OPTIONS = [
  { value: '1M', label: '1 month' },
  { value: '3M', label: '3 months' },
  { value: '6M', label: '6 months' },
  { value: '1Y', label: '1 year' },
  { value: '3Y', label: '3 years' },
  { value: '5Y', label: '5 years' },
  { value: 'ALL', label: 'All' },
];

function parseDateOnly(value) {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function subtractInterval(date, option) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  const result = new Date(date.getTime());
  switch (option) {
    case '1M':
      result.setMonth(result.getMonth() - 1);
      break;
    case '3M':
      result.setMonth(result.getMonth() - 3);
      break;
    case '6M':
      result.setMonth(result.getMonth() - 6);
      break;
    case '1Y':
      result.setFullYear(result.getFullYear() - 1);
      break;
    case '3Y':
      result.setFullYear(result.getFullYear() - 3);
      break;
    case '5Y':
      result.setFullYear(result.getFullYear() - 5);
      break;
    default:
      return null;
  }
  return result;
}

function filterSeries(points, timeframe) {
  if (!Array.isArray(points)) {
    return [];
  }
  const sanitized = points
    .map((entry) => ({
      date: entry?.date || null,
      totalPnl: Number(entry?.totalPnlCad),
      totalPnlDelta: Number(entry?.totalPnlSinceDisplayStartCad),
      equity: Number(entry?.equityCad),
      equityDelta: Number(entry?.equitySinceDisplayStartCad),
      netDeposits: Number(entry?.cumulativeNetDepositsCad),
      netDepositsDelta: Number(entry?.cumulativeNetDepositsSinceDisplayStartCad),
    }))
    .filter((entry) => entry.date && Number.isFinite(entry.totalPnl));
  if (!sanitized.length) {
    return [];
  }
  sanitized.sort((a, b) => {
    const aDate = parseDateOnly(a.date)?.getTime() ?? 0;
    const bDate = parseDateOnly(b.date)?.getTime() ?? 0;
    return aDate - bDate;
  });
  if (timeframe === 'ALL') {
    return sanitized;
  }
  const lastEntry = sanitized[sanitized.length - 1];
  const lastDate = parseDateOnly(lastEntry.date);
  const cutoff = subtractInterval(lastDate, timeframe);
  if (!cutoff) {
    return sanitized;
  }
  const filtered = sanitized.filter((entry) => {
    const entryDate = parseDateOnly(entry.date);
    if (!entryDate) {
      return false;
    }
    return entryDate >= cutoff;
  });
  if (filtered.length === 0) {
    return sanitized.slice(-1);
  }
  return filtered;
}

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

function buildChartMetrics(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }
  const values = series.map((entry) => entry.totalPnl);
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 0);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(10, Math.abs(maxValue) * 0.1 || 10) : Math.max(10, range * 0.1);
  const rawMinDomain = minValue - padding;
  const rawMaxDomain = maxValue + padding;
  const { minDomain, maxDomain, ticks } = buildAxisScale(rawMinDomain, rawMaxDomain);
  const domainRange = maxDomain - minDomain || 1;
  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const points = series.map((entry, index) => {
    const ratio = series.length === 1 ? 0 : index / (series.length - 1);
    const x = PADDING.left + innerWidth * ratio;
    const normalized = (entry.totalPnl - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    const y = PADDING.top + innerHeight * (1 - clamped);
    const previous = index > 0 ? series[index - 1].totalPnl : entry.totalPnl;
    const trend = entry.totalPnl - previous;
    return { ...entry, x, y, trend };
  });

  const yFor = (value) => {
    const normalized = (value - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    return PADDING.top + innerHeight * (1 - clamped);
  };

  return {
    points,
    yFor,
    rangeStart: series[0].date,
    rangeEnd: series[series.length - 1].date,
    minDomain,
    maxDomain,
    domainRange,
    innerWidth,
    innerHeight,
    axisTicks: ticks,
  };
}

function formatIssues(issues) {
  if (!Array.isArray(issues) || !issues.length) {
    return [];
  }
  return issues.map((issue) => {
    if (!issue || typeof issue !== 'string') {
      return null;
    }
    if (issue === 'missing-price-data') {
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

  const filteredSeries = useMemo(() => filterSeries(data?.points, timeframe), [data?.points, timeframe]);
  const chartMetrics = useMemo(() => buildChartMetrics(filteredSeries), [filteredSeries]);
  const hasChart = Boolean(chartMetrics && chartMetrics.points.length);
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
    return {
      date: t < 0.5 ? lower.date : upper.date,
      totalPnl: lower.totalPnl + (upper.totalPnl - lower.totalPnl) * t,
      equity: lower.equity + (upper.equity - lower.equity) * t,
      netDeposits: lower.netDeposits + (upper.netDeposits - lower.netDeposits) * t,
      totalPnlDelta: interpolate(lower.totalPnlDelta, upper.totalPnlDelta),
      equityDelta: interpolate(lower.equityDelta, upper.equityDelta),
      netDepositsDelta: interpolate(lower.netDepositsDelta, upper.netDepositsDelta),
      x: clampedInterpX,
      y: lower.y + (upper.y - lower.y) * t,
      trend: upper.totalPnl - lower.totalPnl,
    };
  }, [hover, chartMetrics, hasChart]);

  const marker = hasChart ? chartMetrics.points[chartMetrics.points.length - 1] : null;
  const markerLabel = marker ? formatMoney(marker.totalPnl) : null;
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
        amount: formatMoney(hoverPoint.totalPnl),
        delta:
          Number.isFinite(hoverPoint.totalPnlDelta) && Math.abs(hoverPoint.totalPnlDelta) > 0.005
            ? formatSignedMoney(hoverPoint.totalPnlDelta)
            : null,
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

  const displayRangeStart = chartMetrics ? chartMetrics.rangeStart : data?.periodStartDate;
  const displayRangeEnd = chartMetrics ? chartMetrics.rangeEnd : data?.periodEndDate;

  const summary = data?.summary || {};
  const netDeposits = Number(summary.netDepositsCad);
  const totalEquity = Number(summary.totalEquityCad);
  const totalPnl = Number(summary.totalPnlCad);

  const normalizedIssues = useMemo(() => formatIssues(data?.issues), [data?.issues]);

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

            <div className="pnl-dialog__summary">
              <div className="pnl-dialog__summary-item">
                <span className="pnl-dialog__summary-label">Total P&amp;L</span>
                <span className="pnl-dialog__summary-value pnl-dialog__summary-value--accent">
                  {Number.isFinite(totalPnl) ? formatMoney(totalPnl) : '—'}
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
                        className={option.value === timeframe ? 'select-control__option select-control__option--selected' : 'select-control__option'}
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

            {loading && (
              <div className="qqq-section__status" role="status">
                Loading Total P&amp;L…
              </div>
            )}

            {!loading && error && (
              <div className="qqq-section__status qqq-section__status--error" role="alert">
                <span>{error.message || 'Failed to load Total P&L series.'}</span>
                {onRetry && (
                  <button type="button" className="qqq-section__retry" onClick={onRetry}>
                    Retry
                  </button>
                )}
              </div>
            )}

            {!loading && !error && hasChart && (
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
                        {formatMoney(tick.value)}
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
                {(hoverLabel || (marker && markerLabel)) && (
                  <div className="qqq-section__chart-label" style={labelPosition}>
                    <span className="pnl-dialog__label-amount">{hoverLabel ? hoverLabel.amount : markerLabel}</span>
                    {hoverLabel?.delta && (
                      <span className="pnl-dialog__label-delta">{hoverLabel.delta} since start</span>
                    )}
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

            {!loading && !error && !hasChart && (
              <div className="qqq-section__status">No Total P&amp;L data available.</div>
            )}

            {!loading && !error && normalizedIssues.length > 0 && (
              <div className="pnl-dialog__issues" role="note">
                <h3>Notes</h3>
                <ul>
                  {normalizedIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
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
      totalEquityCad: PropTypes.number,
      totalPnlCad: PropTypes.number,
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
};
