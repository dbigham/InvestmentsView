const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveDataPath } = require('./dataPaths');

const DEFAULT_GIFTS_FILE = 'gifts.json';
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_INDEX_BY_NAME = new Map(
  [
    ['jan', 0],
    ['january', 0],
    ['feb', 1],
    ['february', 1],
    ['mar', 2],
    ['march', 2],
    ['apr', 3],
    ['april', 3],
    ['may', 4],
    ['jun', 5],
    ['june', 5],
    ['jul', 6],
    ['july', 6],
    ['aug', 7],
    ['august', 7],
    ['sep', 8],
    ['sept', 8],
    ['september', 8],
    ['oct', 9],
    ['october', 9],
    ['nov', 10],
    ['november', 10],
    ['dec', 11],
    ['december', 11],
  ]
);

function resolveGiftsFilePath(options = {}) {
  if (options.filePath) {
    return path.resolve(options.filePath);
  }
  return resolveDataPath(DEFAULT_GIFTS_FILE);
}

function normalizeDateOnly(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const match = DATE_ONLY_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

function normalizeYear(value) {
  if (value === undefined || value === null || value === '') {
    return new Date().getFullYear();
  }
  const numeric = Number(value);
  const rounded = Math.round(numeric);
  if (!Number.isFinite(rounded) || rounded < 1900 || rounded > 3000) {
    return null;
  }
  return rounded;
}

function normalizeAmountCad(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const sanitized = trimmed.replace(/[$,\s]/g, '');
  if (!sanitized) {
    return null;
  }
  const multiplier = /k$/i.test(sanitized) ? 1000 : 1;
  const numericText = multiplier === 1000 ? sanitized.slice(0, -1) : sanitized;
  const numeric = Number(numericText);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric * multiplier * 100) / 100;
}

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'on', '1', 'tax', 'claimable'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', 'off', '0', 'non-tax', 'not-claimable'].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function normalizeOrganization(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function normalizeNote(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function toDateKey(year, monthIndex, day) {
  const timestamp = Date.UTC(year, monthIndex, day);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizeReceiptDate(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    return null;
  }

  const isoMatch = /\b(20\d{2}|19\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(text);
  if (isoMatch) {
    return toDateKey(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }

  const monthFirstMatch = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2}|19\d{2})\b/.exec(text);
  if (monthFirstMatch) {
    const monthIndex = MONTH_INDEX_BY_NAME.get(monthFirstMatch[1].toLowerCase());
    if (monthIndex !== undefined) {
      return toDateKey(Number(monthFirstMatch[3]), monthIndex, Number(monthFirstMatch[2]));
    }
  }

  const dayFirstMatch = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?[,]?\s+(20\d{2}|19\d{2})\b/.exec(text);
  if (dayFirstMatch) {
    const monthIndex = MONTH_INDEX_BY_NAME.get(dayFirstMatch[2].toLowerCase());
    if (monthIndex !== undefined) {
      return toDateKey(Number(dayFirstMatch[3]), monthIndex, Number(dayFirstMatch[1]));
    }
  }

  return null;
}

function readGiftContainer(options = {}) {
  const filePath = resolveGiftsFilePath(options);
  if (!fs.existsSync(filePath)) {
    return { gifts: [], filePath };
  }
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    return { gifts: [], filePath };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    const error = new Error('Failed to parse gifts file');
    error.code = 'PARSE_ERROR';
    error.cause = parseError;
    throw error;
  }
  const gifts = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.gifts)
      ? parsed.gifts
      : [];
  return {
    gifts: gifts.map((gift) => normalizeStoredGift(gift)).filter(Boolean),
    filePath,
    updatedAt: parsed && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  };
}

function writeGiftContainer(gifts, options = {}) {
  const filePath = resolveGiftsFilePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    gifts: Array.isArray(gifts) ? gifts : [],
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(filePath, serialized + '\n', 'utf-8');
  return { ...payload, filePath };
}

function normalizeStoredGift(gift) {
  if (!gift || typeof gift !== 'object' || Array.isArray(gift)) {
    return null;
  }
  const id = typeof gift.id === 'string' && gift.id.trim() ? gift.id.trim() : crypto.randomUUID();
  const date = normalizeDateOnly(gift.date);
  const organization = normalizeOrganization(gift.organization);
  const amountCad = normalizeAmountCad(gift.amountCad ?? gift.amount);
  if (!date || !organization || !Number.isFinite(amountCad)) {
    return null;
  }
  return {
    id,
    date,
    organization,
    amountCad,
    taxClaimable: normalizeBoolean(gift.taxClaimable, false),
    note: normalizeNote(gift.note),
    createdAt:
      typeof gift.createdAt === 'string' && gift.createdAt.trim() ? gift.createdAt.trim() : null,
    updatedAt:
      typeof gift.updatedAt === 'string' && gift.updatedAt.trim() ? gift.updatedAt.trim() : null,
  };
}

