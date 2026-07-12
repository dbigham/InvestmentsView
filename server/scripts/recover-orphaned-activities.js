const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const HOLDING_TOLERANCE = 0.001;

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      result.apply = true;
    } else if (arg === '--account') {
      result.account = argv[++index];
    } else if (arg === '--expected-holdings') {
      result.expectedHoldings = argv[++index];
    } else if (arg === '--synthetic-transfer-out') {
      result.syntheticTransferOut = argv[++index];
    } else if (arg === '--synthetic-transfer-cash') {
      result.syntheticTransferCash = argv[++index];
    }
  }
  return result;
}

function parseExpectedHoldings(value) {
  const result = {};
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [rawSymbol, rawQuantity] = entry.split('=');
      const symbol = String(rawSymbol || '').trim().toUpperCase();
      const quantity = Number(rawQuantity);
      if (!symbol || !Number.isFinite(quantity)) {
        throw new Error(`Invalid expected holding: ${entry}`);
      }
      result[symbol] = quantity;
    });
  return result;
}

function parseCurrencyAmounts(value) {
  const result = {};
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [rawCurrency, rawAmount] = entry.split('=');
      const currency = String(rawCurrency || '').trim().toUpperCase();
      const amount = Number(rawAmount);
      if (!currency || !Number.isFinite(amount) || amount < 0) {
        throw new Error(`Invalid synthetic cash amount: ${entry}`);
      }
      result[currency] = amount;
    });
  return result;
}

function formatDateParam(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function cacheKey(loginId, accountId, start, end) {
  return crypto
    .createHash('sha1')
    .update([loginId, accountId, formatDateParam(start), formatDateParam(end)].join('|'))
    .digest('hex');
}

function activityTimestamp(activity) {
  const raw = activity && (activity.tradeDate || activity.transactionDate || activity.settlementDate || activity.date);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function activityKey(activity) {
  const timestamp = activityTimestamp(activity);
  return [
    timestamp ? timestamp.toISOString() : '',
    activity.type || '',
    activity.action || '',
    activity.symbol || '',
    activity.description || '',
    activity.currency || '',
    activity.netAmount ?? '',
    activity.grossAmount ?? '',
    activity.amount ?? '',
    activity.quantity ?? '',
    activity.price ?? '',
  ].join('|');
}

function mergeActivities(...collections) {
  const merged = new Map();
  collections.flat().forEach((activity) => {
    if (activity && typeof activity === 'object') merged.set(activityKey(activity), activity);
  });
  return Array.from(merged.values()).sort((left, right) => {
    const leftTime = activityTimestamp(left)?.getTime() || 0;
    const rightTime = activityTimestamp(right)?.getTime() || 0;
    return leftTime - rightTime || activityKey(left).localeCompare(activityKey(right));
  });
}

function computeHoldings(activities) {
  const holdings = {};
  activities.forEach((activity) => {
    const symbol = String(activity.symbol || '').trim().toUpperCase();
    const quantity = Number(activity.quantity);
    if (!symbol || !Number.isFinite(quantity)) return;
    holdings[symbol] = (holdings[symbol] || 0) + quantity;
  });
  return holdings;
}

function compareHoldings(actual, expected) {
  return Object.fromEntries(
    Object.entries(expected).map(([symbol, target]) => {
      const value = actual[symbol] || 0;
      return [symbol, {
        actual: Number(value.toFixed(4)),
        expected: target,
        difference: Number((value - target).toFixed(4)),
      }];
    })
  );
}

function holdingsMatch(actual, expected) {
  return Object.entries(expected).every(([symbol, target]) => {
    return Math.abs((actual[symbol] || 0) - target) <= HOLDING_TOLERANCE;
  });
}

function readPayload(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return payload && Array.isArray(payload.activities) ? payload : null;
  } catch (_error) {
    return null;
  }
}

function recoverBookValueTransferPrices(serverDir, activities) {
  const prices = {};
  activities.forEach((activity) => {
    if (!/\bBOOK\s+VALUE\b/i.test(String(activity.description || ''))) return;
    const symbol = String(activity.symbol || '').trim().toUpperCase();
    const timestamp = activityTimestamp(activity);
    if (!symbol || !timestamp) return;
    const dateKey = timestamp.toISOString().slice(0, 10);
    const activityPrice = Number(activity.price || activity.unitPrice);
    const price = readCachedPrice(serverDir, symbol, dateKey)
      || (Number.isFinite(activityPrice) && activityPrice > 0 ? activityPrice : null);
    if (price) {
      prices[`${symbol}|${dateKey}`] = price;
    }
  });
  return prices;
}

function readCachedPrice(serverDir, symbol, dateKey) {
  const cacheSymbols = [
    symbol,
    symbol.replace(/^([A-Z0-9]+)\.([A-Z])(?=\.|$)/i, '$1-$2'),
  ];
  for (const cacheSymbol of new Set(cacheSymbols)) {
    const cachePath = path.join(
      serverDir,
      '.cache',
      'yahoo-price-cache',
      `${cacheSymbol.replace(/[^A-Z0-9_.-]/gi, '_')}.json`
    );
    try {
      const payload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const requestedDate = new Date(`${dateKey}T12:00:00Z`);
    for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
      const candidateDate = new Date(requestedDate);
      candidateDate.setUTCDate(candidateDate.getUTCDate() - dayOffset);
      const candidateKey = candidateDate.toISOString().slice(0, 10);
      const price = Number(payload && payload.prices && payload.prices[candidateKey]);
        if (Number.isFinite(price) && price > 0) return price;
      }
    } catch (_error) {
      // Try the next Questrade/Yahoo symbol variant.
    }
  }
  return null;
}

