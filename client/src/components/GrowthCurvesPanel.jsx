import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { getQuote, getSymbolPriceHistory } from '../api/questrade';
import { formatDate, formatMoney, formatNumber, formatPercent, formatSignedPercent } from '../utils/formatters';
import { parseDateOnly } from '../../../shared/totalPnlDisplay.js';
import { buildExponentialGrowthFit } from '../utils/growthFit';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  PADDING,
  buildChartMetrics,
} from './TotalPnlChartUtils';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;
const MAX_CHART_POINTS = 260;
const TEMPERATURE_REFERENCE_VALUES = [1.5, 0.5];

const TIMEFRAMES = [
  { key: 'ALL', label: 'Since inception', shortLabel: 'All', years: null },
  { key: '10Y', label: '10 year', shortLabel: '10Y', years: 10 },
  { key: '5Y', label: '5 year', shortLabel: '5Y', years: 5 },
  { key: '3Y', label: '3 year', shortLabel: '3Y', years: 3 },
  { key: '1Y', label: '1 year', shortLabel: '1Y', years: 1 },
];

function normalizeSymbol(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function coercePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function coerceFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeQuote(quote) {
  if (!quote || typeof quote !== 'object') {
    return null;
  }
  return {
    price: coercePositiveNumber(quote.price),
    currency:
      typeof quote.currency === 'string' && quote.currency.trim()
        ? quote.currency.trim().toUpperCase()
        : null,
    description:
      typeof quote.name === 'string' && quote.name.trim()
        ? quote.name.trim()
        : typeof quote.shortName === 'string' && quote.shortName.trim()
          ? quote.shortName.trim()
          : typeof quote.longName === 'string' && quote.longName.trim()
            ? quote.longName.trim()
            : null,
    changePercent: coerceFiniteNumber(quote.changePercent),
    previousClose: coercePositiveNumber(quote.previousClose),
    peRatio: coercePositiveNumber(quote.peRatio),
    pegRatio: coercePositiveNumber(quote.pegRatio),
    marketCap: coercePositiveNumber(quote.marketCap),
    dividendYieldPercent: coercePositiveNumber(quote.dividendYieldPercent),
    asOf: typeof quote.asOf === 'string' && quote.asOf.trim() ? quote.asOf.trim() : null,
  };
}

function normalizePricePoints(points) {
  const byDate = new Map();
  if (!Array.isArray(points)) {
    return [];
  }
  points.forEach((point) => {
    const date = typeof point?.date === 'string' ? point.date.slice(0, 10) : '';
    const parsedDate = parseDateOnly(date);
    const price = coercePositiveNumber(point?.price);
    if (!date || !parsedDate || price === null) {
      return;
    }
    byDate.set(date, {
      date,
      dateValue: parsedDate.getTime(),
      price,
    });
  });
  return Array.from(byDate.values()).sort((a, b) => a.dateValue - b.dateValue);
}

function subtractYears(date, years) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !Number.isFinite(years)) {
    return null;
  }
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCFullYear(copy.getUTCFullYear() - years);
  return copy;
}

function filterPointsForTimeframe(points, timeframe) {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }
  if (!timeframe?.years) {
    return points;
  }
  const lastPoint = points[points.length - 1];
  const lastDate = parseDateOnly(lastPoint.date);
  const cutoff = subtractYears(lastDate, timeframe.years);
  if (!cutoff) {
    return points;
  }
  const filtered = points.filter((point) => point.dateValue >= cutoff.getTime());
  return filtered.length >= 2 ? filtered : points;
}

