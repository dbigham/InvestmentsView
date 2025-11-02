// Replicates the client orders table sorting to validate activity order preservation
const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

function sortOrdersLikeClient(orders) {
  const prepared = orders
    .filter((order) => order && (order.creationTime || order.updateTime || order.symbol))
    .map((order, __index) => ({ order, __index }));

  const getTime = (o) => Date.parse(o.creationTime || o.updateTime || 0);
  const getDayKey = (o) => {
    const ts = (o.creationTime || o.updateTime || '').toString();
    return ts ? ts.slice(0, 10) : '';
  };
  const isActivity = (o) => (typeof o.source === 'string' && o.source.toLowerCase() === 'activity');
  const normalizeSymbol = (s) => (typeof s === 'string' ? s.trim().toUpperCase() : '');
  const resolveActivityIndex = (wrap) => {
    const o = wrap.order;
    return Number.isFinite(o.activityIndex) ? o.activityIndex : wrap.__index;
  };

  prepared.sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    const timeA = getTime(ao);
    const timeB = getTime(bo);

    const aTimeValid = !Number.isNaN(timeA);
    const bTimeValid = !Number.isNaN(timeB);

    if (aTimeValid && bTimeValid) {
      if (timeB !== timeA) {
        return timeB - timeA; // Desc by time
      }
      const bothActivity = isActivity(ao) && isActivity(bo);
      if (bothActivity) {
        const dayA = getDayKey(ao);
        const dayB = getDayKey(bo);
        if (dayA && dayB && dayA === dayB) {
          const aIdx = Number.isFinite(ao.activityIndex) ? ao.activityIndex : a.__index;
          const bIdx = Number.isFinite(bo.activityIndex) ? bo.activityIndex : b.__index;
          return bIdx - aIdx; // Desc within day to mirror UI
        }
      }
      return String(bo.symbol || '').localeCompare(String(ao.symbol || ''));
    }

    if (!aTimeValid && !bTimeValid) {
      const bothActivity = isActivity(ao) && isActivity(bo);
      if (bothActivity) {
        const dayA = getDayKey(ao);
        const dayB = getDayKey(bo);
        if (dayA && dayB && dayA === dayB) {
          const aIdx = Number.isFinite(ao.activityIndex) ? ao.activityIndex : a.__index;
          const bIdx = Number.isFinite(bo.activityIndex) ? bo.activityIndex : b.__index;
          return bIdx - aIdx; // Desc within day to mirror UI
        }
      }
      return String(bo.symbol || '').localeCompare(String(ao.symbol || ''));
    }
    if (!aTimeValid) return 1; // unknown times last
    if (!bTimeValid) return -1;
    return 0;
  });

  // Regroup contiguous same-day activity runs by symbol using earliest-occurrence ordering
  const rebuilt = [];
  for (let i = 0; i < prepared.length;) {
    const wrap = prepared[i];
    const o = wrap.order;
    const day = getDayKey(o);
    if (!day || !isActivity(o)) {
      rebuilt.push(wrap);
      i += 1;
      continue;
    }
    let j = i;
    while (j < prepared.length) {
      const next = prepared[j].order;
      if (isActivity(next) && getDayKey(next) === day) {
        j += 1;
      } else {
        break;
      }
    }
    const run = prepared.slice(i, j);
    const buckets = new Map(); // sym -> Array<wrap>
    for (const w of run) {
      const sym = normalizeSymbol(w.order.symbol) || '#NOSYM#';
      const arr = buckets.get(sym) || [];
      arr.push(w);
      buckets.set(sym, arr);
    }
    const entries = Array.from(buckets.entries()).map(([sym, arr]) => {
      const earliest = Math.min(...arr.map((w) => resolveActivityIndex(w)));
      const wraps = arr.slice().sort((a, b) => resolveActivityIndex(b) - resolveActivityIndex(a));
      return { sym, wraps, earliest };
    });
    // Order symbols by earliest occurrence descending so the first symbol of the day ends up last
    entries.sort((a, b) => b.earliest - a.earliest);
    for (const entry of entries) {
      rebuilt.push(...entry.wraps);
    }
    i = j;
  }

  return rebuilt.map((p) => p.order);
}

(async () => {
  const target = process.argv[2] || 'daniel:53384039';
  const filterDay = process.argv[3] || null; // YYYY-MM-DD
  const url = `http://localhost:4000/api/summary?accountId=${encodeURIComponent(target)}`;
  const data = await fetchJson(url);
  const sorted = sortOrdersLikeClient(data.orders || []);
  const act = sorted.filter((o) => o && o.source === 'activity');
  const byDay = new Map();
  for (const o of act) {
    const day = (o.creationTime || o.updateTime || '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(o);
  }
  const dayKeys = Array.from(byDay.keys());
  const sampleDays = filterDay ? dayKeys.filter((d) => d === filterDay) : dayKeys.slice(0, 5);
  for (const day of sampleDays) {
    const rows = byDay.get(day);
    console.log(`Day: ${day} -> ${rows.length}`);
    const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
    for (const r of rows) {
      const price = isFiniteNumber(r.limitPrice)
        ? r.limitPrice
        : isFiniteNumber(r.avgExecPrice)
          ? r.avgExecPrice
          : isFiniteNumber(r.lastExecPrice)
            ? r.lastExecPrice
            : null;
      const qty = isFiniteNumber(r.totalQuantity)
        ? r.totalQuantity
        : isFiniteNumber(r.filledQuantity)
          ? r.filledQuantity
          : r.openQuantity;
      const total = isFiniteNumber(price) && isFiniteNumber(qty) ? price * qty : null;
      console.log(
        ' ',
        r.creationTime,
        r.symbol,
        r.action,
        'price=', price,
        'qty=', qty,
        'total=', total,
        'idx=', r.activityIndex
      );
    }
  }
})();
