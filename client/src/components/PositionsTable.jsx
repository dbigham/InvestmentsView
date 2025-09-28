import PropTypes from 'prop-types';
import {
  formatCurrencyWithCode,
  formatNumber,
  classifyPnL,
  formatSignedCurrency,
} from '../utils/formatters';

function PnlBadge({ value, currency }) {
  const tone = classifyPnL(value);
  return (
    <span className={`positions-table__pnl ${tone}`}>
      <span className="positions-table__pnl-value">{formatSignedCurrency(value, currency)}</span>
    </span>
  );
}

PnlBadge.propTypes = {
  value: PropTypes.number,
  currency: PropTypes.string.isRequired,
};

PnlBadge.defaultProps = {
  value: 0,
};

const TABLE_HEADERS = [
  { label: 'Symbol', className: 'positions-table__head--symbol' },
  { label: "Today's P&L", className: 'positions-table__head--numeric' },
  { label: 'Open P&L', className: 'positions-table__head--numeric' },
  { label: 'Open qty', className: 'positions-table__head--numeric' },
  { label: 'Avg price', className: 'positions-table__head--numeric' },
  { label: 'Symbol price', className: 'positions-table__head--numeric' },
  { label: 'Market value', className: 'positions-table__head--numeric' },
  { label: 'Currency', className: 'positions-table__head--currency' },
  { label: '% of portfolio', className: 'positions-table__head--numeric' },
];

function normalizeLabel(value) {
  if (!value) return '';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTitle(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return '';
  return normalized
    .split(' ')
    .map((word) => {
      if (word.length <= 3 && word === word.toUpperCase()) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function buildAccountDescriptor(position) {
  const fragments = [];
  const primaryDescriptor = toTitle(position.accountType);
  if (primaryDescriptor) {
    fragments.push(primaryDescriptor);
  }
  const accountId = position.accountNumber || position.accountId;
  if (accountId) {
    fragments.push(`#${accountId}`);
  }
  return fragments.join(' \\u2022 ');
}

export default function PositionsTable({ positions, totalMarketValue }) {
  const header = (
    <header className="positions-card__header">
      <div className="positions-card__tabs" role="tablist" aria-label="Positions data views">
        <button type="button" role="tab" aria-selected="true" className="active">
          Positions
        </button>
      </div>
      <span className="positions-card__count">{positions.length} holdings</span>
    </header>
  );

  if (!positions.length) {
    return (
      <section className="positions-card">
        {header}
        <div className="empty-state">No positions to display.</div>
      </section>
    );
  }

  const aggregateMarketValue =
    totalMarketValue ?? positions.reduce((acc, position) => acc + (position.currentMarketValue || 0), 0);

  return (
    <section className="positions-card">
      {header}

      <div className="positions-table" role="table">
        <div className="positions-table__row positions-table__row--head" role="row">
          {TABLE_HEADERS.map((column) => (
            <div
              key={column.label}
              role="columnheader"
              className={`positions-table__head ${column.className}`}
            >
              {column.label}
            </div>
          ))}
        </div>

        <div className="positions-table__body">
          {positions.map((position) => {
            const currency = position.currency || 'CAD';
            const share = aggregateMarketValue > 0 ? (position.currentMarketValue / aggregateMarketValue) * 100 : null;
            const accountDescriptor = buildAccountDescriptor(position);

            return (
              <div
                key={`${position.accountNumber || position.accountId}:${position.symbolId}`}
                className="positions-table__row"
                role="row"
              >
                <div className="positions-table__cell positions-table__cell--symbol" role="cell">
                  <div className="positions-table__symbol-ticker">{position.symbol}</div>
                  <div className="positions-table__symbol-name">{position.description || '—'}</div>
                  <div className="positions-table__symbol-account">{accountDescriptor}</div>
                </div>
                <div className="positions-table__cell positions-table__cell--pnl" role="cell">
                  <PnlBadge value={position.dayPnl} currency={currency} />
                </div>
                <div className="positions-table__cell positions-table__cell--pnl" role="cell">
                  <PnlBadge value={position.openPnl} currency={currency} />
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatNumber(position.openQuantity, 2)}
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatCurrencyWithCode(position.averageEntryPrice, currency)}
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatCurrencyWithCode(position.currentPrice, currency)}
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {formatCurrencyWithCode(position.currentMarketValue, currency)}
                </div>
                <div className="positions-table__cell positions-table__cell--currency" role="cell">
                  <span>{currency}</span>
                </div>
                <div className="positions-table__cell positions-table__cell--numeric" role="cell">
                  {share === null ? '—' : `${formatNumber(share, 2)}%`}
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
      accountType: PropTypes.string,
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