function buildFitDiagnostics(points, fit, elapsedYears) {
  if (!Array.isArray(points) || points.length < 2 || !fit?.fittedPoints?.length) {
    return null;
  }
  const fairValueByDate = new Map(
    fit.fittedPoints
      .filter((point) => point?.date && Number.isFinite(point.value) && point.value > 0)
      .map((point) => [point.date, point.value])
  );
  const inputs = points
    .map((point) => {
      const fairPrice = fairValueByDate.get(point.date);
      if (!Number.isFinite(point?.price) || point.price <= 0 || !Number.isFinite(fairPrice) || fairPrice <= 0) {
        return null;
      }
      return {
        date: point.date,
        price: point.price,
        fairPrice,
        logPrice: Math.log(point.price),
        logFairPrice: Math.log(fairPrice),
      };
    })
    .filter(Boolean);
  if (inputs.length < 2) {
    return null;
  }
  const meanLogPrice = inputs.reduce((sum, point) => sum + point.logPrice, 0) / inputs.length;
  let sse = 0;
  let sst = 0;
  const residuals = inputs.map((point) => {
    const residual = point.logPrice - point.logFairPrice;
    sse += residual * residual;
    sst += (point.logPrice - meanLogPrice) * (point.logPrice - meanLogPrice);
    return residual;
  });
  const rmse = Math.sqrt(sse / inputs.length);
  const meanAbsoluteResidual =
    residuals.reduce((sum, residual) => sum + Math.abs(residual), 0) / residuals.length;
  const rSquared = sst > 1e-12 ? 1 - sse / sst : 1;
  const lastInput = inputs[inputs.length - 1];
  const currentLogResidual = lastInput.logPrice - lastInput.logFairPrice;
  return {
    annualGrowthRate: fit.annualGrowthRate,
    fittedPoints: fit.fittedPoints,
    elapsedYears,
    pointCount: inputs.length,
    rSquared,
    rmse,
    meanAbsoluteResidual,
    currentLogResidual,
    currentDeviation: Math.abs(currentLogResidual),
    fairValueByDate,
  };
}

function buildCandidate(points, timeframe, allElapsedYears) {
  const windowPoints = filterPointsForTimeframe(points, timeframe);
  if (windowPoints.length < 12) {
    return { ...timeframe, available: false, reason: 'Not enough data' };
  }
  const elapsedYears =
    (windowPoints[windowPoints.length - 1].dateValue - windowPoints[0].dateValue) / MS_PER_DAY / DAYS_PER_YEAR;
  if (!Number.isFinite(elapsedYears) || elapsedYears < 0.1) {
    return { ...timeframe, available: false, reason: 'Not enough data' };
  }
  if (timeframe.years && allElapsedYears < Math.max(0.5, timeframe.years * 0.55)) {
    return { ...timeframe, available: false, reason: 'Not enough history' };
  }
  const fit = buildExponentialGrowthFit(
    windowPoints.map((point) => ({
      date: point.date,
      totalPnl: point.price,
    }))
  );
  const fitDiagnostics = buildFitDiagnostics(windowPoints, fit, elapsedYears);
  if (!fitDiagnostics) {
    return { ...timeframe, available: false, reason: 'No fit' };
  }
  const shortWindowPenalty =
    timeframe.years && allElapsedYears > 0
      ? Math.max(0, Math.log2(Math.max(1, allElapsedYears / Math.max(fitDiagnostics.elapsedYears, 0.25)))) * 0.045
      : 0;
  const smallSamplePenalty = Math.max(0, (80 - fitDiagnostics.pointCount) / 80) * 0.08;
  const errorPenalty = Math.min(1, fitDiagnostics.rmse) * 0.55;
  const currentPenalty = Math.min(1, fitDiagnostics.currentDeviation) * 0.35;
  const score = fitDiagnostics.rSquared - errorPenalty - currentPenalty - shortWindowPenalty - smallSamplePenalty;
  return {
    ...timeframe,
    available: true,
    points: windowPoints,
    fit: fitDiagnostics,
    score,
  };
}

function buildGrowthAnalysis(rawPoints) {
  const points = normalizePricePoints(rawPoints);
  if (points.length < 2) {
    return null;
  }
  const allElapsedYears =
    (points[points.length - 1].dateValue - points[0].dateValue) / MS_PER_DAY / DAYS_PER_YEAR;
  const candidates = TIMEFRAMES.map((timeframe) => buildCandidate(points, timeframe, allElapsedYears));
  const available = candidates.filter((candidate) => candidate.available);
  if (!available.length) {
    return { points, candidates, best: null, byKey: new Map(candidates.map((candidate) => [candidate.key, candidate])) };
  }
  const best = available.reduce((currentBest, candidate) => {
    if (!currentBest) {
      return candidate;
    }
    const delta = candidate.score - currentBest.score;
    if (delta > 0.015) {
      return candidate;
    }
    if (Math.abs(delta) <= 0.015 && candidate.fit.elapsedYears > currentBest.fit.elapsedYears) {
      return candidate;
    }
    return currentBest;
  }, null);
  return {
    points,
    candidates,
    best,
    byKey: new Map(candidates.map((candidate) => [candidate.key, candidate])),
  };
}

