import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { getTotalPnlSeries, setAccountMetadata } from '../api/questrade';
import { formatDate, formatMoney, formatNumber } from '../utils/formatters';

const CHART_WIDTH = 680;
const CHART_HEIGHT = 260;
const PADDING = { top: 6, right: 48, bottom: 30, left: 0 };
const AXIS_TARGET_INTERVALS = 4;

const PROJECTION_TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 year' },
  { value: 3, label: '3 years' },
  { value: 5, label: '5 years' },
  { value: 10, label: '10 years' },
  { value: 20, label: '20 years' },
  { value: 30, label: '30 years' },
  { value: 40, label: '40 years' },
  { value: 50, label: '50 years' },
];

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

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const years = Math.floor(targetMonth / 12);
  const newMonth = targetMonth % 12;
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCMonth(newMonth);
  return d;
}

function toDateOnly(date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toPlainDateString(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : toDateOnly(d);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : toDateOnly(d);
}

function formatMoneyCompact(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) {
    const num = abs / 1e9;
    const digits = num >= 100 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return `${sign}$${formatNumber(num, digits)} b`;
  }
  if (abs >= 1e6) {
    const num = abs / 1e6;
    return `${sign}$${formatNumber(num, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} m`;
  }
  if (abs >= 1e3) {
    const num = abs / 1e3;
    return `${sign}$${formatNumber(num, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}K`;
  }
  return `${sign}$${formatNumber(abs, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function buildMilestones(years) {
  const Y = Math.max(1, Math.floor(years));
  const points = new Set([Y]);
  [10, 20, 30, 40, 50].forEach((m) => {
    if (m <= Y) points.add(m);
  });
  if (Y <= 10 && Y >= 5) points.add(5);
  if (Y >= 3 && Y < 5) points.add(1);
  return Array.from(points).sort((a, b) => a - b);
}

function computeProjectionSeries({ startDate, startValue, annualRate, years }) {
  if (!Number.isFinite(startValue) || !Number.isFinite(annualRate) || !Number.isFinite(years)) {
    return [];
  }
  const totalMonths = Math.max(1, Math.round(years * 12));
  const monthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  const points = [];
  const base = toDateOnly(startDate);
  for (let i = 0; i <= totalMonths; i += 1) {
    const date = addMonths(base, i);
    const monthsElapsed = i;
    const value = startValue * Math.pow(1 + monthlyRate, monthsElapsed);
    points.push({ date: toPlainDateString(date), value });
  }
  return points;
}

function buildChartMetrics(seriesA, seriesB, { rangeStartDate, rangeEndDate }) {
  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const parsedRangeStart = parseDateOnly(rangeStartDate);
  const parsedRangeEnd = parseDateOnly(rangeEndDate);
  const domainDuration = parsedRangeStart && parsedRangeEnd ? Math.max(0, parsedRangeEnd - parsedRangeStart) : 0;

  const finiteValues = [];
  const collectValues = (series, resolver) => {
    if (!Array.isArray(series)) return;
    series.forEach((entry) => {
      const v = resolver(entry);
      if (Number.isFinite(v)) finiteValues.push(v);
    });
  };
  collectValues(seriesA, (e) => e?.value);
  collectValues(seriesB, (e) => e?.value);
  if (!finiteValues.length) {
    return null;
  }
  const minValue = Math.min(...finiteValues, 0);
  const maxValue = Math.max(...finiteValues, 0);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(10, Math.abs(maxValue) * 0.1 || 10) : Math.max(10, range * 0.1);
  const rawMinDomain = minValue - padding;
  const rawMaxDomain = maxValue + padding;
  const { minDomain, maxDomain, ticks } = buildAxisScale(rawMinDomain, rawMaxDomain);
  const domainRange = maxDomain - minDomain || 1;

  const normalizePoint = (entry) => {
    const v = Number.isFinite(entry?.value) ? entry.value : 0;
    const d = parseDateOnly(entry?.date);
    let ratio = 0;
    if (parsedRangeStart && parsedRangeEnd && domainDuration > 0 && d) {
      ratio = (d - parsedRangeStart) / domainDuration;
    }
    const clampedRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const normalized = (v - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    const y = PADDING.top + innerHeight * (1 - clamped);
    return { x: PADDING.left + innerWidth * clampedRatio, y, date: entry?.date, value: v };
  };

  const pointsA = Array.isArray(seriesA) ? seriesA.map(normalizePoint) : [];
  const pointsB = Array.isArray(seriesB) ? seriesB.map(normalizePoint) : [];

  return {
    pointsA,
    pointsB,
    axisTicks: ticks.map((value) => ({ value, y: PADDING.top + innerHeight * (1 - (value - minDomain) / (domainRange || 1)) })),
    minDomain,
    maxDomain,
    innerWidth,
    innerHeight,
    rangeStart: toPlainDateString(parsedRangeStart) || null,
    rangeEnd: toPlainDateString(parsedRangeEnd) || null,
  };
}

export default function ProjectionDialog({
  onClose,
  accountKey,
  accountLabel,
  todayTotalEquity,
  todayDate,
  cagrStartDate,
  onEstimateFutureCagr,
  childAccounts,
  onSelectAccount,
  parentAccountId,
  initialGrowthPercent,
  isGroupView,
  groupProjectionAccounts,
}) {
  const toNumberOrNaN = (val) => {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = Number(val.trim());
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };
  const headingId = useId();
  const selectRef = useRef(null);
  const [timeframeYears, setTimeframeYears] = useState(10);
  const [rateInput, setRateInput] = useState(() => {
    const v = toNumberOrNaN(initialGrowthPercent);
    return Number.isFinite(v) ? String(v) : '';
  });
  const [didEdit, setDidEdit] = useState(false);
  const [mode, setMode] = useState('today'); // 'today' | 'start'
  const [seriesState, setSeriesState] = useState({ status: 'idle', data: null, error: null });

  const normalizedRate = useMemo(() => {
    const trimmed = String(rateInput ?? '').replace(/[^0-9.\-]/g, '').trim();
    if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
      return null;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return null;
    return num / 100;
  }, [rateInput]);

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep the input synchronized if initial value changes (accept string or number)
  useEffect(() => {
    const v = toNumberOrNaN(initialGrowthPercent);
    if (Number.isFinite(v)) {
      setRateInput(String(v));
    }
  }, [initialGrowthPercent]);

  // Reset edit tracking when switching accounts
  useEffect(() => {
    setDidEdit(false);
  }, [accountKey]);

  useEffect(() => {
    function handleDocumentClick(event) {
      if (!selectRef.current) return;
      if (!selectRef.current.contains(event.target)) {
        selectRef.current.querySelector('.select-control__list')?.classList.remove('select-control__list--open');
      }
    }
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  }, []);

  // Persist growth percent value to server (debounced) only after user edits
  useEffect(() => {
    if (!accountKey) {
      return undefined;
    }
    if (!didEdit) {
      return undefined;
    }
    const trimmed = String(rateInput ?? '').replace(/[^0-9.\-]/g, '').trim();
    // Avoid clobbering with 0 when input is temporarily empty during editing
    if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
      return undefined;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setAccountMetadata(accountKey, { projectionGrowthPercent: num }).catch((err) => {
        console.warn('Failed to persist projectionGrowthPercent', err);
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [accountKey, rateInput, didEdit]);

  const startOverlayAvailable = Boolean(cagrStartDate) || true; // fallback to series start if needed

  const loadSeriesForStart = useCallback(async () => {
    if (!accountKey) return;
    setSeriesState((prev) => ({ ...prev, status: 'loading', error: null }));
    try {
      const payload = await getTotalPnlSeries(accountKey, {
        applyAccountCagrStartDate: Boolean(cagrStartDate),
      });
      setSeriesState({ status: 'success', data: payload, error: null });
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error('Failed to load Total P&L series');
      setSeriesState({ status: 'error', data: null, error: normalized });
    }
  }, [accountKey, cagrStartDate]);

  useEffect(() => {
    if (mode === 'start' && seriesState.status === 'idle') {
      loadSeriesForStart();
    }
  }, [mode, seriesState.status, loadSeriesForStart]);

  const overlayInfo = useMemo(() => {
    if (mode !== 'start') {
      return { startDate: null, startValue: null, actualSeries: [] };
    }
    if (seriesState.status !== 'success' || !seriesState.data) {
      return { startDate: null, startValue: null, actualSeries: [] };
    }
    const summary = seriesState.data?.summary || {};
    const startTotals = cagrStartDate ? summary.displayStartTotals : summary.seriesStartTotals;
    const baseStartDate = cagrStartDate ? seriesState.data?.displayStartDate || cagrStartDate : seriesState.data?.periodStartDate;
    const sd = parseDateOnly(baseStartDate);
    const startValue = Number.isFinite(startTotals?.equityCad) ? startTotals.equityCad : null;
    const rawPoints = Array.isArray(seriesState.data?.points) ? seriesState.data.points : [];
    const actualSeries = rawPoints
      .map((p) => ({ date: p.date, value: Number.isFinite(p.equityCad) ? p.equityCad : null }))
      .filter((e) => e.value !== null);
    return { startDate: sd, startValue, actualSeries };
  }, [mode, seriesState.status, seriesState.data, cagrStartDate]);

  const projectionStartDate = useMemo(() => {
    if (mode === 'start' && overlayInfo.startDate) return overlayInfo.startDate;
    const today = parseDateOnly(todayDate) || new Date();
    return today;
  }, [mode, overlayInfo.startDate, todayDate]);

  const projectionStartValue = useMemo(() => {
    if (mode === 'start' && Number.isFinite(overlayInfo.startValue)) return overlayInfo.startValue;
    return Number.isFinite(todayTotalEquity) ? todayTotalEquity : null;
  }, [mode, overlayInfo.startValue, todayTotalEquity]);

  const groupChildren = useMemo(() => {
    // Prefer a precomputed descendant account list from the parent if provided
    if (Array.isArray(groupProjectionAccounts) && groupProjectionAccounts.length) {
      return groupProjectionAccounts
        .map((e) => ({ equity: Number(e?.equity) || 0, rate: Number(e?.rate) || 0 }))
        .filter((e) => e.equity > 0);
    }
    if (!Array.isArray(childAccounts)) return [];
    return childAccounts
      .filter((c) => c && c.kind === 'account')
      .map((c) => ({
        equity: Number.isFinite(c.totalEquityCad) ? c.totalEquityCad : 0,
        rate: Number.isFinite(c.projectionGrowthPercent) ? c.projectionGrowthPercent / 100 : 0,
      }))
      .filter((e) => e.equity > 0);
  }, [childAccounts, groupProjectionAccounts]);

  const projectionSeries = useMemo(() => {
    if (!projectionStartDate || !Number.isFinite(projectionStartValue)) {
      return [];
    }
    if (isGroupView) {
      const totalMonths = Math.max(1, Math.round(timeframeYears * 12));
      const base = toDateOnly(projectionStartDate);
      const points = [];
      for (let i = 0; i <= totalMonths; i += 1) {
        const date = addMonths(base, i);
        let sum = 0;
        for (const child of groupChildren) {
          const monthlyRate = Math.pow(1 + child.rate, 1 / 12) - 1;
          sum += child.equity * Math.pow(1 + monthlyRate, i);
        }
        points.push({ date: toPlainDateString(date), value: sum });
      }
      return points;
    }
    if (!Number.isFinite(normalizedRate)) {
      return [];
    }
    return computeProjectionSeries({ startDate: projectionStartDate, startValue: projectionStartValue, annualRate: normalizedRate, years: timeframeYears });
  }, [projectionStartDate, projectionStartValue, normalizedRate, timeframeYears, isGroupView, groupChildren]);

  const chartRange = useMemo(() => {
    if (!projectionSeries.length) return { start: null, end: null };
    const start = parseDateOnly(projectionSeries[0]?.date);
    const end = addMonths(start, Math.round(timeframeYears * 12));
    return { start, end };
  }, [projectionSeries, timeframeYears]);

  const metrics = useMemo(() => {
    const actualWithinRange = overlayInfo.actualSeries.filter((e) => {
      const d = parseDateOnly(e.date);
      if (!d || !chartRange.start || !chartRange.end) return false;
      return d >= chartRange.start && d <= chartRange.end;
    });
    return buildChartMetrics(
      projectionSeries,
      mode === 'start' ? actualWithinRange : [],
      { rangeStartDate: chartRange.start, rangeEndDate: chartRange.end }
    );
  }, [overlayInfo.actualSeries, projectionSeries, chartRange.start, chartRange.end, mode]);

  const pathProjection = useMemo(() => {
    if (!metrics || !metrics.pointsA.length) return null;
    const pts = metrics.pointsA;
    if (pts.length === 1) {
      const p = pts[0];
      return `M${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    }
    return metrics.pointsA.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  }, [metrics]);

  const pathActual = useMemo(() => {
    if (!metrics || !metrics.pointsB.length) return null;
    const pts = metrics.pointsB;
    if (pts.length === 1) {
      const p = pts[0];
      return `M${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    }
    return metrics.pointsB.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  }, [metrics]);

  const milestones = useMemo(() => buildMilestones(timeframeYears), [timeframeYears]);

  const milestoneMarkers = useMemo(() => {
    if (!metrics || !metrics.pointsA.length) return [];
    const start = parseDateOnly(projectionSeries[0]?.date);
    return milestones.map((years) => {
      const d = addMonths(start, years * 12);
      const ds = toPlainDateString(d);
      // find nearest point in projection series
      let nearest = metrics.pointsA[metrics.pointsA.length - 1];
      for (let i = 0; i < metrics.pointsA.length; i += 1) {
        if (metrics.pointsA[i].date >= ds) {
          nearest = metrics.pointsA[i];
          break;
        }
      }
      const leftPercent = Math.min(100, Math.max(0, (nearest.x / CHART_WIDTH) * 100));
      const offset = 26;
      const minY = PADDING.top + 8;
      const maxY = CHART_HEIGHT - PADDING.bottom - 8;
      const anchorY = Math.min(maxY, Math.max(minY, nearest.y - offset));
      const topPercent = Math.max(0, Math.min(100, (anchorY / CHART_HEIGHT) * 100));
      return { x: nearest.x, y: nearest.y, leftPercent, topPercent, label: formatMoneyCompact(nearest.value), date: ds };
    });
  }, [metrics, milestones, projectionSeries]);

  const finalProjectedValue = useMemo(() => {
    if (!projectionSeries.length) return null;
    const last = projectionSeries[projectionSeries.length - 1];
    return Number.isFinite(last?.value) ? last.value : null;
  }, [projectionSeries]);

  const ratePercentLabel = useMemo(() => {
    if (isGroupView) {
      if (!Number.isFinite(projectionStartValue) || !Number.isFinite(finalProjectedValue) || !Number.isFinite(timeframeYears) || timeframeYears <= 0) {
        return '—';
      }
      const ratio = finalProjectedValue / projectionStartValue;
      if (!(ratio > 0)) return '—';
      const eff = Math.pow(ratio, 1 / timeframeYears) - 1;
      if (!Number.isFinite(eff)) return '—';
      return `${formatNumber(eff * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    }
    if (!Number.isFinite(normalizedRate)) return '—';
    return `${formatNumber(normalizedRate * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }, [isGroupView, normalizedRate, projectionStartValue, finalProjectedValue, timeframeYears]);

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
              <h2 id={headingId}>Projections</h2>
              {accountLabel && <span className="pnl-dialog__account">{accountLabel}</span>}
            </div>

            <div className="pnl-dialog__summary" aria-live="polite">
              <div className="pnl-dialog__summary-item">
                <span className="pnl-dialog__summary-label">Annual growth</span>
                <span className="pnl-dialog__summary-value">{ratePercentLabel}</span>
              </div>
              <div className="pnl-dialog__summary-item">
                <span className="pnl-dialog__summary-label">Current value</span>
                <span className="pnl-dialog__summary-value">
                  {Number.isFinite(todayTotalEquity) ? formatMoney(todayTotalEquity) : '—'}
                </span>
              </div>
              <div className="pnl-dialog__summary-item">
                <span className="pnl-dialog__summary-label">Final value</span>
                <span className="pnl-dialog__summary-value">
                  {Number.isFinite(finalProjectedValue) ? formatMoney(finalProjectedValue) : '—'}
                </span>
              </div>
            </div>

            <div className="pnl-dialog__controls" style={{ gap: '12px', alignItems: 'center' }}>
              <label className="pnl-dialog__control-label" htmlFor="projection-timeframe">Show</label>
              <div className="select-control" ref={selectRef}>
                <button
                  id="projection-timeframe"
                  type="button"
                  className="select-control__button"
                  onClick={(event) => {
                    const menu = event.currentTarget.nextSibling;
                    if (menu) menu.classList.toggle('select-control__list--open');
                  }}
                >
                  {PROJECTION_TIMEFRAME_OPTIONS.find((o) => o.value === timeframeYears)?.label || 'Select timeframe'}
                  <span aria-hidden="true" className="select-control__chevron" />
                </button>
                <ul className="select-control__list" role="listbox">
                  {PROJECTION_TIMEFRAME_OPTIONS.map((option) => (
                    <li key={option.value}>
                      <button
                        type="button"
                        className={option.value === timeframeYears ? 'select-control__option select-control__option--selected' : 'select-control__option'}
                        onClick={() => {
                          setTimeframeYears(option.value);
                          const container = document.getElementById('projection-timeframe')?.nextSibling;
                          if (container) container.classList.remove('select-control__list--open');
                        }}
                        role="option"
                        aria-selected={option.value === timeframeYears}
                      >
                        {option.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {!isGroupView && (
                <>
                  <label className="pnl-dialog__control-label" htmlFor="projection-rate">Growth</label>
                  <input
                    id="projection-rate"
                    type="text"
                    inputMode="decimal"
                    className="text-input"
                    value={rateInput}
                    onChange={(e) => {
                      setRateInput(e.target.value);
                      setDidEdit(true);
                    }}
                    placeholder="e.g. 8"
                    aria-describedby="projection-rate-suffix"
                    style={{ width: '64px' }}
                  />
                  <span id="projection-rate-suffix">%</span>

                  {typeof onEstimateFutureCagr === 'function' && (
                    <button
                      type="button"
                      className="projection-dialog__button"
                      onClick={onEstimateFutureCagr}
                      title="Copy a prompt to estimate CAGR using ChatGPT"
                    >
                      Estimate future CAGR
                    </button>
                  )}
                </>
              )}
            </div>

            {startOverlayAvailable && (
              <div className="pnl-dialog__range-toggle-row" style={{ marginTop: '6px' }}>
                <label className="pnl-dialog__range-toggle">
                  <input
                    type="checkbox"
                    checked={mode === 'start'}
                    onChange={(e) => setMode(e.target.checked ? 'start' : 'today')}
                  />
                  <span>{cagrStartDate ? `From ${formatDate(cagrStartDate).replace(',', '')}` : 'From start'}</span>
                </label>
                {mode === 'start' && seriesState.status === 'error' && (
                  <button type="button" className="qqq-section__retry" onClick={loadSeriesForStart}>
                    Retry
                  </button>
                )}
              </div>
            )}

            <div className="qqq-section__chart-container" aria-live="polite">
              <svg className="qqq-section__chart pnl-dialog__chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-hidden="true">
                <rect className="qqq-section__chart-surface" x="0" y="0" width={CHART_WIDTH} height={CHART_HEIGHT} rx="16" />
                {metrics && metrics.axisTicks.map((tick) => (
                  <g key={`tick-${tick.value}`}>
                    <line
                      className="qqq-section__line qqq-section__line--guide"
                      x1={CHART_WIDTH - PADDING.right}
                      x2={CHART_WIDTH - PADDING.right + 6}
                      y1={tick.y}
                      y2={tick.y}
                    />
                    <text x={CHART_WIDTH - PADDING.right + 8} y={tick.y + 3} className="pnl-dialog__axis-label" textAnchor="start">
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
                {pathActual && <path className="projection-dialog__actual-path" d={pathActual} />}
                {pathProjection && <path className="qqq-section__series-path" d={pathProjection} />}
                {milestoneMarkers.map((m) => (
                  <g key={`m-${m.date}`}>
                    <line
                      className="qqq-section__line qqq-section__line--guide"
                      x1={m.x}
                      x2={m.x}
                      y1={PADDING.top}
                      y2={CHART_HEIGHT - PADDING.bottom}
                      strokeDasharray="3 6"
                    />
                    <circle className="projection-dialog__milestone" cx={m.x} cy={m.y} r="5" />
                  </g>
                ))}
              </svg>
              {milestoneMarkers.map((m) => (
                <div
                  key={`label-${m.date}`}
                  className="qqq-section__chart-label"
                  style={{ position: 'absolute', left: `${m.leftPercent}%`, top: `${m.topPercent}%`, transform: 'translate(-50%, -100%)' }}
                >
                  <span className="pnl-dialog__label-amount">{m.label}</span>
                  <span className="pnl-dialog__label-date">{formatDate(m.date)}</span>
                </div>
              ))}
              <div className="qqq-section__chart-footer">
                <span>{formatDate(chartRange.start)}</span>
                <span>{formatDate(chartRange.end)}</span>
              </div>
            </div>

            {Array.isArray(childAccounts) && childAccounts.length > 0 && (
              <div className="projection-dialog__children">
                <h3 className="equity-card__children-title">Child accounts</h3>
                <ul className="equity-card__children-list">
                  {childAccounts.map((child) => (
                    <li key={child.id} className="equity-card__children-item">
                      <a
                        href={child.href || `?accountId=${encodeURIComponent(child.id)}`}
                        className="equity-card__children-link"
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1) return;
                          event.preventDefault();
                          if (typeof onSelectAccount === 'function') onSelectAccount(child.id);
                        }}
                      >
                        <span className="equity-card__children-name">{child.label}</span>
                        <div className="equity-card__children-meta">
                          <span className="equity-card__children-value">{formatMoney(child.totalEquityCad)}</span>
                          <span className="equity-card__children-pnl equity-card__children-pnl--positive">
                            <span className="equity-card__children-pnl-label">Projected CAGR:</span>
                            <span className="equity-card__children-pnl-value">
                              {Number.isFinite(child.projectionGrowthPercent)
                                ? `${formatNumber(child.projectionGrowthPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`
                                : '—'}
                            </span>
                          </span>
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {parentAccountId && (
              <div className="pnl-dialog__footer">
                <button type="button" className="pnl-dialog__link-button" onClick={() => onSelectAccount && onSelectAccount(parentAccountId)}>
                  Go to parent account
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

ProjectionDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
  accountKey: PropTypes.string,
  accountLabel: PropTypes.string,
  todayTotalEquity: PropTypes.number,
  todayDate: PropTypes.string,
  cagrStartDate: PropTypes.string,
  onEstimateFutureCagr: PropTypes.func,
  initialGrowthPercent: PropTypes.number,
  childAccounts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      totalEquityCad: PropTypes.number,
      href: PropTypes.string,
      kind: PropTypes.oneOf(['account', 'group']),
      projectionGrowthPercent: PropTypes.number,
    })
  ),
  onSelectAccount: PropTypes.func,
  parentAccountId: PropTypes.string,
  isGroupView: PropTypes.bool,
  groupProjectionAccounts: PropTypes.arrayOf(
    PropTypes.shape({ equity: PropTypes.number, rate: PropTypes.number })
  ),
};

ProjectionDialog.defaultProps = {
  accountKey: null,
  accountLabel: null,
  todayTotalEquity: null,
  todayDate: null,
  cagrStartDate: null,
  onEstimateFutureCagr: null,
  initialGrowthPercent: null,
  childAccounts: [],
  onSelectAccount: null,
  parentAccountId: null,
  isGroupView: false,
  groupProjectionAccounts: [],
};
