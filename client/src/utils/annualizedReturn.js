const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CASH_FLOW_EPSILON = 0.000001;

function parseDateString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const isoString = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00Z`
    : trimmed;
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function normalizeSeriesDateKey(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return isValidDate(value) ? value.toISOString().slice(0, 10) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  const parsed = parseDateString(trimmed);
  if (!parsed) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

export function normalizeCashFlowsForXirr(cashFlows) {
  if (!Array.isArray(cashFlows)) {
    return [];
  }
  return cashFlows
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const numericAmount = Number(entry.amount);
      if (!Number.isFinite(numericAmount) || Math.abs(numericAmount) < CASH_FLOW_EPSILON) {
        return null;
      }

      let date = null;
      if (isValidDate(entry.date)) {
        date = entry.date;
      } else if (isValidDate(entry.timestamp)) {
        date = entry.timestamp;
      } else if (typeof entry.date === 'string' && entry.date.trim()) {
        const parsedDate = parseDateString(entry.date);
        if (isValidDate(parsedDate)) {
          date = parsedDate;
        }
      } else if (typeof entry.timestamp === 'string' && entry.timestamp.trim()) {
        const parsedTimestamp = parseDateString(entry.timestamp);
        if (isValidDate(parsedTimestamp)) {
          date = parsedTimestamp;
        }
      }

      if (!isValidDate(date)) {
        return null;
      }
      return { amount: numericAmount, date };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
}

function yearFraction(start, end) {
  return (end.getTime() - start.getTime()) / MS_PER_DAY / 365;
}

function xnpv(rate, cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length === 0) {
    return Number.NaN;
  }
  if (rate <= -0.999999) {
    return Number.POSITIVE_INFINITY;
  }
  const baseDate = cashFlows[0].date;
  return cashFlows.reduce((sum, entry) => {
    const t = yearFraction(baseDate, entry.date);
    return sum + entry.amount / Math.pow(1 + rate, t);
  }, 0);
}

function dxnpv(rate, cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length === 0) {
    return Number.NaN;
  }
  const baseDate = cashFlows[0].date;
  return cashFlows.reduce((sum, entry) => {
    const t = yearFraction(baseDate, entry.date);
    return sum + (-t) * entry.amount / Math.pow(1 + rate, t + 1);
  }, 0);
}

export function xirr(cashFlows, guess = 0.1) {
  let flows = [];
  if (Array.isArray(cashFlows) && cashFlows.length > 0) {
    const maybeNormalized = cashFlows.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.amount === 'number' &&
        Number.isFinite(entry.amount) &&
        isValidDate(entry.date)
    );
    if (maybeNormalized) {
      flows = cashFlows.slice().sort((a, b) => a.date - b.date);
    }
  }
  if (!flows.length) {
    flows = normalizeCashFlowsForXirr(cashFlows);
  }
  if (flows.length < 2) {
    return Number.NaN;
  }

  let hasPositive = false;
  let hasNegative = false;
  for (const entry of flows) {
    if (entry.amount > CASH_FLOW_EPSILON) {
      hasPositive = true;
    } else if (entry.amount < -CASH_FLOW_EPSILON) {
      hasNegative = true;
    }
  }
  if (!hasPositive || !hasNegative) {
    return Number.NaN;
  }

  const MIN_RATE = -0.999999;
  const MAX_RATE = 1000000;

  let low = -0.9999;
  let high = 1.0;
  let fLow = xnpv(low, flows);
  let fHigh = xnpv(high, flows);

  const isUsable = (value) =>
    Number.isFinite(value) || value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY;

  for (let i = 0; i < 100 && isUsable(fLow) && isUsable(fHigh) && fLow * fHigh > 0; i += 1) {
    let expanded = false;

    const canExpandLow = low > MIN_RATE + 1e-9;
    const canExpandHigh = high < MAX_RATE;
    const preferHigh =
      canExpandHigh &&
      (!canExpandLow || Math.abs(fHigh) <= Math.abs(fLow) || !Number.isFinite(fLow));

    if (fLow * fHigh > 0 && canExpandHigh && preferHigh) {
      const previousHigh = high;
      if (high >= 0) {
        high += 1 + Math.abs(high);
      } else {
        high *= 2;
      }
      if (high === previousHigh) {
        high = previousHigh + 1;
      }
      high = Math.min(high, MAX_RATE);
      fHigh = xnpv(high, flows);
      expanded = true;
    }

    if (fLow * fHigh > 0 && canExpandLow && (!preferHigh || !expanded)) {
      const nextLow = Math.max(MIN_RATE, low - (1 + Math.abs(low)));
      if (nextLow !== low) {
        low = nextLow;
        fLow = xnpv(low, flows);
        expanded = true;
      }
    }

    if (!expanded) {
      break;
    }
  }

  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh) || fLow * fHigh > 0) {
    return Number.NaN;
  }

  let rate = Number.isFinite(guess) ? guess : 0.1;
  for (let i = 0; i < 50; i += 1) {
    const f = xnpv(rate, flows);
    if (!Number.isFinite(f)) {
      break;
    }
    if (Math.abs(f) < 1e-10) {
      return rate;
    }
    const df = dxnpv(rate, flows);
    if (!Number.isFinite(df) || Math.abs(df) < 1e-12) {
      break;
    }
    const next = rate - f / df;
    if (!Number.isFinite(next)) {
      break;
    }
    if (next <= MIN_RATE) {
      rate = MIN_RATE;
      break;
    }
    if (Math.abs(next - rate) < 1e-12) {
      const residual = xnpv(next, flows);
      if (Number.isFinite(residual) && Math.abs(residual) < 1e-10) {
        return next;
      }
      break;
    }
    rate = next;
  }

  let lowBound = low;
  let highBound = high;
  let fLowBound = fLow;

  if (rate > lowBound && rate < highBound) {
    const residual = xnpv(rate, flows);
    if (Number.isFinite(residual) && Math.abs(residual) < 1e-8) {
      return rate;
    }
    if (Number.isFinite(residual)) {
      if (residual > 0) {
        fLowBound = residual;
        lowBound = rate;
      } else if (residual < 0) {
        highBound = rate;
      }
    }
  }

  let mid = Number.NaN;
  for (let i = 0; i < 200; i += 1) {
    mid = (lowBound + highBound) / 2;
    const fMid = xnpv(mid, flows);
    if (!Number.isFinite(fMid)) {
      break;
    }
    if (Math.abs(fMid) < 1e-10 || Math.abs(highBound - lowBound) < 1e-12) {
      return mid;
    }
    if (fLowBound * fMid <= 0) {
      highBound = mid;
    } else {
      lowBound = mid;
      fLowBound = fMid;
    }
  }

  return mid;
}

export function computeAnnualizedReturnFromCashFlows(cashFlows) {
  const normalized = normalizeCashFlowsForXirr(cashFlows);
  if (normalized.length < 2) {
    return null;
  }
  const rate = xirr(normalized, 0.1);
  return Number.isFinite(rate) ? rate : null;
}

export function computeAnnualizedReturnFromSeriesPoints(seriesPoints) {
  if (!Array.isArray(seriesPoints) || seriesPoints.length < 2) {
    return {
      rate: null,
      startDate: null,
      endDate: null,
      incomplete: true,
    };
  }

  const entries = seriesPoints
    .map((entry) => {
      const key = normalizeSeriesDateKey(entry?.date);
      if (!key) {
        return null;
      }
      return { key, entry };
    })
    .filter(Boolean)
    .sort((a, b) => a.key.localeCompare(b.key));

  if (entries.length < 2) {
    return {
      rate: null,
      startDate: null,
      endDate: null,
      incomplete: true,
    };
  }

  const resolveNumber = (value) => (Number.isFinite(value) ? value : null);
  const startKey = entries[0].key;
  const endKey = entries[entries.length - 1].key;
  const startDate = parseDateString(startKey);
  const endDate = parseDateString(endKey);

  if (!startDate || !endDate) {
    return {
      rate: null,
      startDate: startKey || null,
      endDate: endKey || null,
      incomplete: true,
    };
  }

  const startEntry = entries[0].entry || null;
  const endEntry = entries[entries.length - 1].entry || null;

  const startEquity =
    resolveNumber(startEntry?.equityCad) ??
    resolveNumber(startEntry?.equity);
  const endEquity =
    resolveNumber(endEntry?.equityCad) ??
    resolveNumber(endEntry?.equity);

  const cashFlows = [];
  if (Number.isFinite(startEquity)) {
    cashFlows.push({ amount: -startEquity, date: startDate });
  }

  for (let i = 1; i < entries.length; i += 1) {
    const current = entries[i]?.entry;
    const previous = entries[i - 1]?.entry;
    if (!current || !previous) {
      continue;
    }
    const currentDeposits =
      resolveNumber(current.cumulativeNetDepositsCad) ??
      resolveNumber(current.netDeposits);
    const previousDeposits =
      resolveNumber(previous.cumulativeNetDepositsCad) ??
      resolveNumber(previous.netDeposits);
    if (!Number.isFinite(currentDeposits) || !Number.isFinite(previousDeposits)) {
      continue;
    }
    const delta = currentDeposits - previousDeposits;
    if (Math.abs(delta) > CASH_FLOW_EPSILON) {
      const flowDate = parseDateString(entries[i].key);
      if (flowDate) {
        cashFlows.push({ amount: -delta, date: flowDate });
      }
    }
  }

  if (Number.isFinite(endEquity)) {
    cashFlows.push({ amount: endEquity, date: endDate });
  }

  const rate = computeAnnualizedReturnFromCashFlows(cashFlows);
  return {
    rate: Number.isFinite(rate) ? rate : null,
    startDate: startKey,
    endDate: endKey,
    incomplete: !Number.isFinite(rate),
  };
}

export function applySeriesAnnualizedToFundingSummary(fundingSummary, seriesPoints) {
  if (!fundingSummary || typeof fundingSummary !== 'object') {
    return fundingSummary;
  }
  if (!Array.isArray(seriesPoints)) {
    return fundingSummary;
  }

  const annualized = computeAnnualizedReturnFromSeriesPoints(seriesPoints);
  if (!annualized) {
    return fundingSummary;
  }

  const nextSummary = { ...fundingSummary };
  nextSummary.annualizedReturnRate = Number.isFinite(annualized.rate) ? annualized.rate : null;
  if (annualized.startDate) {
    nextSummary.annualizedReturnStartDate = annualized.startDate;
    nextSummary.periodStartDate = annualized.startDate;
  }
  if (annualized.endDate) {
    nextSummary.annualizedReturnAsOf = annualized.endDate;
    nextSummary.periodEndDate = annualized.endDate;
  }
  if (annualized.incomplete) {
    nextSummary.annualizedReturnIncomplete = true;
  } else if (Object.prototype.hasOwnProperty.call(nextSummary, 'annualizedReturnIncomplete')) {
    nextSummary.annualizedReturnIncomplete = false;
  }

  return nextSummary;
}
