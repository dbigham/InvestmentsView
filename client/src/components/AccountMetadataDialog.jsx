import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatMoney, formatNumber } from '../utils/formatters';

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s;
}

export default function AccountMetadataDialog({
  accountLabel,
  initial,
  models,
  onClose,
  onSave,
  targetType,
}) {
  const titleId = useId();
  const fieldBaseId = useId();
  const isGroupTarget = targetType === 'group';
  const DEFAULT_INFLATION_PERCENT = 2.5; // 2.5% per year default
  const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
  const DEFAULT_MAX_CPP_65_ANNUAL = 17500;
  const DEFAULT_FULL_OAS_65_ANNUAL = 8500;

  // Resolve an inflation percent from user input, falling back to default
  const resolveInflationPercent = (raw) => {
    const s = (raw === undefined || raw === null) ? '' : String(raw).trim();
    if (s === '') return DEFAULT_INFLATION_PERCENT;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INFLATION_PERCENT;
  };

  const parseDateOnly = (value) => {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const d = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  const initialState = useMemo(() => {
    return {
      displayName: normalizeString(initial?.displayName || initial?.name || ''),
      accountGroup: normalizeString(initial?.accountGroup || ''),
      portalAccountId: normalizeString(initial?.portalAccountId || ''),
      chatURL: normalizeString(initial?.chatURL || ''),
      cagrStartDate: normalizeString(initial?.cagrStartDate || ''),
      rebalancePeriod:
        initial?.rebalancePeriod !== undefined && initial?.rebalancePeriod !== null
          ? String(initial.rebalancePeriod)
          : '',
      ignoreSittingCash:
        initial?.ignoreSittingCash !== undefined && initial?.ignoreSittingCash !== null
          ? String(initial.ignoreSittingCash)
          : '',
      mainRetirementAccount: initial?.mainRetirementAccount === true,
      retirementYear:
        initial?.retirementYear !== undefined && initial?.retirementYear !== null
          ? String(initial.retirementYear)
          : '',
      retirementIncome:
        initial?.retirementIncome !== undefined && initial?.retirementIncome !== null
          ? String(initial.retirementIncome)
          : '',
      retirementLivingExpenses:
        initial?.retirementLivingExpenses !== undefined &&
        initial?.retirementLivingExpenses !== null
          ? String(initial.retirementLivingExpenses)
          : '',
      // Deprecated single birth date replaced by per-person; keep for back-compat only
      retirementBirthDate: '',
      retirementInflationPercent:
        (function () {
          if (initial?.retirementInflationPercent === undefined || initial?.retirementInflationPercent === null) {
            return String(DEFAULT_INFLATION_PERCENT);
          }
          const trimmed = String(initial.retirementInflationPercent).trim();
          return trimmed === '' ? String(DEFAULT_INFLATION_PERCENT) : trimmed;
        })(),
      retirementHouseholdType: normalizeString(initial?.retirementHouseholdType || 'single'),
      retirementBirthDate1: normalizeString(initial?.retirementBirthDate1 || initial?.retirementBirthDate || ''),
      retirementBirthDate2: normalizeString(initial?.retirementBirthDate2 || ''),
      retirementCppYearsContributed1: normalizeString(initial?.retirementCppYearsContributed1 ?? ''),
      retirementCppAvgEarningsPctOfYMPE1: normalizeString(initial?.retirementCppAvgEarningsPctOfYMPE1 ?? ''),
      retirementCppStartAge1: normalizeString(initial?.retirementCppStartAge1 ?? ''),
      retirementOasYearsResident1: normalizeString(initial?.retirementOasYearsResident1 ?? ''),
      retirementOasStartAge1: normalizeString(initial?.retirementOasStartAge1 ?? ''),
      retirementCppYearsContributed2: normalizeString(initial?.retirementCppYearsContributed2 ?? ''),
      retirementCppAvgEarningsPctOfYMPE2: normalizeString(initial?.retirementCppAvgEarningsPctOfYMPE2 ?? ''),
      retirementCppStartAge2: normalizeString(initial?.retirementCppStartAge2 ?? ''),
      retirementOasYearsResident2: normalizeString(initial?.retirementOasYearsResident2 ?? ''),
      retirementOasStartAge2: normalizeString(initial?.retirementOasStartAge2 ?? ''),
      retirementCppMaxAt65Annual: normalizeString(initial?.retirementCppMaxAt65Annual ?? ''),
      retirementOasFullAt65Annual: normalizeString(initial?.retirementOasFullAt65Annual ?? ''),
    };
  }, [initial]);

  const [draft, setDraft] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [showRetirementInfo, setShowRetirementInfo] = useState(false);

  const presentValueInfo = useMemo(() => {
    const birth = parseDateOnly(draft.retirementBirthDate1);
    const ageNum = (function () {
      const y = Number(draft.retirementYear);
      if (birth && Number.isFinite(y)) return Math.max(0, y - birth.getUTCFullYear());
      return NaN;
    })();
    const income = Number(draft.retirementIncome);
    const expenses = Number(draft.retirementLivingExpenses);
    const inflationPercent = resolveInflationPercent(draft.retirementInflationPercent);
    const inflationRate = inflationPercent / 100;
    if (!birth || !Number.isFinite(ageNum) || ageNum <= 0) {
      return { yearsUntil: null, incomeToday: null, expensesToday: null };
    }
    const start = new Date(Date.UTC(birth.getUTCFullYear() + Math.round(ageNum), birth.getUTCMonth(), birth.getUTCDate()));
    const now = new Date();
    const yearsUntil = Math.max(0, (start.getTime() - now.getTime()) / MS_PER_YEAR);
    const disc = Math.pow(1 + inflationRate, yearsUntil);
    const incomeToday = Number.isFinite(income) ? income / (disc || 1) : null;
    const expensesToday = Number.isFinite(expenses) ? expenses / (disc || 1) : null;
    return { yearsUntil, incomeToday, expensesToday };
  }, [draft.retirementBirthDate, draft.retirementAge, draft.retirementIncome, draft.retirementLivingExpenses, draft.retirementInflationPercent]);

  useEffect(() => {
    setDraft(initialState);
    setBusy(false);
    setErrorMessage(null);
    setShowRetirementInfo(false);
  }, [initialState]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onClose]);

  const handleOverlayMouseDown = useCallback(
    (event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    },
    [busy, onClose]
  );

  const handleChange = useCallback((key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleCancel = useCallback(() => {
    if (!busy) {
      onClose();
    }
  }, [busy, onClose]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (busy) return;
      setErrorMessage(null);

      const parseNumberOrEmpty = (value) => {
        const trimmed = String(value ?? '').trim();
        if (!trimmed) {
          return '';
        }
        const numeric = Number(trimmed);
        return Number.isFinite(numeric) ? numeric : '';
      };

      const payload = {};
      Object.keys(initialState).forEach((key) => {
        const original = initialState[key];
        const current = draft[key];
        if (current !== original) {
          payload[key] = current;
        }
      });

      if (Object.prototype.hasOwnProperty.call(payload, 'retirementYear')) {
        payload.retirementYear = parseNumberOrEmpty(payload.retirementYear);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'retirementIncome')) {
        payload.retirementIncome = parseNumberOrEmpty(payload.retirementIncome);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'retirementLivingExpenses')) {
        payload.retirementLivingExpenses = parseNumberOrEmpty(payload.retirementLivingExpenses);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'retirementBirthDate')) {
        const trimmed = String(payload.retirementBirthDate ?? '').trim();
        payload.retirementBirthDate = trimmed;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'retirementInflationPercent')) {
        const trimmed = String(payload.retirementInflationPercent ?? '').trim();
        if (!trimmed) {
          payload.retirementInflationPercent = '';
        } else {
          const numeric = Number(trimmed);
          payload.retirementInflationPercent = Number.isFinite(numeric) ? numeric : '';
        }
      }

      // Household and pension fields
      if (Object.prototype.hasOwnProperty.call(payload, 'retirementHouseholdType')) {
        const s = String(payload.retirementHouseholdType || '').trim().toLowerCase();
        payload.retirementHouseholdType = s === 'couple' ? 'couple' : 'single';
      }
      ['1','2'].forEach((idx) => {
        const bKey = 'retirementBirthDate' + idx;
        if (Object.prototype.hasOwnProperty.call(payload, bKey)) {
          payload[bKey] = String(payload[bKey] ?? '').trim();
        }
        const numKeys = [
          'retirementCppYearsContributed' + idx,
          'retirementCppAvgEarningsPctOfYMPE' + idx,
          'retirementCppStartAge' + idx,
          'retirementOasYearsResident' + idx,
          'retirementOasStartAge' + idx,
        ];
        numKeys.forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(payload, k)) {
            const trimmed = String(payload[k] ?? '').trim();
            if (!trimmed) {
              payload[k] = '';
            } else {
              const num = Number(trimmed);
              payload[k] = Number.isFinite(num) ? num : '';
            }
          }
        });
      });
      ['retirementCppMaxAt65Annual','retirementOasFullAt65Annual'].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(payload, k)) {
          const trimmed = String(payload[k] ?? '').trim();
          if (!trimmed) {
            payload[k] = '';
          } else {
            const num = Number(trimmed);
            payload[k] = Number.isFinite(num) ? num : '';
          }
        }
      });

      try {
        setBusy(true);
        await onSave(payload);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Failed to save account details.';
        setErrorMessage(message);
        setBusy(false);
        return;
      }
      setBusy(false);
    },
    [busy, draft, onSave, initialState]
  );

  // Estimate CPP/OAS based on current draft inputs
  const pensionEstimates = useMemo(() => {
    if (!draft.mainRetirementAccount) return { cpp: 0, oas: 0 };
    const maxCpp65 = Number(draft.retirementCppMaxAt65Annual);
    const fullOas65 = Number(draft.retirementOasFullAt65Annual);
    const cppMaxBase = Number.isFinite(maxCpp65) && maxCpp65 > 0 ? maxCpp65 : DEFAULT_MAX_CPP_65_ANNUAL;
    const oasFullBase = Number.isFinite(fullOas65) && fullOas65 > 0 ? fullOas65 : DEFAULT_FULL_OAS_65_ANNUAL;
    const ry = Number(draft.retirementYear);
    const birth1 = parseDateOnly(draft.retirementBirthDate1);
    const birth2 = draft.retirementHouseholdType === 'couple' ? parseDateOnly(draft.retirementBirthDate2) : null;
    // Inflate base CPP/OAS values to retirement-year dollars using inflation and time until retirement start
    const inflationPercent = resolveInflationPercent(draft.retirementInflationPercent);
    const inflationRate = inflationPercent / 100;
    const now = new Date();
    let yearsUntil = 0;
    // Derive a retirement start date using birth1 (fallback to birth2) and retirementYear
    const refBirth = birth1 || birth2;
    if (refBirth && Number.isFinite(ry)) {
      const start = new Date(Date.UTC(ry, refBirth.getUTCMonth(), refBirth.getUTCDate()));
      yearsUntil = Math.max(0, (start.getTime() - now.getTime()) / MS_PER_YEAR);
    }
    const discToRetirement = Math.pow(1 + inflationRate, yearsUntil) || 1;
    const cppMaxAtRetirement = cppMaxBase * discToRetirement;
    const oasFullAtRetirement = oasFullBase * discToRetirement;
    const buildPerson = (idx, birth) => {
      if (!birth) return { cpp: 0, oas: 0 };
      const cppYears = Number(draft['retirementCppYearsContributed' + idx]);
      const cppPct = Number(draft['retirementCppAvgEarningsPctOfYMPE' + idx]);
      const oasYears = Number(draft['retirementOasYearsResident' + idx]);
      // If start age not provided, derive from retirementYear
      const fallbackAge = (ry && birth) ? (ry - birth.getUTCFullYear()) : 65;
      const cppAge = Math.max(60, Math.min(70, Math.round(fallbackAge)));
      const oasAge = Math.max(65, Math.min(70, Math.round(fallbackAge)));
      const contribYears = Number.isFinite(cppYears) ? Math.max(0, Math.min(47, Math.round(cppYears))) : 0;
      // If retiring before 65, reduce effective contribution years by the early gap
      const earlyGapYears = Math.max(0, 65 - Math.round(fallbackAge));
      const effectiveContribYears = Math.max(0, contribYears - earlyGapYears);
      const earningsRatio = Number.isFinite(cppPct) ? Math.max(0, Math.min(100, cppPct)) / 100 : 0;
      const baseCpp65 = cppMaxAtRetirement * Math.min(1, earningsRatio * (effectiveContribYears / 39));
      const monthsFrom65 = (cppAge - 65) * 12;
      const cppAdj = monthsFrom65 < 0 ? 1 + 0.006 * monthsFrom65 : 1 + 0.007 * monthsFrom65;
      const cpp = Math.max(0, baseCpp65 * cppAdj);
      const oasResidYears = Number.isFinite(oasYears) ? Math.max(0, Math.min(40, Math.round(oasYears))) : 0;
      const baseOas65 = oasFullAtRetirement * Math.min(1, oasResidYears / 40);
      const oasMonthsFrom65 = (oasAge - 65) * 12;
      const oasAdj = 1 + 0.006 * Math.max(0, oasMonthsFrom65);
      const oas = Math.max(0, baseOas65 * oasAdj);
      return { cpp, oas };
    };
    const p1 = buildPerson(1, birth1);
    const p2 = draft.retirementHouseholdType === 'couple' ? buildPerson(2, birth2) : { cpp: 0, oas: 0 };
    return { cpp: (p1.cpp + p2.cpp), oas: (p1.oas + p2.oas) };
  }, [draft]);

  return (
    <div className="account-metadata-overlay" role="presentation" onMouseDown={handleOverlayMouseDown}>
      <div className="account-metadata-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="account-metadata-dialog__header">
          <div className="account-metadata-dialog__heading">
            <h2 id={titleId}>Edit account details</h2>
            <p className="account-metadata-dialog__subtitle">{accountLabel || 'Selected account'}</p>
          </div>
          <button
            type="button"
            className="account-metadata-dialog__close"
            onClick={handleCancel}
            aria-label="Close dialog"
            disabled={busy}
          >
            ×
          </button>
        </header>
        <form className="account-metadata-dialog__form" onSubmit={handleSubmit} noValidate>
          <div className="account-metadata-dialog__body">
            {errorMessage && (
              <div className="account-metadata-dialog__status" role="alert">
                {errorMessage}
              </div>
            )}

            {!isGroupTarget && (
              <div className="account-metadata-dialog__grid">
                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-name`}>Display name</label>
                  <input
                    id={`${fieldBaseId}-name`}
                    type="text"
                    className="account-metadata-dialog__input"
                    value={draft.displayName}
                    onChange={(e) => handleChange('displayName', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">Leave blank to use the default label.</p>
                </div>

                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-group`}>Account group</label>
                  <input
                    id={`${fieldBaseId}-group`}
                    type="text"
                    className="account-metadata-dialog__input"
                    value={draft.accountGroup}
                    onChange={(e) => handleChange('accountGroup', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">
                    Account groups are like accounts; they aggregate other accounts.
                  </p>
                </div>

                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-portal`}>Questrade account UUID</label>
                  <input
                    id={`${fieldBaseId}-portal`}
                    type="text"
                    className="account-metadata-dialog__input"
                    value={draft.portalAccountId}
                    onChange={(e) => handleChange('portalAccountId', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">Optional: Used for linking to Questrade's UI.</p>
                </div>

                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-chat`}>Chat URL</label>
                  <input
                    id={`${fieldBaseId}-chat`}
                    type="url"
                    className="account-metadata-dialog__input"
                    value={draft.chatURL}
                    onChange={(e) => handleChange('chatURL', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">Optional: e.g., a ChatGPT link for this account.</p>
                </div>

                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-cagr`}>CAGR start date</label>
                  <input
                    id={`${fieldBaseId}-cagr`}
                    type="date"
                    className="account-metadata-dialog__input"
                    value={draft.cagrStartDate}
                    onChange={(e) => handleChange('cagrStartDate', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">Optional: Overrides the start used for CAGR.</p>
                </div>

                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-rebalance`}>Rebalance period (days)</label>
                  <input
                    id={`${fieldBaseId}-rebalance`}
                    type="number"
                    min="1"
                    className="account-metadata-dialog__input"
                    value={draft.rebalancePeriod}
                    onChange={(e) => handleChange('rebalancePeriod', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">Optional: Default cadence for rebalance reminders.</p>
                </div>

                <div className="account-metadata-dialog__field">
                  <label htmlFor={`${fieldBaseId}-ignorecash`}>Ignore cash ≤ (CAD)</label>
                  <input
                    id={`${fieldBaseId}-ignorecash`}
                    type="number"
                    min="0"
                    className="account-metadata-dialog__input"
                    value={draft.ignoreSittingCash}
                    onChange={(e) => handleChange('ignoreSittingCash', e.target.value)}
                    disabled={busy}
                  />
                  <p className="account-metadata-dialog__hint">Optional: Threshold to suppress small cash todos.</p>
                </div>
              </div>
            )}

            <div className="account-metadata-dialog__section">
              <label className="account-metadata-dialog__toggle" htmlFor={`${fieldBaseId}-retirement-toggle`}>
                <input
                  id={`${fieldBaseId}-retirement-toggle`}
                  type="checkbox"
                  checked={draft.mainRetirementAccount}
                  onChange={(e) => handleChange('mainRetirementAccount', e.target.checked)}
                  disabled={busy}
                />
                <span>Main retirement account</span>
              </label>
              <p className="account-metadata-dialog__hint">
                Enable this to include retirement income (CPP, OAS, pensions, etc.) and living costs in projections.
              </p>
                  {draft.mainRetirementAccount && (
                    <>
                      <div className="account-metadata-dialog__retirement-grid">
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-retirement-year`}>Retirement year</label>
                      <input
                        id={`${fieldBaseId}-retirement-year`}
                        type="number"
                        min="1900"
                        className="account-metadata-dialog__input"
                        value={draft.retirementYear}
                        onChange={(e) => handleChange('retirementYear', e.target.value)}
                        disabled={busy}
                      />
                      <p className="account-metadata-dialog__hint">Year when retirement begins. Ages are derived from each person’s birth date.</p>
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-retirement-income`}>Other retirement income (annual CAD)</label>
                      <input
                        id={`${fieldBaseId}-retirement-income`}
                        type="number"
                        min="0"
                        step="1000"
                        className="account-metadata-dialog__input"
                        value={draft.retirementIncome}
                        onChange={(e) => handleChange('retirementIncome', e.target.value)}
                        disabled={busy}
                      />
                      <p className="account-metadata-dialog__hint">Exclude CPP and OAS here. Include employer pensions, annuities, rental income, etc., in retirement-year dollars.</p>
                      {Number.isFinite(presentValueInfo.incomeToday) && (
                        <p className="account-metadata-dialog__hint">
                          ≈ {formatMoney(presentValueInfo.incomeToday)} in today's dollars (using
                          {' '}{formatNumber(resolveInflationPercent(draft.retirementInflationPercent), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% inflation)
                        </p>
                      )}
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-retirement-expenses`}>Living expenses (annual CAD)</label>
                      <input
                        id={`${fieldBaseId}-retirement-expenses`}
                        type="number"
                        min="0"
                        step="1000"
                        className="account-metadata-dialog__input"
                        value={draft.retirementLivingExpenses}
                        onChange={(e) => handleChange('retirementLivingExpenses', e.target.value)}
                        disabled={busy}
                      />
                      <p className="account-metadata-dialog__hint">
                        Annual spending target, inflated to the year of retirement.
                      </p>
                      {Number.isFinite(presentValueInfo.expensesToday) && (
                        <p className="account-metadata-dialog__hint">
                          ≈ {formatMoney(presentValueInfo.expensesToday)} in today's dollars (using
                          {' '}{formatNumber(resolveInflationPercent(draft.retirementInflationPercent), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% inflation)
                        </p>
                      )}
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-retirement-inflation`}>Inflation rate (%)</label>
                      <input
                        id={`${fieldBaseId}-retirement-inflation`}
                        type="number"
                        min="0"
                        step="0.01"
                        className="account-metadata-dialog__input"
                        value={draft.retirementInflationPercent}
                        onChange={(e) => handleChange('retirementInflationPercent', e.target.value)}
                        disabled={busy}
                      />
                      <p className="account-metadata-dialog__hint">Default is {DEFAULT_INFLATION_PERCENT}% if left blank.</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="account-metadata-dialog__info-trigger"
                    onClick={() => setShowRetirementInfo((value) => !value)}
                    disabled={busy}
                  >
                    {showRetirementInfo ? 'Hide details' : 'More info'}
                  </button>
                  {showRetirementInfo && (
                    <div className="account-metadata-dialog__info-panel">
                      <p>
                        Other retirement income should exclude CPP and OAS (those are estimated separately below).
                        Include predictable sources such as employer pensions, annuities, rental income, or other cash
                        flows. Enter amounts in the dollars of your retirement year.
                      </p>
                      <p>
                        Living expenses should also be expressed in retirement-year dollars. The projections
                        automatically grow living expenses each year after retirement using your inflation setting.
                      </p>
                    </div>
                  )}
                  {/* Pension inputs */}
                  <div className="account-metadata-dialog__retirement-grid" style={{ marginTop: '12px' }}>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-household`}>Household</label>
                      <select
                        id={`${fieldBaseId}-household`}
                        className="account-metadata-dialog__input"
                        value={draft.retirementHouseholdType}
                        onChange={(e) => handleChange('retirementHouseholdType', e.target.value)}
                        disabled={busy}
                      >
                        <option value="single">Single person</option>
                        <option value="couple">Married/common-law couple</option>
                      </select>
                    </div>
                  </div>

                  <h4 className="account-metadata-dialog__models-title">Pension inputs — Person 1</h4>
                  <div className="account-metadata-dialog__retirement-grid">
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-bd1`}>Birth date</label>
                      <input id={`${fieldBaseId}-bd1`} type="date" className="account-metadata-dialog__input" value={draft.retirementBirthDate1} onChange={(e) => handleChange('retirementBirthDate1', e.target.value)} disabled={busy} />
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-cppy1`}>
                        CPP years contributed (max ~39)
                        <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="Approximate number of calendar years you contributed to CPP at a meaningful level. Around 39 years are needed to qualify for the full CPP amount at age 65.">i</button>
                      </label>
                      <input id={`${fieldBaseId}-cppy1`} type="number" min="0" className="account-metadata-dialog__input" value={draft.retirementCppYearsContributed1} onChange={(e) => handleChange('retirementCppYearsContributed1', e.target.value)} disabled={busy} />
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-cppp1`}>
                        CPP avg earnings (% of YMPE)
                        <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="Your average career earnings as a percentage of the YMPE (Year’s Maximum Pensionable Earnings). 100% means earnings at or above the YMPE in most eligible years; lower values reduce CPP entitlement.">i</button>
                      </label>
                      <input id={`${fieldBaseId}-cppp1`} type="number" min="0" step="0.1" className="account-metadata-dialog__input" value={draft.retirementCppAvgEarningsPctOfYMPE1} onChange={(e) => handleChange('retirementCppAvgEarningsPctOfYMPE1', e.target.value)} disabled={busy} />
                    </div>
                    
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-oasy1`}>
                        OAS years resident in Canada (0–40)
                        <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="Number of years lived in Canada after age 18. 40 years gives a full OAS pension; fewer years reduce OAS proportionally.">i</button>
                      </label>
                      <input id={`${fieldBaseId}-oasy1`} type="number" min="0" max="40" className="account-metadata-dialog__input" value={draft.retirementOasYearsResident1} onChange={(e) => handleChange('retirementOasYearsResident1', e.target.value)} disabled={busy} />
                    </div>
                    
                  </div>
                  

                  {draft.retirementHouseholdType === 'couple' && (
                    <>
                      <h4 className="account-metadata-dialog__models-title">Pension inputs — Person 2</h4>
                      <div className="account-metadata-dialog__retirement-grid">
                        <div className="account-metadata-dialog__field">
                          <label htmlFor={`${fieldBaseId}-bd2`}>Birth date</label>
                          <input id={`${fieldBaseId}-bd2`} type="date" className="account-metadata-dialog__input" value={draft.retirementBirthDate2} onChange={(e) => handleChange('retirementBirthDate2', e.target.value)} disabled={busy} />
                        </div>
                        <div className="account-metadata-dialog__field">
                          <label htmlFor={`${fieldBaseId}-cppy2`}>
                            CPP years contributed (max ~39)
                            <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="Approximate number of calendar years you contributed to CPP at a meaningful level. Around 39 years are needed to qualify for the full CPP amount at age 65.">i</button>
                          </label>
                          <input id={`${fieldBaseId}-cppy2`} type="number" min="0" className="account-metadata-dialog__input" value={draft.retirementCppYearsContributed2} onChange={(e) => handleChange('retirementCppYearsContributed2', e.target.value)} disabled={busy} />
                        </div>
                        <div className="account-metadata-dialog__field">
                          <label htmlFor={`${fieldBaseId}-cppp2`}>
                            CPP avg earnings (% of YMPE)
                            <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="Your average career earnings as a percentage of the YMPE (Year’s Maximum Pensionable Earnings). 100% means earnings at or above the YMPE in most eligible years; lower values reduce CPP entitlement.">i</button>
                          </label>
                          <input id={`${fieldBaseId}-cppp2`} type="number" min="0" step="0.1" className="account-metadata-dialog__input" value={draft.retirementCppAvgEarningsPctOfYMPE2} onChange={(e) => handleChange('retirementCppAvgEarningsPctOfYMPE2', e.target.value)} disabled={busy} />
                        </div>
                        
                        <div className="account-metadata-dialog__field">
                          <label htmlFor={`${fieldBaseId}-oasy2`}>
                            OAS years resident in Canada (0–40)
                            <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="Number of years lived in Canada after age 18. 40 years gives a full OAS pension; fewer years reduce OAS proportionally.">i</button>
                          </label>
                          <input id={`${fieldBaseId}-oasy2`} type="number" min="0" max="40" className="account-metadata-dialog__input" value={draft.retirementOasYearsResident2} onChange={(e) => handleChange('retirementOasYearsResident2', e.target.value)} disabled={busy} />
                        </div>
                        
                      </div>
                    </>
                  )}

                  <div className="account-metadata-dialog__retirement-grid">
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-cppmax`}>
                        CPP maximum at age 65 (per person, annual)
                        <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="The maximum annual CPP retirement pension at age 65 per person. Leave blank to use a default estimate; the same value is applied per person.">i</button>
                      </label>
                      <input id={`${fieldBaseId}-cppmax`} type="number" min="0" className="account-metadata-dialog__input" value={draft.retirementCppMaxAt65Annual} onChange={(e) => handleChange('retirementCppMaxAt65Annual', e.target.value)} disabled={busy} />
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-oasmax`}>
                        OAS full amount at age 65 (per person, annual)
                        <button type="button" className="account-metadata-dialog__info-dot" data-tooltip="The full annual OAS pension at age 65 for someone with 40+ years of Canadian residency. Leave blank to use a default estimate; applied per person.">i</button>
                      </label>
                      <input id={`${fieldBaseId}-oasmax`} type="number" min="0" className="account-metadata-dialog__input" value={draft.retirementOasFullAt65Annual} onChange={(e) => handleChange('retirementOasFullAt65Annual', e.target.value)} disabled={busy} />
                    </div>
                  </div>

                  <div className="account-metadata-dialog__info-panel" style={{ marginTop: '8px' }}>
                    <strong>Estimated at start of retirement:</strong>
                    {(() => {
                      const ryIncome = Number(draft.retirementIncome) || 0;
                      const ryCpp = Number(pensionEstimates.cpp) || 0;
                      const ryOas = Number(pensionEstimates.oas) || 0;
                      const ryTotal = ryIncome + ryCpp + ryOas;

                      const yearsUntil = presentValueInfo.yearsUntil;
                      const inflationRate = resolveInflationPercent(draft.retirementInflationPercent) / 100;
                      const disc = Number.isFinite(yearsUntil) && yearsUntil > 0 ? Math.pow(1 + inflationRate, yearsUntil) : 1;

                      const todayIncome = Number.isFinite(presentValueInfo.incomeToday) ? presentValueInfo.incomeToday : (ryIncome / disc);
                      const todayCpp = ryCpp / (disc || 1);
                      const todayOas = ryOas / (disc || 1);
                      const todayTotal = todayIncome + todayCpp + todayOas;

                      const money0 = { minimumFractionDigits: 0, maximumFractionDigits: 0 };

                      return (
                        <table className="account-metadata-dialog__summary-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: '6px' }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '6px 0' }}>Item</th>
                              <th style={{ textAlign: 'right', padding: '6px 0' }}>Today’s dollars</th>
                              <th style={{ textAlign: 'right', padding: '6px 0' }}>Retirement-year dollars</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td style={{ padding: '4px 0' }}>CPP (annual)</td>
                              <td style={{ padding: '4px 0', textAlign: 'right' }}>{formatMoney(todayCpp, money0)}</td>
                              <td style={{ padding: '4px 0', textAlign: 'right' }}>{formatMoney(ryCpp, money0)}</td>
                            </tr>
                            <tr>
                              <td style={{ padding: '4px 0' }}>OAS (annual)</td>
                              <td style={{ padding: '4px 0', textAlign: 'right' }}>{formatMoney(todayOas, money0)}</td>
                              <td style={{ padding: '4px 0', textAlign: 'right' }}>{formatMoney(ryOas, money0)}</td>
                            </tr>
                            <tr>
                              <td style={{ padding: '4px 0' }}>Other retirement income (annual)</td>
                              <td style={{ padding: '4px 0', textAlign: 'right' }}>{formatMoney(todayIncome, money0)}</td>
                              <td style={{ padding: '4px 0', textAlign: 'right' }}>{formatMoney(ryIncome, money0)}</td>
                            </tr>
                            <tr>
                              <td style={{ padding: '6px 0', borderTop: '1px solid var(--color-border)' }}><strong>Total (annual)</strong></td>
                              <td style={{ padding: '6px 0', textAlign: 'right', borderTop: '1px solid var(--color-border)' }}><strong>{formatMoney(todayTotal, money0)}</strong></td>
                              <td style={{ padding: '6px 0', textAlign: 'right', borderTop: '1px solid var(--color-border)' }}><strong>{formatMoney(ryTotal, money0)}</strong></td>
                            </tr>
                          </tbody>
                        </table>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>

            {Array.isArray(models) && models.length > 0 ? (
              <div className="account-metadata-dialog__models">
                <h3 className="account-metadata-dialog__models-title">Investment models</h3>
                <ul className="account-metadata-dialog__models-list">
                  {models.map((m, index) => (
                    <li key={`${m.model || 'model'}-${index}`} className="account-metadata-dialog__model">
                      <strong className="account-metadata-dialog__model-key">{m.model}</strong>
                      <span className="account-metadata-dialog__model-details">
                        {m.symbol ? `Base: ${m.symbol}` : null}
                        {m.leveragedSymbol ? ` • Leveraged: ${m.leveragedSymbol}` : null}
                        {m.reserveSymbol ? ` • Reserve: ${m.reserveSymbol}` : null}
                        {m.lastRebalance ? ` • Last: ${m.lastRebalance}` : null}
                        {Number.isFinite(m.rebalancePeriod) ? ` • Every ${m.rebalancePeriod}d` : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <footer className="account-metadata-dialog__footer">
            <button
              type="button"
              className="account-metadata-dialog__button"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="account-metadata-dialog__button account-metadata-dialog__button--primary"
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save details'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

const modelShape = PropTypes.shape({
  model: PropTypes.string,
  symbol: PropTypes.string,
  leveragedSymbol: PropTypes.string,
  reserveSymbol: PropTypes.string,
  lastRebalance: PropTypes.string,
  rebalancePeriod: PropTypes.number,
});

AccountMetadataDialog.propTypes = {
  accountLabel: PropTypes.string,
  initial: PropTypes.shape({
    displayName: PropTypes.string,
    name: PropTypes.string,
    accountGroup: PropTypes.string,
    portalAccountId: PropTypes.string,
    chatURL: PropTypes.string,
    cagrStartDate: PropTypes.string,
    rebalancePeriod: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    ignoreSittingCash: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    mainRetirementAccount: PropTypes.bool,
    retirementAge: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementYear: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementIncome: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementLivingExpenses: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementBirthDate: PropTypes.string,
    retirementInflationPercent: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementHouseholdType: PropTypes.string,
    retirementBirthDate1: PropTypes.string,
    retirementBirthDate2: PropTypes.string,
    retirementCppYearsContributed1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppAvgEarningsPctOfYMPE1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppStartAge1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasYearsResident1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasStartAge1: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppYearsContributed2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppAvgEarningsPctOfYMPE2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppStartAge2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasYearsResident2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasStartAge2: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementCppMaxAt65Annual: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementOasFullAt65Annual: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  }),
  models: PropTypes.arrayOf(modelShape),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  targetType: PropTypes.oneOf(['account', 'group']),
};

AccountMetadataDialog.defaultProps = {
  accountLabel: null,
  initial: {},
  models: [],
  targetType: 'account',
};
