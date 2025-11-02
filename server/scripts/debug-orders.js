require('dotenv').config();

const path = require('path');
const server = require(path.join(__dirname, '..', 'src', 'index.js'));

function clampDate(date, minDate) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return null;
  }
  if (!(minDate instanceof Date) || Number.isNaN(minDate.getTime())) {
    return new Date(date.getTime());
  }
  return date < minDate ? new Date(minDate.getTime()) : new Date(date.getTime());
}

const MIN_ACTIVITY_DATE = new Date('2000-01-01T00:00:00Z');
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const RECENT_ORDERS_LOOKBACK_DAYS = 90;

const crypto = require('crypto');

const TRADE_ACTIVITY_EXCLUDE_REGEX = /(dividend|distribution|interest|fee|commission|transfer|journal|tax|withholding)/i;
const TRADE_ACTIVITY_KEYWORD_REGEX = /(buy|sell|short|cover|exercise|assign|assignment|option|trade)/i;

function isOrderLikeActivity(activity) {
  if (!activity || typeof activity !== 'object') {
    return false;
  }
  const quantity = Number(activity.quantity);
  if (!Number.isFinite(quantity) || Math.abs(quantity) <= 1e-8) {
    return false;
  }
  const type = typeof activity.type === 'string' ? activity.type : '';
  const action = typeof activity.action === 'string' ? activity.action : '';
  const description = typeof activity.description === 'string' ? activity.description : '';
  const combined = [type, action, description].join(' ');
  if (TRADE_ACTIVITY_EXCLUDE_REGEX.test(combined)) {
    return false;
  }
  return TRADE_ACTIVITY_KEYWORD_REGEX.test(combined);
}

