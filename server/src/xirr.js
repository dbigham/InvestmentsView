'use strict';

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const CASH_FLOW_EPSILON = 1e-8;
const DEFAULT_GUESS = 0.1;

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function normalizeCashFlowsForXirr(cashFlows) {
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
        const parsed = new Date(entry.date);
        if (isValidDate(parsed)) {
          date = parsed;
        }
      } else if (typeof entry.timestamp === 'string' && entry.timestamp.trim()) {
        const parsedTimestamp = new Date(entry.timestamp);
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
  return (end.getTime() - start.getTime()) / DAY_IN_MS / 365;
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

function xirr(cashFlows, guess = DEFAULT_GUESS) {
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
  const MAX_RATE = 1e6;

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

  let rate = Number.isFinite(guess) ? guess : DEFAULT_GUESS;
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
  let fHighBound = fHigh;

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
        fHighBound = residual;
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
      fHighBound = fMid;
    } else {
      lowBound = mid;
      fLowBound = fMid;
    }
  }

  return mid;
}

function computeAnnualizedReturnFromCashFlows(cashFlows, options = {}) {
  const { guess, onFailure, preNormalized } = options || {};
  const normalized = preNormalized
    ? Array.isArray(cashFlows)
      ? cashFlows.slice()
      : []
    : normalizeCashFlowsForXirr(cashFlows);
  if (normalized.length < 2) {
    if (typeof onFailure === 'function') {
      onFailure({ reason: 'insufficient_data', normalized });
    }
    return null;
  }

  const rate = xirr(normalized, guess);
  if (Number.isFinite(rate)) {
    return rate;
  }

  if (typeof onFailure === 'function') {
    let hasPositive = false;
    let hasNegative = false;
    for (const entry of normalized) {
      if (entry.amount > CASH_FLOW_EPSILON) {
        hasPositive = true;
      } else if (entry.amount < -CASH_FLOW_EPSILON) {
        hasNegative = true;
      }
    }
    onFailure({ reason: 'no_convergence', normalized, hasPositive, hasNegative });
  }

  return null;
}

module.exports = {
  CASH_FLOW_EPSILON,
  DAY_IN_MS,
  normalizeCashFlowsForXirr,
  yearFraction,
  xnpv,
  dxnpv,
  xirr,
  computeAnnualizedReturnFromCashFlows,
};
