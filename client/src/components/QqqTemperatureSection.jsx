import { useCallback, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDate, formatMoney, formatNumber, formatPercent } from '../utils/formatters';
import { copyTextToClipboard } from '../utils/clipboard';

const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;
const PADDING = { top: 6, right: 0, bottom: 4.5, left: 0 };
const DEFAULT_REFERENCE_TEMPERATURES = [1, 1.5, 0.5];
const SUPPLEMENTAL_REFERENCE_TEMPERATURES = [0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3, 1.4];
const EXTENDED_REFERENCE_TEMPERATURES = [1.6, 1.7, 1.8, 1.9, 2];

const TIMEFRAME_OPTIONS = [
  { value: '1M', label: '1 month' },
  { value: '1Y', label: '1 year' },
  { value: '5Y', label: '5 years' },
  { value: '10Y', label: '10 years' },
  { value: '15Y', label: '15 years' },
  { value: '20Y', label: '20 years' },
  { value: '25Y', label: '25 years' },
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

function toUtcDateOnly(date) {
  if (!(date instanceof Date)) {
    return null;
  }
  // Normalize to a UTC date-only timestamp for consistent day math
  const iso = date.toISOString().slice(0, 10);
  const normalized = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(normalized.getTime()) ? null : normalized;
}

function countBusinessDaysSince(dateString) {
  const start = parseDate(dateString);
  if (!start) {
    return null;
  }
  const today = toUtcDateOnly(new Date());
  const startDay = toUtcDateOnly(start);
  if (!today || !startDay) {
    return null;
  }
  if (today <= startDay) {
    return 0;
  }
  let count = 0;
  const cursor = new Date(startDay.getTime());
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= today) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      count += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
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
    case '15Y':
      result.setFullYear(result.getFullYear() - 15);
      break;
    case '20Y':
      result.setFullYear(result.getFullYear() - 20);
      break;
    case '25Y':
      result.setFullYear(result.getFullYear() - 25);
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

function buildChartMetrics(series, referenceTemperatures = DEFAULT_REFERENCE_TEMPERATURES) {
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
  const normalizedReferenceTemperatures = Array.isArray(referenceTemperatures)
    ? referenceTemperatures.filter((value) => Number.isFinite(value))
    : [];
  const referenceValues = normalizedReferenceTemperatures.length
    ? normalizedReferenceTemperatures
    : DEFAULT_REFERENCE_TEMPERATURES;
  const minValue = Math.min(...values, ...referenceValues);
  const maxValue = Math.max(...values, ...referenceValues);
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
  onMarkRebalanced,
  accountUrl,
}) {
  const [timeframe, setTimeframe] = useState('5Y');
  const [markingRebalanced, setMarkingRebalanced] = useState(false);
  const [completedTrades, setCompletedTrades] = useState(() => new Set());
  const filteredSeries = useMemo(() => filterSeries(data?.series, timeframe), [data?.series, timeframe]);
  const latestTemperature = Number(data?.latest?.temperature);
  const referenceTemperatures = useMemo(() => {
    if (!Array.isArray(data?.referenceTemperatures)) {
      return DEFAULT_REFERENCE_TEMPERATURES;
    }
    const normalized = data.referenceTemperatures
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (!normalized.length) {
      return DEFAULT_REFERENCE_TEMPERATURES;
    }
    return normalized;
  }, [data?.referenceTemperatures]);
  const maxSeriesTemperature = useMemo(() => {
    if (!Array.isArray(filteredSeries) || filteredSeries.length === 0) {
      return null;
    }
    const numeric = filteredSeries
      .map((entry) => Number(entry.temperature))
      .filter((value) => Number.isFinite(value));
    if (numeric.length === 0) {
      return null;
    }
    return Math.max(...numeric);
  }, [filteredSeries]);
  const supplementalReferenceTemperatures = useMemo(() => {
    if (Number.isFinite(maxSeriesTemperature) && maxSeriesTemperature > 3) {
      return [];
    }
    const values = [...SUPPLEMENTAL_REFERENCE_TEMPERATURES];
    if (Number.isFinite(latestTemperature) && latestTemperature > 1.5) {
      values.push(...EXTENDED_REFERENCE_TEMPERATURES);
    }
    return values;
  }, [latestTemperature, maxSeriesTemperature]);
  const domainReferenceTemperatures = useMemo(() => {
    const combined = new Set();
    referenceTemperatures.forEach((value) => {
      if (Number.isFinite(value)) {
        combined.add(value);
      }
    });
    supplementalReferenceTemperatures.forEach((value) => {
      if (Number.isFinite(value)) {
        combined.add(value);
      }
    });
    if (combined.size === 0) {
      DEFAULT_REFERENCE_TEMPERATURES.forEach((value) => combined.add(value));
    }
    return Array.from(combined);
  }, [referenceTemperatures, supplementalReferenceTemperatures]);
  const chartMetrics = useMemo(
    () => buildChartMetrics(filteredSeries, domainReferenceTemperatures),
    [filteredSeries, domainReferenceTemperatures],
  );
  const latestLabel = Number.isFinite(latestTemperature)
    ? `T = ${formatNumber(latestTemperature, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;

  const hasChart = chartMetrics && chartMetrics.points.length >= 1;
  const additionalReferenceLines = useMemo(() => {
    if (!hasChart || !chartMetrics) {
      return [];
    }
    const baselineSet = new Set(
      referenceTemperatures
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    );
    return supplementalReferenceTemperatures
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && !baselineSet.has(value))
      .map((value) => ({ value, y: chartMetrics.yFor(value) }))
      .filter((entry) => Number.isFinite(entry.y));
  }, [chartMetrics, hasChart, referenceTemperatures, supplementalReferenceTemperatures]);
  const displayRangeStart = chartMetrics ? chartMetrics.rangeStart : data?.rangeStart;
  const displayRangeEnd = chartMetrics ? chartMetrics.rangeEnd : data?.rangeEnd;
  const resolvedTitle = title || (modelName ? 'Investment Model' : 'QQQ temperature');
  const generatedId = useId();
  const headingId = modelName
    ? `investment-model-heading-${generatedId}`
    : `qqq-temperature-heading-${generatedId}`;
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
    const unique = Array.from(new Set(referenceTemperatures)).filter((value) => Number.isFinite(value));
    if (!unique.length) {
      return null;
    }
    let baseTemperature = unique[0];
    let smallestDistance = Math.abs(baseTemperature - 1);
    for (let i = 1; i < unique.length; i += 1) {
      const candidate = unique[i];
      const distance = Math.abs(candidate - 1);
      if (distance < smallestDistance) {
        smallestDistance = distance;
        baseTemperature = candidate;
      }
    }
    const higher = unique.filter((value) => value > baseTemperature).sort((a, b) => a - b);
    const lower = unique.filter((value) => value < baseTemperature).sort((a, b) => b - a);
    const guides = {
      base: chartMetrics.yFor(baseTemperature),
    };
    if (higher.length) {
      guides.upper = chartMetrics.yFor(higher[0]);
    }
    if (lower.length) {
      guides.lower = chartMetrics.yFor(lower[0]);
    }
    return guides;
  }, [chartMetrics, hasChart, referenceTemperatures]);

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

  const toggleTrade = useCallback((rowKey) => {
    setCompletedTrades((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }, []);

  const evaluationStatus = evaluation?.status || null;
  const evaluationData = evaluationStatus === 'ok' && evaluation && typeof evaluation === 'object' ? evaluation.data || null : null;
  const evaluationDecision = evaluationData && typeof evaluationData === 'object' ? evaluationData.decision || null : null;
  const evaluationReason = evaluationDecision && typeof evaluationDecision === 'object' ? evaluationDecision.reason || null : null;
  const evaluationDescription =
    evaluationDecision && typeof evaluationDecision === 'object' ? evaluationDecision.description || null : null;
  const evaluationAction = evaluationDecision && typeof evaluationDecision === 'object' ? evaluationDecision.action || null : null;
  const evaluationActionClass = evaluationAction
    ? String(evaluationAction)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
    : 'hold';
  const normalizedEvaluationAction = evaluationAction
    ? String(evaluationAction)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
    : '';
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
    const recentReasonToken = (() => {
      const r = evaluationData?.recent_rebalance?.reason || '';
      const l = evaluationData?.recent_rebalance?.reason_label || '';
      return String(r || l).trim().toLowerCase();
    })();

    const targetAllocation =
      (evaluationData.model && isFiniteNumber(evaluationData.model.target_allocation)
        ? evaluationData.model.target_allocation
        : null) ??
      (evaluationDecision && evaluationDecision.details && isFiniteNumber(evaluationDecision.details.target_p)
        ? evaluationDecision.details.target_p
        : null);
    const hideTargetForDerisk = recentReasonToken.includes('forced') && recentReasonToken.includes('derisk');
    if (isFiniteNumber(targetAllocation) && !hideTargetForDerisk) {
      evaluationMetrics.push({
        label: 'Target allocation',
        value: formatPercent(targetAllocation * 100, percentOptions),
      });
    }
    const baseAllocation = evaluationData.model && isFiniteNumber(evaluationData.model.base_allocation)
      ? evaluationData.model.base_allocation
      : null;
    if (isFiniteNumber(baseAllocation)) {
      const matchesTarget =
        isFiniteNumber(targetAllocation) && Math.abs(baseAllocation - targetAllocation) < 1e-6;
      if (!matchesTarget) {
        evaluationMetrics.push({
          label: 'Base allocation',
          value: formatPercent(baseAllocation * 100, percentOptions),
        });
      }
    }
    const cadence =
      (evaluationData.model && Number.isFinite(evaluationData.model.rebalance_cadence)
        ? evaluationData.model.rebalance_cadence
        : null) ??
      (evaluationDecision && evaluationDecision.details && Number.isFinite(evaluationDecision.details.rebalance_cadence)
        ? evaluationDecision.details.rebalance_cadence
        : null);
    if (Number.isFinite(cadence)) {
      const isDefaultCadence = Math.abs(cadence - 22) < 1e-6;
      if (!isDefaultCadence) {
        const cadenceLabel = formatTradingDays(cadence);
        if (cadenceLabel) {
          evaluationMetrics.push({ label: 'Rebalance cadence', value: cadenceLabel });
        }
      }
    }
    // Prefer manual lastRebalance (accounts.json) for days-since metric to avoid
    // implying a rebalance occurred due to a recent model event.
    const manualDaysSince = lastRebalance != null ? countBusinessDaysSince(lastRebalance) : null;
    const modelDaysSince =
      (evaluationData.model && Number.isFinite(evaluationData.model.days_since_last_rebalance)
        ? evaluationData.model.days_since_last_rebalance
        : null) ??
      (evaluationDecision && evaluationDecision.details && Number.isFinite(evaluationDecision.details.days_since_last_rebalance)
        ? evaluationDecision.details.days_since_last_rebalance
        : null);
    const daysSinceResolved =
      Number.isFinite(manualDaysSince) ? manualDaysSince : Number.isFinite(modelDaysSince) ? modelDaysSince : null;
    if (Number.isFinite(daysSinceResolved)) {
      const roundedDaysSince = Math.round(daysSinceResolved);
      if (roundedDaysSince !== 0) {
        evaluationMetrics.push({ label: 'Days since rebalance', value: roundedDaysSince.toString() });
      }
    }
  }

  let evaluationContent = null;
  if (evaluationStatus === 'ok' && evaluationData) {
    const actionLabel = formatActionLabel(evaluationAction);
    const recent = (() => {
      const ev = evaluationData.recent_rebalance || null;
      if (!ev) return null;
      const label = ev.reason_label || formatActionLabel(ev.reason);
      let desc = ev.reason_description || '';
      if (!desc) {
        const token = (ev.reason || label || '').toString().toLowerCase();
        if (token.includes('forced') && token.includes('derisk')) {
          desc = 'Crash guard forced a cash move.';
        }
      }
      return { ...ev, reason: [label, desc].filter(Boolean).join(': ') };
    })();
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
        {Array.isArray(evaluationData.trades) && evaluationData.trades.length > 0 && (
          <>
            {accountUrl && (
              <div className="qqq-section__account-link">
                <a
                  className="invest-plan-dialog__account-link"
                  href={accountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open account in Questrade
                </a>
              </div>
            )}
            <div className="invest-plan-purchases-wrapper">
              <table className="invest-plan-purchases">
                <thead>
                  <tr>
                    <th scope="col" className="invest-plan-purchases__checkbox-header">Done</th>
                    <th scope="col">Action</th>
                    <th scope="col">Symbol</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Shares</th>
                    <th scope="col">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluationData.trades.map((t, idx) => {
                    const key = `${t?.symbol || ''}|${t?.action || ''}|${idx}`;
                    const side = (t?.action || '').toString().toUpperCase();
                    const symbol = (t?.symbol || '').toString();
                    const dollars = Number(t?.dollars);
                    const shares = Number(t?.shares);
                    const price = Number(t?.price);
                    const amountCopy = Number.isFinite(dollars) ? Math.abs(dollars).toFixed(2) : null;
                    const shareCopy = Number.isFinite(shares) ? Math.abs(shares).toString() : null;
                    const amountLabel = Number.isFinite(dollars) ? formatMoney(Math.abs(dollars)) : '—';
                    const shareLabel = Number.isFinite(shares)
                      ? formatNumber(Math.abs(shares), { minimumFractionDigits: 0, maximumFractionDigits: 4 })
                      : '—';
                    const priceLabel = Number.isFinite(price)
                      ? formatMoney(price, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
                      : '—';
                    const isCompleted = completedTrades.has(key);
                    const rowClass = isCompleted
                      ? 'invest-plan-purchases__row invest-plan-purchases__row--completed'
                      : 'invest-plan-purchases__row';
                    const actionClass = side === 'BUY' ? 'qqq-trade-action qqq-trade-action--buy' : 'qqq-trade-action qqq-trade-action--sell';
                    return (
                      <tr key={key} className={rowClass}>
                        <td className="invest-plan-purchases__checkbox-cell">
                          <input
                            type="checkbox"
                            className="invest-plan-purchases__checkbox"
                            checked={isCompleted}
                            onChange={() => toggleTrade(key)}
                            aria-label={`Mark ${symbol} ${side.toLowerCase()} as ${isCompleted ? 'not completed' : 'completed'}`}
                          />
                        </td>
                        <td><span className={actionClass}>{side}</span></td>
                        <th scope="row">
                          <div className="invest-plan-symbol">
                            {symbol ? (
                              <button
                                type="button"
                                className="invest-plan-symbol__ticker"
                                onClick={() => copyTextToClipboard(symbol)}
                                title="Copy symbol"
                                aria-label={`Copy ${symbol} symbol`}
                              >
                                {symbol}
                              </button>
                            ) : (
                              <span className="invest-plan-symbol__ticker">{symbol}</span>
                            )}
                          </div>
                        </th>
                        <td>
                          {amountCopy ? (
                            <button type="button" className="invest-plan-copy-button" onClick={() => copyTextToClipboard(amountCopy)}>
                              {amountLabel}
                            </button>
                          ) : (
                            <span className="invest-plan-copy-button invest-plan-copy-button--disabled">{amountLabel}</span>
                          )}
                        </td>
                        <td>
                          {shareCopy ? (
                            <button type="button" className="invest-plan-copy-button" onClick={() => copyTextToClipboard(shareCopy)}>
                              {shareLabel}
                            </button>
                          ) : (
                            <span className="invest-plan-copy-button invest-plan-copy-button--disabled">{shareLabel}</span>
                          )}
                        </td>
                        <td>{priceLabel}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
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
  const targetMetText = 'target allocation already met';
  const normalizedReason = evaluationReason ? String(evaluationReason).toLowerCase() : '';
  const normalizedDescription = evaluationDescription ? String(evaluationDescription).toLowerCase() : '';
  const allowHoldOverride = normalizedReason.includes(targetMetText) || normalizedDescription.includes(targetMetText);
  const canMarkRebalanced = Boolean(
    lastRebalance &&
      typeof onMarkRebalanced === 'function' &&
      normalizedEvaluationAction &&
      (normalizedEvaluationAction !== 'hold' || allowHoldOverride)
  );
  const showModelMeta = Boolean(lastRebalance || canMarkRebalanced);

  const handleMarkRebalanced = useCallback(async () => {
    if (!onMarkRebalanced || markingRebalanced) {
      return;
    }
    setMarkingRebalanced(true);
    try {
      await onMarkRebalanced();
    } catch (error) {
      console.error('Failed to mark investment model as rebalanced', error);
    } finally {
      setMarkingRebalanced(false);
    }
  }, [onMarkRebalanced, markingRebalanced]);

  return (
    <section className="qqq-section" aria-labelledby={headingId}>
      <div className="qqq-section__header">
        <h2 id={headingId}>{resolvedTitle}</h2>
        <span className="qqq-section__updated">{`Updated ${formatDate(data?.updated)}`}</span>
      </div>

      {showModelMeta && (
        <div className="qqq-section__model-meta">
          {lastRebalance && (
            <span>
              <span className="qqq-section__meta-label">Last rebalance:</span> {formatDate(lastRebalance)}
            </span>
          )}
          {canMarkRebalanced && (
            <button
              type="button"
              className="qqq-section__mark-button"
              onClick={handleMarkRebalanced}
              disabled={markingRebalanced || loading}
            >
              {markingRebalanced ? 'Working…' : 'Mark as Rebalanced'}
            </button>
          )}
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
            {additionalReferenceLines.length > 0 && (
              <g className="qqq-section__reference-lines">
                {additionalReferenceLines.map((line) => (
                  <line
                    key={line.value}
                    className="qqq-section__line qqq-section__line--reference"
                    x1={PADDING.left}
                    x2={CHART_WIDTH - PADDING.right}
                    y1={line.y}
                    y2={line.y}
                  />
                ))}
              </g>
            )}
            {guideLines && (
              <g className="qqq-section__guides">
                {Number.isFinite(guideLines.base) && (
                  <line
                    className="qqq-section__line qqq-section__line--base"
                    x1={PADDING.left}
                    x2={CHART_WIDTH - PADDING.right}
                    y1={guideLines.base}
                    y2={guideLines.base}
                  />
                )}
                {Number.isFinite(guideLines.upper) && (
                  <line
                    className="qqq-section__line qqq-section__line--guide"
                    x1={PADDING.left}
                    x2={CHART_WIDTH - PADDING.right}
                    y1={guideLines.upper}
                    y2={guideLines.upper}
                  />
                )}
                {Number.isFinite(guideLines.lower) && (
                  <line
                    className="qqq-section__line qqq-section__line--guide"
                    x1={PADDING.left}
                    x2={CHART_WIDTH - PADDING.right}
                    y1={guideLines.lower}
                    y2={guideLines.lower}
                  />
                )}
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
      startDate: PropTypes.string,
      manualOverride: PropTypes.bool,
    }),
    referenceTemperatures: PropTypes.arrayOf(PropTypes.number),
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
  onMarkRebalanced: PropTypes.func,
  accountUrl: PropTypes.string,
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
  onMarkRebalanced: null,
  accountUrl: null,
};
