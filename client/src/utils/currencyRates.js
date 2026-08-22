export function mergeAuthoritativeUsdToCadRate(rates, usdToCadRate, baseCurrency = 'CAD') {
  const nextRates = rates instanceof Map ? new Map(rates) : new Map();
  const normalizedBase = String(baseCurrency || 'CAD').trim().toUpperCase();
  const normalizedRate = Number(usdToCadRate);

  if (
    normalizedBase === 'CAD' &&
    Number.isFinite(normalizedRate) &&
    normalizedRate > 0
  ) {
    nextRates.set('USD', normalizedRate);
  }

  return nextRates;
}

function convertAmount(value, sourceCurrency, targetCurrency, rates, baseCurrency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const source = String(sourceCurrency || baseCurrency).trim().toUpperCase();
  const target = String(targetCurrency || baseCurrency).trim().toUpperCase();
  if (source === target) return amount;
  const sourceRate = rates instanceof Map ? Number(rates.get(source)) : null;
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) return null;
  const amountInBase = source === baseCurrency ? amount : amount * sourceRate;
  if (target === baseCurrency) return amountInBase;
  const targetRate = rates instanceof Map ? Number(rates.get(target)) : null;
  return Number.isFinite(targetRate) && targetRate > 0 ? amountInBase / targetRate : null;
}

export function computeReserveValueAcrossCurrencies({
  cashByCurrency,
  reservePositionsByCurrency,
  targetCurrency = 'CAD',
  currencyRates,
  baseCurrency = 'CAD',
}) {
  const normalizedBase = String(baseCurrency || 'CAD').trim().toUpperCase();
  let reserveValue = 0;
  let hasValue = false;
  for (const entries of [cashByCurrency, reservePositionsByCurrency]) {
    if (!(entries instanceof Map)) continue;
    entries.forEach((amount, currency) => {
      const converted = convertAmount(
        amount,
        currency,
        targetCurrency,
        currencyRates,
        normalizedBase
      );
      if (Number.isFinite(converted)) {
        reserveValue += converted;
        hasValue = true;
      }
    });
  }
  return hasValue ? Math.max(0, reserveValue) : null;
}

export function computeCombinedCashAcrossCurrencies({
  balances,
  targetCurrency = 'CAD',
  currencyRates,
  baseCurrency = 'CAD',
}) {
  if (!balances || typeof balances !== 'object') return null;
  const perCurrency = balances.perCurrency;
  if (!perCurrency || typeof perCurrency !== 'object') return null;

  const normalizedBase = String(baseCurrency || 'CAD').trim().toUpperCase();
  let totalCash = 0;
  let hasValue = false;
  Object.entries(perCurrency).forEach(([currencyKey, entry]) => {
    if (!entry || typeof entry !== 'object') return;
    const cash = Number(entry.cash);
    if (!Number.isFinite(cash)) return;
    const converted = convertAmount(
      cash,
      entry.currency || currencyKey,
      targetCurrency,
      currencyRates,
      normalizedBase
    );
    if (Number.isFinite(converted)) {
      totalCash += converted;
      hasValue = true;
    }
  });

  return hasValue ? totalCash : null;
}
