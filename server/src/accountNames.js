const fs = require('fs');
const path = require('path');

const DEFAULT_FILE_CANDIDATES = ['accounts.json', 'account-names.json'];

function resolveConfiguredFilePath() {
  const configured = process.env.ACCOUNTS_FILE || process.env.ACCOUNT_NAMES_FILE;
  if (configured) {
    if (path.isAbsolute(configured)) {
      return configured;
    }
    // If a relative path is provided, prefer CWD but fall back to server root
    const fromCwd = path.join(process.cwd(), configured);
    if (fs.existsSync(fromCwd)) {
      return fromCwd;
    }
    const fromServerRoot = path.join(__dirname, '..', configured);
    if (fs.existsSync(fromServerRoot)) {
      return fromServerRoot;
    }
    return fromCwd;
  }
  for (const name of DEFAULT_FILE_CANDIDATES) {
    // 1) Try current working directory
    const fromCwd = path.join(process.cwd(), name);
    if (fs.existsSync(fromCwd)) {
      return fromCwd;
    }
    // 2) Try server root (one level above this file)
    const fromServerRoot = path.join(__dirname, '..', name);
    if (fs.existsSync(fromServerRoot)) {
      return fromServerRoot;
    }
  }
  // Default to CWD path for predictable error messages elsewhere
  return path.join(process.cwd(), DEFAULT_FILE_CANDIDATES[0]);
}

let resolvedFilePath = resolveConfiguredFilePath();
let cachedOverrides = {};
let cachedPortalOverrides = {};
let cachedChatOverrides = {};
let cachedSettings = {};
let cachedOrdering = [];
let cachedDefaultAccount = null;
let cachedGroupRelations = {};
let cachedGroupMetadata = {};
let cachedMarker = null;
let hasLoggedError = false;

function createMarker(stats) {
  if (!stats) {
    return null;
  }
  return String(stats.size) + ':' + String(stats.mtimeMs);
}

function isLikelyAccountKey(key) {
  if (key === undefined || key === null) {
    return false;
  }
  return /[0-9]/.test(String(key));
}

function applyOverride(target, key, label) {
  if (!key || !label) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedLabel = String(label).trim();
  if (!normalizedLabel) {
    return;
  }
  target[normalizedKey] = normalizedLabel;
}

function applyPortalOverride(target, key, portalId) {
  if (!key || !portalId) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedPortalId = String(portalId).trim();
  if (!normalizedPortalId) {
    return;
  }
  target[normalizedKey] = normalizedPortalId;
}

function coerceBoolean(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['true', 'yes', 'on', '1'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', 'off', '0'].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function ensureAccountSettingsEntry(target, key) {
  if (!target || !key) {
    return null;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return null;
  }
  const existing = target[normalizedKey];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing;
  }
  const container = {};
  target[normalizedKey] = container;
  return container;
}

function normalizeNumberLike(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const sanitized = trimmed.replace(/,/g, '').replace(/\s+/g, '');
    const parsed = Number.parseFloat(sanitized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'amount')) {
      return normalizeNumberLike(value.amount);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'value')) {
      return normalizeNumberLike(value.value);
    }
  }
  return null;
}

function normalizePositiveInteger(value) {
  const numeric = normalizeNumberLike(value);
  if (numeric === null) {
    return null;
  }
  const rounded = Math.round(numeric);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return null;
  }
  return rounded;
}

function applyShowDetailsSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const resolved = coerceBoolean(value);
  if (resolved === null) {
    return;
  }
  container.showQQQDetails = resolved;
}

function normalizeModelKey(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function applyInvestmentModelSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeModelKey(value);
  if (!normalized) {
    delete container.investmentModel;
    return;
  }
  container.investmentModel = normalized;
}

function normalizeInvestmentModelSymbol(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function normalizeInvestmentModelEntry(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const modelOnly = normalizeModelKey(value);
    return modelOnly ? { model: modelOnly.toUpperCase() } : null;
  }

  if (typeof value !== 'object') {
    return null;
  }

  const modelCandidate =
    value.model ?? value.experiment ?? value.id ?? value.key ?? value.name ?? value.title;
  const normalizedModel = normalizeModelKey(modelCandidate);
  if (!normalizedModel) {
    return null;
  }

  const entry = { model: normalizedModel.toUpperCase() };

  const symbolCandidate = value.symbol ?? value.baseSymbol ?? value.base_symbol;
  const normalizedSymbol = normalizeInvestmentModelSymbol(symbolCandidate);
  if (normalizedSymbol) {
    entry.symbol = normalizedSymbol;
  }

  const leveragedCandidate =
    value.leveragedSymbol ?? value.leveraged_symbol ?? value.leveraged ?? value.leveragedsymbol;
  const normalizedLeveraged = normalizeInvestmentModelSymbol(leveragedCandidate);
  if (normalizedLeveraged) {
    entry.leveragedSymbol = normalizedLeveraged;
  }

  const reserveCandidate = value.reserveSymbol ?? value.reserve_symbol ?? value.reserve;
  const normalizedReserve = normalizeInvestmentModelSymbol(reserveCandidate);
  if (normalizedReserve) {
    entry.reserveSymbol = normalizedReserve;
  }

  const normalizedLastRebalance = normalizeDateOnly(
    value.lastRebalance ?? value.last_rebalance ?? value.last_rebalance_date
  );
  if (normalizedLastRebalance) {
    entry.lastRebalance = normalizedLastRebalance;
  }

  const normalizedRebalancePeriod = normalizePositiveInteger(
    value.rebalancePeriod ?? value.rebalance_period ?? value.rebalancePeriodDays ?? value.rebalance_period_days
  );
  if (normalizedRebalancePeriod !== null) {
    entry.rebalancePeriod = normalizedRebalancePeriod;
  }

  if (typeof value.title === 'string' && value.title.trim()) {
    entry.title = value.title.trim();
  } else if (typeof value.label === 'string' && value.label.trim()) {
    entry.title = value.label.trim();
  }

  return entry;
}

function normalizeInvestmentModels(value) {
  if (value == null) {
    return [];
  }

  const source = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const normalized = [];

  source.forEach((entry) => {
    const normalizedEntry = normalizeInvestmentModelEntry(entry);
    if (!normalizedEntry || !normalizedEntry.model) {
      return;
    }
    const key = normalizedEntry.model.toUpperCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    normalized.push(normalizedEntry);
  });

  return normalized;
}

function applyInvestmentModelsSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeInvestmentModels(value);
  if (!normalized.length) {
    delete container.investmentModels;
    return;
  }
  container.investmentModels = normalized;
  if (!container.investmentModel && normalized[0] && normalized[0].model) {
    container.investmentModel = normalized[0].model;
  }
}

function applyNetDepositAdjustmentSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeNumberLike(value);
  if (normalized === null) {
    delete container.netDepositAdjustment;
    return;
  }
  container.netDepositAdjustment = normalized;
}

function applyCagrStartDateSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    delete container.cagrStartDate;
    return;
  }
  container.cagrStartDate = normalized;
}

function applyIgnoreSittingCashSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeNumberLike(value);
  if (normalized === null) {
    delete container.ignoreSittingCash;
    return;
  }
  const rounded = Math.round(normalized);
  if (!Number.isFinite(rounded) || rounded < 0) {
    delete container.ignoreSittingCash;
    return;
  }
  container.ignoreSittingCash = rounded;
}

function applyProjectionGrowthPercentSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const numeric = normalizeNumberLike(value);
  if (numeric === null || Number.isNaN(numeric)) {
    if (Object.prototype.hasOwnProperty.call(container, 'projectionGrowthPercent')) {
      delete container.projectionGrowthPercent;
    }
    return;
  }
  const rounded = Math.round(Number(numeric) * 100) / 100;
  if (Number.isFinite(rounded)) {
    container.projectionGrowthPercent = rounded;
  }
}

function applyRetirementInflationPercentSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const numeric = normalizeNumberLike(value);
  if (numeric === null || Number.isNaN(numeric)) {
    if (Object.prototype.hasOwnProperty.call(container, 'retirementInflationPercent')) {
      delete container.retirementInflationPercent;
    }
    return;
  }
  const bounded = Math.max(0, Math.min(Number(numeric), 1000));
  const rounded = Math.round(bounded * 100) / 100; // keep two decimals
  if (Number.isFinite(rounded)) {
    container.retirementInflationPercent = rounded;
  }
}

function normalizeRetirementAge(value) {
  const numeric = normalizeNumberLike(value);
  if (numeric === null || Number.isNaN(numeric)) {
    return null;
  }
  const rounded = Math.round(Number(numeric));
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return null;
  }
  return rounded;
}

function normalizeRetirementAmount(value) {
  const numeric = normalizeNumberLike(value);
  if (numeric === null || Number.isNaN(numeric)) {
    return null;
  }
  const rounded = Math.round(Number(numeric) * 100) / 100;
  if (!Number.isFinite(rounded) || rounded < 0) {
    return null;
  }
  return rounded;
}

function applyRetirementAgeSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeRetirementAge(value);
  if (normalized === null) {
    delete container.retirementAge;
    return;
  }
  container.retirementAge = normalized;
}

function applyRetirementIncomeSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeRetirementAmount(value);
  if (normalized === null) {
    delete container.retirementIncome;
    return;
  }
  container.retirementIncome = normalized;
}

function applyRetirementLivingExpensesSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeRetirementAmount(value);
  if (normalized === null) {
    delete container.retirementLivingExpenses;
    return;
  }
  container.retirementLivingExpenses = normalized;
}

function applyMainRetirementAccountSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = coerceBoolean(value);
  if (normalized === null) {
    delete container.mainRetirementAccount;
    return;
  }
  container.mainRetirementAccount = normalized;
}

function recordGroupMetadataEntry(target, label, entry) {
  if (!target || !entry) {
    return;
  }
  const normalizedName = normalizeAccountGroupName(label);
  if (!normalizedName) {
    return;
  }
  const key = normalizedName.toLowerCase();
  if (!key) {
    return;
  }
  const existing = target.get(key) || { name: normalizedName };
  const metadata = Object.assign({ name: normalizedName }, existing);
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(entry, 'mainRetirementAccount')) {
    const normalized = coerceBoolean(entry.mainRetirementAccount);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(metadata, 'mainRetirementAccount')) {
        delete metadata.mainRetirementAccount;
        changed = true;
      }
    } else if (metadata.mainRetirementAccount !== normalized) {
      metadata.mainRetirementAccount = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'retirementAge')) {
    const normalized = normalizeRetirementAge(entry.retirementAge);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(metadata, 'retirementAge')) {
        delete metadata.retirementAge;
        changed = true;
      }
    } else if (metadata.retirementAge !== normalized) {
      metadata.retirementAge = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'retirementIncome')) {
    const normalized = normalizeRetirementAmount(entry.retirementIncome);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(metadata, 'retirementIncome')) {
        delete metadata.retirementIncome;
        changed = true;
      }
    } else if (metadata.retirementIncome !== normalized) {
      metadata.retirementIncome = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'retirementLivingExpenses')) {
    const normalized = normalizeRetirementAmount(entry.retirementLivingExpenses);
    if (normalized === null) {
      if (
        Object.prototype.hasOwnProperty.call(metadata, 'retirementLivingExpenses')
      ) {
        delete metadata.retirementLivingExpenses;
        changed = true;
      }
    } else if (metadata.retirementLivingExpenses !== normalized) {
      metadata.retirementLivingExpenses = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'retirementBirthDate')) {
    const normalized = normalizeDateOnly(entry.retirementBirthDate);
    if (normalized) {
      if (metadata.retirementBirthDate !== normalized) {
        metadata.retirementBirthDate = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(metadata, 'retirementBirthDate')) {
      delete metadata.retirementBirthDate;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'retirementInflationPercent')) {
    const numeric = normalizeNumberLike(entry.retirementInflationPercent);
    if (numeric === null || Number.isNaN(numeric)) {
      if (Object.prototype.hasOwnProperty.call(metadata, 'retirementInflationPercent')) {
        delete metadata.retirementInflationPercent;
        changed = true;
      }
    } else {
      const bounded = Math.max(0, Math.min(Number(numeric), 1000));
      const rounded = Math.round(bounded * 100) / 100;
      if (metadata.retirementInflationPercent !== rounded) {
        metadata.retirementInflationPercent = rounded;
        changed = true;
      }
    }
  }

  if (!changed && target.has(key)) {
    return;
  }

  const keys = Object.keys(metadata);
  if (keys.length === 1 && keys[0] === 'name') {
    target.delete(key);
    return;
  }

  target.set(key, metadata);
}

function serializeGroupMetadataMap(map) {
  if (!map || typeof map.forEach !== 'function') {
    return {};
  }
  const result = {};
  map.forEach((value, key) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    result[key] = Object.assign({}, value);
  });
  return result;
}

function normalizeTargetSymbol(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toUpperCase();
  return normalized || null;
}

function normalizeSymbolTargetProportion(value) {
  const numeric = normalizeNumberLike(value);
  if (numeric === null) {
    return null;
  }
  const percent = Number(numeric);
  if (!Number.isFinite(percent) || percent <= 0) {
    return null;
  }
  const bounded = Math.min(Math.max(percent, 0), 1000);
  const rounded = Math.round((bounded + Number.EPSILON) * 10000) / 10000;
  return rounded;
}

function normalizeSymbolNote(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function normalizePlanningContext(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return null;
}

function normalizeAccountGroupName(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const stringValue = typeof value === 'string' ? value : String(value);
  const normalized = stringValue.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeSymbolEntry(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const entry = {};

    if (Object.prototype.hasOwnProperty.call(value, 'targetProportion')) {
      const target = normalizeSymbolTargetProportion(value.targetProportion);
      if (target !== null) {
        entry.targetProportion = target;
      }
    }

    const percentCandidate =
      value.targetProportion ??
      value.percent ??
      value.percentage ??
      value.weight ??
      value.value ??
      value.target ??
      value.targetPercent ??
      value.targetPercentage;
    const normalizedPercent = normalizeSymbolTargetProportion(percentCandidate);
    if (normalizedPercent !== null) {
      entry.targetProportion = normalizedPercent;
    }

    if (Object.prototype.hasOwnProperty.call(value, 'notes')) {
      const note = normalizeSymbolNote(value.notes);
      if (note) {
        entry.notes = note;
      }
    } else {
      const noteCandidate = value.note ?? value.comment ?? value.text;
      const normalizedNote = normalizeSymbolNote(noteCandidate);
      if (normalizedNote) {
        entry.notes = normalizedNote;
      }
    }

    return Object.keys(entry).length ? entry : null;
  }

  const normalizedPercent = normalizeSymbolTargetProportion(value);
  if (normalizedPercent !== null) {
    return { targetProportion: normalizedPercent };
  }

  const normalizedNote = normalizeSymbolNote(value);
  if (normalizedNote) {
    return { notes: normalizedNote };
  }

  return null;
}

function normalizeSymbolSettings(container) {
  const map = new Map();
  if (!container) {
    return map;
  }

  const recordEntry = (symbolCandidate, entryValue) => {
    const symbol = normalizeTargetSymbol(symbolCandidate);
    if (!symbol) {
      return;
    }
    const normalizedEntry = normalizeSymbolEntry(entryValue);
    if (!normalizedEntry) {
      return;
    }
    const existing = map.get(symbol) || {};
    if (Object.prototype.hasOwnProperty.call(normalizedEntry, 'targetProportion')) {
      existing.targetProportion = normalizedEntry.targetProportion;
    }
    if (Object.prototype.hasOwnProperty.call(normalizedEntry, 'notes')) {
      existing.notes = normalizedEntry.notes;
    }
    map.set(symbol, existing);
  };

  if (Array.isArray(container)) {
    container.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const symbolCandidate =
        entry.symbol ?? entry.ticker ?? entry.code ?? entry.key ?? entry.name ?? entry.id;
      recordEntry(symbolCandidate, entry);
    });
    return map;
  }

  if (typeof container === 'object') {
    Object.entries(container).forEach(([key, value]) => {
      recordEntry(key, value);
    });
  }

  return map;
}

function serializeSymbolSettings(map) {
  if (!map || map.size === 0) {
    return null;
  }
  const entries = [];
  map.forEach((value, symbol) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    const container = {};
    if (Number.isFinite(value.targetProportion)) {
      container.targetProportion = value.targetProportion;
    }
    if (typeof value.notes === 'string' && value.notes) {
      container.notes = value.notes;
    }
    if (Object.keys(container).length > 0) {
      entries.push([symbol, container]);
    }
  });
  if (!entries.length) {
    return null;
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const result = {};
  entries.forEach(([symbol, container]) => {
    result[symbol] = container;
  });
  return result;
}

