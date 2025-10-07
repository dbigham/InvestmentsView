import { useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney } from '../utils/formatters';

const COLLAPSE_THRESHOLD = 2;

function resolveCurrencyLabel(currency) {
  if (typeof currency !== 'string') {
    return '';
  }
  const trimmed = currency.trim();
  return trimmed ? trimmed.toUpperCase() : '';
}

export default function TodoSummary({ items, onSelectItem }) {
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
  const listId = `${resolvedHeadingId}-list`;
  const collapsible = safeItems.length > COLLAPSE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(collapsible);
  const previousCountRef = useRef(safeItems.length);

  useEffect(() => {
    const previousCount = previousCountRef.current;
    if (previousCount !== safeItems.length) {
      previousCountRef.current = safeItems.length;
      setCollapsed(safeItems.length > COLLAPSE_THRESHOLD);
      return;
    }
    if (!collapsible && collapsed) {
      setCollapsed(false);
    }
  }, [safeItems.length, collapsible, collapsed]);

  const countLabel = safeItems.length === 1 ? '1 ITEM' : `${safeItems.length} ITEMS`;
  const interactive = typeof onSelectItem === 'function';

  const handleToggle = () => {
    if (!collapsible) {
      return;
    }
    setCollapsed((value) => !value);
  };

  return (
    <section className={`todo-card${collapsed ? ' todo-card--collapsed' : ''}`} aria-labelledby={resolvedHeadingId}>
      <header className="todo-card__header">
        <button
          type="button"
          className="todo-card__toggle"
          onClick={handleToggle}
          aria-expanded={!collapsed}
          aria-controls={collapsible ? listId : undefined}
          disabled={!collapsible}
        >
          <span id={resolvedHeadingId} className="todo-card__title">
            TODOs
          </span>
          <span className="todo-card__count" aria-live="polite">
            {countLabel}
          </span>
          {collapsible && <span className="todo-card__chevron" aria-hidden="true" />}
        </button>
      </header>
      {!collapsed && (
        <ul id={collapsible ? listId : undefined} className="todo-card__list">
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
            const itemInteractive =
              interactive && (item?.type === 'cash' || item?.type === 'rebalance');
            const itemClassName = `todo-card__item todo-card__item--${item?.type || 'generic'}${itemInteractive ? ' todo-card__item--interactive' : ''}`;

            return (
              <li key={key} className={itemClassName}>
                <button
                  type="button"
                  className="todo-card__item-button"
                  onClick={itemInteractive ? () => onSelectItem(item) : undefined}
                  disabled={!itemInteractive}
                >
                  <span className="todo-card__item-title">{titleText}</span>
                  {detailText && <span className="todo-card__item-detail">{detailText}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
      model: PropTypes.string,
      chartKey: PropTypes.string,
    })
  ),
  onSelectItem: PropTypes.func,
};

TodoSummary.defaultProps = {
  items: [],
  onSelectItem: null,
};
