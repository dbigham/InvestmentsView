import { useEffect } from 'react';
import PropTypes from 'prop-types';

export default function NewsPromptDialog({ onClose, prompt, rawOutput, usage, pricing, cost }) {
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
      <div
        className="qqq-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="news-prompt-dialog-title"
        style={{ padding: 24 }}
      >
        <button type="button" className="qqq-dialog__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="qqq-dialog__content" style={{ padding: 0 }}>
          <h2 id="news-prompt-dialog-title">Portfolio News Prompt</h2>
          <div style={{ marginTop: 4, color: 'var(--color-text-muted)', fontSize: 12 }}>
            Model: {pricing?.model || 'Unknown'}
          </div>
          <div style={{ marginTop: 8, color: 'var(--color-text-muted)', fontSize: 12 }}>
            {(() => {
              const inTok = usage?.inputTokens;
              const outTok = usage?.outputTokens;
              const inRate = Number(pricing?.inputPerMillionUsd);
              const outRate = Number(pricing?.outputPerMillionUsd);
              const haveTokens = Number.isFinite(inTok) && Number.isFinite(outTok);
              const haveRates = Number.isFinite(inRate) && inRate > 0 && Number.isFinite(outRate) && outRate > 0;
              if (!haveTokens) {
                return <span>Token and cost details unavailable.</span>;
              }
              if (!haveRates) {
                return (
                  <span>
                    Input: {inTok.toLocaleString()} tokens · Output: {outTok.toLocaleString()} tokens · Total tokens:{' '}
                    {(inTok + outTok).toLocaleString()} (pricing unavailable)
                  </span>
                );
              }
              const inCost = Number.isFinite(cost?.inputUsd) ? `$${cost.inputUsd.toFixed(6)}` : '—';
              const outCost = Number.isFinite(cost?.outputUsd) ? `$${cost.outputUsd.toFixed(6)}` : '—';
              const totCost = Number.isFinite(cost?.totalUsd) ? `$${cost.totalUsd.toFixed(6)}` : '—';
              return (
                <span>
                  Input: {inTok.toLocaleString()} tokens @ ${inRate.toLocaleString()} / 1M → {inCost} · Output: {outTok.toLocaleString()} tokens @ ${outRate.toLocaleString()} / 1M → {outCost} · Total: {totCost}
                </span>
              );
            })()}
          </div>
          {prompt ? (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: 13,
                lineHeight: 1.5,
                background: 'var(--color-surface-alt)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: 12,
                marginTop: 12,
                maxHeight: '32vh',
                overflowY: 'auto',
              }}
            >
              {prompt}
            </pre>
          ) : (
            <p>Prompt unavailable. Load news to generate a prompt.</p>
          )}

          {rawOutput ? (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: 13,
                lineHeight: 1.5,
                background: 'var(--color-surface-alt)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: 12,
                marginTop: 12,
                maxHeight: '32vh',
                overflowY: 'auto',
              }}
            >
              {rawOutput}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

NewsPromptDialog.propTypes = {
  onClose: PropTypes.func.isRequired,
  prompt: PropTypes.string,
  rawOutput: PropTypes.string,
  usage: PropTypes.shape({
    inputTokens: PropTypes.number,
    outputTokens: PropTypes.number,
    totalTokens: PropTypes.number,
  }),
  pricing: PropTypes.shape({
    model: PropTypes.string,
    inputPerMillionUsd: PropTypes.number,
    outputPerMillionUsd: PropTypes.number,
  }),
  cost: PropTypes.shape({ inputUsd: PropTypes.number, outputUsd: PropTypes.number, totalUsd: PropTypes.number }),
};

NewsPromptDialog.defaultProps = {
  prompt: null,
  rawOutput: null,
  usage: null,
  pricing: null,
  cost: null,
};
