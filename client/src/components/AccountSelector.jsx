import { useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

function normalizeLabel(value) {
  if (!value) {
    return '';
  }
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toFriendlyLabel(value) {
  const normalized = normalizeLabel(value);
  if (!normalized) {
    return '';
  }
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

function formatAccountType(account) {
  if (!account) {
    return null;
  }
  const rawType = account.clientAccountType || account.type;
  if (!rawType) {
    return null;
  }
  const friendly = toFriendlyLabel(rawType);
  if (!friendly) {
    return null;
  }
  if (/self[-\s]?directed/i.test(rawType)) {
    return friendly;
  }
  return `Self-directed ${friendly}`;
}

function buildPrimaryLabel(account) {
  if (!account) {
    return 'Account';
  }
  const displayName = normalizeLabel(account.displayName);
  if (displayName) {
    return displayName;
  }
  const ownerLabel = normalizeLabel(account.ownerLabel);
  if (ownerLabel) {
    return ownerLabel;
  }
  const typeLabel = toFriendlyLabel(account.clientAccountType || account.type);
  if (account.isPrimary && typeLabel) {
    return `Main ${typeLabel}`;
  }
  if (typeLabel) {
    return typeLabel;
  }
  const number = account.number ? String(account.number).trim() : '';
  if (number) {
    return `Account ${number}`;
  }
  return 'Account';
}

function labelsEqual(a, b) {
  if (!a || !b) {
    return false;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolveMetaLabel(account, multipleOwners, primaryLabel) {
  const ownerLabel = normalizeLabel(account && account.ownerLabel);
  if (!ownerLabel) {
    return null;
  }
  if (!primaryLabel) {
    return ownerLabel;
  }
  if (labelsEqual(ownerLabel, primaryLabel)) {
    return multipleOwners ? ownerLabel : null;
  }
  return ownerLabel;
}

function buildSecondaryLabel(account, totalAccounts) {
  if (!account) {
    if (totalAccounts > 1) {
      return `Combined across ${totalAccounts} accounts`;
    }
    return null;
  }
  const parts = [];
  const typeLabel = formatAccountType(account);
  if (typeLabel) {
    parts.push(typeLabel);
  }
  const number = account.number ? String(account.number).trim() : '';
  if (number) {
    parts.push(number);
  }
  return parts.join(' - ') || null;
}

function buildAccountOption(account, context) {
  if (!account) {
    return null;
  }
  const primary = buildPrimaryLabel(account);
  const meta = resolveMetaLabel(account, context.multipleOwners, primary);
  const secondary = buildSecondaryLabel(account, context.totalAccounts);
  return {
    value: account.id,
    primary,
    meta,
    secondary,
    account,
  };
}

function buildAllOption(totalAccounts, accountOptions, multipleOwners) {
  if (!totalAccounts) {
    return null;
  }
  if (totalAccounts === 1 && accountOptions.length) {
    const single = accountOptions[0];
    return {
      value: 'all',
      primary: single.primary,
      meta: single.meta,
      secondary: single.secondary,
    };
  }
  return {
    value: 'all',
    primary: 'All accounts',
    meta: multipleOwners ? 'All owners' : null,
    secondary: `Combined across ${totalAccounts} accounts`,
  };
}

export default function AccountSelector({ accounts, selected, onChange, disabled }) {
  const baseReactId = useId();
  const fallbackId = useMemo(() => `account-selector-${Math.random().toString(36).slice(2)}`, []);
  const baseId = baseReactId || fallbackId;

  const containerRef = useRef(null);
  const listRef = useRef(null);

  const totalAccounts = accounts.length;
  const multipleOwners = useMemo(() => {
    const labels = new Set();
    accounts.forEach((account) => {
      if (account && account.ownerLabel) {
        labels.add(account.ownerLabel.trim().toLowerCase());
      }
    });
    return labels.size > 1;
  }, [accounts]);

  const optionsState = useMemo(() => {
    const accountOptions = accounts
      .map((account) => buildAccountOption(account, { multipleOwners, totalAccounts }))
      .filter(Boolean);
    const allOption = buildAllOption(totalAccounts, accountOptions, multipleOwners);
    const optionsList = [];
    if (allOption) {
      optionsList.push(allOption);
    }
    optionsList.push(...accountOptions);
    return {
      options: optionsList,
      accountOptions,
      allOption,
    };
  }, [accounts, multipleOwners, totalAccounts]);

  const options = optionsState.options;
  const accountOptions = optionsState.accountOptions;
  const allOption = optionsState.allOption;

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === selected),
    [options, selected]
  );

  const selectedOption = useMemo(() => {
    if (!options.length) {
      return null;
    }
    const direct = options.find((option) => option.value === selected);
    if (direct) {
      return direct;
    }
    if (selected === 'all' && accountOptions.length === 1) {
      const single = accountOptions[0];
      return {
        value: 'all',
        primary: single.primary,
        meta: single.meta,
        secondary: single.secondary,
      };
    }
    return options[0];
  }, [options, selected, accountOptions]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const indexToHighlight = selectedIndex >= 0 ? selectedIndex : 0;
    setHighlightedIndex(indexToHighlight);
  }, [isOpen, selectedIndex]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    if (highlightedIndex < 0 || highlightedIndex >= listElement.children.length) {
      return;
    }
    const optionNode = listElement.children[highlightedIndex];
    if (optionNode && optionNode.scrollIntoView) {
      optionNode.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, highlightedIndex]);

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen]);

  const handleToggle = () => {
    if (disabled || !options.length) {
      return;
    }
    setIsOpen((value) => !value);
  };

  const handleSelect = (option) => {
    if (!option) {
      return;
    }
    if (option.value !== selected) {
      onChange(option.value);
    }
    setIsOpen(false);
  };

  const handleKeyDown = (event) => {
    if (disabled) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!options.length) {
        return;
      }
      if (!isOpen) {
        setIsOpen(true);
        return;
      }
      setHighlightedIndex((current) => {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        if (current < 0) {
          return direction === 1 ? 0 : options.length - 1;
        }
        return (current + direction + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < options.length) {
        handleSelect(options[highlightedIndex]);
      } else {
        setIsOpen(true);
      }
      return;
    }
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else if (highlightedIndex >= 0 && highlightedIndex < options.length) {
        handleSelect(options[highlightedIndex]);
      }
      return;
    }
    if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
      }
      return;
    }
    if (event.key === 'Home') {
      if (isOpen && options.length) {
        event.preventDefault();
        setHighlightedIndex(0);
      }
      return;
    }
    if (event.key === 'End') {
      if (isOpen && options.length) {
        event.preventDefault();
        setHighlightedIndex(options.length - 1);
      }
      return;
    }
    if (event.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const listId = `${baseId}-list`;
  const activeOptionId = isOpen && highlightedIndex >= 0 ? `${baseId}-option-${highlightedIndex}` : undefined;
  const classes = ['account-selector'];
  if (isOpen) {
    classes.push('account-selector--open');
  }
  if (disabled || !options.length) {
    classes.push('account-selector--disabled');
  }

  const displayOption =
    selectedOption ||
    allOption || {
      value: 'all',
      primary: 'All accounts',
      meta: null,
      secondary: totalAccounts > 1 ? `Combined across ${totalAccounts} accounts` : null,
    };

  const isTriggerDisabled = disabled || !options.length;

  return (
    <div className={classes.join(' ')} ref={containerRef}>
      <button
        type="button"
        className="account-selector__trigger"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        disabled={isTriggerDisabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-activedescendant={activeOptionId}
      >
        <div className="account-selector__value">
          {displayOption.meta && <span className="account-selector__meta">{displayOption.meta}</span>}
          <span className="account-selector__primary">{displayOption.primary}</span>
          {displayOption.secondary && (
            <span className="account-selector__secondary">{displayOption.secondary}</span>
          )}
        </div>
        <span className="account-selector__chevron" aria-hidden="true" />
      </button>

      {isOpen && (
        <div className="account-selector__dropdown">
          {options.length ? (
            <ul className="account-selector__list" role="listbox" id={listId} ref={listRef}>
              {options.map((option, index) => {
                const optionClasses = ['account-selector__option'];
                if (option.value === selected) {
                  optionClasses.push('account-selector__option--selected');
                }
                if (index === highlightedIndex) {
                  optionClasses.push('account-selector__option--highlighted');
                }
                const optionId = `${baseId}-option-${index}`;
                return (
                  <li
                    key={option.value}
                    id={optionId}
                    role="option"
                    aria-selected={option.value === selected}
                    className={optionClasses.join(' ')}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => handleSelect(option)}
                  >
                    <div className="account-selector__option-content">
                      {option.meta && <span className="account-selector__meta">{option.meta}</span>}
                      <span className="account-selector__primary">{option.primary}</span>
                      {option.secondary && (
                        <span className="account-selector__secondary">{option.secondary}</span>
                      )}
                    </div>
                    {option.value === selected && <span className="account-selector__check" aria-hidden="true" />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="account-selector__empty">No accounts available</div>
          )}
        </div>
      )}
    </div>
  );
}

AccountSelector.propTypes = {
  accounts: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      number: PropTypes.string.isRequired,
      clientAccountType: PropTypes.string,
      type: PropTypes.string,
      isPrimary: PropTypes.bool,
      ownerLabel: PropTypes.string,
      ownerEmail: PropTypes.string,
      loginId: PropTypes.string,
      displayName: PropTypes.string,
    })
  ).isRequired,
  selected: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};

AccountSelector.defaultProps = {
  disabled: false,
};
