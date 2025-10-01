const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

export const PERFORMANCE_RANGES = [
  { value: 'all', label: 'All', days: null },
  { value: '1d', label: 'Last Day', days: 1 },
  { value: '1w', label: 'Last Week', days: 7 },
  { value: '1m', label: 'Last Month', days: 30 },
  { value: '1y', label: 'Last Year', days: 365 },
];

function parseDateKey(key) {
  if (!key) {
    return null;
  }
  const normalized = `${key}T00:00:00Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function clampStartDate(timeline, desired) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return desired;
  }
  const first = timeline[0];
  const firstDate = parseDateKey(first.date);
  if (!firstDate) {
    return desired;
  }
  if (!desired || desired < firstDate) {
    return firstDate;
  }
  return desired;
}

function findStartEntry(timeline, startDate) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return null;
  }
  if (!startDate) {
    return timeline[0];
  }
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    const entryDate = parseDateKey(entry.date);
    if (!entryDate) {
      continue;
    }
    if (entryDate >= startDate) {
      return entry;
    }
  }
  return timeline[0];
}

function filterTimeline(timeline, startDate) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return [];
  }
  if (!startDate) {
    return timeline.slice();
  }
  return timeline.filter((entry) => {
    const entryDate = parseDateKey(entry.date);
    if (!entryDate) {
      return false;
    }
    return entryDate >= startDate;
  });
}

function summarizeCashFlows(cashFlows, startDate, endDate) {
  if (!Array.isArray(cashFlows) || cashFlows.length === 0) {
    return {
      contributions: 0,
      withdrawals: 0,
      flows: [],
    };
  }
  const startTime = startDate ? startDate.getTime() : Number.NEGATIVE_INFINITY;
  const endTime = endDate ? endDate.getTime() + MS_PER_DAY - 1 : Number.POSITIVE_INFINITY;
  let contributions = 0;
  let withdrawals = 0;
  const flows = [];

  cashFlows.forEach((flow) => {
    if (!flow || flow.amount === undefined || flow.amount === null || !flow.timestamp) {
      return;
    }
    const amount = Number(flow.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return;
    }
    const type = flow.type ? String(flow.type).toLowerCase() : null;
    if (type === 'execution') {
      return;
    }
    const timestamp = parseTimestamp(flow.timestamp);
    if (!timestamp) {
      return;
    }
    const timeValue = timestamp.getTime();
    if (timeValue < startTime || timeValue > endTime) {
      return;
    }
    if (amount > 0) {
      withdrawals += amount;
    } else {
      contributions += -amount;
    }
    flows.push({ date: timestamp, amount });
  });

  return { contributions, withdrawals, flows };
}

function xnpv(rate, flows) {
  const firstDate = flows[0].date;
  return flows.reduce((sum, flow) => {
    const years = (flow.date.getTime() - firstDate.getTime()) / MS_PER_YEAR;
    return sum + flow.amount / (1 + rate) ** years;
  }, 0);
}

function computeXirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) {
    return null;
  }
  const hasPositive = flows.some((flow) => flow.amount > 0);
  const hasNegative = flows.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) {
    return null;
  }

  const sorted = flows
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((flow) => ({
      date: flow.date,
      amount: flow.amount,
    }));

  let rate = 0.1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const value = xnpv(rate, sorted);
    const derivative = sorted.reduce((sum, flow) => {
      const years = (flow.date.getTime() - sorted[0].date.getTime()) / MS_PER_YEAR;
      const denominator = (1 + rate) ** (years + 1);
      return sum - years * flow.amount / denominator;
    }, 0);

    if (Math.abs(derivative) < 1e-10) {
      break;
    }

    const nextRate = rate - value / derivative;
    if (!Number.isFinite(nextRate) || nextRate <= -0.999999) {
      break;
    }

    if (Math.abs(nextRate - rate) < 1e-7) {
      rate = nextRate;
      break;
    }

    rate = nextRate;
  }

  if (!Number.isFinite(rate) || rate <= -0.999999) {
    return null;
  }

  const residual = xnpv(rate, sorted);
  if (Number.isFinite(residual) && Math.abs(residual) < 1e-4) {
    return rate;
  }
  return null;
}

export function resolveRangeDefinition(value) {
  return PERFORMANCE_RANGES.find((range) => range.value === value) || PERFORMANCE_RANGES[0];
}

export function buildRangeSummary(performance, rangeValue) {
  const range = resolveRangeDefinition(rangeValue);
  const timeline = Array.isArray(performance?.timeline) ? performance.timeline : [];
  if (!timeline.length) {
    return {
      range,
      timeline: [],
      startDate: null,
      endDate: null,
      startValue: 0,
      endValue: 0,
      contributions: 0,
      withdrawals: 0,
      totalPnl: 0,
      totalReturn: null,
      cagr: null,
    };
  }

  const endEntry = timeline[timeline.length - 1];
  const endDate = parseDateKey(endEntry.date);
  const earliestDate = parseDateKey(timeline[0].date);

  let desiredStart = earliestDate;
  if (range.days && endDate) {
    desiredStart = new Date(endDate.getTime() - range.days * MS_PER_DAY);
  }

  const startDate = clampStartDate(timeline, desiredStart);
  const startEntry = findStartEntry(timeline, startDate);
  const effectiveStartDate = parseDateKey(startEntry?.date) || startDate || earliestDate;
  const filteredTimeline = filterTimeline(timeline, effectiveStartDate);

  const { contributions, withdrawals, flows } = summarizeCashFlows(
    performance.cashFlows,
    effectiveStartDate,
    endDate
  );

  const startValue = Number(startEntry?.value) || 0;
  const endValue = Number(endEntry?.value) || 0;

  const totalPnl = (endValue + withdrawals) - (startValue + contributions);
  const invested = startValue + contributions;
  const totalReturn = invested > 0 ? totalPnl / invested : null;

  const irrFlows = [];
  if (effectiveStartDate && startValue) {
    irrFlows.push({ date: effectiveStartDate, amount: -startValue });
  }
  flows.forEach((flow) => {
    irrFlows.push(flow);
  });
  if (endDate && endValue) {
    irrFlows.push({ date: endDate, amount: endValue });
  }

  const cagr = irrFlows.length >= 2 ? computeXirr(irrFlows) : null;

  return {
    range,
    timeline: filteredTimeline,
    startDate: effectiveStartDate || null,
    endDate: endDate || null,
    startValue,
    endValue,
    contributions,
    withdrawals,
    totalPnl,
    totalReturn,
    cagr,
  };
}