function normalizeGiftInput(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('Gift payload is required');
    error.code = 'INVALID_GIFT';
    throw error;
  }
  const date = normalizeDateOnly(input.date ?? existing?.date);
  if (!date) {
    const error = new Error('Gift date must be a valid YYYY-MM-DD date');
    error.code = 'INVALID_DATE';
    throw error;
  }
  const organization = normalizeOrganization(input.organization ?? existing?.organization);
  if (!organization) {
    const error = new Error('Organization is required');
    error.code = 'INVALID_ORGANIZATION';
    throw error;
  }
  const amountCad = normalizeAmountCad(input.amountCad ?? input.amount ?? existing?.amountCad);
  if (!Number.isFinite(amountCad)) {
    const error = new Error('Gift amount must be greater than zero');
    error.code = 'INVALID_AMOUNT';
    throw error;
  }
  return {
    date,
    organization,
    amountCad,
    taxClaimable: normalizeBoolean(input.taxClaimable, existing?.taxClaimable || false),
    note: Object.prototype.hasOwnProperty.call(input, 'note')
      ? normalizeNote(input.note)
      : normalizeNote(existing?.note),
  };
}

function compareGifts(a, b) {
  const byDate = String(b.date).localeCompare(String(a.date));
  if (byDate !== 0) {
    return byDate;
  }
  const byOrganization = String(a.organization).localeCompare(String(b.organization));
  if (byOrganization !== 0) {
    return byOrganization;
  }
  return String(a.id).localeCompare(String(b.id));
}

function normalizeReceiptText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
}

