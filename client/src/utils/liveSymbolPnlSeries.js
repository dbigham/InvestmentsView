function normalizeSymbol(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function marketDateKey(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

function addDelta(value, delta) {
  return Number.isFinite(Number(value)) ? Number(value) + delta : value;
}

export function applyLivePriceToSymbolPnlSeries(
  series,
  { positions = [], symbol, currencyRates, baseCurrency = 'CAD', asOf = null } = {}
) {
  if (!series || !Array.isArray(series.points) || !series.points.length) {
    return series;
  }
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol || !Array.isArray(positions) || !positions.length) {
    return series;
  }

  const lastPoint = series.points[series.points.length - 1];
  const historicalPrice = Number(lastPoint?.priceNative);
  const lastDateKey = typeof lastPoint?.date === 'string' ? lastPoint.date.slice(0, 10) : null;
  if (!Number.isFinite(historicalPrice) || historicalPrice <= 0 || !lastDateKey) {
    return series;
  }

  const matchingPositions = positions.filter((position) => {
    const currentPrice = Number(position?.currentPrice);
    const quantity = Number(position?.openQuantity);
    return (
      normalizeSymbol(position?.symbol) === normalizedSymbol &&
      Number.isFinite(currentPrice) &&
      currentPrice > 0 &&
      Number.isFinite(quantity) &&
      Math.abs(quantity) > 1e-9 &&
      marketDateKey(position?.priceAsOf || asOf) === lastDateKey
    );
  });
  if (!matchingPositions.length) {
    return series;
  }

  let deltaCad = 0;
  let deltaNative = 0;
  let priceAccumulator = 0;
  let priceWeight = 0;
  let resolvedCurrency = null;
  for (const position of matchingPositions) {
    const currentPrice = Number(position.currentPrice);
    const quantity = Number(position.openQuantity);
    const currency = normalizeSymbol(position.currency || baseCurrency) || normalizeSymbol(baseCurrency);
    if (resolvedCurrency && currency !== resolvedCurrency) {
      return series;
    }
    resolvedCurrency = currency;
    const normalizedBase = normalizeSymbol(baseCurrency) || 'CAD';
    const rate = currency === normalizedBase ? 1 : Number(currencyRates?.get(currency));
    if (!Number.isFinite(rate) || rate <= 0) {
      return series;
    }
    const positionDeltaNative = (currentPrice - historicalPrice) * quantity;
    deltaNative += positionDeltaNative;
    deltaCad += positionDeltaNative * rate;
    const weight = Math.abs(quantity);
    priceAccumulator += currentPrice * weight;
    priceWeight += weight;
  }

  if (!Number.isFinite(deltaCad) || Math.abs(deltaCad) < 1e-9 || priceWeight <= 0) {
    return series;
  }

  const livePrice = priceAccumulator / priceWeight;
  const normalizedBase = normalizeSymbol(baseCurrency) || 'CAD';
  const rate = resolvedCurrency === normalizedBase ? 1 : Number(currencyRates?.get(resolvedCurrency));
  const nextLastPoint = {
    ...lastPoint,
    equityCad: addDelta(lastPoint.equityCad, deltaCad),
    totalPnlCad: addDelta(lastPoint.totalPnlCad, deltaCad),
    totalPnlSinceDisplayStartCad: addDelta(lastPoint.totalPnlSinceDisplayStartCad, deltaCad),
    priceNative: livePrice,
    priceCad: livePrice * rate,
  };
  if (resolvedCurrency === 'USD') {
    nextLastPoint.usdSecurityValue = addDelta(lastPoint.usdSecurityValue, deltaNative);
  } else if (resolvedCurrency === normalizedBase) {
    nextLastPoint.cadSecurityValue = addDelta(lastPoint.cadSecurityValue, deltaNative);
  }

  const nextSummary = series.summary && typeof series.summary === 'object'
    ? {
        ...series.summary,
        totalEquityCad: addDelta(series.summary.totalEquityCad, deltaCad),
        totalPnlCad: addDelta(series.summary.totalPnlCad, deltaCad),
        totalPnlAllTimeCad: addDelta(series.summary.totalPnlAllTimeCad, deltaCad),
        totalPnlSinceDisplayStartCad: addDelta(series.summary.totalPnlSinceDisplayStartCad, deltaCad),
        priceNative: livePrice,
        priceCad: livePrice * rate,
      }
    : series.summary;

  return {
    ...series,
    points: [...series.points.slice(0, -1), nextLastPoint],
    summary: nextSummary,
  };
}