function resolveActivityOrderAction(activity, rawQuantity) {
  if (activity && typeof activity.action === 'string') {
    const trimmed = activity.action.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (Number.isFinite(rawQuantity)) {
    if (rawQuantity > 0) return 'Buy';
    if (rawQuantity < 0) return 'Sell';
  }
  return 'Trade';
}

function resolveActivityOrderPrice(activity, rawQuantity) {
  const price = Number(activity.price);
  if (Number.isFinite(price) && Math.abs(price) > 1e-8) {
    return Math.abs(price);
  }
  const grossAmount = Number(activity.grossAmount);
  if (Number.isFinite(grossAmount) && Number.isFinite(rawQuantity) && Math.abs(rawQuantity) > 1e-8) {
    const derived = Math.abs(grossAmount / rawQuantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }
  const netAmount = Number(activity.netAmount);
  if (Number.isFinite(netAmount) && Number.isFinite(rawQuantity) && Math.abs(rawQuantity) > 1e-8) {
    const derived = Math.abs(netAmount / rawQuantity);
    if (Number.isFinite(derived) && derived > 0) {
      return derived;
    }
  }
  return null;
}

function resolveActivityOrderCommission(activity) {
  if (!activity || typeof activity !== 'object') {
    return null;
  }
  const fields = ['commission', 'commissionUsd', 'commissionCad', 'commissionCdn', 'commissionCharged'];
  for (const field of fields) {
    const value = Number(activity[field]);
    if (Number.isFinite(value) && Math.abs(value) > 1e-8) {
      return Math.abs(value);
    }
  }
  return null;
}

function buildActivityOrderIdentifierKey(accountKey, symbol, timestamp, action, quantity) {
  const parts = [
    accountKey ? String(accountKey).trim().toUpperCase() : '',
    symbol ? String(symbol).trim().toUpperCase() : '',
    timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : '',
    action ? String(action).trim().toUpperCase() : '',
    Number.isFinite(quantity) ? quantity.toFixed(8) : '',
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function normalizeCurrency(code) {
  if (typeof code !== 'string') return null;
  return code.trim().toUpperCase();
}

function convertActivityToOrder(activity, context) {
  if (!context || !context.account || !context.login) {
    return null;
  }
  if (!isOrderLikeActivity(activity)) {
    return null;
  }
  const timestamp = server.resolveActivityTimestamp(activity);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return null;
  }
  const symbol = (function resolveActivitySymbol(activity) {
    if (!activity || typeof activity !== 'object') return '';
    const rawSymbol = typeof activity.symbol === 'string' ? activity.symbol.trim() : '';
    return rawSymbol || '';
  })(activity);
  // Allow missing symbol if symbolId is present; decoration can fill it later
  const rawQuantity = Number(activity.quantity);
  if (!Number.isFinite(rawQuantity) || Math.abs(rawQuantity) <= 1e-8) {
    return null;
  }
  const identifierCandidates = [activity.orderId, activity.activityId, activity.id, activity.transactionId, activity.tradeId];
  let identifier = null;
  for (const candidate of identifierCandidates) {
    if (candidate === null || candidate === undefined) continue;
    const trimmed = String(candidate).trim();
    if (trimmed) { identifier = trimmed; break; }
  }
  if (!identifier) {
    identifier = buildActivityOrderIdentifierKey(
      context.account.id || context.account.number,
      symbol,
      timestamp,
      resolveActivityOrderAction(activity, rawQuantity),
      rawQuantity
    );
  }
  const orderId = 'activity:' + identifier;
  const quantity = Math.abs(rawQuantity);
  const price = resolveActivityOrderPrice(activity, rawQuantity);
  const action = resolveActivityOrderAction(activity, rawQuantity);
  const commission = resolveActivityOrderCommission(activity);
  const currency = normalizeCurrency(activity.currency) || null;
  const symbolId = Number(activity.symbolId);
  const accountId = context.account && context.account.id ? String(context.account.id) : null;
  const accountNumber = context.account && context.account.number ? String(context.account.number) : (context.account && context.account.accountNumber ? String(context.account.accountNumber) : accountId);
  const loginId = context.login && context.login.id ? String(context.login.id) : null;
  return {
    id: orderId,
    orderId,
    accountId,
    accountNumber,
    loginId,
    symbol: symbol || null,
    symbolId: Number.isFinite(symbolId) ? symbolId : null,
    description: typeof activity.description === 'string' ? activity.description.trim() : null,
    currency,
    status: 'Executed',
    action,
    type: typeof activity.orderType === 'string' && activity.orderType.trim() ? activity.orderType.trim() : null,
    timeInForce: null,
    totalQuantity: quantity,
    openQuantity: 0,
    filledQuantity: quantity,
    limitPrice: price,
    stopPrice: null,
    avgExecPrice: price,
    lastExecPrice: price,
    commission,
    commissionCharged: commission,
    venue: typeof activity.exchange === 'string' && activity.exchange.trim() ? activity.exchange.trim() : (typeof activity.venue === 'string' && activity.venue.trim() ? activity.venue.trim() : null),
    notes: typeof activity.notes === 'string' && activity.notes.trim() ? activity.notes.trim() : null,
    source: 'activity',
    creationTime: timestamp.toISOString(),
    updateTime: timestamp.toISOString(),
    gtdDate: null,
  };
}

function buildOrdersFromActivities(activityContext, context, cutoffDate) {
  if (!activityContext || typeof activityContext !== 'object' || !Array.isArray(activityContext.activities) || !context) {
    return [];
  }
  const cutoffMs = cutoffDate instanceof Date && !Number.isNaN(cutoffDate.getTime()) ? cutoffDate.getTime() : null;
  return activityContext.activities
    .map((activity) => convertActivityToOrder(activity, context))
    .filter((order) => {
      if (!order) return false;
      if (cutoffMs === null) return true;
      const createdMs = Date.parse(order.creationTime || order.updateTime || '');
      if (!Number.isFinite(createdMs)) return true;
      return createdMs < cutoffMs;
    });
}

function findEarliestOrderTimestamp(orders) {
  if (!Array.isArray(orders) || orders.length === 0) return null;
  let earliestMs = null;
  orders.forEach((order) => {
    if (!order || typeof order !== 'object') return;
    const candidates = [];
    if (typeof order.creationTime === 'string') { candidates.push(order.creationTime); }
    if (typeof order.updateTime === 'string') { candidates.push(order.updateTime); }
    candidates.forEach((value) => {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) return;
      if (earliestMs === null || parsed < earliestMs) {
        earliestMs = parsed;
      }
    });
  });
  return earliestMs === null ? null : new Date(earliestMs).toISOString();
}

async function main() {
  const target = process.argv[2] || '';
  const accounts = [];
  for (const login of server.getAllLogins()) {
    const fetched = await server.fetchAccounts(login);
    fetched.forEach((account) => {
      const number = String(account.number || account.accountNumber || account.id);
      const id = `${login.id}:${number}`;
      accounts.push({ id, number, displayName: account.displayName || account.type || number, login, account: Object.assign({}, account, { id, number, loginId: login.id }) });
    });
  }
  let match = null;
  if (!target) {
    console.log('Provide accountId or name fragment. Available accounts:');
    accounts.forEach((a) => console.log('-', a.id, a.displayName));
    process.exit(1);
  }
  match = accounts.find((a) => a.id === target || a.number === target || (a.displayName && a.displayName.toLowerCase().includes(target.toLowerCase())));
  if (!match) {
    console.error('Account not found:', target);
    process.exit(2);
  }

  const context = { login: server.getLoginById(match.account.loginId), account: match.account };
  const activityContext = await server.buildAccountActivityContext(context.login, context.account);
  const now = new Date();
  const recentStartCandidate = new Date(now.getTime() - RECENT_ORDERS_LOOKBACK_DAYS * DAY_IN_MS);
  const normalizedRecentStart = clampDate(recentStartCandidate, MIN_ACTIVITY_DATE) || recentStartCandidate || now;
  const activityOrders = buildOrdersFromActivities(activityContext, context, normalizedRecentStart);
  const activityStart = findEarliestOrderTimestamp(activityOrders);
  console.log('Account:', match.id, '-', match.displayName);
  console.log('Activities count:', activityContext.activities.length);
  console.log('Activity-derived orders:', activityOrders.length);
  console.log('Earliest activity-derived order timestamp:', activityStart);

  // Print diagnostic sample of activities
  const sample = activityContext.activities
    .filter((a) => {
      const qty = Number(a.quantity);
      const hasQty = Number.isFinite(qty) && Math.abs(qty) > 1e-8;
      const t = (a.type || '').toString().toLowerCase();
      const d = (a.description || '').toString().toLowerCase();
      const hasTradeWords = /trade|buy|sell|short|cover|option/.test(t + ' ' + d);
      return hasQty || hasTradeWords;
    })
    .slice(0, 10);
  console.log('Sample trade-like activities:', sample.length);
  sample.forEach((a, idx) => {
    const fields = {
      id: a.id || a.activityId || a.transactionId,
      type: a.type,
      action: a.action,
      description: a.description,
      symbol: a.symbol,
      quantity: a.quantity,
      price: a.price,
      grossAmount: a.grossAmount,
      netAmount: a.netAmount,
      currency: a.currency,
      tradeDate: a.tradeDate || a.transactionDate || a.settlementDate || a.date,
    };
    console.log('  -', idx + 1, fields);
  });
}

main().catch((err) => {
  console.error('Error:', err && err.message ? err.message : err);
  process.exit(3);
});
