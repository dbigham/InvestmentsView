import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { getTotalPnlSeries, setAccountMetadata } from '../api/questrade';
import { formatDate, formatMoney, formatNumber } from '../utils/formatters';
import { buildRetirementModel as buildSharedRetirementModel, summarizeAtRetirementYear as summarizeAtRetirementYearShared } from '../../../shared/retirementModel.js';

const CHART_WIDTH = 680;
const CHART_HEIGHT = 260;
const PADDING = { top: 6, right: 48, bottom: 30, left: 0 };
const AXIS_TARGET_INTERVALS = 4;
const MS_PER_YEAR_APPROX = 365.2425 * 24 * 60 * 60 * 1000;
const DEFAULT_OWNER_BIRTHDATE = new Date(Date.UTC(1980, 10, 20));

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
const DEFAULT_RETIREMENT_INFLATION_PERCENT = 2.5; // default when not configured
const DEFAULT_MAX_CPP_65_ANNUAL = 17500; // fallback estimate; can override via metadata
const DEFAULT_FULL_OAS_65_ANNUAL = 8500;  // fallback estimate; can override via metadata
const DEFAULT_BORROWING_RATE_ANNUAL = 0.06; // 6% default when portfolio goes negative
const RETIREMENT_AGE_MIN = 40;
const RETIREMENT_AGE_MAX = 80;

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

