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

function buildQuoteUrl(symbol) {
  const base = API_BASE_URL.replace(/\/$/, '');
  const url = new URL('/api/quote', base);
  if (symbol) {
    url.searchParams.set('symbol', symbol);
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

export async function getQuote(symbol) {
  const normalizedSymbol = typeof symbol === 'string' ? symbol.trim() : '';
  if (!normalizedSymbol) {
    throw new Error('Symbol is required');
  }

  const response = await fetch(buildQuoteUrl(normalizedSymbol));
  if (!response.ok) {
    let message = 'Failed to load quote data';
    try {
      const payload = await response.json();
      message = payload?.message || payload?.details || message;
    } catch (parseError) {
      console.warn('Failed to parse quote error response as JSON', parseError);
      try {
        const text = await response.text();
        if (text && text.trim()) {
          message = text.trim();
        }
      } catch (nestedError) {
        console.warn('Failed to read quote error response', nestedError);
      }
    }
    throw new Error(message);
  }

  return response.json();
}
