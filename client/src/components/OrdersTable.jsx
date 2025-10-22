import { useMemo, useCallback } from 'react';
import PropTypes from 'prop-types';
import { formatDateTime, formatNumber } from '../utils/formatters';
import { buildQuoteUrl, openQuote } from '../utils/quotes';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatPrice(value, currency) {
  if (!isFiniteNumber(value)) {
    return '—';
  }
  const numeric = Number(value);
  const magnitude = Math.abs(numeric);
  let digits;
  if (magnitude >= 1000) {
    digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  } else if (magnitude >= 1) {
    digits = { minimumFractionDigits: 2, maximumFractionDigits: 3 };
  } else {
    digits = { minimumFractionDigits: 4, maximumFractionDigits: 6 };
  }
  const formatted = formatNumber(numeric, digits);
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatQuantity(value) {
  if (!isFiniteNumber(value)) {
    return '—';
  }
  const numeric = Number(value);
  const hasFraction = Math.abs(numeric % 1) > 0.000001;
  return formatNumber(numeric, {
    minimumFractionDigits: hasFraction ? 4 : 0,
    maximumFractionDigits: hasFraction ? 4 : 0,
  });
}

function normalizeKey(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function formatStatus(value) {
  if (!value) {
    return '—';
  }
  const lookup = {
    executed: 'Executed',
    filled: 'Filled',
    partiallyfilled: 'Partially filled',
    partiallyfilledthencancelled: 'Partially filled',
    partialfill: 'Partially filled',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    rejected: 'Rejected',
    open: 'Open',
    pending: 'Pending',
    queued: 'Queued',
    expired: 'Expired',
    halted: 'Halted',
  };
  const normalized = normalizeKey(value);
  if (lookup[normalized]) {
    return lookup[normalized];
  }
  const spaced = String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function classifyStatus(value) {
  const normalized = normalizeKey(value);
  if (!normalized) {
    return 'pending';
  }
  if (normalized === 'executed' || normalized === 'filled' || normalized === 'partialfill' || normalized === 'partiallyfilled') {
    return 'executed';
  }
  if (normalized === 'rejected' || normalized === 'failed') {
    return 'negative';
  }
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'expired' || normalized === 'halted') {
    return 'cancelled';
  }
  return 'pending';
}

function formatTimeInForce(value) {
  if (!value) {
    return { label: '—', title: undefined };
  }
  const normalized = normalizeKey(value);
  const specialLookup = {
    goodtillcancelled: { label: 'GTC', title: 'Good till canceled' },
    goodtillcanceled: { label: 'GTC', title: 'Good till canceled' },
    gtcd: { label: 'GTC', title: 'Good till canceled' },
    goodtillextendedday: { label: 'GTED', title: 'Good till extended day' },
  };
  if (specialLookup[normalized]) {
    return specialLookup[normalized];
  }

  const defaultLookup = {
    day: { label: 'Day', title: undefined },
    goodtildate: { label: 'Good till date', title: undefined },
    ioc: { label: 'Immediate or cancel', title: undefined },
    fok: { label: 'Fill or kill', title: undefined },
  };

  if (defaultLookup[normalized]) {
    return defaultLookup[normalized];
  }

  return { label: value, title: undefined };
}

function truncateDescription(value) {
  if (!value) {
    return '—';
  }
  const normalized = String(value);
  if (normalized.length <= 21) {
    return normalized;
  }
  return `${normalized.slice(0, 21).trimEnd()}...`;
}

function formatAction(value) {
  if (!value) {
    return '—';
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return '—';
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function resolveAccount(accountsById, accountId) {
  if (!accountId) {
    return null;
  }
  if (accountsById instanceof Map) {
    return accountsById.get(accountId) || null;
  }
  if (accountsById && typeof accountsById === 'object') {
    return accountsById[accountId] || null;
  }
  return null;
}

function formatAccountLabel(order, accountsById) {
  const account = resolveAccount(accountsById, order.accountId);
  const displayName = (order.displayName && order.displayName.trim()) ||
    (account && typeof account.displayName === 'string' && account.displayName.trim()) ||
    (account && typeof account.name === 'string' && account.name.trim()) ||
    (order.accountNumber ? String(order.accountNumber).trim() : '') ||
    (account && account.number ? String(account.number).trim() : '');
  const ownerLabel = order.accountOwnerLabel ||
    (account && typeof account.ownerLabel === 'string' && account.ownerLabel.trim()) ||
    (account && typeof account.loginLabel === 'string' && account.loginLabel.trim()) ||
    null;

  if (displayName && ownerLabel && ownerLabel !== displayName) {
    return { label: displayName, owner: ownerLabel };
  }
  return { label: displayName || '—', owner: null };
}

function OrdersTable({ orders, accountsById, showAccountColumn, emptyMessage }) {
  const sortedOrders = useMemo(() => {
    if (!Array.isArray(orders)) {
      return [];
    }
    return orders
      .filter((order) => order && (order.creationTime || order.updateTime || order.symbol))
      .slice()
      .sort((a, b) => {
        const timeA = Date.parse(a.creationTime || a.updateTime || 0);
        const timeB = Date.parse(b.creationTime || b.updateTime || 0);
        if (Number.isNaN(timeA) && Number.isNaN(timeB)) {
          return String(b.symbol || '').localeCompare(String(a.symbol || ''));
        }
        if (Number.isNaN(timeA)) {
          return 1;
        }
        if (Number.isNaN(timeB)) {
          return -1;
        }
        return timeB - timeA;
      });
  }, [orders]);

  const hasOrders = sortedOrders.length > 0;

  const handleRowNavigation = useCallback((event, symbol) => {
    if (!symbol) {
      return;
    }

    const element = event.target;
    if (element && typeof element.closest === 'function' && element.closest('button, a')) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      const questradeUrl = buildQuoteUrl(symbol, 'questrade');
      if (!questradeUrl) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openQuote(symbol, 'questrade');
      return;
    }

    const provider = event.altKey ? 'yahoo' : 'google';
    const url = buildQuoteUrl(symbol, provider);
    if (!url) {
      return;
    }

    event.stopPropagation();
    openQuote(symbol, provider);
  }, []);

  return (
    <section className="orders-panel" aria-label="Recent orders">
      <div className="orders-table__wrapper">
        {hasOrders ? (
          <table className="orders-table">
            <thead>
              <tr>
                {showAccountColumn ? <th scope="col">Account</th> : null}
                <th scope="col">Symbol</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
                <th scope="col">Price</th>
                <th scope="col">Duration</th>
                <th scope="col" className="orders-table__head--numeric">Qty</th>
                <th scope="col">Time placed</th>
              </tr>
            </thead>
            <tbody>
              {sortedOrders.map((order, index) => {
                const rowKey = order.orderId || order.id || `${order.symbol || 'order'}-${index}`;
                const accountCell = showAccountColumn ? formatAccountLabel(order, accountsById) : null;
                const statusLabel = formatStatus(order.status);
                const statusClass = `orders-table__status orders-table__status--${classifyStatus(order.status)}`;
                const priceSource = isFiniteNumber(order.limitPrice)
                  ? order.limitPrice
                  : isFiniteNumber(order.avgExecPrice)
                    ? order.avgExecPrice
                    : isFiniteNumber(order.lastExecPrice)
                      ? order.lastExecPrice
                      : null;
                const priceLabel = formatPrice(priceSource, order.currency || null);
                const priceTitle = isFiniteNumber(order.limitPrice) && isFiniteNumber(order.avgExecPrice)
                  ? `Limit ${formatPrice(order.limitPrice, order.currency || null)} · Avg exec ${formatPrice(order.avgExecPrice, order.currency || null)}`
                  : isFiniteNumber(order.avgExecPrice) && !isFiniteNumber(order.limitPrice)
                    ? 'Average execution price'
                    : undefined;
                const quantityValue = isFiniteNumber(order.totalQuantity)
                  ? order.totalQuantity
                  : isFiniteNumber(order.filledQuantity)
                    ? order.filledQuantity
                    : order.openQuantity;
                const quantityLabel = formatQuantity(quantityValue);
                const descriptionTitle = order.description ? String(order.description) : undefined;
                const descriptionLabel = order.description ? truncateDescription(order.description) : null;
                const timeInForceDisplay = formatTimeInForce(order.timeInForce);
                const quantityTitleParts = [];
                if (isFiniteNumber(order.filledQuantity)) {
                  quantityTitleParts.push(`Filled ${formatQuantity(order.filledQuantity)}`);
                }
                if (isFiniteNumber(order.openQuantity)) {
                  quantityTitleParts.push(`Open ${formatQuantity(order.openQuantity)}`);
                }
                const quantityTitle = quantityTitleParts.length ? quantityTitleParts.join(' · ') : undefined;
                const timeLabel = order.creationTime || order.updateTime ? formatDateTime(order.creationTime || order.updateTime) : '—';

                return (
                  <tr
                    key={rowKey}
                    className="orders-table__row orders-table__row--clickable"
                    onClick={(event) => handleRowNavigation(event, order.symbol)}
                  >
                    {showAccountColumn ? (
                      <td className="orders-table__cell">
                        <div className="orders-table__account-label">{accountCell.label}</div>
                      </td>
                    ) : null}
                    <td className="orders-table__cell orders-table__cell--symbol">
                      <div className="orders-table__symbol">{order.symbol || '—'}</div>
                      {descriptionLabel ? (
                        <div className="orders-table__description" title={descriptionTitle}>
                          {descriptionLabel}
                        </div>
                      ) : null}
                    </td>
                    <td className="orders-table__cell">
                      <span className={statusClass}>{statusLabel}</span>
                    </td>
                    <td className="orders-table__cell">{formatAction(order.action)}</td>
                    <td className="orders-table__cell orders-table__cell--numeric" title={priceTitle}>
                      {priceLabel}
                    </td>
                    <td className="orders-table__cell">
                      {timeInForceDisplay.title ? (
                        <span title={timeInForceDisplay.title}>{timeInForceDisplay.label}</span>
                      ) : (
                        timeInForceDisplay.label
                      )}
                    </td>
                    <td className="orders-table__cell orders-table__cell--numeric" title={quantityTitle}>
                      {quantityLabel}
                    </td>
                    <td className="orders-table__cell">{timeLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="orders-table__empty">{emptyMessage}</div>
        )}
      </div>
    </section>
  );
}

OrdersTable.propTypes = {
  orders: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      orderId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      accountId: PropTypes.string,
      accountNumber: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      symbol: PropTypes.string,
      description: PropTypes.string,
      status: PropTypes.string,
      action: PropTypes.string,
      type: PropTypes.string,
      timeInForce: PropTypes.string,
      limitPrice: PropTypes.number,
      avgExecPrice: PropTypes.number,
      lastExecPrice: PropTypes.number,
      totalQuantity: PropTypes.number,
      filledQuantity: PropTypes.number,
      openQuantity: PropTypes.number,
      creationTime: PropTypes.string,
      updateTime: PropTypes.string,
      currency: PropTypes.string,
    })
  ),
  accountsById: PropTypes.oneOfType([
    PropTypes.instanceOf(Map),
    PropTypes.object,
  ]),
  showAccountColumn: PropTypes.bool,
  emptyMessage: PropTypes.string,
};

OrdersTable.defaultProps = {
  orders: [],
  accountsById: null,
  showAccountColumn: false,
  emptyMessage: 'No orders found for this period.',
};

export default OrdersTable;
