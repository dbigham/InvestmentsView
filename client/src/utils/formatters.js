const currencyFormatters = {};

export function formatCurrency(value, currency = 'CAD', options = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '\u2014';
  }
  const key = currency + JSON.stringify(options || {});
  if (!currencyFormatters[key]) {
    currencyFormatters[key] = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      minimumFractionDigits: options.minimumFractionDigits ?? 2,
      maximumFractionDigits: options.maximumFractionDigits ?? 2,
    });
  }
  return currencyFormatters[key].format(value);
}

export function formatNumber(value, fractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  return Number(value).toLocaleString('en-CA', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function classifyPnL(value) {
  if (value > 0.01) return 'positive';
  if (value < -0.01) return 'negative';
  return 'neutral';
}

export function formatPnL(value, currency) {
  const formatted = formatCurrency(value, currency);
  const tone = classifyPnL(value);
  return { formatted, tone };
}
