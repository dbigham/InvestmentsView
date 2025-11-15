import { parseDateOnly } from '../../../shared/totalPnlDisplay.js';
import { classifyPnL, formatDate, formatSignedMoney } from '../utils/formatters';

export const CHART_WIDTH = 782;
export const CHART_HEIGHT = 260;
export const PADDING = { top: 6, right: 48, bottom: 30, left: 0 };
const AXIS_TARGET_INTERVALS = 4;

export function clampChartX(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(PADDING.left, Math.min(CHART_WIDTH - PADDING.right, value));
}

function niceNumber(value, round) {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const fraction = Math.abs(value) / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) {
      niceFraction = 1;
    } else if (fraction < 3) {
      niceFraction = 2;
    } else if (fraction < 7) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
  } else if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  return Math.sign(value) * niceFraction * 10 ** exponent;
}

export function buildAxisScale(minDomain, maxDomain) {
  if (!Number.isFinite(minDomain) || !Number.isFinite(maxDomain)) {
    return { minDomain, maxDomain, tickSpacing: 0, ticks: [] };
  }
  const rawRange = maxDomain - minDomain;
  if (rawRange === 0) {
    return { minDomain, maxDomain, tickSpacing: 0, ticks: [minDomain] };
  }
  const niceRange = niceNumber(rawRange, false) || rawRange;
  const spacing = niceNumber(niceRange / AXIS_TARGET_INTERVALS, true) || rawRange / AXIS_TARGET_INTERVALS;
  const niceMin = Math.floor(minDomain / spacing) * spacing;
  const niceMax = Math.ceil(maxDomain / spacing) * spacing;
  const ticks = [];
  for (let value = niceMin; value <= niceMax + spacing * 0.5; value += spacing) {
    const rounded = Math.abs(value) < spacing * 1e-6 ? 0 : Number(value.toFixed(6));
    if (!ticks.length || Math.abs(ticks[ticks.length - 1] - rounded) > spacing * 1e-6) {
      ticks.push(rounded);
    }
  }
  return {
    minDomain: niceMin,
    maxDomain: niceMax,
    tickSpacing: spacing,
    ticks,
  };
}

