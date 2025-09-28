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
      const isShort = word.length <= 3;
      const isAllCaps = word === word.toUpperCase();
      if (isShort || isAllCaps) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .filter(Boolean)
    .join(' ');
}

function buildPrimaryLabel(account, totalAccounts) {
  if (!account) {
    if (totalAccounts > 1) {
      return 'All Accounts';
    }
    return totalAccounts === 1 ? 'Account' : 'Accounts';
  }
  const typeLabel = toFriendlyLabel(account.clientAccountType || account.type);
  if (account.isPrimary && typeLabel) {
    return `Main ${typeLabel}`;
  }
  return typeLabel || 'Account';
}

function buildSecondaryLabel(account, totalAccounts) {
  if (!account) {
    if (totalAccounts > 1) {
      return `Combined across ${totalAccounts} accounts`;
    }
    return null;
  }
  const pieces = [];
  const typeLabel = toFriendlyLabel(account.type);
  if (typeLabel) {
    pieces.push(`Self-directed ${typeLabel}`);
  }
  if (account.number) {
    pieces.push(account.number);
  }
  return pieces.join(' · ') || null;
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

export default function AccountSelector({ accounts, selected, onChange, disabled }) {
  const handleChange = (event) => {
    onChange(event.target.value);
  };

  const totalAccounts = accounts.length;
  const selectedAccount = selected === 'all' ? null : accounts.find((account) => String(account.number) === selected) || null;

  let primaryLabel = buildPrimaryLabel(selectedAccount, totalAccounts);
  let secondaryLabel = buildSecondaryLabel(selectedAccount, totalAccounts);

  if (!selectedAccount && totalAccounts === 1) {
    primaryLabel = buildPrimaryLabel(accounts[0], totalAccounts);
    secondaryLabel = buildSecondaryLabel(accounts[0], totalAccounts);
  }

  const displayId = 'account-select-display';

  return (
    <div className="account-selector">
      <div className="account-selector__display" id={displayId} aria-hidden="true">
        <span className="account-selector__primary">{primaryLabel}</span>
        {secondaryLabel && <span className="account-selector__secondary">{secondaryLabel}</span>}
      </div>
      <select
        id="account-select"
        className="account-selector__native"
        aria-labelledby={displayId}
        value={selected}
        onChange={handleChange}
        disabled={disabled}
      >
        <option value="all">All accounts</option>
        {accounts.map((account) => (
          <option key={account.number} value={String(account.number)}>
            {resolveLabel(account)}
          </option>
        ))}
      </select>
    </div>
  );
}

AccountSelector.propTypes = {
  accounts: PropTypes.arrayOf(
    PropTypes.shape({
      number: PropTypes.string.isRequired,
      clientAccountType: PropTypes.string,
      type: PropTypes.string,
      isPrimary: PropTypes.bool,
    })
  ).isRequired,
  selected: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};

AccountSelector.defaultProps = {
  disabled: false,
};
