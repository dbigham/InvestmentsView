require('dotenv').config();

const path = require('path');
const server = require(path.join(__dirname, '..', 'src', 'index.js'));

async function main() {
  const target = process.argv[2] || 'daniel:53540936';
  const START = process.argv[3] || '2025-08-01T00:00:00Z';
  const END = process.argv[4] || new Date().toISOString();

  const all = [];
  for (const login of server.getAllLogins()) {
    const fetched = await server.fetchAccounts(login);
    fetched.forEach((account) => {
      const number = String(account.number || account.accountNumber || account.id);
      const id = `${login.id}:${number}`;
      all.push({ id, number, displayName: account.displayName || account.type || number, login, account: Object.assign({}, account, { id, number, loginId: login.id }) });
    });
  }

  const acct = all.find((a) => a.id === target || a.number === target || (a.displayName && a.displayName.toLowerCase().includes(String(target).toLowerCase())));
  if (!acct) {
    console.error('Account not found:', target);
    process.exit(2);
  }
  const login = server.getLoginById(acct.account.loginId);
  const accountNumber = acct.account.number;

  console.log('Fetching orders for', acct.id, acct.displayName, 'from', START, 'to', END);
  const orders = await server.fetchOrders(login, accountNumber, {
    startTime: START,
    endTime: END,
    stateFilter: 'All',
    maxPages: 500,
  });
  console.log('Total orders returned:', Array.isArray(orders) ? orders.length : 0);
  if (!Array.isArray(orders) || orders.length === 0) {
    return;
  }
  // Sort and print the earliest and latest
  const sorted = orders
    .filter((o) => o && (o.creationTime || o.updateTime))
    .sort((a, b) => Date.parse(a.creationTime || a.updateTime || 0) - Date.parse(b.creationTime || b.updateTime || 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  console.log('Earliest:', first?.creationTime || first?.updateTime, first?.symbol, first?.action, first?.state);
  console.log('Latest:', last?.creationTime || last?.updateTime, last?.symbol, last?.action, last?.state);
  // Print a small subset around September 19
  const sample = sorted.filter((o) => {
    const t = Date.parse(o.creationTime || o.updateTime || '');
    return Number.isFinite(t) && t >= Date.parse('2025-09-18T00:00:00Z') && t <= Date.parse('2025-09-20T23:59:59Z');
  });
  console.log('Orders near 2025-09-19:', sample.length);
  sample.slice(0, 20).forEach((o) => {
    console.log('-', o.creationTime || o.updateTime, o.symbol, o.action || o.side, o.state);
  });
}

main().catch((err) => {
  console.error('Error:', err?.message || String(err));
  process.exit(1);
});

