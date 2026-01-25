import { useEffect, useId, useMemo } from 'react';
import PropTypes from 'prop-types';
import { formatDateTime, formatMoney, formatPercent } from '../utils/formatters';
import {
  aggregatePositionsByMergedSymbol,
  resolveHoldingsDisplaySymbol,
} from '../utils/holdings';

const MIN_VISIBLE_HOLDINGS = 4;
const MAX_VISIBLE_HOLDINGS = 8;
const MIN_HOLDING_SHARE_PERCENT = 2;
const TARGET_COVERAGE_PERCENT = 90;

const PIE_SLICE_COLORS = [
  '#2f855a',
  '#2b6cb0',
  '#dd6b20',
  '#319795',
  '#805ad5',
  '#d69e2e',
  '#c53030',
  '#4a5568',
];
const OTHER_SLICE_COLOR = '#9aa3b2';

const CHART_VIEWBOX_SIZE = 240;
const CHART_CENTER = CHART_VIEWBOX_SIZE / 2;
const OUTER_RADIUS = CHART_VIEWBOX_SIZE / 2 - 10;
const INNER_RADIUS = OUTER_RADIUS * 0.62;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

// Build a donut chart slice path for a start/end angle in degrees.
function buildDonutPath(centerX, centerY, outerRadius, innerRadius, startAngle, endAngle) {
  const adjustedEndAngle = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const startOuter = polarToCartesian(centerX, centerY, outerRadius, startAngle);
  const endOuter = polarToCartesian(centerX, centerY, outerRadius, adjustedEndAngle);
  const startInner = polarToCartesian(centerX, centerY, innerRadius, adjustedEndAngle);
  const endInner = polarToCartesian(centerX, centerY, innerRadius, startAngle);
  const largeArcFlag = adjustedEndAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${endInner.x} ${endInner.y}`,
    'Z',
  ].join(' ');
}

function buildHoldingsPieSlices(positions) {
  const merged = aggregatePositionsByMergedSymbol(positions);
  const holdings = merged
    .map((entry) => {
      const marketValue = isFiniteNumber(entry.normalizedMarketValue)
        ? entry.normalizedMarketValue
        : isFiniteNumber(entry.currentMarketValue)
        ? entry.currentMarketValue
        : 0;
      return {
        id: entry.id || entry.symbol,
        symbol: entry.symbol,
        label: resolveHoldingsDisplaySymbol(entry.symbol),
        description: entry.description || null,
        marketValue,
        rawSymbols: Array.isArray(entry.rawSymbols) ? entry.rawSymbols : [],
      };
    })
    .filter((entry) => entry.marketValue > 0);

  if (!holdings.length) {
    return { slices: [], totalMarketValue: 0 };
  }

  holdings.sort((a, b) => b.marketValue - a.marketValue);

  const totalMarketValue = holdings.reduce((sum, entry) => sum + entry.marketValue, 0);
  if (!isFiniteNumber(totalMarketValue) || totalMarketValue <= 0) {
    return { slices: [], totalMarketValue: 0 };
  }

  const slices = [];
  let otherMarketValue = 0;
  let otherCount = 0;
  let coverage = 0;

  holdings.forEach((entry) => {
    const share = (entry.marketValue / totalMarketValue) * 100;
    const mustInclude = slices.length < MIN_VISIBLE_HOLDINGS;
    const hasRoom = slices.length < MAX_VISIBLE_HOLDINGS;
    const meetsShareThreshold = share >= MIN_HOLDING_SHARE_PERCENT;
    const needsCoverage = coverage < TARGET_COVERAGE_PERCENT;

    if (hasRoom && (mustInclude || meetsShareThreshold || needsCoverage)) {
      slices.push({ ...entry, share });
      coverage += share;
    } else {
      otherMarketValue += entry.marketValue;
      otherCount += 1;
    }
  });

  if (otherMarketValue > 0) {
    slices.push({
      id: 'other',
      symbol: 'OTHER',
      label: 'Other',
      description: null,
      marketValue: otherMarketValue,
      share: (otherMarketValue / totalMarketValue) * 100,
      rawSymbols: [],
      isOther: true,
      otherCount,
    });
  }

  return { slices, totalMarketValue };
}

export default function HoldingsPieChartDialog({
  positions,
  accountLabel,
  asOf,
  baseCurrency,
  onClose,
}) {
  const titleId = useId();

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const { slices, totalMarketValue } = useMemo(
    () => buildHoldingsPieSlices(positions),
    [positions]
  );

  const chartSlices = useMemo(() => {
    if (!slices.length) {
      return [];
    }
    let currentAngle = 0;
    return slices.map((slice, index) => {
      const sweep = slice.share * 3.6;
      const startAngle = currentAngle;
      const endAngle = index === slices.length - 1 ? 360 : currentAngle + sweep;
      currentAngle = endAngle;
      const color = slice.isOther ? OTHER_SLICE_COLOR : PIE_SLICE_COLORS[index % PIE_SLICE_COLORS.length];
      return {
        ...slice,
        startAngle,
        endAngle,
        color,
      };
    });
  }, [slices]);

  const normalizedAccountLabel =
    typeof accountLabel === 'string' && accountLabel.trim() ? accountLabel.trim() : null;
  const normalizedBaseCurrency =
    typeof baseCurrency === 'string' && baseCurrency.trim() ? baseCurrency.trim().toUpperCase() : null;
  const subtitle = normalizedBaseCurrency
    ? `By market value (${normalizedBaseCurrency})`
    : 'By market value';
  const asOfDisplay = asOf ? formatDateTime(asOf) : null;

  return (
    <div className="holdings-pie-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="holdings-pie-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="holdings-pie-dialog__header">
          <div className="holdings-pie-dialog__heading">
            <h2 id={titleId}>Top holdings</h2>
            <p className="holdings-pie-dialog__subtitle">{subtitle}</p>
            {normalizedAccountLabel && (
              <p className="holdings-pie-dialog__meta">{normalizedAccountLabel}</p>
            )}
            {asOfDisplay && <p className="holdings-pie-dialog__meta">As of {asOfDisplay}</p>}
          </div>
          <button
            type="button"
            className="holdings-pie-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </header>

        <div className="holdings-pie-dialog__body">
          {chartSlices.length ? (
            <div className="holdings-pie-dialog__content">
              <div className="holdings-pie-chart" role="img" aria-label="Top holdings pie chart">
                <svg viewBox={`0 0 ${CHART_VIEWBOX_SIZE} ${CHART_VIEWBOX_SIZE}`}>
                  {chartSlices.map((slice) => {
                    const percentLabel = formatPercent(slice.share, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    });
                    const valueLabel = formatMoney(slice.marketValue);
                    const rawSymbols =
                      Array.isArray(slice.rawSymbols) && slice.rawSymbols.length
                        ? slice.rawSymbols.join(', ')
                        : null;
                    const tooltipParts = [
                      slice.label,
                      `${percentLabel} of total`,
                      valueLabel,
                      rawSymbols ? `Symbols: ${rawSymbols}` : null,
                    ].filter(Boolean);
                    const tooltip = tooltipParts.join('\n');
                    return (
                      <path
                        key={slice.id}
                        d={buildDonutPath(
                          CHART_CENTER,
                          CHART_CENTER,
                          OUTER_RADIUS,
                          INNER_RADIUS,
                          slice.startAngle,
                          slice.endAngle
                        )}
                        fill={slice.color}
                        title={tooltip}
                      />
                    );
                  })}
                </svg>
              </div>
              <ul className="holdings-pie-legend">
                {chartSlices.map((slice) => {
                  const percentLabel = formatPercent(slice.share, {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  });
                  const valueLabel = formatMoney(slice.marketValue);
                  const subtitleText =
                    slice.isOther && slice.otherCount ? `${slice.otherCount} holdings` : null;
                  return (
                    <li key={slice.id} className="holdings-pie-legend__item">
                      <span
                        className="holdings-pie-legend__swatch"
                        style={{ backgroundColor: slice.color }}
                        aria-hidden="true"
                      />
                      <div className="holdings-pie-legend__info">
                        <span className="holdings-pie-legend__label">{slice.label}</span>
                        {subtitleText && (
                          <span className="holdings-pie-legend__subtitle">{subtitleText}</span>
                        )}
                      </div>
                      <div className="holdings-pie-legend__values">
                        <span className="holdings-pie-legend__percent">{percentLabel}</span>
                        <span className="holdings-pie-legend__value">{valueLabel}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="holdings-pie-dialog__empty">No holdings available.</p>
          )}
        </div>

        <footer className="holdings-pie-dialog__footer">
          <span className="holdings-pie-dialog__total-label">Total market value</span>
          <span className="holdings-pie-dialog__total-value">{formatMoney(totalMarketValue)}</span>
        </footer>
      </div>
    </div>
  );
}

HoldingsPieChartDialog.propTypes = {
  positions: PropTypes.arrayOf(PropTypes.object).isRequired,
  accountLabel: PropTypes.string,
  asOf: PropTypes.string,
  baseCurrency: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};

HoldingsPieChartDialog.defaultProps = {
  accountLabel: null,
  asOf: null,
  baseCurrency: 'CAD',
};
