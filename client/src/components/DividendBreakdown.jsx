import PropTypes from 'prop-types';
import { formatMoney, formatNumber, formatDate } from '../utils/formatters';

function formatCurrencyTotals(totals) {
  if (!totals || typeof totals !== 'object') {
    return null;
  }

  const prioritized = Object.entries(totals)
    .map(([currency, value]) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return null;
      }
      const normalizedCurrency = currency ? String(currency).toUpperCase() : '';
      const formatted = `${formatMoney(numeric)}${normalizedCurrency ? ` ${normalizedCurrency}` : ''}`;
      const priority =
        normalizedCurrency === 'CAD'
          ? 0
          : normalizedCurrency === 'USD'
            ? 1
            : normalizedCurrency
            ? 2
            : 3;
      return { formatted, normalizedCurrency, priority };
    })
    .filter(Boolean);

  if (!prioritized.length) {
    return null;
  }

  prioritized.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.normalizedCurrency.localeCompare(b.normalizedCurrency);
  });

  return prioritized.map((entry) => entry.formatted).join(' · ');
}

function formatLastPayment(entry) {
  if (!entry) {
    return '—';
  }
  const dateLabel = entry.lastDate
    ? formatDate(entry.lastDate)
    : entry.lastTimestamp
    ? formatDate(entry.lastTimestamp)
    : null;
  const normalizedCurrency = entry.lastCurrency ? String(entry.lastCurrency).toUpperCase() : '';
  const amountLabel = Number.isFinite(entry.lastAmount)
    ? `${formatMoney(entry.lastAmount)}${normalizedCurrency ? ` ${normalizedCurrency}` : ''}`
    : null;

  if (dateLabel && amountLabel) {
    return `${dateLabel} · ${amountLabel}`;
  }
  if (dateLabel) {
    return dateLabel;
  }
  if (amountLabel) {
    return amountLabel;
  }
  return '—';
}

function formatRange(start, end) {
  const startLabel = start ? formatDate(start) : null;
  const endLabel = end ? formatDate(end) : null;

  if (startLabel && endLabel) {
    if (startLabel === endLabel) {
      return `Since ${startLabel}`;
    }
    return `${startLabel} – ${endLabel}`;
  }
  if (startLabel) {
    return `Since ${startLabel}`;
  }
  if (endLabel) {
    return `Through ${endLabel}`;
  }
  return null;
}

