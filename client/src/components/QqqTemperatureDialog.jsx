import { useEffect } from 'react';
import PropTypes from 'prop-types';
import QqqTemperatureSection from './QqqTemperatureSection';

export default function QqqTemperatureDialog({
  onClose,
  data,
  loading,
  error,
  onRetry,
  modelName,
  lastRebalance,
  evaluation,
}) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="qqq-dialog-overlay" role="presentation" onClick={handleOverlayClick}>
      <div className="qqq-dialog" role="dialog" aria-modal="true" aria-label="Investment model details">
        <button type="button" className="qqq-dialog__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="qqq-dialog__content">
          <QqqTemperatureSection
            data={data}
            loading={loading}
            error={error}
            onRetry={onRetry}
            title="Investment Model"
            modelName={modelName}
            lastRebalance={lastRebalance}
            evaluation={evaluation}
          />
        </div>
      </div>
    </div>
  );
}

QqqTemperatureDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
  data: QqqTemperatureSection.propTypes.data,
  loading: PropTypes.bool,
  error: PropTypes.instanceOf(Error),
  onRetry: PropTypes.func,
  modelName: PropTypes.string,
  lastRebalance: PropTypes.string,
  evaluation: QqqTemperatureSection.propTypes.evaluation,
};

QqqTemperatureDialog.defaultProps = {
  data: QqqTemperatureSection.defaultProps.data,
  loading: false,
  error: null,
  onRetry: null,
  modelName: 'A1',
  lastRebalance: null,
  evaluation: QqqTemperatureSection.defaultProps.evaluation,
};
