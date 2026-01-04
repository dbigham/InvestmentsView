const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.cache', 'yahoo-price-cache');
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const symbolCache = new Map();

function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string') {
    return null;
  }
  const trimmed = symbol.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toUpperCase();
}

function normalizeDateKey(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'date')) {
      return normalizeDateKey(value.date);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return normalizeDateKey(value.value);
    }
  }
  return null;
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysToKey(dateKey, days) {
  const parsed = normalizeDateKey(dateKey);
  if (!parsed) {
    return null;
  }
  const date = new Date(`${parsed}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Date(date.getTime() + days * DAY_IN_MS).toISOString().slice(0, 10);
}

function sanitizeSymbolForFilename(symbolKey) {
  const safe = typeof symbolKey === 'string' ? symbolKey.replace(/[^A-Z0-9_.-]/gi, '_') : '';
  return safe || 'symbol';
}

function getSymbolCacheFilePath(symbolKey) {
  return path.join(CACHE_DIR, `${sanitizeSymbolForFilename(symbolKey)}.json`);
}

function normalizeRanges(ranges) {
  if (!Array.isArray(ranges)) {
    return [];
  }
  const cleaned = ranges
    .map((range) => {
      if (!range || typeof range !== 'object') {
        return null;
      }
      const start = normalizeDateKey(range.start);
      const end = normalizeDateKey(range.end);
      if (!start || !end || start > end) {
        return null;
      }
      return { start, end };
    })
    .filter(Boolean)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  if (!cleaned.length) {
    return [];
  }

  const merged = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i += 1) {
    const current = cleaned[i];
    const last = merged[merged.length - 1];
    const adjacent = addDaysToKey(last.end, 1);
    if (current.start <= last.end || (adjacent && current.start <= adjacent)) {
      if (current.end > last.end) {
        last.end = current.end;
      }
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

function loadSymbolCache(symbol) {
  const symbolKey = normalizeSymbol(symbol);
  if (!symbolKey) {
    return null;
  }
  if (symbolCache.has(symbolKey)) {
    return symbolCache.get(symbolKey);
  }
  const cache = {
    symbolKey,
    prices: new Map(),
    ranges: [],
    dirty: false,
  };
  const filePath = getSymbolCacheFilePath(symbolKey);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const prices = parsed.prices && typeof parsed.prices === 'object' ? parsed.prices : null;
          if (prices) {
            Object.entries(prices).forEach(([dateKey, value]) => {
              const normalizedDate = normalizeDateKey(dateKey);
              const price = Number(value);
              if (normalizedDate && Number.isFinite(price) && price > 0) {
                cache.prices.set(normalizedDate, price);
              }
            });
          }
          cache.ranges = normalizeRanges(parsed.ranges);
        }
      }
    }
  } catch (_) {
    // ignore cache read errors
  }
  symbolCache.set(symbolKey, cache);
  return cache;
}

function persistSymbolCache(cache) {
  if (!cache || !cache.dirty) {
    return;
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const prices = {};
    Array.from(cache.prices.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .forEach(([dateKey, price]) => {
        prices[dateKey] = price;
      });
    const payload = {
      symbol: cache.symbolKey,
      updatedAt: new Date().toISOString(),
      ranges: cache.ranges,
      prices,
    };
    fs.writeFileSync(getSymbolCacheFilePath(cache.symbolKey), JSON.stringify(payload, null, 2), 'utf-8');
    cache.dirty = false;
  } catch (_) {
    // ignore cache write errors
  }
}

function cacheYahooPriceSeries(symbol, startKey, endKey, entries) {
  const cache = loadSymbolCache(symbol);
  if (!cache) {
    return;
  }
  const normalizedStart = normalizeDateKey(startKey);
  const normalizedEnd = normalizeDateKey(endKey);
  const todayKey = getTodayKey();
  let effectiveStart = normalizedStart;
  let effectiveEnd = normalizedEnd;

  if (effectiveEnd && todayKey && effectiveEnd >= todayKey) {
    effectiveEnd = addDaysToKey(todayKey, -1);
  }
  if (effectiveStart && todayKey && effectiveStart === todayKey) {
    effectiveStart = null;
  }

  let updated = false;
  if (Array.isArray(entries)) {
    entries.forEach((entry) => {
      if (!entry) {
        return;
      }
      const dateKey = normalizeDateKey(entry.dateKey || entry.date);
      const price = Number(entry.price ?? entry.close ?? entry.value);
      if (!dateKey || dateKey === todayKey) {
        return;
      }
      if (!Number.isFinite(price) || price <= 0) {
        return;
      }
      if (!cache.prices.has(dateKey) || cache.prices.get(dateKey) !== price) {
        cache.prices.set(dateKey, price);
        updated = true;
      }
    });
  }

  if (effectiveStart && effectiveEnd && effectiveStart <= effectiveEnd) {
    cache.ranges = normalizeRanges([...cache.ranges, { start: effectiveStart, end: effectiveEnd }]);
    updated = true;
  }

  if (updated) {
    cache.dirty = true;
    persistSymbolCache(cache);
  }
}

function getCachedYahooPriceSeries(symbol, startKey, endKey) {
  const cache = loadSymbolCache(symbol);
  if (!cache) {
    return { hit: false };
  }
  const normalizedStart = normalizeDateKey(startKey);
  const normalizedEnd = normalizeDateKey(endKey);
  if (!normalizedStart || !normalizedEnd || normalizedStart > normalizedEnd) {
    return { hit: false };
  }
  const covered = cache.ranges.some((range) => range.start <= normalizedStart && range.end >= normalizedEnd);
  if (!covered) {
    return { hit: false };
  }
  const values = [];
  cache.prices.forEach((price, dateKey) => {
    if (dateKey >= normalizedStart && dateKey <= normalizedEnd) {
      const date = new Date(`${dateKey}T00:00:00Z`);
      if (!Number.isNaN(date.getTime())) {
        values.push({ date, price });
      }
    }
  });
  values.sort((a, b) => a.date - b.date);
  if (!values.length) {
    return { hit: false };
  }
  return { hit: true, value: values };
}

module.exports = {
  cacheYahooPriceSeries,
  getCachedYahooPriceSeries,
};
