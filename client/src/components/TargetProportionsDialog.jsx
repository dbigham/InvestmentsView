import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatNumber } from '../utils/formatters';

function normalizeTargetProportionsMap(value) {
  const normalized = new Map();
  if (!value) {
    return normalized;
  }

  const record = (symbolCandidate, percentCandidate) => {
    if (!symbolCandidate) {
      return;
    }
    const symbol = String(symbolCandidate).trim().toUpperCase();
    if (!symbol) {
      return;
    }
    const numeric = Number(percentCandidate);
    if (!Number.isFinite(numeric)) {
      return;
    }
    normalized.set(symbol, numeric);
  };

  if (value instanceof Map) {
    value.forEach((percentCandidate, symbolCandidate) => {
      record(symbolCandidate, percentCandidate);
    });
    return normalized;
  }

  if (typeof value === 'object') {
    Object.entries(value).forEach(([symbolCandidate, percentCandidate]) => {
      record(symbolCandidate, percentCandidate);
    });
  }

  return normalized;
}

function formatPercentInput(value) {
  if (!Number.isFinite(value)) {
    return '';
  }
  return value.toFixed(2);
}

function parsePercentInput(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value !== 'string') {
    return NaN;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/%/g, '').replace(/,/g, '');
  if (!normalized) {
    return NaN;
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    return NaN;
  }
  return numeric;
}

