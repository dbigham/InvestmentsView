import { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import TimePill from './TimePill';
import { classifyPnL, formatMoney, formatNumber, formatSignedMoney, formatSignedPercent } from '../utils/formatters';

const TABLE_HEADERS = [
  {
    key: 'symbol',
    label: 'Symbol',
    className: 'positions-table__head--symbol',
    sortType: 'text',
    accessor: (row) => row.symbol || '',
  },
  {
    key: 'dayPnl',
    label: "Today's P&L",
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.dayPnl ?? 0,
  },
  {
    key: 'openPnl',
    label: 'Open P&L',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.openPnl ?? 0,
  },
  {
    key: 'openQuantity',
    label: 'Open qty',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.openQuantity ?? 0,
  },
  {
    key: 'averageEntryPrice',
    label: 'Avg price',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.averageEntryPrice ?? 0,
  },
  {
    key: 'currentPrice',
    label: 'Symbol price',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.currentPrice ?? 0,
  },
  {
    key: 'currentMarketValue',
    label: 'Market value',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.currentMarketValue ?? 0,
  },
  {
    key: 'currency',
    label: 'Currency',
    className: 'positions-table__head--currency',
    sortType: 'text',
    accessor: (row) => row.currency || '',
  },
  {
    key: 'portfolioShare',
    label: '% of portfolio',
    className: 'positions-table__head--numeric',
    sortType: 'number',
    accessor: (row) => row.portfolioShare ?? 0,
  },
];

function resolveTotalCost(position) {
  if (position.totalCost !== undefined && position.totalCost !== null) {
    return position.totalCost;
  }
  if (typeof position.averageEntryPrice === 'number' && typeof position.openQuantity === 'number') {
    return position.averageEntryPrice * position.openQuantity;
  }
  return null;
}

function derivePercentages(position) {
  const currentMarketValue = position.currentMarketValue || 0;
  const dayPnl = position.dayPnl || 0;
  const openPnl = position.openPnl || 0;
  const totalCost = resolveTotalCost(position);

  const previousValue = currentMarketValue - dayPnl;
  const dayPnlPercent = Math.abs(previousValue) > 1e-6 ? (dayPnl / previousValue) * 100 : null;
  const openPnlPercent = totalCost && Math.abs(totalCost) > 1e-6 ? (openPnl / totalCost) * 100 : null;

  return { dayPnlPercent, openPnlPercent };
}

function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const numeric = Number(value);
  const hasFraction = Math.abs(numeric % 1) > 0.0000001;
  return formatNumber(numeric, {
    minimumFractionDigits: hasFraction ? 4 : 0,
    maximumFractionDigits: hasFraction ? 4 : 0,
  });
}

function formatShare(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const numeric = Number(value);
  return `${formatNumber(numeric, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function truncateDescription(value) {
  if (!value) {
    return '\u2014';
  }
  const normalized = String(value);
  if (normalized.length <= 21) {
    return normalized;
  }
  return `${normalized.slice(0, 21).trimEnd()}...`;
}

function buildQuoteUrl(symbol, provider) {
  if (!symbol) {
    return null;
  }
  const normalized = String(symbol).trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  const encoded = encodeURIComponent(normalized);
  if (provider === 'yahoo') {
    return `https://ca.finance.yahoo.com/quote/${encoded}/`;
  }
  return `https://www.google.ca/search?sourceid=chrome-psyapi2&ion=1&espv=2&ie=UTF-8&q=${encoded}%20chart`;
}

