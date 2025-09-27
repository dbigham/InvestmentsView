import PropTypes from 'prop-types';

function resolveLabel(account) {
  if (!account) return 'All accounts';
  const pieces = [account.number];
  if (account.clientAccountType) {
    pieces.push(account.clientAccountType.replace(/_/g, ' '));
  }
  return pieces.filter(Boolean).join(' - ');
}

export default function AccountSelector({ accounts, selected, onChange }) {
  const handleChange = (event) => {
    onChange(event.target.value);
  };

  return (
    <label className="account-selector">
      <span className="account-selector__label">Accounts</span>
      <select value={selected} onChange={handleChange}>
        <option value="all">All accounts</option>
        {accounts.map((account) => (
          <option key={account.id} value={String(account.id)}>
            {resolveLabel(account)}
          </option>
        ))}
      </select>
    </label>
  );
}

AccountSelector.propTypes = {
  accounts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.number.isRequired,
      number: PropTypes.string.isRequired,
      clientAccountType: PropTypes.string,
    })
  ).isRequired,
  selected: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};