function formatPercentDisplay(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return `${formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function truncateDescription(value) {
  if (!value) {
    return '';
  }
  const normalized = String(value);
  if (normalized.length <= 21) {
    return normalized;
  }
  return `${normalized.slice(0, 21).trimEnd()}...`;
}

export default function TargetProportionsDialog({
  accountLabel,
  positions,
  targetProportions,
  onClose,
  onSave,
}) {
  const titleId = useId();
  const normalizedTargets = useMemo(
    () => normalizeTargetProportionsMap(targetProportions),
    [targetProportions]
  );

  const normalizedPositions = useMemo(() => {
    if (!Array.isArray(positions) || positions.length === 0) {
      return [];
    }
    const seen = new Set();
    return positions
      .map((position) => {
        if (!position || typeof position.symbol !== 'string') {
          return null;
        }
        const symbol = position.symbol.trim().toUpperCase();
        if (!symbol || seen.has(symbol)) {
          return null;
        }
        seen.add(symbol);
        const description =
          typeof position.description === 'string' && position.description.trim().length
            ? position.description.trim()
            : null;
        const portfolioShare = Number(position.portfolioShare);
        const targetProportionValue = Number(position.targetProportion);
        return {
          symbol,
          description,
          portfolioShare: Number.isFinite(portfolioShare) ? portfolioShare : null,
          targetProportion: Number.isFinite(targetProportionValue) ? targetProportionValue : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [positions]);

  const initialInputs = useMemo(() => {
    const defaults = {};
    normalizedPositions.forEach((position) => {
      const existing = normalizedTargets.get(position.symbol);
      const baseValue = Number.isFinite(existing)
        ? existing
        : Number.isFinite(position.targetProportion)
        ? position.targetProportion
        : Number.isFinite(position.portfolioShare)
        ? position.portfolioShare
        : null;
      defaults[position.symbol] = Number.isFinite(baseValue) ? formatPercentInput(baseValue) : '';
    });
    return defaults;
  }, [normalizedPositions, normalizedTargets]);

  const [inputs, setInputs] = useState(initialInputs);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    setInputs(initialInputs);
  }, [initialInputs]);

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

  const handleInputChange = useCallback((symbol, value) => {
    setInputs((prev) => ({
      ...prev,
      [symbol]: value,
    }));
  }, []);

  const handleInputBlur = useCallback((symbol) => {
    setInputs((prev) => {
      const current = prev[symbol];
      const parsed = parsePercentInput(current);
      if (parsed === null || !Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
        return prev;
      }
      const formatted = formatPercentInput(parsed);
      if (formatted === current) {
        return prev;
      }
      return {
        ...prev,
        [symbol]: formatted,
      };
    });
  }, []);

  const parsedState = useMemo(() => {
    const parsed = new Map();
    const invalid = new Set();
    let total = 0;

    normalizedPositions.forEach((position) => {
      const rawValue = inputs[position.symbol];
      const parsedValue = parsePercentInput(rawValue);
      if (parsedValue === null || parsedValue === 0) {
        return;
      }
      if (!Number.isFinite(parsedValue) || parsedValue < 0 || parsedValue > 1000) {
        invalid.add(position.symbol);
        return;
      }
      const rounded = Math.round((parsedValue + Number.EPSILON) * 10000) / 10000;
      parsed.set(position.symbol, rounded);
      total += rounded;
    });

    return { parsed, invalid, total };
  }, [inputs, normalizedPositions]);

  const totalPercent = parsedState.total;
  const invalidSymbols = parsedState.invalid;
  const parsedValues = parsedState.parsed;

  const totalPercentLabel = Number.isFinite(totalPercent)
    ? formatNumber(totalPercent, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';

  let totalStatus = 'empty';
  if (Number.isFinite(totalPercent) && totalPercent > 0) {
    totalStatus = Math.abs(totalPercent - 100) <= 0.5 ? 'ok' : 'warning';
  }

  const disableSubmit = busy || invalidSymbols.size > 0;

  useEffect(() => {
    if (submitError && invalidSymbols.size === 0) {
      setSubmitError(null);
    }
  }, [invalidSymbols.size, submitError]);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      if (invalidSymbols.size > 0) {
        setSubmitError('Fix invalid percentages before saving.');
        return;
      }
      setSubmitError(null);
      setBusy(true);
      const payload = {};
      parsedValues.forEach((value, symbol) => {
        if (value > 0) {
          const bounded = Math.min(Math.max(value, 0), 1000);
          const rounded = Math.round((bounded + Number.EPSILON) * 10000) / 10000;
          payload[symbol] = rounded;
        }
      });
      try {
        await onSave(payload);
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : 'Failed to save target proportions.';
        setSubmitError(message);
        setBusy(false);
      }
    },
    [busy, invalidSymbols.size, onSave, parsedValues]
  );

  const handleCancel = useCallback(() => {
    if (busy) {
      return;
    }
    onClose();
  }, [busy, onClose]);

  return (
    <div className="target-proportions-overlay" role="presentation" onClick={handleOverlayClick}>
      <div
        className="target-proportions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="target-proportions-dialog__header">
          <div className="target-proportions-dialog__heading">
            <h2 id={titleId}>Manage target proportions</h2>
            {accountLabel && (
              <p className="target-proportions-dialog__subtitle">{accountLabel}</p>
            )}
            <p className="target-proportions-dialog__hint">
              Set the desired percentage allocation for each position. Leave a field blank to remove its target.
            </p>
          </div>
          <button
            type="button"
            className="target-proportions-dialog__close"
            onClick={handleCancel}
            aria-label="Close dialog"
            disabled={busy}
          >
            ×
          </button>
        </header>

        <form className="target-proportions-dialog__form" onSubmit={handleSubmit} noValidate>
          <div className="target-proportions-dialog__body">
            {submitError && (
              <div className="target-proportions-dialog__status target-proportions-dialog__status--error" role="alert">
                {submitError}
              </div>
            )}
            {normalizedPositions.length > 0 ? (
              <>
                <div className="target-proportions-dialog__summary">
                  <div className={`target-proportions-dialog__total target-proportions-dialog__total--${totalStatus}`}>
                    <span>Total configured: {totalPercentLabel}%</span>
                    {totalStatus === 'warning' && (
                      <span className="target-proportions-dialog__total-note">
                        Targets typically sum to 100%. Adjust as needed.
                      </span>
                    )}
                  </div>
                </div>
                <div className="target-proportions-dialog__table-wrapper">
                  <table className="target-proportions-table">
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th scope="col">Current %</th>
                        <th scope="col">Target %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {normalizedPositions.map((position) => {
                        const inputValue = inputs[position.symbol] ?? '';
                        const currentShareLabel = formatPercentDisplay(position.portfolioShare);
                        const truncatedDescription = truncateDescription(position.description);
                        const rowHasError = invalidSymbols.has(position.symbol);
                        return (
                          <tr key={position.symbol}>
                            <th scope="row">
                              <div className="target-proportions-table__symbol">
                                <span className="target-proportions-table__symbol-ticker">{position.symbol}</span>
                                {truncatedDescription && (
                                  <span
                                    className="target-proportions-table__symbol-name"
                                    title={position.description || undefined}
                                  >
                                    {truncatedDescription}
                                  </span>
                                )}
                              </div>
                            </th>
                            <td className="target-proportions-table__metric">{currentShareLabel}</td>
                            <td>
                              <div className="target-proportions-table__input-group">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  className={
                                    rowHasError
                                      ? 'target-proportions-table__input target-proportions-table__input--error'
                                      : 'target-proportions-table__input'
                                  }
                                  value={inputValue}
                                  onChange={(event) => handleInputChange(position.symbol, event.target.value)}
                                  onBlur={() => handleInputBlur(position.symbol)}
                                  aria-invalid={rowHasError}
                                />
                                {rowHasError && (
                                  <p className="target-proportions-table__error">Enter a value between 0 and 1000.</p>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="target-proportions-dialog__empty">No eligible positions were found.</p>
            )}
          </div>

          <footer className="target-proportions-dialog__footer">
            <button
              type="button"
              className="target-proportions-dialog__button"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="target-proportions-dialog__button target-proportions-dialog__button--primary"
              disabled={disableSubmit}
            >
              {busy ? 'Saving…' : 'Save targets'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

const positionShape = PropTypes.shape({
  symbol: PropTypes.string,
  description: PropTypes.string,
  portfolioShare: PropTypes.number,
  targetProportion: PropTypes.number,
});

TargetProportionsDialog.propTypes = {
  accountLabel: PropTypes.string,
  positions: PropTypes.arrayOf(positionShape),
  targetProportions: PropTypes.oneOfType([PropTypes.instanceOf(Map), PropTypes.object]),
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
};

TargetProportionsDialog.defaultProps = {
  accountLabel: null,
  positions: [],
  targetProportions: null,
};
