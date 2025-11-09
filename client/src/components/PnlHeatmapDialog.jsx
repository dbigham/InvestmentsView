import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  formatDateTime,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';
import { buildQuoteUrl, openQuote } from '../utils/quotes';
import { copyTextToClipboard } from '../utils/clipboard';
import { openChatGpt } from '../utils/chat';
import { buildExplainMovementPrompt, derivePercentages, resolveTotalCost } from '../utils/positions';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computePercentChange(position, metricKey) {
  const metricValue = isFiniteNumber(position[metricKey]) ? position[metricKey] : 0;

  if (metricKey === 'dayPnl') {
    const currentMarketValue = isFiniteNumber(position.currentMarketValue)
      ? position.currentMarketValue
      : 0;
    const previousValue = currentMarketValue - metricValue;
    if (Math.abs(previousValue) > 1e-9) {
      return (metricValue / previousValue) * 100;
    }
    return metricValue === 0 ? 0 : null;
  }

  const totalCost = resolveTotalCost(position);
  if (totalCost !== null && Math.abs(totalCost) > 1e-9) {
    return (metricValue / totalCost) * 100;
  }
  return metricValue === 0 ? 0 : null;
}

function resolveMetricValue(position, metricKey) {
  if (!position) {
    return 0;
  }
  if (metricKey === 'dayPnl' && isFiniteNumber(position.normalizedDayPnl)) {
    return position.normalizedDayPnl;
  }
  if (metricKey === 'openPnl' && isFiniteNumber(position.normalizedOpenPnl)) {
    return position.normalizedOpenPnl;
  }
  return isFiniteNumber(position[metricKey]) ? position[metricKey] : 0;
}

function layoutRow(row, rowWeight, rect, totalWeight) {
  const areaScale = (rect.width * rect.height) / totalWeight;
  const rowArea = rowWeight * areaScale;
  if (rowArea <= 0) {
    return {
      placed: row.map((item) => ({
        ...item,
        x: rect.x,
        y: rect.y,
        width: 0,
        height: 0,
      })),
      remainingRect: rect,
    };
  }

  const horizontal = rect.width < rect.height;

  if (horizontal) {
    const rowHeight = rowArea / rect.width;
    let cursorX = rect.x;
    const placed = row.map((item) => {
      const itemArea = item.weight * areaScale;
      const itemWidth = rowHeight > 0 ? itemArea / rowHeight : 0;
      const tile = {
        ...item,
        x: cursorX,
        y: rect.y,
        width: itemWidth,
        height: rowHeight,
      };
      cursorX += itemWidth;
      return tile;
    });
    return {
      placed,
      remainingRect: {
        x: rect.x,
        y: rect.y + rowHeight,
        width: rect.width,
        height: Math.max(0, rect.height - rowHeight),
      },
    };
  }

  const rowWidth = rowArea / rect.height;
  let cursorY = rect.y;
  const placed = row.map((item) => {
    const itemArea = item.weight * areaScale;
    const itemHeight = rowWidth > 0 ? itemArea / rowWidth : 0;
    const tile = {
      ...item,
      x: rect.x,
      y: cursorY,
      width: rowWidth,
      height: itemHeight,
    };
    cursorY += itemHeight;
    return tile;
  });

  return {
    placed,
    remainingRect: {
      x: rect.x + rowWidth,
      y: rect.y,
      width: Math.max(0, rect.width - rowWidth),
      height: rect.height,
    },
  };
}

function worstAspect(row, rowWeight, rect, totalWeight) {
  if (!row.length) {
    return Infinity;
  }

  const shortSide = Math.min(rect.width, rect.height);
  if (shortSide <= 0) {
    return Infinity;
  }

  const areaScale = (rect.width * rect.height) / totalWeight;
  const rowArea = rowWeight * areaScale;
  if (rowArea <= 0) {
    return Infinity;
  }

  const maxWeight = row.reduce((max, item) => Math.max(max, item.weight), 0);
  const minWeight = row.reduce((min, item) => Math.min(min, item.weight), Number.POSITIVE_INFINITY);
  const maxArea = maxWeight * areaScale;
  const minArea = minWeight * areaScale;

  if (minArea <= 0) {
    return Infinity;
  }

  const shortSideSquared = shortSide * shortSide;
  const rowAreaSquared = rowArea * rowArea;

  return Math.max((shortSideSquared * maxArea) / rowAreaSquared, rowAreaSquared / (shortSideSquared * minArea));
}