function buildSymbolNotesMapFromSettings(map) {
  if (!map || map.size === 0) {
    return null;
  }
  const entries = [];
  map.forEach((value, symbol) => {
    if (!value || typeof value.notes !== 'string' || !value.notes) {
      return;
    }
    entries.push([symbol, value.notes]);
  });
  if (!entries.length) {
    return null;
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const result = {};
  entries.forEach(([symbol, note]) => {
    result[symbol] = note;
  });
  return result;
}

function readSymbolSettingsFromEntry(entry) {
  const map = new Map();
  if (!entry || typeof entry !== 'object') {
    return map;
  }
  const existingSymbols = normalizeSymbolSettings(entry.symbols);
  existingSymbols.forEach((value, symbol) => {
    map.set(symbol, Object.assign({}, value));
  });
  const targetMap = normalizeTargetProportions(entry.targetProportions, { strict: false });
  if (targetMap) {
    Object.entries(targetMap).forEach(([symbol, percent]) => {
      const existing = map.get(symbol) || {};
      existing.targetProportion = percent;
      map.set(symbol, existing);
    });
  }
  return map;
}

function writeSymbolSettingsToEntry(entry, map) {
  const nextSymbols = serializeSymbolSettings(map);
  const existingSymbols = serializeSymbolSettings(normalizeSymbolSettings(entry?.symbols));

  const nextSymbolsJson = JSON.stringify(nextSymbols);
  const existingSymbolsJson = JSON.stringify(existingSymbols);

  let changed = false;

  if (nextSymbolsJson !== existingSymbolsJson) {
    if (nextSymbols) {
      entry.symbols = nextSymbols;
    } else if (entry && Object.prototype.hasOwnProperty.call(entry, 'symbols')) {
      delete entry.symbols;
    }
    changed = true;
  }

  if (entry && Object.prototype.hasOwnProperty.call(entry, 'targetProportions')) {
    delete entry.targetProportions;
    changed = true;
  }

  return changed;
}

function extractSymbolSettingsFromOverride(override) {
  if (!override || typeof override !== 'object') {
    return { symbolSettings: null, symbolNotes: null };
  }

  const map = normalizeSymbolSettings(override.symbols);
  const targetMap = normalizeTargetProportions(override.targetProportions, { strict: false });
  if (targetMap) {
    Object.entries(targetMap).forEach(([symbol, percent]) => {
      const existing = map.get(symbol) || {};
      existing.targetProportion = percent;
      map.set(symbol, existing);
    });
  }

  const symbolSettings = serializeSymbolSettings(map);
  const symbolNotes = buildSymbolNotesMapFromSettings(map);

  return {
    symbolSettings: symbolSettings || null,
    symbolNotes: symbolNotes || null,
  };
}

function normalizeTargetProportions(value, { strict = false } = {}) {
  if (value === null || value === undefined) {
    return null;
  }

  const entries = new Map();

  const recordEntry = (symbolCandidate, percentCandidate) => {
    const symbol = normalizeTargetSymbol(symbolCandidate);
    if (!symbol) {
      return;
    }
    const normalizedPercent = normalizeSymbolTargetProportion(percentCandidate);
    if (normalizedPercent === null) {
      return;
    }
    entries.set(symbol, normalizedPercent);
  };

  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const symbolCandidate =
        entry.symbol ?? entry.ticker ?? entry.code ?? entry.key ?? entry.name ?? entry.id;
      const percentCandidate =
        entry.percent ??
        entry.percentage ??
        entry.weight ??
        entry.value ??
        entry.target ??
        entry.targetPercent ??
        entry.targetPercentage;
      recordEntry(symbolCandidate, percentCandidate);
    });
  } else if (typeof value === 'object') {
    Object.entries(value).forEach(([key, entryValue]) => {
      if (entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
        const percentCandidate =
          entryValue.percent ??
          entryValue.percentage ??
          entryValue.weight ??
          entryValue.value ??
          entryValue.target ??
          entryValue.targetPercent ??
          entryValue.targetPercentage;
        recordEntry(key, percentCandidate);
        return;
      }
      recordEntry(key, entryValue);
    });
  } else {
    if (strict) {
      const error = new Error('Target proportions must be provided as an object or array.');
      error.code = 'INVALID_PROPORTIONS';
      throw error;
    }
    return null;
  }

  if (!entries.size) {
    return null;
  }

  const sortedSymbols = Array.from(entries.keys()).sort((a, b) => a.localeCompare(b));
  const normalized = {};
  sortedSymbols.forEach((symbol) => {
    normalized[symbol] = entries.get(symbol);
  });
  return normalized;
}

function applyTargetProportionsSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  let normalized = null;
  try {
    normalized = normalizeTargetProportions(value, { strict: false });
  } catch (error) {
    normalized = null;
  }
  const settingsMap = normalizeSymbolSettings(container.symbols);

  if (normalized) {
    Object.entries(normalized).forEach(([symbol, percent]) => {
      const existing = settingsMap.get(symbol) || {};
      const nextEntry = Object.assign({}, existing, { targetProportion: percent });
      if (typeof existing.notes === 'string' && existing.notes) {
        nextEntry.notes = existing.notes;
      }
      settingsMap.set(symbol, nextEntry);
    });

    settingsMap.forEach((entry, symbol) => {
      if (Object.prototype.hasOwnProperty.call(normalized, symbol)) {
        return;
      }
      if (!entry || typeof entry !== 'object') {
        settingsMap.delete(symbol);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(entry, 'targetProportion')) {
        if (typeof entry.notes === 'string' && entry.notes) {
          settingsMap.set(symbol, { notes: entry.notes });
        } else {
          settingsMap.delete(symbol);
        }
      }
    });
  } else {
    settingsMap.forEach((entry, symbol) => {
      if (!entry || typeof entry !== 'object') {
        settingsMap.delete(symbol);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(entry, 'targetProportion')) {
        if (typeof entry.notes === 'string' && entry.notes) {
          settingsMap.set(symbol, { notes: entry.notes });
        } else {
          settingsMap.delete(symbol);
        }
      }
    });
  }

  const serialized = serializeSymbolSettings(settingsMap);
  if (serialized) {
    container.symbols = serialized;
  } else if (Object.prototype.hasOwnProperty.call(container, 'symbols')) {
    delete container.symbols;
  }

  if (Object.prototype.hasOwnProperty.call(container, 'targetProportions')) {
    delete container.targetProportions;
  }
}

function applySymbolSettingsSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const existingMap = normalizeSymbolSettings(container.symbols);
  const normalizedMap = normalizeSymbolSettings(value);

  normalizedMap.forEach((entry, symbol) => {
    const existing = existingMap.get(symbol) || {};
    const merged = Object.assign({}, existing, entry);
    existingMap.set(symbol, merged);
  });

  const serialized = serializeSymbolSettings(existingMap);
  if (serialized) {
    container.symbols = serialized;
  } else {
    delete container.symbols;
  }
}

function applyPlanningContextSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizePlanningContext(value);
  if (!normalized) {
    delete container.planningContext;
    return;
  }
  container.planningContext = normalized;
}

function applyAccountGroupSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeAccountGroupName(value);
  if (!normalized) {
    delete container.accountGroup;
    return;
  }
  container.accountGroup = normalized;
}

function normalizeDateOnly(value) {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) {
      return null;
    }
    return new Date(time).toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const derived = new Date(value);
    if (Number.isNaN(derived.getTime())) {
      return null;
    }
    return derived.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'date')) {
      return normalizeDateOnly(value.date);
    }
    return null;
  }
  return null;
}

function applyLastRebalanceSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    delete container.lastRebalance;
    return;
  }
  container.lastRebalance = normalized;
}

function applyRebalancePeriodSetting(target, key, value) {
  const container = ensureAccountSettingsEntry(target, key);
  if (!container) {
    return;
  }
  const normalized = normalizePositiveInteger(value);
  if (normalized === null) {
    delete container.rebalancePeriod;
    return;
  }
  container.rebalancePeriod = normalized;
}

function recordOrdering(tracker, key) {
  if (!tracker) {
    return;
  }
  const normalizedKey = key == null ? '' : String(key).trim();
  if (!normalizedKey) {
    return;
  }
  if (tracker.seen.has(normalizedKey)) {
    return;
  }
  tracker.seen.add(normalizedKey);
  tracker.list.push(normalizedKey);
}

const ACCOUNT_ENTRY_HINT_KEYS = new Set([
  'name',
  'displayName',
  'label',
  'title',
  'value',
  'nickname',
  'alias',
  'number',
  'accountNumber',
  'accountId',
  'id',
  'key',
  'portalAccountId',
  'portalId',
  'portal',
  'portalUUID',
  'portalUuid',
  'uuid',
  'accountUuid',
  'summaryUuid',
  'chatURL',
  'chatUrl',
  'showQQQDetails',
]);

const PORTAL_ID_KEYS = [
  'portalAccountId',
  'portalId',
  'portal',
  'portalUUID',
  'portalUuid',
  'uuid',
  'accountUuid',
  'summaryUuid',
  'questradePortalId',
  'questradeAccountId',
];

const CHAT_URL_KEYS = ['chatURL', 'chatUrl'];

function isLikelyAccountEntryObject(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  return Object.keys(entry).some((key) => ACCOUNT_ENTRY_HINT_KEYS.has(key));
}

function deriveChildContext(currentContext, source) {
  if (!source || typeof source !== 'object') {
    return currentContext || null;
  }

  if (!Object.prototype.hasOwnProperty.call(source, 'accountGroup')) {
    return currentContext || null;
  }

  const normalized = normalizeAccountGroupName(source.accountGroup);
  if (normalized !== null) {
    if (
      currentContext &&
      currentContext.hasAccountGroup === true &&
      currentContext.accountGroup === normalized
    ) {
      return currentContext;
    }
    return { accountGroup: normalized, hasAccountGroup: true };
  }

  if (currentContext && currentContext.hasAccountGroup === true && currentContext.accountGroup === null) {
    return currentContext;
  }

  return { accountGroup: null, hasAccountGroup: true };
}

