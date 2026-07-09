const fs = require('fs');
const path = require('path');
const { resolveDataPath } = require('./dataPaths');

const ARCHIVE_VERSION = 1;
const ARCHIVE_PATH = resolveDataPath('archived-accounts.json');

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function readArchiveStore() {
  try {
    if (!fs.existsSync(ARCHIVE_PATH)) {
      return { version: ARCHIVE_VERSION, accounts: {} };
    }
    const contents = fs.readFileSync(ARCHIVE_PATH, 'utf-8');
    if (!contents.trim()) {
      return { version: ARCHIVE_VERSION, accounts: {} };
    }
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
      return {
        version: parsed.version || ARCHIVE_VERSION,
        updatedAt: parsed.updatedAt || null,
        accounts: parsed.accounts,
      };
    }
  } catch (error) {
    console.warn('Failed to read archived accounts:', error.message || error);
  }
  return { version: ARCHIVE_VERSION, accounts: {} };
}

function writeArchiveStore(store) {
  try {
    const payload = {
      version: ARCHIVE_VERSION,
      updatedAt: new Date().toISOString(),
      accounts: store && store.accounts && typeof store.accounts === 'object' ? store.accounts : {},
    };
    fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
    fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    return true;
  } catch (error) {
    console.warn('Failed to persist archived accounts:', error.message || error);
    return false;
  }
}

function normalizeKey(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function buildAccountKeys(account, entry) {
  const keys = new Set();
  const push = (value) => {
    const normalized = normalizeKey(value);
    if (normalized) {
      keys.add(normalized);
      keys.add(normalized.toLowerCase());
    }
  };
  push(account && account.id);
  push(account && account.number);
  push(account && account.accountNumber);
  push(account && account.providerAccountId);
  push(account && account.name);
  push(entry && entry.id);
  push(entry && entry.accountId);
  if (account && account.loginId && account.number) {
    push(`${account.loginId}:${account.number}`);
  }
  return Array.from(keys);
}

function normalizeArchiveEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const account = raw.account && typeof raw.account === 'object' ? raw.account : null;
  const id = normalizeKey(raw.id || raw.accountId || (account && account.id));
  if (!id || !account) {
    return null;
  }
  return Object.assign({}, raw, {
    id,
    accountId: id,
    account,
    keys: Array.isArray(raw.keys) && raw.keys.length ? raw.keys : buildAccountKeys(account, raw),
  });
}

function applySnapshotToStore(store, snapshot) {
  if (!snapshot || !snapshot.account || !snapshot.account.id) {
    return null;
  }
  const accountId = normalizeKey(snapshot.account.id);
  if (!accountId) {
    return null;
  }
  const existing = normalizeArchiveEntry(store.accounts[accountId]) || {};
  const now = new Date().toISOString();
  const account = cloneJson(snapshot.account);
  const entry = Object.assign({}, existing, {
    id: accountId,
    accountId,
    loginId: snapshot.loginId || account.loginId || existing.loginId || null,
    loginEmail: snapshot.loginEmail || account.ownerEmail || existing.loginEmail || null,
    provider: snapshot.provider || account.provider || existing.provider || 'questrade',
    account,
    lastSeenAt: snapshot.asOf || existing.lastSeenAt || now,
    updatedAt: now,
    keys: buildAccountKeys(account, existing),
  });

  if (snapshot.live === true) {
    entry.lastLiveSeenAt = snapshot.asOf || now;
  }
  if (snapshot.archived === true && !entry.archivedAt) {
    entry.archivedAt = snapshot.asOf || now;
  }

  const optionalFields = [
    'balanceSummary',
    'balanceRaw',
    'fundingSummary',
    'dividendSummary',
    'totalPnlSeries',
    'totalPnlBySymbol',
    'totalPnlBySymbolAll',
    'positions',
    'orders',
    'activityContext',
    'activityCacheLoginId',
    'activityCacheAccountKey',
    'earliestFunding',
  ];
  optionalFields.forEach((field) => {
    if (snapshot[field] !== undefined) {
      if (
        field === 'totalPnlSeries' &&
        entry.totalPnlSeries &&
        typeof entry.totalPnlSeries === 'object' &&
        snapshot.totalPnlSeries &&
        typeof snapshot.totalPnlSeries === 'object' &&
        !Array.isArray(entry.totalPnlSeries) &&
        !Array.isArray(snapshot.totalPnlSeries)
      ) {
        entry.totalPnlSeries = Object.assign({}, entry.totalPnlSeries, cloneJson(snapshot.totalPnlSeries));
      } else {
        entry[field] = cloneJson(snapshot[field]);
      }
    }
  });

  store.accounts[accountId] = entry;
  return entry;
}

function listArchivedAccounts() {
  const store = readArchiveStore();
  return Object.values(store.accounts || {})
    .map(normalizeArchiveEntry)
    .filter(Boolean);
}

function listArchivedAccountsForLogin(login) {
  const loginId = normalizeKey(login && login.id).toLowerCase();
  const loginEmail = normalizeKey(login && login.email).toLowerCase();
  return listArchivedAccounts().filter((entry) => {
    const entryLoginId = normalizeKey(entry.loginId || entry.account?.loginId).toLowerCase();
    const entryEmail = normalizeKey(entry.loginEmail || entry.account?.ownerEmail).toLowerCase();
    return (
      (loginId && entryLoginId === loginId) ||
      (loginEmail && entryEmail === loginEmail)
    );
  });
}

function findArchivedAccountByKey(rawKey) {
  const normalized = normalizeKey(rawKey);
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  const colonIndex = lower.indexOf(':');
  const accountPortion = colonIndex > 0 ? lower.slice(colonIndex + 1) : '';
  return (
    listArchivedAccounts().find((entry) => {
      const keys = Array.isArray(entry.keys) ? entry.keys : buildAccountKeys(entry.account, entry);
      return keys.some((key) => {
        const candidate = normalizeKey(key).toLowerCase();
        return candidate === lower || (accountPortion && candidate === accountPortion);
      });
    }) || null
  );
}

function upsertArchivedAccountSnapshot(snapshot) {
  const store = readArchiveStore();
  const entry = applySnapshotToStore(store, snapshot);
  if (!entry) {
    return null;
  }
  writeArchiveStore(store);
  return entry;
}

function upsertArchivedAccountSnapshots(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  if (!list.length) {
    return [];
  }
  const store = readArchiveStore();
  const entries = [];
  list.forEach((snapshot) => {
    const entry = applySnapshotToStore(store, snapshot);
    if (entry) {
      entries.push(entry);
    }
  });
  if (entries.length) {
    writeArchiveStore(store);
  }
  return entries;
}

module.exports = {
  ARCHIVE_PATH,
  findArchivedAccountByKey,
  listArchivedAccounts,
  listArchivedAccountsForLogin,
  readArchiveStore,
  upsertArchivedAccountSnapshot,
  upsertArchivedAccountSnapshots,
};
