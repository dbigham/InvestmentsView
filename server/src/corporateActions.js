const fs = require('fs');
const path = require('path');

const dateKey = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
};

function normalizeSplitHistory(payload) {
  const result = payload?.chart?.result?.[0];
  const splits = Object.values(result?.events?.splits || {}).map((event) => ({
    date: dateKey(Number(event.date) * 1000),
    ratio: Number(event.numerator) / Number(event.denominator),
  })).filter((event) => event.date && Number.isFinite(event.ratio) && event.ratio > 0 && event.ratio !== 1);
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const prices = (result?.timestamp || []).map((timestamp, index) => {
    const date = dateKey(timestamp * 1000);
    // Yahoo's close (not just adjclose) is retroactively split-adjusted.
    // Reconstruct the price actually quoted alongside that day's share count.
    const factor = splits.reduce((value, event) => date < event.date ? value * event.ratio : value, 1);
    return { date, price: closes[index] == null ? null : Number(closes[index]) * factor };
  }).filter((point) => point.date && Number.isFinite(point.price) && point.price > 0);
  return { splits, prices };
}

function supplementMissingSplits(activities, positions, histories) {
  const supplemental = [];
  for (const position of positions) {
    const symbol = position.symbol;
    const history = histories[symbol];
    if (!history?.splits?.length || !Number.isFinite(position.openQuantity)) continue;
    const symbolActivities = activities.filter((activity) => activity.symbol === symbol);
    const missingSplits = history.splits.filter((event) => !symbolActivities.some((activity) =>
      /split|consolidat/i.test([activity.type, activity.action, activity.description].join(' ')) &&
      Math.abs(new Date(activity.tradeDate || activity.date) - new Date(event.date)) <= 4 * 86400000
    ));
    // Walk backwards from the actual broker holdings, undoing trades and each
    // confirmed split. A split adds shares without a deposit or trade cash flow.
    const timeline = [
      ...symbolActivities.map((activity) => ({
        date: dateKey(activity.tradeDate || activity.date), activity,
      })),
      ...missingSplits.map((event) => ({ ...event, split: true })),
    ].filter((entry) => entry.date).sort((left, right) => right.date.localeCompare(left.date) || Number(left.split || false) - Number(right.split || false));
    let quantity = position.openQuantity;
    for (const entry of timeline) {
      if (entry.split) {
        const addedQuantity = quantity - quantity / entry.ratio;
        quantity /= entry.ratio;
        if (Math.abs(addedQuantity) < 1e-8) continue;
        supplemental.push({
          id: `corporate-split:${symbol}:${entry.date}`,
          symbol, currency: position.currency, quantity: addedQuantity,
          type: 'Stock split', action: 'SPLIT',
          description: `Confirmed ${entry.ratio}:1 stock split`,
          tradeDate: `${entry.date}T00:00:00Z`, date: `${entry.date}T00:00:00Z`,
          netAmount: 0, grossAmount: 0, price: 0,
          source: 'yahoo-corporate-action',
        });
      } else {
        const amount = Number(entry.activity.quantity);
        if (Number.isFinite(amount)) quantity -= amount;
      }
    }
  }
  return [...activities, ...supplemental];
}

function createCorporateActionLoader(fetchHistory, cacheDirectory) {
  const pending = new Map();
  return async function loadCorporateActions(symbol, startDate, endDate) {
    const key = `${symbol}:${startDate}:${endDate}`;
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      const file = path.join(cacheDirectory, `${encodeURIComponent(symbol)}.json`);
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cached.startDate <= startDate && cached.endDate >= endDate &&
            Date.now() - cached.cachedAt < 6 * 3600000) return cached;
      } catch (_) { /* No reusable corporate-action cache. */ }
      const history = await fetchHistory(symbol, startDate, endDate);
      const value = { ...history, startDate, endDate, cachedAt: Date.now() };
      fs.mkdirSync(cacheDirectory, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
      return value;
    })();
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  };
}

function getCorporateActionPrices(activityContext, symbol) {
  const history = activityContext?.corporateActionPriceHistory?.[symbol];
  return Array.isArray(history) && history.length ? history.map((point) =>
    ({ date: new Date(`${point.date}T00:00:00Z`), price: point.price })) : null;
}

module.exports = { normalizeSplitHistory, supplementMissingSplits, createCorporateActionLoader, getCorporateActionPrices };
