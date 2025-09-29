export function buildQuoteUrl(symbol, provider) {
  if (!symbol) {
    return null;
  }
  const normalized = String(symbol).trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  const encoded = encodeURIComponent(normalized);
  if (provider === 'questrade') {
    return `https://myportal.questrade.com/investing/summary/quote/${encoded}`;
  }
  if (provider === 'yahoo') {
    return `https://ca.finance.yahoo.com/quote/${encoded}/`;
  }
  return `https://www.google.ca/search?sourceid=chrome-psyapi2&ion=1&espv=2&ie=UTF-8&q=${encoded}%20chart`;
}

export function openQuote(symbol, provider) {
  const url = buildQuoteUrl(symbol, provider);
  if (!url) {
    return;
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
