import { useCallback, useEffect, useId, useState } from 'react';
import PropTypes from 'prop-types';

export default function QuestradeRefreshTokenDialog({ onClose }) {
  const titleId = useId();
  const descriptionId = useId();
  const [screenshotDialog, setScreenshotDialog] = useState(null);

  const openScreenshot = useCallback((event, url, alt) => {
    event.preventDefault();
    event.stopPropagation();
    setScreenshotDialog({ url, alt });
  }, []);

  const closeScreenshot = useCallback(() => {
    setScreenshotDialog(null);
  }, []);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleScreenshotOverlayClick = useCallback(
    (event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) {
        closeScreenshot();
      }
    },
    [closeScreenshot]
  );

  const stopScreenshotClick = useCallback((event) => {
    event.stopPropagation();
  }, []);

  return (
    <div className="login-setup-help-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="login-setup-help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="login-setup-help-dialog__header">
          <h2 id={titleId} className="login-setup-help-dialog__title">Get a Questrade refresh token</h2>
          <button type="button" className="login-setup-help-dialog__close" onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </header>
        <div className="login-setup-help-dialog__body" id={descriptionId}>
          <ol className="login-setup-help-dialog__steps">
            <li>
              Open the Questrade App Hub:
              <a href="https://apphub.questrade.com/UI/UserApps.aspx" target="_blank" rel="noopener noreferrer">
                https://apphub.questrade.com/UI/UserApps.aspx
              </a>
            </li>
            <li>
              Create a personal app if you have not already.
              <button
                type="button"
                className="login-setup-help-dialog__screenshot-link"
                onClick={(event) =>
                  openScreenshot(
                    event,
                    '/screenshots/creating-questrade-personal-app.png',
                    'Register a personal app form'
                  )
                }
              >
                (View screenshot)
              </button>{' '}
              Make sure the second OAuth scope is checked, and you can leave the callback URL empty.
            </li>
            <li>
              On the app card, click "Add Device".
              <button
                type="button"
                className="login-setup-help-dialog__screenshot-link"
                onClick={(event) =>
                  openScreenshot(
                    event,
                    '/screenshots/adding-authorization.png',
                    'Add device button on app card'
                  )
                }
              >
                (View screenshot)
              </button>{' '}
            </li>
            <li>
              In the Authorizations list, click "Generate new token".
              <button
                type="button"
                className="login-setup-help-dialog__screenshot-link"
                onClick={(event) =>
                  openScreenshot(
                    event,
                    '/screenshots/adding-authorization-2.png',
                    'Generate new token link'
                  )
                }
              >
                (View screenshot)
              </button>{' '}
            </li>
            <li>
              In the refresh token dialog, select the token text and copy it manually (the "COPY TOKEN" button is broken).
              <button
                type="button"
                className="login-setup-help-dialog__screenshot-link"
                onClick={(event) =>
                  openScreenshot(
                    event,
                    '/screenshots/adding-authorization-3.png',
                    'Refresh token dialog with manual copy'
                  )
                }
              >
                (View screenshot)
              </button>{' '}
              Paste the token into the setup dialog.
            </li>
          </ol>
        </div>
        <footer className="login-setup-help-dialog__footer">
          <button type="button" className="login-setup-help-dialog__button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
      {screenshotDialog && (
        <div
          className="login-setup-screenshot-overlay"
          role="presentation"
          onClick={handleScreenshotOverlayClick}
        >
          <div
            className="login-setup-screenshot-dialog"
            role="dialog"
            aria-modal="true"
            onClick={stopScreenshotClick}
          >
            <div className="login-setup-screenshot-header">
              <span className="login-setup-screenshot-title">Screenshot</span>
              <button
                type="button"
                className="login-setup-screenshot-close"
                onClick={closeScreenshot}
                aria-label="Close screenshot"
              >
                &times;
              </button>
            </div>
            <div className="login-setup-screenshot-body" onClick={stopScreenshotClick}>
              <img
                src={screenshotDialog.url}
                alt={screenshotDialog.alt || 'Questrade screenshot'}
                className="login-setup-screenshot-image"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

QuestradeRefreshTokenDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
};
