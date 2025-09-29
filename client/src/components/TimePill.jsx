import PropTypes from 'prop-types';
import { formatTimeOfDay } from '../utils/formatters';

export default function TimePill({ asOf, onRefresh, className, refreshing }) {
  const label = formatTimeOfDay(asOf);
  const pillClassName = className ? `time-pill ${className}` : 'time-pill';
  const isInteractive = typeof onRefresh === 'function';
  const showIcon = isInteractive || refreshing;
  const resolvedClassName = refreshing ? `${pillClassName} time-pill--refreshing` : pillClassName;
  const refreshLabel = label ? `Refresh data (last updated ${label})` : 'Refresh data';
  const refreshingLabel = label ? `Refreshing data (last updated ${label})` : 'Refreshing data';

  const contents = refreshing ? (
    <span className="time-pill__icon" aria-hidden="true" />
  ) : (
    <>
      {showIcon && <span className="time-pill__icon" aria-hidden="true" />}
      <span className="time-pill__text">{label}</span>
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        className={resolvedClassName}
        onClick={onRefresh}
        aria-label={refreshing ? refreshingLabel : refreshLabel}
      >
        {contents}
      </button>
    );
  }

  return (
    <div
      className={resolvedClassName}
      role="text"
      aria-label={label ? `Last updated ${label}` : 'Last updated'}
    >
      {contents}
    </div>
  );
}

TimePill.propTypes = {
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  className: PropTypes.string,
  refreshing: PropTypes.bool,
};

TimePill.defaultProps = {
  asOf: null,
  onRefresh: null,
  className: '',
  refreshing: false,
};
