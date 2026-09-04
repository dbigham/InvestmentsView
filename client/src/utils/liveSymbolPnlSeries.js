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

export function resolveLatestMarketDateKey(positions, asOf) {
  let latestTimestamp = null;
  if (Array.isArray(positions)) {
    positions.forEach((position) => {
      const timestamp = new Date(position?.priceAsOf).getTime();
      if (Number.isFinite(timestamp) && (latestTimestamp === null || timestamp > latestTimestamp)) {
        latestTimestamp = timestamp;
      }
    });
  }
  if (latestTimestamp === null) {
    const asOfTimestamp = asOf ? new Date(asOf).getTime() : Number.NaN;
    latestTimestamp = Number.isFinite(asOfTimestamp) ? asOfTimestamp : null;
  }
  return latestTimestamp === null ? null : marketDateKey(latestTimestamp);
}

export function computeSeriesDayPnlCad(series, marketDateKeyValue) {
  if (!series || !Array.isArray(series.points) || !marketDateKeyValue) {
    return null;
  }
  const currentIndex = series.points.findLastIndex((point) =>
    typeof point?.date === 'string' && point.date.slice(0, 10) === marketDateKeyValue
  );
  if (currentIndex <= 0) {
    return null;
  }
  const currentPnlCad = Number(series.points[currentIndex]?.totalPnlCad);
  if (!Number.isFinite(currentPnlCad)) {
    return null;
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const point = series.points[index];
    const pointDateKey = typeof point?.date === 'string' ? point.date.slice(0, 10) : null;
    const priorPnlCad = Number(point?.totalPnlCad);
    if (pointDateKey && pointDateKey !== marketDateKeyValue && Number.isFinite(priorPnlCad)) {
      return currentPnlCad - priorPnlCad;
    }
  }
  return null;
}

function computeSeriesExternalFlowCad(series, marketDateKeyValue) {
  if (!series || !Array.isArray(series.points) || !marketDateKeyValue) {
    return null;
  }
  const currentIndex = series.points.findLastIndex((point) =>
    typeof point?.date === 'string' && point.date.slice(0, 10) === marketDateKeyValue
  );
  if (currentIndex <= 0) {
    return null;
  }
  const currentDepositsCad = Number(series.points[currentIndex]?.cumulativeNetDepositsCad);
  if (!Number.isFinite(currentDepositsCad)) {
    return null;
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const point = series.points[index];
    const pointDateKey = typeof point?.date === 'string' ? point.date.slice(0, 10) : null;
    const priorDepositsCad = Number(point?.cumulativeNetDepositsCad);
    if (pointDateKey && pointDateKey !== marketDateKeyValue && Number.isFinite(priorDepositsCad)) {
      return currentDepositsCad - priorDepositsCad;
    }
  }
  return null;
}

export function computeAccountSeriesExternalFlowCad(
  seriesMap,
  { accountIds = [], requiredAccountIds = [], marketDateKey: marketDateKeyValue } = {}
) {
  if (!seriesMap || typeof seriesMap !== 'object' || !marketDateKeyValue) {
    return null;
  }
  const normalizedAccountIds = Array.from(new Set(accountIds.map((value) => String(value || '').trim()).filter(Boolean)));
  const required = new Set(
    requiredAccountIds.map((value) => String(value || '').trim()).filter(Boolean)
  );
  const covered = new Set();
  let total = 0;
  let count = 0;
  normalizedAccountIds.forEach((accountId) => {
    const container = seriesMap[accountId];
    const series = container?.all || container?.cagr ||
      (Array.isArray(container?.points) ? container : null);
    const externalFlowCad = computeSeriesExternalFlowCad(series, marketDateKeyValue);
    if (!Number.isFinite(externalFlowCad)) {
      return;
    }
    total += externalFlowCad;
    count += 1;
    covered.add(accountId);
  });
  if (!count || Array.from(required).some((accountId) => !covered.has(accountId))) {
    return null;
  }
  return total;
}