function downsample(points, maxPoints = MAX_CHART_POINTS) {
  if (!Array.isArray(points) || points.length <= maxPoints) {
    return Array.isArray(points) ? points : [];
  }
  const step = Math.ceil(points.length / maxPoints);
  const sampled = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) {
    sampled.push(last);
  }
  return sampled;
}

function fittedValueForPoint(point, fit) {
  if (!point || !fit) {
    return null;
  }
  const value = fit.fairValueByDate?.get(point.date);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function pathFromPoints(points) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
}

function buildChartData(candidate) {
  if (!candidate?.available || !Array.isArray(candidate.points) || !candidate.fit) {
    return null;
  }
  const sampledPoints = downsample(candidate.points);
  const modeledPoints = sampledPoints
    .map((point) => {
      const fairPrice = fittedValueForPoint(point, candidate.fit);
      const temperature =
        Number.isFinite(point.price) && Number.isFinite(fairPrice) && fairPrice > 0
          ? point.price / fairPrice
          : null;
      return {
        ...point,
        fairPrice,
        temperature,
      };
    })
    .filter((point) => Number.isFinite(point.price));
  const series = modeledPoints.map((point) => ({
    date: point.date,
    totalPnl: point.price,
    priceActualValue: point.price,
    priceFairValue: point.fairPrice,
    priceTemperature: point.temperature,
  }));
  const fittedValues = modeledPoints.map((point) => point.fairPrice);
  const referenceValues = modeledPoints.flatMap((point) =>
    TEMPERATURE_REFERENCE_VALUES.map((temperature) =>
      Number.isFinite(point.fairPrice) ? point.fairPrice * temperature : null
    )
  );
  const metrics = buildChartMetrics(series, {
    rangeStartDate: candidate.points[0]?.date,
    rangeEndDate: candidate.points[candidate.points.length - 1]?.date,
    extraDomainValues: [...fittedValues, ...referenceValues].filter(Number.isFinite),
    minimumValuePadding: 0,
  });
  if (!metrics?.points?.length) {
    return null;
  }
  const fitPoints = metrics.points
    .map((point, index) => {
      const fittedValue = fittedValues[index];
      if (!Number.isFinite(fittedValue)) {
        return null;
      }
      return {
        x: point.x,
        y: metrics.yFor(fittedValue),
      };
    })
    .filter(Boolean);
  const referenceCurves = TEMPERATURE_REFERENCE_VALUES
    .map((temperature) => {
      const referencePoints = metrics.points
        .map((point, index) => {
          const fairPrice = fittedValues[index];
          const referenceValue = Number.isFinite(fairPrice) ? fairPrice * temperature : null;
          if (!Number.isFinite(point?.x) || !Number.isFinite(referenceValue)) {
            return null;
          }
          return {
            x: point.x,
            y: metrics.yFor(referenceValue),
            temperature,
          };
        })
        .filter(Boolean);
      if (referencePoints.length < 2) {
        return null;
      }
      return {
        temperature,
        path: pathFromPoints(referencePoints),
      };
    })
    .filter(Boolean);
  return {
    metrics,
    actualPath: pathFromPoints(metrics.points),
    fitPath: pathFromPoints(fitPoints),
    referenceCurves,
    marker: metrics.points[metrics.points.length - 1] || null,
  };
}

function interpolateValue(lowerValue, upperValue, ratio) {
  const lowerFinite = Number.isFinite(lowerValue);
  const upperFinite = Number.isFinite(upperValue);
  if (!lowerFinite && !upperFinite) {
    return undefined;
  }
  if (!lowerFinite) {
    return upperValue;
  }
  if (!upperFinite) {
    return lowerValue;
  }
  return lowerValue + (upperValue - lowerValue) * ratio;
}

