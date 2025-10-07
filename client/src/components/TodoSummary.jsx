import { useId } from 'react';
import PropTypes from 'prop-types';
import { formatMoney } from '../utils/formatters';

function resolveCurrencyLabel(currency) {
  if (typeof currency !== 'string') {
    return '';
  }
  const trimmed = currency.trim();
  return trimmed ? trimmed.toUpperCase() : '';
}

export default function TodoSummary({ items }) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!safeItems.length) {
    return null;
  }

  const headingId = useId();
  const resolvedHeadingId = headingId || 'todo-card-title';
  const accountIds = new Set();
  safeItems.forEach((item) => {
    if (item && item.accountId) {
      accountIds.add(item.accountId);
    }
  });
  const showAccountContext = accountIds.size > 1;

  return (
    <section className="todo-card" aria-labelledby={resolvedHeadingId}>
      <header className="todo-card__header">
        <h2 id={resolvedHeadingId} className="todo-card__title">
          TODOs
        </h2>
        <span className="todo-card__count" aria-live="polite">
          {safeItems.length === 1 ? '1 item' : `${safeItems.length} items`}
        </span>
      </header>
      <ul className="todo-card__list">
        {safeItems.map((item, index) => {
          const key = item?.id || `${item?.type || 'todo'}-${item?.accountId || index}-${index}`;
          const detailParts = [];
          if (showAccountContext && item?.accountLabel) {
            detailParts.push(item.accountLabel);
          }
          if (Array.isArray(item?.details)) {
            item.details
              .map((detail) => (typeof detail === 'string' ? detail.trim() : ''))
              .filter(Boolean)
              .forEach((detail) => detailParts.push(detail));
          }
          if (item?.type === 'rebalance' && item?.lastRebalance) {
            detailParts.push(`Last rebalanced ${item.lastRebalance}`);
          }

          let titleText = 'Review portfolio';
          if (item?.type === 'cash') {
            const currency = resolveCurrencyLabel(item.currency);
            const amountText = Number.isFinite(item?.amount)
              ? formatMoney(item.amount)
              : null;
            if (currency && amountText) {
              titleText = `Invest available ${currency} cash (${amountText} ${currency})`;
            } else if (currency) {
              titleText = `Invest available ${currency} cash`;
            } else if (amountText) {
              titleText = `Invest available cash (${amountText})`;
            } else {
              titleText = 'Invest available cash';
            }
          } else if (item?.type === 'rebalance') {
            const modelLabel = item?.modelLabel || 'Investment model';
            titleText = `Rebalance ${modelLabel}`;
          } else if (typeof item?.title === 'string' && item.title.trim()) {
            titleText = item.title.trim();
          }

          const detailText = detailParts.filter(Boolean).join(' • ');

          return (
            <li key={key} className={`todo-card__item todo-card__item--${item?.type || 'generic'}`}>
              <span className="todo-card__item-title">{titleText}</span>
              {detailText && <span className="todo-card__item-detail">{detailText}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

TodoSummary.propTypes = {
  items: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      type: PropTypes.string,
      accountId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      accountLabel: PropTypes.string,
      currency: PropTypes.string,
      amount: PropTypes.number,
      modelLabel: PropTypes.string,
      lastRebalance: PropTypes.string,
      title: PropTypes.string,
      details: PropTypes.arrayOf(PropTypes.string),
    })
  ),
};

TodoSummary.defaultProps = {
  items: [],
};
