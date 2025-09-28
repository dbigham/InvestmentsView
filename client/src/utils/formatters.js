const decimalFormatters = new Map();
const torontoTimeZone = 'America/Toronto';
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: torontoTimeZone,
});
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: torontoTimeZone,
});
const timeWithSecondsFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
  timeZone: torontoTimeZone,
});

function resolveDigitOptions(input, defaults) {
  if (typeof input === 'number') {
    return {
      minimumFractionDigits: input,
      maximumFractionDigits: input,
    };
  }
  return {
    minimumFractionDigits: input?.minimumFractionDigits ?? defaults.minimumFractionDigits,
    maximumFractionDigits: input?.maximumFractionDigits ?? defaults.maximumFractionDigits,
  };
}

function getDecimalFormatter(minimumFractionDigits, maximumFractionDigits) {
  const key = `${minimumFractionDigits}:${maximumFractionDigits}`;
  if (!decimalFormatters.has(key)) {
    decimalFormatters.set(
      key,
      new Intl.NumberFormat('en-CA', {
        minimumFractionDigits,
        maximumFractionDigits,
      })
    );
  }
  return decimalFormatters.get(key);
}

function normalizeSignedZero(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return value;
  }
  if (Object.is(value, -0) || Math.abs(value) < 1e-8) {
    return 0;
  }
  return value;
}

export function formatNumber(value, fractionDigitsOrOptions = { minimumFractionDigits: 0, maximumFractionDigits: 2 }) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const digits = resolveDigitOptions(fractionDigitsOrOptions, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const formatter = getDecimalFormatter(digits.minimumFractionDigits, digits.maximumFractionDigits);
  return formatter.format(Number(value));
}

function formatMoneyMagnitude(value, digitOptions) {
  const digits = resolveDigitOptions(digitOptions, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatter = getDecimalFormatter(digits.minimumFractionDigits, digits.maximumFractionDigits);
  return `$${formatter.format(Number(value))}`;
}

export function formatMoney(value, digitOptions) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const numericValue = normalizeSignedZero(Number(value));
  const formattedMagnitude = formatMoneyMagnitude(Math.abs(numericValue), digitOptions);
  return numericValue < 0 ? `-${formattedMagnitude}` : formattedMagnitude;
}

export function formatSignedMoney(value, digitOptions) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const numericValue = normalizeSignedZero(Number(value));
  const formattedMagnitude = formatMoneyMagnitude(Math.abs(numericValue), digitOptions);
  if (numericValue > 0) {
    return `+${formattedMagnitude}`;
  }
  if (numericValue < 0) {
    return `-${formattedMagnitude}`;
  }
  return formattedMagnitude;
}

export function formatCurrency(value, _currency = 'CAD', options) {
  void _currency;
  return formatMoney(value, options);
}

export function formatCurrencyWithCode(value, _currency = 'CAD', options) {
  void _currency;
  return formatMoney(value, options);
}

export function formatSignedCurrency(value, _currency = 'CAD', options) {
  void _currency;
  return formatSignedMoney(value, options);
}

export function classifyPnL(value) {
  if (value > 0.01) return 'positive';
  if (value < -0.01) return 'negative';
  return 'neutral';
}

export function formatPnL(value, currency, options) {
  return {
    formatted: formatSignedMoney(value, options),
    tone: classifyPnL(value),
  };
}

export function formatPercent(value, fractionDigitsOrOptions = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const digits = resolveDigitOptions(fractionDigitsOrOptions, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const formatter = getDecimalFormatter(digits.minimumFractionDigits, digits.maximumFractionDigits);
  return `${formatter.format(Number(value))}%`;
}

export function formatSignedPercent(value, fractionDigitsOrOptions = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '\u2014';
  }
  const magnitude = Math.abs(Number(value));
  const formattedMagnitude = formatPercent(magnitude, fractionDigitsOrOptions);
  if (value > 0) {
    return `+${formattedMagnitude}`;
  }
  if (value < 0) {
    return `-${formattedMagnitude}`;
  }
  return formattedMagnitude;
}

export function formatDateTime(dateInput) {
  if (!dateInput) {
    return '\u2014';
  }
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return '\u2014';
  }
  const datePart = dateFormatter.format(date);
  const timePart = timeFormatter.format(date);
  return `${datePart}, ${timePart} ET`;
}

export function formatTimeOfDay(dateInput) {
  if (!dateInput) {
    return '\u2014';
  }
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return '\u2014';
  }
  const formatted = timeWithSecondsFormatter.format(date).toLowerCase();
  return `${formatted} ET`;
}




