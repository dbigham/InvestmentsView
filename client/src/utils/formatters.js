const currencyFormatters = new Map();
const numberFormatters = new Map();
const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Toronto',
});

export function formatCurrency(value, currency = 'CAD', options = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '\u2014';
  }
  const key = `${currency}:${options.minimumFractionDigits ?? 2}:${options.maximumFractionDigits ?? 2}`;
  if (!currencyFormatters.has(key)) {
    currencyFormatters.set(
      key,
      new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency,
        minimumFractionDigits: options.minimumFractionDigits ?? 2,
        maximumFractionDigits: options.maximumFractionDigits ?? 2,
      })
    );
  }
  return currencyFormatters.get(key).format(value);
}

export function formatNumber(value, fractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const key = `${fractionDigits}`;
  if (!numberFormatters.has(key)) {
    numberFormatters.set(
      key,
      new Intl.NumberFormat('en-CA', {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      })
    );
  }
  return numberFormatters.get(key).format(Number(value));
}

export function formatCurrencyWithCode(value, currency = 'CAD', options = {}) {
  return formatCurrency(value, currency, options);
}

export function formatSignedCurrency(value, currency = 'CAD', options = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '\u2014';
  }
  const magnitude = Math.abs(Number(value));
  const formattedMagnitude = formatCurrency(magnitude, currency, options);
  if (value > 0) {
    return `+${formattedMagnitude}`;
  }
  if (value < 0) {
    return `-${formattedMagnitude}`;
  }
  return formattedMagnitude;
}

export function classifyPnL(value) {
  if (value > 0.01) return 'positive';
  if (value < -0.01) return 'negative';
  return 'neutral';
}

export function formatPnL(value, currency) {
  return {
    formatted: formatSignedCurrency(value, currency),
    tone: classifyPnL(value),
  };
}

export function formatPercent(value, fractionDigits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '\u2014';
  }
  return `${formatNumber(value, fractionDigits)}%`;
}

export function formatDateTime(dateInput) {
  if (!dateInput) {
    return '\u2014';
  }
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return '\u2014';
  }
  return dateTimeFormatter.format(date);
}

