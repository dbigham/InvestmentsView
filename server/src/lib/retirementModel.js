// Retirement model utilities mirrored from ProjectionDialog logic

const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CPP_65_ANNUAL = 17500;
const DEFAULT_FULL_OAS_65_ANNUAL = 8500;
const DEFAULT_RETIREMENT_INFLATION_PERCENT = 2.5;

function toDateOnly(date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return toDateOnly(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const d = new Date(`${trimmed.slice(0, 10)}T00:00:00Z`);
      if (!Number.isNaN(d.getTime())) return toDateOnly(d);
    }
    const d2 = new Date(trimmed);
    if (!Number.isNaN(d2.getTime())) return toDateOnly(d2);
  }
  return null;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const years = Math.floor(targetMonth / 12);
  const newMonth = ((targetMonth % 12) + 12) % 12;
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCMonth(newMonth);
  return d;
}

function yearsBetween(from, to) {
  if (!(from instanceof Date) || !(to instanceof Date)) return 0;
  return (to.getTime() - from.getTime()) / MS_PER_YEAR;
}

function normalizeNumber(n, dflt = null) {
  if (n === null || n === undefined) return dflt;
  if (typeof n === 'string') {
    const s = n.trim();
    if (s === '') return dflt;
    const v = Number(s);
    return Number.isFinite(v) ? v : dflt;
  }
  const v = Number(n);
  return Number.isFinite(v) ? v : dflt;
}

function resolveInflationRatePercent(settings) {
  const raw = normalizeNumber(settings?.retirementInflationPercent, DEFAULT_RETIREMENT_INFLATION_PERCENT);
  const value = raw === null || raw === undefined ? DEFAULT_RETIREMENT_INFLATION_PERCENT : raw;
  return Math.max(0, value);
}

