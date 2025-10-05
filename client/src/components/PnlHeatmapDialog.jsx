import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import {
  formatDateTime,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';
import { buildQuoteUrl, openQuote } from '../utils/quotes';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolvePositionTotalCost(position) {
  if (position && position.totalCost !== undefined && position.totalCost !== null) {
    return position.totalCost;
  }
  if (
    position &&
    isFiniteNumber(position.averageEntryPrice) &&
    isFiniteNumber(position.openQuantity)
  ) {
    return position.averageEntryPrice * position.openQuantity;
  }
  return null;
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

  const totalCost = resolvePositionTotalCost(position);
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

function normalizeStyleTwoSymbol(position, fallbackId) {
  const rawSymbol =
    typeof position.symbol === 'string' && position.symbol.trim()
      ? position.symbol.trim()
      : position.symbolId !== undefined && position.symbolId !== null
      ? String(position.symbolId)
      : position.rowId
      ? String(position.rowId)
      : fallbackId;

  const normalized = rawSymbol ? rawSymbol.toUpperCase() : '';
  const base = normalized.endsWith('.TO') ? normalized.slice(0, -3) : normalized;

  return {
    key: base || normalized || fallbackId,
    display: base || rawSymbol || '—',
    raw: rawSymbol || '—',
  };
}

function aggregatePositionsForStyleTwo(positions) {
  const groups = new Map();

  positions.forEach((position, index) => {
    const { key, display, raw } = normalizeStyleTwoSymbol(position, `__style2_${index}`);
    const resolvedCost = resolvePositionTotalCost(position);
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
    const portfolioShare = isFiniteNumber(position.portfolioShare) ? position.portfolioShare : 0;
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

    if (groups.has(key)) {
      const entry = groups.get(key);
      entry.normalizedMarketValue += normalizedMarketValue;
      entry.normalizedDayPnl += normalizedDayPnl;
      entry.normalizedOpenPnl += normalizedOpenPnl;
      entry.currentMarketValue += currentMarketValue;
      entry.dayPnl += dayPnl;
      entry.openPnl += openPnl;
      entry.portfolioShare += portfolioShare;
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
        id: `${key}-style2`,
        symbol: display,
        description: description || null,
        normalizedMarketValue,
        normalizedDayPnl,
        normalizedOpenPnl,
        currentMarketValue,
        dayPnl,
        openPnl,
        portfolioShare,
        currency,
        currentPrice,
        totalCost: isFiniteNumber(resolvedCost) ? resolvedCost : null,
        averageEntryPrice: isFiniteNumber(position.averageEntryPrice)
          ? position.averageEntryPrice
          : null,
        openQuantity,
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
  const sourcePositions =
    styleMode === 'style2' ? aggregatePositionsForStyleTwo(positions) : positions;

  const prepared = sourcePositions
    .map((position) => {
      const marketValue = isFiniteNumber(position.normalizedMarketValue)
        ? position.normalizedMarketValue
        : 0;
      if (marketValue <= 0) {
        return null;
      }

      const metricValue = resolveMetricValue(position, metricKey);
      const percentChange = computePercentChange(position, metricKey);

      return {
        id:
          position.rowId ||
          position.symbol ||
          position.symbolId ||
          String(position.id || position.symbol || Math.random()),
        symbol: position.symbol || position.symbolId || '—',
        description: position.description || null,
        weight: marketValue,
        marketValue,
        portfolioShare: isFiniteNumber(position.portfolioShare) ? position.portfolioShare : null,
        currency:
          typeof position.currency === 'string' && position.currency.trim()
            ? position.currency.trim().toUpperCase()
            : null,
        currentPrice: isFiniteNumber(position.currentPrice) ? position.currentPrice : null,
        metricValue,
        percentChange,
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

    const sorted = pool
      .slice()
      .sort((a, b) => {
        const aScore = score(a.metricValue);
        const bScore = score(b.metricValue);
        if (aScore !== bScore) {
          return aScore - bScore;
        }
        if (aScore === 0) {
          return b.weight - a.weight;
        }
        if (aScore === 2) {
          if (a.weight !== b.weight) {
            return a.weight - b.weight;
          }
          return Math.abs(a.metricValue) - Math.abs(b.metricValue);
        }
        return b.weight - a.weight;
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

  const sorted = normalized
    .slice()
    .sort((a, b) => {
      const aScore = score(a.metricValue);
      const bScore = score(b.metricValue);
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      if (aScore === 0) {
        return b.weight - a.weight;
      }
      if (aScore === 2) {
        if (a.weight !== b.weight) {
          return a.weight - b.weight;
        }
        return Math.abs(a.metricValue) - Math.abs(b.metricValue);
      }
      return b.weight - a.weight;
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
}) {
  const initialMetric = mode === 'open' ? 'open' : 'day';
  const [metricMode, setMetricMode] = useState(initialMetric);
  useEffect(() => {
    setMetricMode(initialMetric);
  }, [initialMetric]);

  const metricKey = metricMode === 'open' ? 'openPnl' : 'dayPnl';
  const metricLabel = metricMode === 'open' ? 'Open P&L' : "Today's P&L";
  const percentColorThreshold = metricMode === 'open' ? 70 : 5;
  const tileGapPx = 1;
  const halfTileGapPx = tileGapPx / 2;
  const epsilon = 0.0001;
  const toPercent = (fraction) => `${(fraction * 100).toFixed(4)}%`;
  const formatPx = (value) => `${Number.parseFloat(value.toFixed(3))}`;

  const [styleMode, setStyleMode] = useState('style1');
  const nodes = useMemo(
    () => buildHeatmapNodes(positions, metricKey, styleMode),
    [positions, metricKey, styleMode]
  );
  const [colorMode, setColorMode] = useState('percent');
  const handleTileClick = useCallback((event, symbol) => {
    if (!symbol) {
      return;
    }
    const provider = event.altKey ? 'yahoo' : 'google';
    const url = buildQuoteUrl(symbol, provider);
    if (!url) {
      return;
    }
    event.stopPropagation();
    openQuote(symbol, provider);
  }, []);

  const totals = useMemo(() => {
    if (!positions.length) {
      return { marketValue: 0, pnl: 0 };
    }
    return positions.reduce(
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
  }, [positions, metricKey]);

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

  const resolvedMarketValue = isFiniteNumber(totalMarketValue) ? totalMarketValue : totals.marketValue;

  const asOfDisplay = asOf ? `As of ${formatDateTime(asOf)}` : null;
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
              {pnlLabel} in {marketValueLabel} total market value
            </p>
            {asOfDisplay && <p className="pnl-heatmap-dialog__timestamp">{asOfDisplay}</p>}
            <div className="pnl-heatmap-dialog__toolbar">
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
              </div>
              <div className="pnl-heatmap-dialog__controls" role="group" aria-label="Select heat map style">
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
                const pnlLine = percentDisplay
                  ? `${metricLabel}: ${pnlDisplay} (${percentDisplay})`
                  : `${metricLabel}: ${pnlDisplay}`;
                const styleTwoLine = isStyleTwo
                  ? node.metricValue > 0 && styleTwoTotals.positive > 0
                    ? `Share of total gain: ${styleTwoDisplay}`
                    : node.metricValue < 0 && styleTwoTotals.negative > 0
                    ? `Share of total loss: ${styleTwoDisplay}`
                    : null
                  : null;
                const tooltipLines = [
                  node.description ? `${node.symbol} — ${node.description}` : node.symbol,
                  pnlLine,
                  priceLine,
                  !isStyleTwo && shareLabel ? `Portfolio share: ${shareLabel}` : null,
                  styleTwoLine,
                ]
                  .filter(Boolean)
                  .join('\n');

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
                  >
                    <span
                      className="pnl-heatmap-board__symbol"
                      style={{ fontSize: `${symbolFontSize}px`, lineHeight: 1 }}
                    >
                      {node.symbol}
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
    </div>
  );
}

PnlHeatmapDialog.propTypes = {
  positions: PropTypes.arrayOf(
    PropTypes.shape({
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
    })
  ).isRequired,
  mode: PropTypes.oneOf(['day', 'open']).isRequired,
  onClose: PropTypes.func.isRequired,
  baseCurrency: PropTypes.string,
  asOf: PropTypes.string,
  totalMarketValue: PropTypes.number,
};

PnlHeatmapDialog.defaultProps = {
  baseCurrency: 'CAD',
  asOf: null,
  totalMarketValue: null,
};
