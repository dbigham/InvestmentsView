import { useCallback, useEffect, useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  formatDate,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  classifyPnL,
} from '../utils/formatters';
import {
  PERFORMANCE_PERIOD_OPTIONS,
  computePerformanceSummary,
  sliceTimeline,
  buildChartPoints,
} from '../utils/performance';
import { logPerformanceDebug } from '../utils/performanceDebug';

const CHART_WIDTH = 560;
const CHART_HEIGHT = 260;
const CHART_PADDING = { top: 24, right: 24, bottom: 36, left: 48 };

function buildChartMetrics(points) {
  if (!points || points.length === 0) {
    return null;
  }
  const values = points.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(1, Math.abs(maxValue) * 0.1) : range * 0.1;
  const minDomain = minValue - padding;
  const maxDomain = maxValue + padding;
  const domainRange = maxDomain - minDomain || 1;
  const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

  const metrics = points.map((point, index) => {
    const ratio = points.length === 1 ? 0.5 : index / (points.length - 1);
    const x = CHART_PADDING.left + innerWidth * ratio;
    const normalized = (point.value - minDomain) / domainRange;
    const clamped = Number.isFinite(normalized) ? Math.max(0, Math.min(1, normalized)) : 0.5;
    const y = CHART_PADDING.top + innerHeight * (1 - clamped);
    return { ...point, x, y };
  });

  const yFor = (value) => {
    const normalized = (value - minDomain) / domainRange;
    const clamped = Number.isFinite(normalized) ? Math.max(0, Math.min(1, normalized)) : 0.5;
    return CHART_PADDING.top + innerHeight * (1 - clamped);
  };

  return {
    points: metrics,
    yFor,
    minDomain,
    maxDomain,
  };
}

