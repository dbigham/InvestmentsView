import PropTypes from 'prop-types';

export default function CurrencyToggle({ options, selected, onChange }) {
  return (
    <div className="currency-toggle">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={selected === option.value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

CurrencyToggle.propTypes = {
  options: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
    })
  ).isRequired,
  selected: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};