export function computeLivePositionValueDeltaCad(
  basePositions,
  livePositions,
  { currencyRates, baseCurrency = 'CAD', isExcluded = () => false } = {}
) {
  if (!Array.isArray(basePositions) || !Array.isArray(livePositions)) {
    return null;
  }
  const normalizedBase = normalizeSymbol(baseCurrency) || 'CAD';
  const totals = (positions) => {
    const result = new Map();
    positions.forEach((position) => {
      if (!position || isExcluded(position)) {
        return;
      }
      const currency = normalizeSymbol(position.currency || normalizedBase) || normalizedBase;
      const accountId = String(position.accountId || position.accountNumber || '').trim();
      const symbol = normalizeSymbol(position.symbol);
      if (!accountId || !symbol) {
        return;
      }
      let marketValue = Number(position.currentMarketValue);
      if (!Number.isFinite(marketValue)) {
        const price = Number(position.currentPrice);
        const quantity = Number(position.openQuantity);
        marketValue = Number.isFinite(price) && Number.isFinite(quantity) ? price * quantity : Number.NaN;
      }
      if (!Number.isFinite(marketValue)) {
        return;
      }
      const key = `${accountId}\u0000${symbol}\u0000${currency}`;
      result.set(key, (result.get(key) || 0) + marketValue);
    });
    return result;
  };
  const baseTotals = totals(basePositions);
  const liveTotals = totals(livePositions);
  const keys = new Set([...baseTotals.keys(), ...liveTotals.keys()]);
  let deltaCad = 0;
  for (const key of keys) {
    const currency = key.split('\u0000').at(-1);
    const rate = currency === normalizedBase ? 1 : Number(currencyRates?.get(currency));
    if (!Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    deltaCad += ((liveTotals.get(key) || 0) - (baseTotals.get(key) || 0)) * rate;
  }
  return deltaCad;
}

export function computeSeriesEquityBasisAdjustmentCad(series) {
  if (!series || !Array.isArray(series.points) || !series.points.length) {
    return null;
  }
  const point = series.points[series.points.length - 1];
  const equityCad = Number(point?.equityCad);
  const cadCash = Number(point?.cadCash);
  const usdCash = Number(point?.usdCash);
  const cadSecurityValue = Number(point?.cadSecurityValue);
  const usdSecurityValue = Number(point?.usdSecurityValue);
  const usdToCadRate = Number(point?.usdToCadRate);
  if (
    !Number.isFinite(equityCad) ||
    !Number.isFinite(cadCash) ||
    !Number.isFinite(usdCash) ||
    !Number.isFinite(cadSecurityValue) ||
    !Number.isFinite(usdSecurityValue) ||
    !Number.isFinite(usdToCadRate)
  ) {
    return null;
  }
  return equityCad - cadCash - cadSecurityValue - (usdCash + usdSecurityValue) * usdToCadRate;
}

export function shouldApplyLiveSeriesToFundingSummary({
  isAggregateSelection = false,
  symbolExclusionActive = false,
} = {}) {
  // The aggregate funding summary is the authoritative household capital
  // basis. A live chart overlay may estimate today's P&L for continuity, but
  // back-solving capital from that estimate must not replace Net invested.
  return symbolExclusionActive || !isAggregateSelection;
}

export function shouldApplyLivePortfolioSnapshotToSeries({
  isAggregateSelection = false,
  symbolExclusionActive = false,
} = {}) {
  // Aggregate series already reconcile the complete account universe and the
  // authoritative current endpoint on the server. Re-anchoring them a few
  // seconds later from provider day P&L can double-apply today's movement.
  return !isAggregateSelection && !symbolExclusionActive;
}

export function applyLivePortfolioSnapshotToPnlSeries(
  series,
  {
    totalEquityCad,
    externalFlowCad,
    dayPnlCad,
    currentCapitalCad,
    positions = [],
    asOf = null,
  } = {}
) {
  if (!series || !Array.isArray(series.points) || series.points.length < 2) {
    return series;
  }
  const optionalNumber = (value) =>
    value === null || value === undefined || value === '' ? Number.NaN : Number(value);
  const liveEquityCad = Number(totalEquityCad);
  const liveExternalFlowCad = optionalNumber(externalFlowCad);
  const providerDayPnlCad = optionalNumber(dayPnlCad);
  const hasExternalFlow = Number.isFinite(liveExternalFlowCad);
  const hasProviderDayPnl = Number.isFinite(providerDayPnlCad);
  if (!Number.isFinite(liveEquityCad) || (!hasExternalFlow && !hasProviderDayPnl)) {
    return series;
  }

  const lastPointIndex = series.points.length - 1;
  const lastPoint = series.points[lastPointIndex];
  const lastDateKey = typeof lastPoint?.date === 'string' ? lastPoint.date.slice(0, 10) : null;
  if (!lastDateKey || resolveLatestMarketDateKey(positions, asOf) !== lastDateKey) {
    return series;
  }

  const historicalEquityCad = Number(lastPoint?.equityCad);
  const historicalDepositsCad = Number(lastPoint?.cumulativeNetDepositsCad);
  const historicalPnlCad = Number(lastPoint?.totalPnlCad);
  let priorPointIndex = -1;
  for (let index = series.points.length - 2; index >= 0; index -= 1) {
    const point = series.points[index];
    const pointDateKey = typeof point?.date === 'string' ? point.date.slice(0, 10) : null;
    if (pointDateKey && pointDateKey !== lastDateKey) {
      priorPointIndex = index;
      break;
    }
  }
  const priorPoint = priorPointIndex >= 0 ? series.points[priorPointIndex] : null;
  const priorEquityCad = Number(priorPoint?.equityCad);
  const priorDepositsCad = Number(priorPoint?.cumulativeNetDepositsCad);
  const priorPnlCad = Number(priorPoint?.totalPnlCad);
  if (
    !Number.isFinite(historicalEquityCad) ||
    !Number.isFinite(historicalDepositsCad) ||
    !Number.isFinite(historicalPnlCad) ||
    !Number.isFinite(priorEquityCad) ||
    !Number.isFinite(priorDepositsCad) ||
    !Number.isFinite(priorPnlCad)
  ) {
    return series;
  }

  const hasCapitalCandidate =
    currentCapitalCad !== null &&
    currentCapitalCad !== undefined &&
    currentCapitalCad !== '';
  const authoritativeCapitalCad = hasCapitalCandidate ? Number(currentCapitalCad) : Number.NaN;
  const hasAuthoritativeCapital = Number.isFinite(authoritativeCapitalCad);
  const liveDayPnlCad = hasProviderDayPnl
    ? providerDayPnlCad
    : liveEquityCad - priorEquityCad - liveExternalFlowCad;
  // A provider-reported day P&L is the best continuity anchor when an account
  // first appears today and therefore has no prior point from which to prove an
  // external flow. Do not turn a reconstructed opening-capital difference into
  // a one-day market loss; derive only today's capital from equity minus the
  // continuous P&L series instead.
  const livePnlCad = hasProviderDayPnl
    ? priorPnlCad + liveDayPnlCad
    : hasAuthoritativeCapital
      ? liveEquityCad - authoritativeCapitalCad
      : priorPnlCad + liveDayPnlCad;
  const liveDepositsCad = hasProviderDayPnl
    ? liveEquityCad - livePnlCad
    : hasAuthoritativeCapital
      ? authoritativeCapitalCad
      : priorDepositsCad + liveExternalFlowCad;
  const equityDeltaCad = liveEquityCad - historicalEquityCad;
  const depositsDeltaCad = liveDepositsCad - historicalDepositsCad;
  const pnlDeltaCad = livePnlCad - historicalPnlCad;
  const displayStartTotals = series.summary?.displayStartTotals;
  const displayStartEquityCad = optionalNumber(displayStartTotals?.equityCad);
  const displayStartDepositsCad = optionalNumber(displayStartTotals?.cumulativeNetDepositsCad);
  const displayStartPnlCad = optionalNumber(displayStartTotals?.totalPnlCad);
  const liveEquitySinceDisplayStartCad = Number.isFinite(displayStartEquityCad)
    ? liveEquityCad - displayStartEquityCad
    : addDelta(lastPoint.equitySinceDisplayStartCad, equityDeltaCad);
  const liveDepositsSinceDisplayStartCad = Number.isFinite(displayStartDepositsCad)
    ? liveDepositsCad - displayStartDepositsCad
    : addDelta(lastPoint.cumulativeNetDepositsSinceDisplayStartCad, depositsDeltaCad);
  const livePnlSinceDisplayStartCad = Number.isFinite(displayStartPnlCad)
    ? livePnlCad - displayStartPnlCad
    : addDelta(lastPoint.totalPnlSinceDisplayStartCad, pnlDeltaCad);
  if (
    Math.abs(equityDeltaCad) < 1e-9 &&
    Math.abs(depositsDeltaCad) < 1e-9 &&
    Math.abs(pnlDeltaCad) < 1e-9
  ) {
    return series;
  }

  const nextLastPoint = {
    ...lastPoint,
    equityCad: liveEquityCad,
    cumulativeNetDepositsCad: liveDepositsCad,
    totalPnlCad: livePnlCad,
    equitySinceDisplayStartCad: liveEquitySinceDisplayStartCad,
    cumulativeNetDepositsSinceDisplayStartCad: liveDepositsSinceDisplayStartCad,
    totalPnlSinceDisplayStartCad: livePnlSinceDisplayStartCad,
  };
  const nextSummary = series.summary && typeof series.summary === 'object'
    ? {
        ...series.summary,
        totalEquityCad: liveEquityCad,
        totalPnlCad: livePnlCad,
        totalPnlAllTimeCad: livePnlCad,
        ...(hasAuthoritativeCapital
          ? {
              netDepositsCad: liveDepositsCad,
              netDepositsAllTimeCad: liveDepositsCad,
            }
          : {}),
        totalEquitySinceDisplayStartCad: liveEquitySinceDisplayStartCad,
        totalPnlSinceDisplayStartCad: livePnlSinceDisplayStartCad,
      }
    : series.summary;

  return {
    ...series,
    points: [...series.points.slice(0, -1), nextLastPoint],
    summary: nextSummary,
  };
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
