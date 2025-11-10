import {
  classifyPnL,
  formatMoney,
  formatNumber,
  formatSignedMoney,
  formatSignedPercent,
} from './formatters';

export function resolveTotalCost(position) {
  if (!position) {
    return null;
  }
  if (position.totalCost !== undefined && position.totalCost !== null) {
    return position.totalCost;
  }
  const { averageEntryPrice, openQuantity } = position;
  if (Number.isFinite(averageEntryPrice) && Number.isFinite(openQuantity)) {
    return averageEntryPrice * openQuantity;
  }
  return null;
}

export function formatQuantity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  const numeric = Number(value);
  const hasFraction = Math.abs(numeric % 1) > 0.0000001;
  return formatNumber(numeric, {
    minimumFractionDigits: hasFraction ? 4 : 0,
    maximumFractionDigits: hasFraction ? 4 : 0,
  });
}

export function formatShare(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  const numeric = Number(value);
  return `${formatNumber(numeric, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export function derivePercentages(position) {
  if (!position) {
    return { dayPnlPercent: null, openPnlPercent: null };
  }
  const currentMarketValue = Number.isFinite(position.currentMarketValue)
    ? position.currentMarketValue
    : 0;
  const dayPnl = Number.isFinite(position.dayPnl) ? position.dayPnl : 0;
  const openPnl = Number.isFinite(position.openPnl) ? position.openPnl : 0;
  const totalCost = resolveTotalCost(position);

  const previousValue = currentMarketValue - dayPnl;
  const dayPnlPercent = Math.abs(previousValue) > 1e-6 ? (dayPnl / previousValue) * 100 : null;
  const openPnlPercent =
    totalCost !== null && Math.abs(totalCost) > 1e-6 ? (openPnl / totalCost) * 100 : null;

  return { dayPnlPercent, openPnlPercent };
}

export function resolveAccountForPosition(position, accountsById) {
  if (!position) {
    return null;
  }

  const rawPortalAccountId =
    position.portalAccountId ||
    position.accountPortalId ||
    position.portalId ||
    position.accountPortalUuid ||
    null;

  if (rawPortalAccountId !== null && rawPortalAccountId !== undefined) {
    const portalAccountId = String(rawPortalAccountId).trim();
    if (portalAccountId) {
      return { portalAccountId };
    }
  }

  if (!accountsById || typeof accountsById.has !== 'function') {
    return null;
  }

  const matches = new Map();

  const addMatch = (account) => {
    if (!account) {
      return;
    }
    const id = account.id != null ? String(account.id) : null;
    if (!id || matches.has(id)) {
      return;
    }
    matches.set(id, account);
  };

  const tryMatchById = (rawId) => {
    if (rawId == null) {
      return;
    }
    const normalized = String(rawId);
    if (!normalized || !accountsById.has(normalized)) {
      return;
    }
    addMatch(accountsById.get(normalized));
  };

  const tryMatchByNumber = (rawNumber) => {
    if (!rawNumber && rawNumber !== 0) {
      return;
    }
    const normalizedNumber = String(rawNumber).trim();
    if (!normalizedNumber) {
      return;
    }
    if (typeof accountsById.values !== 'function') {
      return;
    }
    for (const account of accountsById.values()) {
      const accountNumber =
        account?.number != null ? String(account.number).trim() : '';
      if (accountNumber && accountNumber === normalizedNumber) {
        addMatch(account);
      }
    }
  };

  const candidateEntries = [
    { accountId: position.accountId, accountNumber: position.accountNumber },
  ];

  if (Array.isArray(position.accountNotes) && position.accountNotes.length) {
    position.accountNotes.forEach((entry) => {
      candidateEntries.push({
        accountId: entry?.accountId,
        accountNumber: entry?.accountNumber,
      });
    });
  }

  candidateEntries.forEach((entry) => {
    tryMatchById(entry.accountId);
  });
  if (matches.size === 1) {
    return matches.values().next().value;
  }

  candidateEntries.forEach((entry) => {
    tryMatchByNumber(entry.accountNumber);
  });
  if (matches.size === 1) {
    return matches.values().next().value;
  }

  return null;
}

function formatPromptValue(value, { fallback = 'Not available', currency } = {}) {
  if (value === null || value === undefined) {
    return fallback;
  }

  let text = typeof value === 'string' ? value.trim() : String(value);
  if (!text || text === '\u2014') {
    return fallback;
  }

  const currencySuffix = currency && currency !== '\u2014' ? String(currency).trim().toUpperCase() : '';
  if (currencySuffix && text !== fallback && !text.toUpperCase().endsWith(currencySuffix)) {
    text = `${text} ${currencySuffix}`.trim();
  }

  return text;
}

export function buildExplainMovementPrompt(position) {
  if (!position) {
    return '';
  }

  const today = new Date();
  const isoDate = Number.isNaN(today.getTime()) ? '' : today.toISOString().slice(0, 10);
  const symbol =
    typeof position.symbol === 'string' && position.symbol.trim()
      ? position.symbol.trim().toUpperCase()
      : 'Unknown symbol';
  const description =
    typeof position.description === 'string' && position.description.trim()
      ? position.description.trim()
      : 'Unknown company';

  let accountIdentifier = 'Not specified';
  if (typeof position.accountNumber === 'string' && position.accountNumber.trim()) {
    accountIdentifier = position.accountNumber.trim();
  } else if (position.accountId !== null && position.accountId !== undefined) {
    accountIdentifier = String(position.accountId);
  }

  const currency =
    typeof position.currency === 'string' && position.currency.trim()
      ? position.currency.trim().toUpperCase()
      : '';

  const quantity = formatPromptValue(formatQuantity(position.openQuantity));
  const averagePrice = formatPromptValue(
    formatMoney(position.averageEntryPrice, { minimumFractionDigits: 4, maximumFractionDigits: 4 }),
    { currency }
  );
  const currentPrice = formatPromptValue(
    formatMoney(position.currentPrice, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const marketValue = formatPromptValue(
    formatMoney(position.currentMarketValue, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const costBasis = formatPromptValue(
    formatMoney(resolveTotalCost(position), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const openPnl = formatPromptValue(
    formatSignedMoney(position.openPnl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const openPnlPercent = formatPromptValue(
    typeof position.openPnlPercent === 'number'
      ? formatSignedPercent(position.openPnlPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '\u2014',
    { fallback: 'n/a' }
  );
  const dayPnl = formatPromptValue(
    formatSignedMoney(position.dayPnl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    { currency }
  );
  const dayPnlPercent = formatPromptValue(
    typeof position.dayPnlPercent === 'number'
      ? formatSignedPercent(position.dayPnlPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '\u2014',
    { fallback: 'n/a' }
  );
  const portfolioShare = formatPromptValue(formatShare(position.portfolioShare), { fallback: 'n/a' });

  const movementClassification = classifyPnL(typeof position.dayPnl === 'number' ? position.dayPnl : 0);
  const movementDescriptorMap = {
    positive: `${symbol} traded higher today.`,
    negative: `${symbol} declined today.`,
    neutral: `${symbol} was roughly flat today.`,
  };
  const movementDescriptor = movementDescriptorMap[movementClassification] || `${symbol} had limited movement today.`;

  const dayPnlSummary =
    dayPnl === 'Not available'
      ? 'No intraday P&L data is available for today.'
      : dayPnlPercent !== 'n/a'
      ? `${dayPnl} (${dayPnlPercent})`
      : dayPnl;

  const positionSideLine =
    quantity === 'Not available'
      ? '- Position side: Long position (share count not available)'
      : `- Position side: Long ${quantity}`;

  const contextLines = [
    `- Symbol: ${symbol}`,
    `- Company name: ${description}`,
    `- Account: ${accountIdentifier}`,
    positionSideLine,
    `- Trading currency: ${currency || 'Not specified'}`,
    `- Average entry price: ${averagePrice}`,
    `- Current price: ${currentPrice}`,
    `- Position market value: ${marketValue}`,
    `- Cost basis: ${costBasis}`,
    `- Unrealized P&L: ${openPnl}${openPnlPercent !== 'n/a' ? ` (${openPnlPercent})` : ''}`,
    `- Today's intraday P&L: ${dayPnlSummary}`,
    `- Portfolio weight: ${portfolioShare}`,
  ];

  const sanitizedContext = contextLines.map((line) => line.replace(/\s+/g, ' ').trim());

  const lines = [
    'You are a sell-side equity analyst preparing a post-trade explanation.',
    isoDate ? `Today is ${isoDate}. ${movementDescriptor}` : movementDescriptor,
    `Research credible, real-world financial news and market data published today (extend back up to 72 hours if needed) about:`,
    '1. The overall market (major North American indices, macroeconomic releases, rates, and cross-asset moves).',
    `2. The sector or industry most relevant to ${symbol}.`,
    `3. Company-specific developments for ${symbol} (${description}).`,
    '',
    'Use that research to narrate why the stock moved the way it did today.',
    '',
    'Holding context:',
    ...sanitizedContext,
    '',
    'Please respond with clearly labeled sections:',
    '1. Market context',
    '2. Sector/industry context',
    '3. Company-specific catalysts',
    `4. Narrative linking the catalysts to why ${symbol} moved the way it did today (cover timing, magnitude, and investor reaction).`,
    '5. Confidence assessment (High/Medium/Low) and key follow-ups to monitor next.',
    "6. Executive Summary (end with a very short, to-the-point takeaway capturing the core driver for senior leaders).",
    '',
    'Make sure the Executive Summary appears at the end and is concise yet still conveys the essence of the move.',
    '',
    'If no direct news exists, identify plausible drivers such as sympathy moves, analyst commentary, fund flows, or technical factors, and make it clear that direct news was not found.',
    'Cite publication timestamps when possible.',
  ];

  return lines.join('\n');
}