function inferSymbolCurrency(symbol) {
  return /\.(?:TO|VN)$/i.test(symbol) && !/\.U\.(?:TO|VN)$/i.test(symbol) ? 'CAD' : 'USD';
}

function buildSyntheticTransferOutActivities(serverDir, activities, dateKey, expectedSymbols) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) {
    throw new Error(`Invalid synthetic transfer-out date: ${dateKey}`);
  }
  const holdings = computeHoldings(activities);
  return Object.keys(expectedSymbols).map((symbol) => {
    const quantity = holdings[symbol] || 0;
    if (quantity <= HOLDING_TOLERANCE) {
      throw new Error(`Cannot transfer ${symbol}: recovered closing quantity is ${quantity}`);
    }
    const lastTransactionPrice = activities
      .filter((activity) => String(activity.symbol || '').trim().toUpperCase() === symbol)
      .filter((activity) => {
        const timestamp = activityTimestamp(activity);
        return timestamp && timestamp <= new Date(`${dateKey}T23:59:59Z`);
      })
      .sort((left, right) => activityTimestamp(right) - activityTimestamp(left))
      .map((activity) => Number(activity.price || activity.unitPrice))
      .find((price) => Number.isFinite(price) && price > 0);
    const price = readCachedPrice(serverDir, symbol, dateKey) || lastTransactionPrice;
    if (!price) {
      throw new Error(`Cannot transfer ${symbol}: no cached market price for ${dateKey}`);
    }
    const timestamp = `${dateKey}T00:00:00.000000-04:00`;
    return {
      tradeDate: timestamp,
      transactionDate: timestamp,
      settlementDate: timestamp,
      action: 'TFO',
      symbol,
      description: `${symbol} WEALTHSIMPLE INVESTMENTS INC SYNTHETIC TRANSFER BOOK VALUE ${(quantity * price).toFixed(2)}`,
      currency: inferSymbolCurrency(symbol),
      quantity: -quantity,
      price: 0,
      grossAmount: 0,
      commission: 0,
      netAmount: 0,
      type: 'Transfers',
      synthetic: true,
      syntheticReason: 'Manual archived-account transfer-out date',
    };
  });
}

function buildSyntheticCashTransferOutActivities(dateKey, currencyAmounts) {
  return Object.entries(currencyAmounts).map(([currency, amount]) => {
    const timestamp = `${dateKey}T00:00:00.000000-04:00`;
    return {
      tradeDate: timestamp,
      transactionDate: timestamp,
      settlementDate: timestamp,
      action: 'TFO',
      description: `CASH WEALTHSIMPLE INVESTMENTS INC SYNTHETIC TRANSFER OUT ${amount.toFixed(2)} ${currency}`,
      currency,
      quantity: 0,
      price: 0,
      grossAmount: -amount,
      commission: 0,
      netAmount: -amount,
      type: 'Transfers',
      synthetic: true,
      syntheticReason: 'Manual archived-account cash transfer-out date',
    };
  });
}

function findDeterministicWindows(cacheDir, loginIds, accountId, start, end) {
  const windows = [];
  let cursor = new Date(start.getTime());
  while (cursor <= end) {
    const windowEnd = new Date(Math.min(end.getTime(), cursor.getTime() + WINDOW_DAYS * DAY_MS - 1000));
    const isFullWindow = windowEnd.getTime() - cursor.getTime() >= WINDOW_DAYS * DAY_MS - 2000;
    if (!isFullWindow) break;

    let selected = null;
    for (const loginId of loginIds) {
      const key = cacheKey(loginId, accountId, cursor, windowEnd);
      const filePath = path.join(cacheDir, `${key}.json`);
      const payload = readPayload(filePath);
      if (payload && (!selected || Date.parse(payload.cachedAt || 0) > Date.parse(selected.payload.cachedAt || 0))) {
        selected = { key, filePath, loginId, payload };
      }
    }
    if (selected) {
      windows.push({
        ...selected,
        start: new Date(cursor.getTime()),
        end: new Date(windowEnd.getTime()),
      });
    }
    cursor = new Date(windowEnd.getTime() + 1000);
  }
  return { windows, tailStart: cursor };
}