function compareRows(header, direction) {
  const multiplier = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const valueA = header.accessor(a);
    const valueB = header.accessor(b);

    if (header.sortType === 'text') {
      const textA = (valueA ?? '').toString().toUpperCase();
      const textB = (valueB ?? '').toString().toUpperCase();
      const comparison = textA.localeCompare(textB);
      if (comparison !== 0) {
        return comparison * multiplier;
      }
    } else {
      const numberA = Number(valueA ?? 0);
      const numberB = Number(valueB ?? 0);
      if (!Number.isNaN(numberA) || !Number.isNaN(numberB)) {
        if (numberA !== numberB) {
          return numberA > numberB ? multiplier : -multiplier;
        }
      }
    }

    const fallback = (a.symbol || '').localeCompare(b.symbol || '', undefined, { sensitivity: 'base' });
    return fallback * multiplier;
  };
}

function PnlBadge({ value, percent, mode, onToggle }) {
  const tone = classifyPnL(value);
  const isPercentMode = mode === 'percent';
  const formatted = isPercentMode
    ? percent !== null && Number.isFinite(percent)
      ? formatSignedPercent(percent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '\u2014'
    : formatSignedMoney(value);

  return (
    <button
      type="button"
      className={`positions-table__pnl ${tone}`}
      onClick={onToggle}
      aria-pressed={isPercentMode}
      title={isPercentMode ? 'Show dollar values' : 'Show percentage values'}
    >
      {formatted}
    </button>
  );
}

PnlBadge.propTypes = {
  value: PropTypes.number,
  percent: PropTypes.number,
  mode: PropTypes.oneOf(['currency', 'percent']).isRequired,
  onToggle: PropTypes.func.isRequired,
};

PnlBadge.defaultProps = {
  value: 0,
  percent: null,
};

function PositionsTable({
  positions,
  totalMarketValue,
  asOf,
  sortColumn,
  sortDirection,
}) {
  const [sortState, setSortState] = useState({ column: sortColumn, direction: sortDirection });
  const [pnlMode, setPnlMode] = useState('currency');

  useEffect(() => {
    setSortState({ column: sortColumn, direction: sortDirection });
  }, [sortColumn, sortDirection]);

  const aggregateMarketValue = useMemo(() => {
    if (typeof totalMarketValue === 'number' && totalMarketValue > 0) {
      return totalMarketValue;
    }
    return positions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);
  }, [positions, totalMarketValue]);

  const decoratedPositions = useMemo(() => {
    if (!positions.length) {
      return [];
    }
    return positions.map((position) => {
      const { dayPnlPercent, openPnlPercent } = derivePercentages(position);
      let share = position.portfolioShare;
      if (typeof share !== 'number') {
        share = aggregateMarketValue > 0 ? ((position.currentMarketValue || 0) / aggregateMarketValue) * 100 : null;
      }
      return {
        ...position,
        portfolioShare: share,
        dayPnlPercent,
        openPnlPercent,
      };
    });
  }, [positions, aggregateMarketValue]);

  const sortedPositions = useMemo(() => {
    const header = TABLE_HEADERS.find((column) => column.key === sortState.column);
    if (!header) {
      return decoratedPositions.slice();
    }
    const sorter = compareRows(header, sortState.direction);
    return decoratedPositions.slice().sort((a, b) => sorter(a, b));
  }, [decoratedPositions, sortState]);

  const handleSort = useCallback((columnKey) => {
    const header = TABLE_HEADERS.find((column) => column.key === columnKey);
    if (!header) {
      return;
    }
    setSortState((current) => {
      if (current.column === columnKey) {
        return { column: columnKey, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      const defaultDirection = header.sortType === 'text' ? 'asc' : 'desc';
      return { column: columnKey, direction: defaultDirection };
    });
  }, []);

  const handleTogglePnlMode = useCallback(() => {
    setPnlMode((mode) => (mode === 'currency' ? 'percent' : 'currency'));
  }, []);

  const handleRowNavigation = useCallback(
    (event, symbol) => {
      if (!symbol) {
        return;
      }
      const element = event.target;
      if (element && typeof element.closest === 'function' && element.closest('button, a')) {
        return;
      }
      const url = buildQuoteUrl(symbol, event.altKey ? 'yahoo' : 'google');
      if (!url) {
        return;
      }
      event.stopPropagation();
      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    []
  );

  if (!positions.length) {
    return (
      <section className="positions-card">
        <header className="positions-card__header">
          <div className="positions-card__tabs" role="tablist" aria-label="Positions data views">
            <button type="button" role="tab" aria-selected="true" className="active">
              Positions
            </button>
          </div>
          <TimePill asOf={asOf} />
        </header>
        <div className="empty-state">No positions to display.</div>
      </section>
    );
  }

  return (
    <section className="positions-card">
      <header className="positions-card__header">
        <div className="positions-card__tabs" role="tablist" aria-label="Positions data views">
          <button type="button" role="tab" aria-selected="true" className="active">
            Positions
          </button>
        </div>
        <TimePill asOf={asOf} />
      </header>

      <div className="positions-table" role="table">
        <div className="positions-table__row positions-table__row--head" role="row">
          {TABLE_HEADERS.map((column) => {
            const isSorted = column.key === sortState.column;
            const sortDirectionValue = isSorted ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none';
            return (
              <div
                key={column.key}
                role="columnheader"
                aria-sort={sortDirectionValue}
                className={`positions-table__head ${column.className}${isSorted ? ' sorted' : ''}`}
              >
                <button type="button" className="positions-table__head-button" onClick={() => handleSort(column.key)}>
                  <span>{column.label}</span>
                  {isSorted && (
                    <span
                      className={`positions-table__sort-indicator ${sortState.direction}`}
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="positions-table__body">
          {sortedPositions.map((position) => {
            const displayShare = formatShare(position.portfolioShare);
            const displayDescription = truncateDescription(position.description);

            return (
              <div
                key={`${position.accountNumber || position.accountId}:${position.symbolId}`}
                className="positions-table__row positions-table__row--clickable"
                role="row"
                onClick={(event) => handleRowNavigation(event, position.symbol)}
              >
                <div className="positions-table__cell positions-table__cell--symbol" role="cell">
                  <div className="positions-table__symbol-ticker">{position.symbol}</div>
                  <div className="positions-table__symbol-name" title={position.description || '\u2014'}>
                    {displayDescription}
                  </div>
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  <PnlBadge
                    value={position.dayPnl}
                    percent={position.dayPnlPercent}
                    mode={pnlMode}
                    onToggle={handleTogglePnlMode}
                  />
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  <PnlBadge
                    value={position.openPnl}
                    percent={position.openPnlPercent}
                    mode={pnlMode}
                    onToggle={handleTogglePnlMode}
                  />
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatQuantity(position.openQuantity)}
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatMoney(position.averageEntryPrice, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatMoney(position.currentPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatMoney(position.currentMarketValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="positions-table__cell positions-table__cell--currency" role="cell">
                  <span>{position.currency || '\u2014'}</span>
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {displayShare}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

PositionsTable.propTypes = {
  positions: PropTypes.arrayOf(
    PropTypes.shape({
      accountId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      accountNumber: PropTypes.string,
      symbol: PropTypes.string.isRequired,
      symbolId: PropTypes.number.isRequired,
      description: PropTypes.string,
      dayPnl: PropTypes.number,
      openPnl: PropTypes.number,
      openQuantity: PropTypes.number,
      averageEntryPrice: PropTypes.number,
      currentPrice: PropTypes.number,
      currentMarketValue: PropTypes.number,
      currency: PropTypes.string,
      portfolioShare: PropTypes.number,
      totalCost: PropTypes.number,
    })
  ).isRequired,
  totalMarketValue: PropTypes.number,
  asOf: PropTypes.string,
  sortColumn: PropTypes.string,
  sortDirection: PropTypes.oneOf(['asc', 'desc']),
};

PositionsTable.defaultProps = {
  totalMarketValue: null,
  asOf: null,
  sortColumn: 'portfolioShare',
  sortDirection: 'desc',
};

export default PositionsTable;
