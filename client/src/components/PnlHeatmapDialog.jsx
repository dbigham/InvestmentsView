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

function buildTreemapLayout(items, orientation = 'vertical', origin = { x: 0, y: 0, width: 1, height: 1 }) {
  if (!items.length) {
    return [];
  }

  if (items.length === 1) {
    const [item] = items;
    return [
      {
        ...item,
        x: origin.x,
        y: origin.y,
        width: origin.width,
        height: origin.height,
      },
    ];
  }

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return items.map((item) => ({ ...item, x: origin.x, y: origin.y, width: origin.width, height: origin.height }));
  }

  let splitIndex = 0;
  let running = 0;
  const target = totalWeight / 2;

  while (splitIndex < items.length) {
    running += items[splitIndex].weight;
    splitIndex += 1;
    if (running >= target) {
      break;
    }
  }

  if (splitIndex <= 0) {
    splitIndex = 1;
  } else if (splitIndex >= items.length) {
    splitIndex = items.length - 1;
  }

  const firstGroup = items.slice(0, splitIndex);
  const secondGroup = items.slice(splitIndex);
  const firstWeight = firstGroup.reduce((sum, item) => sum + item.weight, 0);

  if (orientation === 'vertical') {
    const firstWidth = origin.width * (firstWeight / totalWeight);
    const secondWidth = origin.width - firstWidth;
    return [
      ...buildTreemapLayout(firstGroup, 'horizontal', {
        x: origin.x,
        y: origin.y,
        width: firstWidth,
        height: origin.height,
      }),
      ...buildTreemapLayout(secondGroup, 'horizontal', {
        x: origin.x + firstWidth,
        y: origin.y,
        width: secondWidth,
        height: origin.height,
      }),
    ];
  }

  const firstHeight = origin.height * (firstWeight / totalWeight);
  const secondHeight = origin.height - firstHeight;
  return [
    ...buildTreemapLayout(firstGroup, 'vertical', {
      x: origin.x,
      y: origin.y,
      width: origin.width,
      height: firstHeight,
    }),
    ...buildTreemapLayout(secondGroup, 'vertical', {
      x: origin.x,
      y: origin.y + firstHeight,
      width: origin.width,
      height: secondHeight,
    }),
  ];
}

function resolveOrientation(width, height) {
  if (width >= height) {
    return 'vertical';
  }
  return 'horizontal';
}

function buildHeatmapNodes(positions, metricKey) {
  const filtered = positions
    .filter((position) => isFiniteNumber(position.normalizedMarketValue) && position.normalizedMarketValue > 0)
    .map((position) => ({
      id: position.rowId || position.symbol || position.symbolId || String(position.id || position.symbol || Math.random()),
      symbol: position.symbol || position.symbolId || '—',
      description: position.description || null,
      weight: position.normalizedMarketValue,
      share: isFiniteNumber(position.portfolioShare) ? position.portfolioShare : null,
      metricValue: isFiniteNumber(position[metricKey]) ? position[metricKey] : 0,
      marketValue: position.normalizedMarketValue,
    }));

  if (!filtered.length) {
    return [];
  }

  const sorted = filtered.slice().sort((a, b) => b.weight - a.weight);
  const layoutOrientation = resolveOrientation(1, 1);
  const layout = buildTreemapLayout(sorted, layoutOrientation);
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
    const hue = 142;
    const saturation = 45 + intensity * 35;
    const lightness = 82 - intensity * 40;
    return `hsl(${hue}, ${clamp(saturation, 40, 85)}%, ${clamp(lightness, 30, 82)}%)`;
  }
  if (value < 0) {
    const hue = 0;
    const saturation = 50 + intensity * 35;
    const lightness = 82 - intensity * 40;
    return `hsl(${hue}, ${clamp(saturation, 45, 90)}%, ${clamp(lightness, 28, 82)}%)`;
  }
  return 'hsl(215, 20%, 92%)';
}

function resolveTextColor(intensity, value) {
  if (value === 0) {
    return 'var(--color-text-primary)';
  }
  if (intensity >= 0.4) {
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
    return nodes.reduce((acc, node) => Math.max(acc, Math.abs(node.metricValue)), 0);
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
                const intensity = maxMagnitude > 0 ? Math.min(1, Math.abs(node.metricValue) / maxMagnitude) : 0;
                const backgroundColor = resolveTileColor(node.metricValue, intensity);
                const textColor = resolveTextColor(intensity, node.metricValue);
                const pnlDisplay = formatSignedMoney(node.metricValue);
                const shareLabel = node.share !== null ? formatPercent(node.share, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : null;
                const changePercent = node.marketValue > 0 ? node.metricValue / node.marketValue : null;
                const percentDisplay = isFiniteNumber(changePercent)
                  ? formatSignedPercent(changePercent * 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : null;

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
                    title={`${node.symbol}\n${metricLabel}: ${pnlDisplay}${
                      percentDisplay ? ` (${percentDisplay})` : ''
                    }${shareLabel ? `\nPortfolio share: ${shareLabel}` : ''}`}
                  >
                    <div className="pnl-heatmap-board__tile-header">
                      <span className="pnl-heatmap-board__symbol">{node.symbol}</span>
                      {shareLabel && <span className="pnl-heatmap-board__share">{shareLabel}</span>}
                    </div>
                    <div className="pnl-heatmap-board__tile-footer">
                      <span className="pnl-heatmap-board__value">{pnlDisplay}</span>
                      {percentDisplay && (
                        <span className="pnl-heatmap-board__percent">{percentDisplay}</span>
                      )}
                    </div>
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