function yearsBetween(from, to) {
  if (!(from instanceof Date) || !(to instanceof Date)) return null;
  return (to.getTime() - from.getTime()) / MS_PER_YEAR_APPROX;
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

// Compact number formatter without currency, lowercase suffixes (k/m/b)
function formatNumberCompactPlain(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) {
    const num = abs / 1e9;
    const digits = num >= 100 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    return `${sign}${formatNumber(num, digits)} b`;
  }
  if (abs >= 1e6) {
    const num = abs / 1e6;
    return `${sign}${formatNumber(num, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m`;
  }
  if (abs >= 1e3) {
    const num = abs / 1e3;
    return `${sign}${formatNumber(num, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} k`;
  }
  return `${sign}${formatNumber(abs, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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

function computeProjectionSeries({ startDate, startValue, annualRate, years, cashFlowResolver, borrowingAnnualRate = DEFAULT_BORROWING_RATE_ANNUAL }) {
  if (!Number.isFinite(startValue) || !Number.isFinite(annualRate) || !Number.isFinite(years)) {
    return [];
  }
  const totalMonths = Math.max(1, Math.round(years * 12));
  const monthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  const monthlyBorrowRate = Math.pow(1 + (Number(borrowingAnnualRate) || 0), 1 / 12) - 1;
  const points = [];
  const base = toDateOnly(startDate);
  let currentValue = startValue;
  for (let i = 0; i <= totalMonths; i += 1) {
    const date = addMonths(base, i);
    if (i > 0) {
      // Apply borrowing rate when value is negative; otherwise use investment rate
      if (currentValue < 0) {
        currentValue *= 1 + monthlyBorrowRate;
      } else {
        currentValue *= 1 + monthlyRate;
      }
      if (typeof cashFlowResolver === 'function') {
        const flow = cashFlowResolver({ date, monthIndex: i, value: currentValue });
        if (Number.isFinite(flow) && flow !== 0) {
          currentValue += flow;
        }
      }
    }
    points.push({ date: toPlainDateString(date), value: currentValue });
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
  retirementSettings,
  projectionTree,
  onPersistGrowthPercent,
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
  const chartContainerRef = useRef(null);
  const [timeframeYears, setTimeframeYears] = useState(50);
  const [rateInput, setRateInput] = useState(() => {
    const v = toNumberOrNaN(initialGrowthPercent);
    return Number.isFinite(v) ? String(v) : '';
  });
  const [didEdit, setDidEdit] = useState(false);
  const [mode, setMode] = useState('today'); // 'today' | 'start'
  const [seriesState, setSeriesState] = useState({ status: 'idle', data: null, error: null });
  const [hoverPoint, setHoverPoint] = useState(null);
  const [includeRetirementFlows, setIncludeRetirementFlows] = useState(
    Boolean(retirementSettings?.mainRetirementAccount)
  );
  // Normalize displayed values to current-year dollars (using configured inflation)
  const [normalizeToBaseYear, setNormalizeToBaseYear] = useState(false);
  const [retirementAgeChoice, setRetirementAgeChoice] = useState(() => {
    const raw = Number(retirementSettings?.retirementAge);
    if (Number.isFinite(raw) && raw > 0) return Math.round(raw);
    const year = Number(retirementSettings?.retirementYear);
    const bd = parseDateOnly(retirementSettings?.retirementBirthDate1) || parseDateOnly(retirementSettings?.retirementBirthDate);
    if (bd && Number.isFinite(year)) {
      return Math.max(0, Math.round(year - bd.getUTCFullYear()));
    }
    return null;
  });

  // Selection on the projection path: index into projectionSeries
  const [selectedPoint, setSelectedPoint] = useState(null); // { date, index }

  // Local per-account overrides and inclusion toggles (for group view tree)
  const [ratesById, setRatesById] = useState(() => new Map()); // accountId -> percent number
  const [changedRateIds, setChangedRateIds] = useState(() => new Set());
  const [includedById, setIncludedById] = useState(() => new Map()); // accountId -> boolean
  const [savingRates, setSavingRates] = useState(false);

  const normalizedRate = useMemo(() => {
    const trimmed = String(rateInput ?? '').replace(/[^0-9.-]/g, '').trim();
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
    setIncludeRetirementFlows(Boolean(retirementSettings?.mainRetirementAccount));
  }, [retirementSettings?.mainRetirementAccount]);

  const ownerBirthDate = useMemo(
    () =>
      parseDateOnly(retirementSettings?.retirementBirthDate1) ||
      parseDateOnly(retirementSettings?.retirementBirthDate) ||
      DEFAULT_OWNER_BIRTHDATE,
    [retirementSettings?.retirementBirthDate1, retirementSettings?.retirementBirthDate]
  );

  const effectiveRetirementAgeMin = useMemo(() => {
    const today = parseDateOnly(todayDate) || new Date();
    const ageYears = yearsBetween(ownerBirthDate, today);
    if (Number.isFinite(ageYears) && ageYears >= 0) {
      const nextBirthdayAge = Math.floor(ageYears) + 1;
      const boundedMin = Math.max(RETIREMENT_AGE_MIN, nextBirthdayAge);
      return Math.min(boundedMin, RETIREMENT_AGE_MAX);
    }
    return RETIREMENT_AGE_MIN;
  }, [ownerBirthDate, todayDate]);

  // Reset local retirement age choice when the underlying setting changes (e.g., switching accounts)
  useEffect(() => {
    const clampAge = (value) => {
      if (!Number.isFinite(value)) {
        return null;
      }
      const rounded = Math.round(value);
      if (!Number.isFinite(rounded)) {
        return null;
      }
      const minAllowed = Number.isFinite(effectiveRetirementAgeMin)
        ? effectiveRetirementAgeMin
        : RETIREMENT_AGE_MIN;
      return Math.min(RETIREMENT_AGE_MAX, Math.max(minAllowed, rounded));
    };

    const raw = Number(retirementSettings?.retirementAge);
    if (Number.isFinite(raw) && raw > 0) {
      const clamped = clampAge(raw);
      setRetirementAgeChoice(clamped);
      return;
    }
    const year = Number(retirementSettings?.retirementYear);
    const bd =
      parseDateOnly(retirementSettings?.retirementBirthDate1) ||
      parseDateOnly(retirementSettings?.retirementBirthDate);
    if (bd && Number.isFinite(year)) {
      const clamped = clampAge(Math.max(0, Math.round(year - bd.getUTCFullYear())));
      setRetirementAgeChoice(clamped);
    } else {
      setRetirementAgeChoice(null);
    }
  }, [
    retirementSettings?.retirementAge,
    retirementSettings?.retirementYear,
    retirementSettings?.retirementBirthDate1,
    retirementSettings?.retirementBirthDate,
    effectiveRetirementAgeMin,
  ]);

  useEffect(() => {
    function handleDocumentClick(event) {
      // Close timeframe dropdown if click occurs outside it
      if (selectRef.current && !selectRef.current.contains(event.target)) {
        selectRef.current
          .querySelector('.select-control__list')
          ?.classList.remove('select-control__list--open');
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
    const trimmed = String(rateInput ?? '').replace(/[^0-9.-]/g, '').trim();
    // Avoid clobbering with 0 when input is temporarily empty during editing
    if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
      return undefined;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setAccountMetadata(accountKey, { projectionGrowthPercent: num }).then(
        () => {
          if (typeof onPersistGrowthPercent === 'function') {
            onPersistGrowthPercent(accountKey, num);
          }
        },
        (err) => {
          console.warn('Failed to persist projectionGrowthPercent', err);
        }
      );
    }, 600);
    return () => clearTimeout(timer);
  }, [accountKey, rateInput, didEdit, onPersistGrowthPercent]);

  const configuredInflationRate = useMemo(() => {
    // Treat missing/null inflation percent as "not configured" and fall back to default.
    // Only use 0% inflation when explicitly configured as 0.
    const raw = retirementSettings?.retirementInflationPercent;
    if (raw === null || raw === undefined) {
      return DEFAULT_RETIREMENT_INFLATION_PERCENT / 100;
    }
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 0) {
      return num / 100;
    }
    return DEFAULT_RETIREMENT_INFLATION_PERCENT / 100;
  }, [retirementSettings?.retirementInflationPercent]);

  // Normalization base (Jan 1 of the current year, based on todayDate when provided)
  const normalizeBaseDate = useMemo(() => {
    const t = parseDateOnly(todayDate) || new Date();
    // Use today's date (UTC midnight) as the normalization benchmark instead of Jan 1
    return toDateOnly(t);
  }, [todayDate]);
  const normalizeBaseYearLabel = useMemo(() => String(normalizeBaseDate.getUTCFullYear()), [normalizeBaseDate]);

  const retirementModel = useMemo(() => {
    const supported = Boolean(retirementSettings?.mainRetirementAccount);
    if (!supported) {
      return {
        supported: false,
        enabled: false,
        startDate: null,
        incomeMonthly: 0,
        livingExpensesAnnual: 0,
        inflationRate: configuredInflationRate,
        persons: [],
        cppAnnualAtStart: 0,
        oasAnnualAtStart: 0,
      };
    }
    const overrideAge = Number.isFinite(retirementAgeChoice) && retirementAgeChoice > 0 ? Math.round(retirementAgeChoice) : undefined;
    const model = buildSharedRetirementModel(retirementSettings, { todayDate, overrideRetirementAge: overrideAge });
    return {
      supported: true,
      enabled: Boolean(includeRetirementFlows && model?.startDate),
      startDate: model?.startDate || null,
      incomeMonthly: Number(model?.incomeMonthly) || 0,
      livingExpensesAnnual: Number(model?.livingExpensesAnnual) || 0,
      inflationRate: Number(model?.inflationRate) || configuredInflationRate,
      persons: Array.isArray(model?.persons) ? model.persons : [],
      cppAnnualAtStart: Number(model?.cppAnnualAtStart) || 0,
      oasAnnualAtStart: Number(model?.oasAnnualAtStart) || 0,
    };
  }, [retirementSettings, includeRetirementFlows, todayDate, retirementAgeChoice, configuredInflationRate]);

  const showRetirementFlowColumns = Boolean(retirementModel?.enabled);

  // Inflation rate to use for normalization (prefer retirement model's if available)
  const normalizationInflationRate = useMemo(() => {
    const r = Number(retirementModel?.inflationRate);
    return Number.isFinite(r) ? r : configuredInflationRate;
  }, [retirementModel?.inflationRate, configuredInflationRate]);

  // Helper to normalize a monetary value at a specific date to the base-year dollars
  const normalizeValueForDate = useCallback(
    (dateLike, value) => {
      const v = Number(value);
      if (!normalizeToBaseYear || !Number.isFinite(v)) return v;
      const d = parseDateOnly(dateLike);
      if (!d) return v;
      const yrs = yearsBetween(normalizeBaseDate, d);
      const factor = Number.isFinite(yrs) && yrs !== 0 ? Math.pow(1 + normalizationInflationRate, yrs) : 1;
      return v / (factor || 1);
    },
    [normalizeToBaseYear, normalizeBaseDate, normalizationInflationRate]
  );

  // Summarize CPP, OAS, and other retirement income for the retirement start year
  const retirementStartYearIncome = useMemo(() => {
    if (!retirementSettings?.mainRetirementAccount) return null;
    const chosenAge = Number.isFinite(retirementAgeChoice) && retirementAgeChoice > 0 ? Math.round(retirementAgeChoice) : undefined;
    const model = buildSharedRetirementModel(retirementSettings, { todayDate, overrideRetirementAge: chosenAge });
    const summary = summarizeAtRetirementYearShared(model);
    return summary;
  }, [retirementSettings, retirementAgeChoice, todayDate]);

  const computeRetirementFlow = useCallback(
    (date) => {
      if (!retirementModel.enabled || !retirementModel.startDate) {
        return 0;
      }
      const comparisonDate = toDateOnly(date);
      if (!comparisonDate || comparisonDate < retirementModel.startDate) {
        return 0;
      }
      const elapsedYears = yearsBetween(retirementModel.startDate, comparisonDate);
      const expenseMultiplier =
        Number.isFinite(elapsedYears) && elapsedYears > 0
          ? Math.pow(1 + retirementModel.inflationRate, elapsedYears)
          : 1;
      const monthlyExpenses = (retirementModel.livingExpensesAnnual * expenseMultiplier) / 12;
      let pensionMonthly = 0;
      if (Array.isArray(retirementModel.persons)) {
        retirementModel.persons.forEach((p) => {
          if (!p) return;
          const cppStart = p.cppStartDate || p.startCppDate || null;
          if (cppStart && comparisonDate >= cppStart) {
            const yrs = yearsBetween(cppStart, comparisonDate);
            const factor = Number.isFinite(yrs) && yrs > 0 ? Math.pow(1 + retirementModel.inflationRate, yrs) : 1;
            pensionMonthly += (p.cppAnnualAtStart * factor) / 12;
          }
          const oasStart = p.oasStartDate || p.startOasDate || null;
          if (oasStart && comparisonDate >= oasStart) {
            const yrs = yearsBetween(oasStart, comparisonDate);
            const factor = Number.isFinite(yrs) && yrs > 0 ? Math.pow(1 + retirementModel.inflationRate, yrs) : 1;
            pensionMonthly += (p.oasAnnualAtStart * factor) / 12;
          }
        });
      }
      return retirementModel.incomeMonthly + pensionMonthly - monthlyExpenses;
    },
    [retirementModel]
  );

  // Temporarily hide the overlay compare-from-start toggle
  const startOverlayAvailable = false;

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
      const childStates = (function buildChildStates() {
        if (projectionTree && typeof projectionTree === 'object') {
          // Flatten included leaves from the projection tree, applying overrides
          const leaves = [];
          const walk = (node) => {
            if (!node) return;
            if (node.kind === 'account') {
              const accId = node.id;
              const included = includedById.get(accId);
              if (included !== false) {
                const ratePercent = ratesById.has(accId)
                  ? ratesById.get(accId)
                  : (Number.isFinite(node.ratePercent) ? node.ratePercent : null);
                const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
                leaves.push({ equity: Number(node.equity) || 0, rate });
              }
              return;
            }
            if (Array.isArray(node.children)) node.children.forEach(walk);
          };
          walk(projectionTree);
          const filtered = leaves.filter((l) => (Number.isFinite(l.equity) ? l.equity : 0) > 0);
          if (filtered.length) {
            return filtered.map((leaf) => ({
              monthlyRate: Math.pow(1 + (Number(leaf.rate) || 0), 1 / 12) - 1,
              value: Number(leaf.equity) || 0,
            }));
          }
        }
        if (groupChildren.length) {
          return groupChildren.map((child) => {
            const annual = Number(child?.rate) || 0;
            const monthlyRate = Math.pow(1 + annual, 1 / 12) - 1;
            return {
              monthlyRate,
              value: Number(child?.equity) || 0,
            };
          });
        }
        const fallbackRate = Number.isFinite(normalizedRate) ? normalizedRate : 0;
        return [
          {
            monthlyRate: Math.pow(1 + fallbackRate, 1 / 12) - 1,
            value: projectionStartValue,
          },
        ];
      })();
      const monthlyBorrowRate = Math.pow(1 + DEFAULT_BORROWING_RATE_ANNUAL, 1 / 12) - 1;
      for (let i = 0; i <= totalMonths; i += 1) {
        const date = addMonths(base, i);
        if (i > 0) {
          childStates.forEach((state) => {
            // If a child state ever goes negative (due to withdrawals), accrue borrowing interest
            const rate = state.value < 0 ? monthlyBorrowRate : state.monthlyRate;
            state.value *= 1 + rate;
          });
          if (retirementModel.enabled) {
            const flow = computeRetirementFlow(date);
            if (Number.isFinite(flow) && flow !== 0) {
              let aggregate = childStates.reduce((sum, state) => sum + state.value, 0);
              if (aggregate <= 0) {
                childStates[0].value += flow;
              } else {
                childStates.forEach((state) => {
                  const share = state.value / aggregate;
                  state.value += share * flow;
                });
              }
            }
          }
        }
        const totalValue = childStates.reduce((sum, state) => sum + state.value, 0);
        points.push({ date: toPlainDateString(date), value: totalValue });
      }
      return points;
    }
    if (!Number.isFinite(normalizedRate)) {
      return [];
    }
    const cashFlowResolver =
      retirementModel.enabled && typeof computeRetirementFlow === 'function'
        ? ({ date }) => computeRetirementFlow(date)
        : null;
    return computeProjectionSeries({
      startDate: projectionStartDate,
      startValue: projectionStartValue,
      annualRate: normalizedRate,
      years: timeframeYears,
      cashFlowResolver,
    });
  }, [
    projectionStartDate,
    projectionStartValue,
    normalizedRate,
    timeframeYears,
    isGroupView,
    groupChildren,
    retirementModel,
    computeRetirementFlow,
    // Recompute when inclusion or rates change
    includedById,
    ratesById,
  ]);

  // Series used for display/charting (optionally normalized to base-year dollars)
  const displayProjectionSeries = useMemo(() => {
    if (!Array.isArray(projectionSeries) || !projectionSeries.length) return [];
    if (!normalizeToBaseYear) return projectionSeries;
    return projectionSeries.map((p) => ({ date: p.date, value: normalizeValueForDate(p.date, p.value) }));
  }, [projectionSeries, normalizeToBaseYear, normalizeValueForDate]);

  const chartRange = useMemo(() => {
    if (!projectionSeries.length) return { start: null, end: null };
    const start = parseDateOnly(projectionSeries[0]?.date);
    const end = addMonths(start, Math.round(timeframeYears * 12));
    return { start, end };
  }, [projectionSeries, timeframeYears]);

  // Initialize tree state (ratesById and includedById) once tree becomes available
  useEffect(() => {
    if (!isGroupView || !projectionTree) return;
    const newRates = new Map();
    const newIncluded = new Map();
    const walk = (node) => {
      if (!node) return;
      if (node.kind === 'account') {
        if (Number.isFinite(node.ratePercent)) newRates.set(node.id, node.ratePercent);
        newIncluded.set(node.id, true);
        return;
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(projectionTree);
    setRatesById(newRates);
    setIncludedById(newIncluded);
    setChangedRateIds(new Set());
  }, [isGroupView, projectionTree]);

  // Selected point defaults to the final chart date when series is ready
  useEffect(() => {
    if (!projectionSeries.length) return;
    const last = projectionSeries[projectionSeries.length - 1];
    if (!last?.date) return;
    setSelectedPoint({ date: last.date, index: projectionSeries.length - 1 });
  }, [projectionSeries]);

  const metrics = useMemo(() => {
    const actualWithinRange = overlayInfo.actualSeries.filter((e) => {
      const d = parseDateOnly(e.date);
      if (!d || !chartRange.start || !chartRange.end) return false;
      return d >= chartRange.start && d <= chartRange.end;
    });
    const seriesB = mode === 'start' ? actualWithinRange : [];
    const displaySeriesB = normalizeToBaseYear
      ? seriesB.map((p) => ({ date: p.date, value: normalizeValueForDate(p.date, p.value) }))
      : seriesB;
    return buildChartMetrics(
      displayProjectionSeries,
      displaySeriesB,
      { rangeStartDate: chartRange.start, rangeEndDate: chartRange.end }
    );
  }, [overlayInfo.actualSeries, displayProjectionSeries, chartRange.start, chartRange.end, mode, normalizeToBaseYear, normalizeValueForDate]);

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

  // Compute retirement start marker position for the chart (visible even when flows disabled)
  const retirementStartMarker = useMemo(() => {
    if (!metrics || !retirementModel?.startDate || !chartRange.start || !chartRange.end) return null;
    const d = toDateOnly(retirementModel.startDate);
    if (!d) return null;
    const start = chartRange.start;
    const end = chartRange.end;
    if (!(d >= start && d <= end)) return null;
    const ratio = (d - start) / Math.max(1, end - start);
    const x = PADDING.left + (metrics.innerWidth || (CHART_WIDTH - PADDING.left - PADDING.right)) * ratio;
    return { x };
  }, [metrics, retirementModel?.startDate, chartRange.start, chartRange.end]);

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
      // Compute age at milestone date
      const ageYears = yearsBetween(ownerBirthDate, d);
      const ageLabel = Number.isFinite(ageYears) ? `${formatNumber(ageYears, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : '—';
      return { x: nearest.x, y: nearest.y, leftPercent, topPercent, label: formatMoneyCompact(nearest.value), date: ds, ageLabel };
    });
  }, [metrics, milestones, projectionSeries, ownerBirthDate]);

  const finalProjectedValue = useMemo(() => {
    if (!projectionSeries.length) return null;
    const last = projectionSeries[projectionSeries.length - 1];
    return Number.isFinite(last?.value) ? last.value : null;
  }, [projectionSeries]);

  const displayedFinalProjectedValue = useMemo(() => {
    if (!projectionSeries.length) return null;
    const last = projectionSeries[projectionSeries.length - 1];
    return Number.isFinite(last?.value) ? normalizeValueForDate(last.date, last.value) : null;
  }, [projectionSeries, normalizeValueForDate]);

  const displayedCurrentValue = useMemo(() => {
    if (isGroupView && projectionTree) {
      let sum = 0;
      const walk = (node) => {
        if (!node) return;
        if (node.kind === 'account') {
          if (includedById.get(node.id) === false) return;
          const eq = Number(node.equity) || 0;
          if (Number.isFinite(eq) && eq > 0) sum += eq;
          return;
        }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      walk(projectionTree);
      const baseToday = parseDateOnly(todayDate) || new Date();
      const normalized = Number.isFinite(sum) ? normalizeValueForDate(baseToday, sum) : null;
      return normalized;
    }
    const baseToday = parseDateOnly(todayDate) || new Date();
    const nominal = Number.isFinite(todayTotalEquity) ? todayTotalEquity : null;
    return Number.isFinite(nominal) ? normalizeValueForDate(baseToday, nominal) : null;
  }, [isGroupView, projectionTree, includedById, todayTotalEquity, todayDate, normalizeValueForDate]);

  const effectiveGroupRatePercentAtSelection = useMemo(() => {
    if (!isGroupView || !projectionTree || !selectedPoint || !projectionSeries.length) return null;
    const endEntry = projectionSeries[selectedPoint.index];
    const end = Number.isFinite(endEntry?.value) ? endEntry.value : null;
    if (!(end > 0)) return null;
    let startTotal = 0;
    const walk = (node) => {
      if (!node) return;
      if (node.kind === 'account') {
        if (includedById.get(node.id) === false) return;
        const eq = Number(node.equity) || 0;
        if (Number.isFinite(eq) && eq > 0) startTotal += eq;
        return;
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(projectionTree);
    if (!(startTotal > 0)) return null;
    const years = selectedPoint.index / 12;
    if (!(years > 0)) return null;
    const eff = Math.pow(end / startTotal, 1 / years) - 1;
    return Number.isFinite(eff) ? eff * 100 : null;
  }, [isGroupView, projectionTree, selectedPoint, projectionSeries, includedById]);

  const ratePercentLabel = useMemo(() => {
    if (isGroupView) {
      if (!Number.isFinite(effectiveGroupRatePercentAtSelection)) return '—';
      return `${formatNumber(effectiveGroupRatePercentAtSelection, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    }
    if (!Number.isFinite(normalizedRate)) return '—';
    return `${formatNumber(normalizedRate * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }, [isGroupView, normalizedRate, effectiveGroupRatePercentAtSelection]);

  // Flow breakdown for a specific month date using same retirement logic as chart
  const computeFlowBreakdown = useCallback(
    (date) => {
      if (!retirementModel.enabled || !retirementModel.startDate) {
        return { cpp: 0, oas: 0, other: 0, expenses: 0, net: 0 };
      }
      const comparisonDate = toDateOnly(date);
      if (!comparisonDate || comparisonDate < retirementModel.startDate) {
        return { cpp: 0, oas: 0, other: 0, expenses: 0, net: 0 };
      }
      const elapsedYears = yearsBetween(retirementModel.startDate, comparisonDate);
      const expenseMultiplier =
        Number.isFinite(elapsedYears) && elapsedYears > 0
          ? Math.pow(1 + retirementModel.inflationRate, elapsedYears)
          : 1;
      const expenses = (retirementModel.livingExpensesAnnual * expenseMultiplier) / 12;
      let cpp = 0;
      let oas = 0;
      if (Array.isArray(retirementModel.persons)) {
        retirementModel.persons.forEach((p) => {
          if (!p) return;
          const cppStart = p.cppStartDate || p.startCppDate || null;
          if (cppStart && comparisonDate >= cppStart) {
            const yrs = yearsBetween(cppStart, comparisonDate);
            const factor = Number.isFinite(yrs) && yrs > 0 ? Math.pow(1 + retirementModel.inflationRate, yrs) : 1;
            cpp += (p.cppAnnualAtStart * factor) / 12;
          }
          const oasStart = p.oasStartDate || p.startOasDate || null;
          if (oasStart && comparisonDate >= oasStart) {
            const yrs = yearsBetween(oasStart, comparisonDate);
            const factor = Number.isFinite(yrs) && yrs > 0 ? Math.pow(1 + retirementModel.inflationRate, yrs) : 1;
            oas += (p.oasAnnualAtStart * factor) / 12;
          }
        });
      }
      const other = retirementModel.incomeMonthly || 0;
      const net = other + cpp + oas - expenses;
      return { cpp, oas, other, expenses, net };
    },
    [retirementModel]
  );

  // Build yearly table rows from projection series
  const yearlyRows = useMemo(() => {
    if (!projectionSeries.length) return [];
    const start = parseDateOnly(projectionSeries[0]?.date);
    const end = addMonths(start, Math.round(timeframeYears * 12));
    const rows = [];
    const startYear = start.getUTCFullYear();
    const endYear = end.getUTCFullYear();
    for (let year = startYear; year <= endYear; year += 1) {
      const firstOfYear = new Date(Date.UTC(year, 0, 1));
      const lastOfYear = new Date(Date.UTC(year, 11, 31));
      let firstIdx = null;
      let lastIdx = null;
      for (let i = 0; i < projectionSeries.length; i += 1) {
        const d = parseDateOnly(projectionSeries[i].date);
        if (firstIdx === null && d >= firstOfYear) firstIdx = i;
        if (d <= lastOfYear) lastIdx = i;
      }
      if (firstIdx === null || lastIdx === null || firstIdx > lastIdx) continue;
      const startRaw = Number(projectionSeries[firstIdx]?.value) || 0;
      const endRaw = Number(projectionSeries[lastIdx]?.value) || startRaw;
      const startDateForYear = parseDateOnly(projectionSeries[firstIdx]?.date);
      const endDateForYear = parseDateOnly(projectionSeries[lastIdx]?.date);
      const startValue = normalizeValueForDate(startDateForYear, startRaw);
      const endValue = normalizeValueForDate(endDateForYear, endRaw);
      let cppTotal = 0;
      let oasTotal = 0;
      let otherTotal = 0;
      let expensesTotal = 0;
      for (let i = firstIdx; i <= lastIdx; i += 1) {
        if (i === 0) continue;
        const d = parseDateOnly(projectionSeries[i].date);
        const c = computeFlowBreakdown(d);
        const cppN = normalizeValueForDate(d, c.cpp);
        const oasN = normalizeValueForDate(d, c.oas);
        const otherN = normalizeValueForDate(d, c.other);
        const expN = normalizeValueForDate(d, c.expenses);
        cppTotal += cppN;
        oasTotal += oasN;
        otherTotal += otherN;
        expensesTotal += expN;
      }
      const netFlow = otherTotal + cppTotal + oasTotal - expensesTotal;
      const change = endValue - startValue;
      rows.push({ year, startValue, cpp: cppTotal, oas: oasTotal, other: otherTotal, expenses: expensesTotal, netFlow, change, endValue });
    }
    return rows;
  }, [projectionSeries, timeframeYears, computeFlowBreakdown, normalizeValueForDate]);

  const copyDialogAsText = useCallback(() => {
    try {
      const lines = [];
      lines.push(`Projections${accountLabel ? ' — ' + accountLabel : ''}`);
      lines.push(`Annual growth avg: ${ratePercentLabel}`);
      const cur = Number.isFinite(displayedCurrentValue) ? formatMoney(displayedCurrentValue) : '—';
      const fin = Number.isFinite(displayedFinalProjectedValue) ? formatMoney(displayedFinalProjectedValue) : '—';
      lines.push(`Current value: ${cur}`);
      lines.push(`Final value: ${fin}`);
      // Intentionally omit the single-year-at-retirement summary line to avoid
      // confusion for late-in-year retirements which show only a partial year.
      if (yearlyRows.length) {
        lines.push('');
        const headerColumns = showRetirementFlowColumns
          ? ['Year', 'Start', 'CPP', 'OAS', 'Other', 'Expenses', 'Net flow', 'Change', 'End']
          : ['Year', 'Start', 'Change', 'End'];
        lines.push(headerColumns.join(' | '));
        yearlyRows.forEach((r) => {
          const commonColumns = [
            r.year,
            formatMoney(r.startValue, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
          ];
          const retirementColumns = showRetirementFlowColumns
            ? [
                formatMoney(r.cpp, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                formatMoney(r.oas, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                formatMoney(r.other, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                formatMoney(r.expenses, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
                formatMoney(r.netFlow, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
              ]
            : [];
          const trailingColumns = [
            formatMoney(r.change, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
            formatMoney(r.endValue, { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
          ];
          lines.push([...commonColumns, ...retirementColumns, ...trailingColumns].join(' | '));
        });
      }
      const text = lines.join('\n');
      const run = async () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      };
      run();
    } catch (err) {
      console.error('Failed to copy Projections dialog text', err);
    }
  }, [accountLabel, ratePercentLabel, displayedCurrentValue, displayedFinalProjectedValue, retirementStartYearIncome, yearlyRows, normalizeToBaseYear, normalizeBaseYearLabel, normalizeValueForDate, retirementModel, showRetirementFlowColumns]);

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
                <span className="pnl-dialog__summary-label">Annual growth avg</span>
                <span className="pnl-dialog__summary-value">{ratePercentLabel}</span>
              </div>
              <div className="pnl-dialog__summary-item">
                <span className="pnl-dialog__summary-label">Current value</span>
                <span className="pnl-dialog__summary-value">
                  {Number.isFinite(displayedCurrentValue) ? formatMoney(displayedCurrentValue) : '—'}
                </span>
              </div>
              <div className="pnl-dialog__summary-item">
                <span className="pnl-dialog__summary-label">Final value</span>
                <span className="pnl-dialog__summary-value">
                  {Number.isFinite(displayedFinalProjectedValue) ? formatMoney(displayedFinalProjectedValue) : '—'}
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

              {retirementModel.supported && (
                <>
                  <label className="pnl-dialog__control-label" htmlFor="projection-retirement-age">Retirement age</label>
                  <input
                    id="projection-retirement-age"
                    type="number"
                    className="pnl-dialog__number-input"
                    inputMode="numeric"
                    min={effectiveRetirementAgeMin}
                    max={RETIREMENT_AGE_MAX}
                    step={1}
                    value={Number.isFinite(retirementAgeChoice) ? retirementAgeChoice : ''}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === '' || raw === null) {
                        setRetirementAgeChoice(null);
                        return;
                      }
                      const n = Math.round(Number(raw));
                      if (!Number.isFinite(n)) {
                        setRetirementAgeChoice(null);
                        return;
                      }
                      const minAllowed = Number.isFinite(effectiveRetirementAgeMin)
                        ? effectiveRetirementAgeMin
                        : RETIREMENT_AGE_MIN;
                      const clamped = Math.min(RETIREMENT_AGE_MAX, Math.max(minAllowed, n));
                      setRetirementAgeChoice(clamped);
                    }}
                    placeholder="e.g. 65"
                    style={{ width: '77px' }}
                  />
                </>
              )}

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

            <div className="pnl-dialog__range-toggle-row" style={{ marginTop: '6px' }}>
              <label className="pnl-dialog__range-toggle">
                <input
                  type="checkbox"
                  checked={normalizeToBaseYear}
                  onChange={(e) => setNormalizeToBaseYear(e.target.checked)}
                />
                <span>{`Normalize to ${normalizeBaseYearLabel} dollars`}</span>
              </label>
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

            {retirementModel.supported && (
              <>
                <div className="pnl-dialog__range-toggle-row" style={{ marginTop: '2px' }}>
                  <label className="pnl-dialog__range-toggle">
                    <input
                      type="checkbox"
                      checked={includeRetirementFlows}
                      onChange={(e) => setIncludeRetirementFlows(e.target.checked)}
                    />
                    <span>Include retirement income and expenses</span>
                  </label>
                </div>
                {false && retirementStartYearIncome && (
                  <div className="pnl-dialog__range-toggle-row" style={{ marginTop: '6px' }}>
                    <div
                      style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}
                      title={(function () {
                        try {
                          const m = buildSharedRetirementModel(retirementSettings, { todayDate, overrideRetirementAge: Number.isFinite(retirementAgeChoice) ? retirementAgeChoice : undefined });
                          const start = m.startDate ? m.startDate.toISOString().slice(0, 10) : 'n/a';
                          const today = m.todayRef ? m.todayRef.toISOString().slice(0, 10) : 'n/a';
                          const yrs = Number.isFinite(m.yrsUntil) ? m.yrsUntil.toFixed(3) : 'n/a';
                          const infl = Number.isFinite(m.inflationRate) ? (m.inflationRate*100).toFixed(2) + '%' : 'n/a';
                          const factor = m.factor?.toFixed?.(4) ?? 'n/a';
                          return `Inflation factor: ${factor}\nStart date: ${start}\nToday: ${today}\nYears until start: ${yrs}\nInflation: ${infl}`; 
                        } catch (e) { return ''; }
                      })()}
                    >
                      <strong>{`At retirement (${retirementStartYearIncome.year}, in ${normalizeToBaseYear ? normalizeBaseYearLabel : retirementStartYearIncome.year} dollars)`}</strong>
                      {' '}— CPP {formatMoney(normalizeToBaseYear ? normalizeValueForDate(retirementModel?.startDate, retirementStartYearIncome.cpp) : retirementStartYearIncome.cpp, { minimumFractionDigits: 0, maximumFractionDigits: 0 })},
                      {' '}OAS {formatMoney(normalizeToBaseYear ? normalizeValueForDate(retirementModel?.startDate, retirementStartYearIncome.oas) : retirementStartYearIncome.oas, { minimumFractionDigits: 0, maximumFractionDigits: 0 })},
                      {' '}Other {formatMoney(normalizeToBaseYear ? normalizeValueForDate(retirementModel?.startDate, retirementStartYearIncome.other) : retirementStartYearIncome.other, { minimumFractionDigits: 0, maximumFractionDigits: 0 })},
                      {' '}Total {formatMoney(normalizeToBaseYear ? normalizeValueForDate(retirementModel?.startDate, retirementStartYearIncome.total) : retirementStartYearIncome.total, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </div>
                  </div>
                )}
                {/* CPP/OAS breakdown is shown in Account Details dialog, not here. */}
              </>
            )}

            <div
              className="qqq-section__chart-container"
              aria-live="polite"
              ref={chartContainerRef}
              onMouseMove={(event) => {
                if (!metrics || !metrics.pointsA.length || !chartRange.start) {
                  setHoverPoint(null);
                  return;
                }
                const rect = chartContainerRef.current?.getBoundingClientRect();
                if (!rect) return;
                const relX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
                const ratio = rect.width > 0 ? relX / rect.width : 0;
                const targetX = ratio * CHART_WIDTH;
                // Find nearest plotted point on the projection path
                let nearest = metrics.pointsA[0];
                let best = Math.abs(nearest.x - targetX);
                for (let i = 1; i < metrics.pointsA.length; i += 1) {
                  const dist = Math.abs(metrics.pointsA[i].x - targetX);
                  if (dist < best) {
                    best = dist;
                    nearest = metrics.pointsA[i];
                  }
                }
                const leftPercent = Math.min(100, Math.max(0, (nearest.x / CHART_WIDTH) * 100));
                const offset = 26;
                const minY = PADDING.top + 8;
                const maxY = CHART_HEIGHT - PADDING.bottom - 8;
                const anchorY = Math.min(maxY, Math.max(minY, nearest.y - offset));
                const topPercent = Math.max(0, Math.min(100, (anchorY / CHART_HEIGHT) * 100));
                const start = chartRange.start;
                const hoveredDate = parseDateOnly(nearest.date);
                const diffYears = yearsBetween(start, hoveredDate);
                const yearsLabel = Number.isFinite(diffYears)
                  ? `${formatNumber(diffYears, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} years`
                  : '—';
                const ageYears = yearsBetween(ownerBirthDate, hoveredDate);
                const ageLabel = Number.isFinite(ageYears)
                  ? `${formatNumber(ageYears, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
                  : '—';
                setHoverPoint({
                  x: nearest.x,
                  y: nearest.y,
                  leftPercent,
                  topPercent,
                  amount: formatMoneyCompact(nearest.value),
                  date: nearest.date,
                  yearsLabel,
                  ageLabel,
                });
              }}
              onClick={(event) => {
                if (!metrics || !metrics.pointsA.length) return;
                const rect = chartContainerRef.current?.getBoundingClientRect();
                if (!rect) return;
                const relX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
                const ratio = rect.width > 0 ? relX / rect.width : 0;
                const targetX = ratio * CHART_WIDTH;
                let nearest = metrics.pointsA[0];
                let best = Math.abs(nearest.x - targetX);
                let nearestIndex = 0;
                for (let i = 1; i < metrics.pointsA.length; i += 1) {
                  const dist = Math.abs(metrics.pointsA[i].x - targetX);
                  if (dist < best) {
                    best = dist;
                    nearest = metrics.pointsA[i];
                    nearestIndex = i;
                  }
                }
                setSelectedPoint({ date: nearest.date, index: nearestIndex });
              }}
              onMouseLeave={() => setHoverPoint(null)}
            >
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
                {retirementStartMarker && (
                  <line
                    className="projection-dialog__retirement-line"
                    x1={retirementStartMarker.x}
                    x2={retirementStartMarker.x}
                    y1={PADDING.top}
                    y2={CHART_HEIGHT - PADDING.bottom}
                  />
                )}
                {pathActual && <path className="projection-dialog__actual-path" d={pathActual} />}
                {pathProjection && <path className="qqq-section__series-path" d={pathProjection} />}
                {hoverPoint && (
                  <circle className="pnl-dialog__hover-marker" cx={hoverPoint.x} cy={hoverPoint.y} r="5" />
                )}
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
                    <circle
                      className="projection-dialog__milestone"
                      cx={m.x}
                      cy={m.y}
                      r="5"
                      onClick={(e) => {
                        e.stopPropagation();
                        // find nearest point index for the milestone date
                        let nearestIndex = metrics.pointsA.length - 1;
                        for (let i = 0; i < metrics.pointsA.length; i += 1) {
                          if (metrics.pointsA[i].date >= m.date) {
                            nearestIndex = i;
                            break;
                          }
                        }
                        setSelectedPoint({ date: metrics.pointsA[nearestIndex].date, index: nearestIndex });
                      }}
                      style={{ cursor: 'pointer' }}
                    />
                  </g>
                ))}
              </svg>
              {hoverPoint && (
                <div
                  className="qqq-section__chart-label"
                  style={{ position: 'absolute', left: `${hoverPoint.leftPercent}%`, top: `${hoverPoint.topPercent}%`, transform: 'translate(-50%, -100%)' }}
                >
                  <span className="pnl-dialog__label-amount">{hoverPoint.amount}</span>
                  <span className="pnl-dialog__label-delta">{hoverPoint.yearsLabel}</span>
                  <span className="pnl-dialog__label-date">{formatDate(hoverPoint.date)}</span>
                  <span className="pnl-dialog__label-delta">Age: {hoverPoint.ageLabel}</span>
                </div>
              )}
              {milestoneMarkers.map((m) => (
                <div
                  key={`label-${m.date}`}
                  className="qqq-section__chart-label"
                  style={{ position: 'absolute', left: `${m.leftPercent}%`, top: `${m.topPercent}%`, transform: 'translate(-50%, -100%)' }}
                >
                  <span className="pnl-dialog__label-amount">{m.label}</span>
                  <span className="pnl-dialog__label-date">{formatDate(m.date)}</span>
                  <span className="pnl-dialog__label-delta">Age: {m.ageLabel}</span>
                </div>
              ))}
              <div className="qqq-section__chart-footer">
                <span>{formatDate(chartRange.start)}</span>
                <span>{formatDate(chartRange.end)}</span>
              </div>
            </div>

            {isGroupView && projectionTree && selectedPoint && (
              <ProjectionBreakdown
                root={projectionTree}
                selectedIndex={selectedPoint.index}
                startDate={projectionSeries.length ? parseDateOnly(projectionSeries[0]?.date) : null}
                ratesById={ratesById}
                setRatesById={setRatesById}
                changedRateIds={changedRateIds}
                setChangedRateIds={setChangedRateIds}
                includedById={includedById}
                setIncludedById={setIncludedById}
                normalizeValueForDate={normalizeValueForDate}
                onSave={async () => {
                  if (!changedRateIds.size) return;
                  try {
                    setSavingRates(true);
                    for (const id of changedRateIds) {
                      const p = ratesById.get(id);
                      if (Number.isFinite(p)) {
                        // Persist as projectionGrowthPercent
                        await setAccountMetadata(id, { projectionGrowthPercent: p });
                        if (typeof onPersistGrowthPercent === 'function') {
                          onPersistGrowthPercent(id, p);
                        }
                      }
                    }
                    setChangedRateIds(new Set());
                  } finally {
                    setSavingRates(false);
                  }
                }}
                savingRates={savingRates}
              />
            )}

            {!isGroupView && Array.isArray(childAccounts) && childAccounts.length > 0 && (
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

            {yearlyRows.length > 0 && (
              <div className="projection-dialog__yearly" style={{ marginTop: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 className="equity-card__children-title" style={{ margin: 0 }}>Yearly breakdown</h3>
                  <button type="button" className="pnl-dialog__link-button" onClick={copyDialogAsText}>
                    Copy to clipboard
                  </button>
                </div>
                <div style={{ overflowX: 'auto', marginTop: '6px' }}>
                  <table className="projection-tree" role="grid" style={{ tableLayout: 'auto', width: '100%' }}>
                    <thead>
                      <tr>
                        <th className="projection-tree__th-name">Year</th>
                        <th className="projection-tree__th">Start</th>
                        {showRetirementFlowColumns && (
                          <>
                            <th className="projection-tree__th">CPP</th>
                            <th className="projection-tree__th">OAS</th>
                            <th className="projection-tree__th">Other</th>
                            <th className="projection-tree__th">Expenses</th>
                            <th className="projection-tree__th">Net flow</th>
                          </>
                        )}
                        <th className="projection-tree__th">Change</th>
                        <th className="projection-tree__th">End</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyRows.map((r) => (
                        <tr key={`yr-${r.year}`}>
                          <td className="projection-tree__cell-name">{r.year}</td>
                          <td className="projection-tree__cell-value">{formatMoney(r.startValue, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                          {showRetirementFlowColumns && (
                            <>
                              <td className="projection-tree__cell-value">{formatMoney(r.cpp, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                              <td className="projection-tree__cell-value">{formatMoney(r.oas, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                              <td className="projection-tree__cell-value">{formatMoney(r.other, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                              <td className="projection-tree__cell-value">{formatMoney(r.expenses, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                              <td className="projection-tree__cell-value">{formatMoney(r.netFlow, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                            </>
                          )}
                          <td className="projection-tree__cell-value">{formatMoney(r.change, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                          <td className="projection-tree__cell-value">{formatMoney(r.endValue, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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

// Projection breakdown tree view component
function ProjectionBreakdown({
  root,
  selectedIndex,
  startDate,
  ratesById,
  setRatesById,
  changedRateIds,
  setChangedRateIds,
  includedById,
  setIncludedById,
  normalizeValueForDate,
  onSave,
  savingRates,
}) {
  // Temporary text state for rate inputs to allow typing decimals like "4." before committing
  const [rateInputsById, setRateInputsById] = useState(new Map());
  // Track which rate input should retain focus between renders
  const [focusedRateId, setFocusedRateId] = useState(null);
  useEffect(() => {
    if (!focusedRateId) return;
    const el = document.querySelector(`[data-rate-input-id="${focusedRateId}"]`);
    if (el && document.activeElement !== el && typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }
  });
  // Flatten leaves
  const leaves = useMemo(() => {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (node.kind === 'account') {
        out.push(node);
        return;
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(root);
    return out;
  }, [root]);

  const maxDepth = useMemo(() => {
    let max = 0;
    const walk = (node, depth) => {
      if (!node) return;
      if (depth > max) max = depth;
      if (Array.isArray(node.children)) node.children.forEach((c) => walk(c, depth + 1));
    };
    walk(root, 0);
    return max;
  }, [root]);

  // Simulate to selected index for included leaves
  const leafValues = useMemo(() => {
    if (!startDate || !Number.isFinite(selectedIndex)) return new Map();
    const states = [];
    leaves.forEach((leaf) => {
      const included = includedById.get(leaf.id);
      if (included === false) return;
      const eq = Number(leaf.equity) || 0;
      if (!(eq > 0)) return;
      const ratePercent = ratesById.has(leaf.id) ? ratesById.get(leaf.id) : (Number.isFinite(leaf.ratePercent) ? leaf.ratePercent : 0);
      const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
      states.push({ id: leaf.id, value: eq, monthlyRate: Math.pow(1 + rate, 1 / 12) - 1 });
    });
    for (let i = 0; i <= selectedIndex; i += 1) {
      if (i > 0) {
        states.forEach((s) => { s.value *= 1 + s.monthlyRate; });
        // Do not distribute retirement flows into per-account values here to keep
        // sibling branches independent when toggling inclusion.
      }
    }
    const result = new Map();
    states.forEach((s) => result.set(s.id, s.value));
    return result;
  }, [leaves, selectedIndex, startDate, ratesById, includedById]);

  const computeGroupValueAtSelection = useCallback((node) => {
    let sum = 0;
    const walk = (n) => {
      if (!n) return;
      if (n.kind === 'account') {
        if (includedById.get(n.id) === false) return;
        const v = leafValues.get(n.id);
        if (Number.isFinite(v)) sum += v;
        return;
      }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(node);
    return sum;
  }, [leafValues, includedById]);

  const computeGroupStartValue = useCallback((node) => {
    let sum = 0;
    const walk = (n) => {
      if (!n) return;
      if (n.kind === 'account') {
        if (includedById.get(n.id) === false) return;
        const v = Number(n.equity) || 0;
        if (Number.isFinite(v)) sum += v;
        return;
      }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    };
    walk(node);
    return sum;
  }, [includedById]);

  const computeGroupAggregatedRate = useCallback((node) => {
    // Effective CAGR from start to selectedIndex based on included leaves
    if (!(selectedIndex > 0)) return null;
    let startTotal = 0;
    const walkStart = (n) => {
      if (!n) return;
      if (n.kind === 'account') {
        if (includedById.get(n.id) === false) return;
        const eq = Number(n.equity) || 0;
        if (Number.isFinite(eq) && eq > 0) startTotal += eq;
        return;
      }
      if (Array.isArray(n.children)) n.children.forEach(walkStart);
    };
    walkStart(node);
    if (!(startTotal > 0)) return null;
    const endTotal = computeGroupValueAtSelection(node);
    if (!(endTotal > 0)) return null;
    const years = selectedIndex / 12;
    const eff = Math.pow(endTotal / startTotal, 1 / years) - 1;
    return Number.isFinite(eff) ? eff * 100 : null;
  }, [includedById, selectedIndex, computeGroupValueAtSelection]);

  const setRate = (id, percent) => {
    setRatesById((prev) => {
      const next = new Map(prev);
      next.set(id, percent);
      return next;
    });
    setChangedRateIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const setIncludedRecursive = (node, included) => {
    const apply = (n) => {
      if (!n) return;
      if (n.kind === 'account') {
        setIncludedById((prev) => {
          const next = new Map(prev);
          next.set(n.id, included);
          return next;
        });
        return;
      }
      if (Array.isArray(n.children)) n.children.forEach(apply);
    };
    apply(node);
  };

  const TreeItem = ({ node, depth }) => {
    const isAccount = node.kind === 'account';
    const included = isAccount ? includedById.get(node.id) !== false : (function computeGroupIncluded(n) {
      // included if all leaf descendants are included; indeterminate if mixed
      let total = 0; let on = 0;
      const walk = (m) => {
        if (!m) return;
        if (m.kind === 'account') {
          total += 1;
          if (includedById.get(m.id) !== false) on += 1;
          return;
        }
        if (Array.isArray(m.children)) m.children.forEach(walk);
      };
      walk(n);
      if (total === 0) return true;
      return on === total;
    }(node));

    const indeterminate = !isAccount && (function computeIndeterminate(n) {
      let total = 0; let on = 0;
      const walk = (m) => {
        if (!m) return;
        if (m.kind === 'account') {
          total += 1;
          if (includedById.get(m.id) !== false) on += 1;
          return;
        }
        if (Array.isArray(m.children)) m.children.forEach(walk);
      };
      walk(n);
      return on > 0 && on < total;
    }(node));

    const valueAtRaw = isAccount ? leafValues.get(node.id) : computeGroupValueAtSelection(node);
    const startAtRaw = isAccount ? (Number(node.equity) || 0) : computeGroupStartValue(node);
    const selectedDate = startDate ? addMonths(startDate, Math.max(0, Math.round(selectedIndex))) : null;
    const valueAt = Number.isFinite(valueAtRaw) ? normalizeValueForDate(selectedDate, valueAtRaw) : valueAtRaw;
    const startAt = Number.isFinite(startAtRaw) ? normalizeValueForDate(startDate, startAtRaw) : startAtRaw;
    const ratePercent = isAccount
      ? (ratesById.has(node.id) ? ratesById.get(node.id) : (Number.isFinite(node.ratePercent) ? node.ratePercent : null))
      : computeGroupAggregatedRate(node);

    const inputId = `proj-rate-${node.id}-${depth}`;

    return (
      <tr className={isAccount && !included ? 'projection-tree__row--disabled' : ''}>
        <td className="projection-tree__cell-name">
          <div className="projection-tree__name-wrap" style={{ paddingLeft: `${depth * 20}px` }}>
            <input
              type="checkbox"
              className="projection-tree__checkbox"
              checked={included}
              ref={(el) => { if (el) el.indeterminate = Boolean(indeterminate); }}
              onChange={(e) => {
                const nextIncluded = e.target.checked;
                if (isAccount) {
                  setIncludedById((prev) => {
                    const next = new Map(prev);
                    next.set(node.id, nextIncluded);
                    return next;
                  });
                } else {
                  setIncludedRecursive(node, nextIncluded);
                }
              }}
            />
            <span className="projection-tree__name">{node.label}</span>
          </div>
        </td>
        <td className="projection-tree__cell-value">{formatNumberCompactPlain(startAt)}</td>
        <td className="projection-tree__cell-value">{formatNumberCompactPlain(valueAt)}</td>
        <td className="projection-tree__cell-rate">
          {isAccount ? (
            <label htmlFor={inputId} className="projection-tree__rate">
              <input
                id={inputId}
                type="text"
                className="text-input projection-tree__rate-input"
                inputMode="decimal"
                data-rate-input-id={node.id}
                onFocus={() => setFocusedRateId(node.id)}
                onBlur={(e) => {
                  const val = (rateInputsById.get(node.id) ?? e.target.value).replace(/[^0-9.-]/g, '');
                  const isNumber = /^-?\d*(?:\.\d+)?$/.test(val) && !/^[-.]?$/.test(val);
                  if (!val) {
                    setRatesById((prev) => {
                      const next = new Map(prev);
                      next.delete(node.id);
                      return next;
                    });
                    setChangedRateIds((prev) => new Set(prev).add(node.id));
                  } else if (isNumber) {
                    const num = Number(val);
                    if (Number.isFinite(num)) setRate(node.id, num);
                  }
                  // Clear the temp buffer so controlled value reflects committed number
                  setRateInputsById((prev) => {
                    const next = new Map(prev);
                    next.delete(node.id);
                    return next;
                  });
                  setFocusedRateId(null);
                }}
                onKeyDown={(event) => {
                  // Prevent global key handlers from stealing focus while typing
                  event.stopPropagation();
                }}
                value={rateInputsById.has(node.id)
                  ? rateInputsById.get(node.id)
                  : (Number.isFinite(ratesById.get(node.id)) ? String(ratesById.get(node.id)) : '')}
                onChange={(e) => {
                  const allowed = e.target.value.replace(/[^0-9.-]/g, '');
                  setRateInputsById((prev) => {
                    const next = new Map(prev);
                    next.set(node.id, allowed);
                    return next;
                  });
                  // If it's a clean number (no trailing '.' or isolated '-') commit immediately
                  const isCleanNumber = /^-?\d*(?:\.\d+)?$/.test(allowed) && !/^[-.]?$/.test(allowed) && !/\.$/.test(allowed);
                  if (isCleanNumber) {
                    const num = Number(allowed);
                    if (Number.isFinite(num)) setRate(node.id, num);
                  }
                }}
                placeholder="e.g. 8"
                disabled={!included}
              />
              <span className="projection-tree__rate-suffix">%</span>
            </label>
          ) : (
            <span className="projection-tree__group-rate-wrap">
              <span className="projection-tree__group-rate-value">
                {Number.isFinite(ratePercent)
                  ? formatNumber(ratePercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : '—'}
              </span>
              <span className="projection-tree__rate-suffix">%</span>
            </span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="projection-breakdown" style={{ '--proj-indent-col': `${maxDepth * 16}px` }}>
      <div className="projection-breakdown__header">
        <h3 className="equity-card__children-title">{`Projected breakdown (Until ${formatDate(toPlainDateString(addMonths(startDate, selectedIndex))).replace(',', '')})`}</h3>
      </div>
      <table className="projection-tree" role="grid">
        <colgroup>
          <col className="projection-tree__col-name" />
          <col className="projection-tree__col-start" />
          <col className="projection-tree__col-final" />
          <col className="projection-tree__col-rate" />
        </colgroup>
        <thead>
          <tr>
            <th className="projection-tree__th-name">Account</th>
            <th className="projection-tree__th">Start</th>
            <th className="projection-tree__th">Final</th>
            <th className="projection-tree__th">Growth</th>
          </tr>
        </thead>
        <tbody>
          {(function renderRows() {
            const rows = [];
            const walk = (n, d) => {
              rows.push({ n, d });
              if (n && n.kind !== 'account' && Array.isArray(n.children)) {
                n.children.forEach((c) => walk(c, d + 1));
              }
            };
            walk(root, 0);
            return rows.map(({ n, d }) => (
              <TreeItem key={`${n.kind}-${n.id}`} node={n} depth={d} />
            ));
          })()}
        </tbody>
      </table>
      <div className="projection-breakdown__actions">
        <button type="button" className="projection-dialog__button" onClick={onSave} disabled={savingRates || !changedRateIds.size}>
          {savingRates ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="projection-dialog__button"
          onClick={() => {
            // Reset overrides to initial
            const base = new Map();
            leaves.forEach((leaf) => {
              if (Number.isFinite(leaf.ratePercent)) base.set(leaf.id, leaf.ratePercent);
            });
            setRatesById(base);
            setChangedRateIds(new Set());
            // Enable all
            const incl = new Map();
            leaves.forEach((leaf) => incl.set(leaf.id, true));
            setIncludedById(incl);
          }}
          disabled={savingRates}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

ProjectionBreakdown.propTypes = {
  root: PropTypes.shape({
    kind: PropTypes.oneOf(['group', 'account']).isRequired,
    id: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    children: PropTypes.array,
  }).isRequired,
  selectedIndex: PropTypes.number.isRequired,
  startDate: PropTypes.instanceOf(Date),
  ratesById: PropTypes.instanceOf(Map).isRequired,
  setRatesById: PropTypes.func.isRequired,
  changedRateIds: PropTypes.instanceOf(Set).isRequired,
  setChangedRateIds: PropTypes.func.isRequired,
  includedById: PropTypes.instanceOf(Map).isRequired,
  setIncludedById: PropTypes.func.isRequired,
  normalizeValueForDate: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  savingRates: PropTypes.bool,
};

ProjectionBreakdown.defaultProps = {
  startDate: null,
  savingRates: false,
};

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
  retirementSettings: PropTypes.shape({
    mainRetirementAccount: PropTypes.bool,
    retirementAge: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementIncome: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementLivingExpenses: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementBirthDate: PropTypes.string,
    retirementInflationPercent: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementHouseholdType: PropTypes.string,
    retirementBirthDate1: PropTypes.string,
    retirementBirthDate2: PropTypes.string,
    retirementCppYearsContributed1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppAvgEarningsPctOfYMPE1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppStartAge1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasYearsResident1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasStartAge1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppYearsContributed2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppAvgEarningsPctOfYMPE2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppStartAge2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasYearsResident2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasStartAge2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppMaxAt65Annual: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasFullAt65Annual: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  }),
  projectionTree: PropTypes.shape({
    kind: PropTypes.oneOf(['group', 'account']).isRequired,
    id: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    children: PropTypes.array,
  }),
  onPersistGrowthPercent: PropTypes.func,
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
  retirementSettings: null,
  projectionTree: null,
  onPersistGrowthPercent: null,
};
