import { useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDate, formatMoney, formatPercent } from '../utils/formatters';

const CHART_VIEWBOX_SIZE = 240;
const CHART_CENTER = CHART_VIEWBOX_SIZE / 2;
const OUTER_RADIUS = CHART_VIEWBOX_SIZE / 2 - 10;
const INNER_RADIUS = OUTER_RADIUS * 0.58;
const SLICE_COLORS = [
  '#2f855a',
  '#2b6cb0',
  '#dd6b20',
  '#319795',
  '#805ad5',
  '#d69e2e',
  '#c53030',
  '#4a5568',
];

function currentDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function buildDonutPath(centerX, centerY, outerRadius, innerRadius, startAngle, endAngle) {
  const adjustedEndAngle = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const startOuter = polarToCartesian(centerX, centerY, outerRadius, startAngle);
  const endOuter = polarToCartesian(centerX, centerY, outerRadius, adjustedEndAngle);
  const startInner = polarToCartesian(centerX, centerY, innerRadius, adjustedEndAngle);
  const endInner = polarToCartesian(centerX, centerY, innerRadius, startAngle);
  const largeArcFlag = adjustedEndAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${endInner.x} ${endInner.y}`,
    'Z',
  ].join(' ');
}

function emptyDraft(year) {
  const today = currentDateKey();
  const date = today.startsWith(`${year}-`) ? today : `${year}-01-01`;
  return {
    date,
    organization: '',
    amountCad: '',
    taxClaimable: true,
    note: '',
  };
}

function draftFromGift(gift) {
  return {
    date: gift?.date || currentDateKey(),
    organization: gift?.organization || '',
    amountCad: Number.isFinite(gift?.amountCad) ? String(gift.amountCad) : '',
    taxClaimable: gift?.taxClaimable !== false,
    note: gift?.note || '',
  };
}

function buildChartSlices(organizations) {
  if (!Array.isArray(organizations) || organizations.length === 0) {
    return [];
  }
  let currentAngle = 0;
  return organizations.map((entry, index) => {
    const share = Number.isFinite(entry.share) ? entry.share : 0;
    const sweep = Math.max(0, share) * 360;
    const startAngle = currentAngle;
    const endAngle = index === organizations.length - 1 ? 360 : currentAngle + sweep;
    currentAngle = endAngle;
    return {
      ...entry,
      startAngle,
      endAngle,
      color: SLICE_COLORS[index % SLICE_COLORS.length],
    };
  });
}

export default function GivingDialog({
  year,
  gifts,
  summary,
  status,
  error,
  onClose,
  onRetry,
  onAddGift,
  onUpdateGift,
  onDeleteGift,
}) {
  const titleId = useId();
  const fieldBaseId = useId();
  const orgListId = useId();
  const [draft, setDraft] = useState(() => emptyDraft(year));
  const [editingGiftId, setEditingGiftId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!editingGiftId) {
      setDraft(emptyDraft(year));
    }
  }, [editingGiftId, year]);

  const normalizedGifts = useMemo(() => (Array.isArray(gifts) ? gifts : []), [gifts]);
  const organizations = useMemo(
    () => (Array.isArray(summary?.organizations) ? summary.organizations : []),
    [summary?.organizations]
  );
  const chartSlices = useMemo(() => buildChartSlices(organizations), [organizations]);
  const organizationOptions = useMemo(() => {
    const values = new Set(['MCC', 'One4Another']);
    normalizedGifts.forEach((gift) => {
      if (gift?.organization) {
        values.add(gift.organization);
      }
    });
    organizations.forEach((entry) => {
      if (entry?.organization) {
        values.add(entry.organization);
      }
    });
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [normalizedGifts, organizations]);

  const handleOverlayClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleDraftChange = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError(null);
  };

  const handleEditGift = (gift) => {
    if (!gift || !gift.id) {
      return;
    }
    setEditingGiftId(gift.id);
    setDraft(draftFromGift(gift));
    setFormError(null);
  };

  const handleCancelEdit = () => {
    setEditingGiftId(null);
    setDraft(emptyDraft(year));
    setFormError(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const organization = draft.organization.trim();
    const amountCad = Number(String(draft.amountCad).replace(/[$,\s]/g, ''));
    if (!draft.date) {
      setFormError('Choose a gift date.');
      return;
    }
    if (!organization) {
      setFormError('Enter an organization.');
      return;
    }
    if (!Number.isFinite(amountCad) || amountCad <= 0) {
      setFormError('Enter an amount greater than zero.');
      return;
    }
    const payload = {
      year,
      date: draft.date,
      organization,
      amountCad,
      taxClaimable: draft.taxClaimable,
      note: draft.note.trim(),
    };
    setBusy(true);
    setFormError(null);
    try {
      if (editingGiftId) {
        await onUpdateGift(editingGiftId, payload);
      } else {
        await onAddGift(payload);
      }
      setEditingGiftId(null);
      setDraft(emptyDraft(year));
    } catch (saveError) {
      const message =
        saveError instanceof Error && saveError.message ? saveError.message : 'Failed to save gift.';
      setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGift = async (gift) => {
    if (!gift || !gift.id) {
      return;
    }
    const ok =
      typeof window === 'undefined' ||
      window.confirm(`Delete ${formatMoney(gift.amountCad)} gift to ${gift.organization}?`);
    if (!ok) {
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await onDeleteGift(gift.id, { year });
      if (editingGiftId === gift.id) {
        handleCancelEdit();
      }
    } catch (deleteError) {
      const message =
        deleteError instanceof Error && deleteError.message ? deleteError.message : 'Failed to delete gift.';
      setFormError(message);
    } finally {
      setBusy(false);
    }
  };

  const totalCad = Number.isFinite(summary?.totalCad) ? summary.totalCad : 0;
  const taxClaimableCad = Number.isFinite(summary?.taxClaimableCad) ? summary.taxClaimableCad : 0;
  const nonTaxClaimableCad = Number.isFinite(summary?.nonTaxClaimableCad) ? summary.nonTaxClaimableCad : 0;
  const giftCount = Number.isFinite(summary?.giftCount) ? summary.giftCount : normalizedGifts.length;
  const loading = status === 'loading';
  const refreshing = status === 'refreshing';
  const minDate = `${year}-01-01`;
  const maxDate = `${year}-12-31`;

  return (
    <div className="giving-overlay" role="presentation" onClick={handleOverlayClick}>
      <div className="giving-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="giving-dialog__header">
          <div className="giving-dialog__heading">
            <p className="giving-dialog__eyebrow">{year} Giving</p>
            <h2 id={titleId}>{formatMoney(totalCad)}</h2>
            <p className="giving-dialog__subtitle">
              {giftCount === 1 ? '1 gift' : `${giftCount} gifts`}
              {summary?.organizationCount ? ` across ${summary.organizationCount} organizations` : ''}
              {refreshing ? ' - refreshing' : ''}
            </p>
          </div>
          <button type="button" className="giving-dialog__close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </header>

        <div className="giving-dialog__body">
          <section className="giving-dialog__chart-panel" aria-label="Giving by organization">
            {loading ? (
              <div className="giving-dialog__status">Loading gifts...</div>
            ) : error ? (
              <div className="giving-dialog__status giving-dialog__status--error">
                <span>{error.message || 'Failed to load gifts.'}</span>
                {onRetry ? (
                  <button type="button" className="giving-dialog__link-button" onClick={onRetry}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : chartSlices.length ? (
              <>
                <div className="giving-chart" role="img" aria-label={`${year} giving by organization`}>
                  <svg viewBox={`0 0 ${CHART_VIEWBOX_SIZE} ${CHART_VIEWBOX_SIZE}`}>
                    {chartSlices.map((slice) => {
                      const percentLabel = formatPercent(slice.share * 100, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      });
                      return (
                        <path
                          key={slice.organization}
                          d={buildDonutPath(
                            CHART_CENTER,
                            CHART_CENTER,
                            OUTER_RADIUS,
                            INNER_RADIUS,
                            slice.startAngle,
                            slice.endAngle
                          )}
                          fill={slice.color}
                        >
                          <title>{`${slice.organization}: ${formatMoney(slice.totalCad)} (${percentLabel})`}</title>
                        </path>
                      );
                    })}
                  </svg>
                  <div className="giving-chart__center">
                    <span className="giving-chart__center-label">Total</span>
                    <strong>{formatMoney(totalCad, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</strong>
                  </div>
                </div>
                <ul className="giving-legend">
                  {chartSlices.map((slice) => (
                    <li key={slice.organization} className="giving-legend__item">
                      <span
                        className="giving-legend__swatch"
                        style={{ backgroundColor: slice.color }}
                        aria-hidden="true"
                      />
                      <span className="giving-legend__label">{slice.organization}</span>
                      <span className="giving-legend__percent">
                        {formatPercent(slice.share * 100, {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })}
                      </span>
                      <span className="giving-legend__value">{formatMoney(slice.totalCad)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="giving-dialog__empty">No gifts recorded for {year} yet.</div>
            )}
          </section>

          <section className="giving-dialog__summary-strip" aria-label="Giving tax summary">
            <div className="giving-stat">
              <span>Tax claimable</span>
              <strong>{formatMoney(taxClaimableCad)}</strong>
            </div>
            <div className="giving-stat">
              <span>Other gifts</span>
              <strong>{formatMoney(nonTaxClaimableCad)}</strong>
            </div>
          </section>

          <section className="giving-dialog__work-area">
            <form className="giving-form" onSubmit={handleSubmit}>
              <div className="giving-form__header">
                <h3>{editingGiftId ? 'Edit gift' : 'Add gift'}</h3>
                {editingGiftId ? (
                  <button type="button" className="giving-dialog__link-button" onClick={handleCancelEdit} disabled={busy}>
                    Cancel edit
                  </button>
                ) : null}
              </div>
              <div className="giving-form__grid">
                <label className="giving-form__field" htmlFor={`${fieldBaseId}-date`}>
                  <span>Date</span>
                  <input
                    id={`${fieldBaseId}-date`}
                    type="date"
                    min={minDate}
                    max={maxDate}
                    value={draft.date}
                    onChange={(event) => handleDraftChange('date', event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="giving-form__field" htmlFor={`${fieldBaseId}-organization`}>
                  <span>Organization</span>
                  <input
                    id={`${fieldBaseId}-organization`}
                    list={orgListId}
                    value={draft.organization}
                    onChange={(event) => handleDraftChange('organization', event.target.value)}
                    placeholder="MCC"
                    disabled={busy}
                  />
                  <datalist id={orgListId}>
                    {organizationOptions.map((organization) => (
                      <option key={organization} value={organization} />
                    ))}
                  </datalist>
                </label>
                <label className="giving-form__field" htmlFor={`${fieldBaseId}-amount`}>
                  <span>Amount (CAD)</span>
                  <input
                    id={`${fieldBaseId}-amount`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    inputMode="decimal"
                    value={draft.amountCad}
                    onChange={(event) => handleDraftChange('amountCad', event.target.value)}
                    placeholder="100.00"
                    disabled={busy}
                  />
                </label>
                <label className="giving-form__checkbox" htmlFor={`${fieldBaseId}-claimable`}>
                  <input
                    id={`${fieldBaseId}-claimable`}
                    type="checkbox"
                    checked={draft.taxClaimable}
                    onChange={(event) => handleDraftChange('taxClaimable', event.target.checked)}
                    disabled={busy}
                  />
                  <span>Tax claimable</span>
                </label>
              </div>
              <label className="giving-form__field" htmlFor={`${fieldBaseId}-note`}>
                <span>Note</span>
                <textarea
                  id={`${fieldBaseId}-note`}
                  value={draft.note}
                  onChange={(event) => handleDraftChange('note', event.target.value)}
                  rows={2}
                  disabled={busy}
                />
              </label>
              {formError ? <div className="giving-form__error">{formError}</div> : null}
              <div className="giving-form__actions">
                <button type="submit" className="giving-form__submit" disabled={busy}>
                  {busy ? 'Saving...' : editingGiftId ? 'Save gift' : 'Add gift'}
                </button>
              </div>
            </form>

            <div className="giving-list-panel">
              <h3>Gift history</h3>
              {normalizedGifts.length ? (
                <ul className="giving-list">
                  {normalizedGifts.map((gift) => (
                    <li key={gift.id} className="giving-list__item">
                      <div className="giving-list__main">
                        <span className="giving-list__organization">{gift.organization}</span>
                        <span className="giving-list__meta">
                          {formatDate(gift.date)}
                          {gift.taxClaimable ? ' - tax claimable' : ' - not tax claimable'}
                        </span>
                        {gift.note ? <span className="giving-list__note">{gift.note}</span> : null}
                      </div>
                      <div className="giving-list__side">
                        <span className="giving-list__amount">{formatMoney(gift.amountCad)}</span>
                        <div className="giving-list__actions">
                          <button type="button" onClick={() => handleEditGift(gift)} disabled={busy}>
                            Edit
                          </button>
                          <button type="button" onClick={() => handleDeleteGift(gift)} disabled={busy}>
                            Delete
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="giving-list__empty">No entries yet.</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const giftShape = PropTypes.shape({
  id: PropTypes.string.isRequired,
  date: PropTypes.string.isRequired,
  organization: PropTypes.string.isRequired,
  amountCad: PropTypes.number.isRequired,
  taxClaimable: PropTypes.bool,
  note: PropTypes.string,
});

GivingDialog.propTypes = {
  year: PropTypes.number.isRequired,
  gifts: PropTypes.arrayOf(giftShape),
  summary: PropTypes.shape({
    year: PropTypes.number,
    totalCad: PropTypes.number,
    taxClaimableCad: PropTypes.number,
    nonTaxClaimableCad: PropTypes.number,
    giftCount: PropTypes.number,
    organizationCount: PropTypes.number,
    organizations: PropTypes.arrayOf(
      PropTypes.shape({
        organization: PropTypes.string.isRequired,
        totalCad: PropTypes.number.isRequired,
        taxClaimableCad: PropTypes.number,
        nonTaxClaimableCad: PropTypes.number,
        count: PropTypes.number,
        share: PropTypes.number,
      })
    ),
  }),
  status: PropTypes.oneOf(['idle', 'loading', 'refreshing', 'ready', 'error']),
  error: PropTypes.instanceOf(Error),
  onClose: PropTypes.func.isRequired,
  onRetry: PropTypes.func,
  onAddGift: PropTypes.func.isRequired,
  onUpdateGift: PropTypes.func.isRequired,
  onDeleteGift: PropTypes.func.isRequired,
};

GivingDialog.defaultProps = {
  gifts: [],
  summary: null,
  status: 'idle',
  error: null,
  onRetry: null,
};