function extractReceiptTransactionId(text) {
  const match =
    /\b(?:Transaction|Receipt|Confirmation)\s*(?:ID|Number|#)\s*[:#]?\s*([A-Z0-9-]{8,})\b/i.exec(text);
  return match ? match[1].trim() : null;
}

function extractReceiptAmount(text) {
  const amountPatterns = [
    /\b(?:total|amount|payment|donation|you\s+sent|sent)\b[^\n$]{0,80}(?:CA\$|C\$|\$)\s*([0-9][0-9,]*(?:\.\d{2})?)\s*(?:CAD)?/gi,
    /(?:CA\$|C\$|\$)\s*([0-9][0-9,]*(?:\.\d{2})?)\s*CAD\b/gi,
    /\bCAD\s*(?:CA\$|C\$|\$)?\s*([0-9][0-9,]*(?:\.\d{2})?)\b/gi,
  ];

  for (const pattern of amountPatterns) {
    let match = pattern.exec(text);
    while (match) {
      const amountCad = normalizeAmountCad(match[1]);
      if (Number.isFinite(amountCad)) {
        return amountCad;
      }
      match = pattern.exec(text);
    }
  }

  return null;
}

function extractReceiptDate(text) {
  const datePatterns = [
    /\b(?:date|transaction\s+date|payment\s+date|sent\s+on)\s*:?\s*([^\n]{6,40})/gi,
    /\b(?:20\d{2}|19\d{2})[-/]\d{1,2}[-/]\d{1,2}\b/g,
    /\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+(?:20\d{2}|19\d{2})\b/g,
    /\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?[,]?\s+(?:20\d{2}|19\d{2})\b/g,
  ];

  for (const pattern of datePatterns) {
    let match = pattern.exec(text);
    while (match) {
      const date = normalizeReceiptDate(match[1] || match[0]);
      if (date) {
        return date;
      }
      match = pattern.exec(text);
    }
  }

  return null;
}

function buildReceiptChunks(text) {
  const normalized = normalizeReceiptText(text);
  if (!normalized.trim()) {
    return [];
  }
  const lines = normalized.split('\n');
  const paypalIndexes = [];
  lines.forEach((line, index) => {
    if (/^\s*paypal\s*$/i.test(line)) {
      paypalIndexes.push(index);
    }
  });
  if (paypalIndexes.length > 1) {
    return paypalIndexes
      .map((index, offset) => {
        const end = offset + 1 < paypalIndexes.length ? paypalIndexes[offset + 1] : lines.length;
        return lines.slice(index, end).join('\n');
      })
      .filter((chunk) => /one\s*4\s*another|one4another/i.test(chunk));
  }

  const indexes = [];
  lines.forEach((line, index) => {
    if (/one\s*4\s*another|one4another/i.test(line)) {
      indexes.push(index);
    }
  });
  if (!indexes.length && /one\s*4\s*another|one4another/i.test(normalized)) {
    return [normalized];
  }

  const chunks = [];
  indexes.forEach((index) => {
    const start = Math.max(0, index - 18);
    const end = Math.min(lines.length, index + 24);
    chunks.push(lines.slice(start, end).join('\n'));
  });
  return chunks.length ? chunks : [normalized];
}

function parseOne4AnotherPayPalReceipts(text) {
  const chunks = buildReceiptChunks(text);
  const seen = new Set();
  const receipts = [];

  chunks.forEach((chunk) => {
    if (!/paypal/i.test(chunk) || !/one\s*4\s*another|one4another/i.test(chunk)) {
      return;
    }
    const date = extractReceiptDate(chunk);
    const amountCad = extractReceiptAmount(chunk);
    if (!date || !Number.isFinite(amountCad)) {
      return;
    }
    const transactionId = extractReceiptTransactionId(chunk);
    const key = transactionId || `${date}:${amountCad}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    receipts.push({
      source: 'one4another-paypal',
      transactionId,
      date,
      organization: 'One4Another',
      amountCad,
      taxClaimable: true,
      note: transactionId
        ? `Imported from One4Another PayPal receipt ${transactionId}`
        : 'Imported from One4Another PayPal receipt',
    });
  });

  return receipts.sort(compareGifts);
}

function findMatchingGift(gifts, receipt) {
  return gifts.find(
    (gift) =>
      gift &&
      gift.date === receipt.date &&
      typeof gift.organization === 'string' &&
      gift.organization.trim().toLowerCase() === receipt.organization.toLowerCase() &&
      Math.abs(Number(gift.amountCad) - receipt.amountCad) < 0.01
  ) || null;
}

function buildGiftSummary(gifts, year) {
  const normalizedYear = normalizeYear(year);
  if (!normalizedYear) {
    const error = new Error('Year must be between 1900 and 3000');
    error.code = 'INVALID_YEAR';
    throw error;
  }
  const yearPrefix = `${normalizedYear}-`;
  const filtered = gifts.filter((gift) => typeof gift.date === 'string' && gift.date.startsWith(yearPrefix));
  const byOrganization = new Map();
  let totalCad = 0;
  let taxClaimableCad = 0;
  let nonTaxClaimableCad = 0;

  filtered.forEach((gift) => {
    const amountCad = Number.isFinite(gift.amountCad) ? gift.amountCad : 0;
    totalCad += amountCad;
    if (gift.taxClaimable) {
      taxClaimableCad += amountCad;
    } else {
      nonTaxClaimableCad += amountCad;
    }
    const key = gift.organization.toLocaleLowerCase();
    const existing = byOrganization.get(key) || {
      organization: gift.organization,
      totalCad: 0,
      taxClaimableCad: 0,
      nonTaxClaimableCad: 0,
      count: 0,
    };
    existing.totalCad += amountCad;
    if (gift.taxClaimable) {
      existing.taxClaimableCad += amountCad;
    } else {
      existing.nonTaxClaimableCad += amountCad;
    }
    existing.count += 1;
    byOrganization.set(key, existing);
  });

  const organizations = Array.from(byOrganization.values())
    .map((entry) => ({
      ...entry,
      totalCad: Math.round(entry.totalCad * 100) / 100,
      taxClaimableCad: Math.round(entry.taxClaimableCad * 100) / 100,
      nonTaxClaimableCad: Math.round(entry.nonTaxClaimableCad * 100) / 100,
      share: totalCad > 0 ? entry.totalCad / totalCad : 0,
    }))
    .sort((a, b) => b.totalCad - a.totalCad || a.organization.localeCompare(b.organization));

  return {
    year: normalizedYear,
    totalCad: Math.round(totalCad * 100) / 100,
    taxClaimableCad: Math.round(taxClaimableCad * 100) / 100,
    nonTaxClaimableCad: Math.round(nonTaxClaimableCad * 100) / 100,
    giftCount: filtered.length,
    organizationCount: organizations.length,
    organizations,
  };
}

function listGifts(params = {}, options = {}) {
  const { gifts, filePath, updatedAt } = readGiftContainer(options);
  const year =
    params.year === undefined || params.year === null || params.year === ''
      ? null
      : normalizeYear(params.year);
  if (params.year !== undefined && params.year !== null && params.year !== '' && !year) {
    const error = new Error('Year must be between 1900 and 3000');
    error.code = 'INVALID_YEAR';
    throw error;
  }
  const filtered = year
    ? gifts.filter((gift) => gift.date.startsWith(`${year}-`))
    : gifts;
  const sorted = filtered.slice().sort(compareGifts);
  const summary = buildGiftSummary(gifts, year || new Date().getFullYear());
  return {
    gifts: sorted,
    summary,
    filePath,
    updatedAt,
  };
}

function createGift(input, options = {}) {
  const container = readGiftContainer(options);
  const now = new Date().toISOString();
  const gift = {
    id: crypto.randomUUID(),
    ...normalizeGiftInput(input),
    createdAt: now,
    updatedAt: now,
  };
  const gifts = container.gifts.concat(gift).sort(compareGifts);
  const result = writeGiftContainer(gifts, options);
  return { gift, gifts, filePath: result.filePath, updatedAt: result.updatedAt };
}

function updateGift(id, input, options = {}) {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) {
    const error = new Error('Gift id is required');
    error.code = 'INVALID_ID';
    throw error;
  }
  const container = readGiftContainer(options);
  const index = container.gifts.findIndex((gift) => gift.id === normalizedId);
  if (index < 0) {
    const error = new Error('Gift not found');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const existing = container.gifts[index];
  const nextGift = {
    ...existing,
    ...normalizeGiftInput(input, existing),
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const gifts = container.gifts.slice();
  gifts[index] = nextGift;
  gifts.sort(compareGifts);
  const result = writeGiftContainer(gifts, options);
  return { gift: nextGift, gifts, filePath: result.filePath, updatedAt: result.updatedAt };
}

function deleteGift(id, options = {}) {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!normalizedId) {
    const error = new Error('Gift id is required');
    error.code = 'INVALID_ID';
    throw error;
  }
  const container = readGiftContainer(options);
  const index = container.gifts.findIndex((gift) => gift.id === normalizedId);
  if (index < 0) {
    const error = new Error('Gift not found');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const gift = container.gifts[index];
  const gifts = container.gifts.filter((entry) => entry.id !== normalizedId);
  const result = writeGiftContainer(gifts, options);
  return { gift, gifts, filePath: result.filePath, updatedAt: result.updatedAt };
}

function reconcileGiftReceipts(input = {}, options = {}) {
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'one4another-paypal';
  if (source !== 'one4another-paypal') {
    const error = new Error('Only One4Another PayPal receipt imports are supported right now');
    error.code = 'INVALID_RECEIPT_SOURCE';
    throw error;
  }

  const text = normalizeReceiptText(input.text);
  if (!text.trim()) {
    const error = new Error('Paste at least one receipt email');
    error.code = 'INVALID_RECEIPT_TEXT';
    throw error;
  }

  const shouldImport = input.import === true;
  const container = readGiftContainer(options);
  const receipts = parseOne4AnotherPayPalReceipts(text);
  let gifts = container.gifts.slice();
  const now = new Date().toISOString();

  const candidates = receipts.map((receipt) => {
    const existingGift = findMatchingGift(gifts, receipt);
    if (existingGift) {
      return {
        ...receipt,
        status: 'matched',
        existingGiftId: existingGift.id,
      };
    }
    if (!shouldImport) {
      return {
        ...receipt,
        status: 'new',
      };
    }
    const gift = {
      id: crypto.randomUUID(),
      date: receipt.date,
      organization: receipt.organization,
      amountCad: receipt.amountCad,
      taxClaimable: receipt.taxClaimable,
      note: receipt.note,
      createdAt: now,
      updatedAt: now,
    };
    gifts = gifts.concat(gift).sort(compareGifts);
    return {
      ...receipt,
      status: 'imported',
      giftId: gift.id,
    };
  });

  let updatedAt = container.updatedAt || null;
  if (shouldImport && candidates.some((candidate) => candidate.status === 'imported')) {
    const result = writeGiftContainer(gifts, options);
    updatedAt = result.updatedAt;
  }

  const year = input.year === undefined || input.year === null || input.year === ''
    ? new Date().getFullYear()
    : normalizeYear(input.year);
  if (input.year !== undefined && input.year !== null && input.year !== '' && !year) {
    const error = new Error('Year must be between 1900 and 3000');
    error.code = 'INVALID_YEAR';
    throw error;
  }

  return {
    source,
    candidates,
    importedCount: candidates.filter((candidate) => candidate.status === 'imported').length,
    matchedCount: candidates.filter((candidate) => candidate.status === 'matched').length,
    newCount: candidates.filter((candidate) => candidate.status === 'new').length,
    gifts: year ? gifts.filter((gift) => gift.date.startsWith(`${year}-`)).sort(compareGifts) : gifts.sort(compareGifts),
    summary: buildGiftSummary(gifts, year || new Date().getFullYear()),
    filePath: container.filePath,
    updatedAt,
  };
}

module.exports = {
  buildGiftSummary,
  createGift,
  deleteGift,
  parseOne4AnotherPayPalReceipts,
  reconcileGiftReceipts,
  listGifts,
  normalizeAmountCad,
  normalizeDateOnly,
  normalizeGiftInput,
  normalizeYear,
  readGiftContainer,
  resolveGiftsFilePath,
  updateGift,
};
