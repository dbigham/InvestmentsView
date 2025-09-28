import PropTypes from 'prop-types';

function resolveLabel(account) {
  if (!account) return 'All accounts';
  const pieces = [account.number];
  if (account.clientAccountType) {
    pieces.push(account.clientAccountType.replace(/_/g, ' '));
  } else if (account.type) {
    pieces.push(account.type);
  }
  return pieces.filter(Boolean).join(' • ');
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
