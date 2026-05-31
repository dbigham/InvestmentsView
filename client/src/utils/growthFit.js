import { parseDateOnly } from '../../../shared/totalPnlDisplay.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;
const PRICE_GROWTH_FIT_TRIM_STAGES = [
  { high: 1.15, low: 2.5 },
  { high: 0.85, low: 1.9 },
  { high: 0.65, low: 1.6 },
];

export function buildExponentialGrowthFit(series) {
  if (!Array.isArray(series) || series.length < 2) {
    return null;
  }
  const points = series
    .map((entry) => {
      const parsedDate = parseDateOnly(entry?.date);
      const value = Number(entry?.totalPnl);
      if (!parsedDate || !Number.isFinite(value) || value <= 0) {
        return null;
      }
      return { date: entry.date, dateValue: parsedDate.getTime(), value };
    })
    .filter(Boolean);
  if (points.length < 2) {
    return null;
  }
  points.sort((a, b) => a.dateValue - b.dateValue);
  const startTime = points[0].dateValue;
  const fitInputs = points
    .map((point) => ({
      ...point,
      years: (point.dateValue - startTime) / MS_PER_DAY / DAYS_PER_YEAR,
      logValue: Math.log(point.value),
    }))
    .filter((point) => Number.isFinite(point.years) && Number.isFinite(point.logValue));
  if (fitInputs.length < 2 || fitInputs[fitInputs.length - 1].years <= 0) {
    return null;
  }
  const count = fitInputs.length;
  let weightedPoints = fitInputs.map((point) => ({
    ...point,
    baseWeight: 1,
    active: true,
  }));
  const fitWeightedLine = (points) => {
    const sums = points.reduce(
      (acc, point) => {
        if (!point.active) {
          return acc;
        }
        const weight = point.baseWeight;
        return {
          w: acc.w + weight,
          x: acc.x + weight * point.years,
          y: acc.y + weight * point.logValue,
          xx: acc.xx + weight * point.years * point.years,
          xy: acc.xy + weight * point.years * point.logValue,
        };
      },
      { w: 0, x: 0, y: 0, xx: 0, xy: 0 }
    );
    const denominator = sums.w * sums.xx - sums.x * sums.x;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12 || sums.w <= 0) {
      return null;
    }
    const nextSlope = (sums.w * sums.xy - sums.x * sums.y) / denominator;
    const nextIntercept = (sums.y - nextSlope * sums.x) / sums.w;
    if (!Number.isFinite(nextSlope) || !Number.isFinite(nextIntercept)) {
      return null;
    }
    return { slope: nextSlope, intercept: nextIntercept };
  };
  const weightedMedian = (entries) => {
    const normalizedEntries = entries
      .filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.weight > 0)
      .sort((a, b) => a.value - b.value);
    if (!normalizedEntries.length) {
      return null;
    }
    const totalWeight = normalizedEntries.reduce((sum, entry) => sum + entry.weight, 0);
    const midpoint = totalWeight / 2;
    let cumulative = 0;
    for (let index = 0; index < normalizedEntries.length; index += 1) {
      cumulative += normalizedEntries[index].weight;
      if (cumulative >= midpoint) {
        return normalizedEntries[index].value;
      }
    }
    return normalizedEntries[normalizedEntries.length - 1].value;
  };
  let fittedLine = fitWeightedLine(weightedPoints);
  if (!fittedLine) {
    return null;
  }
  for (const trimStage of PRICE_GROWTH_FIT_TRIM_STAGES) {
    const activePoints = weightedPoints.filter((point) => point.active);
    const residualEntries = activePoints.map((point) => ({
      value: Math.abs(point.logValue - (fittedLine.intercept + fittedLine.slope * point.years)),
      weight: point.baseWeight,
    }));
    const medianResidual = weightedMedian(residualEntries);
    const scale = Number.isFinite(medianResidual) ? Math.max(1e-6, medianResidual / 0.6745) : null;
    const highCutoff = Number.isFinite(scale) ? trimStage.high * scale : null;
    const lowCutoff = Number.isFinite(scale) ? trimStage.low * scale : null;
    if (!Number.isFinite(highCutoff) || !Number.isFinite(lowCutoff)) {
      break;
    }
    const nextWeightedPoints = weightedPoints.map((point) => {
      if (!point.active) {
        return point;
      }
      const residual = point.logValue - (fittedLine.intercept + fittedLine.slope * point.years);
      const cutoff = residual > 0 ? highCutoff : lowCutoff;
      return {
        ...point,
        active: Number.isFinite(residual) ? Math.abs(residual) <= cutoff : false,
      };
    });
    const retainedCount = nextWeightedPoints.filter((point) => point.active).length;
    const minimumRetainedCount = Math.min(count, Math.max(6, Math.ceil(count * 0.2)));
    if (retainedCount < minimumRetainedCount) {
      break;
    }
    const nextLine = fitWeightedLine(nextWeightedPoints);
    if (!nextLine) {
      break;
    }
    weightedPoints = nextWeightedPoints;
    fittedLine = nextLine;
  }
  const { slope, intercept } = fittedLine;
  const annualGrowthRate = Math.exp(slope) - 1;
  if (!Number.isFinite(annualGrowthRate)) {
    return null;
  }
  const fittedPoints = fitInputs
    .map((point) => {
      const fittedValue = Math.exp(intercept + slope * point.years);
      if (!Number.isFinite(fittedValue)) {
        return null;
      }
      return {
        date: point.date,
        value: fittedValue,
      };
    })
    .filter(Boolean);
  if (fittedPoints.length < 2) {
    return null;
  }
  return {
    annualGrowthRate,
    fittedPoints,
  };
}
