export const DELTA_EPSILON = 1e-6;

export const TOTAL_PNL_TIMEFRAME_OPTIONS = Object.freeze([
  { value: '15D', label: '15 days' },
  { value: '1M', label: '1 month' },
  { value: '3M', label: '3 months' },
  { value: '6M', label: '6 months' },
  { value: '1Y', label: '1 year' },
  { value: '3Y', label: '3 years' },
  { value: '5Y', label: '5 years' },
  { value: 'ALL', label: 'All' },
]);

export function parseDateOnly(value) {
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

export function subtractInterval(date, option) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  const result = new Date(date.getTime());
  switch (option) {
    case '15D':
      result.setDate(result.getDate() - 15);
      break;
    case '1M':
      result.setMonth(result.getMonth() - 1);
      break;
    case '3M':
      result.setMonth(result.getMonth() - 3);
      break;
    case '6M':
      result.setMonth(result.getMonth() - 6);
      break;
    case '1Y':
      result.setFullYear(result.getFullYear() - 1);
      break;
    case '3Y':
      result.setFullYear(result.getFullYear() - 3);
      break;
    case '5Y':
      result.setFullYear(result.getFullYear() - 5);
      break;
    default:
      return null;
  }
  return result;
}

function coerceFinite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildTotalPnlDisplaySeries(points, timeframe = 'ALL', options = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const normalizedTimeframe = typeof timeframe === 'string' ? timeframe.trim().toUpperCase() : 'ALL';
  const displayStartDate = options?.displayStartDate ? parseDateOnly(options.displayStartDate) : null;
  const displayStartTotals = options && typeof options.displayStartTotals === 'object'
    ? options.displayStartTotals
    : null;

  const sanitized = points
    .map((entry) => ({
      date: entry?.date || null,
      totalPnlCad: coerceFinite(entry?.totalPnlCad),
      totalPnlSinceDisplayStartCad: coerceFinite(entry?.totalPnlSinceDisplayStartCad),
      equityCad: coerceFinite(entry?.equityCad),
      equitySinceDisplayStartCad: coerceFinite(entry?.equitySinceDisplayStartCad),
      cumulativeNetDepositsCad: coerceFinite(entry?.cumulativeNetDepositsCad),
      cumulativeNetDepositsSinceDisplayStartCad: coerceFinite(entry?.cumulativeNetDepositsSinceDisplayStartCad),
    }))
    .filter((entry) => entry.date && entry.totalPnlCad !== null);

  if (!sanitized.length) {
    return [];
  }

  sanitized.sort((a, b) => {
    const aDate = parseDateOnly(a.date)?.getTime() ?? 0;
    const bDate = parseDateOnly(b.date)?.getTime() ?? 0;
    return aDate - bDate;
  });

  const afterDisplayStart = displayStartDate
    ? sanitized.filter((entry) => {
        const entryDate = parseDateOnly(entry.date);
        if (!entryDate) {
          return false;
        }
        return entryDate >= displayStartDate;
      })
    : sanitized;

  if (!afterDisplayStart.length) {
    return [];
  }

  let working = afterDisplayStart;
  if (normalizedTimeframe && normalizedTimeframe !== 'ALL') {
    const lastEntry = afterDisplayStart[afterDisplayStart.length - 1];
    const lastDate = parseDateOnly(lastEntry.date);
    const cutoff = subtractInterval(lastDate, normalizedTimeframe);
    if (cutoff) {
      const timeframeFiltered = afterDisplayStart.filter((entry) => {
        const entryDate = parseDateOnly(entry.date);
        if (!entryDate) {
          return false;
        }
        return entryDate >= cutoff;
      });
      if (timeframeFiltered.length) {
        working = timeframeFiltered;
      }
    }
  }

  const baselineTotalPnl = coerceFinite(displayStartTotals?.totalPnlCad) ?? afterDisplayStart[0]?.totalPnlCad ?? null;
  const baselineEquity = coerceFinite(displayStartTotals?.equityCad) ?? afterDisplayStart[0]?.equityCad ?? null;
  const baselineDeposits =
    coerceFinite(displayStartTotals?.cumulativeNetDepositsCad) ?? afterDisplayStart[0]?.cumulativeNetDepositsCad ?? null;

  return working.map((entry, index) => {
    const normalized = { ...entry };

    if (normalized.totalPnlSinceDisplayStartCad === null && normalized.totalPnlCad !== null) {
      if (baselineTotalPnl !== null) {
        const delta = normalized.totalPnlCad - baselineTotalPnl;
        normalized.totalPnlSinceDisplayStartCad = Math.abs(delta) < DELTA_EPSILON ? 0 : delta;
      }
    } else if (index === 0 && normalized.totalPnlSinceDisplayStartCad !== null) {
      normalized.totalPnlSinceDisplayStartCad =
        Math.abs(normalized.totalPnlSinceDisplayStartCad) < DELTA_EPSILON ? 0 : normalized.totalPnlSinceDisplayStartCad;
    }

    if (normalized.equitySinceDisplayStartCad === null && normalized.equityCad !== null) {
      if (baselineEquity !== null) {
        const delta = normalized.equityCad - baselineEquity;
        normalized.equitySinceDisplayStartCad = Math.abs(delta) < DELTA_EPSILON ? 0 : delta;
      }
    } else if (index === 0 && normalized.equitySinceDisplayStartCad !== null) {
      normalized.equitySinceDisplayStartCad =
        Math.abs(normalized.equitySinceDisplayStartCad) < DELTA_EPSILON ? 0 : normalized.equitySinceDisplayStartCad;
    }

    if (normalized.cumulativeNetDepositsSinceDisplayStartCad === null && normalized.cumulativeNetDepositsCad !== null) {
      if (baselineDeposits !== null) {
        const delta = normalized.cumulativeNetDepositsCad - baselineDeposits;
        normalized.cumulativeNetDepositsSinceDisplayStartCad = Math.abs(delta) < DELTA_EPSILON ? 0 : delta;
      }
    } else if (index === 0 && normalized.cumulativeNetDepositsSinceDisplayStartCad !== null) {
      normalized.cumulativeNetDepositsSinceDisplayStartCad =
        Math.abs(normalized.cumulativeNetDepositsSinceDisplayStartCad) < DELTA_EPSILON
          ? 0
          : normalized.cumulativeNetDepositsSinceDisplayStartCad;
    }

    normalized.totalPnl = normalized.totalPnlCad;
    normalized.totalPnlDelta =
      normalized.totalPnlSinceDisplayStartCad !== null ? normalized.totalPnlSinceDisplayStartCad : undefined;
    normalized.equity = normalized.equityCad;
    normalized.equityDelta =
      normalized.equitySinceDisplayStartCad !== null ? normalized.equitySinceDisplayStartCad : undefined;
    normalized.netDeposits = normalized.cumulativeNetDepositsCad;
    normalized.netDepositsDelta =
      normalized.cumulativeNetDepositsSinceDisplayStartCad !== null
        ? normalized.cumulativeNetDepositsSinceDisplayStartCad
        : undefined;

    return normalized;
  });
}

const totalPnlDisplay = {
  TOTAL_PNL_TIMEFRAME_OPTIONS,
  buildTotalPnlDisplaySeries,
  parseDateOnly,
  subtractInterval,
};

export default totalPnlDisplay;
