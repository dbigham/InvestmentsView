import { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  formatDateTime,
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function buildHeatmapNodes(positions, metricKey) {
  const filtered = positions
    .filter((position) => isFiniteNumber(position.normalizedMarketValue) && position.normalizedMarketValue > 0)
    .map((position) => {
      const metricValue = isFiniteNumber(position[metricKey]) ? position[metricKey] : 0;
      const marketValue = position.normalizedMarketValue;
      const percentChange =
        marketValue > 0 && isFiniteNumber(metricValue) ? (metricValue / marketValue) * 100 : 0;
      const magnitude = Math.abs(percentChange);

      return {
        id:
          position.rowId ||
          position.symbol ||
          position.symbolId ||
          String(position.id || position.symbol || Math.random()),
        symbol: position.symbol || position.symbolId || '—',
        description: position.description || null,
        weight: Math.max(magnitude, 0.0001),
        share: isFiniteNumber(position.portfolioShare) ? position.portfolioShare : null,
        metricValue,
        marketValue,
        percentChange,
        percentMagnitude: magnitude,
      };
    });

  if (!filtered.length) {
    return [];
  }

  const sorted = filtered
    .slice()
    .sort((a, b) => {
      const score = (value) => {
        if (value > 0) return 0;
        if (value === 0) return 1;
        return 2;
      };
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
  const gutter = 0.004;

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

function resolveTileColor(value, intensity) {
  if (value > 0) {
    const saturation = 55 + intensity * 30;
    const lightness = 74 - intensity * 40;
    return `hsl(140, ${clamp(saturation, 50, 85)}%, ${clamp(lightness, 28, 74)}%)`;
  }
  if (value < 0) {
    const saturation = 60 + intensity * 30;
    const lightness = 74 - intensity * 42;
    return `hsl(0, ${clamp(saturation, 55, 90)}%, ${clamp(lightness, 26, 74)}%)`;
  }
  return '#3b4758';
}

function resolveTextColor(intensity, value) {
  if (value === 0) {
    return 'rgba(255, 255, 255, 0.92)';
  }
  if (intensity >= 0.5) {
    return 'rgba(255, 255, 255, 0.96)';
  }
  return 'var(--color-text-primary)';
}

export default function PnlHeatmapDialog({
  positions,
  mode,
  onClose,
  baseCurrency,
  asOf,
}) {
  const metricKey = mode === 'open' ? 'openPnl' : 'dayPnl';
  const metricLabel = mode === 'open' ? 'Open P&L' : "Today's P&L";

  const nodes = useMemo(() => buildHeatmapNodes(positions, metricKey), [positions, metricKey]);

  const totals = useMemo(() => {
    if (!positions.length) {
      return { marketValue: 0, pnl: 0 };
    }
    return positions.reduce(
      (acc, position) => {
        const marketValue = isFiniteNumber(position.normalizedMarketValue) ? position.normalizedMarketValue : 0;
        const pnlValue = isFiniteNumber(position[metricKey]) ? position[metricKey] : 0;
        return {
          marketValue: acc.marketValue + marketValue,
          pnl: acc.pnl + pnlValue,
        };
      },
      { marketValue: 0, pnl: 0 }
    );
  }, [positions, metricKey]);

  const maxMagnitude = useMemo(() => {
    if (!nodes.length) {
      return 0;
    }
    return nodes.reduce((acc, node) => Math.max(acc, node.percentMagnitude), 0);
  }, [nodes]);

  const asOfDisplay = asOf ? `As of ${formatDateTime(asOf)}` : null;
  const normalizedCurrency = typeof baseCurrency === 'string' && baseCurrency.trim()
    ? baseCurrency.trim().toUpperCase()
    : null;
  const pnlLabel = normalizedCurrency
    ? `${formatSignedMoney(totals.pnl)} ${normalizedCurrency}`
    : formatSignedMoney(totals.pnl);
  const marketValueLabel = normalizedCurrency
    ? `${formatMoney(totals.marketValue)} ${normalizedCurrency}`
    : formatMoney(totals.marketValue);

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
          </div>
          <button type="button" className="pnl-heatmap-dialog__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="pnl-heatmap-dialog__body">
          {nodes.length ? (
            <div className="pnl-heatmap-board" role="presentation">
              {nodes.map((node) => {
                const intensity = maxMagnitude > 0 ? Math.min(1, node.percentMagnitude / maxMagnitude) : 0;
                const backgroundColor = resolveTileColor(node.percentChange, intensity);
                const textColor = resolveTextColor(intensity, node.percentChange);
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
                const areaFraction = node.width * node.height;
                const symbolFontSize = clamp(Math.sqrt(areaFraction) * 54, 10, 28);
                const percentFontSize = clamp(symbolFontSize - 2, 9, 24);
                const tooltipLines = [
                  node.description ? `${node.symbol} — ${node.description}` : node.symbol,
                  `${metricLabel}: ${pnlDisplay}`,
                  percentDisplay ? `Change: ${percentDisplay}` : null,
                  shareLabel ? `Portfolio share: ${shareLabel}` : null,
                ]
                  .filter(Boolean)
                  .join('\n');

                return (
                  <div
                    key={node.id}
                    className="pnl-heatmap-board__tile"
                    style={{
                      left: `${node.x * 100}%`,
                      top: `${node.y * 100}%`,
                      width: `${node.width * 100}%`,
                      height: `${node.height * 100}%`,
                      backgroundColor,
                      color: textColor,
                    }}
                    title={tooltipLines}
                  >
                    <span
                      className="pnl-heatmap-board__symbol"
                      style={{ fontSize: `${symbolFontSize}px` }}
                    >
                      {node.symbol}
                    </span>
                    {percentDisplay && (
                      <span
                        className="pnl-heatmap-board__percent"
                        style={{ fontSize: `${percentFontSize}px` }}
                      >
                        {percentDisplay}
                      </span>
                    )}
                  </div>
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
      portfolioShare: PropTypes.number,
      rowId: PropTypes.string,
    })
  ).isRequired,
  mode: PropTypes.oneOf(['day', 'open']).isRequired,
  onClose: PropTypes.func.isRequired,
  baseCurrency: PropTypes.string,
  asOf: PropTypes.string,
};

PnlHeatmapDialog.defaultProps = {
  baseCurrency: 'CAD',
  asOf: null,
};
