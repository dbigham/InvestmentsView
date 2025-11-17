const groups = require('./symbol-groups.json');

function normalizeSymbolKey(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.toUpperCase();
}

function hydrateGroup(group) {
  const canonicalKey = normalizeSymbolKey(group.key);
  if (!canonicalKey) {
    return null;
  }
  const symbols = Array.isArray(group.symbols)
    ? Array.from(
        new Set(
          group.symbols
            .map((symbol) => normalizeSymbolKey(symbol))
            .filter(Boolean)
        )
      )
    : [canonicalKey];
  if (!symbols.includes(canonicalKey)) {
    symbols.unshift(canonicalKey);
  }
  const defaultPriceSymbol = (() => {
    const normalized = normalizeSymbolKey(group.defaultPriceSymbol);
    if (normalized && symbols.includes(normalized)) {
      return normalized;
    }
    return symbols[0];
  })();
  return Object.freeze({
    key: canonicalKey,
    label: typeof group.label === 'string' && group.label.trim() ? group.label.trim() : canonicalKey,
    symbols,
    defaultPriceSymbol,
  });
}

const SYMBOL_GROUPS = Object.freeze(groups.map(hydrateGroup).filter(Boolean));
const GROUP_BY_KEY = new Map();
const GROUP_BY_SYMBOL = new Map();

SYMBOL_GROUPS.forEach((group) => {
  GROUP_BY_KEY.set(group.key, group);
  group.symbols.forEach((symbol) => {
    GROUP_BY_SYMBOL.set(symbol, group);
  });
});

function getSymbolGroupByKey(key) {
  const normalized = normalizeSymbolKey(key);
  if (!normalized) {
    return null;
  }
  return GROUP_BY_KEY.get(normalized) || null;
}

function getSymbolGroupForSymbol(symbol) {
  const normalized = normalizeSymbolKey(symbol);
  if (!normalized) {
    return null;
  }
  return GROUP_BY_SYMBOL.get(normalized) || null;
}

function getSymbolGroupMembers(symbolOrKey) {
  const group = getSymbolGroupByKey(symbolOrKey) || getSymbolGroupForSymbol(symbolOrKey);
  if (!group) {
    const normalized = normalizeSymbolKey(symbolOrKey);
    return normalized ? [normalized] : [];
  }
  return group.symbols.slice();
}

function getDefaultPriceSymbol(symbolOrKey) {
  const group = getSymbolGroupByKey(symbolOrKey) || getSymbolGroupForSymbol(symbolOrKey);
  if (!group) {
    return normalizeSymbolKey(symbolOrKey);
  }
  return group.defaultPriceSymbol;
}

module.exports = {
  SYMBOL_GROUPS,
  normalizeSymbolKey,
  getSymbolGroupByKey,
  getSymbolGroupForSymbol,
  getSymbolGroupMembers,
  getDefaultPriceSymbol,
};
