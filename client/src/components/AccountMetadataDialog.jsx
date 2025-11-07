import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';

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
}) {
  const titleId = useId();
  const fieldBaseId = useId();

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
    };
  }, [initial]);

  const [draft, setDraft] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    setDraft(initialState);
    setBusy(false);
    setErrorMessage(null);
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

  const handleOverlayClick = useCallback(
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

      const payload = {};
      Object.keys(initialState).forEach((key) => {
        const original = initialState[key];
        const current = draft[key];
        if (current !== original) {
          payload[key] = current;
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

  return (
    <div className="account-metadata-overlay" role="presentation" onClick={handleOverlayClick}>
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
                <p className="account-metadata-dialog__hint">Account groups are like accounts; they aggregate other accounts.</p>
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
                <p className="account-metadata-dialog__hint">Optional: Used for linking to the Questrade's UI.</p>
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
  }),
  models: PropTypes.arrayOf(modelShape),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
};

AccountMetadataDialog.defaultProps = {
  accountLabel: null,
  initial: {},
  models: [],
};