// Build the retirement model roughly equivalent to the client ProjectionDialog
function buildRetirementModel(settings, opts = {}) {
  if (!settings || settings.mainRetirementAccount !== true) {
    return { supported: false, enabled: false };
  }

  const todayRef = parseDateOnly(opts.todayDate) || toDateOnly(new Date());
  const ownerBirth = parseDateOnly(settings.retirementBirthDate1) || parseDateOnly(settings.retirementBirthDate);
  const inflationRate = resolveInflationRatePercent(settings) / 100;

  const rawConfiguredAge = normalizeNumber(settings.retirementAge, null);
  const configuredAge = rawConfiguredAge && rawConfiguredAge > 0 ? Math.round(rawConfiguredAge) : null;
  const chosenAge = Number.isFinite(opts.overrideRetirementAge) && opts.overrideRetirementAge > 0
    ? Math.round(opts.overrideRetirementAge)
    : (configuredAge || 65);
  const startDate = ownerBirth ? toDateOnly(addMonths(ownerBirth, chosenAge * 12)) : null;

  const income = normalizeNumber(settings.retirementIncome, 0);
  const living = normalizeNumber(settings.retirementLivingExpenses, 0);
  const maxCpp65 = normalizeNumber(settings.retirementCppMaxAt65Annual, DEFAULT_MAX_CPP_65_ANNUAL);
  const fullOas65 = normalizeNumber(settings.retirementOasFullAt65Annual, DEFAULT_FULL_OAS_65_ANNUAL);

  // Keep an inflation factor to the retirement start (used only for metadata/tooltips)
  const yrsUntil = startDate ? Math.max(0, yearsBetween(todayRef, startDate)) : 0;
  const factor = yrsUntil > 0 ? Math.pow(1 + inflationRate, yrsUntil) : 1;

  const hh = (settings?.retirementHouseholdType || 'single').toLowerCase() === 'couple' ? 'couple' : 'single';
  const birth1 = parseDateOnly(settings.retirementBirthDate1) || ownerBirth;
  const birth2 = parseDateOnly(settings.retirementBirthDate2) || null;

  const cppStartAge = Math.max(60, Math.min(70, chosenAge));
  const oasStartAge = Math.max(65, Math.min(70, chosenAge));

  const buildPerson = (idx, birth) => {
    if (!birth) return null;
    const cppYears = normalizeNumber(settings[`retirementCppYearsContributed${idx}`], 0);
    const cppPct = normalizeNumber(settings[`retirementCppAvgEarningsPctOfYMPE${idx}`], 0);
    const oasYears = normalizeNumber(settings[`retirementOasYearsResident${idx}`], 0);
    const startCppDate = toDateOnly(addMonths(birth, cppStartAge * 12));
    const startOasDate = toDateOnly(addMonths(birth, oasStartAge * 12));
    const contribYears = Math.max(0, Math.min(47, Math.round(cppYears)));
    const earningsRatio = Math.max(0, Math.min(100, cppPct)) / 100;
    // Anchor CPP to its own start date
    const cppYearsUntilStart = Math.max(0, yearsBetween(todayRef, startCppDate));
    const cppInflationAtStart = cppYearsUntilStart > 0 ? Math.pow(1 + inflationRate, cppYearsUntilStart) : 1;
    const baseCpp65 = (maxCpp65 * cppInflationAtStart) * Math.min(1, earningsRatio * (contribYears / 39));
    const monthsFrom65 = (cppStartAge - 65) * 12;
    const cppAdj = monthsFrom65 < 0 ? 1 + 0.006 * monthsFrom65 : 1 + 0.007 * monthsFrom65;
    const cppAnnualAtStart = Math.max(0, baseCpp65 * cppAdj);
    const oasResidYears = Math.max(0, Math.min(40, Math.round(oasYears)));
    // Anchor OAS to its own start date
    const oasYearsUntilStart = Math.max(0, yearsBetween(todayRef, startOasDate));
    const oasInflationAtStart = oasYearsUntilStart > 0 ? Math.pow(1 + inflationRate, oasYearsUntilStart) : 1;
    const baseOas65 = (fullOas65 * oasInflationAtStart) * Math.min(1, oasResidYears / 40);
    const oasMonthsFrom65 = (oasStartAge - 65) * 12;
    const oasAdj = 1 + 0.006 * Math.max(0, oasMonthsFrom65);
    const oasAnnualAtStart = Math.max(0, baseOas65 * oasAdj);
    return {
      birth,
      startCppDate,
      startOasDate,
      cppStartDate: startCppDate,
      oasStartDate: startOasDate,
      cppAnnualAtStart,
      oasAnnualAtStart,
    };
  };

  const p1 = buildPerson(1, birth1);
  const p2 = hh === 'couple' ? buildPerson(2, birth2) : null;

  // Reindex income/expenses when overriding retirement age: values are configured
  // in the configured retirement-year dollars, so shift them to the chosen start year.
  let configuredStartDate = null;
  if (ownerBirth) {
    if (configuredAge) {
      configuredStartDate = toDateOnly(addMonths(ownerBirth, configuredAge * 12));
    } else {
      const cfgYear = normalizeNumber(settings.retirementYear, null);
      if (Number.isFinite(cfgYear)) {
        configuredStartDate = toDateOnly(new Date(Date.UTC(cfgYear, ownerBirth.getUTCMonth(), ownerBirth.getUTCDate())));
      }
    }
  }
  const reindexYears = (configuredStartDate && startDate) ? yearsBetween(configuredStartDate, startDate) : 0;
  const reindexFactor = reindexYears !== 0 ? Math.pow(1 + inflationRate, reindexYears) : 1;
  const adjustedIncomeAnnual = income * reindexFactor;
  const adjustedLivingAnnual = living * reindexFactor;

  const cppAnnualAtStart = (p1?.cppAnnualAtStart || 0) + (p2?.cppAnnualAtStart || 0);
  const oasAnnualAtStart = (p1?.oasAnnualAtStart || 0) + (p2?.oasAnnualAtStart || 0);

  return {
    supported: true,
    enabled: Boolean(startDate),
    startDate,
    inflationRate,
    incomeMonthly: adjustedIncomeAnnual / 12,
    livingExpensesAnnual: adjustedLivingAnnual,
    persons: [p1, p2].filter(Boolean),
    cppAnnualAtStart,
    oasAnnualAtStart,
    factor,
  };
}

function summarizeAtRetirementYear(model) {
  if (!model || !model.startDate) return null;
  const year = model.startDate.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const endOfYear = new Date(Date.UTC(year, 11, 31));

  const incomeMonthly = Number(model.incomeMonthly) || 0;
  const inflationRate = Number(model.inflationRate) || 0;
  const persons = Array.isArray(model.persons) ? model.persons : [];

  let cpp = 0;
  let oas = 0;
  let other = 0;

  for (let m = 0; m < 12; m += 1) {
    const date = new Date(Date.UTC(year, m, 1));
    if (date < model.startDate || date < startOfYear || date > endOfYear) continue;
    other += incomeMonthly;
    persons.forEach((p) => {
      const cppStart = p.cppStartDate || p.startCppDate || null;
      if (cppStart && date >= cppStart) {
        const yrs = yearsBetween(cppStart, date);
        const factorAtMonth = yrs > 0 ? Math.pow(1 + inflationRate, yrs) : 1;
        cpp += ((Number(p.cppAnnualAtStart) || 0) / 12) * factorAtMonth;
      }
      const oasStart = p.oasStartDate || p.startOasDate || null;
      if (oasStart && date >= oasStart) {
        const yrs = yearsBetween(oasStart, date);
        const factorAtMonth = yrs > 0 ? Math.pow(1 + inflationRate, yrs) : 1;
        oas += ((Number(p.oasAnnualAtStart) || 0) / 12) * factorAtMonth;
      }
    });
  }

  return { year, cpp, oas, other, total: cpp + oas + other };
}

module.exports = {
  buildRetirementModel,
  summarizeAtRetirementYear,
  // export helpers for tests
  _internals: { toDateOnly, parseDateOnly, addMonths, yearsBetween },
};
