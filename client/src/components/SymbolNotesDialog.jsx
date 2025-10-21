import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatNumber } from '../utils/formatters';

function formatTargetProportion(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `${formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export default function SymbolNotesDialog({ symbol, entries, onClose, onSave }) {
  const titleId = useId();
  const descriptionId = useId();
  const fieldBaseId = useId();

  const initialDrafts = useMemo(() => {
    const map = {};
    if (Array.isArray(entries)) {
      entries.forEach((entry) => {
        if (!entry || !entry.accountKey) {
          return;
        }
        map[entry.accountKey] = typeof entry.notes === 'string' ? entry.notes : '';
      });
    }
    return map;
  }, [entries]);

  const [drafts, setDrafts] = useState(initialDrafts);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    setDrafts(initialDrafts);
    setBusy(false);
    setErrorMessage(null);
  }, [initialDrafts]);

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

  const sortedEntries = useMemo(() => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries
      .slice()
      .sort((a, b) => a.accountLabel.localeCompare(b.accountLabel, undefined, { sensitivity: 'base' }));
  }, [entries]);

  const hasChanges = useMemo(() => {
    if (!Array.isArray(sortedEntries) || !sortedEntries.length) {
      return false;
    }
    return sortedEntries.some((entry) => {
      if (!entry || !entry.accountKey) {
        return false;
      }
      const original = typeof entry.notes === 'string' ? entry.notes.trim() : '';
      const current = typeof drafts[entry.accountKey] === 'string' ? drafts[entry.accountKey].trim() : '';
      return original !== current;
    });
  }, [drafts, sortedEntries]);

  const handleOverlayClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget && !busy) {
        onClose();
      }
    },
    [busy, onClose]
  );

  const handleInputChange = useCallback((accountKey, value) => {
    setDrafts((prev) => ({
      ...prev,
      [accountKey]: value,
    }));
  }, []);

  const handleCancel = useCallback(() => {
    if (!busy) {
      onClose();
    }
  }, [busy, onClose]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      setErrorMessage(null);
      try {
        setBusy(true);
        await onSave(drafts);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Failed to save notes.';
        setErrorMessage(message);
        setBusy(false);
        return;
      }
      setBusy(false);
    },
    [busy, drafts, onSave]
  );

  return (
    <div className="symbol-notes-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="symbol-notes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="symbol-notes-dialog__header">
          <div className="symbol-notes-dialog__heading">
            <h2 id={titleId}>Notes for {symbol}</h2>
            <p id={descriptionId} className="symbol-notes-dialog__subtitle">
              Maintain per-account notes for this symbol.
            </p>
          </div>
          <button
            type="button"
            className="symbol-notes-dialog__close"
            onClick={handleCancel}
            aria-label="Close dialog"
            disabled={busy}
          >
            ×
          </button>
        </header>
        <form className="symbol-notes-dialog__form" onSubmit={handleSubmit} noValidate>
          <div className="symbol-notes-dialog__body">
            {errorMessage && (
              <div className="symbol-notes-dialog__status symbol-notes-dialog__status--error" role="alert">
                {errorMessage}
              </div>
            )}
            {sortedEntries.length > 0 ? (
              sortedEntries.map((entry, index) => {
                const fieldId = `${fieldBaseId}-${index}`;
                const targetLabel = formatTargetProportion(entry.targetProportion);
                const owner = entry.ownerLabel ? ` (${entry.ownerLabel})` : '';
                return (
                  <div key={entry.accountKey} className="symbol-notes-dialog__section">
                    <label htmlFor={fieldId} className="symbol-notes-dialog__label">
                      <span className="symbol-notes-dialog__account">
                        {entry.accountLabel}
                        {owner}
                      </span>
                      {targetLabel && (
                        <span className="symbol-notes-dialog__target">Target: {targetLabel}</span>
                      )}
                    </label>
                    <textarea
                      id={fieldId}
                      className="symbol-notes-dialog__textarea"
                      value={drafts[entry.accountKey] ?? ''}
                      onChange={(event) => handleInputChange(entry.accountKey, event.target.value)}
                      placeholder="Add notes for this account"
                      rows={5}
                      disabled={busy}
                    />
                  </div>
                );
              })
            ) : (
              <p className="symbol-notes-dialog__empty">No accounts available for this symbol.</p>
            )}
          </div>
          <footer className="symbol-notes-dialog__footer">
            <button
              type="button"
              className="symbol-notes-dialog__button"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="symbol-notes-dialog__button symbol-notes-dialog__button--primary"
              disabled={busy || !hasChanges}
            >
              {busy ? 'Saving…' : 'Save notes'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

SymbolNotesDialog.propTypes = {
  symbol: PropTypes.string.isRequired,
  entries: PropTypes.arrayOf(
    PropTypes.shape({
      accountKey: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
      accountId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      accountNumber: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      accountLabel: PropTypes.string.isRequired,
      ownerLabel: PropTypes.string,
      notes: PropTypes.string,
      targetProportion: PropTypes.number,
    })
  ).isRequired,
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
};
