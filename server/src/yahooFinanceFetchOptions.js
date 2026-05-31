const DEFAULT_YAHOO_FINANCE_USER_AGENT = 'Mozilla/5.0 stock-lookup-demo';

function resolveYahooFinanceUserAgent() {
  const configured = process.env.YAHOO_FINANCE_USER_AGENT;
  return typeof configured === 'string' && configured.trim()
    ? configured.trim()
    : DEFAULT_YAHOO_FINANCE_USER_AGENT;
}

function buildYahooFinanceFetchOptions(baseOptions = {}) {
  const fetchOptions = baseOptions && typeof baseOptions === 'object' ? { ...baseOptions } : {};
  const headers =
    fetchOptions.headers && typeof fetchOptions.headers === 'object'
      ? { ...fetchOptions.headers }
      : {};

  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === 'user-agent') {
      delete headers[key];
    }
  });
  headers['User-Agent'] = resolveYahooFinanceUserAgent();

  return {
    ...fetchOptions,
    headers,
  };
}

module.exports = {
  DEFAULT_YAHOO_FINANCE_USER_AGENT,
  buildYahooFinanceFetchOptions,
  resolveYahooFinanceUserAgent,
};
