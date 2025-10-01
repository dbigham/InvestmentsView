import { logPerformanceDebug } from './performanceDebug';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

export const PERFORMANCE_PERIOD_OPTIONS = [
  { value: 'all', label: 'All', days: null },
  { value: '1d', label: 'Last Day', days: 1 },
  { value: '1w', label: 'Last Week', days: 7 },
  { value: '1m', label: 'Last Month', days: 30 },
  { value: '1y', label: 'Last Year', days: 365 },
];

function parseDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time);
  }
  const str = String(value).trim();
  if (!str) {
    return null;
  }
  const parsed = new Date(`${str}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toDateKey(date) {
  const parsed = parseDate(date);
  if (!parsed) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function findStartIndex(timeline, boundary) {
  const boundaryDate = parseDate(boundary);
  if (!boundaryDate) {
    return 0;
  }
  for (let i = 0; i < timeline.length; i += 1) {
    const entryDate = parseDate(timeline[i] && timeline[i].date);
    if (entryDate && entryDate >= boundaryDate) {
      return i;
    }
  }
  return 0;
}

export function getTimelineWindow(timeline, period) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return null;
  }
  const normalizedPeriod = period || 'all';
  const endIndex = timeline.length - 1;
  if (normalizedPeriod === 'all') {
    return { startIndex: 0, endIndex };
  }
  const definition = PERFORMANCE_PERIOD_OPTIONS.find((option) => option.value === normalizedPeriod);
  if (!definition || !definition.days) {
    return { startIndex: 0, endIndex };
  }
  const endDate = parseDate(timeline[endIndex].date);
  if (!endDate) {
    return { startIndex: 0, endIndex };
  }
  const boundary = new Date(endDate.getTime() - definition.days * MS_PER_DAY);
  const boundaryKey = toDateKey(boundary);
  const startIndex = findStartIndex(timeline, boundaryKey);
  return { startIndex, endIndex };
}

function sumFlows(timeline, startIndex, endIndex) {
  let total = 0;
  let positive = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    const flow = Number(timeline[i] && timeline[i].netFlows);
    if (!Number.isFinite(flow) || flow === 0) {
      continue;
    }
    total += flow;
    if (flow > 0) {
      positive += flow;
    }
  }
  return { total, positive };
}

function evaluateXirr(rate, cashFlows, referenceDate) {
  const base = 1 + rate;
  if (base <= 0) {
    return { npv: Number.POSITIVE_INFINITY, derivative: Number.POSITIVE_INFINITY };
  }
  let npv = 0;
  let derivative = 0;
  const origin = referenceDate.getTime();
  cashFlows.forEach(({ date, amount }) => {
    const days = (date.getTime() - origin) / MS_PER_DAY;
    const fraction = days / DAYS_PER_YEAR;
    const discount = base ** fraction;
    npv += amount / discount;
    derivative -= (fraction * amount) / (discount * base);
  });
  return { npv, derivative };
}

function computeXirr(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) {
    return null;
  }
  const positives = cashFlows.some((flow) => flow.amount > 0);
  const negatives = cashFlows.some((flow) => flow.amount < 0);
  if (!positives || !negatives) {
    return null;
  }
  const referenceDate = cashFlows[0].date;
  let rate = 0.1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const { npv, derivative } = evaluateXirr(rate, cashFlows, referenceDate);
    if (!Number.isFinite(npv) || !Number.isFinite(derivative)) {
      break;
    }
    if (Math.abs(npv) < 1e-7) {
      return rate;
    }
    if (Math.abs(derivative) < 1e-9) {
      break;
    }
    const nextRate = rate - npv / derivative;
    if (!Number.isFinite(nextRate)) {
      break;
    }
    if (nextRate <= -0.9999) {
      rate = (rate - 0.9999) / 2;
    } else {
      rate = nextRate;
    }
  }
  return null;
}

export function computePerformanceSummary(timeline, period) {
  const normalizedPeriod = period || 'all';
  if (!Array.isArray(timeline) || timeline.length === 0) {
    logPerformanceDebug('computePerformanceSummary skipped: empty timeline.', {
      period: normalizedPeriod,
    });
    return null;
  }
  const window = getTimelineWindow(timeline, normalizedPeriod);
  if (!window) {
    logPerformanceDebug('computePerformanceSummary could not resolve a window.', {
      period: normalizedPeriod,
    });
    return null;
  }
  const { startIndex, endIndex } = window;
  if (startIndex > endIndex) {
    logPerformanceDebug('computePerformanceSummary received an invalid index range.', {
      period: normalizedPeriod,
      startIndex,
      endIndex,
    });
    return null;
  }
  const startValue = startIndex > 0 ? Number(timeline[startIndex - 1].value) || 0 : 0;
  const endValue = Number(timeline[endIndex].value) || 0;
  const { total: netFlows, positive: positiveFlows } = sumFlows(timeline, startIndex, endIndex);
  const totalPnl = endValue - startValue - netFlows;
  const invested = startValue + positiveFlows;
  const percent =
    invested > 0
      ? (totalPnl / invested) * 100
      : startValue !== 0
      ? (totalPnl / Math.abs(startValue)) * 100
      : null;

  const startDate = parseDate(timeline[startIndex].date);
  const endDate = parseDate(timeline[endIndex].date);
  let cagr = null;
  if (startDate && endDate && endDate > startDate) {
    const cashFlows = [];
    cashFlows.push({ date: startDate, amount: -startValue });
    for (let i = startIndex; i <= endIndex; i += 1) {
      const flow = Number(timeline[i].netFlows);
      if (!Number.isFinite(flow) || flow === 0) {
        continue;
      }
      const flowDate = parseDate(timeline[i].date);
      if (!flowDate) {
        continue;
      }
      cashFlows.push({ date: flowDate, amount: -flow });
    }
    cashFlows.push({ date: endDate, amount: endValue });
    const rate = computeXirr(cashFlows);
    if (rate !== null) {
      cagr = rate * 100;
    }
  }

  const summary = {
    startIndex,
    endIndex,
    startValue,
    endValue,
    netFlows,
    totalPnl,
    percent,
    cagr,
    startDate: startDate ? toDateKey(startDate) : null,
    endDate: endDate ? toDateKey(endDate) : null,
  };

  logPerformanceDebug('computePerformanceSummary completed.', {
    period: normalizedPeriod,
    startIndex,
    endIndex,
    startValue,
    endValue,
    netFlows,
    totalPnl,
    percent,
    cagr,
  });

  return summary;
}

export function sliceTimeline(timeline, startIndex, endIndex) {
  if (!Array.isArray(timeline) || startIndex < 0 || endIndex < startIndex) {
    return [];
  }
  return timeline.slice(startIndex, endIndex + 1);
}

export function buildChartPoints(timelineSlice) {
  if (!Array.isArray(timelineSlice) || timelineSlice.length === 0) {
    return [];
  }
  return timelineSlice.map((entry) => ({
    date: entry.date,
    value: Number(entry.value) || 0,
  }));
}