function collectGroupRelationsRaw(node, relationsMap) {
  if (!node) {
    return;
  }
  const addRelation = (childName, parentName) => {
    const child = normalizeAccountGroupName(childName);
    const parent = normalizeAccountGroupName(parentName);
    if (!child || !parent) {
      return;
    }
    let set = relationsMap.get(child);
    if (!set) {
      set = new Set();
      relationsMap.set(child, set);
    }
    set.add(parent);
  };
  const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const hasAnyKey = (obj, keys) => keys.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
  const accountIdKeys = ['number', 'accountNumber', 'accountId', 'id', 'key'];

  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item));
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    // Record relation when entry declares a group but is not a concrete account (no id/number)
    if (
      typeof value.name === 'string' &&
      Object.prototype.hasOwnProperty.call(value, 'accountGroup') &&
      !hasAnyKey(value, accountIdKeys)
    ) {
      addRelation(value.name, value.accountGroup);
    }
    Object.values(value).forEach((child) => walk(child));
  };

  walk(node);
}

function resolvePortalCandidate(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  for (const key of PORTAL_ID_KEYS) {
    if (entry[key] !== undefined && entry[key] !== null) {
      const candidate = String(entry[key]).trim();
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function applyChatOverride(target, key, url) {
  if (!target) {
    return;
  }
  if (!key || !url) {
    return;
  }
  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    return;
  }
  const normalizedUrl = String(url).trim();
  if (!normalizedUrl) {
    return;
  }
  target[normalizedKey] = normalizedUrl;
}

function resolveChatCandidate(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  for (const key of CHAT_URL_KEYS) {
    if (entry[key] !== undefined && entry[key] !== null) {
      const candidate = String(entry[key]).trim();
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}

function extractEntry(
  namesTarget,
  portalTarget,
  chatTarget,
  settingsTarget,
  defaultTracker,
  entry,
  fallbackKey,
  orderingTracker,
  context,
  explicitAccountGroupKeys,
  groupRelations,
  groupMetadataTarget
) {
  if (entry === null || entry === undefined) {
    return;
  }
  if (typeof entry === 'string') {
    if (isLikelyAccountKey(fallbackKey)) {
      applyOverride(namesTarget, fallbackKey, entry);
      recordOrdering(orderingTracker, fallbackKey);
    }
    return;
  }
  if (typeof entry !== 'object') {
    return;
  }

  const candidateKey =
    entry.number ?? entry.accountNumber ?? entry.id ?? entry.key ?? entry.accountId ?? fallbackKey;

  const candidateLabel =
    entry.name ??
    entry.displayName ??
    entry.label ??
    entry.title ??
    entry.value ??
    entry.nickname ??
    entry.alias;

  const portalCandidate = resolvePortalCandidate(entry);
  const chatCandidate = resolveChatCandidate(entry);

  const resolvedKey =
    candidateKey !== undefined && candidateKey !== null
      ? candidateKey
      : isLikelyAccountKey(fallbackKey)
      ? fallbackKey
      : undefined;

  const inheritedAccountGroup =
    context && context.hasAccountGroup === true ? context.accountGroup : null;
  const hasInheritedAccountGroup =
    context && context.hasAccountGroup === true && typeof inheritedAccountGroup === 'string' && inheritedAccountGroup;
  const hasExplicitAccountGroup = Object.prototype.hasOwnProperty.call(entry, 'accountGroup');

  if (candidateLabel !== undefined && resolvedKey !== undefined) {
    applyOverride(namesTarget, resolvedKey, candidateLabel);
  }

  if (portalCandidate && resolvedKey !== undefined) {
    applyPortalOverride(portalTarget, resolvedKey, portalCandidate);
  }

  if (chatCandidate && resolvedKey !== undefined) {
    applyChatOverride(chatTarget, resolvedKey, chatCandidate);
  }

  if (settingsTarget && resolvedKey !== undefined) {
    if (Object.prototype.hasOwnProperty.call(entry, 'showQQQDetails')) {
      applyShowDetailsSetting(settingsTarget, resolvedKey, entry.showQQQDetails);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'investmentModel')) {
      applyInvestmentModelSetting(settingsTarget, resolvedKey, entry.investmentModel);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'investmentModels')) {
      applyInvestmentModelsSetting(settingsTarget, resolvedKey, entry.investmentModels);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'lastRebalance')) {
      applyLastRebalanceSetting(settingsTarget, resolvedKey, entry.lastRebalance);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'rebalancePeriod')) {
      applyRebalancePeriodSetting(settingsTarget, resolvedKey, entry.rebalancePeriod);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'netDepositAdjustment')) {
      applyNetDepositAdjustmentSetting(settingsTarget, resolvedKey, entry.netDepositAdjustment);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'cagrStartDate')) {
      applyCagrStartDateSetting(settingsTarget, resolvedKey, entry.cagrStartDate);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'ignoreSittingCash')) {
      applyIgnoreSittingCashSetting(settingsTarget, resolvedKey, entry.ignoreSittingCash);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'projectionGrowthPercent')) {
      applyProjectionGrowthPercentSetting(
        settingsTarget,
        resolvedKey,
        entry.projectionGrowthPercent
      );
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'retirementInflationPercent')) {
      applyRetirementInflationPercentSetting(settingsTarget, resolvedKey, entry.retirementInflationPercent);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'targetProportions')) {
      applyTargetProportionsSetting(settingsTarget, resolvedKey, entry.targetProportions);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'symbols')) {
      applySymbolSettingsSetting(settingsTarget, resolvedKey, entry.symbols);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'planningContext')) {
      applyPlanningContextSetting(settingsTarget, resolvedKey, entry.planningContext);
    }
    if (hasExplicitAccountGroup) {
      const normalizedKey = String(resolvedKey).trim();
      if (normalizedKey) {
        explicitAccountGroupKeys.add(normalizedKey);
      }
      applyAccountGroupSetting(settingsTarget, resolvedKey, entry.accountGroup);
    } else if (hasInheritedAccountGroup) {
      const normalizedKey = String(resolvedKey).trim();
      if (normalizedKey && !explicitAccountGroupKeys.has(normalizedKey)) {
        applyAccountGroupSetting(settingsTarget, resolvedKey, inheritedAccountGroup);
      }
    }
  }

  // Capture group-to-parent mapping for container/group entries that declare an accountGroup
  // but don’t resolve to an account key (i.e., they represent a group node, not an account).
  if (hasExplicitAccountGroup && resolvedKey === undefined && groupRelations) {
    const childGroupName = normalizeAccountGroupName(candidateLabel);
    const parentGroupName = normalizeAccountGroupName(entry.accountGroup);
    if (childGroupName && parentGroupName) {
      const childKey = childGroupName;
      let parents = groupRelations.get(childKey);
      if (!parents) {
        parents = new Set();
        groupRelations.set(childKey, parents);
      }
      parents.add(parentGroupName);
    }
  }

  if (defaultTracker && resolvedKey !== undefined) {
    const resolvedDefault = coerceBoolean(entry.default);
    if (resolvedDefault === true && !defaultTracker.value) {
      const normalizedKey = String(resolvedKey).trim();
      if (normalizedKey) {
        defaultTracker.value = normalizedKey;
      }
    }
  }

  if (groupMetadataTarget && resolvedKey === undefined && candidateLabel !== undefined) {
    recordGroupMetadataEntry(groupMetadataTarget, candidateLabel, entry);
  }

  if (resolvedKey !== undefined) {
    recordOrdering(orderingTracker, resolvedKey);
  }

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items', 'entries'];
  const childContext = deriveChildContext(context || null, entry);
  nestedKeys.forEach((key) => {
    if (entry[key]) {
      collectOverridesFromContainer(
        namesTarget,
        portalTarget,
        chatTarget,
        settingsTarget,
        defaultTracker,
        entry[key],
        orderingTracker,
        childContext,
        explicitAccountGroupKeys,
        groupRelations,
        groupMetadataTarget
      );
    }
  });
}

function collectOverridesFromContainer(
  namesTarget,
  portalTarget,
  chatTarget,
  settingsTarget,
  defaultTracker,
  container,
  orderingTracker,
  context,
  explicitAccountGroupKeys,
  groupRelations,
  groupMetadataTarget
) {
  if (!container) {
    return;
  }
  if (Array.isArray(container)) {
    container.forEach((entry) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && !isLikelyAccountEntryObject(entry)) {
        const nextContext = deriveChildContext(context || null, entry);
        collectOverridesFromContainer(
        namesTarget,
        portalTarget,
        chatTarget,
        settingsTarget,
        defaultTracker,
        entry,
        orderingTracker,
        nextContext,
        explicitAccountGroupKeys,
        groupRelations,
        groupMetadataTarget
      );
      return;
    }
    extractEntry(
      namesTarget,
        portalTarget,
        chatTarget,
        settingsTarget,
        defaultTracker,
        entry,
        undefined,
        orderingTracker,
        context || null,
        explicitAccountGroupKeys,
        groupRelations,
        groupMetadataTarget
      );
    });
    return;
  }
  if (typeof container !== 'object') {
    return;
  }

  const containerContext = deriveChildContext(context || null, container);

  Object.keys(container).forEach((key) => {
    const value = container[key];
    if (typeof value === 'string') {
      if (isLikelyAccountKey(key)) {
        applyOverride(namesTarget, key, value);
        recordOrdering(orderingTracker, key);
      }
      return;
    }
    if (isLikelyAccountKey(key) || isLikelyAccountEntryObject(value)) {
      extractEntry(
        namesTarget,
        portalTarget,
        chatTarget,
        settingsTarget,
        defaultTracker,
        value,
        key,
        orderingTracker,
        containerContext,
        explicitAccountGroupKeys,
        groupRelations,
        groupMetadataTarget
      );
      return;
    }
    if (value && typeof value === 'object') {
      const nextContext = deriveChildContext(containerContext, value);
      collectOverridesFromContainer(
        namesTarget,
        portalTarget,
        chatTarget,
        settingsTarget,
        defaultTracker,
        value,
        orderingTracker,
        nextContext,
        explicitAccountGroupKeys,
        groupRelations,
        groupMetadataTarget
      );
    }
  });
}

