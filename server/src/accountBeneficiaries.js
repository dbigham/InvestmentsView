const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_NAME = 'account-beneficiaries.json';

const beneficiariesFilePath = (() => {
  const configured = process.env.ACCOUNT_BENEFICIARIES_FILE;
  if (!configured) {
    return path.join(process.cwd(), DEFAULT_FILE_NAME);
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.join(process.cwd(), configured);
})();

let cachedBeneficiaries = { overrides: Object.create(null), defaultBeneficiary: null };
let cachedMarker = null;
let hasLoggedError = false;

function createMarker(stats) {
  if (!stats) {
    return null;
  }
  return String(stats.size) + ':' + String(stats.mtimeMs);
}

function applyBeneficiary(target, key, beneficiary) {
  if (!key || !beneficiary) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedValue = String(beneficiary).trim();
  if (!normalizedValue) {
    return;
  }
  const lookupKey = normalizedKey.toLowerCase();
  target[lookupKey] = normalizedValue;
  const condensed = normalizedKey.replace(/\s+/g, '');
  if (condensed && condensed.toLowerCase() !== lookupKey) {
    target[condensed.toLowerCase()] = normalizedValue;
  }
}

function extractEntry(target, entry, fallbackKey) {
  if (entry === null || entry === undefined) {
    return;
  }
  if (typeof entry === 'string') {
    if (fallbackKey) {
      applyBeneficiary(target, fallbackKey, entry);
    }
    return;
  }
  if (typeof entry !== 'object') {
    return;
  }

  const candidateBeneficiary =
    entry.beneficiary ?? entry.value ?? entry.name ?? entry.label ?? entry.display ?? entry.target;

  const candidateKey =
    entry.account ??
    entry.number ??
    entry.accountNumber ??
    entry.id ??
    entry.key ??
    entry.accountId ??
    entry.identifier ??
    entry.match ??
    fallbackKey;

  const candidateDisplay = entry.displayName ?? entry.title ?? entry.alias ?? entry.description ?? null;

  if (candidateKey !== undefined && candidateBeneficiary !== undefined) {
    applyBeneficiary(target, candidateKey, candidateBeneficiary);
  }

  if (candidateDisplay !== undefined && candidateBeneficiary !== undefined) {
    applyBeneficiary(target, candidateDisplay, candidateBeneficiary);
  }
}

function collectOverrides(target, container) {
  if (!container) {
    return;
  }
  if (Array.isArray(container)) {
    container.forEach((entry) => {
      extractEntry(target, entry, undefined);
    });
    return;
  }
  if (typeof container !== 'object') {
    return;
  }
  Object.keys(container).forEach((key) => {
    const value = container[key];
    if (key === 'default' || key === 'defaultBeneficiary' || key === 'defaults') {
      return;
    }
    if (typeof value === 'string') {
      applyBeneficiary(target, key, value);
      return;
    }
    extractEntry(target, value, key);
  });
}

function normalizeBeneficiaries(raw) {
  const overrides = Object.create(null);
  if (!raw || typeof raw !== 'object') {
    return { overrides, defaultBeneficiary: null };
  }

  const defaultCandidate =
    raw.defaultBeneficiary ?? raw.default ?? (raw.defaults && raw.defaults.beneficiary) ?? null;
  const defaultBeneficiary =
    typeof defaultCandidate === 'string' && defaultCandidate.trim() ? defaultCandidate.trim() : null;

  const containers = [];
  if (Array.isArray(raw)) {
    containers.push(raw);
  } else {
    containers.push(raw);
    const nestedKeys = ['accounts', 'overrides', 'items', 'entries'];
    nestedKeys.forEach((key) => {
      if (raw[key]) {
        containers.push(raw[key]);
      }
    });
  }

  containers.forEach((container) => {
    collectOverrides(overrides, container);
  });

  return { overrides, defaultBeneficiary };
}

function loadBeneficiaries() {
  if (!beneficiariesFilePath) {
    cachedBeneficiaries = { overrides: Object.create(null), defaultBeneficiary: null };
    cachedMarker = null;
    return cachedBeneficiaries;
  }
  if (!fs.existsSync(beneficiariesFilePath)) {
    cachedBeneficiaries = { overrides: Object.create(null), defaultBeneficiary: null };
    cachedMarker = null;
    hasLoggedError = false;
    return cachedBeneficiaries;
  }
  const stats = fs.statSync(beneficiariesFilePath);
  const marker = createMarker(stats);
  if (marker && marker === cachedMarker) {
    return cachedBeneficiaries;
  }
  const content = fs.readFileSync(beneficiariesFilePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    cachedBeneficiaries = { overrides: Object.create(null), defaultBeneficiary: null };
    cachedMarker = marker;
    hasLoggedError = false;
    return cachedBeneficiaries;
  }
  const parsed = JSON.parse(content);
  cachedBeneficiaries = normalizeBeneficiaries(parsed);
  cachedMarker = marker;
  hasLoggedError = false;
  return cachedBeneficiaries;
}

function getAccountBeneficiaries() {
  try {
    return loadBeneficiaries();
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account beneficiary overrides from ' + beneficiariesFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedBeneficiaries || { overrides: Object.create(null), defaultBeneficiary: null };
  }
}

module.exports = {
  getAccountBeneficiaries,
  accountBeneficiariesFilePath: beneficiariesFilePath,
};
