import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

const PROVIDER_QUESTRADE = 'questrade';
const PROVIDER_SNAPTRADE = 'snaptrade';
const DEFAULT_SNAPTRADE_BROKER = 'WEALTHSIMPLETRADE';

function normalizeProvider(value) {
  return value === PROVIDER_SNAPTRADE ? PROVIDER_SNAPTRADE : PROVIDER_QUESTRADE;
}

function resolveLoginDisplay(login) {
  if (!login || typeof login !== 'object') {
    return 'Unknown login';
  }
  return login.label || login.email || login.userId || login.id || 'Unknown login';
}

function resolveProviderLabel(login) {
  const provider = normalizeProvider(login?.provider);
  if (provider === PROVIDER_SNAPTRADE) {
    return login?.providerLabel || 'SnapTrade';
  }
  return login?.providerLabel || 'Questrade';
}

function openConnectionPortal(url) {
  if (typeof window === 'undefined' || !url) {
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export default function QuestradeLoginDialog({
  logins,
  notice,
  prefillEmail,
  mode,
  onClose,
  onSave,
  onCreateSnapTradeConnectionPortal,
  onShowInstructions,
  onStartAccountStructure,
  onStartDemoMode,
}) {
  const titleId = useId();
  const subtitleId = useId();
  const primaryInputRef = useRef(null);
  const [provider, setProvider] = useState(PROVIDER_QUESTRADE);
  const [email, setEmail] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [snapTradeUserId, setSnapTradeUserId] = useState('');
  const [snapTradeUserSecret, setSnapTradeUserSecret] = useState('');
  const [snapTradeClientId, setSnapTradeClientId] = useState('');
  const [snapTradeConsumerKey, setSnapTradeConsumerKey] = useState('');
  const [snapTradeBroker, setSnapTradeBroker] = useState(DEFAULT_SNAPTRADE_BROKER);
  const [status, setStatus] = useState({ saving: false, error: null, success: null });
  const [connectionPortal, setConnectionPortal] = useState(null);
  const [showAccountPrompt, setShowAccountPrompt] = useState(false);
  const [accountPromptMessage, setAccountPromptMessage] = useState('');
  const didPrefillRef = useRef(false);
  const isReconnect = mode === 'reconnect';
  const allowClose = !isReconnect;
  const selectedProvider = isReconnect ? PROVIDER_QUESTRADE : provider;
  const isSnapTrade = selectedProvider === PROVIDER_SNAPTRADE;
  const titleText = isReconnect ? 'Reconnect Questrade' : 'Connect brokerage';
  const subtitleText = isReconnect
    ? 'Update your Questrade refresh token to continue syncing accounts.'
    : isSnapTrade
      ? 'Add or create a SnapTrade end-user, then connect Wealthsimple through the portal.'
      : 'Add your Questrade refresh token so the app can sync accounts.';
  const primaryLabel = isReconnect
    ? status.saving
      ? 'Verifying...'
      : status.error
        ? 'Retry'
        : 'Continue'
    : status.saving
      ? 'Saving...'
      : isSnapTrade
        ? 'Save SnapTrade end-user'
        : 'Save login';

  const loginList = useMemo(() => (Array.isArray(logins) ? logins : []), [logins]);

  useEffect(() => {
    if (primaryInputRef.current && typeof primaryInputRef.current.focus === 'function') {
      primaryInputRef.current.focus({ preventScroll: true });
    }
  }, [selectedProvider]);

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

  const resetAfterSave = useCallback(() => {
    setRefreshToken('');
    setSnapTradeUserSecret('');
    setSnapTradeConsumerKey('');
    if (!isSnapTrade) {
      setEmail('');
    }
    if (primaryInputRef.current && typeof primaryInputRef.current.focus === 'function') {
      primaryInputRef.current.focus({ preventScroll: true });
    }
  }, [isSnapTrade]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (status.saving) {
        return;
      }
      const trimmedEmail = email.trim();
      const trimmedToken = refreshToken.trim();
      const trimmedUserId = snapTradeUserId.trim();
      const trimmedUserSecret = snapTradeUserSecret.trim();
      const trimmedClientId = snapTradeClientId.trim();
      const trimmedConsumerKey = snapTradeConsumerKey.trim();
      const trimmedBroker = snapTradeBroker.trim() || DEFAULT_SNAPTRADE_BROKER;

      if (isSnapTrade) {
        if (!trimmedEmail && !trimmedUserId) {
          setStatus({ saving: false, error: 'Email or SnapTrade end-user ID is required.', success: null });
          return;
        }
      } else if (!trimmedEmail || !trimmedToken) {
        setStatus({ saving: false, error: 'Email and refresh token are required.', success: null });
        return;
      }

      setStatus({ saving: true, error: null, success: null });
      setConnectionPortal(null);
      try {
        const result = await onSave(
          isSnapTrade
            ? {
                provider: PROVIDER_SNAPTRADE,
                email: trimmedEmail,
                userId: trimmedUserId,
                userSecret: trimmedUserSecret,
                clientId: trimmedClientId,
                consumerKey: trimmedConsumerKey,
                broker: trimmedBroker,
              }
            : { provider: PROVIDER_QUESTRADE, email: trimmedEmail, refreshToken: trimmedToken }
        );
        const portal = result?.snapTrade?.connectionPortal || null;
        if (portal?.redirectURI) {
          setConnectionPortal(portal);
          openConnectionPortal(portal.redirectURI);
        }
        resetAfterSave();
        if (isReconnect) {
          setStatus({ saving: false, error: null, success: null });
          setShowAccountPrompt(false);
          setAccountPromptMessage('');
        } else {
          setStatus({
            saving: false,
            error: null,
            success: isSnapTrade
              ? portal?.redirectURI
                ? 'SnapTrade end-user saved. Connection portal opened.'
                : 'SnapTrade end-user saved.'
              : 'Login saved. Add another if you like.',
          });
          setShowAccountPrompt(true);
          setAccountPromptMessage('');
        }
      } catch (error) {
        const message = error && error.message ? error.message : 'Failed to save login.';
        setStatus({ saving: false, error: message, success: null });
      }
    },
    [
      email,
      refreshToken,
      snapTradeUserId,
      snapTradeUserSecret,
      snapTradeClientId,
      snapTradeConsumerKey,
      snapTradeBroker,
      isSnapTrade,
      isReconnect,
      onSave,
      resetAfterSave,
      status.saving,
    ]
  );

  const handleProviderChange = useCallback((nextProvider) => {
    setProvider(normalizeProvider(nextProvider));
    setStatus({ saving: false, error: null, success: null });
    setConnectionPortal(null);
  }, []);

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

  const handleCreatePortal = useCallback(
    async (login) => {
      if (!login?.id || typeof onCreateSnapTradeConnectionPortal !== 'function') {
        return;
      }
      setStatus({ saving: true, error: null, success: null });
      setConnectionPortal(null);
      try {
        const payload = await onCreateSnapTradeConnectionPortal(login.id, {
          broker: login.defaultBroker || DEFAULT_SNAPTRADE_BROKER,
        });
        const portal = payload?.connectionPortal || null;
        if (portal?.redirectURI) {
          setConnectionPortal(portal);
          openConnectionPortal(portal.redirectURI);
          setStatus({ saving: false, error: null, success: 'Connection portal opened.' });
        } else {
          setStatus({ saving: false, error: 'SnapTrade did not return a connection link.', success: null });
        }
      } catch (error) {
        const message = error && error.message ? error.message : 'Failed to create connection link.';
        setStatus({ saving: false, error: message, success: null });
      }
    },
    [onCreateSnapTradeConnectionPortal]
  );

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
              {!isReconnect ? (
                <div className="login-setup-dialog__provider-tabs" role="tablist" aria-label="Broker provider">
                  <button
                    type="button"
                    className={`login-setup-dialog__provider-tab${!isSnapTrade ? ' login-setup-dialog__provider-tab--active' : ''}`}
                    onClick={() => handleProviderChange(PROVIDER_QUESTRADE)}
                    aria-pressed={!isSnapTrade}
                  >
                    Questrade
                  </button>
                  <button
                    type="button"
                    className={`login-setup-dialog__provider-tab${isSnapTrade ? ' login-setup-dialog__provider-tab--active' : ''}`}
                    onClick={() => handleProviderChange(PROVIDER_SNAPTRADE)}
                    aria-pressed={isSnapTrade}
                  >
                    SnapTrade
                  </button>
                </div>
              ) : null}
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
              {connectionPortal?.redirectURI ? (
                <div className="login-setup-dialog__status login-setup-dialog__status--success">
                  <a href={connectionPortal.redirectURI} target="_blank" rel="noopener noreferrer">
                    Open SnapTrade connection portal
                  </a>
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
                  ref={primaryInputRef}
                  id="login-email"
                  type="email"
                  className="login-setup-dialog__input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  autoComplete="email"
                  spellCheck="false"
                  required={!isSnapTrade}
                />
              </div>
              {isSnapTrade ? (
                <>
                  <div className="login-setup-dialog__field">
                    <label htmlFor="snaptrade-user-id">SnapTrade end-user ID</label>
                    <input
                      id="snaptrade-user-id"
                      className="login-setup-dialog__input"
                      value={snapTradeUserId}
                      onChange={(event) => setSnapTradeUserId(event.target.value)}
                      placeholder="Leave blank to create one"
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>
                  <div className="login-setup-dialog__field">
                    <label htmlFor="snaptrade-user-secret">SnapTrade end-user secret</label>
                    <textarea
                      id="snaptrade-user-secret"
                      className="login-setup-dialog__textarea"
                      value={snapTradeUserSecret}
                      onChange={(event) => setSnapTradeUserSecret(event.target.value)}
                      placeholder="Leave blank to register a new SnapTrade end-user"
                      rows={3}
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>
                  <div className="login-setup-dialog__field">
                    <label htmlFor="snaptrade-client-id">SnapTrade Client ID</label>
                    <input
                      id="snaptrade-client-id"
                      className="login-setup-dialog__input"
                      value={snapTradeClientId}
                      onChange={(event) => setSnapTradeClientId(event.target.value)}
                      placeholder="Leave blank to use server default"
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>
                  <div className="login-setup-dialog__field">
                    <label htmlFor="snaptrade-consumer-key">SnapTrade Consumer Key</label>
                    <input
                      id="snaptrade-consumer-key"
                      type="password"
                      className="login-setup-dialog__input"
                      value={snapTradeConsumerKey}
                      onChange={(event) => setSnapTradeConsumerKey(event.target.value)}
                      placeholder="Leave blank to use server default"
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>
                  <div className="login-setup-dialog__field">
                    <label htmlFor="snaptrade-broker">Broker slug</label>
                    <input
                      id="snaptrade-broker"
                      className="login-setup-dialog__input"
                      value={snapTradeBroker}
                      onChange={(event) => setSnapTradeBroker(event.target.value)}
                      placeholder={DEFAULT_SNAPTRADE_BROKER}
                      autoComplete="off"
                      spellCheck="false"
                    />
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
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
                  {loginList.map((login) => {
                    const loginProvider = normalizeProvider(login?.provider);
                    return (
                      <li key={login.id || login.email || login.label} className="login-setup-dialog__list-item">
                        <span className="login-setup-dialog__list-label">{resolveLoginDisplay(login)}</span>
                        <span className="login-setup-dialog__list-meta">{resolveProviderLabel(login)}</span>
                        {login.updatedAt ? (
                          <span className="login-setup-dialog__list-meta">Updated {login.updatedAt}</span>
                        ) : null}
                        {loginProvider === PROVIDER_SNAPTRADE && login.hasCustomCredentials ? (
                          <span className="login-setup-dialog__list-meta">Custom SnapTrade credentials</span>
                        ) : null}
                        {loginProvider === PROVIDER_SNAPTRADE && typeof onCreateSnapTradeConnectionPortal === 'function' ? (
                          <button
                            type="button"
                            className="login-setup-dialog__list-action"
                            onClick={() => handleCreatePortal(login)}
                            disabled={status.saving}
                          >
                            Connect Wealthsimple
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
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
      provider: PropTypes.string,
      providerLabel: PropTypes.string,
      label: PropTypes.string,
      email: PropTypes.string,
      userId: PropTypes.string,
      defaultBroker: PropTypes.string,
      hasCustomCredentials: PropTypes.bool,
      updatedAt: PropTypes.string,
    })
  ),
  notice: PropTypes.string,
  prefillEmail: PropTypes.string,
  mode: PropTypes.oneOf(['setup', 'reconnect']),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
  onCreateSnapTradeConnectionPortal: PropTypes.func,
  onShowInstructions: PropTypes.func.isRequired,
  onStartAccountStructure: PropTypes.func,
  onStartDemoMode: PropTypes.func,
};

QuestradeLoginDialog.defaultProps = {
  logins: [],
  notice: null,
  prefillEmail: '',
  mode: 'setup',
  onCreateSnapTradeConnectionPortal: null,
  onStartAccountStructure: null,
  onStartDemoMode: null,
};
