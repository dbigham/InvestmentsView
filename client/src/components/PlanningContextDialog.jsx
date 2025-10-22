import { useCallback, useEffect, useId, useState } from 'react';
import PropTypes from 'prop-types';

export default function PlanningContextDialog({ accountLabel, initialValue, onClose, onSave }) {
  const titleId = useId();
  const descriptionId = useId();
  const fieldId = useId();

  const [value, setValue] = useState(typeof initialValue === 'string' ? initialValue : '');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    setValue(typeof initialValue === 'string' ? initialValue : '');
    setBusy(false);
    setErrorMessage(null);
  }, [initialValue]);

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
        await onSave(value);
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Failed to save planning context.';
        setErrorMessage(message);
        setBusy(false);
        return;
      }
      setBusy(false);
    },
    [busy, onSave, value]
  );

  return (
    <div className="planning-context-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="planning-context-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="planning-context-dialog__header">
          <div className="planning-context-dialog__heading">
            <h2 id={titleId}>Set planning context</h2>
            <p id={descriptionId} className="planning-context-dialog__subtitle">
              Describe how this account should be managed (use of funds, time horizon, risk appetite, etc.).
            </p>
          </div>
          <button
            type="button"
            className="planning-context-dialog__close"
            onClick={handleCancel}
            aria-label="Close dialog"
            disabled={busy}
          >
            ×
          </button>
        </header>
        <form className="planning-context-dialog__form" onSubmit={handleSubmit} noValidate>
          <div className="planning-context-dialog__body">
            {errorMessage && (
              <div className="planning-context-dialog__status" role="alert">
                {errorMessage}
              </div>
            )}
            <label htmlFor={fieldId} className="planning-context-dialog__label">
              <span className="planning-context-dialog__account">{accountLabel}</span>
              <span className="planning-context-dialog__hint">
                Leave the field blank to clear the saved context.
              </span>
            </label>
            <textarea
              id={fieldId}
              className="planning-context-dialog__textarea"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={8}
              disabled={busy}
            />
          </div>
          <footer className="planning-context-dialog__footer">
            <button
              type="button"
              className="planning-context-dialog__button"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="planning-context-dialog__button planning-context-dialog__button--primary"
              disabled={busy}
            >
              {busy ? 'Saving…' : 'Save context'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

PlanningContextDialog.propTypes = {
  accountLabel: PropTypes.string,
  initialValue: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
};

PlanningContextDialog.defaultProps = {
  accountLabel: 'Selected account',
  initialValue: '',
};
