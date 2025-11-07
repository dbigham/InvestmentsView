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
      retirementAge:
        initial?.retirementAge !== undefined && initial?.retirementAge !== null
          ? String(initial.retirementAge)
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
      retirementBirthDate: normalizeString(initial?.retirementBirthDate || ''),
      retirementInflationPercent:
        initial?.retirementInflationPercent !== undefined && initial?.retirementInflationPercent !== null
          ? String(initial.retirementInflationPercent)
          : '',
    };
  }, [initial]);

  const [draft, setDraft] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const [showRetirementInfo, setShowRetirementInfo] = useState(false);

  const presentValueInfo = useMemo(() => {
    const birth = parseDateOnly(draft.retirementBirthDate);
    const ageNum = Number(draft.retirementAge);
    const income = Number(draft.retirementIncome);
    const expenses = Number(draft.retirementLivingExpenses);
    const inflationPercent = (function () {
      const n = Number(draft.retirementInflationPercent);
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INFLATION_PERCENT;
    })();
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

      if (Object.prototype.hasOwnProperty.call(payload, 'retirementAge')) {
        payload.retirementAge = parseNumberOrEmpty(payload.retirementAge);
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
                          <label htmlFor={`${fieldBaseId}-retirement-birthdate`}>Birth date</label>
                          <input
                            id={`${fieldBaseId}-retirement-birthdate`}
                            type="date"
                            className="account-metadata-dialog__input"
                            value={draft.retirementBirthDate}
                            onChange={(e) => handleChange('retirementBirthDate', e.target.value)}
                            disabled={busy}
                          />
                          <p className="account-metadata-dialog__hint">Used with retirement age to compute the retirement year.</p>
                        </div>
                        <div className="account-metadata-dialog__field">
                          <label htmlFor={`${fieldBaseId}-retirement-age`}>Retirement age</label>
                      <input
                        id={`${fieldBaseId}-retirement-age`}
                        type="number"
                        min="1"
                        className="account-metadata-dialog__input"
                        value={draft.retirementAge}
                        onChange={(e) => handleChange('retirementAge', e.target.value)}
                        disabled={busy}
                      />
                      <p className="account-metadata-dialog__hint">Age when retirement income/expenses should start.</p>
                    </div>
                    <div className="account-metadata-dialog__field">
                      <label htmlFor={`${fieldBaseId}-retirement-income`}>Retirement income (annual CAD)</label>
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
                      <p className="account-metadata-dialog__hint">
                        Include CPP, OAS, pensions, or any other yearly income in retirement-year dollars.
                      </p>
                      {Number.isFinite(presentValueInfo.incomeToday) && (
                        <p className="account-metadata-dialog__hint">
                          ≈ {formatMoney(presentValueInfo.incomeToday)} in today's dollars (using
                          {' '}{formatNumber((Number(draft.retirementInflationPercent) || DEFAULT_INFLATION_PERCENT), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% inflation)
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
                          {' '}{formatNumber((Number(draft.retirementInflationPercent) || DEFAULT_INFLATION_PERCENT), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% inflation)
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
                        Retirement income should include predictable sources such as CPP, OAS, pensions, rental income, or
                        other cash flows. Enter the amount in dollars of the year you retire (inflate CPP/OAS amounts
                        accordingly).
                      </p>
                      <p>
                        Living expenses should also be expressed in retirement-year dollars. The projections will
                        automatically increase living expenses each year after retirement using the configured inflation
                        assumption.
                      </p>
                    </div>
                  )}
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
    retirementIncome: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementLivingExpenses: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    retirementBirthDate: PropTypes.string,
    retirementInflationPercent: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
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