function normalizeAccountOverrides(raw) {
  const overrides = {};
  const portalOverrides = {};
  const chatOverrides = {};
  const settings = {};
  const orderingTracker = { list: [], seen: new Set() };
  const defaultTracker = { value: null };
  const explicitAccountGroupKeys = new Set();
  const groupRelations = new Map();
  const groupMetadata = new Map();
  // Pre-scan raw config to pick up group->parent declarations robustly
  try {
    collectGroupRelationsRaw(raw, groupRelations);
  } catch {}

  // Note: We intentionally do not support explicit top-level groupRelations overrides.
  // Group relationships are inferred from container entries that have a name and accountGroup
  // but are not concrete accounts.
  if (!raw) {
    return {
      overrides,
      portalOverrides,
      chatOverrides,
      settings,
      ordering: orderingTracker.list,
      defaultAccount: null,
      groupRelations: {},
      groupMetadata: {},
    };
  }
  if (typeof raw !== 'object') {
    return {
      overrides,
      portalOverrides,
      chatOverrides,
      settings,
      ordering: orderingTracker.list,
      defaultAccount: null,
      groupRelations: {},
      groupMetadata: {},
    };
  }

  if (Array.isArray(raw)) {
    collectOverridesFromContainer(
      overrides,
      portalOverrides,
      chatOverrides,
      settings,
      defaultTracker,
      raw,
      orderingTracker,
      null,
      explicitAccountGroupKeys,
      groupRelations,
      groupMetadata
    );
    const serializedRelations = {};
    groupRelations.forEach((parents, child) => {
      serializedRelations[child] = Array.from(parents);
    });
    return {
      overrides,
      portalOverrides,
      chatOverrides,
      settings,
      ordering: orderingTracker.list,
      defaultAccount: defaultTracker.value,
      groupRelations: serializedRelations,
      groupMetadata: serializeGroupMetadataMap(groupMetadata),
    };
  }

  const rootContext = deriveChildContext(null, raw);
  collectOverridesFromContainer(
    overrides,
    portalOverrides,
    chatOverrides,
    settings,
    defaultTracker,
    raw,
    orderingTracker,
    rootContext,
    explicitAccountGroupKeys,
    groupRelations,
    groupMetadata
  );

  const nestedKeys = ['accounts', 'numbers', 'overrides', 'items', 'entries'];
  nestedKeys.forEach((key) => {
    if (raw[key]) {
      collectOverridesFromContainer(
        overrides,
        portalOverrides,
        chatOverrides,
        settings,
        defaultTracker,
        raw[key],
        orderingTracker,
        rootContext,
        explicitAccountGroupKeys,
        groupRelations,
        groupMetadata
      );
    }
  });

  const serializedRelations = {};
  groupRelations.forEach((parents, child) => {
    serializedRelations[child] = Array.from(parents);
  });

  return {
    overrides,
    portalOverrides,
    chatOverrides,
    settings,
    ordering: orderingTracker.list,
    defaultAccount: defaultTracker.value,
    groupRelations: serializedRelations,
    groupMetadata: serializeGroupMetadataMap(groupMetadata),
  };
}

function loadAccountOverrides() {
  const filePath = resolveConfiguredFilePath();
  if (filePath !== resolvedFilePath) {
    resolvedFilePath = filePath;
    cachedMarker = null;
  }
  if (!filePath) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    cachedMarker = null;
    cachedDefaultAccount = null;
    hasLoggedError = false;
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
      groupRelations: cachedGroupRelations,
      groupMetadata: cachedGroupMetadata,
      defaultAccount: cachedDefaultAccount,
    };
  }
  if (!fs.existsSync(filePath)) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    cachedMarker = null;
    cachedDefaultAccount = null;
    hasLoggedError = false;
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
      groupRelations: cachedGroupRelations,
      groupMetadata: cachedGroupMetadata,
      defaultAccount: cachedDefaultAccount,
    };
  }
  const stats = fs.statSync(filePath);
  const marker = createMarker(stats);
  if (marker && marker === cachedMarker) {
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
      groupRelations: cachedGroupRelations,
      groupMetadata: cachedGroupMetadata,
      defaultAccount: cachedDefaultAccount,
    };
  }
  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    cachedMarker = marker;
    cachedDefaultAccount = null;
    hasLoggedError = false;
    return {
      overrides: cachedOverrides,
      portalOverrides: cachedPortalOverrides,
      chatOverrides: cachedChatOverrides,
      settings: cachedSettings,
      ordering: cachedOrdering,
      groupRelations: cachedGroupRelations,
      groupMetadata: cachedGroupMetadata,
      defaultAccount: cachedDefaultAccount,
    };
  }
  const parsed = JSON.parse(content);
  const normalized = normalizeAccountOverrides(parsed);
  cachedOverrides = normalized.overrides;
  cachedPortalOverrides = normalized.portalOverrides;
  cachedChatOverrides = normalized.chatOverrides;
  cachedSettings = normalized.settings || {};
  cachedOrdering = normalized.ordering || [];
  cachedGroupRelations = normalized.groupRelations || {};
  cachedGroupMetadata = normalized.groupMetadata || {};
  cachedMarker = marker;
  cachedDefaultAccount = normalized.defaultAccount || null;
  hasLoggedError = false;
  return {
    overrides: cachedOverrides,
    portalOverrides: cachedPortalOverrides,
    chatOverrides: cachedChatOverrides,
    settings: cachedSettings,
    ordering: cachedOrdering,
    groupRelations: cachedGroupRelations,
    groupMetadata: cachedGroupMetadata,
    defaultAccount: cachedDefaultAccount,
  };
}

function getAccountNameOverrides() {
  try {
    return loadAccountOverrides().overrides;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedOverrides || {};
  }
}

function getAccountPortalOverrides() {
  try {
    return loadAccountOverrides().portalOverrides;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedPortalOverrides || {};
  }
}

function getAccountChatOverrides() {
  try {
    return loadAccountOverrides().chatOverrides;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedChatOverrides || {};
  }
}

function getAccountOrdering() {
  try {
    return loadAccountOverrides().ordering || [];
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedOrdering || [];
  }
}

function getAccountSettings() {
  try {
    return loadAccountOverrides().settings || {};
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedSettings || {};
  }
}

function getDefaultAccountId() {
  try {
    return loadAccountOverrides().defaultAccount || null;
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedDefaultAccount || null;
  }
}

function getAccountGroupRelations() {
  try {
    return loadAccountOverrides().groupRelations || {};
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedGroupRelations || {};
  }
}

function getAccountGroupMetadata() {
  try {
    return loadAccountOverrides().groupMetadata || {};
  } catch (error) {
    if (!hasLoggedError) {
      console.warn('Failed to load account overrides from ' + resolvedFilePath + ':', error.message);
      hasLoggedError = true;
    }
    return cachedGroupMetadata || {};
  }
}

function buildAccountKeySet(raw) {
  const normalized = raw == null ? '' : String(raw).trim();
  if (!normalized) {
    return null;
  }
  const set = new Set();
  set.add(normalized);
  const colonIndex = normalized.lastIndexOf(':');
  if (colonIndex >= 0) {
    const suffix = normalized.slice(colonIndex + 1).trim();
    if (suffix) {
      set.add(suffix);
    }
  }
  return set;
}

function matchesAccountKey(keySet, candidate) {
  if (!keySet || candidate === undefined || candidate === null) {
    return false;
  }
  const normalized = String(candidate).trim();
  if (!normalized) {
    return false;
  }
  return keySet.has(normalized);
}

function updateAccountConfigEntry(entry, newDate, modelKey) {
  if (!entry || typeof entry !== 'object') {
    return 0;
  }
  let updateCount = 0;
  if (Object.prototype.hasOwnProperty.call(entry, 'lastRebalance')) {
    entry.lastRebalance = newDate;
    updateCount += 1;
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'investmentModelLastRebalance')) {
    entry.investmentModelLastRebalance = newDate;
    updateCount += 1;
  }
  if (Array.isArray(entry.investmentModels)) {
    entry.investmentModels.forEach((modelEntry) => {
      if (!modelEntry || typeof modelEntry !== 'object') {
        return;
      }
      if (modelKey) {
        const candidate =
          typeof modelEntry.model === 'string' ? modelEntry.model.trim().toUpperCase() : null;
        if (!candidate || candidate !== modelKey) {
          return;
        }
      }
      if (Object.prototype.hasOwnProperty.call(modelEntry, 'lastRebalance')) {
        modelEntry.lastRebalance = newDate;
        updateCount += 1;
      }
    });
  }
  return updateCount;
}

