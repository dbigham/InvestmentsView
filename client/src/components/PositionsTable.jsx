import PropTypes from 'prop-types';
import TimePill from './TimePill';
import { classifyPnL, formatMoney, formatNumber, formatSignedMoney } from '../utils/formatters';

function PnlBadge({ value }) {
  const tone = classifyPnL(value);
  return (
    <span className={`positions-table__pnl ${tone}`}>
      {formatSignedMoney(value)}
    </span>
  );
}

PnlBadge.propTypes = {
  value: PropTypes.number,
};

PnlBadge.defaultProps = {
  value: 0,
};

const TABLE_HEADERS = [
  { key: 'symbol', label: 'Symbol', className: 'positions-table__head--symbol' },
  { key: 'dayPnl', label: "Today's P&L", className: 'positions-table__head--numeric' },
  { key: 'openPnl', label: 'Open P&L', className: 'positions-table__head--numeric' },
  { key: 'openQuantity', label: 'Open qty', className: 'positions-table__head--numeric' },
  { key: 'averageEntryPrice', label: 'Avg price', className: 'positions-table__head--numeric' },
  { key: 'currentPrice', label: 'Symbol price', className: 'positions-table__head--numeric' },
  { key: 'currentMarketValue', label: 'Market value', className: 'positions-table__head--numeric' },
  { key: 'currency', label: 'Currency', className: 'positions-table__head--currency' },
  { key: 'portfolioShare', label: '% of portfolio', className: 'positions-table__head--numeric' },
];

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

export default function PositionsTable({
  positions,
  totalMarketValue,
  asOf,
  onRefresh,
  sortColumn,
  sortDirection,
}) {
  const aggregateMarketValue =
    typeof totalMarketValue === 'number' && totalMarketValue > 0
      ? totalMarketValue
      : positions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);

  if (!positions.length) {
    return (
      <section className="positions-card">
        <header className="positions-card__header">
          <div className="positions-card__tabs" role="tablist" aria-label="Positions data views">
            <button type="button" role="tab" aria-selected="true" className="active">
              Positions
            </button>
          </div>
          <TimePill asOf={asOf} onRefresh={onRefresh} />
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
        <TimePill asOf={asOf} onRefresh={onRefresh} />
      </header>

      <div className="positions-table" role="table">
        <div className="positions-table__row positions-table__row--head" role="row">
          {TABLE_HEADERS.map((column) => {
            const isSorted = column.key === sortColumn;
            return (
              <div
                key={column.key}
                role="columnheader"
                className={`positions-table__head ${column.className}${isSorted ? ' sorted' : ''}`}
              >
                <span>{column.label}</span>
                {isSorted && (
                  <span className={`positions-table__sort-indicator ${sortDirection}`} aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>

        <div className="positions-table__body">
          {positions.map((position) => {
            const share =
              typeof position.portfolioShare === 'number'
                ? position.portfolioShare
                : aggregateMarketValue > 0
                ? ((position.currentMarketValue || 0) / aggregateMarketValue) * 100
                : null;

            return (
              <div
                key={`${position.accountNumber || position.accountId}:${position.symbolId}`}
                className="positions-table__row"
                role="row"
              >
                <div className="positions-table__cell positions-table__cell--symbol" role="cell">
                  <div className="positions-table__symbol-ticker">{position.symbol}</div>
                  <div className="positions-table__symbol-name">{position.description || '—'}</div>
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  <PnlBadge value={position.dayPnl} />
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  <PnlBadge value={position.openPnl} />
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
                  <span>{position.currency || '—'}</span>
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatShare(share)}
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
    })
  ).isRequired,
  totalMarketValue: PropTypes.number,
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  sortColumn: PropTypes.string,
  sortDirection: PropTypes.oneOf(['asc', 'desc']),
};

PositionsTable.defaultProps = {
  totalMarketValue: null,
  asOf: null,
  onRefresh: null,
  sortColumn: 'portfolioShare',
  sortDirection: 'desc',
};
