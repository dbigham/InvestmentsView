import PropTypes from 'prop-types';
import { formatTimeOfDay } from '../utils/formatters';

export default function TimePill({ asOf, onRefresh, className }) {
  const label = formatTimeOfDay(asOf);
  const pillClassName = className ? `time-pill ${className}` : 'time-pill';
  const isInteractive = typeof onRefresh === 'function';

  const contents = (
    <>
      {isInteractive && <span className="time-pill__icon" aria-hidden="true" />}
      <span className="time-pill__text">{label}</span>
    </>
  );

  if (isInteractive) {
    return (
      <button
        type="button"
        className={pillClassName}
        onClick={onRefresh}
        aria-label={`Refresh data (last updated ${label})`}
      >
        {contents}
      </button>
    );
  }

  return (
    <div className={pillClassName} role="text" aria-label={`Last updated ${label}`}>
      {contents}
    </div>
  );
}

TimePill.propTypes = {
  asOf: PropTypes.string,
  onRefresh: PropTypes.func,
  className: PropTypes.string,
};

TimePill.defaultProps = {
  asOf: null,
  onRefresh: null,
  className: '',
};
