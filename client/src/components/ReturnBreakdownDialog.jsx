import { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import {
  classifyPnL,
  formatDate,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

const BASE_PERIOD_OPTIONS = [
  { key: 'annualized', label: 'Annualized' },
  { key: '1M', label: '1M', months: 1 },
  { key: '6M', label: '6M', months: 6 },
  { key: '12M', label: '12M', months: 12 },
  { key: '5Y', label: '5Y', months: 60 },
  { key: '10Y', label: '10Y', months: 120 },
];

const VALUE_MODES = [
  { key: 'value', label: 'CAD' },
  { key: 'percent', label: '%' },
];

const CHART_WIDTH = 640;
const CHART_HEIGHT = 260;
const CHART_PADDING = { top: 28, right: 28, bottom: 36, left: 36 };

function addMonthsUtc(base, months) {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const tentative = new Date(Date.UTC(year, month + months, 1));
  const lastDayOfMonth = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfMonth);
  tentative.setUTCDate(clampedDay);
  return tentative;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolveTone(percentValue, moneyValue) {
  if (Number.isFinite(percentValue)) {
    if (percentValue > 0) {
      return 'positive';
    }
    if (percentValue < 0) {
      return 'negative';
    }
    return 'neutral';
  }
  if (Number.isFinite(moneyValue)) {
    return classifyPnL(moneyValue);
  }
  return 'neutral';
}

export default function ReturnBreakdownDialog({
  annualizedRate,
  trailingReturns,
  pnlHistory,
  totalPnl,
  totalEquity,
  netDeposits,
  asOf,
  onClose,
}) {
  const [selectedPeriod, setSelectedPeriod] = useState('annualized');
  const [valueMode, setValueMode] = useState('value');

  const periodOptions = useMemo(() => {
    const options = [];
    const trailing = trailingReturns && typeof trailingReturns === 'object' ? trailingReturns : null;
    BASE_PERIOD_OPTIONS.forEach((option) => {
      if (option.key === 'annualized') {
        options.push(option);
        return;
      }
      const source = trailing ? trailing[option.key] : null;
      if (!source) {
        return;
      }
      const hasMetrics =
        Number.isFinite(source.returnRate) ||
        Number.isFinite(source.annualizedReturnRate) ||
        Number.isFinite(source.pnlCad);
      if (hasMetrics) {
        options.push(option);
      }
    });
    if (!options.length) {
      options.push(BASE_PERIOD_OPTIONS[0]);
    }
    return options;
  }, [trailingReturns]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (!periodOptions.some((option) => option.key === selectedPeriod)) {
      const fallback = periodOptions[0];
      if (fallback) {
        setSelectedPeriod(fallback.key);
      }
    }
  }, [periodOptions, selectedPeriod]);

  const metrics = useMemo(() => {
    const entries = [];
    const percentOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    const availablePeriodKeys = new Set(periodOptions.map((option) => option.key));

    entries.push({
      key: 'annualized',
      label: 'Annualized return',
      percent: Number.isFinite(annualizedRate) ? annualizedRate * 100 : null,
      annualizedPercent: null,
      money: Number.isFinite(totalPnl) ? totalPnl : null,
    });

    const orderedKeys = ['12M', '6M', '1M', '5Y', '10Y'];
    orderedKeys.forEach((key) => {
      if (!availablePeriodKeys.has(key)) {
        return;
      }
      const source = trailingReturns && typeof trailingReturns === 'object' ? trailingReturns[key] : null;
      if (!source) {
        return;
      }
      const baseOption = BASE_PERIOD_OPTIONS.find((option) => option.key === key);
      const label =
        (source && typeof source.label === 'string' && source.label) || (baseOption ? baseOption.label : key);
      const percentValue = source && Number.isFinite(source.returnRate) ? source.returnRate * 100 : null;
      const annualizedPercentValue =
        source && Number.isFinite(source.annualizedReturnRate) ? source.annualizedReturnRate * 100 : null;
      const moneyValue = source && Number.isFinite(source.pnlCad) ? source.pnlCad : null;
      if (percentValue === null && annualizedPercentValue === null && moneyValue === null) {
        return;
      }
      entries.push({
        key,
        label,
        percent: percentValue,
        annualizedPercent: annualizedPercentValue,
        money: moneyValue,
      });
    });

    return entries.map((entry) => {
      const formattedPercent =
        entry.percent !== null ? formatSignedPercent(entry.percent, percentOptions) : '—';
      const formattedAnnualized =
        entry.annualizedPercent !== null
          ? formatSignedPercent(entry.annualizedPercent, percentOptions)
          : null;
      const formattedMoney = entry.money !== null ? formatSignedMoney(entry.money) : null;
      const tone = resolveTone(entry.percent, entry.money);
      const moneyTone = resolveTone(null, entry.money);
      return {
        ...entry,
        formattedPercent,
        formattedAnnualized,
        formattedMoney,
        tone,
        moneyTone,
      };
    });
  }, [annualizedRate, periodOptions, totalPnl, trailingReturns]);

  const normalizedHistory = useMemo(() => {
    if (!Array.isArray(pnlHistory) || pnlHistory.length === 0) {
      return null;
    }
    const mapped = pnlHistory
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const date = typeof entry.date === 'string' ? entry.date : null;
        if (!date) {
          return null;
        }
        let timestamp = Number(entry.timestamp);
        if (!Number.isFinite(timestamp)) {
          const parsed = Date.parse(`${date}T00:00:00Z`);
          timestamp = Number.isNaN(parsed) ? null : parsed;
        }
        const pnlValue = Number(entry.pnlCad);
        const percentValue = Number(entry.pnlPercent);
        const accountValue = Number(entry.accountValue);
        const normalizedPercent = Number.isFinite(percentValue)
          ? percentValue
          : Number.isFinite(pnlValue) && Number.isFinite(accountValue) && Math.abs(accountValue) > 1e-9
            ? pnlValue / accountValue
            : null;
        return {
          date,
          timestamp: Number.isFinite(timestamp) ? timestamp : null,
          pnl: Number.isFinite(pnlValue) ? pnlValue : null,
          percent: Number.isFinite(normalizedPercent) ? normalizedPercent : null,
        };
      })
      .filter((entry) => entry && entry.date && entry.timestamp !== null && entry.pnl !== null);
    if (!mapped.length) {
      return null;
    }
    return mapped.sort((a, b) => a.timestamp - b.timestamp);
  }, [pnlHistory]);

  const chartData = useMemo(() => {
    if (!normalizedHistory || normalizedHistory.length === 0) {
      return null;
    }

    const periodConfig =
      periodOptions.find((option) => option.key === selectedPeriod) || periodOptions[0] || BASE_PERIOD_OPTIONS[0];
    let filtered = normalizedHistory;

    if (selectedPeriod !== 'annualized' && periodConfig && Number.isFinite(periodConfig.months)) {
      const finalEntry = normalizedHistory[normalizedHistory.length - 1];
      const finalTimestamp = Number(finalEntry.timestamp);
      if (Number.isFinite(finalTimestamp)) {
        const startDate = addMonthsUtc(new Date(finalTimestamp), -periodConfig.months);
        const startTime = startDate.getTime();
        let startIndex = -1;
        for (let index = 0; index < normalizedHistory.length; index += 1) {
          const entry = normalizedHistory[index];
          if (Number.isFinite(entry.timestamp) && entry.timestamp >= startTime) {
            startIndex = index;
            break;
          }
        }
        if (startIndex === -1) {
          filtered = normalizedHistory.slice();
        } else if (startIndex > 0) {
          filtered = normalizedHistory.slice(startIndex - 1);
        } else {
          filtered = normalizedHistory.slice();
        }
      }
    }

    if (!filtered.length) {
      filtered = normalizedHistory.slice();
    }

    const baselineEntry = filtered[0];
    const baselineValue = Number.isFinite(baselineEntry?.pnl) ? baselineEntry.pnl : 0;
    const baselinePercent = Number.isFinite(baselineEntry?.percent) ? baselineEntry.percent * 100 : 0;

    const series = filtered.map((entry) => {
      const rawValue = Number.isFinite(entry.pnl) ? entry.pnl : baselineValue;
      const rawPercent = Number.isFinite(entry.percent) ? entry.percent * 100 : baselinePercent;
      return {
        date: entry.date,
        timestamp: entry.timestamp,
        value: rawValue - baselineValue,
        percent: rawPercent - baselinePercent,
      };
    });

    const values = series.map((entry) => (valueMode === 'percent' ? entry.percent : entry.value));
    values.push(0);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    let domainMin = minValue;
    let domainMax = maxValue;
    if (domainMax === domainMin) {
      const spread = Math.abs(domainMax || 1);
      domainMin -= spread * 0.5;
      domainMax += spread * 0.5;
    }
    const padding = (domainMax - domainMin) * 0.1 || Math.abs(domainMax) * 0.1 || 1;
    domainMin -= padding;
    domainMax += padding;

    const innerWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
    const innerHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;

    const mapY = (value) => {
      if (domainMax === domainMin) {
        return CHART_PADDING.top + innerHeight / 2;
      }
      const ratio = (value - domainMin) / (domainMax - domainMin);
      const clampedRatio = clamp(ratio, 0, 1);
      return CHART_PADDING.top + innerHeight * (1 - clampedRatio);
    };

    const points = series.map((entry, index) => {
      const ratio = series.length === 1 ? 0 : index / (series.length - 1);
      const x = CHART_PADDING.left + innerWidth * ratio;
      const currentValue = valueMode === 'percent' ? entry.percent : entry.value;
      return {
        x,
        y: mapY(currentValue),
        date: entry.date,
        timestamp: entry.timestamp,
        value: currentValue,
      };
    });

    const path = points
      .map((point, index) => {
        const command = index === 0 ? 'M' : 'L';
        return `${command}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
      })
      .join(' ');

    const zeroY = mapY(0);
    const startDate = filtered[0]?.date || null;
    const endDate = filtered[filtered.length - 1]?.date || null;
    const lastPoint = points[points.length - 1];
    const finalValue = lastPoint ? lastPoint.value : 0;

    return {
      points,
      path,
      zeroY,
      startDate,
      endDate,
      finalValue,
      finalPoint: lastPoint || null,
    };
  }, [normalizedHistory, periodOptions, selectedPeriod, valueMode]);

  const selectedMetric = metrics.find((entry) => entry.key === selectedPeriod) || metrics[0];
  const selectedPeriodLabel = selectedMetric ? selectedMetric.label : 'Annualized return';

  const formattedFinalValue = useMemo(() => {
    if (!chartData) {
      return '—';
    }
    if (valueMode === 'percent') {
      return formatSignedPercent(chartData.finalValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return formatSignedMoney(chartData.finalValue);
  }, [chartData, valueMode]);

  const chartTone = useMemo(() => {
    if (!chartData) {
      return 'neutral';
    }
    return valueMode === 'percent'
      ? resolveTone(chartData.finalValue, null)
      : resolveTone(null, chartData.finalValue);
  }, [chartData, valueMode]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleDialogClick = (event) => {
    event.stopPropagation();
  };

  const netDepositsLabel = Number.isFinite(netDeposits) ? formatMoney(netDeposits) : '—';
  const totalEquityLabel = Number.isFinite(totalEquity) ? formatMoney(totalEquity) : '—';

  return (
    <div className="return-details-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="return-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="return-details-title"
        onClick={handleDialogClick}
      >
        <header className="return-details-dialog__header">
          <div className="return-details-dialog__heading">
            <h2 id="return-details-title">Return details</h2>
            <p className="return-details-dialog__subtitle">Totals in CAD</p>
            <p className="return-details-dialog__meta">
              <span>Net deposits: {netDepositsLabel}</span>
              <span>Total equity: {totalEquityLabel}</span>
            </p>
            {asOf && <p className="return-details-dialog__timestamp">As of {formatDate(asOf)}</p>}
          </div>
          <button type="button" className="return-details-dialog__close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>

        <div className="return-details-dialog__body">
          <section className="return-details-dialog__metrics">
            <dl>
              {metrics.map((metric) => (
                <div key={metric.key} className="return-details-dialog__metric-row">
                  <dt>{metric.label}</dt>
                  <dd>
                    <span className={`return-details-dialog__metric-value return-details-dialog__metric-value--${metric.tone}`}>
                      {metric.formattedPercent}
                    </span>
                    {(metric.formattedAnnualized || metric.formattedMoney) && (
                      <div className="return-details-dialog__metric-sub">
                        {metric.formattedAnnualized ? (
                          <span className="return-details-dialog__metric-extra">
                            <span className="return-details-dialog__metric-extra-label">Annualized:</span>
                            <span
                              className={`return-details-dialog__metric-extra-value return-details-dialog__metric-extra-value--${metric.tone}`}
                            >
                              {metric.formattedAnnualized}
                            </span>
                            {metric.formattedMoney && (
                              <span className="return-details-dialog__metric-extra-money">
                                (
                                <span
                                  className={`return-details-dialog__metric-extra-value return-details-dialog__metric-extra-value--${metric.moneyTone}`}
                                >
                                  {metric.formattedMoney}
                                </span>
                                )
                              </span>
                            )}
                          </span>
                        ) : (
                          metric.formattedMoney && (
                            <span className="return-details-dialog__metric-extra">
                              <span className="return-details-dialog__metric-extra-money">
                                (
                                <span
                                  className={`return-details-dialog__metric-extra-value return-details-dialog__metric-extra-value--${metric.moneyTone}`}
                                >
                                  {metric.formattedMoney}
                                </span>
                                )
                              </span>
                            </span>
                          )
                        )}
                      </div>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="return-details-dialog__chart-section">
            <div className="return-details-dialog__chart-toolbar">
              <div className="return-details-dialog__controls" role="group" aria-label="Select return period">
                {periodOptions.map((option) => {
                  const isActive = selectedPeriod === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={`return-details-dialog__control${isActive ? ' return-details-dialog__control--active' : ''}`}
                      onClick={() => setSelectedPeriod(option.key)}
                      aria-pressed={isActive}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="return-details-dialog__controls" role="group" aria-label="Select chart display">
                {VALUE_MODES.map((mode) => {
                  const isActive = valueMode === mode.key;
                  return (
                    <button
                      key={mode.key}
                      type="button"
                      className={`return-details-dialog__control${isActive ? ' return-details-dialog__control--active' : ''}`}
                      onClick={() => setValueMode(mode.key)}
                      aria-pressed={isActive}
                    >
                      {mode.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {chartData ? (
              <div className="return-details-dialog__chart-wrapper">
                <svg className="return-details-dialog__chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-hidden="true">
                  <rect
                    className="return-details-dialog__chart-surface"
                    x="0"
                    y="0"
                    width={CHART_WIDTH}
                    height={CHART_HEIGHT}
                    rx="12"
                    ry="12"
                  />
                  <line
                    className="return-details-dialog__chart-baseline"
                    x1={CHART_PADDING.left}
                    y1={chartData.zeroY}
                    x2={CHART_WIDTH - CHART_PADDING.right}
                    y2={chartData.zeroY}
                  />
                  <path className="return-details-dialog__chart-path" d={chartData.path} />
                  {chartData.finalPoint && (
                    <circle
                      className="return-details-dialog__chart-marker"
                      cx={chartData.finalPoint.x}
                      cy={chartData.finalPoint.y}
                      r="4"
                    />
                  )}
                </svg>
                <div className="return-details-dialog__chart-footer">
                  <div className="return-details-dialog__chart-range">
                    <span>{selectedPeriodLabel}</span>
                    <span>
                      {chartData.startDate ? formatDate(chartData.startDate) : '—'} →{' '}
                      {chartData.endDate ? formatDate(chartData.endDate) : '—'}
                    </span>
                  </div>
                  <div className={`return-details-dialog__chart-total return-details-dialog__chart-total--${chartTone}`}>
                    {formattedFinalValue}
                  </div>
                </div>
              </div>
            ) : (
              <div className="return-details-dialog__chart-empty">Return history isn&apos;t available yet.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const trailingReturnShape = PropTypes.shape({
  label: PropTypes.string,
  startDate: PropTypes.string,
  endDate: PropTypes.string,
  pnlCad: PropTypes.number,
  returnRate: PropTypes.number,
  annualizedReturnRate: PropTypes.number,
});

const historyEntryShape = PropTypes.shape({
  date: PropTypes.string.isRequired,
  timestamp: PropTypes.number,
  netDeposits: PropTypes.number,
  pnlCad: PropTypes.number,
  accountValue: PropTypes.number,
  pnlPercent: PropTypes.number,
});

ReturnBreakdownDialog.propTypes = {
  annualizedRate: PropTypes.number,
  trailingReturns: PropTypes.objectOf(trailingReturnShape),
  pnlHistory: PropTypes.arrayOf(historyEntryShape),
  totalPnl: PropTypes.number,
  totalEquity: PropTypes.number,
  netDeposits: PropTypes.number,
  asOf: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};

ReturnBreakdownDialog.defaultProps = {
  annualizedRate: null,
  trailingReturns: null,
  pnlHistory: null,
  totalPnl: null,
  totalEquity: null,
  netDeposits: null,
  asOf: null,
};