function traverseAndUpdate(container, keySet, newDate, modelKey) {
  if (!container) {
    return { updated: false, count: 0 };
  }

  let updated = false;
  let totalCount = 0;

  const processEntry = (entry, fallbackKey) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidates = [
      entry.number,
      entry.accountNumber,
      entry.accountId,
      entry.id,
      entry.key,
      entry.name,
      entry.displayName,
      fallbackKey,
    ];
    if (candidates.some((candidate) => matchesAccountKey(keySet, candidate))) {
      const delta = updateAccountConfigEntry(entry, newDate, modelKey);
      if (delta > 0) {
        updated = true;
        totalCount += delta;
      }
    }
  };

  const walk = (node, fallbackKey) => {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (item && typeof item === 'object') {
          processEntry(item);
          walk(item);
        } else {
          walk(item);
        }
      });
      return;
    }
    if (typeof node !== 'object') {
      return;
    }

    processEntry(node, fallbackKey);

    Object.entries(node).forEach(([key, value]) => {
      if (matchesAccountKey(keySet, key) && value && typeof value === 'object') {
        const delta = updateAccountConfigEntry(value, newDate, modelKey);
        if (delta > 0) {
          updated = true;
          totalCount += delta;
        }
      }
      walk(value, key);
    });
  };

  walk(container);

  return { updated, count: totalCount };
}

function applyTargetProportionsToEntry(entry, normalizedMap) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }

  const settingsMap = readSymbolSettingsFromEntry(entry);
  const normalizedEntries =
    normalizedMap && typeof normalizedMap === 'object'
      ? Object.entries(normalizedMap)
      : [];

  if (!normalizedEntries.length) {
    settingsMap.forEach((value, symbol) => {
      if (!value || typeof value !== 'object') {
        settingsMap.delete(symbol);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(value, 'targetProportion')) {
        if (typeof value.notes === 'string' && value.notes) {
          settingsMap.set(symbol, { notes: value.notes });
        } else {
          settingsMap.delete(symbol);
        }
      }
    });
    return writeSymbolSettingsToEntry(entry, settingsMap);
  }

  const normalizedMapEntries = new Map();
  normalizedEntries.forEach(([symbol, percent]) => {
    const normalizedSymbol = normalizeTargetSymbol(symbol);
    if (!normalizedSymbol) {
      return;
    }
    const numeric = normalizeSymbolTargetProportion(percent);
    if (numeric === null) {
      return;
    }
    normalizedMapEntries.set(normalizedSymbol, numeric);
  });

  normalizedMapEntries.forEach((percent, symbol) => {
    const existing = settingsMap.get(symbol) || {};
    const nextEntry = Object.assign({}, existing, { targetProportion: percent });
    if (typeof existing.notes === 'string' && existing.notes) {
      nextEntry.notes = existing.notes;
    }
    settingsMap.set(symbol, nextEntry);
  });

  settingsMap.forEach((value, symbol) => {
    if (normalizedMapEntries.has(symbol)) {
      return;
    }
    if (!value || typeof value !== 'object') {
      settingsMap.delete(symbol);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'targetProportion')) {
      if (typeof value.notes === 'string' && value.notes) {
        settingsMap.set(symbol, { notes: value.notes });
      } else {
        settingsMap.delete(symbol);
      }
    }
  });

  return writeSymbolSettingsToEntry(entry, settingsMap);
}

function traverseAndSetTargetProportions(container, keySet, normalizedMap) {
  if (!container) {
    return { updated: false, count: 0, matched: false };
  }

  let updated = false;
  let totalCount = 0;
  let matched = false;

  const processEntry = (entry, fallbackKey) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidates = [
      entry.number,
      entry.accountNumber,
      entry.accountId,
      entry.id,
      entry.key,
      fallbackKey,
    ];
    if (candidates.some((candidate) => matchesAccountKey(keySet, candidate))) {
      matched = true;
      if (applyTargetProportionsToEntry(entry, normalizedMap)) {
        updated = true;
        totalCount += 1;
      }
    }
  };

  const walk = (node, fallbackKey) => {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (item && typeof item === 'object') {
          processEntry(item);
          walk(item);
        } else {
          walk(item);
        }
      });
      return;
    }
    if (typeof node !== 'object') {
      return;
    }

    processEntry(node, fallbackKey);

    Object.entries(node).forEach(([key, value]) => {
      if (matchesAccountKey(keySet, key) && value && typeof value === 'object') {
        matched = true;
        if (applyTargetProportionsToEntry(value, normalizedMap)) {
          updated = true;
          totalCount += 1;
        }
      }
      walk(value, key);
    });
  };

  walk(container);

  return { updated, count: totalCount, matched };
}

function applyPlanningContextToEntry(entry, normalizedContext) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }

  const hasExisting = Object.prototype.hasOwnProperty.call(entry, 'planningContext');
  const existingRaw = hasExisting && typeof entry.planningContext === 'string' ? entry.planningContext : null;
  const existingNormalized = existingRaw ? existingRaw.trim() || null : null;

  if (!normalizedContext) {
    if (!hasExisting) {
      return false;
    }
    delete entry.planningContext;
    return existingNormalized !== null || existingRaw !== null;
  }

  if (existingNormalized === normalizedContext && existingRaw === normalizedContext) {
    return false;
  }

  entry.planningContext = normalizedContext;
  return existingNormalized !== normalizedContext || existingRaw !== normalizedContext;
}

function traverseAndSetPlanningContext(container, keySet, normalizedContext) {
  if (!container) {
    return { updated: false, matched: false, count: 0 };
  }

  let updated = false;
  let matched = false;
  let count = 0;

  const processEntry = (entry, fallbackKey) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidates = [
      entry.number,
      entry.accountNumber,
      entry.accountId,
      entry.id,
      entry.key,
      fallbackKey,
    ];
    if (candidates.some((candidate) => matchesAccountKey(keySet, candidate))) {
      matched = true;
      if (applyPlanningContextToEntry(entry, normalizedContext)) {
        updated = true;
        count += 1;
      }
    }
  };

  const walk = (node, fallbackKey) => {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (item && typeof item === 'object') {
          processEntry(item);
          walk(item);
        } else {
          walk(item);
        }
      });
      return;
    }
    if (typeof node !== 'object') {
      return;
    }

    processEntry(node, fallbackKey);

    Object.entries(node).forEach(([key, value]) => {
      if (matchesAccountKey(keySet, key) && value && typeof value === 'object') {
        matched = true;
        if (applyPlanningContextToEntry(value, normalizedContext)) {
          updated = true;
          count += 1;
        }
      }
      walk(value, key);
    });
  };

  walk(container);

  return { updated, matched, count };
}

function normalizeDisplayName(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str || null;
}

function normalizePortalId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str || null;
}

function normalizeChatUrl(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const str = String(value).trim();
  return str || null;
}

