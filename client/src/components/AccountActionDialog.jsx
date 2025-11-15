import { useCallback, useEffect, useId, useRef } from 'react';
import PropTypes from 'prop-types';

export default function AccountActionDialog({ title, message, options, onSelect, onCancel }) {
  const titleId = useId();
  const descriptionId = useId();
  const firstOptionRef = useRef(null);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  useEffect(() => {
    if (firstOptionRef.current && typeof firstOptionRef.current.focus === 'function') {
      firstOptionRef.current.focus({ preventScroll: true });
    }
  }, [options]);

  const handleOverlayClick = useCallback(
    (event) => {
      if (event.target === event.currentTarget) {
        onCancel();
      }
    },
    [onCancel]
  );

  return (
    <div className="account-action-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="account-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? descriptionId : undefined}
      >
        <header className="account-action-dialog__header">
          <h2 id={titleId} className="account-action-dialog__title">
            {title}
          </h2>
        </header>
        <div className="account-action-dialog__body">
          {message ? (
            <p id={descriptionId} className="account-action-dialog__message">
              {message}
            </p>
          ) : null}
          <ul className="account-action-dialog__options" role="list">
            {options.map((option, index) => (
              <li key={option.key} className="account-action-dialog__option-item">
                <button
                  type="button"
                  className="account-action-dialog__option"
                  onClick={() => onSelect(option.key)}
                  ref={index === 0 ? firstOptionRef : null}
                >
                  <span className="account-action-dialog__option-label">{option.label}</span>
                  {option.description ? (
                    <span className="account-action-dialog__option-description">{option.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <footer className="account-action-dialog__footer">
          <button type="button" className="account-action-dialog__cancel" onClick={onCancel}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

AccountActionDialog.propTypes = {
  title: PropTypes.string.isRequired,
  message: PropTypes.string,
  options: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      description: PropTypes.string,
    })
  ),
  onSelect: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

AccountActionDialog.defaultProps = {
  message: null,
  options: [],
};
