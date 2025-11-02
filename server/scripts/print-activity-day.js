require('dotenv').config();
const path = require('path');
const server = require(path.join(__dirname, '..', 'src', 'index.js'));

async function main() {
  const target = process.argv[2] || 'daniel:53540936';
  const day = process.argv[3] || '2025-09-19'; // YYYY-MM-DD

  // Resolve account
  const accounts = [];
  for (const login of server.getAllLogins()) {
    const fetched = await server.fetchAccounts(login);
    fetched.forEach((account) => {
      const number = String(account.number || account.accountNumber || account.id);
      const id = `${login.id}:${number}`;
      accounts.push({ id, number, login, account: Object.assign({}, account, { id, number, loginId: login.id }) });
    });
  }
  const acct = accounts.find((a) => a.id === target || a.number === target || (a.account.displayName || '').toLowerCase().includes(String(target).toLowerCase()));
  if (!acct) {
    console.error('Account not found:', target);
    process.exit(2);
  }
  const ctx = { login: server.getLoginById(acct.account.loginId), account: acct.account };
  const activityContext = await server.buildAccountActivityContext(ctx.login, ctx.account);
  const rows = activityContext.activities.filter((a) => {
    const ts = server.resolveActivityTimestamp(a);
    if (!ts) return false;
    const key = ts.toISOString().slice(0, 10);
    return key === day;
  });

  console.log(`Activities on ${day}: ${rows.length}`);
  rows.forEach((a, idx) => {
    const ts = server.resolveActivityTimestamp(a);
    const symbol = a.symbol || '';
    const qty = a.quantity;
    const gross = a.grossAmount;
    const net = a.netAmount;
    const id = a.id || a.activityId || a.transactionId || a.tradeId || a.orderId || null;
    console.log(`${String(idx).padStart(2,'0')} | ${ts.toISOString()} | id=${id} | sym=${symbol} | qty=${qty} | gross=${gross} | net=${net} | type=${a.type} | action=${a.action} | desc=${(a.description||'').slice(0,60)}`);
  });
}

main().catch((err) => {
  console.error('Error:', err?.message || String(err));
  process.exit(1);
});

