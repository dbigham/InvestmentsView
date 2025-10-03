import { useEffect, useMemo } from 'react';
import PropTypes from 'prop-types';
import { PERFORMANCE_RANGES, buildRangeSummary, resolveRangeDefinition } from '../utils/performance';
import {
  formatDate,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

function PerformanceChart({ data }) {
  if (!Array.isArray(data) || data.length < 2) {
    return <p className="performance-dialog__chart-empty">Not enough data to render a chart.</p>;
  }

  const points = data
    .map((entry) => ({
      date: entry.date,
      value: Number(entry.value) || 0,
    }))
    .filter((entry) => Number.isFinite(entry.value));

  if (points.length < 2) {
    return <p className="performance-dialog__chart-empty">Not enough data to render a chart.</p>;
  }

  const values = points.map((entry) => entry.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const width = 128;
  const height = 68;
  const padding = { top: 6, right: 24, bottom: 12, left: 8 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const range = maxValue - minValue;
  const domainPadding = range === 0 ? Math.max(1, Math.abs(maxValue) * 0.05) : range * 0.1;
  const domainMin = minValue - domainPadding;
  const domainMax = maxValue + domainPadding;
  const domainRange = domainMax - domainMin || 1;

  const xForIndex = (index) => {
    if (points.length === 1) {
      return padding.left + innerWidth / 2;
    }
    return padding.left + (innerWidth * index) / (points.length - 1);
  };

  const yForValue = (value) => {
    const ratio = (value - domainMin) / domainRange;
    const clamped = Math.max(0, Math.min(1, ratio));
    return padding.top + innerHeight * (1 - clamped);
  };

  const svgPoints = points.map((point, index) => ({
    x: xForIndex(index),
    y: yForValue(point.value),
    value: point.value,
  }));

  const path = svgPoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');

  const tickCount = 2;
  const gridLines = Array.from({ length: tickCount + 1 }, (_, index) => {
    const value = domainMin + (domainRange * index) / tickCount;
    return { value, y: yForValue(value) };
  });

  const lastPoint = svgPoints[svgPoints.length - 1];

  return (
    <svg className="performance-dialog__chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Account value over time">
      <rect className="performance-chart__surface" x="0" y="0" width={width} height={height} rx="4" />
      <g className="performance-chart__grid" aria-hidden="true">
        {gridLines.map((line, index) => (
          <g key={`grid-${index}`}>
            <line
              className="performance-chart__grid-line"
              x1={padding.left}
              y1={line.y}
              x2={width - padding.right}
              y2={line.y}
            />
            <text className="performance-chart__grid-label" x={width - padding.right + 4} y={line.y + 3}>
              {formatMoney(line.value)}
            </text>
          </g>
        ))}
      </g>
      <path className="performance-chart__path" d={path} />
      <circle className="performance-chart__dot" cx={lastPoint.x} cy={lastPoint.y} r="1.2" />
    </svg>
  );
}

PerformanceChart.propTypes = {
  data: PropTypes.arrayOf(
    PropTypes.shape({
      date: PropTypes.string.isRequired,
      value: PropTypes.number.isRequired,
    })
  ),
};

PerformanceChart.defaultProps = {
  data: [],
};

export default function AccountPerformanceDialog({
  performance,
  status,
  onClose,
  range,
  onRangeChange,
  error,
}) {
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

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const resolvedRange = resolveRangeDefinition(range);
  const summary = useMemo(() => buildRangeSummary(performance, resolvedRange.value), [performance, resolvedRange.value]);

  let bodyContent = null;

  if (status === 'loading') {
    bodyContent = (
      <div className="performance-dialog__status" role="status" aria-live="polite">
        <span className="visually-hidden">Loading performance data…</span>
        <span className="performance-dialog__spinner" aria-hidden="true" />
      </div>
    );
  } else if (status === 'error') {
    bodyContent = (
      <div className="performance-dialog__status performance-dialog__status--error" role="alert">
        <strong>Unable to load performance data.</strong>
        <p>{error?.message || 'Something went wrong while calculating performance.'}</p>
      </div>
    );
  } else {
    const percent = summary.totalReturn !== null ? formatSignedPercent(summary.totalReturn * 100) : '—';
    const cagr = summary.cagr !== null ? formatSignedPercent(summary.cagr * 100) : '—';
    bodyContent = (
      <>
        <dl className="performance-dialog__metrics">
          <div className="performance-dialog__metric">
            <dt>Total P&amp;L</dt>
            <dd>
              <span className="performance-dialog__metric-value">{formatSignedMoney(summary.totalPnl)}</span>
              <span className="performance-dialog__metric-extra">{percent}</span>
            </dd>
          </div>
          <div className="performance-dialog__metric">
            <dt>CAGR</dt>
            <dd>
              <span className="performance-dialog__metric-value">{cagr}</span>
            </dd>
          </div>
        </dl>
        <div className="performance-dialog__chart">
          <PerformanceChart data={summary.timeline.map((entry) => ({ date: entry.date, value: Number(entry.value) || 0 }))} />
        </div>
        <div className="performance-dialog__summary-grid">
          <div>
            <span className="performance-dialog__summary-label">Start ({formatDate(summary.startDate)})</span>
            <span className="performance-dialog__summary-value">{formatMoney(summary.startValue)}</span>
          </div>
          <div>
            <span className="performance-dialog__summary-label">End ({formatDate(summary.endDate)})</span>
            <span className="performance-dialog__summary-value">{formatMoney(summary.endValue)}</span>
          </div>
          <div>
            <span className="performance-dialog__summary-label">Contributions</span>
            <span className="performance-dialog__summary-value">{formatMoney(summary.contributions)}</span>
          </div>
          <div>
            <span className="performance-dialog__summary-label">Withdrawals</span>
            <span className="performance-dialog__summary-value">{formatMoney(summary.withdrawals)}</span>
          </div>
        </div>
        <p className="performance-dialog__disclaimer" role="note">
          Performance is estimated from trade history and public price data. Dividends, cash transfers, and other adjustments may not be included.
        </p>
      </>
    );
  }

  return (
    <div className="performance-overlay" role="presentation" onClick={handleOverlayClick}>
      <div className="performance-dialog" role="dialog" aria-modal="true" aria-labelledby="performance-dialog-title">
        <header className="performance-dialog__header">
          <div className="performance-dialog__heading">
            <h2 id="performance-dialog-title">Account performance</h2>
            <div className="performance-dialog__controls">
              <label htmlFor="performance-range">Time period</label>
              <select
                id="performance-range"
                value={resolvedRange.value}
                onChange={(event) => onRangeChange(event.target.value)}
              >
                {PERFORMANCE_RANGES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="button" className="performance-dialog__close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="performance-dialog__body">{bodyContent}</div>
      </div>
    </div>
  );
}

AccountPerformanceDialog.propTypes = {
  performance: PropTypes.shape({
    timeline: PropTypes.arrayOf(
      PropTypes.shape({
        date: PropTypes.string.isRequired,
        value: PropTypes.number.isRequired,
      })
    ),
    cashFlows: PropTypes.arrayOf(
      PropTypes.shape({
        timestamp: PropTypes.string,
        amount: PropTypes.number,
      })
    ),
    totals: PropTypes.shape({
      startDate: PropTypes.string,
      endDate: PropTypes.string,
      startValue: PropTypes.number,
      endValue: PropTypes.number,
      totalPnl: PropTypes.number,
      totalReturn: PropTypes.number,
      cagr: PropTypes.number,
      totalContributions: PropTypes.number,
      totalWithdrawals: PropTypes.number,
    }),
    metadata: PropTypes.object,
  }),
  status: PropTypes.oneOf(['idle', 'loading', 'ready', 'error']).isRequired,
  onClose: PropTypes.func.isRequired,
  range: PropTypes.string.isRequired,
  onRangeChange: PropTypes.func.isRequired,
  error: PropTypes.instanceOf(Error),
};

AccountPerformanceDialog.defaultProps = {
  performance: null,
  error: null,
};