function buildTreemapLayout(items, rect = { x: 0, y: 0, width: 1, height: 1 }) {
  if (!items.length) {
    return [];
  }

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return items.map((item) => ({ ...item, x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  }

  const stack = [{
    items: items.slice(),
    rect,
    totalWeight,
  }];

  const placedNodes = [];

  while (stack.length) {
    const current = stack.pop();
    const { items: remainingItems, rect: currentRect, totalWeight: currentTotal } = current;

    if (!remainingItems.length) {
      continue;
    }

    if (remainingItems.length === 1) {
      const [only] = remainingItems;
      placedNodes.push({
        ...only,
        x: currentRect.x,
        y: currentRect.y,
        width: currentRect.width,
        height: currentRect.height,
      });
      continue;
    }

    let row = [];
    let rowWeight = 0;
    const queue = remainingItems.slice();

    while (queue.length) {
      const next = queue[0];
      const testRow = row.concat(next);
      const testWeight = rowWeight + next.weight;
      const currentWorst = worstAspect(row, rowWeight, currentRect, currentTotal);
      const nextWorst = worstAspect(testRow, testWeight, currentRect, currentTotal);

      if (row.length && nextWorst > currentWorst) {
        break;
      }

      row = testRow;
      rowWeight = testWeight;
      queue.shift();
    }

    const { placed, remainingRect } = layoutRow(row, rowWeight, currentRect, currentTotal);
    placedNodes.push(...placed);

    const leftover = remainingItems.slice(row.length);
    if (leftover.length) {
      const leftoverWeight = leftover.reduce((sum, item) => sum + item.weight, 0);
      stack.push({
        items: leftover,
        rect: remainingRect,
        totalWeight: leftoverWeight > 0 ? leftoverWeight : Number.EPSILON,
      });
    }
  }

  return placedNodes;
}

const STYLE_TWO_MIN_SHARE = 0.005;

const HEATMAP_SYMBOL_LABELS = {
  SGOV: 'T-Bills',
  SPLG: 'S&P 500',
  SPYM: 'S&P 500',
  TSLA: 'Tesla',
  NVDA: 'NVIDIA',
  VXUS: 'Non-US',
  VCN: 'Canadian',
  QQQ: 'Nasdaq-100',
  ENB: "Enbridge"
};

function resolveDisplaySymbol(symbol) {
  if (!symbol) {
    return symbol;
  }
  const key = String(symbol).toUpperCase();
  return HEATMAP_SYMBOL_LABELS[key] || symbol;
}

const MERGED_SYMBOL_ALIASES = new Map([
  ['QQQM', 'QQQ'],
  ['IBIT.U', 'IBIT'],
  ['VBIL', 'SGOV'],
  ['BIL', 'SGOV'],
]);

function normalizeMergedSymbol(position, fallbackId) {
  const rawSymbol =
    typeof position.symbol === 'string' && position.symbol.trim()
      ? position.symbol.trim()
      : position.symbolId !== undefined && position.symbolId !== null
      ? String(position.symbolId)
      : position.rowId
      ? String(position.rowId)
      : fallbackId;

  const normalized = rawSymbol ? rawSymbol.toUpperCase() : '';
  const withoutToSuffix = normalized.endsWith('.TO') ? normalized.slice(0, -3) : normalized;
  const base = MERGED_SYMBOL_ALIASES.get(withoutToSuffix) || withoutToSuffix;

  return {
    key: base || normalized || fallbackId,
    display: base || rawSymbol || '—',
    raw: rawSymbol || '—',
  };
}

function aggregatePositionsByMergedSymbol(positions) {
  const groups = new Map();

  const entries = Array.isArray(positions) ? positions : [];

  entries.forEach((position, index) => {
    const { key, display, raw } = normalizeMergedSymbol(position, `__merged_${index}`);
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
        rawSymbols: new Set([raw]),
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
      rowId: Array.from(rawSymbols).join(','),
    };
  });
}

function buildHeatmapNodes(positions, metricKey, styleMode = 'style1') {
  const sourcePositions = aggregatePositionsByMergedSymbol(positions);

  const prepared = sourcePositions
    .map((position) => {
      const marketValue = isFiniteNumber(position.normalizedMarketValue)
        ? position.normalizedMarketValue
        : 0;
      const metricValue = resolveMetricValue(position, metricKey);
      if (marketValue <= 0) {
        // In Total P&L mode, allow closed symbols to be included
        if (!(metricKey === 'totalPnl' && Number.isFinite(metricValue) && metricValue !== 0)) {
          return null;
        }
      }
      const percentChange = computePercentChange(position, metricKey);

      return {
        id:
          position.rowId ||
          position.symbol ||
          position.symbolId ||
          String(position.id || position.symbol || Math.random()),
        symbol: position.symbol || position.symbolId || '—',
        displaySymbol: resolveDisplaySymbol(position.symbol || position.symbolId || '—'),
        description: position.description || null,
        weight: metricKey === 'totalPnl' && styleMode === 'style1' ? Math.abs(metricValue) : marketValue,
        marketValue,
        portfolioShare: isFiniteNumber(position.portfolioShare) ? position.portfolioShare : null,
        currency:
          typeof position.currency === 'string' && position.currency.trim()
            ? position.currency.trim().toUpperCase()
            : null,
        currentPrice: isFiniteNumber(position.currentPrice) ? position.currentPrice : null,
        metricValue,
        percentChange,
        positionDetail: position,
      };
    })
    .filter(Boolean);

  if (!prepared.length) {
    return [];
  }

  const score = (value) => {
    if (value > 0) return 0;
    if (value === 0) return 1;
    return 2;
  };

  const resolvePercentChange = (item) =>
    Number.isFinite(item?.percentChange) ? item.percentChange : null;

  const compareNumbers = (a, b) => {
    if (a === null && b === null) {
      return 0;
    }
    if (a === null) {
      return 1;
    }
    if (b === null) {
      return -1;
    }
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  };

  const comparePositive = (a, b) => {
    const aPercent = resolvePercentChange(a);
    const bPercent = resolvePercentChange(b);
    const percentDiff = compareNumbers(bPercent, aPercent);
    if (percentDiff !== 0) {
      return percentDiff;
    }
    const valueDiff = compareNumbers(Math.abs(b.metricValue), Math.abs(a.metricValue));
    if (valueDiff !== 0) {
      return valueDiff;
    }
    return compareNumbers(b.weight, a.weight);
  };

  const compareNegative = (a, b) => {
    const aPercent = resolvePercentChange(a);
    const bPercent = resolvePercentChange(b);
    const aIntensity = aPercent === null ? null : Math.abs(aPercent);
    const bIntensity = bPercent === null ? null : Math.abs(bPercent);
    const percentDiff = compareNumbers(aIntensity, bIntensity);
    if (percentDiff !== 0) {
      return percentDiff;
    }
    const magnitudeDiff = compareNumbers(Math.abs(a.metricValue), Math.abs(b.metricValue));
    if (magnitudeDiff !== 0) {
      return magnitudeDiff;
    }
    return compareNumbers(a.weight, b.weight);
  };

  if (styleMode === 'style2') {
    const withMetricWeight = prepared
      .map((item) => ({
        ...item,
        weight: Math.abs(item.metricValue),
      }))
      .filter((item) => item.weight > 0);

    if (!withMetricWeight.length) {
      return [];
    }

    const totalAbs = withMetricWeight.reduce((sum, item) => sum + item.weight, 0);
    if (totalAbs <= 0) {
      return [];
    }

    const filtered = withMetricWeight.filter((item) => item.weight / totalAbs >= STYLE_TWO_MIN_SHARE);
    const pool = filtered.length ? filtered : withMetricWeight.slice(0, 1);

    const sorted = pool.slice().sort((a, b) => {
      const aScore = score(a.metricValue);
      const bScore = score(b.metricValue);
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      if (aScore === 0) {
        return comparePositive(a, b);
      }
      if (aScore === 2) {
        return compareNegative(a, b);
      }
      return compareNumbers(b.weight, a.weight);
    });

    const layout = buildTreemapLayout(sorted);
    return layout.map((item) => ({
      ...item,
      share: null,
    }));
  }

  const totalWeight = prepared.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return [];
  }

  const normalized = prepared.map((item) => ({
    ...item,
    share: item.portfolioShare !== null ? item.portfolioShare : (item.weight / totalWeight) * 100,
  }));

  const sorted = normalized.slice().sort((a, b) => {
    const aScore = score(a.metricValue);
    const bScore = score(b.metricValue);
    if (aScore !== bScore) {
      return aScore - bScore;
    }
    if (aScore === 0) {
      return comparePositive(a, b);
    }
    if (aScore === 2) {
      return compareNegative(a, b);
    }
    return compareNumbers(b.weight, a.weight);
  });

  const layout = buildTreemapLayout(sorted);
  const gutter = 0;

  return layout.map((node) => {
    const adjustedWidth = Math.max(0, node.width - gutter * 2);
    const adjustedHeight = Math.max(0, node.height - gutter * 2);
    return {
      ...node,
      x: node.x + gutter,
      y: node.y + gutter,
      width: adjustedWidth,
      height: adjustedHeight,
    };
  });
}

