const MARKET_DATA_PROVIDER_PREFERENCE = (() => {
  const raw =
    process.env.MARKET_DATA_PROVIDER_PREFERENCE ||
    process.env.MARKET_DATA_PROVIDER ||
    '';
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'yahoo' || normalized === 'yahoo-finance' || normalized === 'yahoo-finance2') {
    return 'yahoo';
  }
  if (normalized === 'questrade') {
    return 'questrade';
  }
  return 'questrade';
})();

function normalizeMarketDataProvider(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'yahoo' || normalized === 'yahoo-finance' || normalized === 'yahoo-finance2') {
    return 'yahoo';
  }
  if (normalized === 'questrade') {
    return 'questrade';
  }
  return null;
}

function buildProviderOrder(preference) {
  const preferred = normalizeMarketDataProvider(preference) || MARKET_DATA_PROVIDER_PREFERENCE;
  return preferred === 'yahoo' ? ['yahoo', 'questrade'] : ['questrade', 'yahoo'];
}

module.exports = {
  MARKET_DATA_PROVIDER_PREFERENCE,
  normalizeMarketDataProvider,
  buildProviderOrder,
};