function applyMetadataToEntry(entry, updates) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  if (!updates || typeof updates !== 'object') {
    return false;
  }

  let changed = false;

  if (Object.prototype.hasOwnProperty.call(updates, 'displayName')) {
    const normalized = normalizeDisplayName(updates.displayName);
    if (normalized) {
      if (entry.name !== normalized) {
        entry.name = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'name')) {
      delete entry.name;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'portalAccountId')) {
    const normalized = normalizePortalId(updates.portalAccountId);
    if (normalized) {
      if (entry.portalAccountId !== normalized) {
        entry.portalAccountId = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'portalAccountId')) {
      delete entry.portalAccountId;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'chatURL')) {
    const normalized = normalizeChatUrl(updates.chatURL);
    if (normalized) {
      if (entry.chatURL !== normalized) {
        entry.chatURL = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'chatURL')) {
      delete entry.chatURL;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'cagrStartDate')) {
    const normalized = normalizeDateOnly(updates.cagrStartDate);
    if (normalized) {
      if (entry.cagrStartDate !== normalized) {
        entry.cagrStartDate = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'cagrStartDate')) {
      delete entry.cagrStartDate;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'rebalancePeriod')) {
    const normalized = normalizePositiveInteger(updates.rebalancePeriod);
    if (normalized !== null) {
      if (entry.rebalancePeriod !== normalized) {
        entry.rebalancePeriod = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'rebalancePeriod')) {
      delete entry.rebalancePeriod;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'ignoreSittingCash')) {
    const numeric = normalizeNumberLike(updates.ignoreSittingCash);
    if (numeric === null) {
      if (Object.prototype.hasOwnProperty.call(entry, 'ignoreSittingCash')) {
        delete entry.ignoreSittingCash;
        changed = true;
      }
    } else {
      const rounded = Math.max(0, Math.round(numeric));
      if (entry.ignoreSittingCash !== rounded) {
        entry.ignoreSittingCash = rounded;
        changed = true;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'projectionGrowthPercent')) {
    const numeric = Number(updates.projectionGrowthPercent);
    if (!Number.isFinite(numeric)) {
      if (Object.prototype.hasOwnProperty.call(entry, 'projectionGrowthPercent')) {
        delete entry.projectionGrowthPercent;
        changed = true;
      }
    } else {
      const rounded = Math.round(numeric * 100) / 100; // keep two decimals
      if (entry.projectionGrowthPercent !== rounded) {
        entry.projectionGrowthPercent = rounded;
        changed = true;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'accountGroup')) {
    const normalized = normalizeAccountGroupName(updates.accountGroup);
    if (normalized) {
      if (entry.accountGroup !== normalized) {
        entry.accountGroup = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'accountGroup')) {
      delete entry.accountGroup;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'mainRetirementAccount')) {
    const normalized = coerceBoolean(updates.mainRetirementAccount);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(entry, 'mainRetirementAccount')) {
        delete entry.mainRetirementAccount;
        changed = true;
      }
    } else if (entry.mainRetirementAccount !== normalized) {
      entry.mainRetirementAccount = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'retirementAge')) {
    const normalized = normalizeRetirementAge(updates.retirementAge);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(entry, 'retirementAge')) {
        delete entry.retirementAge;
        changed = true;
      }
    } else if (entry.retirementAge !== normalized) {
      entry.retirementAge = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'retirementIncome')) {
    const normalized = normalizeRetirementAmount(updates.retirementIncome);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(entry, 'retirementIncome')) {
        delete entry.retirementIncome;
        changed = true;
      }
    } else if (entry.retirementIncome !== normalized) {
      entry.retirementIncome = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'retirementLivingExpenses')) {
    const normalized = normalizeRetirementAmount(updates.retirementLivingExpenses);
    if (normalized === null) {
      if (Object.prototype.hasOwnProperty.call(entry, 'retirementLivingExpenses')) {
        delete entry.retirementLivingExpenses;
        changed = true;
      }
    } else if (entry.retirementLivingExpenses !== normalized) {
      entry.retirementLivingExpenses = normalized;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'retirementBirthDate')) {
    const normalized = normalizeDateOnly(updates.retirementBirthDate);
    if (normalized) {
      if (entry.retirementBirthDate !== normalized) {
        entry.retirementBirthDate = normalized;
        changed = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(entry, 'retirementBirthDate')) {
      delete entry.retirementBirthDate;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'retirementInflationPercent')) {
    const numeric = normalizeNumberLike(updates.retirementInflationPercent);
    if (numeric === null || Number.isNaN(numeric)) {
      if (Object.prototype.hasOwnProperty.call(entry, 'retirementInflationPercent')) {
        delete entry.retirementInflationPercent;
        changed = true;
      }
    } else {
      const bounded = Math.max(0, Math.min(Number(numeric), 1000));
      const rounded = Math.round(bounded * 100) / 100;
      if (entry.retirementInflationPercent !== rounded) {
        entry.retirementInflationPercent = rounded;
        changed = true;
      }
    }
  }

  return changed;
}

function traverseAndUpdateMetadata(container, keySet, updates) {
  if (!container) {
    return { updated: false, matched: false, count: 0 };
  }

  let updated = false;
  let matched = false;
  let count = 0;

  const processEntry = (entry, fallbackKey) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidates = [
      entry.number,
      entry.accountNumber,
      entry.accountId,
      entry.id,
      entry.key,
      entry.name,
      entry.displayName,
      fallbackKey,
    ];
    if (candidates.some((candidate) => matchesAccountKey(keySet, candidate))) {
      matched = true;
      if (applyMetadataToEntry(entry, updates)) {
        updated = true;
        count += 1;
      }
    }
  };

  const walk = (node, fallbackKey) => {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (item && typeof item === 'object') {
          processEntry(item);
          walk(item);
        } else {
          walk(item);
        }
      });
      return;
    }
    if (typeof node !== 'object') {
      return;
    }

    processEntry(node, fallbackKey);

    Object.entries(node).forEach(([key, value]) => {
      if (matchesAccountKey(keySet, key) && value && typeof value === 'object') {
        matched = true;
        if (applyMetadataToEntry(value, updates)) {
          updated = true;
          count += 1;
        }
      }
      walk(value, key);
    });
  };

  walk(container);

  return { updated, matched, count };
}

function updateAccountMetadata(accountKey, updates) {
  const keySet = buildAccountKeySet(accountKey);
  if (!keySet) {
    const error = new Error('Account identifier is required');
    error.code = 'INVALID_ACCOUNT';
    throw error;
  }

  const filePath = resolveConfiguredFilePath();
  if (!filePath) {
    const error = new Error('Accounts file path is not configured');
    error.code = 'NO_FILE';
    throw error;
  }
  if (!fs.existsSync(filePath)) {
    const error = new Error('Accounts file not found at ' + filePath);
    error.code = 'NO_FILE';
    throw error;
  }

  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    const error = new Error('Accounts file is empty');
    error.code = 'NOT_FOUND';
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    const error = new Error('Failed to parse accounts file');
    error.code = 'PARSE_ERROR';
    error.cause = parseError;
    throw error;
  }

  const updateResult = traverseAndUpdateMetadata(parsed, keySet, updates || {});
  if (!updateResult.matched) {
    const error = new Error('Account configuration not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  if (updateResult.updated) {
    const serialized = JSON.stringify(parsed, null, 2);
    fs.writeFileSync(filePath, serialized + (serialized.endsWith('\n') ? '' : '\n'), 'utf-8');

    cachedMarker = null;
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedDefaultAccount = null;
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    hasLoggedError = false;
    loadAccountOverrides();
  }

  // Normalize payload for response
  return {
    updated: updateResult.updated,
    updatedCount: updateResult.count,
    payload: {
      displayName: normalizeDisplayName(updates?.displayName) || null,
      portalAccountId: normalizePortalId(updates?.portalAccountId) || null,
      chatURL: normalizeChatUrl(updates?.chatURL) || null,
      cagrStartDate: normalizeDateOnly(updates?.cagrStartDate) || null,
      rebalancePeriod: normalizePositiveInteger(updates?.rebalancePeriod),
      ignoreSittingCash: (function () {
        const numeric = normalizeNumberLike(updates?.ignoreSittingCash);
        if (numeric === null) return null;
        const rounded = Math.max(0, Math.round(numeric));
        return Number.isFinite(rounded) ? rounded : null;
      })(),
      projectionGrowthPercent: (function () {
        const n = Number(updates?.projectionGrowthPercent);
        if (!Number.isFinite(n)) return null;
        const rounded = Math.round(n * 100) / 100;
        return Number.isFinite(rounded) ? rounded : null;
      })(),
      accountGroup: normalizeAccountGroupName(updates?.accountGroup) || null,
      mainRetirementAccount: (function () {
        const normalized = coerceBoolean(updates?.mainRetirementAccount);
        return normalized === null ? null : normalized;
      })(),
      retirementAge: normalizeRetirementAge(updates?.retirementAge),
      retirementIncome: normalizeRetirementAmount(updates?.retirementIncome),
      retirementLivingExpenses: normalizeRetirementAmount(updates?.retirementLivingExpenses),
      retirementBirthDate: normalizeDateOnly(updates?.retirementBirthDate),
      retirementInflationPercent: (function () {
        const numeric = normalizeNumberLike(updates?.retirementInflationPercent);
        if (numeric === null || Number.isNaN(numeric)) return null;
        const bounded = Math.max(0, Math.min(Number(numeric), 1000));
        const rounded = Math.round(bounded * 100) / 100;
        return Number.isFinite(rounded) ? rounded : null;
      })(),
    },
  };
}

function applySymbolNoteToEntry(entry, symbolKey, noteValue) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }

  const symbol = normalizeTargetSymbol(symbolKey);
  if (!symbol) {
    const error = new Error('Symbol is required');
    error.code = 'INVALID_SYMBOL';
    throw error;
  }

  const settingsMap = readSymbolSettingsFromEntry(entry);
  const existing = settingsMap.get(symbol) || null;
  const existingNote = existing && typeof existing.notes === 'string' ? existing.notes : '';
  const normalizedNote = normalizeSymbolNote(noteValue) || '';

  if (!existing && !normalizedNote) {
    return false;
  }

  if (existing) {
    const nextEntry = {};
    if (Object.prototype.hasOwnProperty.call(existing, 'targetProportion')) {
      nextEntry.targetProportion = existing.targetProportion;
    }
    if (normalizedNote) {
      nextEntry.notes = normalizedNote;
    }
    if (!normalizedNote && !Object.prototype.hasOwnProperty.call(nextEntry, 'targetProportion')) {
      settingsMap.delete(symbol);
    } else {
      settingsMap.set(symbol, nextEntry);
    }
  } else if (normalizedNote) {
    settingsMap.set(symbol, { notes: normalizedNote });
  }

  if (existingNote === normalizedNote) {
    // No effective change after normalization
    return false;
  }

  return writeSymbolSettingsToEntry(entry, settingsMap);
}