const NEUTRAL_COLOR = '#404656';
const POSITIVE_COLOR = '#00ff00';
const NEGATIVE_COLOR = '#ff0000';

function parseHexColor(color) {
  const normalized = color.replace('#', '');
  const bigint = Number.parseInt(normalized, 16);
  if (normalized.length === 6 && Number.isFinite(bigint)) {
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255,
    };
  }
  return { r: 64, g: 70, b: 86 };
}

const neutralRgb = parseHexColor(NEUTRAL_COLOR);
const positiveRgb = parseHexColor(POSITIVE_COLOR);
const negativeRgb = parseHexColor(NEGATIVE_COLOR);

function interpolateChannel(start, end, amount) {
  return Math.round(start + (end - start) * clamp(amount, 0, 1));
}

function interpolateColor(base, target, intensity) {
  const r = interpolateChannel(base.r, target.r, intensity);
  const g = interpolateChannel(base.g, target.g, intensity);
  const b = interpolateChannel(base.b, target.b, intensity);
  return `rgb(${r}, ${g}, ${b})`;
}

function resolveTileColor(value, intensity) {
  if (value > 0) {
    return interpolateColor(neutralRgb, positiveRgb, intensity);
  }
  if (value < 0) {
    return interpolateColor(neutralRgb, negativeRgb, intensity);
  }
  return NEUTRAL_COLOR;
}

