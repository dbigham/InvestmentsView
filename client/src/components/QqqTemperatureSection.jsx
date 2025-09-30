import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDate, formatNumber, formatPercent } from '../utils/formatters';

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const PADDING = { top: 6, right: 0, bottom: 4.5, left: 0 };

const TIMEFRAME_OPTIONS = [
  { value: '1M', label: '1 month' },
  { value: '1Y', label: '1 year' },
  { value: '5Y', label: '5 years' },
  { value: '10Y', label: '10 years' },
  { value: 'ALL', label: 'All time' },
];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatActionLabel(action) {
  if (!action) {
    return 'Hold';
  }
  const normalized = String(action).replace(/[_\s]+/g, ' ').trim();
  if (!normalized) {
    return 'Hold';
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatTradingDays(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  const suffix = rounded === 1 ? '' : 's';
  return `${rounded} trading day${suffix}`;
}

function parseDate(value) {
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
  if (!(date instanceof Date)) {
    return null;
  }
  const result = new Date(date.getTime());
  switch (option) {
    case '1M':
      result.setMonth(result.getMonth() - 1);
      break;
    case '1Y':
      result.setFullYear(result.getFullYear() - 1);
      break;
    case '5Y':
      result.setFullYear(result.getFullYear() - 5);
      break;
    case '10Y':
      result.setFullYear(result.getFullYear() - 10);
      break;
    default:
      return null;
  }
  return result;
}

function filterSeries(series, timeframe) {
  if (!Array.isArray(series)) {
    return [];
  }
  const normalized = series.filter((entry) => entry && entry.date && Number.isFinite(entry.temperature));
  if (!normalized.length) {
    return [];
  }
  if (timeframe === 'ALL') {
    return normalized;
  }
  const lastEntry = normalized[normalized.length - 1];
  const lastDate = parseDate(lastEntry.date);
  const cutoffDate = subtractInterval(lastDate, timeframe);
  if (!cutoffDate) {
    return normalized;
  }
  return normalized.filter((entry) => {
    const entryDate = parseDate(entry.date);
    if (!entryDate) {
      return false;
    }
    return entryDate >= cutoffDate;
  });
}

function buildChartMetrics(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }
  const sanitized = series
    .map((entry) => ({
      date: entry.date,
      temperature: Number(entry.temperature),
    }))
    .filter((entry) => entry.date && Number.isFinite(entry.temperature));
  if (sanitized.length === 0) {
    return null;
  }
  const values = sanitized.map((entry) => entry.temperature);
  const baseLines = [1, 1.5, 0.5];
  const minValue = Math.min(...values, ...baseLines);
  const maxValue = Math.max(...values, ...baseLines);
  const range = maxValue - minValue;
  const padding = range === 0 ? 0.1 : range * 0.1;
  const minDomain = Math.max(0, minValue - padding);
  const maxDomain = maxValue + padding;
  const domainRange = maxDomain - minDomain || 1;
  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const points = sanitized.map((entry, index) => {
    const ratio = sanitized.length === 1 ? 0 : index / (sanitized.length - 1);
    const x = PADDING.left + innerWidth * ratio;
    const normalized = (entry.temperature - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    const y = PADDING.top + innerHeight * (1 - clamped);
    return { ...entry, x, y };
  });

  const yFor = (value) => {
    const normalized = (value - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    return PADDING.top + innerHeight * (1 - clamped);
  };

  return {
    points,
    yFor,
    rangeStart: sanitized[0].date,
    rangeEnd: sanitized[sanitized.length - 1].date,
  };
}

export default function QqqTemperatureSection({
  data,
  loading,
  error,
  onRetry,
  title,
  modelName,
  lastRebalance,
  evaluation,
}) {
  const [timeframe, setTimeframe] = useState('5Y');
  const filteredSeries = useMemo(() => filterSeries(data?.series, timeframe), [data?.series, timeframe]);
  const chartMetrics = useMemo(() => buildChartMetrics(filteredSeries), [filteredSeries]);
  const latestTemperature = Number(data?.latest?.temperature);
  const latestLabel = Number.isFinite(latestTemperature)
    ? `T = ${formatNumber(latestTemperature, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  const hasChart = chartMetrics && chartMetrics.points.length >= 1;
  const displayRangeStart = chartMetrics ? chartMetrics.rangeStart : data?.rangeStart;
  const displayRangeEnd = chartMetrics ? chartMetrics.rangeEnd : data?.rangeEnd;
  const resolvedTitle = title || (modelName ? 'Investment Model' : 'QQQ temperature');
  const headingId = modelName ? 'investment-model-heading' : 'qqq-temperature-heading';
  const loadingLabel = modelName ? 'Loading investment model…' : 'Loading QQQ temperature…';
  const errorLabel = modelName ? 'Unable to load investment model details.' : 'Unable to load QQQ temperature details.';

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

  const guideLines = useMemo(() => {
    if (!hasChart) {
      return null;
    }
    return {
      base: chartMetrics.yFor(1),
      upper: chartMetrics.yFor(1.5),
      lower: chartMetrics.yFor(0.5),
    };
  }, [chartMetrics, hasChart]);

  const marker = useMemo(() => {
    if (!hasChart) {
      return null;
    }
    const { points } = chartMetrics;
    const lastIndex = points.length - 1;
    const lastPoint = points[lastIndex];
    const previousPoint = lastIndex > 0 ? points[lastIndex - 1] : null;
    const trend = previousPoint ? lastPoint.temperature - previousPoint.temperature : 0;
    return { ...lastPoint, trend };
  }, [chartMetrics, hasChart]);

  const labelPosition = useMemo(() => {
    if (!marker) {
      return null;
    }
    const leftPercent = Math.min(94, Math.max(0, (marker.x / CHART_WIDTH) * 100));
    const verticalOffset = marker.trend > 0 ? -24 : marker.trend < 0 ? 24 : 0;
    const adjustedY = Math.min(
      CHART_HEIGHT - PADDING.bottom,
      Math.max(PADDING.top, marker.y + verticalOffset),
    );
    const topPercent = Math.min(92, Math.max(8, (adjustedY / CHART_HEIGHT) * 100));
    return { left: `${leftPercent}%`, top: `${topPercent}%` };
  }, [marker]);

  const evaluationStatus = evaluation?.status || null;
  const evaluationData = evaluationStatus === 'ok' && evaluation && typeof evaluation === 'object' ? evaluation.data || null : null;
  const evaluationDecision = evaluationData && typeof evaluationData === 'object' ? evaluationData.decision || null : null;
  const evaluationReason = evaluationDecision && typeof evaluationDecision === 'object' ? evaluationDecision.reason || null : null;
  const evaluationAction = evaluationDecision && typeof evaluationDecision === 'object' ? evaluationDecision.action || null : null;
  const evaluationActionClass = evaluationAction
    ? String(evaluationAction)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
    : 'hold';
  const evaluationMetrics = [];
  const percentOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

  if (evaluationData) {
    const currentAllocation = evaluationData.current_allocation;
    if (isFiniteNumber(currentAllocation)) {
      evaluationMetrics.push({
        label: 'Current allocation',
        value: formatPercent(currentAllocation * 100, percentOptions),
      });
    }
    const targetAllocation =
      (evaluationData.model && isFiniteNumber(evaluationData.model.target_allocation)
        ? evaluationData.model.target_allocation
        : null) ??
      (evaluationDecision && evaluationDecision.details && isFiniteNumber(evaluationDecision.details.target_p)
        ? evaluationDecision.details.target_p
        : null);
    if (isFiniteNumber(targetAllocation)) {
      evaluationMetrics.push({
        label: 'Target allocation',
        value: formatPercent(targetAllocation * 100, percentOptions),
      });
    }
    const baseAllocation = evaluationData.model && isFiniteNumber(evaluationData.model.base_allocation)
      ? evaluationData.model.base_allocation
      : null;
    if (isFiniteNumber(baseAllocation)) {
      evaluationMetrics.push({
        label: 'Base allocation',
        value: formatPercent(baseAllocation * 100, percentOptions),
      });
    }
    const cadence =
      (evaluationData.model && Number.isFinite(evaluationData.model.rebalance_cadence)
        ? evaluationData.model.rebalance_cadence
        : null) ??
      (evaluationDecision && evaluationDecision.details && Number.isFinite(evaluationDecision.details.rebalance_cadence)
        ? evaluationDecision.details.rebalance_cadence
        : null);
    if (Number.isFinite(cadence)) {
      const cadenceLabel = formatTradingDays(cadence);
      if (cadenceLabel) {
        evaluationMetrics.push({ label: 'Rebalance cadence', value: cadenceLabel });
      }
    }
    const daysSince =
      (evaluationData.model && Number.isFinite(evaluationData.model.days_since_last_rebalance)
        ? evaluationData.model.days_since_last_rebalance
        : null) ??
      (evaluationDecision && evaluationDecision.details && Number.isFinite(evaluationDecision.details.days_since_last_rebalance)
        ? evaluationDecision.details.days_since_last_rebalance
        : null);
    if (Number.isFinite(daysSince)) {
      evaluationMetrics.push({ label: 'Days since rebalance', value: Math.round(daysSince).toString() });
    }
  }

  let evaluationContent = null;
  if (evaluationStatus === 'ok' && evaluationData) {
    const actionLabel = formatActionLabel(evaluationAction);
    const recent = evaluationData.recent_rebalance || null;
    evaluationContent = (
      <>
        <div className="qqq-section__evaluation-summary">
          <span className={`qqq-section__evaluation-action qqq-section__evaluation-action--${evaluationActionClass}`}>
            {actionLabel}
          </span>
          {evaluationReason && <span className="qqq-section__evaluation-reason">{evaluationReason}</span>}
        </div>
        {evaluationMetrics.length > 0 && (
          <dl className="qqq-section__evaluation-metrics">
            {evaluationMetrics.map((metric) => (
              <div key={metric.label} className="qqq-section__evaluation-metric">
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {recent && recent.date && (
          <div className="qqq-section__evaluation-note">
            <span>Recent action:</span>{' '}
            <strong>{formatDate(recent.date)}</strong>
            {recent.reason ? ` — ${recent.reason}` : ''}
          </div>
        )}
      </>
    );
  } else if (evaluationStatus === 'missing_last_rebalance') {
    evaluationContent = (
      <p className="qqq-section__evaluation-message">
        No last rebalance date is recorded for this account. Update the configuration with a “lastRebalance” value to enable
        model checks.
      </p>
    );
  } else if (evaluationStatus === 'no_positions') {
    evaluationContent = (
      <p className="qqq-section__evaluation-message">
        No positions were found for this account, so the model could not be evaluated.
      </p>
    );
  } else if (evaluationStatus === 'error') {
    evaluationContent = (
      <p className="qqq-section__evaluation-message">
        Unable to evaluate the investment model{evaluation?.message ? `: ${evaluation.message}` : '.'}
      </p>
    );
  }

  const evaluationBlock = evaluationContent ? (
    <div className={`qqq-section__evaluation qqq-section__evaluation--${evaluationStatus}`}>{evaluationContent}</div>
  ) : null;

  return (
    <section className="qqq-section" aria-labelledby={headingId}>
      <div className="qqq-section__header">
        <h2 id={headingId}>{resolvedTitle}</h2>
        <span className="qqq-section__updated">{`Updated ${formatDate(data?.updated)}`}</span>
      </div>

      {lastRebalance && (
        <div className="qqq-section__model-meta">
          <span>
            <span className="qqq-section__meta-label">Last rebalance:</span> {formatDate(lastRebalance)}
          </span>
        </div>
      )}

      <div className="qqq-section__controls">
        <label className="qqq-section__control-label" htmlFor="qqq-temperature-range">
          Time frame
        </label>
        <select
          id="qqq-temperature-range"
          className="qqq-section__control-select"
          value={timeframe}
          onChange={(event) => setTimeframe(event.target.value)}
          disabled={!hasChart || loading}
        >
          {TIMEFRAME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="qqq-section__status" role="status">
          {loadingLabel}
        </div>
      )}

      {!loading && error && (
        <div className="qqq-section__status qqq-section__status--error" role="alert">
          <span>{errorLabel}</span>
          {error.message && <span className="qqq-section__status-detail">{error.message}</span>}
          {onRetry && (
            <button type="button" className="qqq-section__retry" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {!loading && !error && hasChart && (
        <div className="qqq-section__chart-container">
          <svg className="qqq-section__chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-hidden="true">
            <rect
              className="qqq-section__chart-surface"
              x="0"
              y="0"
              width={CHART_WIDTH}
              height={CHART_HEIGHT}
              rx="16"
            />
            {guideLines && (
              <g className="qqq-section__guides">
                <line className="qqq-section__line qqq-section__line--base" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={guideLines.base} y2={guideLines.base} />
                <line className="qqq-section__line qqq-section__line--guide" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={guideLines.upper} y2={guideLines.upper} />
                <line className="qqq-section__line qqq-section__line--guide" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={guideLines.lower} y2={guideLines.lower} />
              </g>
            )}
            {pathD && <path className="qqq-section__series-path" d={pathD} />}
            {marker && <circle className="qqq-section__marker" cx={marker.x} cy={marker.y} r="5" />}
          </svg>
          {marker && latestLabel && labelPosition && (
            <div className="qqq-section__chart-label" style={labelPosition}>
              {latestLabel}
            </div>
          )}
          <div className="qqq-section__chart-footer">
            <span>{formatDate(displayRangeStart)}</span>
            <span>{formatDate(displayRangeEnd)}</span>
          </div>
        </div>
      )}

      {!loading && !error && !hasChart && (
        <div className="qqq-section__status">No {modelName ? 'investment model' : 'QQQ temperature'} data available.</div>
      )}

      {!loading && !error && evaluationBlock}
    </section>
  );
}

QqqTemperatureSection.propTypes = {
  data: PropTypes.shape({
    updated: PropTypes.string,
    rangeStart: PropTypes.string,
    rangeEnd: PropTypes.string,
    growthCurve: PropTypes.shape({
      A: PropTypes.number,
      r: PropTypes.number,
    }),
    series: PropTypes.arrayOf(
      PropTypes.shape({
        date: PropTypes.string.isRequired,
        temperature: PropTypes.number.isRequired,
      })
    ),
    latest: PropTypes.shape({
      date: PropTypes.string,
      temperature: PropTypes.number,
    }),
  }),
  loading: PropTypes.bool,
  error: PropTypes.instanceOf(Error),
  onRetry: PropTypes.func,
  title: PropTypes.string,
  modelName: PropTypes.string,
  lastRebalance: PropTypes.string,
  evaluation: PropTypes.shape({
    status: PropTypes.string,
    data: PropTypes.object,
    message: PropTypes.string,
  }),
};

QqqTemperatureSection.defaultProps = {
  data: null,
  loading: false,
  error: null,
  onRetry: null,
  title: null,
  modelName: null,
  lastRebalance: null,
  evaluation: null,
};
