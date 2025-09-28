import PropTypes from 'prop-types';
import { formatCurrency, formatDateTime, formatPnL, formatPercent } from '../utils/formatters';

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

function toSignedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  const magnitude = formatPercent(Math.abs(value), 2);
  if (value > 0) {
    return `+${magnitude}`;
  }
  if (value < 0) {
    return `-${magnitude}`;
  }
  return magnitude;
}

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

  const dayPnlInfo = formatPnL(pnl?.dayPnl ?? null, currencyCode);
  const openPnlInfo = formatPnL(pnl?.openPnl ?? null, currencyCode);

  const safeDayPnl = typeof pnl?.dayPnl === 'number' ? pnl.dayPnl : null;
  const safeOpenPnl = typeof pnl?.openPnl === 'number' ? pnl.openPnl : null;
  const safeTotalEquity = typeof totalEquity === 'number' && totalEquity !== 0 ? totalEquity : null;
  const safeMarketValue =
    typeof marketValue === 'number' && marketValue !== 0 ? marketValue : safeTotalEquity;

  const dayPnlPercentValue =
    safeDayPnl !== null && safeTotalEquity ? (safeDayPnl / safeTotalEquity) * 100 : null;
  const openPnlPercentValue =
    safeOpenPnl !== null && safeMarketValue ? (safeOpenPnl / safeMarketValue) * 100 : null;

  const dayPnlPercent = toSignedPercent(dayPnlPercentValue);
  const openPnlPercent = toSignedPercent(openPnlPercentValue);

  return (
    <section className="equity-card">
      <header className="equity-card__header">
        <div className="equity-card__heading">
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
      </header>

      <div className="equity-card__summary-row">
        <div className="equity-card__pnl">
          <span className={`equity-card__pill ${dayPnlInfo.tone}`}>
            <span className="equity-card__pill-label">Today&apos;s P&amp;L</span>
            <strong>{dayPnlInfo.formatted}</strong>
            {dayPnlPercent && <span className="equity-card__pill-percent">({dayPnlPercent})</span>}
          </span>
          <span className={`equity-card__pill subtle ${openPnlInfo.tone}`}>
            <span className="equity-card__pill-label">Open P&amp;L</span>
            <strong>{openPnlInfo.formatted}</strong>
            {openPnlPercent && <span className="equity-card__pill-percent">({openPnlPercent})</span>}
          </span>
        </div>
        <button type="button" className="equity-card__balances">
          See all balances
        </button>
      </div>

      <div className="equity-card__metric-grid">
        <MetricItem label="Market value" value={formatCurrency(marketValue, currencyCode)} />
        <MetricItem label="Cash" value={formatCurrency(cash, currencyCode)} />
        <MetricItem label="Buying power" value={formatCurrency(buyingPower, currencyCode)} />
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

