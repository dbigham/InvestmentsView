'use strict';

const SYMBOL_ALIAS_MAP = new Map([
  ['QQQM', 'QQQ'],
  ['QQM', 'QQQ'],
]);

const FUNDING_TYPE_REGEX = /(deposit|withdraw|transfer|journal)/i;

const DIVIDEND_SYMBOL_OVERRIDES = new Map([
  ['N003056', 'NVDA'],
  ['A033916', 'ASML'],
  ['.ENB', 'ENB'],
  ['A040553', 'GOOG'],
  ['C074212', 'CI'],
  ['D052167', 'GGLL'],
  ['H079292', 'SGOV'],
  ['H082968', 'QQQ'],
  ['L415517', 'LLY'],
  ['M415385', 'MSFT'],
  ['PSA', 'PSA'],
  ['S022496', 'SPDR'],
  ['T002234', 'TSM'],
]);

const SYMBOL_INCOME_REGEX = /(dividend|distribution|dist|interest|return of capital|capital gain|reinvest)/i;
const SYMBOL_TRADE_REGEX = /(trade|buy|sell|short|cover|exercise|assign|assignment|option)/i;

function normalizeBreakdownSymbol(symbol) {
  if (symbol === undefined || symbol === null) {
    return null;
  }
  const raw = String(symbol).trim();
  if (!raw) {
    return null;
  }
  const upper = raw.toUpperCase();
  if (DIVIDEND_SYMBOL_OVERRIDES.has(upper)) {
    return DIVIDEND_SYMBOL_OVERRIDES.get(upper);
  }
  let normalized = upper;
  if (normalized.startsWith('.')) {
    normalized = normalized.slice(1);
  }
  const withoutSuffix = normalized.endsWith('.TO') ? normalized.slice(0, -3) : normalized;
  const alias = SYMBOL_ALIAS_MAP.get(withoutSuffix) || SYMBOL_ALIAS_MAP.get(normalized);
  return alias || withoutSuffix || normalized;
}

function resolveActivitySymbolForBreakdown(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const primary = normalizeBreakdownSymbol(activity.symbol);
  const fallback = normalizeBreakdownSymbol(activity.symbolId);
  const symbol = primary || fallback;
  if (!symbol) {
    return null;
  }
  const descriptionCandidates = [activity.symbolDescription, activity.description];
  let description = null;
  for (const candidate of descriptionCandidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) {
        description = trimmed;
        break;
      }
    }
  }
  const symbolId =
    activity.symbolId !== undefined && activity.symbolId !== null
      ? String(activity.symbolId)
      : null;
  return {
    symbol,
    symbolId,
    description,
  };
}

function classifyActivityForSymbolBreakdown(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  if (isFundingActivity(activity)) {
    return null;
  }
  const type = typeof activity.type === 'string' ? activity.type.toLowerCase() : '';
  const action = typeof activity.action === 'string' ? activity.action.toLowerCase() : '';
  const description = typeof activity.description === 'string' ? activity.description.toLowerCase() : '';
  const combined = `${type} ${action}`;
  if (SYMBOL_INCOME_REGEX.test(combined) || SYMBOL_INCOME_REGEX.test(description)) {
    return 'income';
  }
  if (SYMBOL_TRADE_REGEX.test(combined) || SYMBOL_TRADE_REGEX.test(description)) {
    return 'trade';
  }
  return null;
}

function accumulateSymbolBreakdown(target, entries) {
  if (!(target instanceof Map) || !Array.isArray(entries)) {
    return;
  }
  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const symbol = typeof entry.symbol === 'string' ? entry.symbol : null;
    if (!symbol) {
      return;
    }
    const key = symbol.toUpperCase();
    if (!target.has(key)) {
      target.set(key, {
        symbol,
        symbolId: entry.symbolId || null,
        description: entry.description || null,
        netCashFlowCad: 0,
        incomeCad: 0,
        tradeCad: 0,
        investedCad: 0,
        activityCount: 0,
      });
    }
    const bucket = target.get(key);
    bucket.netCashFlowCad += Number(entry.netCashFlowCad) || 0;
    bucket.incomeCad += Number(entry.incomeCad) || 0;
    bucket.tradeCad += Number(entry.tradeCad) || 0;
    bucket.investedCad += Number(entry.investedCad) || 0;
    bucket.activityCount += Number(entry.activityCount) || 0;
    if (!bucket.description && entry.description) {
      bucket.description = entry.description;
    }
    if (!bucket.symbolId && entry.symbolId) {
      bucket.symbolId = entry.symbolId;
    }
  });
}

function finalizeSymbolBreakdown(map) {
  if (!(map instanceof Map)) {
    return [];
  }
  return Array.from(map.values())
    .filter((entry) => {
      const net = Number(entry.netCashFlowCad) || 0;
      const income = Number(entry.incomeCad) || 0;
      const invested = Number(entry.investedCad) || 0;
      return (
        entry.activityCount > 0 &&
        (Math.abs(net) >= 0.01 || Math.abs(income) >= 0.01 || invested >= 0.01)
      );
    })
    .sort((a, b) => Math.abs(b.netCashFlowCad) - Math.abs(a.netCashFlowCad));
}

function isFundingActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }
  const type = typeof activity.type === 'string' ? activity.type : '';
  const action = typeof activity.action === 'string' ? activity.action : '';
  const description = typeof activity.description === 'string' ? activity.description : '';
  return (
    FUNDING_TYPE_REGEX.test(type) ||
    FUNDING_TYPE_REGEX.test(action) ||
    FUNDING_TYPE_REGEX.test(description)
  );
}

module.exports = {
  DIVIDEND_SYMBOL_OVERRIDES,
  normalizeBreakdownSymbol,
  resolveActivitySymbolForBreakdown,
  classifyActivityForSymbolBreakdown,
  accumulateSymbolBreakdown,
  finalizeSymbolBreakdown,
  SYMBOL_ALIAS_MAP,
  FUNDING_TYPE_REGEX,
  SYMBOL_INCOME_REGEX,
  SYMBOL_TRADE_REGEX,
  isFundingActivity,
};