function DividendBreakdown({ summary, variant }) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const variantClass = variant === 'panel' ? ' dividends-card--panel' : '';
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  const hasEntries = entries.length > 0;
  const totalCad = Number.isFinite(summary.totalCad) ? summary.totalCad : null;
  const totalsByCurrencyLabel = formatCurrencyTotals(summary.totalsByCurrency);
  const rangeLabel = formatRange(summary.startDate, summary.endDate);
  const totalCount = Number.isFinite(summary.totalCount) ? summary.totalCount : null;

  const showTitleBlock = Boolean(rangeLabel || totalCount);

  return (
    <section className={`dividends-card${variantClass}`} aria-label="Dividend breakdown">
      <header className="dividends-card__header">
        {showTitleBlock ? (
          <div className="dividends-card__title-block">
            {rangeLabel ? <p className="dividends-card__subtitle">{rangeLabel}</p> : null}
            {totalCount ? (
              <p className="dividends-card__meta">
                {formatNumber(totalCount, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} payouts recorded
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="dividends-card__totals">
          <span className="dividends-card__totals-label">Total received</span>
          <span className="dividends-card__totals-value">
            {Number.isFinite(totalCad) ? `${formatMoney(totalCad)} CAD` : '—'}
          </span>
          {summary.conversionIncomplete ? (
            <span className="dividends-card__totals-note">
              CAD totals include only payouts with available FX rates.
            </span>
          ) : null}
        </div>
      </header>

      {hasEntries ? (
        <div className="dividends-card__table-wrapper">
          <table className="dividends-table">
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Payments</th>
                <th scope="col">Last payment</th>
                <th scope="col">Totals (native)</th>
                <th scope="col">Total (CAD)</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => {
                if (!entry || typeof entry !== 'object') {
                  return null;
                }
                const symbolLabel = entry.displaySymbol || entry.symbol || 'Unknown';
                const rawSymbols = Array.isArray(entry.rawSymbols) ? entry.rawSymbols : [];
                const rawSymbolLabel = rawSymbols.length ? rawSymbols.join(', ') : null;
                const paymentsLabel = Number.isFinite(entry.activityCount)
                  ? formatNumber(entry.activityCount, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
                  : '—';
                const nativeTotalsLabel = formatCurrencyTotals(entry.currencyTotals) || '—';
                const cadLabel = Number.isFinite(entry.cadAmount)
                  ? `${formatMoney(entry.cadAmount)} CAD`
                  : '—';
                const lastPaymentLabel = formatLastPayment(entry);
                const rowKey =
                  entry.symbol ||
                  (rawSymbols.length ? rawSymbols.join('|') : null) ||
                  entry.displaySymbol ||
                  entry.description ||
                  `dividend-${index}`;

                return (
                  <tr key={rowKey}>
                    <td className="dividends-table__cell dividends-table__cell--symbol">
                      <div className="dividends-table__symbol">{symbolLabel}</div>
                      {entry.description ? (
                        <div className="dividends-table__description">{entry.description}</div>
                      ) : null}
                      {rawSymbolLabel && rawSymbolLabel !== symbolLabel ? (
                        <div className="dividends-table__raw">Source code{rawSymbols.length > 1 ? 's' : ''}: {rawSymbolLabel}</div>
                      ) : null}
                    </td>
                    <td className="dividends-table__cell dividends-table__cell--numeric">{paymentsLabel}</td>
                    <td className="dividends-table__cell">{lastPaymentLabel}</td>
                    <td className="dividends-table__cell">{nativeTotalsLabel}</td>
                    <td className="dividends-table__cell dividends-table__cell--numeric">
                      <span>{cadLabel}</span>
                      {entry.conversionIncomplete ? (
                        <span className="dividends-table__note">FX missing</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dividends-card__empty">No dividend activity found for this account.</div>
      )}

      {totalsByCurrencyLabel ? (
        <footer
          className={`dividends-card__footer${hasEntries ? ' dividends-card__footer--flush' : ''}`}
        >
          <span className="dividends-card__footer-label">Totals by currency:</span>
          <span className="dividends-card__footer-value">{totalsByCurrencyLabel}</span>
        </footer>
      ) : null}
    </section>
  );
}

DividendBreakdown.propTypes = {
  summary: PropTypes.shape({
    entries: PropTypes.arrayOf(
      PropTypes.shape({
        symbol: PropTypes.string,
        displaySymbol: PropTypes.string,
        rawSymbols: PropTypes.arrayOf(PropTypes.string),
        description: PropTypes.string,
        currencyTotals: PropTypes.objectOf(PropTypes.number),
        cadAmount: PropTypes.number,
        conversionIncomplete: PropTypes.bool,
        activityCount: PropTypes.number,
        firstDate: PropTypes.string,
        lastDate: PropTypes.string,
        lastTimestamp: PropTypes.string,
        lastAmount: PropTypes.number,
        lastCurrency: PropTypes.string,
      })
    ),
    totalsByCurrency: PropTypes.objectOf(PropTypes.number),
    totalCad: PropTypes.number,
    conversionIncomplete: PropTypes.bool,
    startDate: PropTypes.string,
    endDate: PropTypes.string,
    totalCount: PropTypes.number,
  }),
  variant: PropTypes.oneOf(['card', 'panel']),
};

DividendBreakdown.defaultProps = {
  summary: null,
  variant: 'card',
};

export default DividendBreakdown;