function resolvePointAtX(metrics, x) {
  if (!metrics || !Number.isFinite(x) || !Array.isArray(metrics.points) || !metrics.points.length) {
    return null;
  }
  const clampedX = Math.max(PADDING.left, Math.min(CHART_WIDTH - PADDING.right, x));
  const points = metrics.points;
  if (points.length === 1) {
    return points[0];
  }
  let upperIndex = points.findIndex((point) => Number.isFinite(point?.x) && point.x >= clampedX);
  if (upperIndex < 0) {
    upperIndex = points.length - 1;
  }
  let lowerIndex = Math.max(0, upperIndex - 1);
  if (
    upperIndex === lowerIndex &&
    upperIndex + 1 < points.length &&
    Number.isFinite(points[upperIndex].x) &&
    points[upperIndex].x < clampedX
  ) {
    lowerIndex = upperIndex;
    upperIndex += 1;
  }
  const lower = points[lowerIndex];
  const upper = points[upperIndex];
  if (!lower && !upper) {
    return null;
  }
  if (!lower) {
    return upper;
  }
  if (!upper) {
    return lower;
  }
  const lowerX = Number.isFinite(lower.x) ? lower.x : clampedX;
  const upperX = Number.isFinite(upper.x) ? upper.x : clampedX;
  const span = upperX - lowerX;
  const ratio = span !== 0 ? Math.max(0, Math.min(1, (clampedX - lowerX) / span)) : 0;
  const priceActualValue = interpolateValue(lower.priceActualValue, upper.priceActualValue, ratio);
  const priceFairValue = interpolateValue(lower.priceFairValue, upper.priceFairValue, ratio);
  const priceTemperature = interpolateValue(lower.priceTemperature, upper.priceTemperature, ratio);
  const chartValue = interpolateValue(lower.chartValue, upper.chartValue, ratio);
  const y =
    Number.isFinite(lower.y) && Number.isFinite(upper.y)
      ? lower.y + (upper.y - lower.y) * ratio
      : Number.isFinite(lower.y)
        ? lower.y
        : upper.y;
  return {
    date: ratio < 0.5 ? lower.date : upper.date,
    totalPnl: chartValue,
    chartValue,
    priceActualValue,
    priceFairValue,
    priceTemperature,
    x: lowerX + (upperX - lowerX) * ratio,
    y,
  };
}

function buildChartLabelStyle(point) {
  if (!point) {
    return null;
  }
  const leftPercent = Math.min(94, Math.max(6, (point.x / CHART_WIDTH) * 100));
  const adjustedY = Math.min(
    CHART_HEIGHT - PADDING.bottom,
    Math.max(PADDING.top, point.y - 24)
  );
  const topPercent = Math.min(92, Math.max(8, (adjustedY / CHART_HEIGHT) * 100));
  const transform =
    leftPercent > 78
      ? 'translate(-100%, -100%)'
      : leftPercent < 22
        ? 'translate(0, -100%)'
        : 'translate(-50%, -100%)';
  return { left: `${leftPercent}%`, top: `${topPercent}%`, transform };
}

