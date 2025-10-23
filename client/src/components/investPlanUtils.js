import { formatMoney, formatNumber } from '../utils/formatters';

const DEFAULT_DESCRIPTION_CHAR_LIMIT = 21;
const JOURNALLING_URL = 'https://my.questrade.com/clients/en/my_requests/journalling.aspx';

export function formatCopyNumber(value, decimals = 2, { trimTrailingZeros = false } = {}) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const precision = Math.max(0, Math.min(6, decimals));
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  const fixed = normalized.toFixed(precision);
  if (!trimTrailingZeros || precision === 0) {
    return fixed;
  }
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function formatCurrencyLabel(value, currency) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const code = currency || 'CAD';
  return `${formatMoney(value)} ${code}`;
}

export function formatShareDisplay(shares, precision) {
  if (!Number.isFinite(shares) || shares <= 0) {
    return '—';
  }
  const digits = Math.max(0, Number.isFinite(precision) ? precision : 0);
  return formatNumber(shares, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function truncateDescription(value, limit = DEFAULT_DESCRIPTION_CHAR_LIMIT) {
  if (!value) {
    return null;
  }
  const normalized = String(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}...`;
}

export { DEFAULT_DESCRIPTION_CHAR_LIMIT, JOURNALLING_URL };
