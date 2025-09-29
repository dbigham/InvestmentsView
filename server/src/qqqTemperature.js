const fs = require('fs');
const path = require('path');

const DATA_FILE_PATH = path.join(__dirname, '..', 'data', 'qqq-temperature.json');

let cachedData = null;
let cachedMarker = null;
let hasLoggedError = false;

function createMarker(stats) {
  if (!stats) {
    return null;
  }
  return String(stats.size) + ':' + String(stats.mtimeMs);
}

function clampFraction(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function loadRawData() {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      cachedData = null;
      cachedMarker = null;
      return null;
    }
    const stats = fs.statSync(DATA_FILE_PATH);
    const marker = createMarker(stats);
    if (marker && marker === cachedMarker && cachedData) {
      return cachedData;
    }
    const content = fs.readFileSync(DATA_FILE_PATH, 'utf-8').replace(/^\uFEFF/, '');
    if (!content.trim()) {
      cachedData = null;
      cachedMarker = marker;
      return null;
    }
    const parsed = JSON.parse(content);
    cachedData = parsed;
    cachedMarker = marker;
    hasLoggedError = false;
    return parsed;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load QQQ temperature data from ' + DATA_FILE_PATH + ':', error.message);
      hasLoggedError = true;
    }
    cachedData = null;
    cachedMarker = null;
    return null;
  }
}

function normalizeDate(value) {
  if (!value && value !== 0) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function sanitizeSeries(rawSeries) {
  if (!Array.isArray(rawSeries)) {
    return [];
  }
  return rawSeries
    .map((entry) => {
      const date = normalizeDate(entry && entry.date);
      const temperature = Number(entry && entry.temperature);
      if (!date || !Number.isFinite(temperature)) {
        return null;
      }
      return { date, temperature };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.date === b.date) {
        return 0;
      }
      return a.date < b.date ? -1 : 1;
    });
}

function computeBaseProportion(temperature) {
  if (!Number.isFinite(temperature)) {
    return null;
  }
  if (temperature >= 1.5) {
    return 0.2;
  }
  if (temperature >= 1) {
    const value = 0.8 - 1.2 * (temperature - 1);
    return Math.min(1, Math.max(0.2, value));
  }
  if (temperature > 0.9) {
    const value = 1 - 2 * (temperature - 0.9);
    return Math.min(1, Math.max(0.2, value));
  }
  return 1;
}

function computeAllocation(temperature) {
  const base = computeBaseProportion(temperature);
  if (base === null) {
    return null;
  }
  const exposure = 3 * base;
  let totalEquity = base;
  let tqqqShare = 0;
  let qqqShare = 0;

  if (exposure <= 1) {
    totalEquity = clampFraction(base * 3);
    qqqShare = totalEquity;
  } else if (base < 0.425) {
    const tqqqProportion = (exposure - 1) / 2;
    const qqqProportion = (3 - exposure) / 2;
    totalEquity = 1;
    tqqqShare = clampFraction(tqqqProportion);
    qqqShare = clampFraction(qqqProportion);
  } else {
    totalEquity = clampFraction(base);
    tqqqShare = totalEquity;
  }

  const tBillsShare = Math.max(0, 1 - totalEquity);

  return {
    temperature,
    baseProportion: base,
    totalEquity,
    tqqq: clampFraction(tqqqShare),
    qqq: clampFraction(qqqShare),
    tBills: clampFraction(tBillsShare),
  };
}

function getQqqTemperatureSummary() {
  const raw = loadRawData();
  if (!raw) {
    return null;
  }
  const series = sanitizeSeries(raw.series);
  if (!series.length) {
    return null;
  }
  const latest = series[series.length - 1];
  const allocation = computeAllocation(latest.temperature);
  const rangeStart = series[0].date;
  const rangeEnd = latest.date;
  const summary = {
    updated: normalizeDate(raw.updated) || rangeEnd,
    rangeStart,
    rangeEnd,
    series,
    latest,
    allocation,
  };
  if (raw.growthCurve && typeof raw.growthCurve === 'object') {
    const growthA = Number(raw.growthCurve.A);
    const growthR = Number(raw.growthCurve.r);
    if (Number.isFinite(growthA) && Number.isFinite(growthR)) {
      summary.growthCurve = { A: growthA, r: growthR };
    }
  }
  return summary;
}

module.exports = {
  getQqqTemperatureSummary,
};
