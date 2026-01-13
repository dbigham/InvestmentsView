import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

function resolveLoginDisplay(login) {
  if (!login || typeof login !== 'object') {
    return 'Unknown login';
  }
  return login.label || login.email || login.id || 'Unknown login';
}

export default function QuestradeLoginDialog({
  logins,
  notice,
  prefillEmail,
  mode,
  onClose,
  onSave,
  onShowInstructions,
  onStartAccountStructure,
  onStartDemoMode,
}) {
  const titleId = useId();
  const subtitleId = useId();
  const emailInputRef = useRef(null);
  const [email, setEmail] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [status, setStatus] = useState({ saving: false, error: null, success: null });
  const [showAccountPrompt, setShowAccountPrompt] = useState(false);
  const [accountPromptMessage, setAccountPromptMessage] = useState('');
  const didPrefillRef = useRef(false);
  const isReconnect = mode === 'reconnect';
  const allowClose = !isReconnect;
  const titleText = isReconnect ? 'Reconnect Questrade' : 'Connect Questrade';
  const subtitleText = isReconnect
    ? 'Update your Questrade refresh token to continue syncing accounts.'
    : 'Add your Questrade refresh token so the app can sync accounts.';
  const primaryLabel = isReconnect
    ? status.saving
      ? 'Verifying...'
      : status.error
        ? 'Retry'
        : 'Continue'
    : status.saving
      ? 'Saving...'
      : 'Save login';

  const loginList = useMemo(() => (Array.isArray(logins) ? logins : []), [logins]);

  useEffect(() => {
    if (emailInputRef.current && typeof emailInputRef.current.focus === 'function') {
      emailInputRef.current.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    if (!allowClose) {
      return;
    }
    const handler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [allowClose, onClose]);

  useEffect(() => {
    if (didPrefillRef.current) {
      return;
    }
    if (email) {
      didPrefillRef.current = true;
      return;
    }
    const candidate = typeof prefillEmail === 'string' ? prefillEmail.trim() : '';
    if (candidate) {
      setEmail(candidate);
      didPrefillRef.current = true;
    }
  }, [prefillEmail, email]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (status.saving) {
        return;
      }
      const trimmedEmail = email.trim();
      const trimmedToken = refreshToken.trim();
      if (!trimmedEmail || !trimmedToken) {
        setStatus({ saving: false, error: 'Email and refresh token are required.', success: null });
        return;
      }
      setStatus({ saving: true, error: null, success: null });
      try {
        await onSave({ email: trimmedEmail, refreshToken: trimmedToken });
        setEmail('');
        setRefreshToken('');
        if (isReconnect) {
          setStatus({ saving: false, error: null, success: null });
          setShowAccountPrompt(false);
          setAccountPromptMessage('');
        } else {
          setStatus({ saving: false, error: null, success: 'Login saved. Add another if you like.' });
          setShowAccountPrompt(true);
          setAccountPromptMessage('');
          if (emailInputRef.current && typeof emailInputRef.current.focus === 'function') {
            emailInputRef.current.focus({ preventScroll: true });
          }
        }
      } catch (error) {
        const message = error && error.message ? error.message : 'Failed to save login.';
        setStatus({ saving: false, error: message, success: null });
      }
    },
    [email, refreshToken, isReconnect, onSave, status.saving]
  );

  const handleAccountPromptYes = useCallback(() => {
    setShowAccountPrompt(false);
    setAccountPromptMessage('');
    if (onStartAccountStructure) {
      onStartAccountStructure();
    }
  }, [onStartAccountStructure]);

  const handleAccountPromptNo = useCallback(() => {
    setAccountPromptMessage('You can manage accounts later from Actions > Manage accounts.');
    setShowAccountPrompt(false);
  }, []);

  return (
    <div className="login-setup-overlay" role="presentation">
      <div
        className="login-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
      >
        <header className="login-setup-dialog__header">
          <div className="login-setup-dialog__heading">
            <h2 id={titleId} className="login-setup-dialog__title">{titleText}</h2>
            <p id={subtitleId} className="login-setup-dialog__subtitle">
              {subtitleText}
            </p>
          </div>
          {allowClose ? (
            <button type="button" className="login-setup-dialog__close" onClick={onClose} aria-label="Close dialog">
              &times;
            </button>
          ) : null}
        </header>
        <form className="login-setup-dialog__form" onSubmit={handleSubmit}>
          <div className="login-setup-dialog__body">
            <section className="login-setup-dialog__panel login-setup-dialog__panel--form">
              {notice ? (
                <div className="login-setup-dialog__status login-setup-dialog__status--warning" role="status">
                  {notice}
                </div>
              ) : null}
              {status.error ? (
                <div className="login-setup-dialog__status login-setup-dialog__status--error" role="alert">
                  {status.error}
                </div>
              ) : null}
              {status.success && !isReconnect ? (
                <div className="login-setup-dialog__status login-setup-dialog__status--success">
                  {status.success}
                </div>
              ) : null}
              {showAccountPrompt && !isReconnect ? (
                <div className="login-setup-dialog__followup">
                  <p className="login-setup-dialog__followup-text">
                    Would you like to name your accounts and set up groups now?
                  </p>
                  <div className="login-setup-dialog__followup-actions">
                    <button
                      type="button"
                      className="login-setup-dialog__button"
                      onClick={handleAccountPromptNo}
                    >
                      Not now
                    </button>
                    <button
                      type="button"
                      className="login-setup-dialog__button login-setup-dialog__button--primary"
                      onClick={handleAccountPromptYes}
                    >
                      Yes, set them up
                    </button>
                  </div>
                </div>
              ) : null}
              {accountPromptMessage ? (
                <div className="login-setup-dialog__status login-setup-dialog__status--success">
                  {accountPromptMessage}
                </div>
              ) : null}
              <div className="login-setup-dialog__field">
                <label htmlFor="login-email">Email address</label>
                <input
                  ref={emailInputRef}
                  id="login-email"
                  type="email"
                  className="login-setup-dialog__input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  autoComplete="email"
                  spellCheck="false"
                  required
                />
              </div>
              <div className="login-setup-dialog__field">
                <label htmlFor="login-refresh-token">Questrade refresh token</label>
                <textarea
                  id="login-refresh-token"
                  className="login-setup-dialog__textarea"
                  value={refreshToken}
                  onChange={(event) => setRefreshToken(event.target.value)}
                  placeholder="Paste your refresh token here"
                  rows={4}
                  autoComplete="off"
                  spellCheck="false"
                  required
                />
              </div>
              <button type="button" className="login-setup-dialog__link" onClick={onShowInstructions}>
                How do I get a refresh token?
              </button>
              {!isReconnect && typeof onStartDemoMode === 'function' ? (
                <div className="login-setup-dialog__demo">
                  <div className="login-setup-dialog__demo-title">Just exploring?</div>
                  <p className="login-setup-dialog__demo-text">
                    Launch a fully offline demo with sample data. No tokens required.
                  </p>
                  <button
                    type="button"
                    className="login-setup-dialog__button login-setup-dialog__button--ghost"
                    onClick={onStartDemoMode}
                  >
                    Try Demo Mode
                  </button>
                </div>
              ) : null}
            </section>
            <aside className="login-setup-dialog__panel login-setup-dialog__panel--list">
              <h3 className="login-setup-dialog__panel-title">Saved logins</h3>
              {loginList.length ? (
                <ul className="login-setup-dialog__list" role="list">
                  {loginList.map((login) => (
                    <li key={login.id || login.email || login.label} className="login-setup-dialog__list-item">
                      <span className="login-setup-dialog__list-label">{resolveLoginDisplay(login)}</span>
                      {login.updatedAt ? (
                        <span className="login-setup-dialog__list-meta">Updated {login.updatedAt}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="login-setup-dialog__empty">No logins saved yet.</p>
              )}
            </aside>
          </div>
          <footer className="login-setup-dialog__footer">
            {allowClose ? (
              <button type="button" className="login-setup-dialog__button" onClick={onClose} disabled={status.saving}>
                Close
              </button>
            ) : null}
            <button type="submit" className="login-setup-dialog__button login-setup-dialog__button--primary" disabled={status.saving}>
              {primaryLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

QuestradeLoginDialog.propTypes = {
  logins: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      label: PropTypes.string,
      email: PropTypes.string,
      updatedAt: PropTypes.string,
    })
  ),
  notice: PropTypes.string,
  prefillEmail: PropTypes.string,
  mode: PropTypes.oneOf(['setup', 'reconnect']),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  onShowInstructions: PropTypes.func.isRequired,
  onStartAccountStructure: PropTypes.func,
  onStartDemoMode: PropTypes.func,
};

QuestradeLoginDialog.defaultProps = {
  logins: [],
  notice: null,
  prefillEmail: '',
  mode: 'setup',
  onStartAccountStructure: null,
  onStartDemoMode: null,
};
