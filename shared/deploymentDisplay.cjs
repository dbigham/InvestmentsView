const RESERVE_SYMBOLS = Object.freeze(['SGOV', 'BIL', 'VBIL', 'PSA.TO', 'HFR.TO']);

const DEPLOYMENT_TIMEFRAME_OPTIONS = Object.freeze([
  { value: '1M', label: '1 month' },
  { value: '3M', label: '3 months' },
  { value: '6M', label: '6 months' },
  { value: '1Y', label: '1 year' },
  { value: '3Y', label: '3 years' },
  { value: '5Y', label: '5 years' },
  { value: 'ALL', label: 'All' },
]);

function parseDateOnly(value) {
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

function subtractInterval(date, option) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  const result = new Date(date.getTime());
  switch (option) {
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

function coerceNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildDeploymentDisplaySeries(points, timeframe = 'ALL') {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }

  const normalizedTimeframe = typeof timeframe === 'string' ? timeframe.trim().toUpperCase() : 'ALL';

  const sanitized = points
    .map((entry) => {
      const date = entry?.date ? String(entry.date).trim() : null;
      const deployedValueCad = coerceNumber(entry?.deployedValueCad);
      const reserveValueCad = coerceNumber(entry?.reserveValueCad);
      const equityCad = coerceNumber(entry?.equityCad);
      let deployedPercent = coerceNumber(entry?.deployedPercent);
      if (
        deployedPercent === null &&
        deployedValueCad !== null &&
        equityCad !== null &&
        Math.abs(equityCad) > 0.00001
      ) {
        deployedPercent = (deployedValueCad / equityCad) * 100;
      }
      let reservePercent = coerceNumber(entry?.reservePercent);
      if (
        reservePercent === null &&
        deployedPercent !== null
      ) {
        reservePercent = 100 - deployedPercent;
      }
      if (
        reservePercent === null &&
        reserveValueCad !== null &&
        equityCad !== null &&
        Math.abs(equityCad) > 0.00001
      ) {
        reservePercent = (reserveValueCad / equityCad) * 100;
      }
      return {
        date,
        deployedValueCad,
        reserveValueCad,
        equityCad,
        deployedPercent,
        reservePercent,
      };
    })
    .filter((entry) => entry.date && (entry.deployedValueCad !== null || entry.deployedPercent !== null));

  if (!sanitized.length) {
    return [];
  }

  sanitized.sort((a, b) => {
    const aDate = parseDateOnly(a.date)?.getTime() ?? 0;
    const bDate = parseDateOnly(b.date)?.getTime() ?? 0;
    return aDate - bDate;
  });

  let working = sanitized;
  if (normalizedTimeframe && normalizedTimeframe !== 'ALL') {
    const lastEntry = sanitized[sanitized.length - 1];
    const lastDate = parseDateOnly(lastEntry.date);
    const cutoff = subtractInterval(lastDate, normalizedTimeframe);
    if (cutoff) {
      const timeframeFiltered = sanitized.filter((entry) => {
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

  return working.map((entry) => {
    const equityCad = entry.equityCad !== null
      ? entry.equityCad
      : entry.deployedValueCad !== null && entry.reserveValueCad !== null
        ? entry.deployedValueCad + entry.reserveValueCad
        : null;
    let deployedPercent = entry.deployedPercent;
    if (
      deployedPercent === null &&
      entry.deployedValueCad !== null &&
      equityCad !== null &&
      Math.abs(equityCad) > 0.00001
    ) {
      deployedPercent = (entry.deployedValueCad / equityCad) * 100;
    }
    let reservePercent = entry.reservePercent;
    if (
      reservePercent === null &&
      entry.reserveValueCad !== null &&
      equityCad !== null &&
      Math.abs(equityCad) > 0.00001
    ) {
      reservePercent = (entry.reserveValueCad / equityCad) * 100;
    }
    if (reservePercent === null && deployedPercent !== null) {
      reservePercent = 100 - deployedPercent;
    }
    return {
      date: entry.date,
      deployedValueCad: entry.deployedValueCad,
      reserveValueCad: entry.reserveValueCad,
      equityCad,
      deployedPercent,
      reservePercent,
    };
  });
}

module.exports = {
  RESERVE_SYMBOLS,
  DEPLOYMENT_TIMEFRAME_OPTIONS,
  buildDeploymentDisplaySeries,
  parseDateOnly,
  subtractInterval,
};

module.exports.default = module.exports;
