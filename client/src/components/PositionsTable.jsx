import PropTypes from 'prop-types';
import { formatCurrency, formatNumber, classifyPnL } from '../utils/formatters';

function PnlCell({ value, currency }) {
  const tone = classifyPnL(value);
  return <span className={'pnl-value ' + tone}>{formatCurrency(value, currency)}</span>;
}

PnlCell.propTypes = {
  value: PropTypes.number,
  currency: PropTypes.string.isRequired,
};

PnlCell.defaultProps = {
  value: 0,
};

export default function PositionsTable({ positions }) {
  if (!positions.length) {
    return (
      <section className="positions-card">
        <header>
          <h2>Positions</h2>
        </header>
        <div className="empty-state">No positions to display.</div>
      </section>
    );
  }

  return (
    <section className="positions-card">
      <header>
        <h2>Positions</h2>
        <span className="count">{positions.length} holdings</span>
      </header>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Today's P&L</th>
              <th>Open P&L</th>
              <th>Open qty</th>
              <th>Avg price</th>
              <th>Symbol price</th>
              <th>Market value</th>
              <th>Currency</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.accountId + ':' + position.symbolId}>
                <td>
                  <div className="symbol-cell">
                    <span className="symbol">{position.symbol}</span>
                    <span className="description">{position.description || '—'}</span>
                    <span className="account">{position.accountNumber}</span>
                  </div>
                </td>
                <td>
                  <PnlCell value={position.dayPnl} currency={position.currency || 'CAD'} />
                </td>
                <td>
                  <PnlCell value={position.openPnl} currency={position.currency || 'CAD'} />
                </td>
                <td>{formatNumber(position.openQuantity, 2)}</td>
                <td>{formatCurrency(position.averageEntryPrice, position.currency || 'CAD')}</td>
                <td>{formatCurrency(position.currentPrice, position.currency || 'CAD')}</td>
                <td>{formatCurrency(position.currentMarketValue, position.currency || 'CAD')}</td>
                <td>{position.currency || 'CAD'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

PositionsTable.propTypes = {
  positions: PropTypes.arrayOf(
    PropTypes.shape({
      accountId: PropTypes.number.isRequired,
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
};