function findTailCandidate(cacheDir, tailStart, archiveEnd, baselineActivities, expectedHoldings) {
  const expectedSymbols = new Set(Object.keys(expectedHoldings));
  const candidatesBySignature = new Map();
  fs.readdirSync(cacheDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .forEach((fileName) => {
      const payload = readPayload(path.join(cacheDir, fileName));
      if (!payload) return;
      const activities = payload.activities.filter((activity) => {
        const timestamp = activityTimestamp(activity);
        return timestamp && timestamp >= tailStart && timestamp <= archiveEnd;
      });
      if (!activities.length) return;

      const changedSymbols = new Set(
        activities
          .filter((activity) => Math.abs(Number(activity.quantity) || 0) > 0)
          .map((activity) => String(activity.symbol || '').trim().toUpperCase())
          .filter(Boolean)
      );
      const matchedSymbols = Array.from(changedSymbols).filter((symbol) => expectedSymbols.has(symbol));
      const unexpectedSymbols = Array.from(changedSymbols).filter((symbol) => !expectedSymbols.has(symbol));
      if (matchedSymbols.length < Math.max(3, Math.floor(expectedSymbols.size * 0.6))) return;

      const resultingHoldings = computeHoldings(mergeActivities(baselineActivities, activities));
      const integerResidual = Object.keys(expectedHoldings).reduce((sum, symbol) => {
        const quantity = resultingHoldings[symbol] || 0;
        return sum + Math.abs(quantity - Math.round(quantity));
      }, 0);
      const score = matchedSymbols.length * 100 - unexpectedSymbols.length * 200 - integerResidual * 10;
      const candidate = {
        fileName,
        payload,
        activities,
        matchedSymbols,
        unexpectedSymbols,
        integerResidual,
        score,
      };
      const signature = activities.map(activityKey).sort().join('\n');
      const existing = candidatesBySignature.get(signature);
      if (!existing || Date.parse(payload.cachedAt || 0) > Date.parse(existing.payload.cachedAt || 0)) {
        candidatesBySignature.set(signature, candidate);
      }
    });
  const candidates = Array.from(candidatesBySignature.values());
  candidates.sort((left, right) => right.score - left.score || right.activities.length - left.activities.length);
  const best = candidates[0] || null;
  const runnerUp = candidates[1] || null;
  if (!best || best.unexpectedSymbols.length || (runnerUp && best.score === runnerUp.score && best.activities.length === runnerUp.activities.length)) {
    return { best: null, candidates: candidates.slice(0, 10) };
  }
  return { best, candidates: candidates.slice(0, 10) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.account || !args.expectedHoldings) {
    throw new Error('Usage: node recover-orphaned-activities.js --account <archive-key> --expected-holdings SYM=QTY,... [--synthetic-transfer-out YYYY-MM-DD] [--synthetic-transfer-cash USD=AMOUNT,CAD=AMOUNT] [--apply]');
  }

  const serverDir = path.resolve(__dirname, '..');
  const archivePath = path.join(serverDir, 'archived-accounts.json');
  const cacheDir = path.join(serverDir, '.cache', 'activities');
  const archiveStore = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const entry = archiveStore.accounts && archiveStore.accounts[args.account];
  if (!entry || !entry.account || !entry.activityContext) {
    throw new Error(`Archived account not found or missing activity context: ${args.account}`);
  }

  const expectedHoldings = parseExpectedHoldings(args.expectedHoldings);
  const accountId = String(entry.account.providerAccountId || entry.account.number || '').trim();
  const loginIds = Array.from(new Set([
    entry.activityContext.activityCacheLoginId,
    entry.activityCacheLoginId,
    entry.account.archiveLoginId,
    entry.loginEmail,
    entry.loginId,
  ].filter(Boolean).map(String)));
  const crawlStart = new Date(entry.activityContext.crawlStart);
  const archiveEnd = new Date(entry.activityContext.now || entry.archivedAt);
  if (!accountId || Number.isNaN(crawlStart.getTime()) || Number.isNaN(archiveEnd.getTime())) {
    throw new Error('Archive is missing a usable provider account ID or activity date range');
  }

  const deterministic = findDeterministicWindows(cacheDir, loginIds, accountId, crawlStart, archiveEnd);
  const retainedArchiveActivities = (entry.activityContext.activities || []).filter((activity) => {
    const timestamp = activityTimestamp(activity);
    return timestamp && timestamp < deterministic.tailStart;
  });
  const deterministicActivities = mergeActivities(
    retainedArchiveActivities,
    deterministic.windows.flatMap((window) => window.payload.activities)
  );
  const deterministicHoldings = computeHoldings(deterministicActivities);
  if (!holdingsMatch(deterministicHoldings, expectedHoldings)) {
    console.log(JSON.stringify({
      status: 'rejected',
      reason: 'Deterministic windows do not reconcile to expected holdings',
      comparison: compareHoldings(deterministicHoldings, expectedHoldings),
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const tail = findTailCandidate(cacheDir, deterministic.tailStart, archiveEnd, deterministicActivities, expectedHoldings);
  let recoveredActivities = mergeActivities(
    deterministicActivities,
    tail.best ? tail.best.activities : []
  );
  let syntheticTransferOutActivities = [];
  if (args.syntheticTransferOut) {
    syntheticTransferOutActivities = buildSyntheticTransferOutActivities(
      serverDir,
      recoveredActivities,
      args.syntheticTransferOut,
      expectedHoldings
    );
    recoveredActivities = mergeActivities(recoveredActivities, syntheticTransferOutActivities);
  }
  let syntheticCashTransferOutActivities = [];
  if (args.syntheticTransferCash) {
    if (!args.syntheticTransferOut) {
      throw new Error('--synthetic-transfer-cash requires --synthetic-transfer-out');
    }
    syntheticCashTransferOutActivities = buildSyntheticCashTransferOutActivities(
      args.syntheticTransferOut,
      parseCurrencyAmounts(args.syntheticTransferCash)
    );
    recoveredActivities = mergeActivities(recoveredActivities, syntheticCashTransferOutActivities);
  }
  const latestTimestamp = recoveredActivities
    .map(activityTimestamp)
    .filter(Boolean)
    .sort((left, right) => left - right)
    .at(-1);
  const report = {
    status: args.apply ? 'applied' : 'dry-run',
    account: args.account,
    originalActivityCount: entry.activityContext.activities.length,
    recoveredActivityCount: recoveredActivities.length,
    latestActivity: latestTimestamp ? latestTimestamp.toISOString() : null,
    deterministicWindows: deterministic.windows.map((window) => ({
      file: path.basename(window.filePath),
      loginId: window.loginId,
      start: formatDateParam(window.start),
      end: formatDateParam(window.end),
      activityCount: window.payload.activities.length,
    })),
    expectedHoldingsComparison: compareHoldings(deterministicHoldings, expectedHoldings),
    tailCandidate: tail.best ? {
      file: tail.best.fileName,
      activityCount: tail.best.activities.length,
      matchedSymbols: tail.best.matchedSymbols,
      integerResidual: tail.best.integerResidual,
      score: tail.best.score,
    } : null,
    syntheticTransferOut: args.syntheticTransferOut ? {
      date: args.syntheticTransferOut,
      activityCount: syntheticTransferOutActivities.length + syntheticCashTransferOutActivities.length,
      quantities: Object.fromEntries(
        syntheticTransferOutActivities.map((activity) => [activity.symbol, activity.quantity])
      ),
      cash: Object.fromEntries(
        syntheticCashTransferOutActivities.map((activity) => [activity.currency, -activity.netAmount])
      ),
    } : null,
  };
  const bookValueTransferPrices = recoverBookValueTransferPrices(serverDir, recoveredActivities);
  report.bookValueTransferPriceCount = Object.keys(bookValueTransferPrices).length;

  if (args.apply) {
    entry.activityContext.activities = recoveredActivities;
    entry.activityContext.fingerprint = `count:${recoveredActivities.length}|latest:${report.latestActivity || 'none'}`;
    entry.activityContext.bookValueTransferPrices = bookValueTransferPrices;
    entry.activityRecovery = {
      recoveredAt: new Date().toISOString(),
      method: 'deterministic-cache-window-and-holdings-reconciliation',
      originalActivityCount: report.originalActivityCount,
      recoveredActivityCount: report.recoveredActivityCount,
      latestActivity: report.latestActivity,
      deterministicCacheFiles: report.deterministicWindows.map((window) => window.file),
      tailCacheFile: report.tailCandidate ? report.tailCandidate.file : null,
      syntheticTransferOut: report.syntheticTransferOut,
    };
    const temporaryPath = `${archivePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(archiveStore, null, 2)}\n`);
    fs.renameSync(temporaryPath, archivePath);
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
