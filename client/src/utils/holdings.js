import deploymentDisplay from '../../../shared/deploymentDisplay.js';
import { resolveTotalCost } from './positions';

function normalizeSymbolKey(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.toUpperCase();
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const DEFAULT_SYMBOL_PLACEHOLDER = '\u2014';

const HOLDINGS_SYMBOL_LABELS = Object.freeze({
  SGOV: 'T-Bills',
  SPLG: 'S&P 500',
  SPYM: 'S&P 500',
  TSLA: 'Tesla',
  NVDA: 'NVIDIA',
  VXUS: 'Non-US',
  VCN: 'Canadian',
  QQQ: 'Nasdaq-100',
  ENB: 'Enbridge',
});

const MERGED_SYMBOL_ALIASES = new Map([
  ['QQQM', 'QQQ'],
  ['IBIT.U', 'IBIT'],
  ['VBIL', 'SGOV'],
  ['BIL', 'SGOV'],
]);

const RESERVE_ALIAS_TARGET = 'SGOV';
const RESERVE_SYMBOLS = Array.isArray(deploymentDisplay?.RESERVE_SYMBOLS)
  ? deploymentDisplay.RESERVE_SYMBOLS
  : [];

RESERVE_SYMBOLS.forEach((symbol) => {
  const normalized = normalizeSymbolKey(symbol);
  if (!normalized || normalized === RESERVE_ALIAS_TARGET) {
    return;
  }
  if (!MERGED_SYMBOL_ALIASES.has(normalized)) {
    MERGED_SYMBOL_ALIASES.set(normalized, RESERVE_ALIAS_TARGET);
  }
});

function resolveMergedSymbolKey(normalizedSymbol) {
  if (!normalizedSymbol) {
    return '';
  }
  const directAlias = MERGED_SYMBOL_ALIASES.get(normalizedSymbol);
  if (directAlias) {
    return directAlias;
  }
  const withoutToSuffix = normalizedSymbol.endsWith('.TO')
    ? normalizedSymbol.slice(0, -3)
    : normalizedSymbol;
  return MERGED_SYMBOL_ALIASES.get(withoutToSuffix) || withoutToSuffix;
}

function resolveRawSymbol(position, fallbackId) {
  if (position && typeof position.symbol === 'string' && position.symbol.trim()) {
    return position.symbol.trim();
  }
  if (position && position.symbolId !== undefined && position.symbolId !== null) {
    return String(position.symbolId);
  }
  if (position && position.rowId) {
    return String(position.rowId);
  }
  return fallbackId;
}

function normalizeMergedSymbol(position, fallbackId) {
  const fallbackText =
    fallbackId !== undefined && fallbackId !== null ? String(fallbackId) : '';
  const rawSymbol = resolveRawSymbol(position, fallbackText);
  const normalized = normalizeSymbolKey(rawSymbol);
  const mergedSymbol = normalized ? resolveMergedSymbolKey(normalized) : '';
  const resolvedKey =
    mergedSymbol || normalized || normalizeSymbolKey(fallbackText) || fallbackText;
  const display = mergedSymbol || rawSymbol || fallbackText || DEFAULT_SYMBOL_PLACEHOLDER;
  const raw = rawSymbol || fallbackText || DEFAULT_SYMBOL_PLACEHOLDER;
  return {
    key: resolvedKey || raw || DEFAULT_SYMBOL_PLACEHOLDER,
    display,
    raw,
  };
}

export function resolveHoldingsDisplaySymbol(symbol) {
  if (!symbol) {
    return symbol;
  }
  const key = normalizeSymbolKey(symbol);
  return key ? HOLDINGS_SYMBOL_LABELS[key] || symbol : symbol;
}

export function aggregatePositionsByMergedSymbol(positions) {
  const groups = new Map();

  const entries = Array.isArray(positions) ? positions : [];

  entries.forEach((position, index) => {
    const { key, display, raw } = normalizeMergedSymbol(position, `__merged_${index}`);
    const rawSymbolsFromPosition = Array.isArray(position.rawSymbols)
      ? position.rawSymbols
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter(Boolean)
      : [];
    const resolvedCost = resolveTotalCost(position);
    const normalizedMarketValue = isFiniteNumber(position.normalizedMarketValue)
      ? position.normalizedMarketValue
      : 0;
    const normalizedDayPnl = isFiniteNumber(position.normalizedDayPnl)
      ? position.normalizedDayPnl
      : 0;
    const normalizedOpenPnl = isFiniteNumber(position.normalizedOpenPnl)
      ? position.normalizedOpenPnl
      : 0;
    const currentMarketValue = isFiniteNumber(position.currentMarketValue)
      ? position.currentMarketValue
      : 0;
    const dayPnl = isFiniteNumber(position.dayPnl) ? position.dayPnl : 0;
    const openPnl = isFiniteNumber(position.openPnl) ? position.openPnl : 0;
    const totalPnl = isFiniteNumber(position.totalPnl) ? position.totalPnl : 0;
    const portfolioShare = isFiniteNumber(position.portfolioShare)
      ? position.portfolioShare
      : null;
    const currency =
      typeof position.currency === 'string' && position.currency.trim()
        ? position.currency.trim().toUpperCase()
        : null;
    const description =
      typeof position.description === 'string' && position.description.trim()
        ? position.description.trim()
        : position.description ?? null;
    const currentPrice = isFiniteNumber(position.currentPrice) ? position.currentPrice : null;
    const openQuantity = isFiniteNumber(position.openQuantity) ? position.openQuantity : null;
    const accountNumber =
      typeof position.accountNumber === 'string' && position.accountNumber.trim()
        ? position.accountNumber.trim()
        : null;
    const accountId =
      position.accountId !== undefined && position.accountId !== null ? position.accountId : null;

    if (groups.has(key)) {
      const entry = groups.get(key);
      entry.normalizedMarketValue += normalizedMarketValue;
      entry.normalizedDayPnl += normalizedDayPnl;
      entry.normalizedOpenPnl += normalizedOpenPnl;
      entry.currentMarketValue += currentMarketValue;
      entry.dayPnl += dayPnl;
      entry.openPnl += openPnl;
      entry.totalPnl += totalPnl;
      if (portfolioShare !== null) {
        entry.portfolioShare = (entry.portfolioShare ?? 0) + portfolioShare;
      }
      if (entry.totalCost !== null) {
        if (isFiniteNumber(resolvedCost)) {
          entry.totalCost += resolvedCost;
        } else {
          entry.totalCost = null;
        }
      }
      if (entry.openQuantity !== null) {
        if (openQuantity !== null) {
          entry.openQuantity += openQuantity;
        } else {
          entry.openQuantity = null;
        }
      }
      if (entry.accountNumber) {
        if (accountNumber && entry.accountNumber !== accountNumber) {
          entry.accountNumber = null;
        }
      } else if (accountNumber) {
        entry.accountNumber = accountNumber;
      }
      if (entry.accountId !== null && entry.accountId !== undefined) {
        if (accountId !== null && accountId !== undefined) {
          if (String(entry.accountId) !== String(accountId)) {
            entry.accountId = null;
          }
        }
      } else if (accountId !== null && accountId !== undefined) {
        entry.accountId = accountId;
      }
      if (!entry.description && description) {
        entry.description = description;
      }
      if (currentPrice !== null && entry.currentPrice === null) {
        entry.currentPrice = currentPrice;
      }
      if (currency) {
        if (entry.currency && entry.currency !== currency) {
          entry.currency = null;
        } else if (!entry.currency) {
          entry.currency = currency;
        }
      }
      entry.rawSymbols.add(raw);
      rawSymbolsFromPosition.forEach((rawSymbol) => entry.rawSymbols.add(rawSymbol));
    } else {
      groups.set(key, {
        id: `${key}-merged`,
        symbol: display,
        description: description || null,
        normalizedMarketValue,
        normalizedDayPnl,
        normalizedOpenPnl,
        currentMarketValue,
        dayPnl,
        openPnl,
        totalPnl,
        portfolioShare,
        currency,
        currentPrice,
        totalCost: isFiniteNumber(resolvedCost) ? resolvedCost : null,
        averageEntryPrice: isFiniteNumber(position.averageEntryPrice)
          ? position.averageEntryPrice
          : null,
        openQuantity,
        accountNumber,
        accountId,
        rawSymbols: new Set([raw, ...rawSymbolsFromPosition]),
      });
    }
  });

  return Array.from(groups.values()).map((entry) => {
    const { rawSymbols, ...rest } = entry;
    const { totalCost, openQuantity, averageEntryPrice } = rest;
    let resolvedAverage = averageEntryPrice;
    if (resolvedAverage === null && totalCost !== null && openQuantity) {
      const quantity = isFiniteNumber(openQuantity) ? openQuantity : null;
      if (quantity) {
        resolvedAverage = totalCost / quantity;
      }
    }

    return {
      ...rest,
      averageEntryPrice: resolvedAverage,
      rawSymbols: Array.from(rawSymbols),
      rowId: Array.from(rawSymbols).join(','),
    };
  });
}
