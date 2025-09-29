const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

function buildUrl(accountId, options = {}) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/summary', base);
  if (accountId && accountId !== 'all') {
    url.searchParams.set('accountId', accountId);
  }
  if (options && options.preferDefaultAccount) {
    url.searchParams.set('preferDefaultAccount', '1');
  }
  return url.toString();
}

export async function getSummary(accountId, options) {
  const response = await fetch(buildUrl(accountId, options));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load summary data');
  }
  return response.json();
}
