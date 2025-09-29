import PropTypes from 'prop-types';
import TimePill from './TimePill';
import {
  classifyPnL,
  formatMoney,
  formatNumber,
  formatSignedMoney,
  formatSignedPercent,
} from '../utils/formatters';

function MetricRow({ label, value, extra, tone, className }) {
  const rowClass = className ? `equity-card__metric-row ${className}` : 'equity-card__metric-row';
  return (
    <div className={rowClass}>
      <dt>{label}</dt>
      <dd>
        <span className={`equity-card__metric-value equity-card__metric-value--${tone}`}>{value}</span>
        {extra && <span className="equity-card__metric-extra">{extra}</span>}
      </dd>
    </div>
  );
}

MetricRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  extra: PropTypes.node,
  tone: PropTypes.oneOf(['positive', 'negative', 'neutral']).isRequired,
  className: PropTypes.string,
};

MetricRow.defaultProps = {
  extra: null,
  className: '',
};

export default function SummaryMetrics({
  currencyOption,
  currencyOptions,
  onCurrencyChange,
  balances,
  pnl,
  asOf,
  onRefresh,
  displayTotalEquity,
  usdToCadRate,
  onShowBeneficiaries,
  beneficiariesDisabled,
}) {
  const title = 'Total equity (Combined in CAD)';
  const totalEquity = balances?.totalEquity ?? null;
  const marketValue = balances?.marketValue ?? null;
  const cash = balances?.cash ?? null;
  const buyingPower = balances?.buyingPower ?? null;

  const todayTone = classifyPnL(pnl?.dayPnl);
  const openTone = classifyPnL(pnl?.openPnl);
  const totalTone = classifyPnL(pnl?.totalPnl);

  const formattedToday = formatSignedMoney(pnl?.dayPnl ?? null);
  const formattedOpen = formatSignedMoney(pnl?.openPnl ?? null);
  const formattedTotal = formatSignedMoney(pnl?.totalPnl ?? null);

  const safeTotalEquity = typeof totalEquity === 'number' && totalEquity !== 0 ? totalEquity : null;
  const dayPercentValue = safeTotalEquity ? ((pnl?.dayPnl || 0) / safeTotalEquity) * 100 : null;
  const dayPercent =
    dayPercentValue !== null && Number.isFinite(dayPercentValue)
      ? formatSignedPercent(dayPercentValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;

  return (
    <section className="equity-card">
      <header className="equity-card__header">
        <div className="equity-card__heading">
          <h2 className="equity-card__title">{title}</h2>
          <p className="equity-card__value">{formatMoney(displayTotalEquity ?? totalEquity)}</p>
          {usdToCadRate !== null && (
            <p className="equity-card__subtext">
              <span className="equity-card__subtext-label">USD → CAD</span>
              <span className="equity-card__subtext-value">
                {formatNumber(usdToCadRate, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
              </span>
            </p>
          )}
        </div>
        <div className="equity-card__actions">
          {onShowBeneficiaries && (
            <button
              type="button"
              className="equity-card__action-button"
              onClick={onShowBeneficiaries}
              disabled={beneficiariesDisabled}
            >
              Beneficiaries
            </button>
          )}
          <TimePill asOf={asOf} onRefresh={onRefresh} />
        </div>
      </header>

      {currencyOptions.length > 0 && (
        <div className="equity-card__chip-row" role="group" aria-label="Currency views">
          {currencyOptions.map((option) => {
            const isActive = currencyOption?.value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={isActive ? 'active' : ''}
                onClick={() => onCurrencyChange(option.value)}
                aria-pressed={isActive}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="equity-card__metrics">
        <dl className="equity-card__metric-column">
          <MetricRow
            label="Today's P&L"
            value={formattedToday}
            extra={dayPercent ? `(${dayPercent})` : null}
            tone={todayTone}
          />
          <MetricRow label="Open P&L" value={formattedOpen} tone={openTone} />
          <MetricRow label="Total P&L" value={formattedTotal} tone={totalTone} />
        </dl>
        <dl className="equity-card__metric-column">
          <MetricRow label="Total equity" value={formatMoney(totalEquity)} tone="neutral" />
          <MetricRow label="Market value" value={formatMoney(marketValue)} tone="neutral" />
          <MetricRow label="Cash" value={formatMoney(cash)} tone="neutral" />
          <MetricRow label="Buying power" value={formatMoney(buyingPower)} tone="neutral" />
        </dl>
      </div>

    </section>
  );
}

SummaryMetrics.propTypes = {
  currencyOption: PropTypes.shape({
    value: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    scope: PropTypes.string.isRequired,
    currency: PropTypes.string.isRequired,
  }),
  currencyOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      scope: PropTypes.string.isRequired,
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
    totalPnl: PropTypes.number,
  }).isRequired,
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  displayTotalEquity: PropTypes.number,
  usdToCadRate: PropTypes.number,
  onShowBeneficiaries: PropTypes.func,
  beneficiariesDisabled: PropTypes.bool,
};

SummaryMetrics.defaultProps = {
  currencyOption: null,
  balances: null,
  asOf: null,
  onRefresh: null,
  displayTotalEquity: null,
  usdToCadRate: null,
  onShowBeneficiaries: null,
  beneficiariesDisabled: false,
};
