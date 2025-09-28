import PropTypes from 'prop-types';
import { formatCurrency, formatDateTime, formatPnL } from '../utils/formatters';

const TIMEFRAMES = ['1D', '1W', '1M', '3M', 'YTD', 'ALL'];

function MetricItem({ label, value }) {
  return (
    <div className="equity-card__metric-item">
      <span className="equity-card__metric-label">{label}</span>
      <span className="equity-card__metric-value">{value}</span>
    </div>
  );
}

MetricItem.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
};

export default function SummaryMetrics({
  currencyOption,
  currencyOptions,
  onCurrencyChange,
  balances,
  pnl,
  asOf,
}) {
  const currencyCode = currencyOption?.currency || 'CAD';
  const totalEquity = balances?.totalEquity ?? null;
  const marketValue = balances?.marketValue ?? null;
  const cash = balances?.cash ?? null;
  const buyingPower = balances?.buyingPower ?? null;

  const dayPnl = formatPnL(pnl?.dayPnl ?? null, currencyCode);
  const openPnl = formatPnL(pnl?.openPnl ?? null, currencyCode);

  return (
    <section className="equity-card">
      <div className="equity-card__top">
        <div>
          <div className="equity-card__subtitle">
            Total equity
            {currencyOption ? ` (${currencyOption.label})` : ''}
          </div>
          <div className="equity-card__value">{formatCurrency(totalEquity, currencyCode)}</div>
          <div className="equity-card__timestamp">As of {formatDateTime(asOf)}</div>
        </div>
        {currencyOptions.length > 0 && (
          <div className="equity-card__currency" role="group" aria-label="Currency toggle">
            {currencyOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={currencyOption?.value === option.value ? 'active' : ''}
                onClick={() => onCurrencyChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="equity-card__timeframes" role="group" aria-label="Performance timeframe">
        {TIMEFRAMES.map((label) => (
          <button key={label} type="button" className={label === '1D' ? 'active' : ''}>
            {label}
          </button>
        ))}
      </div>

      <div className="equity-card__metrics">
        <div className="equity-card__pnl">
          <span className={`equity-card__pill ${dayPnl.tone}`}>
            Today&apos;s P&amp;L <strong>{dayPnl.formatted}</strong>
          </span>
          <span className={`equity-card__pill subtle ${openPnl.tone}`}>
            Open P&amp;L <strong>{openPnl.formatted}</strong>
          </span>
        </div>
        <div className="equity-card__metric-grid">
          <MetricItem label="Market value" value={formatCurrency(marketValue, currencyCode)} />
          <MetricItem label="Cash" value={formatCurrency(cash, currencyCode)} />
          <MetricItem label="Buying power" value={formatCurrency(buyingPower, currencyCode)} />
        </div>
      </div>
    </section>
  );
}

SummaryMetrics.propTypes = {
  currencyOption: PropTypes.shape({
    value: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    currency: PropTypes.string.isRequired,
  }),
  currencyOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      currency: PropTypes.string.isRequired,
    })
  ).isRequired,
  onCurrencyChange: PropTypes.func.isRequired,
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
  currencyOption: null,
  balances: {},
  pnl: { dayPnl: 0, openPnl: 0 },
};