export function normalizeDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = parseDateOnly(value);
  if (parsed) {
    return parsed;
  }
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function toPlainDateString(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function buildChartMetrics(series, { useDisplayStartDelta = false, rangeStartDate, rangeEndDate } = {}) {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }
  const resolveValue = (entry) => {
    if (!entry) {
      return null;
    }
    if (useDisplayStartDelta && Number.isFinite(entry.totalPnlDelta)) {
      return entry.totalPnlDelta;
    }
    return entry.totalPnl;
  };

  const rawValues = series.map((entry) => resolveValue(entry));
  const finiteValues = rawValues.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  const parsedDates = series.map((entry) => normalizeDate(entry?.date));
  const finiteDates = parsedDates.filter((date) => date instanceof Date && !Number.isNaN(date.getTime()));

  let resolvedRangeStartDate = normalizeDate(rangeStartDate);
  let resolvedRangeEndDate = normalizeDate(rangeEndDate);

  if (!resolvedRangeStartDate && finiteDates.length) {
    resolvedRangeStartDate = new Date(Math.min(...finiteDates.map((date) => date.getTime())));
  }
  if (!resolvedRangeEndDate && finiteDates.length) {
    resolvedRangeEndDate = new Date(Math.max(...finiteDates.map((date) => date.getTime())));
  }
  if (!resolvedRangeStartDate && resolvedRangeEndDate) {
    resolvedRangeStartDate = new Date(resolvedRangeEndDate.getTime());
  }
  if (resolvedRangeStartDate && !resolvedRangeEndDate) {
    resolvedRangeEndDate = new Date(resolvedRangeStartDate.getTime());
  }

  if (
    resolvedRangeStartDate &&
    resolvedRangeEndDate &&
    resolvedRangeStartDate.getTime() > resolvedRangeEndDate.getTime()
  ) {
    resolvedRangeEndDate = new Date(resolvedRangeStartDate.getTime());
  }

  const domainDuration =
    resolvedRangeStartDate && resolvedRangeEndDate
      ? Math.max(0, resolvedRangeEndDate.getTime() - resolvedRangeStartDate.getTime())
      : 0;

  const minValue = Math.min(...finiteValues);
  const maxValue = Math.max(...finiteValues);
  const range = maxValue - minValue;
  const padding = range === 0 ? Math.max(10, Math.abs(maxValue) * 0.1 || 10) : Math.max(10, range * 0.1);
  let rawMinDomain = minValue - padding;
  let rawMaxDomain = maxValue + padding;
  if (minValue >= 0 && rawMinDomain < 0) {
    rawMinDomain = 0;
  }
  if (maxValue <= 0 && rawMaxDomain > 0) {
    rawMaxDomain = 0;
  }
  const axisScale = buildAxisScale(rawMinDomain, rawMaxDomain);
  let minDomain = axisScale.minDomain;
  let maxDomain = axisScale.maxDomain;
  const spacing = Number.isFinite(axisScale.tickSpacing) && axisScale.tickSpacing > 0
    ? axisScale.tickSpacing
    : axisScale.ticks.length > 1
      ? Math.abs(axisScale.ticks[1] - axisScale.ticks[0])
      : 0;
  if (minDomain < rawMinDomain) {
    minDomain = rawMinDomain;
  }
  if (maxDomain > rawMaxDomain) {
    maxDomain = rawMaxDomain;
  }
  if (maxDomain <= minDomain) {
    maxDomain = minDomain + 1;
  }
  let axisTicks = axisScale.ticks.slice();
  if (spacing > 0) {
    axisTicks = axisTicks.filter(
      (value) => value >= minDomain - spacing * 0.25 && value <= maxDomain + spacing * 0.25
    );
  }
  if (!axisTicks.length) {
    axisTicks = [minDomain, maxDomain];
  }
  const domainRange = maxDomain - minDomain || 1;
  const innerWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

  const points = series.map((entry, index) => {
    const totalValue = resolveValue(entry);
    const safeValue = Number.isFinite(totalValue) ? totalValue : 0;
    let ratio;
    const entryDate = parsedDates[index];
    if (resolvedRangeStartDate && resolvedRangeEndDate && domainDuration > 0 && entryDate) {
      ratio = (entryDate.getTime() - resolvedRangeStartDate.getTime()) / domainDuration;
    } else if (series.length === 1) {
      ratio = 0;
    } else {
      ratio = index / (series.length - 1);
    }
    const clampedRatio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
    const normalized = (safeValue - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    const y = PADDING.top + innerHeight * (1 - clamped);
    const previousValue = index > 0 ? resolveValue(series[index - 1]) : totalValue;
    const safePrevious = Number.isFinite(previousValue) ? previousValue : safeValue;
    const trend = safeValue - safePrevious;
    return { ...entry, x: PADDING.left + innerWidth * clampedRatio, y, trend, chartValue: safeValue };
  });

  const yFor = (value) => {
    const normalized = (value - minDomain) / domainRange;
    const clamped = Math.max(0, Math.min(1, normalized));
    return PADDING.top + innerHeight * (1 - clamped);
  };

  return {
    points,
    yFor,
    rangeStart: toPlainDateString(resolvedRangeStartDate) ?? series[0].date,
    rangeEnd: toPlainDateString(resolvedRangeEndDate) ?? series[series.length - 1].date,
    minDomain,
    maxDomain,
    domainRange,
    innerWidth,
    innerHeight,
    axisTicks,
  };
}

// Shared helper for building a hover label that matches dialog styling
export function buildHoverLabel(point, { useDisplayStartDelta = false } = {}) {
  if (!point) {
    return null;
  }
  let value = null;
  if (useDisplayStartDelta && Number.isFinite(point?.chartValue)) {
    value = point.chartValue;
  } else if (Number.isFinite(point?.totalPnl)) {
    value = point.totalPnl;
  } else if (Number.isFinite(point?.chartValue)) {
    value = point.chartValue;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const tone = classifyPnL(value);
  return {
    amount: formatSignedMoney(value),
    date: point?.date ? formatDate(point.date) : null,
    tone,
  };
}