function formatTemperature(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `T = ${formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function buildTickerLogoUrl(symbol) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const publishableKey =
    import.meta && import.meta.env && import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY
      ? import.meta.env.VITE_LOGO_DEV_PUBLISHABLE_KEY
      : null;
  if (!normalizedSymbol || !publishableKey) {
    return null;
  }
  const base = 'https://img.logo.dev/ticker';
  return `${base}/${encodeURIComponent(normalizedSymbol)}?token=${encodeURIComponent(publishableKey)}&size=64&format=png`;
}

function formatQuoteMoney(value, currency, digitOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 }) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return formatMoney(value, digitOptions);
  }
  const formatted = formatMoney(numeric, digitOptions);
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatAxisPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  const abs = Math.abs(numeric);
  if (abs >= 1000) {
    return formatMoney(numeric, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  if (abs >= 100) {
    return formatMoney(numeric, { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  }
  if (abs >= 10) {
    return formatMoney(numeric, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  return formatMoney(numeric, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function formatMarketCap(value, currency) {
  const marketCap = coercePositiveNumber(value);
  if (marketCap === null) {
    return null;
  }
  const suffix = currency ? ` ${currency}` : '';
  const magnitudes = [
    { threshold: 1e12, label: 'T' },
    { threshold: 1e9, label: 'B' },
    { threshold: 1e6, label: 'M' },
  ];
  for (const magnitude of magnitudes) {
    if (marketCap >= magnitude.threshold) {
      const scaled = marketCap / magnitude.threshold;
      const digits = scaled >= 100
        ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
        : { minimumFractionDigits: 1, maximumFractionDigits: 1 };
      return `$${formatNumber(scaled, digits)} ${magnitude.label}${suffix}`;
    }
  }
  return formatQuoteMoney(marketCap, currency, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatFitError(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const percent = (Math.exp(Math.abs(value)) - 1) * 100;
  return formatPercent(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function toneForChange(value) {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

function useGrowthCurveRows(symbols) {
  const requestRef = useRef(0);
  const [rows, setRows] = useState({});

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const activeSymbols = Array.isArray(symbols) ? symbols.map(normalizeSymbol).filter(Boolean) : [];
    if (!activeSymbols.length) {
      setRows({});
      return undefined;
    }

    setRows((prev) => {
      const next = {};
      activeSymbols.forEach((symbol) => {
        const previous = prev[symbol] || {};
        next[symbol] = {
          quoteStatus: previous.quote ? 'success' : 'loading',
          quote: previous.quote || null,
          quoteError: null,
          historyStatus: previous.history ? 'success' : 'loading',
          history: previous.history || null,
          historyError: null,
        };
      });
      return next;
    });

    activeSymbols.forEach((symbol) => {
      getQuote(symbol)
        .then((quote) => {
          if (requestRef.current !== requestId) return;
          setRows((prev) => ({
            ...prev,
            [symbol]: {
              ...(prev[symbol] || {}),
              quoteStatus: 'success',
              quote: normalizeQuote(quote),
              quoteError: null,
            },
          }));
        })
        .catch((error) => {
          if (requestRef.current !== requestId) return;
          setRows((prev) => ({
            ...prev,
            [symbol]: {
              ...(prev[symbol] || {}),
              quoteStatus: 'error',
              quoteError: error instanceof Error ? error : new Error('Failed to load quote'),
            },
          }));
        });

      getSymbolPriceHistory(symbol)
        .then((history) => {
          if (requestRef.current !== requestId) return;
          setRows((prev) => ({
            ...prev,
            [symbol]: {
              ...(prev[symbol] || {}),
              historyStatus: 'success',
              history,
              historyError: null,
            },
          }));
        })
        .catch((error) => {
          if (requestRef.current !== requestId) return;
          setRows((prev) => ({
            ...prev,
            [symbol]: {
              ...(prev[symbol] || {}),
              historyStatus: 'error',
              historyError: error instanceof Error ? error : new Error('Failed to load price history'),
            },
          }));
        });
    });

    return undefined;
  }, [symbols]);

  return rows;
}

function GrowthCurvePod({ symbol, description, row, selectedTimeframe, onSelectTimeframe }) {
  const chartRef = useRef(null);
  const [hoverX, setHoverX] = useState(null);
  const [logoFailed, setLogoFailed] = useState(false);
  const analysis = useMemo(() => buildGrowthAnalysis(row?.history?.points), [row?.history?.points]);
  const selectedCandidate = useMemo(() => {
    if (!analysis) {
      return null;
    }
    const requested = selectedTimeframe ? analysis.byKey.get(selectedTimeframe) : null;
    if (requested?.available) {
      return requested;
    }
    return analysis.best;
  }, [analysis, selectedTimeframe]);
  const chartData = useMemo(() => buildChartData(selectedCandidate), [selectedCandidate]);
  useEffect(() => {
    setHoverX(null);
  }, [chartData]);
  const quote = row?.quote || null;
  const currency = quote?.currency || row?.history?.currency || null;
  const displayDescription = quote?.description || description || null;
  const logoUrl = useMemo(() => buildTickerLogoUrl(symbol), [symbol]);
  const logoAlt = displayDescription ? `${displayDescription} logo` : `${symbol} logo`;
  useEffect(() => {
    setLogoFailed(false);
  }, [logoUrl]);
  const changePercent = Number.isFinite(quote?.changePercent) ? quote.changePercent : null;
  const changeTone = changePercent !== null ? toneForChange(changePercent) : 'neutral';
  const marketCap = formatMarketCap(quote?.marketCap, currency);
  const dividendYield = quote?.dividendYieldPercent
    ? formatPercent(quote.dividendYieldPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : null;
  const selectedKey = selectedCandidate?.key || null;
  const fit = selectedCandidate?.fit || null;
  const hoverPoint = useMemo(
    () => (hoverX === null ? null : resolvePointAtX(chartData?.metrics, hoverX)),
    [chartData?.metrics, hoverX]
  );
  const activeChartPoint = hoverPoint || chartData?.marker || null;
  const chartLabelStyle = useMemo(() => buildChartLabelStyle(activeChartPoint), [activeChartPoint]);
  const currentTemperatureLabel = formatTemperature(chartData?.marker?.priceTemperature, 2);
  const activeTemperatureLabel = formatTemperature(activeChartPoint?.priceTemperature, hoverPoint ? 3 : 2);
  const activePriceLabel = Number.isFinite(activeChartPoint?.priceActualValue)
    ? formatQuoteMoney(activeChartPoint.priceActualValue, currency, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : null;
  const activeDateLabel = hoverPoint?.date ? formatDate(hoverPoint.date) : null;
  const currentDeviation = fit ? (Math.exp(fit.currentLogResidual) - 1) * 100 : null;
  const fitLabel = fit
    ? `${formatSignedPercent(fit.annualGrowthRate * 100, 2)} CAGR`
    : null;
  const fitQualityLabel = fit
    ? [
        `R2 ${formatNumber(Math.max(0, Math.min(1, fit.rSquared)), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        `error ${formatFitError(fit.rmse)}`,
        Number.isFinite(currentDeviation)
          ? `now ${formatSignedPercent(currentDeviation, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
          : null,
      ].filter(Boolean).join(' | ')
    : null;
  const rangeLabel = selectedCandidate?.available && selectedCandidate.points?.length
    ? `${formatDate(selectedCandidate.points[0].date)} - ${formatDate(selectedCandidate.points[selectedCandidate.points.length - 1].date)}`
    : null;
  const quoteMessage = (() => {
    if (row?.quoteStatus === 'loading' && !quote) {
      return 'Loading quote...';
    }
    if (row?.quoteStatus === 'error' && !quote) {
      return row.quoteError?.message || 'Quote unavailable.';
    }
    return null;
  })();
  const chartMessage = (() => {
    if (row?.historyStatus === 'loading' && !row?.history) {
      return 'Loading chart...';
    }
    if (row?.historyStatus === 'error' && !chartData) {
      return row.historyError?.message || 'Price history unavailable.';
    }
    if (row?.historyStatus === 'success' && !chartData) {
      return 'No fit-ready price history.';
    }
    return null;
  })();
  const handleMouseMove = useCallback(
    (event) => {
      if (!chartData?.metrics || !chartRef.current) {
        return;
      }
      const rect = chartRef.current.getBoundingClientRect();
      if (!rect.width) {
        return;
      }
      const scaleX = CHART_WIDTH / rect.width;
      setHoverX((event.clientX - rect.left) * scaleX);
    },
    [chartData?.metrics]
  );
  const handleMouseLeave = useCallback(() => {
    setHoverX(null);
  }, []);

  return (
    <article className="growth-curve-pod">
      <div className="growth-curve-pod__header">
        <div className="growth-curve-pod__identity">
          <span className="symbol-view__icon growth-curve-pod__icon" aria-hidden="true">
            {logoUrl && !logoFailed ? (
              <img
                className="symbol-view__icon-image"
                src={logoUrl}
                alt={logoAlt}
                width={30}
                height={30}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 19V5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M4 19H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M7 15L11 10.5L14 12.5L20 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          <div className="growth-curve-pod__title-wrap">
            <h3 className="growth-curve-pod__title">{symbol}</h3>
            {displayDescription ? <div className="growth-curve-pod__subtitle">{displayDescription}</div> : null}
          </div>
        </div>
        {fitLabel ? (
          <div className="growth-curve-pod__fit-badge">
            <span>{selectedCandidate?.shortLabel || selectedCandidate?.label}</span>
            <strong>{fitLabel}</strong>
            {currentTemperatureLabel ? <span>{currentTemperatureLabel}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="symbol-view__details growth-curve-pod__details">
        {quoteMessage ? (
          <span className="symbol-view__detail symbol-view__detail--message">{quoteMessage}</span>
        ) : (
          <>
            <span className="symbol-view__detail symbol-view__detail--price">
              <span className="symbol-view__detail-price">
                {formatQuoteMoney(quote?.price, currency, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {changePercent !== null ? (
                <span className={`symbol-view__detail-change symbol-view__detail-change--${changeTone}`}>
                  ({formatSignedPercent(changePercent, 2)})
                </span>
              ) : null}
            </span>
            {quote?.peRatio ? (
              <span className="symbol-view__detail">
                <span className="symbol-view__detail-label">P/E</span>
                <span className="symbol-view__detail-value">
                  {formatNumber(quote.peRatio, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                </span>
              </span>
            ) : null}
            {quote?.pegRatio ? (
              <span className="symbol-view__detail">
                <span className="symbol-view__detail-label">PEG</span>
                <span className="symbol-view__detail-value">
                  {formatNumber(quote.pegRatio, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </span>
            ) : null}
            {marketCap ? (
              <span className="symbol-view__detail">
                <span className="symbol-view__detail-label">Market cap</span>
                <span className="symbol-view__detail-value">{marketCap}</span>
              </span>
            ) : null}
            {dividendYield ? (
              <span className="symbol-view__detail">
                <span className="symbol-view__detail-label">Dividend yield</span>
                <span className="symbol-view__detail-value">{dividendYield}</span>
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="growth-curve-pod__timeframes" role="group" aria-label={`${symbol} growth curve timeframe`}>
        {TIMEFRAMES.map((timeframe) => {
          const candidate = analysis?.byKey?.get(timeframe.key);
          const disabled = !candidate?.available;
          const active = selectedKey === timeframe.key;
          return (
            <button
              key={timeframe.key}
              type="button"
              className={active ? 'active' : ''}
              disabled={disabled}
              aria-pressed={active}
              title={candidate?.reason || timeframe.label}
              onClick={() => onSelectTimeframe(symbol, timeframe.key)}
            >
              {timeframe.shortLabel}
            </button>
          );
        })}
      </div>

      <div className="growth-curve-pod__chart-wrap">
        {chartMessage ? (
          <div className="growth-curve-pod__chart-message" role="status" aria-live="polite">
            {chartMessage}
          </div>
        ) : chartData ? (
          <>
            <svg
              ref={chartRef}
              className="growth-curve-pod__chart qqq-section__chart pnl-dialog__chart"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="img"
              aria-label={`${symbol} price chart with growth curve`}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              {chartData.metrics.axisTicks.map((tick) => (
                <g key={tick}>
                  <line
                    className="qqq-section__line qqq-section__line--guide"
                    x1={PADDING.left}
                    x2={CHART_WIDTH - PADDING.right}
                    y1={chartData.metrics.yFor(tick)}
                    y2={chartData.metrics.yFor(tick)}
                    strokeDasharray="2 4"
                  />
                  <text
                    x={CHART_WIDTH - PADDING.right + 8}
                    y={chartData.metrics.yFor(tick) + 3}
                    className="pnl-dialog__axis-label"
                    textAnchor="start"
                  >
                    {formatAxisPrice(tick)}
                  </text>
                </g>
              ))}
              {chartData.referenceCurves?.map((referenceCurve) => (
                <path
                  key={referenceCurve.temperature}
                  className="qqq-section__temperature-reference-path"
                  d={referenceCurve.path}
                />
              ))}
              {chartData.actualPath ? <path className="qqq-section__series-path" d={chartData.actualPath} /> : null}
              {chartData.fitPath ? <path className="qqq-section__growth-curve-path" d={chartData.fitPath} /> : null}
              {hoverPoint ? (
                <>
                  <line
                    className="pnl-dialog__hover-line"
                    x1={hoverPoint.x}
                    x2={hoverPoint.x}
                    y1={hoverPoint.y}
                    y2={CHART_HEIGHT - PADDING.bottom}
                  />
                  <circle className="pnl-dialog__hover-marker" cx={hoverPoint.x} cy={hoverPoint.y} r="6" />
                </>
              ) : null}
              {activeChartPoint ? (
                <circle className="qqq-section__marker" cx={activeChartPoint.x} cy={activeChartPoint.y} r="5" />
              ) : null}
            </svg>
            {activeTemperatureLabel && chartLabelStyle ? (
              <div className="qqq-section__chart-label growth-curve-pod__chart-label" style={chartLabelStyle}>
                {activePriceLabel ? <span className="pnl-dialog__label-amount">{activePriceLabel}</span> : null}
                <span className="pnl-dialog__label-amount">{activeTemperatureLabel}</span>
                {activeDateLabel ? <span className="pnl-dialog__label-date">{activeDateLabel}</span> : null}
              </div>
            ) : null}
            <div className="growth-curve-pod__fit-summary">
              <span>{rangeLabel}</span>
              {fitQualityLabel ? <strong>{fitQualityLabel}</strong> : null}
            </div>
          </>
        ) : null}
      </div>
    </article>
  );
}

GrowthCurvePod.propTypes = {
  symbol: PropTypes.string.isRequired,
  description: PropTypes.string,
  row: PropTypes.shape({
    quoteStatus: PropTypes.string,
    quote: PropTypes.object,
    quoteError: PropTypes.instanceOf(Error),
    historyStatus: PropTypes.string,
    history: PropTypes.object,
    historyError: PropTypes.instanceOf(Error),
  }),
  selectedTimeframe: PropTypes.string,
  onSelectTimeframe: PropTypes.func.isRequired,
};

GrowthCurvePod.defaultProps = {
  description: null,
  row: null,
  selectedTimeframe: null,
};

export default function GrowthCurvesPanel({ symbols, descriptions, onClear }) {
  const normalizedSymbols = useMemo(() => {
    const seen = new Set();
    return (Array.isArray(symbols) ? symbols : [])
      .map(normalizeSymbol)
      .filter((symbol) => {
        if (!symbol || seen.has(symbol)) {
          return false;
        }
        seen.add(symbol);
        return true;
      });
  }, [symbols]);
  const rows = useGrowthCurveRows(normalizedSymbols);
  const [selectedTimeframes, setSelectedTimeframes] = useState({});
  const symbolsKey = normalizedSymbols.join('|');

  useEffect(() => {
    setSelectedTimeframes({});
  }, [symbolsKey]);

  const handleSelectTimeframe = (symbol, timeframe) => {
    setSelectedTimeframes((prev) => ({
      ...prev,
      [normalizeSymbol(symbol)]: timeframe,
    }));
  };

  if (!normalizedSymbols.length) {
    return null;
  }

  return (
    <section className="growth-curves" aria-label="Growth curves">
      <div className="growth-curves__header">
        <div>
          <h2 className="growth-curves__title">Growth curves</h2>
          <div className="growth-curves__subtitle">{normalizedSymbols.join(' + ')}</div>
        </div>
        {onClear ? (
          <button type="button" className="symbol-view__clear growth-curves__clear" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="growth-curves__grid">
        {normalizedSymbols.map((symbol) => (
          <GrowthCurvePod
            key={symbol}
            symbol={symbol}
            description={descriptions?.[symbol] || null}
            row={rows[symbol] || null}
            selectedTimeframe={selectedTimeframes[symbol] || null}
            onSelectTimeframe={handleSelectTimeframe}
          />
        ))}
      </div>
    </section>
  );
}

GrowthCurvesPanel.propTypes = {
  symbols: PropTypes.arrayOf(PropTypes.string),
  descriptions: PropTypes.objectOf(PropTypes.string),
  onClear: PropTypes.func,
};

GrowthCurvesPanel.defaultProps = {
  symbols: [],
  descriptions: {},
  onClear: null,
};