function PerformanceChart({ points }) {
  const chartMetrics = useMemo(() => buildChartMetrics(points), [points]);

  if (!chartMetrics) {
    return (
      <div className="performance-dialog__chart performance-dialog__chart--empty">
        <p>No timeline data is available for this period.</p>
      </div>
    );
  }

  const { points: chartPoints, yFor } = chartMetrics;
  const hasMultiplePoints = chartPoints.length > 1;
  const pathD = hasMultiplePoints
    ? chartPoints
        .map((point, index) => {
          const prefix = index === 0 ? 'M' : 'L';
          return `${prefix}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
        })
        .join(' ')
    : `M${chartPoints[0].x.toFixed(2)} ${chartPoints[0].y.toFixed(2)}`;

  const latestPoint = chartPoints[chartPoints.length - 1];

  const guideValues = [chartMetrics.minDomain, chartMetrics.maxDomain];
  const guides = guideValues.map((value) => ({ value, y: yFor(value) }));

  return (
    <div className="performance-dialog__chart">
      <svg
        className="performance-dialog__chart-svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label="Account value over time"
      >
        <rect
          className="performance-dialog__chart-surface"
          x="0"
          y="0"
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
        />
        <path className="performance-dialog__chart-line" d={pathD} />
        {chartPoints.map((point) => (
          <circle
            key={point.date}
            cx={point.x}
            cy={point.y}
            r={point.date === latestPoint.date ? 5 : 3}
            className={
              point.date === latestPoint.date
                ? 'performance-dialog__chart-marker performance-dialog__chart-marker--latest'
                : 'performance-dialog__chart-marker'
            }
          />
        ))}
        {guides.map((guide) => (
          <line
            key={guide.value}
            x1={CHART_PADDING.left}
            x2={CHART_WIDTH - CHART_PADDING.right}
            y1={guide.y}
            y2={guide.y}
            className="performance-dialog__chart-guide"
          />
        ))}
      </svg>
      <div className="performance-dialog__chart-footer">
        <span>{chartPoints[0].date}</span>
        <span>{chartPoints[chartPoints.length - 1].date}</span>
      </div>
    </div>
  );
}

PerformanceChart.propTypes = {
  points: PropTypes.arrayOf(
    PropTypes.shape({
      date: PropTypes.string.isRequired,
      value: PropTypes.number.isRequired,
    })
  ),
};

PerformanceChart.defaultProps = {
  points: [],
};

export default function AccountPerformanceDialog({
  data,
  onClose,
  period,
  onPeriodChange,
  loading,
  error,
  onRetry,
  traceId,
}) {
  const dialogTraceId = traceId || null;
  const hasTimeline = Array.isArray(data?.timeline);
  const timelineLength = hasTimeline ? data.timeline.length : 0;
  const warningsLength = Array.isArray(data?.warnings) ? data.warnings.length : 0;

  useEffect(() => {
    logPerformanceDebug('AccountPerformanceDialog props changed.', {
      traceId: dialogTraceId,
      loading,
      error: error || null,
      period,
      hasTimeline,
      timelinePoints: timelineLength,
      warnings: warningsLength,
    });
  }, [dialogTraceId, loading, error, period, hasTimeline, timelineLength, warningsLength]);
  useEffect(() => {
    function handleKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        logPerformanceDebug('Performance dialog closed via Escape key.', { traceId: dialogTraceId });
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [dialogTraceId, onClose]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      logPerformanceDebug('Performance dialog overlay clicked.', { traceId: dialogTraceId });
      onClose();
    }
  };

  const summary = useMemo(() => {
    if (!data || !Array.isArray(data.timeline)) {
      return null;
    }
    return computePerformanceSummary(data.timeline, period);
  }, [data, period]);

  useEffect(() => {
    if (!summary) {
      logPerformanceDebug('AccountPerformanceDialog summary unavailable for current selection.', {
        traceId: dialogTraceId,
        period,
        hasTimeline,
        timelinePoints: timelineLength,
      });
      return;
    }
    logPerformanceDebug('AccountPerformanceDialog summary computed.', {
      traceId: dialogTraceId,
      period,
      startIndex: summary.startIndex,
      endIndex: summary.endIndex,
      startValue: summary.startValue,
      endValue: summary.endValue,
      netFlows: summary.netFlows,
      totalPnl: summary.totalPnl,
      percent: summary.percent,
      cagr: summary.cagr,
    });
  }, [dialogTraceId, summary, period, hasTimeline, timelineLength]);

  const chartPoints = useMemo(() => {
    if (!data || !summary) {
      return [];
    }
    const slice = sliceTimeline(data.timeline, summary.startIndex, summary.endIndex);
    return buildChartPoints(slice);
  }, [data, summary]);

  useEffect(() => {
    logPerformanceDebug('AccountPerformanceDialog chart points prepared.', {
      traceId: dialogTraceId,
      points: chartPoints.length,
    });
  }, [chartPoints, dialogTraceId]);

  const handlePeriodChange = useCallback(
    (event) => {
      const nextPeriod = event.target.value;
      logPerformanceDebug('AccountPerformanceDialog period selection changed.', {
        traceId: dialogTraceId,
        from: period,
        to: nextPeriod,
      });
      onPeriodChange(nextPeriod);
    },
    [dialogTraceId, onPeriodChange, period]
  );

  const totalPnlTone = classifyPnL(summary ? summary.totalPnl : 0);
  const totalPnlFormatted = summary ? formatSignedMoney(summary.totalPnl) : '—';
  const totalPercentFormatted = summary && Number.isFinite(summary.percent)
    ? formatSignedPercent(summary.percent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null;
  const cagrFormatted = summary && Number.isFinite(summary.cagr)
    ? formatSignedPercent(summary.cagr, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
  const startValueFormatted = summary ? formatMoney(summary.startValue) : '—';
  const endValueFormatted = summary ? formatMoney(summary.endValue) : '—';
  const netFlowsFormatted = summary ? formatSignedMoney(summary.netFlows) : '—';
  const periodLabel = PERFORMANCE_PERIOD_OPTIONS.find((option) => option.value === period)?.label || 'All';

  return (
    <div className="performance-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="performance-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="performance-dialog-title"
      >
        <header className="performance-dialog__header">
          <div className="performance-dialog__heading">
            <h2 id="performance-dialog-title">Account performance</h2>
            {data?.startDate && data?.endDate && (
              <p className="performance-dialog__subtitle">
                Timeline from {formatDate(data.startDate)} to {formatDate(data.endDate)}
              </p>
            )}
            {data?.baseCurrency && (
              <p className="performance-dialog__subtitle">Values approximated in {data.baseCurrency}</p>
            )}
          </div>
          <button
            type="button"
            className="performance-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="performance-dialog__body">
          {loading && (
            <div className="performance-dialog__status" role="status" aria-live="polite">
              <span className="initial-loading__spinner" aria-hidden="true" />
              <span>Calculating performance…</span>
            </div>
          )}

          {!loading && error && (
            <div className="performance-dialog__status performance-dialog__status--error" role="alert">
              <p>{error}</p>
              {onRetry && (
                <button type="button" className="performance-dialog__retry" onClick={onRetry}>
                  Try again
                </button>
              )}
            </div>
          )}

          {!loading && !error && data && summary && (
            <>
              <div className="performance-dialog__metrics">
                <div className="performance-dialog__metric">
                  <dt>Total P&amp;L</dt>
                  <dd>
                    <span className={`performance-dialog__metric-value performance-dialog__metric-value--${totalPnlTone}`}>
                      {totalPnlFormatted}
                    </span>
                    {totalPercentFormatted && (
                      <span className="performance-dialog__metric-extra">({totalPercentFormatted})</span>
                    )}
                  </dd>
                </div>
                <div className="performance-dialog__metric performance-dialog__metric--cagr">
                  <dt>CAGR</dt>
                  <dd>
                    <span className="performance-dialog__metric-value performance-dialog__metric-value--neutral">
                      {cagrFormatted}
                    </span>
                    <label className="performance-dialog__period-select">
                      <span className="visually-hidden">Select performance period</span>
                      <select value={period} onChange={handlePeriodChange}>
                        {PERFORMANCE_PERIOD_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </dd>
                </div>
              </div>

              <dl className="performance-dialog__details">
                <div className="performance-dialog__details-row">
                  <dt>Starting value</dt>
                  <dd>{startValueFormatted}</dd>
                </div>
                <div className="performance-dialog__details-row">
                  <dt>Net contributions</dt>
                  <dd>{netFlowsFormatted}</dd>
                </div>
                <div className="performance-dialog__details-row">
                  <dt>Ending value</dt>
                  <dd>{endValueFormatted}</dd>
                </div>
                <div className="performance-dialog__details-row performance-dialog__details-row--period">
                  <dt>Period</dt>
                  <dd>{periodLabel}</dd>
                </div>
              </dl>

              <PerformanceChart points={chartPoints} />

              {data.warnings && data.warnings.length > 0 && (
                <div className="performance-dialog__warnings" role="note">
                  <p>Some data points are approximate:</p>
                  <ul>
                    {data.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {!loading && !error && (!data || !summary) && (
            <div className="performance-dialog__status performance-dialog__status--empty">
              Unable to calculate performance data for this account.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

AccountPerformanceDialog.propTypes = {
  data: PropTypes.shape({
    baseCurrency: PropTypes.string,
    timeline: PropTypes.arrayOf(
      PropTypes.shape({
        date: PropTypes.string.isRequired,
        value: PropTypes.number,
        netFlows: PropTypes.number,
      })
    ),
    warnings: PropTypes.arrayOf(PropTypes.string),
    startDate: PropTypes.string,
    endDate: PropTypes.string,
    traceId: PropTypes.number,
  }),
  onClose: PropTypes.func.isRequired,
  period: PropTypes.string.isRequired,
  onPeriodChange: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onRetry: PropTypes.func,
  traceId: PropTypes.number,
};

AccountPerformanceDialog.defaultProps = {
  data: null,
  loading: false,
  error: null,
  onRetry: null,
  traceId: null,
};
