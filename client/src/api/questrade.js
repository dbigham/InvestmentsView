const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

function buildUrl(accountId) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/summary', base);
  if (accountId && accountId !== 'all') {
    url.searchParams.set('accountId', accountId);
  }
  return url.toString();
}

function buildQqqTemperatureUrl() {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/qqq-temperature', base);
  return url.toString();
}

function buildPerformanceUrl(accountId) {
  if (!accountId) {
    throw new Error('An accountId is required to load performance data');
  }
  const base = API_BASE_URL.replace(/\/$/, '');
  const encodedId = encodeURIComponent(accountId);
  const url = new URL(`/api/accounts/${encodedId}/performance`, base);
  return url.toString();
}

export async function getSummary(accountId) {
  const response = await fetch(buildUrl(accountId));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load summary data');
  }
  return response.json();
}

export async function getQqqTemperature() {
  const response = await fetch(buildQqqTemperatureUrl());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load QQQ temperature data');
  }
  return response.json();
}

export async function getAccountPerformance(accountId) {
  const response = await fetch(buildPerformanceUrl(accountId));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load account performance data');
  }
  return response.json();
}
