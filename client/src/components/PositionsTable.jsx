import PropTypes from 'prop-types';
import {
  formatCurrencyWithCode,
  formatNumber,
  classifyPnL,
  formatSignedCurrency,
} from '../utils/formatters';

function PnlBadge({ value, currency }) {
  const tone = classifyPnL(value);
  return <span className={`positions-table__pnl ${tone}`}>{formatSignedCurrency(value, currency)}</span>;
}

PnlBadge.propTypes = {
  value: PropTypes.number,
  currency: PropTypes.string.isRequired,
};

PnlBadge.defaultProps = {
  value: 0,
};

const TABLE_COLUMNS = [
  'Symbol',
  "Today's P&L",
  'Open P&L',
  'Open qty',
  'Avg price',
  'Symbol price',
  'Market value',
  'Currency',
  '% of portfolio',
];

export default function PositionsTable({ positions, totalMarketValue }) {
  if (!positions.length) {
    return (
      <section className="positions-card">
        <header className="positions-card__header">
          <div className="positions-card__title">Positions</div>
          <span className="positions-card__count">0 holdings</span>
        </header>
        <div className="empty-state">No positions to display.</div>
      </section>
    );
  }

  const aggregateMarketValue =
    totalMarketValue ?? positions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);

  return (
    <section className="positions-card">
      <header className="positions-card__header">
        <div className="positions-card__title">Positions</div>
        <span className="positions-card__count">{positions.length} holdings</span>
      </header>

      <div className="positions-table" role="table">
        <div className="positions-table__row positions-table__row--head" role="row">
          {TABLE_COLUMNS.map((column) => (
            <div key={column} role="columnheader">
              {column}
            </div>
          ))}
        </div>

        {positions.map((position) => {
          const currency = position.currency || 'CAD';
          const share = aggregateMarketValue > 0 ? (position.currentMarketValue / aggregateMarketValue) * 100 : null;

          return (
            <div
              key={`${position.accountNumber || position.accountId}:${position.symbolId}`}
              className="positions-table__row"
              role="row"
            >
              <div className="positions-table__symbol" role="cell">
                <div className="positions-table__symbol-ticker">{position.symbol}</div>
                <div className="positions-table__symbol-name">{position.description || '—'}</div>
                <div className="positions-table__symbol-account">{position.accountNumber}</div>
              </div>
              <div role="cell">
                <PnlBadge value={position.dayPnl} currency={currency} />
              </div>
              <div role="cell">
                <PnlBadge value={position.openPnl} currency={currency} />
              </div>
              <div role="cell">{formatNumber(position.openQuantity, 2)}</div>
              <div role="cell">{formatCurrencyWithCode(position.averageEntryPrice, currency)}</div>
              <div role="cell">{formatCurrencyWithCode(position.currentPrice, currency)}</div>
              <div role="cell">{formatCurrencyWithCode(position.currentMarketValue, currency)}</div>
              <div role="cell" className="positions-table__currency-chip">
                <span>{currency}</span>
              </div>
              <div role="cell">{share === null ? '—' : `${formatNumber(share, 2)}%`}</div>
            </div>
          );
        })}
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
    })
  ).isRequired,
  totalMarketValue: PropTypes.number,
};

PositionsTable.defaultProps = {
  totalMarketValue: null,
};
