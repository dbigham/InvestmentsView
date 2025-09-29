const QUESRADE_SUMMARY_BASE = 'https://myportal.questrade.com/investing/summary';

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
