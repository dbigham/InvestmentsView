import PropTypes from 'prop-types';

function normalizeLabel(value) {
  if (!value) return '';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toFriendlyLabel(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) return '';
  return normalized
    .split(' ')
    .map((word) => {
      if (!word) {
        return '';
      }
      const allUpper = word === word.toUpperCase();
      if (allUpper || word.length <= 3) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(' ');
}

function resolveLabel(account) {
  if (!account) return 'All accounts';
  const labelParts = [];
  if (account.number) {
    labelParts.push(account.number);
  }
  const descriptor = toFriendlyLabel(account.clientAccountType || account.type);
  if (descriptor) {
    labelParts.push(descriptor);
  }
  return labelParts.join(' ');
}

export default function AccountSelector({ accounts, selected, onChange }) {
  const handleChange = (event) => {
    onChange(event.target.value);
  };

  return (
    <div className="account-selector">
      <label className="account-selector__label" htmlFor="account-select">
        Accounts
      </label>
      <div className="account-selector__control">
        <select id="account-select" value={selected} onChange={handleChange}>
          <option value="all">All accounts</option>
          {accounts.map((account) => (
            <option key={account.number} value={String(account.number)}>
              {resolveLabel(account)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

AccountSelector.propTypes = {
  accounts: PropTypes.arrayOf(
    PropTypes.shape({
      number: PropTypes.string.isRequired,
      clientAccountType: PropTypes.string,
      type: PropTypes.string,
    })
  ).isRequired,
  selected: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};
