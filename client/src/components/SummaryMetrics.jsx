import PropTypes from 'prop-types';
import { formatCurrency, formatPnL } from '../utils/formatters';

function MetricRow({ label, value }) {
  return (
    <div className="metric-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

MetricRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
};

export default function SummaryMetrics({ currencyCode, balances, pnl, asOf }) {
  const totalEquity = balances?.totalEquity;
  const marketValue = balances?.marketValue;
  const cash = balances?.cash;
  const buyingPower = balances?.buyingPower;

  const dayPnl = formatPnL(pnl?.dayPnl ?? null, currencyCode);
  const openPnl = formatPnL(pnl?.openPnl ?? null, currencyCode);

  const dayClassName = ['pnl-badge', dayPnl.tone].join(' ');
  const openClassName = ['pnl-badge', 'subtle', openPnl.tone].join(' ');

  return (
    <section className="summary-card">
      <header>
        <div>
          <h2>Total equity</h2>
          <p className="as-of">As of {new Date(asOf).toLocaleString()}</p>
        </div>
        <div className="equity-value">{formatCurrency(totalEquity, currencyCode)}</div>
      </header>

      <div className="metrics-grid">
        <div className="metric-group">
          <span className={dayClassName}>Today's P&L {dayPnl.formatted}</span>
          <span className={openClassName}>Open P&L {openPnl.formatted}</span>
        </div>
        <MetricRow label="Market value" value={formatCurrency(marketValue, currencyCode)} />
        <MetricRow label="Cash" value={formatCurrency(cash, currencyCode)} />
        <MetricRow label="Buying power" value={formatCurrency(buyingPower, currencyCode)} />
      </div>
    </section>
  );
}

SummaryMetrics.propTypes = {
  currencyCode: PropTypes.string.isRequired,
  balances: PropTypes.shape({
    totalEquity: PropTypes.number,
    marketValue: PropTypes.number,
    cash: PropTypes.number,
    buyingPower: PropTypes.number,
  }),
  pnl: PropTypes.shape({
    dayPnl: PropTypes.number,
    openPnl: PropTypes.number,
  }),
  asOf: PropTypes.string.isRequired,
};

SummaryMetrics.defaultProps = {
  balances: {},
  pnl: { dayPnl: 0, openPnl: 0 },
};