export default function PnlHeatmapDialog({
  positions,
  mode,
  onClose,
  baseCurrency,
  asOf,
  totalMarketValue,
  accountOptions,
  initialAccount,
  totalPnlBySymbol,
  totalPnlAsOf,
}) {
  const initialMetric = mode === 'total' ? 'total' : mode === 'open' ? 'open' : 'day';
  const [metricMode, setMetricMode] = useState(initialMetric);
  useEffect(() => {
    setMetricMode(initialMetric);
  }, [initialMetric]);

  const metricKey = metricMode === 'open' ? 'openPnl' : metricMode === 'total' ? 'totalPnl' : 'dayPnl';
  const metricLabel =
    metricMode === 'open' ? 'Open P&L' : metricMode === 'total' ? 'Total P&L' : "Today's P&L";
  const percentColorThreshold = metricMode === 'open' ? 70 : metricMode === 'total' ? 70 : 5;
  const [fxBreakout, setFxBreakout] = useState(true);
  const normalizeTotalList = useCallback(
    (source, breakout) => {
      const addNumber = (value) => (Number.isFinite(value) ? value : 0);
      const cloneEntries = (list) => {
        if (!Array.isArray(list)) {
          return [];
        }
        return list
          .map((entry) => {
            if (!entry) {
              return null;
            }
            const clone = { ...entry };
            if (Array.isArray(entry.components)) {
              clone.components = entry.components
                .map((component) => (component ? { ...component } : null))
                .filter(Boolean);
            }
            return clone;
          })
          .filter(Boolean);
      };
      const mergeComponentArrays = (target, source) => {
        const map = new Map();
        const apply = (collection) => {
          if (!Array.isArray(collection)) {
            return;
          }
          collection.forEach((component) => {
            if (!component) {
              return;
            }
            const key = component.symbol ? String(component.symbol).toUpperCase() : '';
            if (!key) {
              return;
            }
            const existing = map.get(key);
            const addComponentValue = (value) => (Number.isFinite(value) ? value : 0);
            if (!existing) {
              map.set(key, {
                symbol: component.symbol || null,
                totalPnlCad: addComponentValue(component.totalPnlCad),
                totalPnlWithFxCad: addComponentValue(component.totalPnlWithFxCad),
                totalPnlNoFxCad: addComponentValue(component.totalPnlNoFxCad),
                investedCad: addComponentValue(component.investedCad),
                openQuantity: addComponentValue(component.openQuantity),
                marketValueCad: addComponentValue(component.marketValueCad),
              });
            } else {
              existing.totalPnlCad += addComponentValue(component.totalPnlCad);
              existing.totalPnlWithFxCad += addComponentValue(component.totalPnlWithFxCad);
              existing.totalPnlNoFxCad += addComponentValue(component.totalPnlNoFxCad);
              existing.investedCad += addComponentValue(component.investedCad);
              existing.openQuantity += addComponentValue(component.openQuantity);
              existing.marketValueCad += addComponentValue(component.marketValueCad);
              if (!existing.symbol && component.symbol) {
                existing.symbol = component.symbol;
              }
            }
          });
        };
        apply(target);
        apply(source);
        return Array.from(map.values());
      };
      const aggregateUsdCad = (list, fxContribution, options = {}) => {
        const { mergeDlr = true } = options || {};
        const entries = Array.isArray(list) ? list : [];
        if (!entries.length && !(Number.isFinite(fxContribution) && Math.abs(fxContribution) > 1e-9)) {
          return entries;
        }
        const aggregated = [];
        let usdCadEntry = null;
        let dlrTotals = {
          totalPnlCad: 0,
          investedCad: 0,
          openQuantity: 0,
          marketValueCad: 0,
        };
        let dlrComponents = [];
        entries.forEach((entry) => {
          const symbol = typeof entry.symbol === 'string' ? entry.symbol : '';
          const normalizedSymbol = symbol.trim().toUpperCase();
          const withoutTo = normalizedSymbol.endsWith('.TO') ? normalizedSymbol.slice(0, -3) : normalizedSymbol;
          const baseSymbol = withoutTo.endsWith('.U') ? withoutTo.slice(0, -2) : withoutTo;
          const isUsdCad = normalizedSymbol === 'USD/CAD';
          if (isUsdCad) {
            if (!usdCadEntry) {
              usdCadEntry = entry;
            } else {
              usdCadEntry = {
                ...usdCadEntry,
                totalPnlCad: addNumber(usdCadEntry.totalPnlCad) + addNumber(entry.totalPnlCad),
                investedCad: addNumber(usdCadEntry.investedCad) + addNumber(entry.investedCad),
                openQuantity: addNumber(usdCadEntry.openQuantity) + addNumber(entry.openQuantity),
                marketValueCad: addNumber(usdCadEntry.marketValueCad) + addNumber(entry.marketValueCad),
                components: mergeComponentArrays(usdCadEntry.components, entry.components),
              };
              if (!usdCadEntry.symbolId && Number.isFinite(entry.symbolId)) {
                usdCadEntry.symbolId = entry.symbolId;
              }
              if (!usdCadEntry.currency && entry.currency) {
                usdCadEntry.currency = entry.currency;
              }
            }
            return;
          }
          const isDlr = mergeDlr && baseSymbol === 'DLR';
          if (isDlr) {
            dlrTotals = {
              totalPnlCad: dlrTotals.totalPnlCad + addNumber(entry.totalPnlCad),
              investedCad: dlrTotals.investedCad + addNumber(entry.investedCad),
              openQuantity: dlrTotals.openQuantity + addNumber(entry.openQuantity),
              marketValueCad: dlrTotals.marketValueCad + addNumber(entry.marketValueCad),
            };
            dlrComponents = mergeComponentArrays(dlrComponents, entry.components);
            return;
          }
          aggregated.push(entry);
        });
        const fxValue = Number.isFinite(fxContribution) ? fxContribution : 0;
        const hasFxContribution = Math.abs(fxValue) > 1e-9;
        const hasDlrContribution =
          mergeDlr &&
          (Math.abs(dlrTotals.totalPnlCad) > 1e-9 ||
            Math.abs(dlrTotals.investedCad) > 1e-9 ||
            Math.abs(dlrTotals.openQuantity) > 1e-9 ||
            Math.abs(dlrTotals.marketValueCad) > 1e-9);
        const shouldIncludeCombined = usdCadEntry || hasFxContribution || hasDlrContribution;
        if (!shouldIncludeCombined) {
          return aggregated;
        }
        const combinedEntry = usdCadEntry ? { ...usdCadEntry } : { symbol: 'USD/CAD', symbolId: null };
        combinedEntry.symbol = 'USD/CAD';
        combinedEntry.currency = combinedEntry.currency || 'CAD';
        combinedEntry.totalPnlCad =
          addNumber(combinedEntry.totalPnlCad) +
          fxValue +
          (mergeDlr ? addNumber(dlrTotals.totalPnlCad) : 0);
        combinedEntry.investedCad =
          addNumber(combinedEntry.investedCad) + (mergeDlr ? addNumber(dlrTotals.investedCad) : 0);
        combinedEntry.openQuantity =
          addNumber(combinedEntry.openQuantity) + (mergeDlr ? addNumber(dlrTotals.openQuantity) : 0);
        combinedEntry.marketValueCad =
          addNumber(combinedEntry.marketValueCad) + (mergeDlr ? addNumber(dlrTotals.marketValueCad) : 0);
        combinedEntry.components = mergeComponentArrays(
          combinedEntry.components,
          mergeDlr ? dlrComponents : []
        );
        if (hasFxContribution) {
          combinedEntry.components = mergeComponentArrays(combinedEntry.components, [
            {
              symbol: 'USD/CAD FX',
              totalPnlCad: fxValue,
              totalPnlWithFxCad: fxValue,
              totalPnlNoFxCad: fxValue,
              investedCad: 0,
              openQuantity: 0,
              marketValueCad: 0,
            },
          ]);
        }
        const breakdown = {};
        if (hasFxContribution) {
          breakdown.rawFxCad = fxValue;
        }
        if (mergeDlr && dlrComponents.length) {
          const dlrBySymbol = {};
          let dlrTotal = 0;
          dlrComponents.forEach((component) => {
            if (!component) {
              return;
            }
            const key = component.symbol || '';
            if (!key) {
              return;
            }
            const value = addNumber(component.totalPnlCad);
            dlrBySymbol[key] = (dlrBySymbol[key] || 0) + value;
            dlrTotal += value;
          });
          if (Object.keys(dlrBySymbol).length) {
            breakdown.dlrBySymbol = dlrBySymbol;
            breakdown.dlrCad = dlrTotal;
          }
        } else if (mergeDlr && Math.abs(dlrTotals.totalPnlCad) > 1e-9) {
          breakdown.dlrCad = addNumber(dlrTotals.totalPnlCad);
        }
        if (Object.keys(breakdown).length) {
          combinedEntry.breakdown = breakdown;
        } else if (combinedEntry.breakdown) {
          delete combinedEntry.breakdown;
        }
        aggregated.push(combinedEntry);
        return aggregated;
      };

      if (Array.isArray(source)) {
        return aggregateUsdCad(cloneEntries(source), 0, { mergeDlr: breakout });
      }
      if (!source || typeof source !== 'object') {
        return [];
      }
      const entries = cloneEntries(source.entries);
      if (!breakout) {
        return aggregateUsdCad(entries, 0, { mergeDlr: breakout });
      }
      const entriesNoFx = cloneEntries(source.entriesNoFx);
      if (!entriesNoFx.length) {
        return aggregateUsdCad(entries, 0, { mergeDlr: breakout });
      }
      const fx = Number(source.fxEffectCad);
      const fxContribution = Number.isFinite(fx) ? fx : 0;
      return aggregateUsdCad(entriesNoFx, fxContribution, { mergeDlr: breakout });
    },
    []
  );
  const totalList = useMemo(() => normalizeTotalList(totalPnlBySymbol, fxBreakout), [totalPnlBySymbol, fxBreakout, normalizeTotalList]);
  const tileGapPx = 1;
  const halfTileGapPx = tileGapPx / 2;
  const epsilon = 0.0001;
  const toPercent = (fraction) => `${(fraction * 100).toFixed(4)}%`;
  const formatPx = (value) => `${Number.parseFloat(value.toFixed(3))}`;

  const [styleMode, setStyleMode] = useState('style1');
  const autoSwitchedRef = useRef(false);
  // In Total P&L mode, force Style 2 (category ranking by P&L magnitude)
  useEffect(() => {
    if (metricKey === 'totalPnl' && styleMode !== 'style2') {
      setStyleMode('style2');
    }
  }, [metricKey, styleMode]);
  const normalizedAccountOptions = useMemo(() => {
    if (!Array.isArray(accountOptions) || accountOptions.length === 0) {
      return [];
    }
    return accountOptions
      .map((option) => {
        if (!option || option.value === undefined || option.value === null) {
          return null;
        }
        const value = String(option.value);
        const label =
          typeof option.label === 'string' && option.label.trim() ? option.label.trim() : value;
        const optionPositions = Array.isArray(option.positions) ? option.positions : [];
        const totalValue = isFiniteNumber(option.totalMarketValue) ? option.totalMarketValue : null;
        return {
          value,
          label,
          positions: optionPositions,
          totalMarketValue: totalValue,
        };
      })
      .filter(Boolean);
  }, [accountOptions]);

  const accountSelectId = useMemo(
    () => `pnl-heatmap-account-${Math.random().toString(36).slice(2)}`,
    []
  );

  const [accountSelection, setAccountSelection] = useState(() => {
    if (!normalizedAccountOptions.length) {
      return '';
    }
    const normalizedInitial =
      initialAccount === undefined || initialAccount === null ? null : String(initialAccount);
    if (
      normalizedInitial &&
      normalizedAccountOptions.some((option) => option.value === normalizedInitial)
    ) {
      return normalizedInitial;
    }
    return normalizedAccountOptions[0].value;
  });

  useEffect(() => {
    if (!normalizedAccountOptions.length) {
      setAccountSelection('');
      return;
    }
    setAccountSelection((current) => {
      if (current && normalizedAccountOptions.some((option) => option.value === current)) {
        return current;
      }
      const normalizedInitial =
        initialAccount === undefined || initialAccount === null ? null : String(initialAccount);
      if (
        normalizedInitial &&
        normalizedAccountOptions.some((option) => option.value === normalizedInitial)
      ) {
        return normalizedInitial;
      }
      return normalizedAccountOptions[0].value;
    });
  }, [normalizedAccountOptions, initialAccount]);

  const activeAccountOption = useMemo(() => {
    if (!normalizedAccountOptions.length) {
      return null;
    }
    const match = normalizedAccountOptions.find((option) => option.value === accountSelection);
    if (match) {
      return match;
    }
    return normalizedAccountOptions[0];
  }, [normalizedAccountOptions, accountSelection]);

  const activePositions = useMemo(() => {
    if (activeAccountOption && Array.isArray(activeAccountOption.positions)) {
      return activeAccountOption.positions;
    }
    return positions;
  }, [activeAccountOption, positions]);

  const activeMarketValue = useMemo(() => {
    if (activeAccountOption && isFiniteNumber(activeAccountOption.totalMarketValue)) {
      return activeAccountOption.totalMarketValue;
    }
    return totalMarketValue;
  }, [activeAccountOption, totalMarketValue]);

  const hasAccountSelector = normalizedAccountOptions.length > 1;

  const positionsForNodes = useMemo(() => {
    if (metricKey !== 'totalPnl') {
      return activePositions;
    }
    const totals = totalList;
    if (!totals.length) {
      return [];
    }
    const bySymbol = new Map();
    activePositions.forEach((p) => {
      const key = (p && p.symbol ? String(p.symbol) : String(p?.symbolId || '')) || '';
      if (!key) return;
      bySymbol.set(key.toUpperCase(), p);
    });
    const merged = totals
      .map((entry) => {
        if (!entry || !entry.symbol) {
          return null;
        }
        const key = String(entry.symbol).toUpperCase();
        const base = bySymbol.get(key) || {};
        return {
          symbol: entry.symbol,
          symbolId: entry.symbolId ?? base.symbolId ?? null,
          description: base.description || null,
          currentPrice: base.currentPrice ?? null,
          currency: base.currency || 'CAD',
          normalizedMarketValue: Number.isFinite(base.normalizedMarketValue)
            ? base.normalizedMarketValue
            : Number.isFinite(entry.marketValueCad)
              ? entry.marketValueCad
              : 0,
          totalPnl: Number.isFinite(entry.totalPnlCad) ? entry.totalPnlCad : 0,
          totalCost: Number.isFinite(entry.investedCad) ? entry.investedCad : null,
          openQuantity: Number.isFinite(entry.openQuantity) ? entry.openQuantity : null,
          breakdown: entry.breakdown || null,
          components: Array.isArray(entry.components)
            ? entry.components.map((component) => (component ? { ...component } : null)).filter(Boolean)
            : null,
        };
      })
      .filter(Boolean);
    return merged;
  }, [metricKey, activePositions, totalList]);

  const nodes = useMemo(
    () => buildHeatmapNodes(positionsForNodes, metricKey, styleMode),
    [positionsForNodes, metricKey, styleMode]
  );
  
  useEffect(() => {
    if (metricMode === 'total' || autoSwitchedRef.current) {
      return;
    }
    const hasAnyMarket = Array.isArray(activePositions)
      ? activePositions.some((p) => Number.isFinite(p?.normalizedMarketValue) && p.normalizedMarketValue > 0)
      : false;
    const hasTotals = Array.isArray(totalList) && totalList.length > 0;
    if (!hasAnyMarket && hasTotals) {
      setMetricMode('total');
      autoSwitchedRef.current = true;
    }
  }, [metricMode, activePositions, totalList]);
  const menuRef = useRef(null);
  const [contextMenuState, setContextMenuState] = useState({ open: false, x: 0, y: 0, node: null });

  const closeContextMenu = useCallback(() => {
    setContextMenuState((state) => {
      if (!state.open) {
        return state;
      }
      return { open: false, x: 0, y: 0, node: null };
    });
  }, []);
  const [colorMode, setColorMode] = useState('percent');
  const handleTileClick = useCallback(
    (event, symbol) => {
      closeContextMenu();
      if (!symbol) {
        return;
      }
      const provider = event.altKey ? 'yahoo' : 'perplexity';
      const url = buildQuoteUrl(symbol, provider);
      if (!url) {
        return;
      }
      event.stopPropagation();
      openQuote(symbol, provider);
    },
    [closeContextMenu]
  );

  const handleTileContextMenu = useCallback((event, node) => {
    if (!node) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenuState({ open: true, x: event.clientX, y: event.clientY, node });
  }, []);

  const handleExplainMovement = useCallback(async () => {
    const targetNode = contextMenuState.node;
    closeContextMenu();
    if (!targetNode) {
      return;
    }

    openChatGpt();

    const basePosition = targetNode.positionDetail
      ? {
          ...targetNode.positionDetail,
          symbol: targetNode.positionDetail.symbol || targetNode.symbol,
          description: targetNode.positionDetail.description || targetNode.description,
          currentMarketValue:
            Number.isFinite(targetNode.positionDetail.currentMarketValue)
              ? targetNode.positionDetail.currentMarketValue
              : targetNode.marketValue,
          currentPrice:
            Number.isFinite(targetNode.positionDetail.currentPrice)
              ? targetNode.positionDetail.currentPrice
              : targetNode.currentPrice,
          portfolioShare:
            targetNode.positionDetail.portfolioShare ??
            (Number.isFinite(targetNode.share) ? targetNode.share : null),
        }
      : {
          symbol: targetNode.symbol,
          description: targetNode.description,
          dayPnl: Number.isFinite(targetNode.metricValue) ? targetNode.metricValue : null,
          openPnl: Number.isFinite(targetNode.metricValue) ? targetNode.metricValue : null,
          currentMarketValue: Number.isFinite(targetNode.marketValue) ? targetNode.marketValue : null,
          currentPrice: Number.isFinite(targetNode.currentPrice) ? targetNode.currentPrice : null,
          currency: targetNode.currency,
          portfolioShare: Number.isFinite(targetNode.share) ? targetNode.share : null,
        };

    const percentages = derivePercentages(basePosition);
    const promptSource = {
      ...basePosition,
      dayPnlPercent: percentages.dayPnlPercent,
      openPnlPercent: percentages.openPnlPercent,
    };

    const prompt = buildExplainMovementPrompt(promptSource);
    if (!prompt) {
      return;
    }

    try {
      await copyTextToClipboard(prompt);
    } catch (error) {
      console.error('Failed to copy explain movement prompt from heatmap', error);
    }
  }, [closeContextMenu, contextMenuState.node]);

  useEffect(() => {
    if (!contextMenuState.open) {
      return undefined;
    }

    const handlePointer = (event) => {
      if (!menuRef.current) {
        closeContextMenu();
        return;
      }
      if (menuRef.current.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    const handleViewportChange = () => {
      closeContextMenu();
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [closeContextMenu, contextMenuState.open]);

  useEffect(() => {
    if (!contextMenuState.open || !menuRef.current) {
      return;
    }

    const { innerWidth, innerHeight } = window;
    const rect = menuRef.current.getBoundingClientRect();
    const padding = 12;
    let nextX = contextMenuState.x;
    let nextY = contextMenuState.y;

    if (nextX + rect.width > innerWidth - padding) {
      nextX = Math.max(padding, innerWidth - rect.width - padding);
    }
    if (nextY + rect.height > innerHeight - padding) {
      nextY = Math.max(padding, innerHeight - rect.height - padding);
    }

    if (nextX !== contextMenuState.x || nextY !== contextMenuState.y) {
      setContextMenuState((state) => {
        if (!state.open) {
          return state;
        }
        return { ...state, x: nextX, y: nextY };
      });
    }
  }, [contextMenuState.open, contextMenuState.x, contextMenuState.y]);

  useEffect(() => {
    if (!contextMenuState.open || !menuRef.current) {
      return;
    }
    const firstButton = menuRef.current.querySelector('button');
    if (firstButton && typeof firstButton.focus === 'function') {
      firstButton.focus({ preventScroll: true });
    }
  }, [contextMenuState.open]);

  const totals = useMemo(() => {
    if (metricKey === 'totalPnl') {
      const list = totalList;
      const pnl = list.reduce(
        (sum, entry) => sum + (Number.isFinite(entry?.totalPnlCad) ? entry.totalPnlCad : 0),
        0
      );
      return { marketValue: 0, pnl };
    }
    if (!activePositions.length) {
      return { marketValue: 0, pnl: 0 };
    }
    return activePositions.reduce(
      (acc, position) => {
        const marketValue = isFiniteNumber(position.normalizedMarketValue)
          ? position.normalizedMarketValue
          : 0;
        const pnlValue = resolveMetricValue(position, metricKey);
        return {
          marketValue: acc.marketValue + marketValue,
          pnl: acc.pnl + pnlValue,
        };
      },
      { marketValue: 0, pnl: 0 }
    );
  }, [activePositions, metricKey, totalList]);

  const styleTwoTotals = useMemo(() => {
    if (styleMode !== 'style2') {
      return { positive: 0, negative: 0 };
    }
    return nodes.reduce(
      (acc, node) => {
        if (!isFiniteNumber(node.metricValue) || node.metricValue === 0) {
          return acc;
        }
        if (node.metricValue > 0) {
          return { ...acc, positive: acc.positive + node.metricValue };
        }
        return { ...acc, negative: acc.negative + Math.abs(node.metricValue) };
      },
      { positive: 0, negative: 0 }
    );
  }, [nodes, styleMode]);

  const resolvedMarketValue = isFiniteNumber(activeMarketValue)
    ? activeMarketValue
    : totals.marketValue;

  const asOfEffective = metricKey === 'totalPnl' && totalPnlAsOf ? totalPnlAsOf : asOf;
  const asOfDisplay = asOfEffective ? `As of ${formatDateTime(asOfEffective)}` : null;
  const normalizedCurrency = typeof baseCurrency === 'string' && baseCurrency.trim()
    ? baseCurrency.trim().toUpperCase()
    : null;
  const pnlLabel = normalizedCurrency
    ? `${formatSignedMoney(totals.pnl)} ${normalizedCurrency}`
    : formatSignedMoney(totals.pnl);
  const marketValueLabel = normalizedCurrency
    ? `${formatMoney(resolvedMarketValue)} ${normalizedCurrency}`
    : formatMoney(resolvedMarketValue);
  const fallbackCurrency =
    typeof baseCurrency === 'string' && baseCurrency.trim()
      ? baseCurrency.trim().toUpperCase()
      : '';
  const currencyLabel = normalizedCurrency || fallbackCurrency || 'CAD';

  const contextMenuElement = contextMenuState.open ? (
    <div
      className="positions-table__context-menu"
      ref={menuRef}
      style={{ top: `${contextMenuState.y}px`, left: `${contextMenuState.x}px` }}
    >
      <ul className="positions-table__context-menu-list" role="menu">
        <li role="none">
          <button
            type="button"
            className="positions-table__context-menu-item"
            role="menuitem"
            onClick={handleExplainMovement}
          >
            Explain movement
          </button>
        </li>
      </ul>
    </div>
  ) : null;

  return (
    <div className="pnl-heatmap-overlay" role="presentation">
      <div
        className="pnl-heatmap-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pnl-heatmap-title"
      >
        <header className="pnl-heatmap-dialog__header">
          <div className="pnl-heatmap-dialog__heading">
            <h2 id="pnl-heatmap-title">{metricLabel} breakdown</h2>
            <p className="pnl-heatmap-dialog__subtitle">
              {metricKey === 'totalPnl'
                ? `${pnlLabel} total across traded symbols`
                : `${pnlLabel} in ${marketValueLabel} total market value`}
            </p>
            {asOfDisplay && <p className="pnl-heatmap-dialog__timestamp">{asOfDisplay}</p>}
            <div className="pnl-heatmap-dialog__toolbar">
              {hasAccountSelector ? (
                <div className="pnl-heatmap-dialog__controls pnl-heatmap-dialog__controls--select">
                  <label className="pnl-heatmap-dialog__label" htmlFor={accountSelectId}>
                    Account
                  </label>
                  <div className="pnl-heatmap-dialog__select-wrapper">
                    <select
                      id={accountSelectId}
                      className="pnl-heatmap-dialog__select"
                      value={accountSelection}
                      onChange={(event) => setAccountSelection(event.target.value)}
                    >
                      {normalizedAccountOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
              <div className="pnl-heatmap-dialog__controls" role="group" aria-label="Select P&L metric">
                <button
                  type="button"
                  className={`pnl-heatmap-dialog__control${
                    metricMode === 'day' ? ' pnl-heatmap-dialog__control--active' : ''
                  }`}
                  onClick={() => setMetricMode('day')}
                  aria-pressed={metricMode === 'day'}
                >
                  Today's P&L
                </button>
                <button
                  type="button"
                  className={`pnl-heatmap-dialog__control${
                    metricMode === 'open' ? ' pnl-heatmap-dialog__control--active' : ''
                  }`}
                  onClick={() => setMetricMode('open')}
                  aria-pressed={metricMode === 'open'}
                >
                  Open P&L
                </button>
                {Array.isArray(totalList) && totalList.length > 0 && (
                  <button
                    type="button"
                    className={`pnl-heatmap-dialog__control${
                      metricMode === 'total' ? ' pnl-heatmap-dialog__control--active' : ''
                    }`}
                    onClick={() => setMetricMode('total')}
                    aria-pressed={metricMode === 'total'}
                  >
                    Total P&L
                  </button>
                )}
              </div>
              <div className="pnl-heatmap-dialog__controls" role="group" aria-label="Select heat map style">
                {metricKey !== 'totalPnl' && (
                  <button
                    type="button"
                    className={`pnl-heatmap-dialog__control${
                      styleMode === 'style1' ? ' pnl-heatmap-dialog__control--active' : ''
                    }`}
                    onClick={() => setStyleMode('style1')}
                    aria-pressed={styleMode === 'style1'}
                  >
                    Style 1
                  </button>
                )}
                <button
                  type="button"
                  className={`pnl-heatmap-dialog__control${
                    styleMode === 'style2' ? ' pnl-heatmap-dialog__control--active' : ''
                  }`}
                  onClick={() => setStyleMode('style2')}
                  aria-pressed={styleMode === 'style2'}
                >
                  Style 2
                </button>
              </div>
              <div className="pnl-heatmap-dialog__controls" role="group" aria-label="Color tiles by">
                <button
                  type="button"
                  className={`pnl-heatmap-dialog__control${
                    colorMode === 'percent' ? ' pnl-heatmap-dialog__control--active' : ''
                  }`}
                  onClick={() => setColorMode('percent')}
                  aria-pressed={colorMode === 'percent'}
                >
                  % change
                </button>
                <button
                  type="button"
                  className={`pnl-heatmap-dialog__control${
                    colorMode === 'value' ? ' pnl-heatmap-dialog__control--active' : ''
                  }`}
                  onClick={() => setColorMode('value')}
                  aria-pressed={colorMode === 'value'}
                >
                  {currencyLabel} change
                </button>
              </div>
              {metricKey === 'totalPnl' && !Array.isArray(totalPnlBySymbol) && totalPnlBySymbol && typeof totalPnlBySymbol === 'object' && Array.isArray(totalPnlBySymbol.entriesNoFx) && (
                <div
                  className="pnl-heatmap-dialog__controls"
                  role="group"
                  aria-label="FX options"
                  style={{ marginLeft: 'auto', paddingLeft: '12px', paddingRight: '12px' }}
                >
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="checkbox"
                      checked={fxBreakout}
                      onChange={(e) => setFxBreakout(!!e.target.checked)}
                    />
                    Break out USD/CAD
                  </label>
                </div>
              )}
            </div>
          </div>
          <button type="button" className="pnl-heatmap-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="pnl-heatmap-dialog__body">
          {nodes.length ? (
            <div className="pnl-heatmap-board" role="presentation">
              {nodes.map((node) => {
                const isStyleTwo = styleMode === 'style2';
                const percentChangeValue = isFiniteNumber(node.percentChange) ? node.percentChange : 0;
                const percentIntensity = Math.min(
                  1,
                  Math.abs(percentChangeValue) / Math.max(percentColorThreshold, 1)
                );
                const resolvedIntensity = clamp(percentIntensity, 0, 1);
                const backgroundColor = isStyleTwo
                  ? node.metricValue >= 0
                    ? '#2f8f2f'
                    : '#b23b3b'
                  : resolveTileColor(percentChangeValue, resolvedIntensity);
                const textColor = 'rgba(255, 255, 255, 0.98)';
                const pnlDisplay = formatSignedMoney(node.metricValue);
                const shareLabel =
                  node.share !== null
                    ? formatPercent(node.share, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
                    : null;
                const percentDisplay = isFiniteNumber(node.percentChange)
                  ? formatSignedPercent(node.percentChange, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  : null;
                const valueDisplay = isFiniteNumber(node.metricValue) ? pnlDisplay : null;
                const styleTwoDisplay = (() => {
                  if (!isStyleTwo) {
                    return null;
                  }
                  if (node.metricValue > 0 && styleTwoTotals.positive > 0) {
                    const portion = (node.metricValue / styleTwoTotals.positive) * 100;
                    return formatPercent(portion, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    });
                  }
                  if (node.metricValue < 0 && styleTwoTotals.negative > 0) {
                    const portion = (Math.abs(node.metricValue) / styleTwoTotals.negative) * 100;
                    return formatPercent(portion, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    });
                  }
                  return '—';
                })();
                const detailDisplay = isStyleTwo
                  ? colorMode === 'value'
                    ? valueDisplay ?? '—'
                    : styleTwoDisplay
                  : colorMode === 'value'
                  ? valueDisplay ?? '—'
                  : percentDisplay ?? '—';
                const priceDisplay = isFiniteNumber(node.currentPrice)
                  ? formatMoney(node.currentPrice, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                  : null;
                const priceLine = priceDisplay
                  ? `Price: ${priceDisplay}${
                      node.currency ? ` (${String(node.currency).toUpperCase()})` : ''
                    }`
                  : null;
                const areaFraction = node.width * node.height;
                const areaRoot = Math.sqrt(areaFraction);
                const symbolFontSize = clamp(areaRoot * 70, 7, 28);
                const percentFontSize = clamp(symbolFontSize * 0.85, 6, 24);
                const tileHeightFraction = node.height;
                const contentGapPx = clamp(tileHeightFraction * 80, 0.5, 4);
                const touchesLeftEdge = node.x <= epsilon;
                const touchesTopEdge = node.y <= epsilon;
                const touchesRightEdge = node.x + node.width >= 1 - epsilon;
                const touchesBottomEdge = node.y + node.height >= 1 - epsilon;
                const leftOffsetPx = touchesLeftEdge ? 0 : halfTileGapPx;
                const topOffsetPx = touchesTopEdge ? 0 : halfTileGapPx;
                const widthAdjustmentPx =
                  (touchesLeftEdge ? 0 : halfTileGapPx) + (touchesRightEdge ? 0 : halfTileGapPx);
                const heightAdjustmentPx =
                  (touchesTopEdge ? 0 : halfTileGapPx) + (touchesBottomEdge ? 0 : halfTileGapPx);
                const pnlLine =
                  percentDisplay && metricKey !== 'totalPnl'
                    ? `${metricLabel}: ${pnlDisplay} (${percentDisplay})`
                    : `${metricLabel}: ${pnlDisplay}`;
                const styleTwoLine = isStyleTwo
                  ? node.metricValue > 0 && styleTwoTotals.positive > 0
                    ? `Share of total gain: ${styleTwoDisplay}`
                    : node.metricValue < 0 && styleTwoTotals.negative > 0
                    ? `Share of total loss: ${styleTwoDisplay}`
                    : null
                  : null;
                const breakdownLines = (() => {
                  if (node.symbol !== 'USD/CAD') {
                    return [];
                  }
                  const breakdown = node?.positionDetail?.breakdown;
                  if (!breakdown || typeof breakdown !== 'object') {
                    return [];
                  }
                  const hasDisplayValue = (value) => Number.isFinite(value) && Math.abs(value) >= 0.005;
                  const lines = [];
                  if (hasDisplayValue(breakdown.rawFxCad)) {
                    lines.push(`Raw USD/CAD move: ${formatSignedMoney(breakdown.rawFxCad)}`);
                  }
                  if (breakdown.dlrBySymbol && typeof breakdown.dlrBySymbol === 'object') {
                    const entries = Object.entries(breakdown.dlrBySymbol)
                      .filter(([, value]) => hasDisplayValue(value))
                      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
                    entries.forEach(([symbolKey, value]) => {
                      lines.push(`${symbolKey}: ${formatSignedMoney(value)}`);
                    });
                  } else if (hasDisplayValue(breakdown.dlrCad)) {
                    lines.push(`DLR conversions: ${formatSignedMoney(breakdown.dlrCad)}`);
                  }
                  return lines;
                })();
                const tooltipEntries = [
                  node.description
                    ? `${node.displaySymbol || node.symbol} — ${node.description}`
                    : node.displaySymbol || node.symbol,
                  pnlLine,
                  priceLine,
                  !isStyleTwo && shareLabel
                    ? metricKey === 'totalPnl'
                      ? `Share of total P&L: ${shareLabel}`
                      : `Portfolio share: ${shareLabel}`
                    : null,
                  styleTwoLine,
                ];
                if (breakdownLines.length) {
                  tooltipEntries.push('Breakdown:');
                  tooltipEntries.push(...breakdownLines);
                }
                const tooltipLines = tooltipEntries.filter(Boolean).join('\n');

                return (
                  <button
                    type="button"
                    key={node.id}
                    className="pnl-heatmap-board__tile"
                    style={{
                      left: touchesLeftEdge
                        ? toPercent(node.x)
                        : `calc(${toPercent(node.x)} + ${formatPx(leftOffsetPx)}px)`,
                      top: touchesTopEdge
                        ? toPercent(node.y)
                        : `calc(${toPercent(node.y)} + ${formatPx(topOffsetPx)}px)`,
                      width: touchesLeftEdge && touchesRightEdge
                        ? toPercent(node.width)
                        : `calc(${toPercent(node.width)} - ${formatPx(widthAdjustmentPx)}px)`,
                      height: touchesTopEdge && touchesBottomEdge
                        ? toPercent(node.height)
                        : `calc(${toPercent(node.height)} - ${formatPx(heightAdjustmentPx)}px)`,
                      backgroundColor,
                      color: textColor,
                      gap: `${formatPx(contentGapPx)}px`,
                    }}
                    title={tooltipLines}
                    onClick={(event) => handleTileClick(event, node.symbol)}
                    onContextMenu={(event) => handleTileContextMenu(event, node)}
                  >
                    <span
                      className="pnl-heatmap-board__symbol"
                      style={{ fontSize: `${symbolFontSize}px`, lineHeight: 1 }}
                    >
                      {node.displaySymbol || node.symbol}
                    </span>
                    <span
                      className="pnl-heatmap-board__value"
                      style={{ fontSize: `${percentFontSize}px`, lineHeight: 1 }}
                    >
                      {detailDisplay}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="pnl-heatmap-empty">No positions available for this view.</p>
          )}
        </div>
      </div>
      {contextMenuElement}
    </div>
  );
}

const heatmapPositionShape = PropTypes.shape({
  symbol: PropTypes.string,
  symbolId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  description: PropTypes.string,
  dayPnl: PropTypes.number,
  openPnl: PropTypes.number,
  normalizedMarketValue: PropTypes.number,
  normalizedDayPnl: PropTypes.number,
  normalizedOpenPnl: PropTypes.number,
  portfolioShare: PropTypes.number,
  rowId: PropTypes.string,
  currentMarketValue: PropTypes.number,
  currentPrice: PropTypes.number,
  currency: PropTypes.string,
  totalCost: PropTypes.number,
  averageEntryPrice: PropTypes.number,
  openQuantity: PropTypes.number,
});

PnlHeatmapDialog.propTypes = {
  positions: PropTypes.arrayOf(heatmapPositionShape).isRequired,
  mode: PropTypes.oneOf(['day', 'open', 'total']).isRequired,
  onClose: PropTypes.func.isRequired,
  baseCurrency: PropTypes.string,
  asOf: PropTypes.string,
  totalMarketValue: PropTypes.number,
  accountOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      label: PropTypes.string.isRequired,
      positions: PropTypes.arrayOf(heatmapPositionShape).isRequired,
      totalMarketValue: PropTypes.number,
    })
  ),
  initialAccount: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  totalPnlBySymbol: PropTypes.oneOfType([
    PropTypes.arrayOf(
      PropTypes.shape({
        symbol: PropTypes.string.isRequired,
        symbolId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        totalPnlCad: PropTypes.number,
        investedCad: PropTypes.number,
        openQuantity: PropTypes.number,
        marketValueCad: PropTypes.number,
      })
    ),
    PropTypes.shape({
      entries: PropTypes.arrayOf(
        PropTypes.shape({
          symbol: PropTypes.string.isRequired,
          symbolId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
          totalPnlCad: PropTypes.number,
          investedCad: PropTypes.number,
          openQuantity: PropTypes.number,
          marketValueCad: PropTypes.number,
        })
      ),
      entriesNoFx: PropTypes.arrayOf(
        PropTypes.shape({
          symbol: PropTypes.string.isRequired,
          symbolId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
          totalPnlCad: PropTypes.number,
          investedCad: PropTypes.number,
          openQuantity: PropTypes.number,
          marketValueCad: PropTypes.number,
        })
      ),
      fxEffectCad: PropTypes.number,
      asOf: PropTypes.string,
    }),
  ]),
  totalPnlAsOf: PropTypes.string,
};

PnlHeatmapDialog.defaultProps = {
  baseCurrency: 'CAD',
  asOf: null,
  totalMarketValue: null,
  accountOptions: [],
  initialAccount: null,
  totalPnlBySymbol: [],
  totalPnlAsOf: null,
};
