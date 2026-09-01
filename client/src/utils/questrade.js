const QUESRADE_SUMMARY_BASE = 'https://myportal.questrade.com/investing/summary';
const WEALTHSIMPLE_APP_URL = 'https://my.wealthsimple.com/app';

function normalizeProvider(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isWealthsimpleAccount(account) {
  if (!account || typeof account !== 'object') {
    return false;
  }

  if (normalizeProvider(account.provider) === 'wealthsimple') {
    return true;
  }

  const brokerageLabels = [
    account.platformLabel,
    account.brokerageName,
    account.institutionName,
  ].filter((value) => typeof value === 'string' && value.trim());

  return brokerageLabels.some((value) => /wealthsimple/i.test(value));
}

export function resolveAccountPortalName(account) {
  if (isWealthsimpleAccount(account)) {
    return 'Wealthsimple';
  }
  return normalizePortalAccountId(account) ? 'Questrade' : null;
}

function normalizePortalAccountId(account) {
  if (!account) {
    return null;
  }
  const candidate = account.portalAccountId || account.portalId || account.portalUuid || account.accountPortalId;
  if (!candidate) {
    return null;
  }
  const normalized = String(candidate).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function buildAccountSummaryUrl(account) {
  if (isWealthsimpleAccount(account)) {
    return WEALTHSIMPLE_APP_URL;
  }
  const portalAccountId = normalizePortalAccountId(account);
  if (!portalAccountId) {
    return null;
  }
  return `${QUESRADE_SUMMARY_BASE}/accounts/${encodeURIComponent(portalAccountId)}`;
}

export function openAccountSummary(account) {
  const url = buildAccountSummaryUrl(account);
  if (!url) {
    return false;
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
