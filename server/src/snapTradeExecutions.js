// Positions update before the transaction feed at some brokers. Only confirmed
// executions can fill that gap: never infer a sale from a missing position.
function supplementSnapTradeExecutions(activities, orders, { startDate, endDate } = {}) {
  const original = Array.isArray(activities) ? activities : [];
  const result = original.filter((activity) => activity.source !== 'snaptrade-execution');
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return original;
  const groups = new Map();
  const seen = new Set();
  for (const order of orders || []) {
    const timestamp = new Date(order.executionTime).getTime();
    const quantity = Number(order.filledQuantity);
    const price = Number(order.avgExecPrice);
    const action = String(order.action || '').toUpperCase();
    const id = order.orderId || order.id;
    if (!id || seen.has(id) || !['EXECUTED', 'FILLED'].includes(String(order.state).toUpperCase()) ||
        !['BUY', 'SELL'].includes(action) || !order.symbol || !order.currency ||
        !Number.isFinite(timestamp) || timestamp < start || timestamp > end ||
        !(quantity > 0) || !(price > 0) || Number(order.openQuantity) > 0) continue;
    seen.add(id);
    const date = new Date(timestamp).toISOString();
    const key = [order.symbol, order.currency, action, date.slice(0, 10)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ order, id, timestamp, quantity, price, action, date });
  }
  for (const executions of groups.values()) {
    const sample = executions[0];
    const matching = result.filter((activity) => activity.symbol === sample.order.symbol &&
      activity.currency === sample.order.currency &&
      String(activity.action || activity.type).toUpperCase() === sample.action &&
      String(activity.tradeDate || activity.date || '').slice(0, 10) === sample.date.slice(0, 10));
    const recordedQuantity = matching.reduce((sum, activity) => sum + Math.abs(Number(activity.quantity) || 0), 0);
    const executedQuantity = executions.reduce((sum, execution) => sum + execution.quantity, 0);
    // Also handles transactions that consolidate multiple fills into one row.
    if (recordedQuantity >= executedQuantity - 1e-7) continue;
    const remaining = [...executions];
    let ambiguous = false;
    for (const activity of matching) {
      const timestamp = new Date(activity.tradeDate || activity.date).getTime();
      const index = remaining.findIndex((execution) =>
        Math.abs(execution.timestamp - timestamp) < 1000 &&
        Math.abs(execution.quantity - Math.abs(Number(activity.quantity))) < 1e-7);
      if (index < 0) { ambiguous = true; break; }
      remaining.splice(index, 1);
    }
    // Partial/ambiguous matches do not justify manufacturing another trade.
    if (ambiguous) continue;
    for (const execution of remaining) {
      const { order, id, quantity, price, action, date } = execution;
      const signedQuantity = action === 'SELL' ? -quantity : quantity;
      const commission = Number.isFinite(order.commission) ? Math.abs(order.commission) : 0;
      const grossAmount = Math.round(-signedQuantity * price * 100) / 100;
      result.push({
        id: `snaptrade-execution:${id}`, activityId: `snaptrade-execution:${id}`,
        orderId: id, symbol: order.symbol, symbolId: order.symbolId,
        currency: order.currency, type: action, action, quantity: signedQuantity,
        price, grossAmount, netAmount: grossAmount - commission, commission,
        tradeDate: date, transactionDate: date, date,
        description: `Confirmed ${action.toLowerCase()} execution awaiting transaction history`,
        source: 'snaptrade-execution',
      });
    }
  }
  return result;
}

module.exports = { supplementSnapTradeExecutions };
