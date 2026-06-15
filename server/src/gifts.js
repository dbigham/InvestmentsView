const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveDataPath } = require('./dataPaths');

const DEFAULT_GIFTS_FILE = 'gifts.json';
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

module.exports = {
  buildGiftSummary,
  createGift,
  deleteGift,
  listGifts,
  normalizeAmountCad,
  normalizeDateOnly,
  normalizeGiftInput,
  normalizeYear,
  readGiftContainer,
  resolveGiftsFilePath,
  updateGift,
};