function traverseAndSetSymbolNote(container, keySet, symbolKey, noteValue) {
  if (!container) {
    return { updated: false, matched: false, count: 0 };
  }

  let updated = false;
  let matched = false;
  let count = 0;

  const processEntry = (entry, fallbackKey) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidates = [
      entry.number,
      entry.accountNumber,
      entry.accountId,
      entry.id,
      entry.key,
      fallbackKey,
    ];
    if (candidates.some((candidate) => matchesAccountKey(keySet, candidate))) {
      matched = true;
      if (applySymbolNoteToEntry(entry, symbolKey, noteValue)) {
        updated = true;
        count += 1;
      }
    }
  };

  const walk = (node, fallbackKey) => {
    if (!node) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => {
        if (item && typeof item === 'object') {
          processEntry(item);
          walk(item);
        } else {
          walk(item);
        }
      });
      return;
    }
    if (typeof node !== 'object') {
      return;
    }

    processEntry(node, fallbackKey);

    Object.entries(node).forEach(([key, value]) => {
      if (matchesAccountKey(keySet, key) && value && typeof value === 'object') {
        if (applySymbolNoteToEntry(value, symbolKey, noteValue)) {
          updated = true;
          matched = true;
          count += 1;
        }
      }
      walk(value, key);
    });
  };

  walk(container);

  return { updated, matched, count };
}

function updateAccountLastRebalance(accountKey, options = {}) {
  const keySet = buildAccountKeySet(accountKey);
  if (!keySet) {
    const error = new Error('Account identifier is required');
    error.code = 'INVALID_ACCOUNT';
    throw error;
  }

  const filePath = resolveConfiguredFilePath();
  if (!filePath) {
    const error = new Error('Accounts file path is not configured');
    error.code = 'NO_FILE';
    throw error;
  }
  if (!fs.existsSync(filePath)) {
    const error = new Error('Accounts file not found at ' + filePath);
    error.code = 'NO_FILE';
    throw error;
  }

  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    const error = new Error('Accounts file is empty');
    error.code = 'NOT_FOUND';
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    const error = new Error('Failed to parse accounts file');
    error.code = 'PARSE_ERROR';
    error.cause = parseError;
    throw error;
  }

  const normalizedModel =
    options && typeof options.model === 'string' && options.model.trim()
      ? options.model.trim().toUpperCase()
      : null;
  const newDate = new Date().toISOString().slice(0, 10);
  const updateResult = traverseAndUpdate(parsed, keySet, newDate, normalizedModel);
  if (!updateResult.updated) {
    const error = new Error('Account entry not found in configuration');
    error.code = 'NOT_FOUND';
    throw error;
  }

  const serialized = JSON.stringify(parsed, null, 2);
  fs.writeFileSync(filePath, serialized + (serialized.endsWith('\n') ? '' : '\n'), 'utf-8');

  cachedMarker = null;
  cachedOverrides = {};
  cachedPortalOverrides = {};
  cachedChatOverrides = {};
  cachedSettings = {};
  cachedOrdering = [];
  cachedDefaultAccount = null;
  cachedGroupRelations = {};
  cachedGroupMetadata = {};
  hasLoggedError = false;
  loadAccountOverrides();

  return { lastRebalance: newDate, updatedCount: updateResult.count };
}

function updateAccountTargetProportions(accountKey, rawProportions) {
  const keySet = buildAccountKeySet(accountKey);
  if (!keySet) {
    const error = new Error('Account identifier is required');
    error.code = 'INVALID_ACCOUNT';
    throw error;
  }

  let normalizedMap = null;
  try {
    normalizedMap = normalizeTargetProportions(rawProportions, { strict: true });
  } catch (error) {
    if (error && error.code === 'INVALID_PROPORTIONS') {
      throw error;
    }
    throw error;
  }

  const filePath = resolveConfiguredFilePath();
  if (!filePath) {
    const error = new Error('Accounts file path is not configured');
    error.code = 'NO_FILE';
    throw error;
  }
  if (!fs.existsSync(filePath)) {
    const error = new Error('Accounts file not found at ' + filePath);
    error.code = 'NO_FILE';
    throw error;
  }

  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    const error = new Error('Accounts file is empty');
    error.code = 'NOT_FOUND';
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    const error = new Error('Failed to parse accounts file');
    error.code = 'PARSE_ERROR';
    error.cause = parseError;
    throw error;
  }

  const updateResult = traverseAndSetTargetProportions(parsed, keySet, normalizedMap);
  if (!updateResult.matched) {
    const error = new Error('Account configuration not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  if (updateResult.updated) {
    const serialized = JSON.stringify(parsed, null, 2);
    fs.writeFileSync(filePath, serialized + (serialized.endsWith('\n') ? '' : '\n'), 'utf-8');

    cachedMarker = null;
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedDefaultAccount = null;
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    hasLoggedError = false;
    loadAccountOverrides();
  }

  const effectiveMap = normalizedMap && Object.keys(normalizedMap).length ? normalizedMap : null;
  const symbols =
    effectiveMap && Object.keys(effectiveMap).length
      ? Object.entries(effectiveMap).reduce((acc, [symbol, percent]) => {
          acc[symbol] = { targetProportion: percent };
          return acc;
        }, {})
      : null;

  return { symbols, updated: updateResult.updated, updatedCount: updateResult.count };
}

function updateAccountSymbolNote(accountKey, symbolKey, noteValue) {
  const keySet = buildAccountKeySet(accountKey);
  if (!keySet) {
    const error = new Error('Account identifier is required');
    error.code = 'INVALID_ACCOUNT';
    throw error;
  }

  const normalizedSymbol = normalizeTargetSymbol(symbolKey);
  if (!normalizedSymbol) {
    const error = new Error('Symbol is required');
    error.code = 'INVALID_SYMBOL';
    throw error;
  }

  const filePath = resolveConfiguredFilePath();
  if (!filePath) {
    const error = new Error('Accounts file path is not configured');
    error.code = 'NO_FILE';
    throw error;
  }
  if (!fs.existsSync(filePath)) {
    const error = new Error('Accounts file not found at ' + filePath);
    error.code = 'NO_FILE';
    throw error;
  }

  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    const error = new Error('Accounts file is empty');
    error.code = 'NOT_FOUND';
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    const error = new Error('Failed to parse accounts file');
    error.code = 'PARSE_ERROR';
    error.cause = parseError;
    throw error;
  }

  const updateResult = traverseAndSetSymbolNote(parsed, keySet, normalizedSymbol, noteValue);
  if (!updateResult.matched) {
    const error = new Error('Account configuration not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  if (updateResult.updated) {
    const serialized = JSON.stringify(parsed, null, 2);
    fs.writeFileSync(filePath, serialized + (serialized.endsWith('\n') ? '' : '\n'), 'utf-8');

    cachedMarker = null;
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedDefaultAccount = null;
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    hasLoggedError = false;
    loadAccountOverrides();
  }

  const normalizedNote = normalizeSymbolNote(noteValue);

  return {
    symbol: normalizedSymbol,
    note: normalizedNote || null,
    updated: updateResult.updated,
  };
}

function updateAccountPlanningContext(accountKey, contextValue) {
  const keySet = buildAccountKeySet(accountKey);
  if (!keySet) {
    const error = new Error('Account identifier is required');
    error.code = 'INVALID_ACCOUNT';
    throw error;
  }

  const normalizedContext = normalizePlanningContext(contextValue);

  const filePath = resolveConfiguredFilePath();
  if (!filePath) {
    const error = new Error('Accounts file path is not configured');
    error.code = 'NO_FILE';
    throw error;
  }
  if (!fs.existsSync(filePath)) {
    const error = new Error('Accounts file not found at ' + filePath);
    error.code = 'NO_FILE';
    throw error;
  }

  const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  if (!content.trim()) {
    const error = new Error('Accounts file is empty');
    error.code = 'NOT_FOUND';
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    const error = new Error('Failed to parse accounts file');
    error.code = 'PARSE_ERROR';
    error.cause = parseError;
    throw error;
  }

  const updateResult = traverseAndSetPlanningContext(parsed, keySet, normalizedContext);
  if (!updateResult.matched) {
    const error = new Error('Account configuration not found');
    error.code = 'NOT_FOUND';
    throw error;
  }

  if (updateResult.updated) {
    const serialized = JSON.stringify(parsed, null, 2);
    fs.writeFileSync(filePath, serialized + (serialized.endsWith('\n') ? '' : '\n'), 'utf-8');

    cachedMarker = null;
    cachedOverrides = {};
    cachedPortalOverrides = {};
    cachedChatOverrides = {};
    cachedSettings = {};
    cachedOrdering = [];
    cachedDefaultAccount = null;
    cachedGroupRelations = {};
    cachedGroupMetadata = {};
    hasLoggedError = false;
    loadAccountOverrides();
  }

  return {
    planningContext: normalizedContext,
    updated: updateResult.updated,
    updatedCount: updateResult.count,
  };
}

module.exports = {
  getAccountNameOverrides,
  getAccountPortalOverrides,
  getAccountChatOverrides,
  getAccountSettings,
  getAccountOrdering,
  getDefaultAccountId,
  updateAccountLastRebalance,
  updateAccountTargetProportions,
  updateAccountSymbolNote,
  updateAccountPlanningContext,
  updateAccountMetadata,
  extractSymbolSettingsFromOverride,
  getAccountGroupRelations,
  getAccountGroupMetadata,
  get accountNamesFilePath() {
    return resolvedFilePath;
  },
};
