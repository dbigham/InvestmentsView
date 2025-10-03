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

function buildPerformanceUrl(accountId, options = {}) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/account-performance', base);
  if (accountId) {
    url.searchParams.set('accountId', accountId);
  }
  if (options.startTime) {
    url.searchParams.set('startTime', options.startTime);
  }
  if (options.endTime) {
    url.searchParams.set('endTime', options.endTime);
  }
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

export async function getAccountPerformance(accountId, options = {}) {
  if (!accountId || accountId === 'all') {
    throw new Error('An individual account identifier is required for performance data.');
  }
  const response = await fetch(buildPerformanceUrl(accountId, options));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to load account performance data');
  }
  return response.json();
}
