import PropTypes from 'prop-types';
import { formatTimeOfDay } from '../utils/formatters';

export default function TimePill({
  asOf,
  onRefresh,
  className,
  refreshing,
  autoRefreshing,
}) {
  const label = formatTimeOfDay(asOf);
  const pillClassName = className ? `time-pill ${className}` : 'time-pill';
  const isInteractive = typeof onRefresh === 'function';
  const showIcon = isInteractive || refreshing;
  const classNames = [pillClassName];
  if (refreshing) {
    classNames.push('time-pill--refreshing');
  }
  if (autoRefreshing) {
    classNames.push('time-pill--auto');
  }
  const resolvedClassName = classNames.join(' ');
  const refreshLabel = label ? `Refresh data (last updated ${label})` : 'Refresh data';
  const refreshingLabel = label ? `Refreshing data (last updated ${label})` : 'Refreshing data';
  const autoRefreshHint = autoRefreshing
    ? ' Auto-refresh is on. Ctrl-click to stop auto-refresh.'
    : ' Ctrl-click to start auto-refresh.';
  const buttonAriaLabel = `${refreshing ? refreshingLabel : refreshLabel}.${autoRefreshHint}`;
  const title = autoRefreshing ? 'Auto-refresh is on. Ctrl-click to stop.' : 'Ctrl-click to start auto-refresh.';

  const handleClick = (event) => {
    if (isInteractive) {
      onRefresh(event);
    }
  };

  const contents = (
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
        onClick={handleClick}
        aria-label={buttonAriaLabel}
        title={title}
        data-auto-refreshing={autoRefreshing ? 'true' : 'false'}
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
  autoRefreshing: PropTypes.bool,
};

TimePill.defaultProps = {
  asOf: null,
  onRefresh: null,
  className: '',
  refreshing: false,
  autoRefreshing: false,
};
